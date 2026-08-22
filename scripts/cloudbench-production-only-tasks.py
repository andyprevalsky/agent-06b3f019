#!/usr/bin/env python3
"""Return 0 when every positional task arg is production_only in the catalog.

Used by scripts/run-bench to short-circuit Fly fleet provisioning for tasks that
must hit live production (same contract as /deploy Step 13c).

Exit codes:
  0 — every named task exists and is production_only (names printed, one per line)
  1 — valid catalog, but the batch is not an all-production_only set (or empty)
  2 — catalog unavailable / invalid JSON (must fail closed, never look like 1)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Task names travel through bash word-splitting boundaries; keep the catalog
# contract restricted to shell-safe tokens (no whitespace / glob metacharacters).
_UNSAFE_TASK_NAME_CHARS = frozenset(" \t\n\r*?[]")


def _task_name_ok(name: str) -> bool:
    return bool(name) and not any(ch in _UNSAFE_TASK_NAME_CHARS for ch in name)


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parents[1]
    catalog_path = root / "agents" / "benchmarks" / "tasks.json"
    # Strip known run-bench flags so only task names remain.
    skip_next = False
    flag_with_value = {
        "--ref",
        "--dash-base",
        "--timeout",
        "--autoscale-max",
        "--sim-on",
        "--provision-pool",
        "--recover-stale-owner",
    }
    tasks: list[str] = []
    for arg in argv:
        if skip_next:
            skip_next = False
            continue
        if arg in flag_with_value:
            skip_next = True
            continue
        if arg.startswith("--"):
            continue
        tasks.append(arg)
    if not tasks:
        return 1
    if any(not _task_name_ok(name) for name in tasks):
        print(
            "❌ production-only helper: task names must not contain whitespace or glob metacharacters",
            file=sys.stderr,
        )
        return 2
    try:
        catalog = json.loads(catalog_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"❌ production-only helper: catalog unreadable ({exc})", file=sys.stderr)
        return 2
    if not isinstance(catalog, list):
        print("❌ production-only helper: catalog must be a JSON array", file=sys.stderr)
        return 2
    by_name = {
        row.get("name"): row
        for row in catalog
        if isinstance(row, dict) and isinstance(row.get("name"), str)
    }
    for name in by_name:
        if not _task_name_ok(name):
            print(
                f"❌ production-only helper: catalog task name is not shell-safe: {name!r}",
                file=sys.stderr,
            )
            return 2
    if any(name not in by_name for name in tasks):
        return 1
    if not all(by_name[name].get("production_only") is True for name in tasks):
        return 1
    for name in tasks:
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
