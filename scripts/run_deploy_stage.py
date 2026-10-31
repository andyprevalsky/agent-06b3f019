#!/usr/bin/env python3
"""Run and record one /deploy stage without per-stage helper processes."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path
from typing import Sequence

from deploy_stage import LifecycleError, admit_stage, append_stage, release_stage
from factory_detail import (
    HostSampler,
    active_admissions,
    attempt_detail,
    reuse_detail,
    source_detail,
    stage_detail,
)
from factory_metadata import load_metadata

FORWARDED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
CLEANUP_GRACE_SECONDS = 60
REPO_ROOT = Path(__file__).resolve().parents[1]


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", type=Path, help="required unless --preview-lane-scoped-reuse")
    parser.add_argument("--reuse-passed", action="store_true")
    parser.add_argument(
        "--lane-scoped-reuse",
        action="store_true",
        help="reuse a prior PASSED result of this lane when every change since it is provably inert "
        "(the pipeline passes it from the plan's lane_scoped_reuse; DEPLOY_LANE_SCOPED_REUSE=0 disables it, "
        "the environment never enables it); only lanes in _SCOPED_REUSE_LANES qualify",
    )
    parser.add_argument(
        "--preview-lane-scoped-reuse",
        metavar="PASSED_HEAD[..CURRENT_HEAD]",
        help="dry run: print the lane-scoped reuse decision of every scoped lane for the changes between "
        "PASSED_HEAD and CURRENT_HEAD (default HEAD plus the worktree) and exit; runs nothing",
    )
    parser.add_argument("stage", nargs="?")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def _hash_field(digest: "hashlib._Hash", label: str, value: bytes) -> None:
    digest.update(label.encode())
    digest.update(b"\0")
    digest.update(str(len(value)).encode())
    digest.update(b"\0")
    digest.update(value)
    digest.update(b"\0")


def _git_output(*arguments: str) -> bytes:
    return subprocess.run(
        ("git", *arguments),
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


# Per-lane input scopes for --reuse-passed. A scoped lane hashes the content of
# every repository path EXCEPT its excluded prefixes, so a new or unmapped path
# is always an input (over-inclusion by construction). Only lanes whose suites
# cannot read the excluded trees are scoped: the back-end, agents and
# repository-wide structural lanes read across packages (agents executes
# back-end code and schema; back-end reads front-end, agents, scripts, docs and
# .claude), so they keep the exact whole-worktree fingerprint. Root manifests,
# lockfiles, configs, scripts/, shared/ and .claude/ remain inputs of every
# lane. A scoped lane hashes file content rather than HEAD, so committing an
# unrelated fix does not invalidate it; its suites do not inspect git state.
_DOCUMENTATION_ONLY = (
    "research/",
    "docs/",
    "claude-code-src/",
    "prompt-review/",
    "pitch-deck/",
    "observability/",
)
_MAC_EXCLUDED = ("back-end/", "agents/", *_DOCUMENTATION_ONLY)
# Append-only benchmark ledgers local benchmark runs write while the other
# gates run (agents/benchmarks/history/*.jsonl). Inside a deploy the smoke lane
# parks its rows under .context instead (run-predeploy-local,
# BENCHMARK_HISTORY_PARK_DIR), so only other local benchmark runs still dirty
# them. The pipeline's
# source digest already ignores them. Only lanes whose suites cannot read them
# drop them from the exact fingerprint: eslint lints the listed TypeScript,
# tsc type-checks back-end/, and the back-end structural suite reads sources,
# migrations and the benchmark catalog, never the ledgers. backend-coverage-
# blackbox (domains/benchmarks/config.ts reads task_attempts.jsonl), the
# agents lanes and the scripts/tests gates (deploy-command-structural and the
# seed checks) read them and keep the whole-worktree fingerprint.
_LEDGER_PATHS = ("agents/benchmarks/history/",)
# A lane name alone does not prove what ran under it: the ledgers stay out of
# the fingerprint only when the stage is one of these lanes AND its argv is
# that lane's real command (lint-affected over the deploy lint list, tsc, or
# the back-end structural suite). Any other command under the same name keeps
# the whole-worktree fingerprint, so a ledger write still invalidates it.
_LEDGER_FREE_COMMANDS = {
    "eslint": ("lint-affected.mjs",),
    "typescript": ("tsc",),
    "backend-structural": ("test:structural",),
}


def _ledger_free(stage: str, command: Sequence[str]) -> bool:
    markers = _LEDGER_FREE_COMMANDS.get(stage)
    if not markers:
        return False
    joined = " ".join(os.fsdecode(argument) for argument in command)
    return any(marker in joined for marker in markers)
_LANE_SCOPES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    # Vitest blackbox/structural: front-end/ plus the benchmark catalog read by
    # tests-e2e/helpers.ts (imported by a blackbox suite).
    "frontend-coverage-blackbox": (
        ("back-end/", "mac-app/", "agents/", *_DOCUMENTATION_ONLY),
        ("agents/benchmarks/tasks.json",),
    ),
    # The Electron app consumes front-end/ and shared/ contracts; back-end/ and
    # agents/ sources appear only in its comments.
    "mac-static": (_MAC_EXCLUDED, ()),
    "mac-coverage-blackbox": (_MAC_EXCLUDED, ()),
}


def _in_lane_scope(path: str, excluded: Sequence[str], reincluded: Sequence[str]) -> bool:
    if path in reincluded:
        return True
    return not any(path.startswith(prefix) for prefix in excluded)


def _split_paths(output: bytes) -> list[str]:
    return [os.fsdecode(raw) for raw in output.split(b"\0") if raw]


def _scoped_content_fingerprint(digest: "hashlib._Hash", stage: str) -> None:
    excluded, reincluded = _LANE_SCOPES[stage]
    _hash_field(digest, "scope", json.dumps([stage, excluded, reincluded]).encode())
    # --no-renames: a staged rename out of scope must list its in-scope source
    # as deleted, otherwise the unchanged HEAD entry keeps a stale pass reusable.
    changed = set(
        _split_paths(
            _git_output("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD")
        )
    )
    for entry in sorted(_split_paths(_git_output("ls-tree", "-r", "-z", "--full-tree", "HEAD"))):
        meta, _, relative = entry.partition("\t")
        if relative in changed or not _in_lane_scope(relative, excluded, reincluded):
            continue
        _hash_field(digest, f"tree:{relative}", meta.encode())
    untracked = set(_split_paths(_git_output("ls-files", "--others", "--exclude-standard", "-z")))
    for relative in sorted(changed | untracked):
        if not _in_lane_scope(relative, excluded, reincluded):
            continue
        path = REPO_ROOT / relative
        try:
            if path.is_symlink():
                value = b"link:" + os.readlink(path).encode()
            elif path.exists():
                value = (b"x:" if os.access(path, os.X_OK) else b"f:") + path.read_bytes()
            else:
                value = b"deleted"
        except OSError as error:
            value = f"unreadable:{type(error).__name__}".encode()
        _hash_field(digest, f"worktree:{relative}", value)


def _fingerprint_scope(stage: str, command: Sequence[str]) -> str:
    if stage in _LANE_SCOPES:
        return "lane inputs"
    if _ledger_free(stage, command):
        return "exact worktree minus append-only ledgers"
    return "exact worktree"


def _worktree_fingerprint(command: Sequence[str], stage: str = "") -> str:
    """Hash every deploy input; exact-tree reuse is conservative by design.

    A lane in _LANE_SCOPES hashes the content of its declared inputs; a lane
    running its _LEDGER_FREE_COMMANDS command hashes HEAD plus the worktree
    diff and untracked files outside the append-only benchmark ledgers; every
    other lane hashes HEAD plus the whole worktree diff and untracked files.
    """

    digest = hashlib.sha256()
    if stage in _LANE_SCOPES:
        _scoped_content_fingerprint(digest, stage)
        _hash_invocation(digest, command)
        return digest.hexdigest()
    ledger_free = _ledger_free(stage, command)
    diff_paths = ("--", ".", *(f":(exclude){prefix}" for prefix in _LEDGER_PATHS)) if ledger_free else ()
    _hash_field(digest, "scope", _fingerprint_scope(stage, command).encode())
    _hash_field(digest, "head", _git_output("rev-parse", "HEAD"))
    _hash_field(digest, "tracked", _git_output("diff", "--no-ext-diff", "--binary", "HEAD", *diff_paths))
    untracked = _git_output("ls-files", "--others", "--exclude-standard", "-z")
    untracked_paths = sorted(
        path for path in untracked.split(b"\0")
        if path and not (ledger_free and any(os.fsdecode(path).startswith(p) for p in _LEDGER_PATHS))
    )
    _hash_field(digest, "untracked-list", b"\0".join(untracked_paths))
    for raw_path in untracked_paths:
        relative = os.fsdecode(raw_path)
        path = REPO_ROOT / relative
        try:
            value = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        except OSError as error:
            value = f"unreadable:{type(error).__name__}".encode()
        _hash_field(digest, f"untracked:{relative}", value)
    _hash_invocation(digest, command)
    return digest.hexdigest()


# The environment is a deploy input (NODE_OPTIONS, DEPLOY_GATE_OVERRIDES,
# ROSE_*, CONDUCTOR_* change what a gate runs), so every variable is hashed
# except the ones that only identify this process, session or terminal.
# systemd stamps a fresh INVOCATION_ID/JOURNAL_STREAM/SYSTEMD_EXEC_PID on every
# transient unit and the shell its own PWD/OLDPWD/SHLVL/_, so a lane relaunched
# as a new unit inside the same deploy run never matched its own pass: on
# 2026-10-30 the 33-minute coverage lane and the 10-minute structural lane
# re-ran on identical bytes on every retry. cwd is hashed on its own.
# run_deploy_pipeline.py stamps every lane launch with a fresh
# DEPLOY_PIPELINE_LANE_TOKEN (teardown ownership of the processes the lane
# starts; echoed as each row's detail.lane_token so the receipt lane matches
# its own row); it identifies the lane process, not a gate input.
_PROCESS_IDENTITY_ENV = frozenset(
    {
        "_",
        "OLDPWD",
        "PWD",
        "SHLVL",
        "INVOCATION_ID",
        "JOURNAL_STREAM",
        "SYSTEMD_EXEC_PID",
        "NOTIFY_SOCKET",
        "COLUMNS",
        "LINES",
        "TERM_SESSION_ID",
        "ITERM_SESSION_ID",
        "WINDOWID",
        "XDG_SESSION_ID",
        "SSH_CLIENT",
        "SSH_CONNECTION",
        "SSH_TTY",
        "DEPLOY_PIPELINE_LANE_TOKEN",
    }
)
_PROCESS_IDENTITY_ENV_PREFIXES = ("LISTEN_",)


# Scheduling knobs decide whether a lane may skip, never what it runs, so they
# stay out of every fingerprint: toggling lane-scoped reuse (or lowering its
# cross-run age bound) must not turn an identical pass into an exact-input miss.
_SCOPED_REUSE_ENV = "DEPLOY_LANE_SCOPED_REUSE"
_CROSS_RUN_MAX_AGE_ENV = "DEPLOY_LANE_SCOPED_REUSE_MAX_AGE_SECONDS"
_SCHEDULING_ONLY_ENV = frozenset({_SCOPED_REUSE_ENV, _CROSS_RUN_MAX_AGE_ENV})


def _is_process_identity_env(name: str) -> bool:
    return (
        name in _PROCESS_IDENTITY_ENV
        or name in _SCHEDULING_ONLY_ENV
        or name.startswith(_PROCESS_IDENTITY_ENV_PREFIXES)
    )


def _hash_invocation(digest: "hashlib._Hash", command: Sequence[str]) -> None:
    _hash_field(digest, "cwd", os.fsencode(os.getcwd()))
    for index, argument in enumerate(command):
        _hash_field(digest, f"argv:{index}", os.fsencode(argument))
    for name, value in sorted(os.environ.items()):
        if _is_process_identity_env(name):
            continue
        _hash_field(digest, f"env:{name}", os.fsencode(value))


def _cache_path(run_dir: Path, stage: str, fingerprint: str) -> Path:
    return run_dir / "passed-cache" / stage / f"{fingerprint}.json"


def _cache_hit(run_dir: Path, stage: str, fingerprint: str) -> bool:
    path = _cache_path(run_dir, stage, fingerprint)
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    return payload == {"schema_version": 1, "fingerprint": fingerprint}


def _record_cache_hit(run_dir: Path, stage: str, fingerprint: str) -> None:
    path = _cache_path(run_dir, stage, fingerprint)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"schema_version": 1, "fingerprint": fingerprint}) + "\n")
    temporary.replace(path)


# ---------------------------------------------------------------------------
# Lane-scoped reuse (default OFF). Enabled per invocation only by
# --lane-scoped-reuse, which run_deploy_pipeline.py passes when the plan sets
# "lane_scoped_reuse": true: the plan is the single reviewed enabling surface.
# DEPLOY_LANE_SCOPED_REUSE=0 is a kill switch (never an enabler) and, like the
# flag, stays out of every fingerprint.
#
# An exact-input miss reruns a lane even when the only change since its pass
# is a docs page or another package's test, so a one-line agents test fix cost
# a full backend/smoke/semantic rerun. A lane listed in _SCOPED_REUSE_LANES may
# instead reuse its most recent PASSED result for the identical command, cwd
# and environment when EVERY path that differs between the passed tree and the
# current tree is provably inert for that lane. The differing paths are the
# git diff between the passed head and HEAD, the dirty paths recorded when the
# pass ran, the current worktree diff and the current untracked non-ignored
# files. A path is inert only when BOTH hold:
#   (a) it matches one of the lane's declared inert patterns below and none of
#       the never-inert patterns (fnmatch on repo-relative paths, `*` crosses
#       `/`, the convention of scripts/test-map/edges.json), and
#   (b) scripts/select_affected_tests.py selects no test of the lane's graph
#       lanes for that path and does not fall back to ALL: a run_all trigger
#       (lockfiles, env examples, the Prisma schema, migrations, runners,
#       shared configs) or an unmapped file always reruns.
# Anything else reruns the lane; when in doubt it reruns. Only lanes whose
# suites cannot read the inert trees are listed, and each hit records the
# passed head, fingerprint, run id and the rule that judged every path under
# a distinct "reused-scoped" status, so no scorecard can show it as a pass
# executed on the current bytes. A lane name alone proves nothing about what
# ran under it (the _LEDGER_FREE_COMMANDS precedent): a stage is judged by a
# lane's inert set only when its argv carries that lane's real command marker.
# A failed run of the lane records its head too, and a candidate pass is
# vetoed when the current tree differs from a failed head only by inert paths.
#
# Stack lanes (graph_lanes == (): smoke, semantic-stack) execute runtime code
# rather than selector-mapped suites, so a code file under a tooling tree
# (_STACK_REACH_TREES) that is outside their declared inert set gets a second,
# reach-based judgement instead of an immediate rerun: it is inert when the
# selector neither falls back to ALL nor triggers a whole lane AND nothing the
# stack executes reaches it, i.e. no STACK_ENTRYPOINTS member and no backend
# route (``http:`` resource) lies in its reverse-dependency closure
# (select_affected_tests.Selector.upstream: imports, exec'd paths, data reads).
# The judgement is confined to tooling trees because the graph is incomplete
# elsewhere: product->test edges are dropped (run_benchmark.py imports
# agents/tests/e2e), router mounts become ``http:`` resources, Playwright specs
# and fixtures are selected through computed paths. Test files, package-root
# configuration and non-code files never get the second chance, _NEVER_INERT
# and run_all triggers stay absolute, and a missing entrypoint fails closed.
# Lanes with graph lanes keep the declared-only rule.
#
# Cross-run discovery. A deploy whose green timing run was closed with
# --finish and then needed a test-only sync starts a new run whose own
# passed-cache is empty, so the follow-up reran every lane. The decision
# therefore also reads PASSED records in place from EARLIER run dirs of the
# same run root (worktree-local; the branch is recorded in the row but never
# compared: a follow-up branch or the next deploy of the same tree is a valid
# source) when ALL of these hold: the record carries the identical
# invocation digest, its passed head is an ancestor of (or equal to) the
# current head (git merge-base --is-ancestor: a rebased or amended branch never
# matches), the record finished within _CROSS_RUN_MAX_AGE_SECONDS
# (DEPLOY_LANE_SCOPED_REUSE_MAX_AGE_SECONDS may only lower it; a future-dated
# or non-finite timestamp is rejected everywhere, so a corrupt or clock-stepped
# record can never sort first and outrank a failed head) and the record
# file is still byte-identical when the hit is taken. Records are never copied
# into the current run: the row names the source run id, run dir and record
# path with cross_run=true, and candidates stay ordered newest first across
# runs. Failed heads recorded in ANY considered run veto exactly as in-run
# ones do (never fewer vetoes). The exact --reuse-passed cache stays per run.
_CROSS_RUN_MAX_AGE_SECONDS = 24 * 60 * 60.0
# The pipeline stamps every lane launch with this token (process identity,
# excluded from fingerprints); the stage echoes it in each row's detail so the
# receipt lane is matched to its own row regardless of start-time skew.
_LANE_TOKEN_ENV = "DEPLOY_PIPELINE_LANE_TOKEN"
# Never inert for any lane: prompts, commands and skills are read by structural
# gates and prompt-invariant suites, the agent instructions are read by tests,
# and CI/editor configuration changes what runs.
_NEVER_INERT = (
    ".claude/*",
    "CLAUDE.md",
    "AGENTS.md",
    "*/CLAUDE.md",
    "*/AGENTS.md",
    ".github/*",
    ".conductor/*",
    ".cursor/*",
)
# Documentation trees no deploy suite executes. Markdown elsewhere is NOT
# inert: prompts and skills ship as .md and are loaded at run time.
_INERT_DOCS = (
    "docs/*",
    "README.md",
    "*/README.md",
    "research/*",
    "pitch-deck/*",
    "prompt-review/*",
    "claude-code-src/*",
)
# Test trees of each package. agents/tests/e2e and agents/tests/env_defaults.py
# are deliberately absent: agents/benchmarks/run_benchmark.py imports
# tests.e2e.test_helpers, so the smoke and semantic stacks execute them.
_INERT_AGENTS_TESTS = ("agents/tests/blackbox/*", "agents/tests/unit/*", "agents/tests/demo_cache/*")
_INERT_BACKEND_TESTS = ("back-end/src/tests/*",)
_INERT_FRONTEND_TESTS = ("front-end/src/tests/*",)
_INERT_MAC_TESTS = ("mac-app/tests/*",)
_INERT_SCRIPT_TESTS = ("scripts/tests/*",)


@dataclass(frozen=True)
class _ScopedLane:
    """Inert patterns of one lane and the selector lanes whose selection must
    stay empty. Empty ``graph_lanes`` means the lane runs no selector-mapped
    suite (it executes runtime code), so (b) reduces to the selector not
    falling back to ALL."""

    inert: tuple[str, ...]
    graph_lanes: tuple[str, ...]
    runs: str
    # Substrings one of which must appear in the stage's argv: the lane's real
    # command. Any other command under the same stage name is never scoped.
    markers: tuple[str, ...]


_SCOPED_REUSE_LANES: dict[str, _ScopedLane] = {
    # npm run test:coverage:sharded: backend blackbox shards, contract and unit
    # tests, then scripts/tests/blackbox-backend-teardown.test.sh, so
    # scripts/tests is NOT inert here.
    "backend-coverage-blackbox": _ScopedLane(
        inert=(*_INERT_DOCS, *_INERT_AGENTS_TESTS, *_INERT_FRONTEND_TESTS, *_INERT_MAC_TESTS),
        graph_lanes=("backend-blackbox", "backend-unit"),
        runs="backend blackbox/contract/unit suites under coverage",
        markers=("test:coverage:sharded", "run-coverage-sharded"),
    ),
    # scripts/run_deploy_live_probes.py: the credential, Amplitude and chat
    # router failover backend blackbox domains through the blackbox runner.
    "live-probes": _ScopedLane(
        inert=(*_INERT_DOCS, *_INERT_AGENTS_TESTS, *_INERT_FRONTEND_TESTS, *_INERT_MAC_TESTS),
        graph_lanes=("backend-blackbox", "backend-unit"),
        runs="backend live-probe blackbox domains",
        markers=("run_deploy_live_probes.py",),
    ),
    # bash scripts/run-coverage.sh: agents blackbox domains plus unit and DEMO
    # cache pytest; its benchmark domain executes scripts/tests fixtures, so
    # scripts/tests is NOT inert here.
    "agents-coverage-blackbox": _ScopedLane(
        inert=(*_INERT_DOCS, *_INERT_BACKEND_TESTS, *_INERT_FRONTEND_TESTS, *_INERT_MAC_TESTS),
        graph_lanes=("agents-blackbox", "agents-pytest"),
        runs="agents blackbox/unit/demo-cache suites under coverage",
        markers=("run-coverage.sh",),
    ),
    # scripts/run-predeploy-local: a real stack (backend, worker, frontend)
    # running benchmark tasks; it executes runtime code from every package and
    # reads agents/benchmarks (catalog and history), so only documentation and
    # the packages' test trees are inert.
    "smoke": _ScopedLane(
        inert=(
            *_INERT_DOCS, *_INERT_AGENTS_TESTS, *_INERT_BACKEND_TESTS, *_INERT_FRONTEND_TESTS,
            *_INERT_MAC_TESTS, *_INERT_SCRIPT_TESTS,
        ),
        graph_lanes=(),
        runs="the local pre-deploy benchmark stack",
        markers=("run-predeploy-local",),
    ),
    # run.sh --benchmark stack plus front-end/scripts/run-semantic-tests.sh
    # (Playwright specs under front-end/tests-e2e, which are not inert).
    "semantic-stack": _ScopedLane(
        inert=(
            *_INERT_DOCS, *_INERT_AGENTS_TESTS, *_INERT_BACKEND_TESTS, *_INERT_FRONTEND_TESTS,
            *_INERT_MAC_TESTS, *_INERT_SCRIPT_TESTS,
        ),
        graph_lanes=(),
        runs="the semantic Playwright suite on a full local stack",
        markers=("run-semantic-tests.sh",),
    ),
}

# What the stack lanes execute, read from scripts/run-predeploy-local (run-bench
# --local -> run.sh --benchmark -> run_benchmark.py), scripts/run.sh (the seed
# cache/restore/validate/save scripts, seed-local, the schema/index helpers,
# the backend, worker and frontend services) and
# front-end/scripts/run-semantic-tests.sh (the session generator and the
# Playwright run on the same stack). A changed path whose reverse-dependency
# closure contains one of these is executed by the stack and never inert.
STACK_ENTRYPOINTS = (
    "scripts/run-predeploy-local",
    "scripts/run-bench",
    "scripts/run.sh",
    "scripts/lib/seed-cache.sh",
    "scripts/restore-seed-dump.sh",
    "scripts/save-seed-dump.sh",
    "scripts/validate-canonical-seed-dump.sh",
    "back-end/src/bootstrap.ts",
    "back-end/scripts/seed-local.ts",
    "back-end/scripts/seed-dump-cache.ts",
    "back-end/scripts/ensure-fast-mode-cache-schema.ts",
    "back-end/scripts/ensure-agent-network-grep-indexes.ts",
    "back-end/scripts/generate-test-session.ts",
    "agents/worker.py",
    "agents/benchmarks/run_benchmark.py",
    "front-end/src/main.tsx",
    "front-end/scripts/run-semantic-tests.sh",
)
# Tooling trees whose code files a stack lane may judge by reach; every other
# undeclared path (runtime source, fixtures, catalogs, prompts, configuration)
# reruns the lane as before.
_STACK_REACH_TREES = ("scripts/*", "back-end/scripts/*", "front-end/scripts/*", "agents/scripts/*", "mac-app/scripts/*")
_REACH_CODE_SUFFIXES = (".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".bash")


def _selector_module():
    """scripts/select_affected_tests.py (sibling module): the graph build is
    the slow part and happens only in Selector()."""

    try:
        import select_affected_tests
    except ImportError:
        sys.path.insert(0, str(REPO_ROOT / "scripts"))
        import select_affected_tests
    return select_affected_tests


def _reach_eligible(path: str, rules: _ScopedLane) -> tuple[bool, str]:
    """Whether a path outside ``rules.inert`` may still be judged by reach:
    only for stack lanes, only a non-test code file under a tooling tree
    (repo- and package-root configuration lies outside every tooling tree)."""

    if rules.graph_lanes:
        return False, "lane has graph lanes"
    if not any(fnmatch(path, pattern) for pattern in _STACK_REACH_TREES):
        return False, "not under a tooling tree"
    if not path.endswith(_REACH_CODE_SUFFIXES):
        return False, "not a code file"
    if _selector_module().is_test_file(path):
        return False, "test file"
    return True, "stack lane: judged by reach"


def _scoped_lane(stage: str, command: Sequence[str]) -> _ScopedLane | None:
    """The lane's rules only when ``stage`` is a scoped lane AND its argv
    carries that lane's real command marker; otherwise None (never scoped)."""

    rules = _SCOPED_REUSE_LANES.get(stage)
    if rules is None:
        return None
    joined = " ".join(os.fsdecode(argument) for argument in command)
    return rules if any(marker in joined for marker in rules.markers) else None


