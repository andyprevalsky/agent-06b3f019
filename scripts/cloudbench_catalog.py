#!/usr/bin/env python3
"""Fail-closed access to the benchmark catalog used by cloud runners.

The runnable catalog is split across ``tasks.json`` (first-party tasks) and the
sibling ``polar_tasks.json`` shard.  Cloud launchers must resolve both shards
with the same uniqueness contract before making routing or policy decisions.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


class CatalogError(ValueError):
    """The unified benchmark catalog cannot be used safely."""


def _load_catalog_shard(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise CatalogError(f"could not read benchmark catalog shard {path}: {exc}") from exc
    if not isinstance(raw, list) or not raw:
        raise CatalogError(f"benchmark catalog shard {path} must be a non-empty JSON array")

    tasks: list[dict[str, Any]] = []
    for index, task in enumerate(raw):
        if not isinstance(task, dict):
            raise CatalogError(
                f"benchmark catalog shard {path} entry {index} must be an object"
            )
        name = task.get("name")
        if not isinstance(name, str) or not name:
            raise CatalogError(
                f"benchmark catalog shard {path} entry {index} has no non-empty string name"
            )
        tasks.append(task)
    return tasks


def load_unified_catalog(catalog_path: Path) -> list[dict[str, Any]]:
    """Load the first-party catalog and its Polar shard as one validated list."""
    catalog_path = Path(catalog_path)
    shard_paths = (catalog_path, catalog_path.with_name("polar_tasks.json"))
    tasks = [task for path in shard_paths for task in _load_catalog_shard(path)]

    duplicates = sorted(
        name for name, count in Counter(task["name"] for task in tasks).items() if count > 1
    )
    if duplicates:
        raise CatalogError(f"duplicate benchmark task name(s): {', '.join(duplicates)}")
    return tasks


def index_unified_catalog(catalog_path: Path) -> dict[str, dict[str, Any]]:
    """Return the validated unified catalog indexed by its unique task names."""
    return {task["name"]: task for task in load_unified_catalog(catalog_path)}


_METADATA_FIELDS = (
    "production_only",
    "world_model_mode",
    "timeout_seconds",
    "max_steps",
    "group",
    "tags",
)


def get_task_metadata(
    catalog_path: Path, task_names: Iterable[str]
) -> list[dict[str, Any]]:
    """Return routing/budget metadata for named tasks, preserving input order."""
    names = list(task_names)
    by_name = index_unified_catalog(catalog_path)
    missing = [name for name in names if name not in by_name]
    if missing:
        raise CatalogError(f"unknown benchmark task(s): {', '.join(missing)}")

    rows: list[dict[str, Any]] = []
    for name in names:
        task = by_name[name]
        metadata = {"name": name, **{field: task.get(field) for field in _METADATA_FIELDS}}
        max_steps = metadata["max_steps"]
        metadata["browser_step_budget"] = (
            max_steps.get("browser") if isinstance(max_steps, dict) else None
        )
        rows.append(metadata)
    return rows


def selected_tasks_require_gate_type(
    catalog_path: Path, task_names: Iterable[str], gate_type: str
) -> bool:
    """Return whether a selected task declares one exact expected gate type."""
    names = list(task_names)
    by_name = index_unified_catalog(catalog_path)
    missing = [name for name in names if name not in by_name]
    if missing:
        raise CatalogError(f"unknown benchmark task(s): {', '.join(missing)}")
    return any(
        isinstance(by_name[name].get("expected_gate"), dict)
        and by_name[name]["expected_gate"].get("type") == gate_type
        for name in names
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    metadata = subparsers.add_parser(
        "metadata", help="print one JSON metadata object per requested task"
    )
    metadata.add_argument("catalog", type=Path)
    metadata.add_argument("tasks", nargs="+")
    requires_gate = subparsers.add_parser(
        "requires-gate", help="exit 0 when any requested task declares a gate type"
    )
    requires_gate.add_argument("catalog", type=Path)
    requires_gate.add_argument("gate_type")
    requires_gate.add_argument("tasks", nargs="+")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "metadata":
            for row in get_task_metadata(args.catalog, args.tasks):
                print(json.dumps(row, sort_keys=True, separators=(",", ":")))
            return 0
        if args.command == "requires-gate":
            return 0 if selected_tasks_require_gate_type(
                args.catalog, args.tasks, args.gate_type
            ) else 10
    except CatalogError as exc:
        print(exc, file=sys.stderr)
        return 1
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
