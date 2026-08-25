"""Benchmark browser-spawn contract helpers.

Guest-checkout payment-boundary tasks waste wall-clock when the browser starts
on marketing/search detours instead of ``environment.live_targets``,
saved-session auth churn runs on tasks with no live fixture, or ``evaluate``
mutates menu labels to fake unavailable modifiers.

Spawn goals may still say "complete payment" — write-lock / payment-approval
catch the agent before an order is actually placed.
"""

from __future__ import annotations

import os
import re
from copy import deepcopy
from typing import Any, Mapping, Optional
from urllib.parse import urlparse

from benchmarks.benchmark_tasks import BenchmarkTask, get_task_by_name
from benchmarks.live_fixtures import resolve_live_fixtures

_BENCHMARK_ACTIVE_TASK_ENV = "BENCHMARK_ACTIVE_TASK_NAME"

_GUEST_CHECKOUT_MARKERS = (
    "guest checkout",
    "continue as guest",
    "checkout as guest",
)

_DOM_PATCH_EVALUATE_PATTERNS = (
    re.compile(r"\.(?:textContent|innerText|innerHTML)\s*=", re.IGNORECASE),
    re.compile(r"createElement\s*\(\s*['\"]option['\"]", re.IGNORECASE),
    re.compile(r"oat\s*\(\s*default\s*\)", re.IGNORECASE),
    re.compile(r"return\s+['\"]patched", re.IGNORECASE),
    re.compile(r"label(?:Text|s)?\s*[:=].*?(?:oat|almond|milk)", re.IGNORECASE),
)


def active_benchmark_task_name() -> Optional[str]:
    name = (os.environ.get(_BENCHMARK_ACTIVE_TASK_ENV) or "").strip()
    return name or None


def active_benchmark_task() -> Optional[BenchmarkTask]:
    name = active_benchmark_task_name()
    if not name:
        return None
    try:
        return get_task_by_name(name)
    except KeyError:
        return None


def primary_live_target(environment: Mapping[str, Any] | None) -> Optional[str]:
    if not environment:
        return None
    targets = environment.get("live_targets") or []
    if not isinstance(targets, list):
        return None
    for target in targets:
        if isinstance(target, str) and target.strip().startswith(("http://", "https://")):
            return target.strip()
    return None


def guest_checkout_without_live_fixture(task: BenchmarkTask) -> bool:
    environment = task.environment or {}
    if resolve_live_fixtures(environment):
        return False
    prompt_blob = " ".join(
        part
        for part in (
            task.prompt or "",
            str(environment.get("context_notes") or ""),
        )
        if part
    ).lower()
    return any(marker in prompt_blob for marker in _GUEST_CHECKOUT_MARKERS)


def apply_browser_spawn_live_target(
    task: BenchmarkTask,
    tool_call: Mapping[str, Any],
) -> dict[str, Any]:
    """Seed browser ``start_url`` from the task's declared live target when needed."""
    patched = dict(tool_call)
    live_target = primary_live_target(task.environment)
    if live_target:
        current_start = str(patched.get("start_url") or "").strip()
        if not current_start or _should_replace_start_url(current_start, live_target):
            patched["start_url"] = live_target

    return patched


def _should_replace_start_url(current_start: str, live_target: str) -> bool:
    current_host = urlparse(current_start).netloc.lower()
    target_host = urlparse(live_target).netloc.lower()
    if not current_host:
        return True
    if current_host == target_host:
        return False
    # Marketing/homepage detours before order.online are the dominant waste pattern.
    marketing_hosts = {
        "bluebottlecoffee.com",
        "www.bluebottlecoffee.com",
        "www.google.com",
        "google.com",
        "www.bing.com",
        "bing.com",
        "www.doordash.com",
        "doordash.com",
    }
    return current_host in marketing_hosts or current_host != target_host


def should_disable_saved_browser_auth(task: BenchmarkTask) -> bool:
    return guest_checkout_without_live_fixture(task)


def evaluate_dom_patch_blocked(code: str) -> Optional[str]:
    """Return a rejection reason when evaluate would fabricate menu state."""
    text = code if isinstance(code, str) else str(code or "")
    if not text.strip():
        return None
    for pattern in _DOM_PATCH_EVALUATE_PATTERNS:
        if pattern.search(text):
            return (
                "Blocked benchmark evaluate: DOM mutation cannot ground provider-side menu "
                "selections. Choose the closest available modifier or continue checkout."
            )
    return None


def apply_active_task_spawn_contract(tool_call: Mapping[str, Any]) -> dict[str, Any]:
    task = active_benchmark_task()
    if task is None:
        return dict(tool_call)
    return apply_browser_spawn_live_target(task, tool_call)


def with_active_benchmark_task(task_name: str):
    """Context manager for tests that need an active benchmark task env var."""
    from contextlib import contextmanager

    @contextmanager
    def _manager():
        previous = os.environ.get(_BENCHMARK_ACTIVE_TASK_ENV)
        os.environ[_BENCHMARK_ACTIVE_TASK_ENV] = task_name
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop(_BENCHMARK_ACTIVE_TASK_ENV, None)
            else:
                os.environ[_BENCHMARK_ACTIVE_TASK_ENV] = previous

    return _manager()


def copy_tool_call(tool_call: Mapping[str, Any]) -> dict[str, Any]:
    return deepcopy(dict(tool_call))
