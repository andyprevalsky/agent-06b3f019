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

Exit codes: 0 clear/covered, 1 re-request or rejected, 3 decision pending,
2 usage/state error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
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


class BatchError(RuntimeError):
    pass


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ("git", *args), cwd=repo, check=True, capture_output=True, text=True
    ).stdout


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def guard_commands() -> dict[str, tuple[str, ...]]:
    """The real guards, or a JSON override (tests) from DEPLOY_APPROVAL_GUARDS."""
    override = os.environ.get("DEPLOY_APPROVAL_GUARDS")
    if override:
        return {name: tuple(command) for name, command in json.loads(override).items()}
    return dict(GUARDS)


def run_guards(repo: Path) -> dict[str, list[str]]:
    """Run each guard without the approval flag; return its flagged entries."""
    flagged: dict[str, list[str]] = {}
    for name, command in guard_commands().items():
        result = subprocess.run(command, cwd=repo, capture_output=True, text=True)
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
    state["decision"] = decision
    state["decided_at"] = _now()
    state["evidence"] = evidence
    _write(state_path, state)
    return {"status": decision, "head": state["head"], "files": sorted(state["files"])}


def check(repo: Path, state_path: Path) -> tuple[int, dict]:
    state = _read(state_path)
    flagged = run_guards(repo)
    files = scoped_files(flagged)
    current = digests(repo, merge_base(repo, state["base_ref"]), files)
    frozen: dict[str, str] = state["files"]
    changed = sorted(path for path in files if frozen.get(path) != current[path])
    if changed:
        return EXIT_REREQUEST, {
            "status": "re-request",
            "reason": "approval-scoped hunks changed or appeared after the source freeze",
            "changed": changed,
            "frozen_head": state["head"],
        }
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
    commands.add_parser("check")
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    state_path = args.state or repo / ".context" / "deploy-approval-batch.json"
    try:
        if args.command == "freeze":
            payload, code = freeze(repo, state_path, head=args.head, base_ref=args.base), EXIT_OK
        elif args.command == "decide":
            payload, code = decide(state_path, decision=args.decision, evidence=args.evidence), EXIT_OK
        else:
            code, payload = check(repo, state_path)
    except (BatchError, subprocess.CalledProcessError) as error:
        print(f"deploy approval batch: {error}", file=sys.stderr)
        return EXIT_USAGE
    print(json.dumps(payload, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
