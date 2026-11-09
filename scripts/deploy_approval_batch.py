#!/usr/bin/env python3
"""Batch every /deploy human-approval-scoped hunk at the source freeze.

Steps 0p, 0b and 0c each flag approval-scoped files. Instead of stopping the
deploy at each guard, ``freeze`` runs all three once on the frozen snapshot,
records a per-file digest of exactly the approval-scoped diff and writes the one
combined diff for the batched approval packet. Gates keep running while the
human (or a GROUNDED golden-reference review) decides.

``check`` is the merge-time proof. It reruns the guards on the current tree and
passes only when every currently flagged file is byte-identical to the frozen,
approved snapshot. Any post-freeze edit to an approval-scoped hunk, or a newly
flagged file, fails with ``re-request``: approval stays snapshot-scoped and the
guards' semantics are unchanged (they still run, and the mandatory flag is
passed only after ``check`` succeeds).

``classify-code-only`` imports a completed independent managed review of false positives.
It keeps the native guard findings and whole-file diff hashes, without recording
approval or supplying an approval flag. Its authority is the exact assistant
result re-fetched from boxes.dev on every check; local hashes are not authority.
An independent completed owner result anchors the frozen batch, and the reviewer
must be a different managed thread. Caller context is not authentication.
Ordinary approvals also work off-box.

Exit codes: 0 clear/covered, 1 re-request or rejected, 3 decision pending,
2 usage/state error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

GUARDS = {
    "prompt-approval": ("bash", "scripts/check-prompt-human-approval.sh"),
    "agent-behavior-approval": ("bash", "scripts/check-agent-behavior-approval.sh"),
    "llm-trajectory-injection-approval": (
        "bash",
        "scripts/check-llm-trajectory-injection-approval.sh",
    ),
}
DECISIONS = {"approved", "grounded", "rejected"}
EXIT_OK, EXIT_REREQUEST, EXIT_USAGE, EXIT_PENDING = 0, 1, 2, 3
SUBPROCESS_TIMEOUT_SECONDS = 300
GUARD_TERMINATION_GRACE_SECONDS = 1
GUARD_KILL_GRACE_SECONDS = 1


class BatchError(RuntimeError):
    pass


def _git(repo: Path, *args: str) -> str:
    try:
        return subprocess.run(
            ("git", *args), cwd=repo, check=True, capture_output=True, text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        ).stdout
    except subprocess.TimeoutExpired as error:
        raise BatchError(f"git operation timed out after {SUBPROCESS_TIMEOUT_SECONDS}s") from error


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def guard_commands() -> dict[str, tuple[str, ...]]:
    """The real guards, or a JSON override (tests) from DEPLOY_APPROVAL_GUARDS."""
    override = os.environ.get("DEPLOY_APPROVAL_GUARDS")
    if override:
        if os.environ.get("DEPLOY_APPROVAL_BATCH_TEST_MODE") != "1":
            raise BatchError("guard overrides require explicit test mode")
        try:
            commands = json.loads(override)
        except json.JSONDecodeError as error:
            raise BatchError("invalid test guard override") from error
        if not isinstance(commands, dict) or not commands or any(
            not isinstance(name, str) or not name or not isinstance(command, list)
            or not command or not all(isinstance(arg, str) and arg for arg in command)
            for name, command in commands.items()
        ):
            raise BatchError("test guard overrides require a nonempty command map")
        return {name: tuple(command) for name, command in commands.items()}
    return dict(GUARDS)


def _run_guard(repo: Path, name: str, command: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
    """Own the guard session so a timeout also stops its Git/helper descendants."""
    child = subprocess.Popen(
        command, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    try:
        stdout, stderr = child.communicate(timeout=SUBPROCESS_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        try:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.communicate(timeout=GUARD_TERMINATION_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            # A leader can exit while a descendant ignores TERM or closes its
            # inherited pipes. Kill the exact owned group even in that case.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                child.communicate(timeout=GUARD_KILL_GRACE_SECONDS)
            except subprocess.TimeoutExpired as cleanup_error:
                raise BatchError(f"{name} guard cleanup exceeded its bounded deadline") from cleanup_error
        finally:
            if child.stdout is not None:
                child.stdout.close()
            if child.stderr is not None:
                child.stderr.close()
        raise BatchError(f"{name} guard timed out after {SUBPROCESS_TIMEOUT_SECONDS}s") from error
    return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)


def run_guards(repo: Path) -> dict[str, list[str]]:
    """Run each guard without the approval flag; return its flagged entries."""
    flagged: dict[str, list[str]] = {}
    for name, command in guard_commands().items():
        result = _run_guard(repo, name, command)
        if result.returncode == 0:
            flagged[name] = []
            continue
        if result.returncode != 1:
            raise BatchError(f"{name} guard errored (exit {result.returncode}): {result.stderr.strip()}")
        entries = [
            line.strip()[2:].strip()
            for line in (result.stdout + result.stderr).splitlines()
            if line.strip().startswith("- ")
        ]
        if not entries:
            raise BatchError(f"{name} guard failed without listing flagged files")
        flagged[name] = sorted(set(entries))
    return flagged


def _path_of(entry: str) -> str:
    # Guards annotate deletions: "path (deleted test file)".
    return re.sub(r" (?:\(deleted test file\)|\(removed benchmark task: [^\n]*\))$", "", entry)


def scoped_files(flagged: dict[str, list[str]]) -> list[str]:
    return sorted({_path_of(entry) for entries in flagged.values() for entry in entries})


def file_diff(repo: Path, merge_base: str, path: str) -> str:
    # Working tree vs. the merge base: committed, staged and unstaged edits count.
    return _git(repo, "diff", "--no-ext-diff", "--no-color", "--binary", merge_base, "--", path)


def digests(repo: Path, merge_base: str, files: list[str]) -> dict[str, str]:
    return {
        path: hashlib.sha256(file_diff(repo, merge_base, path).encode()).hexdigest()
        for path in files
    }


def merge_base(repo: Path, base_ref: str) -> str:
    return _git(repo, "merge-base", base_ref, "HEAD").strip()


def platform_runtime() -> dict:
    """Pin the official installation under the managed-account trust assumption.

    Platform files outside the source workspace remain trusted. These hashes
    bind that operational provenance; they are not cryptographic attestation.
    """
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    if os.environ.get("HOME") != str(home) or home.resolve() != home:
        raise BatchError("managed authority requires the OS account's canonical HOME")
    shim = Path("/opt/devbox-tools/bin/dvb-onbox")
    daemon = home / ".devbox" / "daemon"
    resolver = daemon / "resolve-daemon-node.sh"
    wrapper = daemon / "bundle/wrappers/dvb-onbox.mjs"
    config = daemon / "config.json"
    def protected(path: Path, *, root: bool = False) -> None:
        for target in (path, path.resolve(strict=True)):
            for member in (target, *target.parents):
                info = member.lstat()
                if (info.st_uid not in ({0} if root else {0, os.getuid()})
                        or not member.is_symlink() and info.st_mode & 0o022):
                    raise BatchError("official managed runtime has unexpected ownership or writable paths")
    protected(shim, root=True)
    for path in (resolver, wrapper, config):
        protected(path)
    provider = json.loads(config.read_text()).get("computeProvider", "")
    if provider == "e2b":
        node = Path("/opt/devbox-runtime/node/current/bin/node")
        protected(node, root=True)
    elif provider == "":
        node = daemon / "bundle/bin/node"
        protected(node)
    else:
        raise BatchError("unsupported official managed runtime provider")
    paths = [shim, resolver, node, Path("/usr/bin/bash"), Path("/usr/bin/env"),
             *sorted(wrapper.parent.glob("*.mjs"))]
    files = {}
    for path in paths:
        protected(path)
        files[str(path)] = dict(resolved=str(path.resolve(strict=True)),
                               sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    return dict(schema="boxes-official-runtime-v1", compute_provider=provider, files=files,
                sha256=hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest())


def managed_command(*args: str) -> dict:
    """Use the installed CLI, not a caller-supplied PATH identity provider."""
    environment = dict(os.environ)
    if os.environ.get("DEPLOY_APPROVAL_BATCH_TEST_MODE") == "1":
        binary = shutil.which("dvb-onbox")
        runtime = {"test_fixture": True}
    else:
        binary = "/opt/devbox-tools/bin/dvb-onbox"
        if any(os.environ.get(key) for key in ("BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH")):
            raise BatchError("interpreter startup/loader injection refused for managed authority")
        # Keep only native thread context and the existing HOME value. A list
        # of forbidden shell/Node/loader startup variables is never complete.
        context_keys = ("HOME", "BOXES_CLIENT_THREAD_ID", "BOXES_THREAD_STARTUP_ATTEMPT_ID",
                        "BOXES_CLAUDE_STARTUP_ATTEMPT_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID",
                        "BOXES_BACKEND_THREAD_ID", "BOXES_AGENT_BACKEND")
        environment = {key: os.environ[key] for key in context_keys if key in os.environ}
        environment["PATH"] = "/usr/bin:/bin"
        if shutil.which("dvb-onbox") != binary:
            raise BatchError("managed CLI PATH shadow refused")
        runtime = platform_runtime()
    if not binary:
        raise BatchError("managed CLI unavailable")
    try:
        result = subprocess.run((binary, *args), env=environment, capture_output=True, text=True, timeout=30)
        value = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        raise BatchError("managed authority unavailable") from error
    if result.returncode or not isinstance(value, dict) or value.get("ok") is not True:
        raise BatchError("managed authority request failed")
    value["_runtime"] = runtime
    return value


def managed_thread() -> dict | None:
    """Advisory context only; server-authored completed results prove authority."""
    try:
        value = managed_command("threads", "get-link", "--json")
    except (BatchError, OSError, ValueError):
        return None
    if (not isinstance(value.get("publicId"), str)
            or not re.fullmatch(r"thr_[0-9a-f]{32}", value.get("publicId", ""))
            or not isinstance(value.get("requestId"), str) or not value["requestId"]):
        return None
    return dict(publicId=value["publicId"], requestId=value["requestId"], runtime=value["_runtime"])


def freeze(repo: Path, state_path: Path, *, head: str, base_ref: str) -> dict:
    actual = _git(repo, "rev-parse", "HEAD").strip()
    if actual != head:
        raise BatchError(f"freeze HEAD mismatch: expected {head}, worktree is at {actual}")
    if _git(repo, "status", "--porcelain", "--untracked-files=normal").strip():
        raise BatchError("freeze requires the committed source-freeze snapshot (worktree is dirty)")
    base = merge_base(repo, base_ref)
    flagged = run_guards(repo)
    files = scoped_files(flagged)
    state = {
        "schema_version": 1,
        "head": head,
        "base_ref": base_ref,
        "merge_base": base,
        "frozen_at": _now(),
        "guards": flagged,
        "files": digests(repo, base, files),
        "decision": None if files else "clear",
        "owner": managed_thread(),
    }
    diff_path = state_path.with_suffix(".diff")
    state_path.parent.mkdir(parents=True, exist_ok=True)
    diff_path.write_text("".join(file_diff(repo, base, path) for path in files))
    _write(state_path, state)
    return {
        "status": "approval-required" if files else "clear",
        "head": head,
        "files": files,
        "guards": {name: entries for name, entries in flagged.items() if entries},
        "diff": str(diff_path) if files else None,
    }


def _write(path: Path, state: dict) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(path)


def _read(path: Path) -> dict:
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise BatchError("no frozen approval batch; run `freeze` at the source freeze") from error
    if not isinstance(state, dict) or state.get("schema_version") != 1:
        raise BatchError("invalid approval batch state")
    return state


def decide(state_path: Path, *, decision: str, evidence: str) -> dict:
    state = _read(state_path)
    if not state["files"]:
        raise BatchError("nothing in this batch needs a decision")
    if state.get("decision") not in (None,):
        raise BatchError(f"batch already decided: {state['decision']}; freeze a new batch to re-request")
    if state.get("code_only"):
        raise BatchError("batch already classified code-only; freeze a new batch to re-request")
    state["decision"] = decision
    state["decided_at"] = _now()
    state["evidence"] = evidence
    _write(state_path, state)
    return {"status": decision, "head": state["head"], "files": sorted(state["files"])}


def validate_code_only(state: dict, report: dict) -> None:
    if (not isinstance(report, dict)
            or set(report) != {"schema", "snapshot", "merge_base", "files", "approval_scoped_hunks", "rationale", "freeze_owner", "batch"}
            or report.get("schema") != "deploy-code-only-review-v1"
            or report.get("snapshot") != state["head"]
            or report.get("merge_base") != state["merge_base"]
            or report.get("files") != state["files"]
            or report.get("freeze_owner") != (state.get("owner") or {}).get("publicId")
            or report.get("batch") != {key: value for key, value in state.items() if key != "code_only"}
            or type(report.get("approval_scoped_hunks")) is not int
            or report["approval_scoped_hunks"] != 0
            or not isinstance(report.get("rationale"), dict)
            or set(report["rationale"]) != set(state["files"])
            or not all(isinstance(reason, str) and reason.strip() for reason in report["rationale"].values())):
        raise BatchError("code-only evidence must classify every exact frozen diff with zero approval-scoped hunks")


def batch_sha256(state: dict) -> str:
    frozen = {key: value for key, value in state.items() if key != "code_only"}
    return hashlib.sha256(json.dumps(frozen, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def completed_managed_result(thread_id: str, turn_id: str) -> dict:
    """Resolve actual server authorship and read the complete assistant result."""
    try:
        metadata = managed_command("threads", "read", "--scope", "project", "--thread",
                                   thread_id, "--turns", "1", "--json")
        thread = metadata["thread"]
        author = thread["publicId"]
        if (not re.fullmatch(r"thr_[0-9a-f]{32}", author)
                or not isinstance(thread["devboxId"], str) or not thread["devboxId"].strip()
                or thread_id not in (thread["id"], author)):
            raise BatchError("invalid managed result author identity")
        completed = managed_command("threads", "result", thread["id"], "--turn", turn_id, "--json")
        if metadata["_runtime"] != completed["_runtime"]:
            raise BatchError("managed runtime changed while verifying review authority")
        result = completed["data"]
        if (result["status"] != "completed" or result["turnId"] != turn_id
                or not isinstance(result["executionInstanceId"], str) or not result["executionInstanceId"].strip()
                or result["executionInstanceId"] != thread["devboxId"]
                or type(result["completedAt"]) is not int or result["completedAt"] <= 0
                or not isinstance(result["output"]["text"], str)):
            raise BatchError("invalid completed managed result")
        return dict(publicId=author, turnId=turn_id, completedAt=result["completedAt"],
                    text=result["output"]["text"], runtime=metadata["_runtime"], devboxId=thread["devboxId"])
    except (KeyError, TypeError, ValueError) as error:
        raise BatchError("invalid managed result authority") from error


def verify_review_authority(state: dict, review: dict) -> dict:
    """Two actual server-authored results, never caller get-link assertions."""
    try:
        owner = completed_managed_result(review["owner_thread"], review["owner_turn"])
        anchor = json.loads(owner["text"])
        expected = dict(schema="deploy-freeze-anchor-v1", owner_public_id=owner["publicId"],
                        head=state["head"], batch_sha256=batch_sha256(state))
        if (anchor != expected or owner["publicId"] != state["owner"]["publicId"]
                or owner["runtime"] != state["owner"].get("runtime")
                or owner["completedAt"] < int(datetime.fromisoformat(state["frozen_at"].replace("Z", "+00:00")).timestamp() * 1000)):
            raise BatchError("completed owner result does not anchor the exact frozen batch")
        reviewer = completed_managed_result(review["thread"], review["turn"])
        raw = review["evidence"]
        if (reviewer["publicId"] == owner["publicId"] or reviewer["completedAt"] < owner["completedAt"]
                or reviewer["runtime"] != owner["runtime"] or reviewer["text"] != raw
                or hashlib.sha256(raw.encode()).hexdigest() != review["evidence_sha256"]):
            raise BatchError("code-only authority does not match an independent completed review")
        validate_code_only(state, json.loads(raw))
        proof = {key: reviewer[key] for key in ("publicId", "turnId", "completedAt")}
        proof["owner"] = {key: owner[key] for key in ("publicId", "turnId", "completedAt", "devboxId")}
        proof["owner"]["text_sha256"] = hashlib.sha256(owner["text"].encode()).hexdigest()
        return proof
    except (KeyError, TypeError, ValueError) as error:
        raise BatchError("invalid managed code-only review authority") from error


def classify_code_only(repo: Path, state_path: Path, evidence: Path, review_thread: str, review_turn: str,
                       owner_thread: str, owner_turn: str) -> dict:
    state = _read(state_path)
    if not state["files"] or state.get("decision") is not None or state.get("code_only"):
        raise BatchError("code-only review requires a pending, unclassified batch")
    owner = state.get("owner")
    if (not isinstance(owner, dict) or not isinstance(owner.get("publicId"), str)
            or not re.fullmatch(r"thr_[0-9a-f]{32}", owner.get("publicId", ""))
            or not owner.get("requestId")):
        raise BatchError("code-only classification requires a verified managed reviewer independent of the freeze owner; legacy batches need a fresh freeze")
    if _git(repo, "rev-parse", "HEAD").strip() != state["head"]:
        raise BatchError("code-only review must run at the frozen snapshot")
    if digests(repo, state["merge_base"], sorted(state["files"])) != state["files"]:
        raise BatchError("code-only review requires every frozen diff to remain unchanged")
    code, payload = check(repo, state_path)
    if code != EXIT_PENDING:
        raise BatchError(f"batch cannot be classified: {payload['status']}")
    try:
        raw = evidence.read_text()
        report = json.loads(raw)
    except (OSError, ValueError) as error:
        raise BatchError("unreadable code-only review evidence") from error
    validate_code_only(state, report)
    review = dict(thread=review_thread, turn=review_turn, reviewed_at=_now(), evidence=raw,
                  evidence_sha256=hashlib.sha256(raw.encode()).hexdigest(),
                  owner_thread=owner_thread, owner_turn=owner_turn)
    reviewer = verify_review_authority(state, review)
    review["reviewer"] = reviewer
    state["code_only"] = review
    _write(state_path, state)
    return {"status": "code-only", "head": state["head"], "reviewer": reviewer["publicId"],
            "files": sorted(state["files"])}


def check(repo: Path, state_path: Path) -> tuple[int, dict]:
    state = _read(state_path)
    flagged = run_guards(repo)
    files = scoped_files(flagged)
    current = digests(repo, merge_base(repo, state["base_ref"]), files)
    frozen: dict[str, str] = state["files"]
    changed = sorted(path for path in files if frozen.get(path) != current[path])
    if review := state.get("code_only"):
        # Include formerly flagged files even if an edit removed their last hit.
        reviewed = digests(repo, state["merge_base"], sorted(frozen))
        changed = sorted(set(changed) | {path for path in frozen if reviewed[path] != frozen[path]})
    if changed:
        return EXIT_REREQUEST, {
            "status": "re-request",
            "reason": "approval-scoped hunks changed or appeared after the source freeze",
            "changed": changed,
            "frozen_head": state["head"],
        }
    if review:
        reviewer = verify_review_authority(state, review)
        if state.get("decision") is not None or review.get("reviewer") != reviewer:
            raise BatchError("invalid persisted code-only reviewer provenance")
        return EXIT_OK, {"status": "code-only", "frozen_head": state["head"],
                         "files": files, "guards_to_flag": [], "reviewer": review["reviewer"]["publicId"]}
    if not files:
        return EXIT_OK, {"status": "clear", "frozen_head": state["head"]}
    decision = state.get("decision")
    if decision == "rejected":
        return EXIT_REREQUEST, {"status": "rejected", "files": files}
    if decision in {"approved", "grounded"}:
        return EXIT_OK, {
            "status": "covered",
            "decision": decision,
            "files": files,
            "guards_to_flag": sorted(name for name, entries in flagged.items() if entries),
            "frozen_head": state["head"],
        }
    return EXIT_PENDING, {"status": "pending", "files": files, "frozen_head": state["head"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--state", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    frozen = commands.add_parser("freeze")
    frozen.add_argument("--head", required=True)
    frozen.add_argument("--base", default="origin/main")
    decision = commands.add_parser("decide")
    decision.add_argument("--decision", choices=sorted(DECISIONS), required=True)
    decision.add_argument("--evidence", required=True, help="who approved / reviewer verdict id")
    classification = commands.add_parser("classify-code-only", help="independent managed review of exact false-positive diffs")
    classification.add_argument("--evidence", type=Path, required=True,
                                help="deploy-code-only-review-v1 JSON with exact frozen hashes and per-file rationale")
    classification.add_argument("--review-thread", required=True, help="independent managed reviewer thread")
    classification.add_argument("--review-turn", required=True, help="completed managed reviewer turn")
    classification.add_argument("--owner-thread", required=True, help="server-authored freeze anchor thread")
    classification.add_argument("--owner-turn", required=True, help="completed server freeze anchor turn")
    commands.add_parser("check")
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    state_path = args.state or repo / ".context" / "deploy-approval-batch.json"
    try:
        if args.command == "freeze":
            payload, code = freeze(repo, state_path, head=args.head, base_ref=args.base), EXIT_OK
        elif args.command == "decide":
            payload, code = decide(state_path, decision=args.decision, evidence=args.evidence), EXIT_OK
        elif args.command == "classify-code-only":
            payload, code = classify_code_only(repo, state_path, args.evidence, args.review_thread, args.review_turn,
                                               args.owner_thread, args.owner_turn), EXIT_OK
        else:
            code, payload = check(repo, state_path)
    except (BatchError, subprocess.CalledProcessError) as error:
        print(f"deploy approval batch: {error}", file=sys.stderr)
        return EXIT_USAGE
    print(json.dumps(payload, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