def _scoped_reuse_enabled(flag: bool) -> bool:
    """The flag enables; DEPLOY_LANE_SCOPED_REUSE=0 disables even with the flag."""

    return flag and os.environ.get(_SCOPED_REUSE_ENV) != "0"


def _lane_token() -> str | None:
    return os.environ.get(_LANE_TOKEN_ENV) or None


def _scoped_records_dir(run_dir: Path, stage: str) -> Path:
    return run_dir / "passed-cache" / stage / "scoped"


def _scoped_failed_dir(run_dir: Path, stage: str) -> Path:
    return run_dir / "passed-cache" / stage / "scoped-failed"


def _invocation_digest(command: Sequence[str]) -> str:
    """cwd + argv + environment (minus process identity and scheduling knobs):
    a scoped record is only comparable to the identical invocation."""

    digest = hashlib.sha256()
    _hash_invocation(digest, command)
    return digest.hexdigest()


def _worktree_state() -> tuple[str, list[str], list[str]]:
    """HEAD, tracked paths that differ from HEAD (staged or not; renames
    listed as delete + add) and untracked non-ignored paths."""

    head = _git_output("rev-parse", "HEAD").decode().strip()
    dirty = sorted(set(_split_paths(_git_output("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD"))))
    untracked = sorted(set(_split_paths(_git_output("ls-files", "--others", "--exclude-standard", "-z"))))
    return head, dirty, untracked


