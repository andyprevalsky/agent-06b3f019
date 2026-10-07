#!/usr/bin/env python3
"""Size a /descend outcome-proof rerun from a task's recorded outcomes.

One passing rerun confirms a fix only for a task that otherwise never passes.
A task that already passes sometimes would often pass that rerun with no fix
at all, so its proof needs several passing runs.

For each task this prints one JSON line with the recorded attempts in its
recent window, how many of them passed, and the passing runs its outcome proof
requires.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

WINDOW = 10


def default_attempts() -> Path:
    return (
        Path(__file__).resolve().parent.parent
        / "agents/benchmarks/history/task_attempts.jsonl"
    )


def recent_outcomes(
    attempts: Path, tasks: Sequence[str], window: int = WINDOW
) -> dict[str, list[bool]]:
    """Return each task's last `window` recorded outcomes, oldest first.

    Every suite counts: a predeploy pass is still a pass without the fix. The
    ledger merges branches with union, so rows are ordered by timestamp and
    only then by file position.
    """
    found: dict[str, list[tuple[str, int, bool]]] = {task: [] for task in tasks}
    with attempts.open() as handle:
        for index, raw_line in enumerate(handle):
            line = raw_line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows = found.get(entry.get("task"))
            if rows is not None:
                rows.append(
                    (str(entry.get("timestamp") or ""), index, bool(entry.get("passed")))
                )
    return {
        task: [passed for _timestamp, _index, passed in sorted(rows)[-window:]]
        for task, rows in found.items()
    }


def required_runs(outcomes: Sequence[bool]) -> int:
    passes = sum(outcomes)
    if passes == 0:
        return 1
    if passes * 2 < len(outcomes):
        return 3
    return 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tasks", nargs="+", metavar="task")
    parser.add_argument("--attempts", type=Path, help="override the attempts ledger path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    attempts = args.attempts or default_attempts()
    try:
        outcomes = recent_outcomes(attempts, args.tasks)
    except OSError as error:
        print(f"cannot read attempts ledger {attempts}: {error}", file=sys.stderr)
        return 2
    for task in args.tasks:
        recent = outcomes[task]
        print(
            json.dumps(
                {
                    "task": task,
                    "attempts": len(recent),
                    "passes": sum(recent),
                    "runs": required_runs(recent),
                }
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
