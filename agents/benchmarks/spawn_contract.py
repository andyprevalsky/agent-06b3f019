"""Benchmark browser-spawn contract helpers.

Guest-checkout payment-boundary tasks waste wall-clock when the browser starts
on marketing/search detours instead of ``environment.live_targets``,
saved-session auth churn runs on tasks with no live fixture, or ``evaluate``
mutates menu labels to fake unavailable modifiers.

Spawn goals may still say "complete payment" — write-lock / payment-approval
catch the agent before an order is actually placed.

Workflow-safe helpers live in ``helpers.browser_spawn_contract`` so Temporal's
replay-surface hash never includes ``agents/benchmarks/``.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Mapping, Optional

from helpers.browser_spawn_contract import (
    BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV,
    BENCHMARK_ACTIVE_TASK_ENV,
    BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV,
    active_benchmark_live_target,
    active_benchmark_task_name,
    apply_active_task_spawn_contract,
    apply_live_target_to_tool_call,
    copy_tool_call,
    evaluate_dom_patch_blocked,
    primary_live_target,
)

if TYPE_CHECKING:
    from benchmarks.benchmark_tasks import BenchmarkTask

_GUEST_CHECKOUT_MARKERS = (
    "guest checkout",
    "continue as guest",
    "checkout as guest",
)

# Re-export workflow-safe helpers for harness / test callers.
__all__ = [
    "active_benchmark_live_target",
    "active_benchmark_task",
    "active_benchmark_task_name",
    "apply_active_task_spawn_contract",
    "apply_browser_spawn_live_target",
    "copy_tool_call",
    "evaluate_dom_patch_blocked",
    "guest_checkout_without_live_fixture",
    "primary_live_target",
    "should_disable_saved_browser_auth",
    "tasks_require_disabled_saved_browser_auth",
    "with_active_benchmark_task",
]


def active_benchmark_task() -> Optional["BenchmarkTask"]:
    """Load the active benchmark task. Activity-only — do not call from workflows."""
    name = active_benchmark_task_name()
    if not name:
        return None
    from benchmarks.benchmark_tasks import get_task_by_name

    try:
        return get_task_by_name(name)
    except KeyError:
        return None


def guest_checkout_without_live_fixture(task: "BenchmarkTask") -> bool:
    from benchmarks.live_fixtures import resolve_live_fixtures

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
    task: "BenchmarkTask",
    tool_call: Mapping[str, Any],
) -> dict[str, Any]:
    """Seed browser ``start_url`` from the task's declared live target when needed."""
    return apply_live_target_to_tool_call(primary_live_target(task.environment), tool_call)


def should_disable_saved_browser_auth(task: "BenchmarkTask") -> bool:
    return guest_checkout_without_live_fixture(task)


def tasks_require_disabled_saved_browser_auth(
    task_names: list[str] | tuple[str, ...] | set[str],
) -> bool:
    """True when any selected task needs the stack-level saved-auth kill-switch.

    ``run_benchmark`` sets ``BENCHMARK_DISABLE_SAVED_BROWSER_AUTH`` in the harness
    process only; cookie injection runs in the backend/worker. Callers that start
    those services (``local.py``, cloudbench) must export the same flag into the
    stack env before browser sessions are created — otherwise guest-checkout
    benches still get ``auth_source=cookie_bundle`` / ``cookies_injected=true``.
    """
    from benchmarks.benchmark_tasks import get_task_by_name

    for name in task_names:
        if not isinstance(name, str) or not name.strip():
            continue
        try:
            task = get_task_by_name(name.strip())
        except Exception:
            continue
        if should_disable_saved_browser_auth(task):
            return True
    return False


def _set_active_task_env(task_name: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    previous_name = os.environ.get(BENCHMARK_ACTIVE_TASK_ENV)
    previous_live_target = os.environ.get(BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV)
    previous_block_dom = os.environ.get(BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV)
    from benchmarks.benchmark_tasks import get_task_by_name

    os.environ[BENCHMARK_ACTIVE_TASK_ENV] = task_name
    task = get_task_by_name(task_name)
    live_target = primary_live_target(task.environment)
    if live_target:
        os.environ[BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV] = live_target
    else:
        os.environ.pop(BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV, None)
    if getattr(task, "success_on_payment_card_request", False):
        os.environ[BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV] = "1"
    else:
        os.environ.pop(BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV, None)
    return previous_name, previous_live_target, previous_block_dom


def _restore_active_task_env(
    previous_name: Optional[str],
    previous_live_target: Optional[str],
    previous_block_dom: Optional[str],
) -> None:
    if previous_name is None:
        os.environ.pop(BENCHMARK_ACTIVE_TASK_ENV, None)
    else:
        os.environ[BENCHMARK_ACTIVE_TASK_ENV] = previous_name
    if previous_live_target is None:
        os.environ.pop(BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV, None)
    else:
        os.environ[BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV] = previous_live_target
    if previous_block_dom is None:
        os.environ.pop(BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV, None)
    else:
        os.environ[BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV] = previous_block_dom


def with_active_benchmark_task(task_name: str):
    """Context manager for tests that need active benchmark task env vars."""
    from contextlib import contextmanager

    @contextmanager
    def _manager():
        previous = _set_active_task_env(task_name)
        try:
            yield
        finally:
            _restore_active_task_env(*previous)

    return _manager()
