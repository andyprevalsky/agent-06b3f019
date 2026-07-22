#!/usr/bin/env python3
"""Resolve a cloud benchmark invocation's backend target from the catalog."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: cloudbench-benchmark-target.py CATALOG LOCAL_PORT TASK [TASK ...]",
            file=sys.stderr,
        )
        return 2

    catalog_path = Path(sys.argv[1])
    local_port = sys.argv[2]
    task_names = sys.argv[3:]
    try:
        catalog = json.loads(catalog_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f"could not read benchmark catalog {catalog_path}: {exc}", file=sys.stderr
        )
        return 1

    tasks_by_name = {
        task.get("name"): task
        for task in catalog
        if isinstance(task, dict) and isinstance(task.get("name"), str)
    }
    missing = [name for name in task_names if name not in tasks_by_name]
    if missing:
        print(f"unknown benchmark task(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    production_names = [
        name
        for name in task_names
        if tasks_by_name[name].get("production_only") is True
    ]
    if production_names and len(production_names) != len(task_names):
        local_names = [name for name in task_names if name not in production_names]
        print(
            "cannot mix production-only and isolated-backend tasks in one cloud "
            f"invocation (production: {', '.join(production_names)}; "
            f"isolated: {', '.join(local_names)})",
            file=sys.stderr,
        )
        return 1

    if production_names:
        print("prod")
        print("--prod")
    else:
        print("local")
        print("--port")
        print(local_port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