def _scoped_record(stage: str, fingerprint: str, command: Sequence[str], run_id: str,
                   head: str, dirty: Sequence[str], untracked: Sequence[str], exit_code: int) -> dict:
    return {
        "schema_version": 1,
        "stage": stage,
        "head": head,
        "fingerprint": fingerprint,
        "run_id": run_id,
        "exit_code": exit_code,
        "finished_at": _utc_timestamp(),
        "finished_epoch": time.time(),
        "invocation": _invocation_digest(command),
        "dirty_paths": sorted({*dirty, *untracked}),
    }


def _write_scoped_record(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True) + "\n")
    temporary.replace(path)


def _record_scoped_pass(
    run_dir: Path, stage: str, fingerprint: str, command: Sequence[str], run_id: str,
    head: str, dirty: Sequence[str], untracked: Sequence[str],
) -> None:
    """Remember the head a real pass ran on (every pass of a scoped lane's real
    command is recorded; only the lookup is opt-in). Dirty and untracked paths
    at pass time are kept so a later decision judges them like every other
    difference."""

    _write_scoped_record(
        _scoped_records_dir(run_dir, stage) / f"{fingerprint}.json",
        _scoped_record(stage, fingerprint, command, run_id, head, dirty, untracked, 0),
    )


def _record_scoped_failure(
    run_dir: Path, stage: str, fingerprint: str, command: Sequence[str], run_id: str,
    head: str, dirty: Sequence[str], untracked: Sequence[str], exit_code: int,
) -> None:
    """Remember the head a real failure ran on: a later candidate pass is
    vetoed when the current tree differs from this head only by inert paths
    (the failure, not the pass, is the latest evidence about these bytes)."""

    _write_scoped_record(
        _scoped_failed_dir(run_dir, stage) / f"{fingerprint}-{int(time.time() * 1000)}.json",
        _scoped_record(stage, fingerprint, command, run_id, head, dirty, untracked, exit_code),
    )


