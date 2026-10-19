#!/usr/bin/env python3
"""Read an exact fleet's public metrics without printing private run content."""

import argparse
import json
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo("America/Los_Angeles")


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def observe(directory, controller_status=None):
    batch = directory / "_batch"
    card_path = batch / "report-card.json"
    card = read(card_path)
    card = card if isinstance(card, dict) else {}
    rows = card.get("per_task")
    invalid_rows = "per_task" in card and not isinstance(rows, list)
    if not isinstance(rows, list) or not rows:
        rows = read(batch / "benches.json")
    invalid_rows = invalid_rows or not isinstance(rows, list)
    rows = rows if isinstance(rows, list) else []
    occupancy = dict.fromkeys(
        [
            "preflight",
            "startup",
            "ready",
            "running",
            "evaluation/evidence",
            "teardown",
            "finished",
            "rejected",
        ],
        0,
    )
    outcomes = Counter()
    task_controller_warnings = []
    stages = {
        "queued": "preflight",
        "starting": "startup",
        "ready": "ready",
        "running": "running",
        "evaluated": "evaluation/evidence",
        "teardown": "teardown",
        "released": "finished",
    }
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            invalid_rows = True
            continue
        name = row["name"]
        if Path(name).name != name:
            invalid_rows = True
            continue
        task = directory / name
        try:
            child_exit = int((task / "benchmark-child.finished").read_text().strip())
        except (OSError, ValueError):
            child_exit = None
        # The child supervisor preserves ordinary benchmark exits 0/1. A
        # different exit needs diagnosis while healthy siblings keep running.
        if child_exit is not None and child_exit not in (0, 1):
            task_controller_warnings.append({"task": name, "exit_code": child_exit})
        status = row.get("status", "queued")
        status = status if isinstance(status, str) else "queued"
        outcomes[status] += 1
        raw_stage = row.get("lifecycle_stage")
        stage = (
            stages.get(raw_stage, "preflight")
            if isinstance(raw_stage, str)
            else "preflight"
        )
        if (task / "bench-e2e.finished-epoch").exists():
            stage = "finished"
        elif (task / "guest-shutdown.confirmed").exists() or (
            task / "benchmark-child.finished"
        ).exists():
            stage = "teardown"
        elif stage == "preflight" and (task / "bench-e2e.started-epoch").exists():
            stage = "startup"
        elif stage == "preflight" and status == "error":
            stage = "rejected"
        occupancy[stage] += 1
    lifecycle = read(batch / "lifecycle.json")
    lifecycle_terminal = (
        isinstance(lifecycle, dict)
        and lifecycle.get("run_id") == directory.name
        and lifecycle.get("status") in ("verified", "failed")
    )
    exit_code = None
    if controller_status is not None:
        try:
            exit_code = int(controller_status.read_text().strip())
        except (OSError, ValueError):
            pass
    age = (
        max(0, time.time() - card_path.stat().st_mtime) if card_path.exists() else None
    )
    return {
        "timestamp_pst": datetime.now(PACIFIC).strftime("%b %d, %I:%M:%S %p %Z"),
        "run_id": directory.name,
        "occupancy": occupancy,
        "task_outcomes": dict(outcomes),
        "task_controller_warnings": task_controller_warnings,
        "card_age_s": round(age, 1) if age is not None else None,
        "controller_terminal": exit_code is not None,
        "controller_exit_code": exit_code,
        "lifecycle_terminal": lifecycle_terminal,
        "cleanup_status": lifecycle.get("status") if lifecycle_terminal else "unknown",
        "observation_warning": "invalid task rows; inspect this exact owner"
        if invalid_rows
        else "task controller exit needs inspection; continue healthy siblings"
        if task_controller_warnings
        else "missing or stale progress; inspect this exact owner"
        if age is None or age > 60
        else None,
        "next_action": "inspect_terminal_and_owned_resources"
        if exit_code is not None or lifecycle_terminal
        else "inspect_task_warnings_and_continue"
        if task_controller_warnings and not invalid_rows
        else "observe_again",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument(
        "--controller-status",
        type=Path,
        help="Exact detached exit marker printed at launch",
    )
    args = parser.parse_args()
    print(json.dumps(observe(args.run_directory.resolve(), args.controller_status)))
