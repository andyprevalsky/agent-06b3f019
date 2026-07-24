#!/usr/bin/env python3
"""Track and enforce bounded /deploy code-review lifecycles."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path


MAX_REVIEW_CYCLES = 3
KINDS = {"initial", "incremental", "verification"}
RESULTS = {"clean", "findings", "unavailable"}


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
    cycles = state["cycles"]
    assert isinstance(cycles, list)
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
    if cycles and isinstance(cycles[-1], dict) and cycles[-1].get("head") == head:
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
    cycles.append(cycle)
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
