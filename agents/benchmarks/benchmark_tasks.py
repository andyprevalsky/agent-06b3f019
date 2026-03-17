"""Benchmark task definitions loaded from tasks.json."""

import json
import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class BenchmarkTask:
    name: str
    title: str
    prompt: str
    eval_prompt: str
    timeout_seconds: int
    is_chat_mode: bool
    expected_tools: List[str]
    tags: List[str]
    price_limit_cents: int
    requires_browser_agent: bool
    requires_claude_code: bool
    attachment: Optional[str]
    approval_handling: Optional[str]  # "auto_approve", "ignore", or None
    start_phase: Optional[str]  # "plan", "execute", or None (chat mode)


_TASKS_FILE = os.path.join(os.path.dirname(__file__), "tasks.json")


def _load_tasks() -> List[BenchmarkTask]:
    with open(_TASKS_FILE) as f:
        raw = json.load(f)
    return [BenchmarkTask(**t) for t in raw]


_cached_tasks: Optional[List[BenchmarkTask]] = None


def all_tasks() -> List[BenchmarkTask]:
    global _cached_tasks
    if _cached_tasks is None:
        _cached_tasks = _load_tasks()
    return _cached_tasks


def get_task_by_name(name: str) -> BenchmarkTask:
    for t in all_tasks():
        if t.name == name:
            return t
    raise ValueError(f"Unknown benchmark task: {name}")


def get_tasks_by_tag(tag: str) -> List[BenchmarkTask]:
    return [t for t in all_tasks() if tag in t.tags]


def list_all_tasks() -> None:
    for t in all_tasks():
        tags = ", ".join(t.tags)
        attach = f" [attachment: {t.attachment}]" if t.attachment else ""
        approval = f" [approval: {t.approval_handling}]" if t.approval_handling else ""
        print(f"  {t.name:<25} {t.title:<35} tags=[{tags}]{attach}{approval}")
