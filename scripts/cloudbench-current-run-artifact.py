#!/usr/bin/env python3
"""Print the newest benchmark run artifact created after this run's marker."""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: cloudbench-current-run-artifact.py <runs-dir> <start-marker>", file=sys.stderr)
        return 2
    runs_dir = Path(sys.argv[1])
    marker = Path(sys.argv[2])
    if not marker.is_file():
        return 0
    threshold = marker.stat().st_mtime_ns
    candidates = [
        path
        for path in runs_dir.glob("*.json")
        if path.is_file() and path.stat().st_mtime_ns > threshold
    ]
    if candidates:
        print(max(candidates, key=lambda path: path.stat().st_mtime_ns))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
