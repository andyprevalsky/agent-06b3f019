#!/usr/bin/env python3
"""Validate an existing DEMO replay workload without changing task evaluation."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cloudbench_catalog import CatalogError, index_unified_catalog

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agents"))
from providers.demo_cache.normalize import demo_cache_allowed


def validate(catalog: Path, names: list[str]) -> None:
    tasks = index_unified_catalog(catalog)
    for name in names:
        task = tasks.get(name, {})
        tags = task.get("tags", [])
        evaluators = task.get("evaluators", [])
        supported = (
            isinstance(tags, list)
            and "DEMO" in tags
            and task.get("demo_cache", task.get("fast_cache")) == "on"
            and demo_cache_allowed(task.get("prompt"))
            and bool(evaluators)
            and task.get("enforce_declared_evaluators") is True
            and task.get("runner") == "agent"
            and not task.get("production_only")
            and not task.get("is_chat_mode")
            and not task.get("requires_browser_agent")
            and not task.get("requires_claude_code")
        )
        if not supported:
            raise CatalogError(
                f"--demo-cache requires an agent task with DEMO, demo_cache:on, and "
                f"admission by the existing DEMO replay policy: {name}"
            )
        if any(evaluator.get("method") != "static_check" for evaluator in evaluators):
            print(
                f"DEMO replay task {name}: declared LLM judges may make provider calls; evaluation is unchanged"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("tasks", nargs="+")
    args = parser.parse_args()
    try:
        validate(args.catalog, args.tasks)
    except (CatalogError, TypeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
