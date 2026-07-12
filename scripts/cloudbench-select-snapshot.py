#!/usr/bin/env python3
"""Select the newest completed Fly volume snapshot from JSON on stdin."""

from __future__ import annotations

import json
import sys


def select_snapshot(snapshots: list[dict]) -> str:
    completed = [
        snapshot
        for snapshot in snapshots
        if str(snapshot.get("status") or "").lower() in {"created", "complete", "completed", "ready"}
        and str(snapshot.get("created_at") or "") not in {"", "0001-01-01T00:00:00Z"}
        and int(snapshot.get("size") or 0) > 0
        and snapshot.get("id")
    ]
    completed.sort(key=lambda snapshot: str(snapshot.get("created_at") or ""), reverse=True)
    return str(completed[0]["id"]) if completed else ""


def main() -> int:
    try:
        snapshots = json.load(sys.stdin) or []
    except (json.JSONDecodeError, TypeError):
        snapshots = []
    print(select_snapshot(snapshots))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
