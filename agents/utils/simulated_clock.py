"""Simulated-clock helpers for world-model simulate runs.

Under ``world_model_mode="simulate"`` every provider boundary (browser, search,
phone, messaging, payments) is served by the World Model Harness, so waiting
real wall-clock time for that world to change is pure dead time. Time skipping
replaces the sleep with a logical clock advance kept on the workflow instance::

    WMH world clock (one per root) ──register / wait ack / read──▶ simulated_world_time_ms
                                                                     │
                                       simulated_now() = that cursor (the agent's world time)

Inside a WMH world each agent's "now" is its world-time cursor: its time on the
world's shared clock. Model thinking costs no world time; simulated actions
advance it by their predicted duration, waits by the acknowledged world time.
Without a world (no cursor) the legacy private offset is used:

    wait_for / wait_seconds ──advance──▶ workflow_instance.simulated_clock_offset_seconds
                       simulated_now() = workflow.now() + offset   (later waits build on it)

Both are ordinary workflow state, so they are deterministic on replay. Real
mode never touches them: every helper is a no-op unless the instance declares
``world_model_mode == "simulate"``.

Pure Python + datetime only: this module is imported from inside Temporal
workflow code (the sandbox), so it must not pull in httpx/temporalio activities.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

SIMULATED_CLOCK_ATTR = "simulated_clock_offset_seconds"
WORLD_TIME_CURSOR_ATTR = "simulated_world_time_ms"


def simulated_time_skip_enabled(workflow_instance: Any) -> bool:
    """True only for agents running against the World Model Harness."""
    if workflow_instance is None:
        return False
    return getattr(workflow_instance, "world_model_mode", "real") == "simulate"


def simulated_clock_offset_seconds(workflow_instance: Any) -> int:
    """Seconds the simulated clock is ahead of the workflow clock (0 outside simulate)."""
    if workflow_instance is None:
        return 0
    raw = getattr(workflow_instance, SIMULATED_CLOCK_ATTR, 0)
    try:
        parsed = int(raw or 0)
        return parsed if simulated_time_skip_enabled(workflow_instance) else max(0, parsed)
    except (TypeError, ValueError):
        return 0


def world_time_cursor_ms(workflow_instance: Any) -> int | None:
    """This agent's world-time cursor in epoch ms, or None outside a WMH world."""
    if not simulated_time_skip_enabled(workflow_instance):
        return None
    cursor = getattr(workflow_instance, WORLD_TIME_CURSOR_ATTR, None)
    return cursor if type(cursor) is int else None


def set_world_time_cursor(workflow_instance: Any, time_ms: int, *, now: datetime) -> None:
    """Set the cursor to an acknowledged world time (simulate mode only).

    The legacy offset is kept equal to it so offset-reading callers agree.
    """
    if not simulated_time_skip_enabled(workflow_instance) or type(time_ms) is not int:
        return
    setattr(workflow_instance, WORLD_TIME_CURSOR_ATTR, time_ms)
    setattr(workflow_instance, SIMULATED_CLOCK_ATTR, time_ms // 1000 - int(now.timestamp()))


def advance_simulated_clock(workflow_instance: Any, seconds: int | float) -> int:
    """Skip ``seconds`` of simulated time; returns the new offset.

    No-op (returns the current offset) when the instance is not simulating, so
    callers can invoke it unconditionally after deciding to skip a sleep.
    """
    offset = simulated_clock_offset_seconds(workflow_instance)
    if not simulated_time_skip_enabled(workflow_instance):
        return offset
    try:
        step = max(0, int(seconds))
    except (TypeError, ValueError):
        step = 0
    offset += step
    setattr(workflow_instance, SIMULATED_CLOCK_ATTR, offset)
    cursor = world_time_cursor_ms(workflow_instance)
    if cursor is not None:
        # The world clock was unreachable for this wait: move the cursor locally.
        setattr(workflow_instance, WORLD_TIME_CURSOR_ATTR, cursor + step * 1000)
    return offset


def simulated_now(workflow_instance: Any, now: datetime) -> datetime:
    """The agent's current time: its world-time cursor, else the workflow clock plus skipped time."""
    cursor = world_time_cursor_ms(workflow_instance)
    if cursor is not None:
        return datetime.fromtimestamp(cursor / 1000, timezone.utc)
    return now + timedelta(seconds=simulated_clock_offset_seconds(workflow_instance))


def simulated_timestamp_ms(workflow_instance: Any, now: datetime) -> int:
    """Return the workflow's logical clock as epoch milliseconds for WMH actions."""
    cursor = world_time_cursor_ms(workflow_instance)
    if cursor is not None:
        return cursor
    return int(simulated_now(workflow_instance, now).timestamp() * 1000)


def simulated_skip_metadata(workflow_instance: Any, skipped_seconds: int | float) -> dict[str, Any]:
    """Tool-event metadata that records a skipped wait so transcripts stay auditable."""
    try:
        skipped = max(0, int(skipped_seconds))
    except (TypeError, ValueError):
        skipped = 0
    return {
        "simulatedTimeSkip": True,
        "simulatedSkipSeconds": skipped,
        "simulatedClockOffsetSeconds": simulated_clock_offset_seconds(workflow_instance),
    }
