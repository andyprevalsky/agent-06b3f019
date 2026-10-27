#!/usr/bin/env python3
"""Resolve the shared execution window for a selected benchmark batch."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "agents"))

from cloudbench_catalog import CatalogError, get_task_metadata
from benchmarks.benchmark_tasks import get_smoke_cap, get_timeout_floor
from benchmarks.timeout_history import InsufficientHistoryError, get_timeout


def effective_timeout(name: str, configured: int) -> int:
    """Match run_benchmark.resolve_task_execution_timeout without its runtime imports."""
    if configured == 0:
        # Polar tasks use a step budget and deliberately have no catalog wall clock.
        return 0
    cap = get_smoke_cap(name)
    floor = get_timeout_floor(name) or 0
    seconds = max(min(configured, cap) if cap is not None else configured, floor)
    try:
        seconds = max(seconds, get_timeout(name, max_seconds=cap), floor)
    except InsufficientHistoryError:
        pass
    return seconds


def select_timeouts(catalog: Path, names: list[str]) -> list[tuple[str, int]]:
    rows = get_task_metadata(catalog, names)
    result = []
    for row in rows:
        value = row.get("timeout_seconds")
        if type(value) is not int or value < 0 or value > 2**31 - 1:
            raise ValueError(f"{row['name']} has no valid timeout_seconds")
        result.append((row["name"], effective_timeout(row["name"], value)))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--requested", type=int)
    parser.add_argument("--mode", choices=("ordinary", "sharded"), default="ordinary")
    parser.add_argument("tasks", nargs="+")
    args = parser.parse_args()
    if args.requested is not None and args.requested <= 0:
        parser.error("--requested must be a positive number of seconds")
    try:
        rows = select_timeouts(args.catalog, args.tasks)
    except (CatalogError, ValueError) as exc:
        print(f"timeout preflight failed: {exc}", file=sys.stderr)
        return 2
    longest = max(seconds for _, seconds in rows)
    unbounded = [name for name, seconds in rows if seconds == 0]
    if unbounded:
        # Preserve the existing route defaults for step-budgeted Polar tasks.
        longest = max(longest, 1200 if args.mode == "sharded" else 7200)
        if args.requested is None and args.mode == "sharded":
            print(f"⚠️  {len(unbounded)} step-budgeted benchmark(s) have no catalog wall-clock "
                  f"timeout; the sharded operator's {longest}s window still applies", file=sys.stderr)
    if args.mode == "sharded":
        longest = max(longest, 60)  # operator's minimum valid execution window
    if args.requested is not None:
        short = [(name, seconds) for name, seconds in rows if seconds and args.requested < seconds]
        if short:
            details = ", ".join(f"{name} ({seconds}s)" for name, seconds in short)
            print(f"⚠️  --timeout {args.requested}s is below selected benchmark timeout(s): {details}; "
                  "the explicit cap can terminate these tasks early", file=sys.stderr)
        if unbounded:
            print(f"⚠️  --timeout {args.requested}s imposes a wall-clock cap on "
                  f"{len(unbounded)} step-budgeted benchmark(s) with no catalog wall-clock timeout",
                  file=sys.stderr)
    print(longest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
