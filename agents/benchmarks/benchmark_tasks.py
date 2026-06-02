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
    expected_attention_kind: Optional[str] = None  # metadata.attentionKind expected for approval-style tasks
    min_agent_count: Optional[int] = None  # Minimum total agents in tree (root + sub-agents)
    expected_tool_counts: Optional[dict] = None  # Exact tool call counts across entire agent tree (toolName → count)
    min_tool_counts: Optional[dict] = None  # Minimum tool call counts across entire agent tree (toolName → min count)
    forbidden_tools: List[str] = field(default_factory=list)  # Tool names that must not be called
    sub_agent_count: Optional[int] = None  # Default fan-out for load-test style tasks; substitutes {n} in prompt


_TASKS_FILE = os.path.join(os.path.dirname(__file__), "tasks.json")


# Smoke test timeout caps — keep these as low as practical.
# If smoke tests hit these limits, diagnose and fix the bottleneck first;
# only raise limits when the underlying latency is genuinely irreducible.
SMOKE_TIMEOUT_CAPS: dict[str, int] = {
    "chat-mode": 120,
    # spawn-sub-agents + parallel-tool-calls: real-workload tasks that fan out
    # 2–3 sub-agents each (web research). Recent p95×1.5 lands ~320s; bumping
    # the ceiling to 400s absorbs the upper tail of LLM streaming variance
    # without disabling the dynamic cap as a regression detector.
    "spawn-sub-agents": 480,
    "parallel-tool-calls": 400,
    "claude-code-agent": 300,
    "browser-smoke": 300,
}


TASK_TIMEOUT_FLOORS: dict[str, int] = {
    # This batch intentionally does upfront outreach research before spawning
    # 40 row agents. Historical local passes are from older, narrower task
    # shapes, so do not let the dynamic cap collapse below this floor.
    "outreach-batch": 600,
}


def get_smoke_cap(name: str) -> int | None:
    """Return the hard timeout cap for a smoke task, or None if not a smoke task."""
    return SMOKE_TIMEOUT_CAPS.get(name)


def get_timeout_floor(name: str) -> int | None:
    """Return the minimum dynamic timeout for a task, if it needs one."""
    return TASK_TIMEOUT_FLOORS.get(name)


def _load_tasks() -> List[BenchmarkTask]:
    with open(_TASKS_FILE) as f:
        raw = json.load(f)
    tasks = [BenchmarkTask(**t) for t in raw]
    for t in tasks:
        if t.sub_agent_count is not None:
            apply_sub_agent_count(t, t.sub_agent_count)
        if t.name in SMOKE_TIMEOUT_CAPS:
            cap = SMOKE_TIMEOUT_CAPS[t.name]
            if t.timeout_seconds > cap:
                raise ValueError(
                    f"Smoke test '{t.name}' timeout_seconds={t.timeout_seconds} exceeds "
                    f"immutable cap of {cap}s. Do NOT increase the timeout — speed up "
                    f"the underlying code instead."
                )
    return tasks


def apply_sub_agent_count(task: BenchmarkTask, n: int) -> None:
    """Substitute count placeholders in prompt with the chosen count.

    Caches the original templates on the task so repeat calls (e.g. CLI override
    after JSON load already substituted) work correctly.
    """
    prompt_tpl = getattr(task, "_prompt_template", None) or task.prompt
    expected_sum = sum((i * i) + (i * 3) + 7 for i in range(1, n + 1))
    task._prompt_template = prompt_tpl
    task.sub_agent_count = n
    task.prompt = prompt_tpl.replace("{n}", str(n)).replace("{expected_sum}", str(expected_sum))


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
