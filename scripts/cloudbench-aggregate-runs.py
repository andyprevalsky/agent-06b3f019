#!/usr/bin/env python3
"""Aggregate one isolated cloudbench run artifact per task into one batch run."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def aggregate(fleet_dir: Path) -> dict:
    benches = json.loads((fleet_dir / "_batch/benches.json").read_text())
    tasks: list[dict] = []
    for bench in benches:
        name = str(bench["name"])
        path = fleet_dir / name / "cloudbench-run.json"
        if not path.is_file():
            tasks.append(
                {
                    "name": name,
                    "passed": False,
                    "status": "INFRA_ERROR",
                    "failure_reason": "no current run artifact produced",
                }
            )
            continue
        run = json.loads(path.read_text())
        candidates = run.get("tasks") or []
        task = next((candidate for candidate in candidates if candidate.get("name") == name), None)
        if task is None:
            tasks.append(
                {
                    "name": name,
                    "passed": False,
                    "status": "INFRA_ERROR",
                    "failure_reason": "run artifact did not contain the requested task",
                }
            )
        else:
            tasks.append(task)
    passed = sum(bool(task.get("passed")) for task in tasks)
    costs = sum(float(task.get("cost_cents") or 0) for task in tasks)
    durations = [float(task.get("duration_seconds") or 0) for task in tasks]
    cache_read = sum(int(task.get("cache_read_input_tokens") or 0) for task in tasks)
    cache_create = sum(int(task.get("cache_creation_input_tokens") or 0) for task in tasks)
    cache_total = cache_read + cache_create
    return {
        "run_id": fleet_dir.name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "suite": "cloud-fleet",
        "source": "cloud-fleet",
        "base_url": "cloud-fleet",
        "summary": {
            "total": len(tasks),
            "passed": passed,
            "failed": len(tasks) - passed,
            "total_cost_cents": round(costs, 4),
            "total_duration_seconds": round(max(durations, default=0), 1),
            "pass_rate": passed / max(1, len(tasks)),
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_create,
            "cache_hit_pct": round(100 * cache_read / cache_total, 1) if cache_total else None,
        },
        "memory_summary": None,
        "tasks": tasks,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: cloudbench-aggregate-runs.py <fleet-dir> <output>", file=sys.stderr)
        return 2
    fleet_dir = Path(sys.argv[1])
    output = Path(sys.argv[2])
    output.write_text(json.dumps(aggregate(fleet_dir), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
