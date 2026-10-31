#!/usr/bin/env python3
"""Run and record one /deploy stage without per-stage helper processes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
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
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--reuse-passed", action="store_true")
    parser.add_argument("stage")
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
# run_deploy_pipeline.py stamps every lane with a fresh DEPLOY_PIPELINE_LANE_TOKEN
# (teardown ownership of the processes the lane starts); it identifies the lane
# process, not a gate input.
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


def _is_process_identity_env(name: str) -> bool:
    return name in _PROCESS_IDENTITY_ENV or name.startswith(_PROCESS_IDENTITY_ENV_PREFIXES)


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


def _append_reused(
    run_dir: Path,
    run_id: str,
    stage: str,
    fingerprint: str,
    telemetry: dict,
    invoked_epoch: float,
) -> None:
    """Record an exact-input reuse so reviews can count skipped reruns."""

    now = time.time()
    try:
        append_stage(
            run_dir,
            run_id=run_id,
            stage=stage,
            started_at=_utc_timestamp(),
            finished_at=_utc_timestamp(),
            started_epoch=now,
            finished_epoch=now,
            exit_code=0,
            log="",
            telemetry=telemetry,
            status="reused",
            detail={
                "schema_version": 1,
                "outcome": {"exit_code": 0, "failure_class": None},
                "reuse": reuse_detail(run_dir, fingerprint, requested=True, hit=True),
                "timing": {"setup_seconds": round(max(0.0, now - invoked_epoch), 3), "exec_seconds": 0.0},
            },
        )
    except OSError as error:
        print(f"warning: could not append reused stage record: {error}", file=sys.stderr)


def _run_logged(log_path: Path, command: Sequence[str]) -> int:
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
                return 128 + received_signal
            try:
                child = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as error:
                print(f"could not start command: {error}", file=sys.stderr)
                return 127
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
        return 128 + received_signal
    if child_exit < 0:
        return 128 - child_exit
    return child_exit


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
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command or re.fullmatch(r"[A-Za-z0-9._-]+", args.stage) is None:
        print("run_deploy_stage.py: valid STAGE and COMMAND are required", file=sys.stderr)
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
    try:
        fingerprint = _worktree_fingerprint(command, args.stage)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"warning: could not fingerprint deploy inputs: {error}", file=sys.stderr)
    if args.reuse_passed and fingerprint is not None and _cache_hit(run_dir, args.stage, fingerprint):
        _append_reused(run_dir, run_id, args.stage, fingerprint, telemetry, invoked_epoch)
        try:
            release_stage(args.run_root, run_id=run_id, token=token)
        except (LifecycleError, OSError) as error:
            print(f"warning: could not release deploy stage admission: {error}", file=sys.stderr)
        print(f"== reused passed deploy stage: {args.stage} ({_fingerprint_scope(args.stage, command)} + command) ==")
        return 0

    log_relative = f"logs/{args.stage}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{os.getpid()}.log"
    log_path = run_dir / log_relative
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started_at = _utc_timestamp()
    started_epoch = time.time()
    print(f"== deploy stage: {args.stage} ==")

    source_thread, source = _source_in_background()
    sampler = HostSampler().start()
    stage_exit = _run_logged(log_path, command)
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
            reuse=reuse_detail(
                run_dir / "passed-cache" / args.stage,
                fingerprint,
                requested=args.reuse_passed,
                hit=False,
            ),
        )
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

    if stage_exit == 0 and fingerprint is not None:
        try:
            finished_fingerprint = _worktree_fingerprint(command, args.stage)
            if finished_fingerprint == fingerprint:
                _record_cache_hit(run_dir, args.stage, fingerprint)
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