def _load_scoped_records(directory: Path, stage: str, invocation: str) -> list[dict]:
    records = []
    try:
        candidates = list(directory.glob("*.json"))
    except OSError:
        return []
    for path in candidates:
        try:
            raw = path.read_bytes()
            payload = json.loads(raw)
        except (json.JSONDecodeError, OSError):
            continue
        if (
            isinstance(payload, dict)
            and payload.get("schema_version") == 1
            and payload.get("stage") == stage
            and payload.get("invocation") == invocation
            and isinstance(payload.get("head"), str)
            and isinstance(payload.get("fingerprint"), str)
        ):
            # Where the record was read and what it contained: a cross-run hit
            # re-checks both so a retired run dir is a miss, never a copy.
            payload["_record_path"] = str(path)
            payload["_record_digest"] = hashlib.sha256(raw).hexdigest()
            records.append(payload)
    records.sort(key=lambda record: float(record.get("finished_epoch") or 0.0), reverse=True)
    return records


def _record_is_intact(record: dict) -> bool:
    """The record file still exists byte-for-byte where it was read."""

    try:
        raw = Path(record["_record_path"]).read_bytes()
    except (KeyError, OSError):
        return False
    return hashlib.sha256(raw).hexdigest() == record.get("_record_digest")


def _cross_run_max_age_seconds() -> float:
    """24 h unless DEPLOY_LANE_SCOPED_REUSE_MAX_AGE_SECONDS lowers it; the
    environment can never widen the bound."""

    raw = (os.environ.get(_CROSS_RUN_MAX_AGE_ENV) or "").strip()
    if not raw:
        return _CROSS_RUN_MAX_AGE_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return _CROSS_RUN_MAX_AGE_SECONDS
    if value != value or value < 0:  # NaN or negative: keep the default
        return _CROSS_RUN_MAX_AGE_SECONDS
    return min(value, _CROSS_RUN_MAX_AGE_SECONDS)


