#!/usr/bin/env python3
"""Fail-closed access to the benchmark catalog used by cloud runners.

The runnable catalog is split across ``tasks.json`` (first-party tasks) and the
sibling ``polar_tasks.json`` shard.  Cloud launchers must resolve both shards
with the same uniqueness contract before making routing or policy decisions.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping


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
    "requires_browser_agent",
)

CATALOG_GROUPS = (
    "pre-deploy",
    "daily",
    "rose-bench",
    "polar-bench",
    "incomplete",
)


def normalize_task_group(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    token = re.sub(r"[\s_]+", "-", raw.strip().lower())
    return token if token in CATALOG_GROUPS else None


def resolve_task_group(task: dict[str, Any]) -> str:
    stored = normalize_task_group(task.get("group"))
    if stored is not None:
        return stored
    status = task.get("status")
    tags = task.get("tags")
    normalized_tags = tags if isinstance(tags, list) else []
    if status is not None and status != "ready":
        return "incomplete"
    if "smoke" in normalized_tags:
        return "pre-deploy"
    if "polar-bench" in normalized_tags:
        return "polar-bench"
    if task.get("bench") == "rose-bench":
        return "rose-bench"
    return "daily"


def resolve_task_selection(
    catalog_path: Path, selectors: Iterable[str]
) -> list[str]:
    """Resolve exact task names and canonical UI groups without duplicates."""
    tasks = load_unified_catalog(catalog_path)
    by_name = {task["name"]: task for task in tasks}
    resolved: list[str] = []
    seen: set[str] = set()
    for selector in selectors:
        if selector in by_name:
            candidates = [selector]
        else:
            group = normalize_task_group(selector)
            if group is None:
                raise CatalogError(f"unknown benchmark task or slice: {selector}")
            candidates = [
                task["name"] for task in tasks if resolve_task_group(task) == group
            ]
            if not candidates:
                raise CatalogError(f"benchmark slice is empty: {group}")
        for name in candidates:
            if name not in seen:
                seen.add(name)
                resolved.append(name)
    if not resolved:
        raise CatalogError("at least one benchmark task or slice is required")
    return resolved


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


def selected_tasks_need_shared_fast_cache(
    catalog_path: Path, task_names: Iterable[str]
) -> bool:
    """Return whether a selected task replays the shared frozen Fast Mode cache.

    Only ``fast_cache: on`` tasks read the shared (production pooler) cache;
    every other cloud guest keeps its cache in the isolated local database.
    """
    names = list(task_names)
    by_name = index_unified_catalog(catalog_path)
    missing = [name for name in names if name not in by_name]
    if missing:
        raise CatalogError(f"unknown benchmark task(s): {', '.join(missing)}")
    return any(by_name[name].get("fast_cache") == "on" for name in names)


_OFF_VALUES = {"0", "false", "no", "off"}
_GENERAL_PURPOSE_SPAWN_TOOLS = {
    "spawn_general_purpose_agent",
    "spawn_general_purpose_agent_for_each",
}


def task_worker_environment(
    tasks: Iterable[Mapping[str, Any]], environ: Mapping[str, str]
) -> dict[str, str | None]:
    """Return the per-task worker environment for one benchmark task selection.

    This is the single source of truth for local runs
    (``agents/benchmarks/local.py:configure_task_environment`` applies it to
    ``os.environ``) and cloud guests (``scripts/cloudbench-run.sh``
    ``resolve_task_gate`` exports the ``task-env`` command's output). ``tasks``
    are the selected catalog entries; ``environ`` supplies operator overrides.
    A ``None`` value means the variable must be unset.
    """
    selected = list(tasks)
    env: dict[str, str | None] = {}
    if any(
        isinstance(task.get("expected_gate"), dict)
        and task["expected_gate"].get("type") == "source_connect"
        for task in selected
    ):
        env["NON_PURCHASE_GATES_ENABLED"] = "1"
    # Force Claude Code (not Codex) for tasks that declare requires_claude_code
    # OR expect spawn_claude_code_agent. Codex sessions were failing this bench
    # with GitHub clone 403s / sandbox timeouts that trip no_tool_failures.
    if any(
        task.get("requires_claude_code")
        or "spawn_claude_code_agent" in (task.get("expected_tools") or [])
        or ((task.get("min_tool_counts") or {}).get("spawn_claude_code_agent") or 0) > 0
        for task in selected
    ):
        env["ROSE_CODE_AGENT_PROVIDER"] = "claude"
    # TEMPORARY: skip post-run Claude Code / Codex dual-agent verifier. The
    # verifier cannot see sandbox files and false-fails complete runs. Re-enable
    # by unsetting ROSE_DISABLE_CODE_AGENT_VERIFIER once we have an in-sandbox
    # agentic verifier. Override with ROSE_DISABLE_CODE_AGENT_VERIFIER=0.
    if environ.get("ROSE_DISABLE_CODE_AGENT_VERIFIER", "1").strip().lower() not in _OFF_VALUES:
        env["ROSE_DISABLE_CODE_AGENT_VERIFIER"] = "1"
    # TEMPORARY: strip api_request from explore tool injection + prompt context
    # so coding-agent GitHub ranking benches are not steered onto that route.
    # Override with ROSE_DISABLE_API_REQUEST=0.
    if {task.get("name") for task in selected} == {"google-oauth"}:
        env["ROSE_DISABLE_API_REQUEST"] = "0"
    elif environ.get("ROSE_DISABLE_API_REQUEST", "1").strip().lower() not in _OFF_VALUES:
        env["ROSE_DISABLE_API_REQUEST"] = "1"
    # When a selected task forbids general-purpose spawn aliases, also strip
    # general_purpose / for_each from spawn_agent schemas + planner enums so
    # the model cannot select them (mirrors ROSE_DISABLE_API_REQUEST). Override
    # with ROSE_DISABLE_GENERAL_PURPOSE_AGENT=0.

    def requires_general_purpose_agent(task: Mapping[str, Any]) -> bool:
        if _GENERAL_PURPOSE_SPAWN_TOOLS.intersection(task.get("expected_tools") or []):
            return True
        return any(
            _GENERAL_PURPOSE_SPAWN_TOOLS.intersection(task.get(field) or {})
            for field in ("expected_tool_counts", "min_tool_counts")
        )

    # Concurrent predeploy batches mix GPA-forbidden tasks (parallel-tool-calls)
    # with GPA-required tasks (spawn-sub-agents). A global env disable would strip
    # spawn_general_purpose_agent from the whole stack and false-fail the latter.
    if any(requires_general_purpose_agent(task) for task in selected):
        env["ROSE_DISABLE_GENERAL_PURPOSE_AGENT"] = "0"
    elif any(
        _GENERAL_PURPOSE_SPAWN_TOOLS.intersection(task.get("forbidden_tools") or [])
        for task in selected
    ) and (
        environ.get("ROSE_DISABLE_GENERAL_PURPOSE_AGENT", "1").strip().lower()
        not in _OFF_VALUES
    ):
        env["ROSE_DISABLE_GENERAL_PURPOSE_AGENT"] = "1"
    browser_max_steps = 0
    for task in selected:
        max_steps = task.get("max_steps")
        browser_limit = max_steps.get("browser") if isinstance(max_steps, dict) else None
        if isinstance(browser_limit, int) and browser_limit > browser_max_steps:
            browser_max_steps = browser_limit
    env["BROWSER_MAX_ITERATIONS"] = str(browser_max_steps) if browser_max_steps > 0 else None
    return env


def selected_task_worker_environment(
    catalog_path: Path, task_names: Iterable[str], environ: Mapping[str, str]
) -> dict[str, str | None]:
    """Resolve named tasks in the unified catalog, then their worker environment."""
    names = list(task_names)
    by_name = index_unified_catalog(catalog_path)
    missing = [name for name in names if name not in by_name]
    if missing:
        raise CatalogError(f"unknown benchmark task(s): {', '.join(missing)}")
    return task_worker_environment([by_name[name] for name in names], environ)


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
    shared_cache = subparsers.add_parser(
        "needs-shared-fast-cache",
        help="exit 0 when any requested task declares fast_cache: on",
    )
    shared_cache.add_argument("catalog", type=Path)
    shared_cache.add_argument("tasks", nargs="+")
    task_env = subparsers.add_parser(
        "task-env",
        help="print the requested tasks' worker environment as KEY=VALUE lines (empty value = unset)",
    )
    task_env.add_argument("catalog", type=Path)
    task_env.add_argument("tasks", nargs="+")
    resolve = subparsers.add_parser(
        "resolve", help="print exact task names for task and named-slice selectors"
    )
    resolve.add_argument("catalog", type=Path)
    resolve.add_argument("selectors", nargs="+")
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
        if args.command == "needs-shared-fast-cache":
            return 0 if selected_tasks_need_shared_fast_cache(
                args.catalog, args.tasks
            ) else 10
        if args.command == "task-env":
            env = selected_task_worker_environment(args.catalog, args.tasks, os.environ)
            for key, value in env.items():
                print(f"{key}={'' if value is None else value}")
            return 0
        if args.command == "resolve":
            for task in resolve_task_selection(args.catalog, args.selectors):
                print(task)
            return 0
    except CatalogError as exc:
        print(exc, file=sys.stderr)
        return 1
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
