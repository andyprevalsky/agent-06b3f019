#!/usr/bin/env python3
"""Per-step bring-up timing report for a fleet run.

Parses each bench's fleet-child.log for the driver's `[cloudbench HH:MM:SS]
STEP <name>` boundary stamps and prints per-step durations per box plus a
p50/max summary — so every bring-up second is attributed to a named step and
the slowest step of the slowest box is obvious.

Usage: python3 scripts/cloudbench-bring-up-report.py <fleet-run-dir>
"""

from __future__ import annotations

import re
import statistics
import sys
from datetime import datetime, timedelta
from pathlib import Path

STEP_RE = re.compile(r"\[cloudbench (\d\d:\d\d:\d\d)\] STEP (\S+)")

# Canonical bring-up order; also the report's column order.
STEP_ORDER = [
    "git_sync",
    "env_decode",
    "dep_sync",
    "postgres",
    "stack_launch",
    "services_wait",
    "benchmark",
]


def parse_child_log(path: Path) -> dict[str, float]:
    """Return {step: seconds-until-next-step} for one box (last stamp wins)."""
    stamps: list[tuple[str, datetime]] = []
    for line in path.read_text(errors="replace").splitlines():
        m = STEP_RE.search(line)
        if not m:
            continue
        t = datetime.strptime(m.group(1), "%H:%M:%S")
        if stamps and t < stamps[-1][1]:  # midnight rollover
            t += timedelta(days=1)
        stamps.append((m.group(2), t))
    durations: dict[str, float] = {}
    for (name, t0), (_, t1) in zip(stamps, stamps[1:]):
        durations[name] = (t1 - t0).total_seconds()
    return durations


def report(run_dir: Path) -> str:
    boxes: dict[str, dict[str, float]] = {}
    for child in sorted(run_dir.glob("*/fleet-child.log")):
        durations = parse_child_log(child)
        if durations:
            boxes[child.parent.name] = durations
    if not boxes:
        return f"no STEP stamps found under {run_dir} (driver too old, or run predates step markers)"

    steps = [s for s in STEP_ORDER if any(s in d for d in boxes.values())]
    lines = []
    header = f"{'bench':38} " + " ".join(f"{s[:12]:>12}" for s in steps) + f" {'total':>8}"
    lines.append(header)
    lines.append("─" * len(header))
    for bench, durations in sorted(boxes.items(), key=lambda kv: -sum(kv[1].values())):
        row = f"{bench[:38]:38} "
        row += " ".join(f"{durations.get(s, float('nan')):>11.0f}s" if s in durations else f"{'—':>12}" for s in steps)
        row += f" {sum(durations.values()):>7.0f}s"
        lines.append(row)
    lines.append("─" * len(header))
    p50_row = f"{'p50':38} "
    max_row = f"{'max':38} "
    for s in steps:
        vals = [d[s] for d in boxes.values() if s in d]
        p50_row += f"{statistics.median(vals):>11.0f}s "
        max_row += f"{max(vals):>11.0f}s "
    lines.append(p50_row.rstrip())
    lines.append(max_row.rstrip())
    slowest = max(
        ((bench, s, d[s]) for bench, d in boxes.items() for s in d),
        key=lambda x: x[2],
    )
    lines.append(f"\nslowest step: {slowest[1]} on {slowest[0]} ({slowest[2]:.0f}s)")
    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    print(report(Path(sys.argv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
