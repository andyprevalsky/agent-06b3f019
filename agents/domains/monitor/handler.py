"""Monitor domain handler — Temporal activity + tool entry point."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any, Dict, Optional

from temporalio import activity

from domains.monitor.service import create_monitor, execute_monitor

# @activity.defn calls get_type_hints() at decoration time, which resolves
# string annotations. MonitorActivityResult must be a runtime import.
from domains.monitor.types import MonitorActivityResult  # noqa: TCH001

if TYPE_CHECKING:
    from domains.monitor.types import ExecuteActivityCallable, MonitorToolResult

# ── Temporal Activity ────────────────────────────────────────────────


@activity.defn
async def monitor_activity(
    query: str,
    cadence: str = "daily",
    webhook_url: Optional[str] = None,
    metadata: Optional[Dict[str, str]] = None,
) -> MonitorActivityResult:
    """Create a monitor using Parallel AI's Monitor API.

    Creates a monitor that tracks the web for material changes on a schedule.
    Monitor creation is synchronous and returns immediately with a monitor_id.

    Args:
        query: Natural language query describing what to monitor.
        cadence: Frequency of monitoring (hourly/daily/weekly).
        webhook_url: Optional URL for webhook notifications.
        metadata: Optional metadata dict (keys/values must be strings).

    Returns:
        Dict with monitor_id and status.
    """
    with contextlib.suppress(RuntimeError):
        activity.heartbeat(f"Creating monitor: {query[:50]}...")

    return await create_monitor(
        query=query,
        cadence=cadence,
        webhook_url=webhook_url,
        metadata=metadata,
    )


# ── Tool Entry Point ─────────────────────────────────────────────────


async def monitor(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> MonitorToolResult:
    """Execute monitor tool.

    Args:
        execute_activity: workflow.execute_activity or equivalent callable.
        tool_call: Tool call dict with 'query', 'cadence', 'webhook_url', 'metadata'.
        tool_call_id: Unique ID for this tool call.
        agent_id: Agent ID for event routing.
        user_id: User ID for usage tracking.

    Returns:
        Result dict with monitor_id and usage.
    """
    return await execute_monitor(
        execute_activity=execute_activity,
        monitor_activity=monitor_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
