#!/usr/bin/env python3
"""Track and enforce bounded /deploy code-review lifecycles."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


MAX_REVIEW_CYCLES = 3
KINDS = {"initial", "incremental", "verification"}
RESULTS = {"clean", "findings", "unavailable"}
SYNC_KIND = "sync-inherited"
# Files regenerated from the merged tree after a main sync. Their content is
# derived, so a sync may change them without new review.
GENERATED_PATHS = frozenset({"docs/rca/INDEX.md"})


class ReviewCycleError(RuntimeError):
    """Raised when the review lifecycle would become unsafe or unbounded."""


def default_state_path() -> Path:
    return Path.cwd() / ".context" / "deploy-review-cycle.json"


def read_state(path: Path) -> dict[str, object]:
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise ReviewCycleError("review cycle state is not initialized") from error
    except (json.JSONDecodeError, OSError) as error:
        raise ReviewCycleError(f"could not read review cycle state: {error}") from error
    if not isinstance(state, dict) or not isinstance(state.get("cycles"), list):
        raise ReviewCycleError("invalid review cycle state")
    return state


def write_state(path: Path, state: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(path)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def review_cycles(entries: list[object]) -> list[dict[str, object]]:
    """Real review cycles; audited sync inheritances never count toward the cap."""
    return [
        entry
        for entry in entries
        if isinstance(entry, dict) and entry.get("kind") != SYNC_KIND
    ]


def start_cycle(
    path: Path, *, head: str, kind: str, reset: bool = False
) -> dict[str, object]:
    if not head:
        raise ReviewCycleError("review HEAD must not be empty")
    if kind not in KINDS:
        raise ReviewCycleError(f"invalid review kind: {kind}")
    if reset:
        state: dict[str, object] = {"schema_version": 1, "cycles": []}
    else:
        state = read_state(path)
    entries = state["cycles"]
    assert isinstance(entries, list)
    cycles = review_cycles(entries)
    if (
        cycles
        and isinstance(cycles[-1], dict)
        and cycles[-1].get("status") == "open"
    ):
        raise ReviewCycleError("the previous review cycle is still open")
    if len(cycles) >= MAX_REVIEW_CYCLES:
        raise ReviewCycleError(
            f"review cycle cap reached ({MAX_REVIEW_CYCLES}); stop /deploy as review-unstable"
        )
    if any(entry.get("head") == head for entry in entries if isinstance(entry, dict)):
        raise ReviewCycleError("this exact HEAD already completed a review cycle")
    cycle_number = len(cycles) + 1
    expected_kind = {1: "initial", 2: "incremental", 3: "verification"}[
        cycle_number
    ]
    if kind != expected_kind:
        raise ReviewCycleError(
            f"review cycle {cycle_number} must be {expected_kind}, not {kind}"
        )
    if cycle_number == 3:
        previous = cycles[-1]
        assert isinstance(previous, dict)
        if previous.get("result") != "findings":
            raise ReviewCycleError(
                "verification review is allowed only after cycle two found a valid issue"
            )
    cycle = {
        "number": cycle_number,
        "kind": kind,
        "head": head,
        "status": "open",
        "started_at": now(),
    }
    entries.append(cycle)
    write_state(path, state)
    return cycle


def finish_cycle(path: Path, *, head: str, result: str) -> dict[str, object]:
    if result not in RESULTS:
        raise ReviewCycleError(f"invalid review result: {result}")
    state = read_state(path)
    cycles = state["cycles"]
    assert isinstance(cycles, list)
    if not cycles or not isinstance(cycles[-1], dict):
        raise ReviewCycleError("no review cycle is open")
    cycle = cycles[-1]
    if cycle.get("status") != "open":
        raise ReviewCycleError("no review cycle is open")
    if cycle.get("head") != head:
        raise ReviewCycleError(
            f"review HEAD mismatch: cycle has {cycle.get('head')}, got {head}"
        )
    cycle.update({"status": "completed", "result": result, "finished_at": now()})
    write_state(path, state)
    return cycle


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise ReviewCycleError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def resolve(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    return (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=repo,
            check=False,
        ).returncode
        == 0
    )


def branch_diff(repo: Path, head: str, base: str) -> str:
    """The branch-only change: merge-base(head, base)..head, generated files excluded."""
    fork = git(repo, "merge-base", head, base).strip()
    excludes = [f":(exclude){name}" for name in sorted(GENERATED_PATHS)]
    return git(repo, "diff", "--binary", "--full-index", fork, head, "--", ".", *excludes)


def changed_files(repo: Path, old: str, new: str) -> set[str]:
    return {line for line in git(repo, "diff", "--name-only", old, new).splitlines() if line}


def inherit_sync(
    path: Path, *, head: str, base: str, repo: Path
) -> dict[str, object]:
    """Carry a clean review onto a HEAD that only synced the base branch.

    Refuses unless the latest real review is clean, every commit after the
    reviewed HEAD is a merge of base-branch history, the branch-only diff is
    byte-identical to the reviewed one (generated files excluded), and every
    file the sync changed was changed on base or is generated.
    """
    state = read_state(path)
    entries = state["cycles"]
    assert isinstance(entries, list)
    cycles = review_cycles(entries)
    if not cycles or cycles[-1].get("status") != "completed":
        raise ReviewCycleError("sync inheritance needs a completed review cycle")
    reviewed = cycles[-1]
    if reviewed.get("result") != "clean":
        raise ReviewCycleError(
            f"latest review result is {reviewed.get('result')}; nothing clean to inherit"
        )
    latest = entries[-1]
    assert isinstance(latest, dict)
    source = str(latest.get("head"))
    head = resolve(repo, head)
    base_sha = resolve(repo, base)
    source = resolve(repo, source)
    if head == source:
        raise ReviewCycleError("HEAD is already the reviewed HEAD")
    if not is_ancestor(repo, source, head):
        raise ReviewCycleError("reviewed HEAD is not an ancestor of HEAD; review the new history")
    for commit in git(repo, "rev-list", "--first-parent", f"{source}..{head}").split():
        parents = git(repo, "rev-list", "--parents", "-n", "1", commit).split()[1:]
        if len(parents) < 2:
            raise ReviewCycleError(f"{commit[:12]} is not a sync merge; review the new commit")
        if not all(is_ancestor(repo, parent, base_sha) for parent in parents[1:]):
            raise ReviewCycleError(f"{commit[:12]} merges history that is not on {base}")
    reviewed_diff = branch_diff(repo, source, base_sha)
    synced_diff = branch_diff(repo, head, base_sha)
    if reviewed_diff != synced_diff:
        raise ReviewCycleError("branch diff differs from the reviewed diff; review the change")
    fork = git(repo, "merge-base", source, base_sha).strip()
    main_side = changed_files(repo, fork, base_sha)
    unexpected = sorted(changed_files(repo, source, head) - main_side - GENERATED_PATHS)
    if unexpected:
        raise ReviewCycleError(
            "sync changed files that neither base nor a generator changed: "
            + ", ".join(unexpected)
        )
    entry = {
        "number": len(entries) + 1,
        "kind": SYNC_KIND,
        "head": head,
        "status": "completed",
        "result": "clean",
        "inherited_from": source,
        "base": base_sha,
        "branch_diff_sha256": hashlib.sha256(synced_diff.encode()).hexdigest(),
        "generated_changed": sorted(changed_files(repo, source, head) & GENERATED_PATHS),
        "started_at": now(),
        "finished_at": now(),
    }
    entries.append(entry)
    write_state(path, state)
    return entry


def require_mergeable(path: Path, *, head: str) -> dict[str, object]:
    state = read_state(path)
    cycles = state["cycles"]
    assert isinstance(cycles, list)
    if not cycles or not isinstance(cycles[-1], dict):
        raise ReviewCycleError("HEAD has no completed review")
    cycle = cycles[-1]
    if cycle.get("status") != "completed":
        raise ReviewCycleError("the latest review cycle is still open")
    if cycle.get("head") != head:
        raise ReviewCycleError(
            f"current HEAD {head} is unreviewed; latest reviewed HEAD is {cycle.get('head')}"
        )
    if cycle.get("result") != "clean":
        raise ReviewCycleError(
            f"latest review result is {cycle.get('result')}; current HEAD is not mergeable"
        )
    return cycle


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=default_state_path())
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start")
    start.add_argument("--head", required=True)
    start.add_argument("--kind", choices=sorted(KINDS), required=True)
    start.add_argument("--reset", action="store_true")

    finish = subparsers.add_parser("finish")
    finish.add_argument("--head", required=True)
    finish.add_argument("--result", choices=sorted(RESULTS), required=True)

    inherit = subparsers.add_parser("inherit-sync")
    inherit.add_argument("--head", required=True)
    inherit.add_argument("--base", default="origin/main")
    inherit.add_argument("--repo", type=Path, default=Path.cwd())

    merge = subparsers.add_parser("require-mergeable")
    merge.add_argument("--head", required=True)

    subparsers.add_parser("status")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "start":
            payload = start_cycle(
                args.state, head=args.head, kind=args.kind, reset=args.reset
            )
        elif args.command == "finish":
            payload = finish_cycle(args.state, head=args.head, result=args.result)
        elif args.command == "inherit-sync":
            payload = inherit_sync(
                args.state, head=args.head, base=args.base, repo=args.repo
            )
        elif args.command == "require-mergeable":
            payload = require_mergeable(args.state, head=args.head)
        else:
            payload = read_state(args.state)
    except ReviewCycleError as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
