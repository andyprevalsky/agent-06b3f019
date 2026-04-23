"""Benchmark task definitions loaded from tasks.json."""

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional


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
    approval_handling: Optional[str]  # "auto_approve", "ignore", "prompt_user", "count_only", or None
    start_phase: Optional[str]  # "plan", "execute", or None (chat mode)
    attachments: List[str] = field(default_factory=list)  # Multiple attachments (alternative to single attachment)
    row_start: Optional[int] = None  # Slice CSV attachments starting at this 1-indexed data row
    row_end: Optional[int] = None    # Slice CSV attachments ending at this 1-indexed data row (inclusive)
    expected_approval_count: Optional[int] = None  # Exact number of approvals expected (used with count_only)
    context_gates: Optional[Dict[str, bool]] = None  # Gate user context sections (None = all open)


_TASKS_FILE = os.path.join(os.path.dirname(__file__), "tasks.json")


# Smoke test timeout caps — keep these as low as practical.
# If smoke tests hit these limits, diagnose and fix the bottleneck first;
# only raise limits when the underlying latency is genuinely irreducible.
SMOKE_TIMEOUT_CAPS: dict[str, int] = {
    "chat-mode": 120,
    "spawn-sub-agents": 300,
    "parallel-tool-calls": 300,
    "claude-code-agent": 300,
    "browser-smoke": 300,
}


def get_smoke_cap(name: str) -> int | None:
    """Return the hard timeout cap for a smoke task, or None if not a smoke task."""
    return SMOKE_TIMEOUT_CAPS.get(name)


def _load_tasks() -> List[BenchmarkTask]:
    with open(_TASKS_FILE) as f:
        raw = json.load(f)
    tasks = [BenchmarkTask(**t) for t in raw]
    for t in tasks:
        if t.name in SMOKE_TIMEOUT_CAPS:
            cap = SMOKE_TIMEOUT_CAPS[t.name]
            if t.timeout_seconds > cap:
                raise ValueError(
                    f"Smoke test '{t.name}' timeout_seconds={t.timeout_seconds} exceeds "
                    f"immutable cap of {cap}s. Do NOT increase the timeout — speed up "
                    f"the underlying code instead."
                )
    return tasks


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
        all_attach = t.attachments or ([t.attachment] if t.attachment else [])
        attach = f" [attachments: {', '.join(all_attach)}]" if all_attach else ""
        approval = f" [approval: {t.approval_handling}]" if t.approval_handling else ""
        rows = f" [rows: {t.row_start}-{t.row_end}]" if t.row_start is not None else ""
        print(f"  {t.name:<25} {t.title:<35} tags=[{tags}]{attach}{approval}{rows}")
