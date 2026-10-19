"""Shared simulated wait activity boundary for wait tools."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

from helpers.world_model_runtime import world_clock_activity
from utils.simulated_clock import set_world_time_cursor, world_time_cursor_ms


async def _wait_on_world_clock(
    workflow_instance: Any, wait_id: str, *, until_ms: int | None = None, duration_ms: int | None = None
) -> int | None:
    """Simulate mode: wait on the world's shared clock; None when it is unavailable.

    The clock resumes this agent once every other agent in the world has passed
    the deadline (or waits beyond it), so a waiting agent never overtakes one
    that is still working. Afterwards this agent's cursor is the acknowledged
    world time, or its later local time: the cursor never moves backwards (a
    failed earlier wait may have advanced it on the agent's own clock).
    """
    wait: dict[str, Any] = {"wait_id": wait_id}
    if until_ms is not None:
        wait["until_ms"] = until_ms
    else:
        wait["duration_ms"] = duration_ms
    try:
        result = await workflow.execute_activity(
            world_clock_activity,
            args=["wait", workflow_instance.agent_id, None, wait],
            start_to_close_timeout=timedelta(hours=6),
            heartbeat_timeout=timedelta(minutes=3),
            retry_policy=RetryPolicy(maximum_attempts=5),
        )
    except Exception as exc:
        workflow.logger.error(f"[wait_for] World clock wait failed; using this agent's clock: {exc}")
        return None
    if not isinstance(result, dict) or type(result.get("time_ms")) is not int:
        return None
    latest = max(world_time_cursor_ms(workflow_instance) or result["time_ms"], result["time_ms"])
    set_world_time_cursor(workflow_instance, latest, now=workflow.now())
    return latest


async def _read_world_time_ms(workflow_instance: Any) -> int | None:
    """Simulate mode: this agent's time on its world clock, or None when it cannot be read."""
    try:
        result = await workflow.execute_activity(
            world_clock_activity,
            args=["time", workflow_instance.agent_id],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
    except Exception as exc:
        workflow.logger.error(f"[world_clock] Cursor read failed; keeping the last world time: {exc}")
        return None
    if not isinstance(result, dict) or type(result.get("time_ms")) is not int:
        return None
    return result["time_ms"]


async def _refresh_world_time_cursor(workflow_instance: Any) -> int | None:
    """Simulate mode: re-read this agent's time on the world clock into its cursor.

    Simulated actions advance the agent on the world clock by their predicted
    duration, and a parent's time moves to a child's finish, so the cursor is
    re-read after a tool rather than inferred. The agent's world time never
    decreases; an out-of-order read keeps the later value. None (no cursor
    change) when no cursor exists or the clock cannot be read.
    """
    cursor = world_time_cursor_ms(workflow_instance)
    if cursor is None or not getattr(workflow_instance, "agent_id", None):
        return None
    time_ms = await _read_world_time_ms(workflow_instance)
    if time_ms is None:
        return None
    latest = max(world_time_cursor_ms(workflow_instance) or cursor, time_ms)
    set_world_time_cursor(workflow_instance, latest, now=workflow.now())
    return latest


async def _world_clock_children_call(workflow_instance: Any, operation: str, payload: dict) -> int | None:
    if world_time_cursor_ms(workflow_instance) is None or not getattr(workflow_instance, "agent_id", None):
        return None
    try:
        result = await workflow.execute_activity(
            world_clock_activity,
            args=[operation, workflow_instance.agent_id, None, payload],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
    except Exception as exc:
        workflow.logger.error(f"[world_clock] {operation} on children failed: {exc}")
        return None
    if not isinstance(result, dict) or type(result.get("time_ms")) is not int:
        return None
    return result["time_ms"]


async def hold_on_children(workflow_instance: Any, hold_id: str) -> bool:
    """Simulate mode: this agent is now blocked awaiting child results, so it holds on its children.

    A held agent is excluded from shared time even if it acted before, so its
    children (and their waits) can move world time past it without deadlock.
    Returns whether the world acknowledged the hold (True outside a world:
    there is nothing to hold). The activity already retried the same hold_id.
    """
    if world_time_cursor_ms(workflow_instance) is None:
        return True
    acknowledged = await _world_clock_children_call(workflow_instance, "hold", {"hold_id": hold_id}) is not None
    if not acknowledged:
        workflow.logger.error(f"[world_clock] Hold {hold_id} was not acknowledged; children may wait on this agent")
    return acknowledged


async def release_children(workflow_instance: Any, hold_id: str, children: list[str]) -> bool:
    """Simulate mode: the awaiting call returned with these children's results.

    The agent receives their finish times (its cursor moves to them) and
    resumes acting on the world clock. Returns whether the world acknowledged
    the release (True outside a world). The activity already retried the same
    hold_id; when every attempt failed, the cursor is re-read from the world
    clock so the agent does not resume on an unacknowledged time.
    """
    if world_time_cursor_ms(workflow_instance) is None:
        return True
    time_ms = await _world_clock_children_call(
        workflow_instance, "release", {"hold_id": hold_id, "children": list(children)}
    )
    if time_ms is None:
        workflow.logger.error(f"[world_clock] Release {hold_id} was not acknowledged; re-reading this agent's world time")
        await _refresh_world_time_cursor(workflow_instance)
        return False
    latest = max(world_time_cursor_ms(workflow_instance) or time_ms, time_ms)
    set_world_time_cursor(workflow_instance, latest, now=workflow.now())
    return True