def _run_metadata(run_dir: Path) -> dict | None:
    try:
        payload = json.loads((run_dir / "metadata.json").read_text())
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


@dataclass(frozen=True)
class _ConsideredRun:
    run_id: str
    run_dir: Path
    cross_run: bool
    branch: str | None = None


def _branch_of(metadata: dict) -> str | None:
    branch = metadata.get("branch")
    return branch if isinstance(branch, str) and branch else None


def _considered_runs(run_root: Path, run_dir: Path) -> list[_ConsideredRun]:
    """The current run first, then every earlier run dir of the same root
    (worktree-local), newest first, each with the branch its metadata
    recorded. The branch is provenance, not a filter: a follow-up branch or
    the next deploy of the same tree is a valid source, and the record guards
    (identical invocation, age bound, ancestor head, intact bytes, own run id)
    decide. A retired run dir is simply absent; unreadable metadata or a
    missing or later start excludes a run."""

    current = _run_metadata(run_dir) or {}
    runs = [_ConsideredRun(run_dir.name, run_dir, False, _branch_of(current))]
    try:
        started = float(current.get("started_epoch"))
    except (TypeError, ValueError):
        return runs
    try:
        entries = [entry for entry in run_root.iterdir() if entry.is_dir()]
    except OSError:
        return runs
    earlier: list[tuple[float, _ConsideredRun]] = []
    for entry in entries:
        if entry.name == run_dir.name or re.fullmatch(r"[A-Za-z0-9._-]+", entry.name) is None:
            continue
        metadata = _run_metadata(entry)
        if metadata is None:
            continue
        try:
            entry_started = float(metadata.get("started_epoch"))
        except (TypeError, ValueError):
            continue
        if entry_started >= started:
            continue
        earlier.append((entry_started, _ConsideredRun(entry.name, entry, True, _branch_of(metadata))))
    earlier.sort(key=lambda item: item[0], reverse=True)
    runs.extend(run for _, run in earlier)
    return runs


