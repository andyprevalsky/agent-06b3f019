"""Shared simulated wait activity boundary for wait tools."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

from helpers.world_model_runtime import world_clock_activity
from utils.simulated_clock import SIMULATED_CLOCK_ATTR, simulated_clock_offset_seconds


async def _wait_on_world_clock(
    workflow_instance: Any, wait_id: str, *, until_ms: int | None = None, duration_ms: int | None = None
) -> int | None:
    """Simulate mode: wait on the world's shared clock; None when it is unavailable.

    The clock resumes this agent once every other agent in the world has passed
    the deadline (or waits beyond it), so a waiting agent never overtakes one
    that is still working. Afterwards this agent's own clock follows world time.
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
    world_seconds = result["time_ms"] // 1000 - int(workflow.now().timestamp())
    setattr(
        workflow_instance,
        SIMULATED_CLOCK_ATTR,
        max(simulated_clock_offset_seconds(workflow_instance), world_seconds),
    )
    return result["time_ms"]