def _is_ancestor(ancestor: str, descendant: str) -> bool:
    completed = subprocess.run(
        ("git", "merge-base", "--is-ancestor", ancestor, descendant),
        cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return completed.returncode == 0


def _scoped_records_across_runs(
    runs: Sequence[_ConsideredRun], stage: str, invocation: str, *, failed: bool, current_head: str, now: float,
) -> tuple[list[dict], dict[str, int]]:
    """The lane's PASSED (or, with ``failed``, failed) records across the
    considered runs, newest first, each annotated with its source run. Every
    pass needs a finite, non-future ``finished_epoch`` (a future-dated record
    would sort first and set the veto threshold beyond every failed head); a
    cross-run pass must additionally be within the age bound, an ancestor of
    the current head and carry its own run's id. Failures veto regardless
    (never fewer vetoes). The rejection counts explain a miss: ``age`` covers
    the bound, future-dated and non-finite timestamps of any run."""

    max_age = _cross_run_max_age_seconds()
    rejected = {"age": 0, "not_ancestor": 0, "foreign_run_id": 0}
    ancestry: dict[str, bool] = {}
    records: list[dict] = []
    for run in runs:
        directory = (_scoped_failed_dir if failed else _scoped_records_dir)(run.run_dir, stage)
        for record in _load_scoped_records(directory, stage, invocation):
            source = {"run_id": run.run_id, "run_dir": str(run.run_dir), "cross_run": run.cross_run, "branch": run.branch}
            if failed:
                record["_source"] = source
                records.append(record)
                continue
            if run.cross_run and record.get("run_id") != run.run_id:
                rejected["foreign_run_id"] += 1
                continue
            age = now - float(record.get("finished_epoch") or 0.0)
            if not math.isfinite(age) or age < 0 or (run.cross_run and age > max_age):
                rejected["age"] += 1
                continue
            if run.cross_run:
                head = record["head"]
                if head not in ancestry:
                    ancestry[head] = _is_ancestor(head, current_head)
                if not ancestry[head]:
                    rejected["not_ancestor"] += 1
                    continue
            record["_source"] = source
            records.append(record)
    records.sort(key=lambda record: float(record.get("finished_epoch") or 0.0), reverse=True)
    return records, rejected


def _judge_declared(path: str, rules: _ScopedLane) -> tuple[bool, str]:
    """(a): the lane's declared inert set, never-inert patterns first."""

    for pattern in _NEVER_INERT:
        if fnmatch(path, pattern):
            return False, f"never-inert:{pattern}"
    for pattern in rules.inert:
        if fnmatch(path, pattern):
            return True, f"inert:{pattern}"
    return False, "not in the lane's declared inert set"


class _GraphJudge:
    """(b): one selector over the current tree, queried per changed path. For
    stack lanes every path is additionally judged by reach from
    STACK_ENTRYPOINTS; ``declared`` is False for a path that reached the graph
    through _reach_eligible rather than the lane's inert set, which also makes
    a run_lanes trigger (shared test infrastructure) a rerun."""

    def __init__(self) -> None:
        self._module = _selector_module()
        self._selector = self._module.Selector()

    def _lane_triggers(self, path: str) -> list[str]:
        """Lanes the selector's run_lanes rules rerun whole for this path:
        declared shared test infrastructure (runners, helpers, manifests)."""

        return sorted({
            lane
            for rule in self._selector.config.get("run_lanes", [])
            if self._module._match(path, rule["from"])
            for lane in rule["lanes"]
        })

    def judge(self, path: str, rules: _ScopedLane, *, declared: bool = True) -> tuple[bool, str]:
        selection = self._selector.select([path])
        if selection.all_lanes:
            return False, "graph:ALL (" + "; ".join(selection.reasons) + ")"
        selected = {
            lane: sorted(selection.selected.get(lane, ()))
            for lane in rules.graph_lanes
            if selection.selected.get(lane)
        }
        if selected:
            listed = "; ".join(f"{lane}: {', '.join(units[:5])}" for lane, units in selected.items())
            return False, f"graph:selects {listed}"
        if rules.graph_lanes:
            return True, "graph:no " + "/".join(rules.graph_lanes) + " test selected"
        triggers = [] if declared else self._lane_triggers(path)
        if triggers:
            return False, "graph:run_lanes trigger for " + ", ".join(triggers[:5])
        missing = [entry for entry in STACK_ENTRYPOINTS if entry not in self._selector.graph.fileset]
        if missing:
            return False, f"graph:stack entrypoint missing: {missing[0]}"
        upstream = self._selector.upstream({path})
        reached = [entry for entry in STACK_ENTRYPOINTS if entry in upstream]
        served = sorted(node for node in upstream if node.startswith("http:"))
        if reached or served:
            return False, "graph:reached by the stack via " + ", ".join((reached + served)[:5])
        return True, "graph:no ALL fallback; unreached from the stack entrypoints"


@dataclass
class _ScopedDecision:
    hit: bool
    stage: str
    rules: _ScopedLane
    current_head: str
    record: dict | None = None
    changed: list[dict] = field(default_factory=list)
    miss_reason: str = ""
    blocked: list[dict] = field(default_factory=list)
    candidates: int = 0
    vetoed_by: dict | None = None
    considered_runs: list[str] = field(default_factory=list)
    rejected_cross_run: dict[str, int] = field(default_factory=dict)

    def provenance(self) -> dict:
        rules = self.rules
        out: dict = {
            "kind": "scoped",
            "current_head": self.current_head,
            "command_marker": list(rules.markers),
            "graph_lanes": list(rules.graph_lanes),
            "inert_patterns": list(rules.inert),
            "never_inert_patterns": list(_NEVER_INERT),
            "considered_runs": list(self.considered_runs),
            "rejected_cross_run": dict(self.rejected_cross_run),
        }
        if self.record is not None:
            source = self.record.get("_source") or {}
            out.update(
                passed_head=self.record["head"],
                passed_fingerprint=self.record["fingerprint"],
                passed_run_id=self.record.get("run_id"),
                passed_run_dir=source.get("run_dir"),
                passed_record=self.record.get("_record_path"),
                passed_at=self.record.get("finished_at"),
                passed_run_branch=source.get("branch"),
                cross_run=bool(source.get("cross_run")),
            )
        if self.hit:
            out["changed"] = self.changed
        else:
            out["miss_reason"] = self.miss_reason
            out["candidates"] = self.candidates
            if self.blocked:
                out["blocked"] = self.blocked[:20]
            if self.vetoed_by is not None:
                out["vetoed_by_failed_head"] = self.vetoed_by
        return out


def _judge_changes(
    rules: _ScopedLane, changed: Sequence[str], judge: "_GraphJudge | None"
) -> tuple[list[dict], list[dict], "_GraphJudge | None"]:
    """Every changed path with the rule that judged it; blocked ones separately.
    The selector is built lazily, only once every path has passed (a)."""

    judged: list[dict] = []
    blocked: list[dict] = []
    undeclared: set[str] = set()
    for path in changed:
        inert, rule = _judge_declared(path, rules)
        entry = {"path": path, "rule": rule}
        judged.append(entry)
        if inert:
            continue
        if not rule.startswith("never-inert:"):
            eligible, why = _reach_eligible(path, rules)
            if eligible:
                entry["rule"] = f"{rule}; {why}"
                undeclared.add(path)
                continue
        blocked.append(entry)
    if blocked:
        return judged, blocked, judge
    if judge is None:
        judge = _GraphJudge()
    for entry in judged:
        inert, rule = judge.judge(entry["path"], rules, declared=entry["path"] not in undeclared)
        entry["graph"] = rule
        if not inert:
            blocked.append(entry)
    return judged, blocked, judge


def _changed_between(passed_head: str, current_head: str, dirty: Sequence[str], untracked: Sequence[str],
                     recorded_dirty: Sequence[str]) -> list[str]:
    tree = _split_paths(_git_output("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", passed_head, current_head))
    return sorted({*tree, *dirty, *untracked, *recorded_dirty})


def _failed_head_veto(
    failed_records: Sequence[dict], rules: _ScopedLane, current_head: str,
    dirty: Sequence[str], untracked: Sequence[str], judge: "_GraphJudge | None", *, newer_than: float,
) -> tuple[dict | None, "_GraphJudge | None"]:
    """The failed record (from any considered run), newer than the candidate
    pass, whose head differs from the current tree only by inert paths, if
    any: that failure is the latest evidence about these bytes, so the older
    pass may not be reused over it. A pass recorded after the failure
    supersedes it."""

    for record in failed_records:
        if float(record.get("finished_epoch") or 0.0) <= newer_than:
            continue
        try:
            changed = _changed_between(record["head"], current_head, dirty, untracked, record.get("dirty_paths") or [])
        except subprocess.CalledProcessError:
            continue
        judged, blocked, judge = _judge_changes(rules, changed, judge)
        if not blocked:
            source = record.get("_source") or {}
            return {
                "failed_head": record["head"],
                "failed_at": record.get("finished_at"),
                "failed_run_id": record.get("run_id"),
                "failed_run_dir": source.get("run_dir"),
                "failed_run_branch": source.get("branch"),
                "cross_run": bool(source.get("cross_run")),
                "exit_code": record.get("exit_code"),
                "inert_changes_since_failure": judged,
            }, judge
    return None, judge


def _scoped_reuse_decision(
    run_root: Path, run_dir: Path, stage: str, rules: _ScopedLane, command: Sequence[str],
) -> _ScopedDecision:
    current_head, dirty, untracked = _worktree_state()
    invocation = _invocation_digest(command)
    now = time.time()
    runs = _considered_runs(run_root, run_dir)
    records, rejected = _scoped_records_across_runs(
        runs, stage, invocation, failed=False, current_head=current_head, now=now,
    )
    failed_records, _ = _scoped_records_across_runs(
        runs, stage, invocation, failed=True, current_head=current_head, now=now,
    )
    decision = _ScopedDecision(
        hit=False, stage=stage, rules=rules, current_head=current_head, candidates=len(records),
        considered_runs=[run.run_id for run in runs], rejected_cross_run=rejected,
    )
    if not records:
        decision.miss_reason = (
            "no prior pass of this lane for the identical command, cwd and environment "
            f"({len(runs)} run(s) considered)"
        )
        return decision
    judge: _GraphJudge | None = None
    first_blocked: list[dict] = []
    changed_before_hit = 0
    for record in records:
        try:
            changed = _changed_between(record["head"], current_head, dirty, untracked, record.get("dirty_paths") or [])
        except subprocess.CalledProcessError:
            continue  # the passed head is not in this repository any more
        judged, blocked, judge = _judge_changes(rules, changed, judge)
        if not blocked:
            veto, judge = _failed_head_veto(
                failed_records, rules, current_head, dirty, untracked, judge,
                newer_than=float(record.get("finished_epoch") or 0.0),
            )
            if veto is not None:
                decision.record = record
                decision.vetoed_by = veto
                decision.miss_reason = (
                    f"a failed run on {veto['failed_head'][:12]} differs from the current tree only by inert paths"
                )
                return decision
            if (record.get("_source") or {}).get("cross_run") and not _record_is_intact(record):
                changed_before_hit += 1  # the source record changed or vanished between the read and the hit
                continue
            decision.hit = True
            decision.record = record
            decision.changed = judged
            return decision
        if not first_blocked:
            first_blocked = blocked
            decision.record = record
    decision.blocked = first_blocked
    if first_blocked:
        decision.miss_reason = f"{len(first_blocked)} changed path(s) are not provably inert"
    elif changed_before_hit:
        decision.miss_reason = f"{changed_before_hit} candidate record(s) changed or vanished before the hit"
    else:
        decision.miss_reason = "no candidate pass head is reachable in this repository"
    return decision


def _print_scoped_hit(decision: _ScopedDecision) -> None:
    record = decision.record or {}
    source = record.get("_source") or {}
    print(
        f"== reused passed deploy stage (lane-scoped): {decision.stage} "
        f"passed_head={record.get('head', '')[:12]} current_head={decision.current_head[:12]} "
        f"inert_paths={len(decision.changed)} passed_run={record.get('run_id', '')} "
        f"cross_run={'true' if source.get('cross_run') else 'false'} ==",
        flush=True,
    )
    for entry in decision.changed:
        print(f"   inert: {entry['path']} ({entry['rule']}; {entry.get('graph', '')})", flush=True)


def _print_scoped_miss(decision: _ScopedDecision) -> None:
    # Flushed: the pipeline appends this runner's stdout to the lane log while
    # the child's bytes are written through sys.stdout.buffer, so an unflushed
    # decision would land after the command's output (at exit).
    print(f"== lane-scoped reuse unavailable for {decision.stage}: {decision.miss_reason} ==", flush=True)
    for entry in decision.blocked[:20]:
        print(f"   rerun: {entry['path']} ({entry['rule']}; {entry.get('graph', 'graph not consulted')})", flush=True)


def _preview_lane_scoped_reuse(spec: str) -> int:
    """Dry run over a commit range: which scoped lanes would reuse a pass made
    on PASSED_HEAD at CURRENT_HEAD (default: HEAD plus the worktree), and why.
    The selector graph is built from the checked-out tree."""

    passed_head, _, current_spec = spec.partition("..")
    try:
        passed_head = _git_output("rev-parse", "--verify", f"{passed_head}^{{commit}}").decode().strip()
        if current_spec:
            current_head = _git_output("rev-parse", "--verify", f"{current_spec}^{{commit}}").decode().strip()
            dirty: list[str] = []
            untracked: list[str] = []
        else:
            current_head, dirty, untracked = _worktree_state()
        changed = _changed_between(passed_head, current_head, dirty, untracked, [])
    except subprocess.CalledProcessError as error:
        print(f"could not resolve {spec!r}: {error.stderr.decode(errors='replace').strip()}", file=sys.stderr)
        return 2
    print(f"lane-scoped reuse preview: passed_head={passed_head[:12]} current_head={current_head[:12]} "
          f"changed_paths={len(changed)} (each lane assumed to run its real command; failed-head records not consulted)")
    judge: _GraphJudge | None = None
    reused = 0
    for stage, rules in _SCOPED_REUSE_LANES.items():
        judged, blocked, judge = _judge_changes(rules, changed, judge)
        if blocked:
            print(f"  {stage}: RERUN ({len(blocked)} path(s) not provably inert)")
            for entry in blocked[:20]:
                print(f"      {entry['path']} ({entry['rule']}; {entry.get('graph', 'graph not consulted')})")
        else:
            reused += 1
            print(f"  {stage}: REUSED-SCOPED ({len(judged)} inert path(s))")
            for entry in judged:
                print(f"      {entry['path']} ({entry['rule']}; {entry.get('graph', '')})")
    print(f"lane-scoped reuse preview: {reused}/{len(_SCOPED_REUSE_LANES)} lane(s) would be reused-scoped")
    return 0


def _append_reused(
    run_dir: Path,
    run_id: str,
    stage: str,
    fingerprint: str,
    telemetry: dict,
    invoked_epoch: float,
    *,
    status: str = "reused",
    reuse: dict | None = None,
    started_epoch: float | None = None,
) -> None:
    """Record an exact-input reuse so reviews can count skipped reruns.

    A lane-scoped reuse records ``status="reused-scoped"`` with its provenance
    and starts at the stage's invocation so the pipeline matches its row.
    """

    now = time.time()
    started = now if started_epoch is None else started_epoch
    try:
        append_stage(
            run_dir,
            run_id=run_id,
            stage=stage,
            started_at=_utc_timestamp(),
            finished_at=_utc_timestamp(),
            started_epoch=started,
            finished_epoch=now,
            exit_code=0,
            log="",
            telemetry=telemetry,
            status=status,
            detail={
                "schema_version": 1,
                "outcome": {"exit_code": 0, "failure_class": None},
                "reuse": reuse if reuse is not None else reuse_detail(run_dir, fingerprint, requested=True, hit=True),
                "timing": {"setup_seconds": round(max(0.0, now - invoked_epoch), 3), "exec_seconds": 0.0},
                **({"lane_token": _lane_token()} if _lane_token() else {}),
            },
        )
    except OSError as error:
        print(f"warning: could not append reused stage record: {error}", file=sys.stderr)


def _run_logged(log_path: Path, command: Sequence[str]) -> tuple[int, int]:
    """Run ``command`` and return ``(exit code, forwarded signal or 0)``.

    The signal is the first one this runner received and forwarded to the
    command (a lane the pipeline superseded, an operator's Ctrl-C). It is
    reported separately from the exit code because a command can legitimately
    exit 143 on its own; only the runner knows whether it was interrupted."""

    received_signal = 0
    child: subprocess.Popen[bytes] | None = None
    kill_timer_started = False

    def force_kill_after_grace() -> None:
        time.sleep(CLEANUP_GRACE_SECONDS)
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def forward(signum: int, _frame: object) -> None:
        nonlocal kill_timer_started, received_signal
        received_signal = received_signal or signum
        if child is None or child.poll() is not None:
            return
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            return
        if not kill_timer_started:
            kill_timer_started = True
            threading.Thread(target=force_kill_after_grace, daemon=True).start()

    for forwarded_signal in FORWARDED_SIGNALS:
        signal.signal(forwarded_signal, forward)

    child_exit = 127
    try:
        with log_path.open("wb") as log_handle:
            if received_signal:
                return 128 + received_signal, received_signal
            try:
                child = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as error:
                print(f"could not start command: {error}", file=sys.stderr)
                return 127, received_signal
            if received_signal:
                forward(received_signal, None)

            assert child.stdout is not None
            while True:
                try:
                    chunk = os.read(child.stdout.fileno(), 65536)
                except InterruptedError:
                    continue
                if not chunk:
                    break
                log_handle.write(chunk)
                try:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                except BrokenPipeError:
                    pass
            child_exit = child.wait()
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=CLEANUP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()

    if received_signal:
        return 128 + received_signal, received_signal
    if child_exit < 0:
        return 128 - child_exit, 0
    return child_exit, 0


def _source_in_background() -> tuple[threading.Thread, dict]:
    """Collect source detail concurrently so it never adds to stage wall time."""

    source: dict = {}

    def collect() -> None:
        try:
            source.update(source_detail(REPO_ROOT))
        except Exception as error:  # Telemetry must never change a gate result.
            print(f"warning: could not collect source detail: {type(error).__name__}", file=sys.stderr)

    thread = threading.Thread(target=collect, daemon=True)
    thread.start()
    return thread, source


def main() -> int:
    invoked_epoch = time.time()
    args = _parser().parse_args()
    if args.preview_lane_scoped_reuse:
        return _preview_lane_scoped_reuse(args.preview_lane_scoped_reuse)
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if (
        args.run_root is None
        or not command
        or not args.stage
        or re.fullmatch(r"[A-Za-z0-9._-]+", args.stage) is None
    ):
        print("run_deploy_stage.py: --run-root, a valid STAGE and COMMAND are required", file=sys.stderr)
        return 2

    try:
        telemetry = load_metadata()
    except (OSError, ValueError) as error:
        print(f"invalid factory metadata: {type(error).__name__}", file=sys.stderr)
        return 2

    token = f"{args.stage}-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        run_id = admit_stage(args.run_root, token=token, pid=os.getpid())
    except LifecycleError as error:
        print(f"deploy timing lifecycle error: {error}", file=sys.stderr)
        return 2

    run_dir = args.run_root / run_id
    concurrent_stages = max(0, active_admissions(run_dir) - 1)
    # Every pass is cached against its inputs, so a standalone run (or an inner
    # stage a lane launches without --reuse-passed) is reusable by a later
    # --reuse-passed run of the identical command; only the lookup is opt-in.
    fingerprint: str | None = None
    worktree_state: tuple[str, list[str], list[str]] | None = None
    scoped_rules = _scoped_lane(args.stage, command)
    try:
        fingerprint = _worktree_fingerprint(command, args.stage)
        if scoped_rules is not None:
            worktree_state = _worktree_state()
    except (OSError, subprocess.SubprocessError) as error:
        print(f"warning: could not fingerprint deploy inputs: {error}", file=sys.stderr)
    if args.reuse_passed and fingerprint is not None and _cache_hit(run_dir, args.stage, fingerprint):
        _append_reused(run_dir, run_id, args.stage, fingerprint, telemetry, invoked_epoch)
        try:
            release_stage(args.run_root, run_id=run_id, token=token)
        except (LifecycleError, OSError) as error:
            print(f"warning: could not release deploy stage admission: {error}", file=sys.stderr)
        print(f"== reused passed deploy stage: {args.stage} ({_fingerprint_scope(args.stage, command)} + command) ==",
              flush=True)
        return 0
    # Lane-scoped reuse: only after the exact lookup missed, only for the
    # listed lanes, only when enabled. Any error in the decision reruns.
    scoped_decision: _ScopedDecision | None = None
    if _scoped_reuse_enabled(args.lane_scoped_reuse) and scoped_rules is not None:
        try:
            scoped_decision = _scoped_reuse_decision(args.run_root, run_dir, args.stage, scoped_rules, command)
        except Exception as error:  # a scheduling decision must never fail a gate: rerun instead
            print(f"warning: lane-scoped reuse decision failed; rerunning {args.stage}: {type(error).__name__}: {error}",
                  file=sys.stderr)
            scoped_decision = None
        if scoped_decision is not None and scoped_decision.hit and scoped_decision.record is not None:
            reuse = {"requested": True, "hit": True, "fingerprint": scoped_decision.record["fingerprint"][:12],
                     **scoped_decision.provenance()}
            _append_reused(
                run_dir, run_id, args.stage, scoped_decision.record["fingerprint"], telemetry, invoked_epoch,
                status="reused-scoped", reuse=reuse, started_epoch=invoked_epoch,
            )
            try:
                release_stage(args.run_root, run_id=run_id, token=token)
            except (LifecycleError, OSError) as error:
                print(f"warning: could not release deploy stage admission: {error}", file=sys.stderr)
            _print_scoped_hit(scoped_decision)
            return 0
        if scoped_decision is not None:
            _print_scoped_miss(scoped_decision)

    log_relative = f"logs/{args.stage}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{os.getpid()}.log"
    log_path = run_dir / log_relative
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started_at = _utc_timestamp()
    started_epoch = time.time()
    print(f"== deploy stage: {args.stage} ==", flush=True)

    source_thread, source = _source_in_background()
    sampler = HostSampler().start()
    stage_exit, interrupted_by = _run_logged(log_path, command)
    finished_epoch = time.time()
    host = sampler.stop()
    source_thread.join(timeout=30)
    try:
        detail = stage_detail(
            exit_code=stage_exit,
            log_path=log_path,
            invoked_epoch=invoked_epoch,
            started_epoch=started_epoch,
            finished_epoch=finished_epoch,
            concurrent_stages=concurrent_stages,
            host=host,
            source=dict(source),
            attempt=attempt_detail(run_dir, args.stage, source),
            reuse={
                **reuse_detail(
                    run_dir / "passed-cache" / args.stage,
                    fingerprint,
                    requested=args.reuse_passed,
                    hit=False,
                ),
                **({"scoped": scoped_decision.provenance()} if scoped_decision is not None else {}),
            },
        )
        if _lane_token():
            detail["lane_token"] = _lane_token()
    except Exception as error:  # Telemetry must never change a gate result.
        print(f"warning: could not build stage detail: {type(error).__name__}", file=sys.stderr)
        detail = None
    try:
        append_stage(
            run_dir,
            run_id=run_id,
            stage=args.stage,
            started_at=started_at,
            finished_at=_utc_timestamp(),
            started_epoch=started_epoch,
            finished_epoch=finished_epoch,
            exit_code=stage_exit,
            log=log_relative,
            telemetry=telemetry,
            detail=detail,
        )
    except OSError as error:
        print(f"warning: could not append deploy stage record: {error}", file=sys.stderr)
    try:
        release_stage(args.run_root, run_id=run_id, token=token)
    except (LifecycleError, OSError) as error:
        print(f"warning: could not release deploy stage admission: {error}", file=sys.stderr)

    # An interrupted lane (the pipeline superseding its run, an operator's
    # Ctrl-C) says nothing about the head: it is not recorded as a failure, so
    # it never vetoes a later lane-scoped reuse of a real pass. The runner's
    # own forwarded signal decides this, never the exit code: a gate can exit
    # 143 by itself, and that is a real failure.
    if interrupted_by:
        print(
            f"deploy stage {args.stage} was interrupted by signal {interrupted_by}; "
            "its exit is not recorded as a failed head",
            file=sys.stderr,
        )
    elif stage_exit != 0 and fingerprint is not None and worktree_state is not None:
        try:
            head, dirty, untracked = worktree_state
            _record_scoped_failure(run_dir, args.stage, fingerprint, command, run_id, head, dirty, untracked, stage_exit)
        except OSError as error:
            print(f"warning: could not record the failed head for lane-scoped reuse: {error}", file=sys.stderr)
    if stage_exit == 0 and fingerprint is not None:
        try:
            finished_fingerprint = _worktree_fingerprint(command, args.stage)
            if finished_fingerprint == fingerprint:
                _record_cache_hit(run_dir, args.stage, fingerprint)
                if worktree_state is not None:
                    head, dirty, untracked = worktree_state
                    _record_scoped_pass(run_dir, args.stage, fingerprint, command, run_id, head, dirty, untracked)
            else:
                print(
                    f"warning: deploy inputs changed while {args.stage} ran; pass was not cached",
                    file=sys.stderr,
                )
        except (OSError, subprocess.SubprocessError) as error:
            print(f"warning: could not cache passed deploy stage: {error}", file=sys.stderr)

    print(f"== deploy stage: {args.stage} exit={stage_exit} log={log_path} ==")
    return stage_exit


if __name__ == "__main__":
    raise SystemExit(main())
