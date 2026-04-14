"""Monitor domain service — business logic orchestration."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Dict, Optional

import structlog
from temporalio.common import RetryPolicy

from domains.monitor.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    COST_PER_REQUEST_CENTS,
    DEFAULT_CADENCE,
    DISPLAY_QUERY_MAX_LENGTH,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_INTERVAL_SECONDS,
    TITLE_QUERY_MAX_LENGTH,
)
from domains.monitor.repo import create_monitor as create_monitor
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message

if TYPE_CHECKING:
    from domains.monitor.types import ExecuteActivityCallable, MonitorToolResult

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _truncate(text: str, limit: int) -> str:
    """Truncate text to *limit* characters with an ellipsis suffix."""
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


async def execute_monitor(
    execute_activity: ExecuteActivityCallable,
    monitor_activity: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> MonitorToolResult:
    """Orchestrate a monitor-creation request.

    Posts progress events, delegates to the Temporal activity, tracks cost,
    and returns a standardised tool result.

    Args:
        execute_activity: workflow.execute_activity or equivalent callable.
        monitor_activity: The Temporal activity function to execute.
        tool_call: Tool call dict with 'query', 'cadence', etc.
        tool_call_id: Unique ID for this tool call.
        agent_id: Agent ID for event routing.
        user_id: User ID for usage tracking.

    Returns:
        MonitorToolResult dict with result and usage.
    """
    query = tool_call.get("query", "")
    cadence = tool_call.get("cadence", DEFAULT_CADENCE)
    # Convert enum to string if needed
    if hasattr(cadence, "value"):
        cadence = cadence.value
    webhook_url = tool_call.get("webhook_url")
    metadata = tool_call.get("metadata")

    title_query = _truncate(query, TITLE_QUERY_MAX_LENGTH)
    display_query = _truncate(query, DISPLAY_QUERY_MAX_LENGTH)

    start_time = _safe_time()

    # 1. Pre-execution status
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\U0001f4e1 Creating monitor: {title_query}",
            message=f"Query: {display_query}\nCadence: {cadence}",
            status=MessageStatus.IN_PROGRESS,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name="monitor",
        execute_activity=execute_activity,
        user_id=user_id,
    )

    # 2. Execute monitor creation activity
    try:
        logger.info("Calling monitor_activity", query_len=len(query), cadence=cadence)
        result = await execute_activity(
            monitor_activity,
            args=[query, cadence, webhook_url, metadata],
            start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(
                maximum_attempts=RETRY_MAX_ATTEMPTS,
                backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
                maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
            ),
        )

        # 3. Calculate elapsed time and cost
        elapsed_time = _safe_time() - start_time
        total_cost_cents = COST_PER_REQUEST_CENTS

        message = format_tool_message(
            params=tool_call,
            result=result,
            time_elapsed=elapsed_time,
            cost_cents=total_cost_cents,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Monitor created: {title_query}",
                message=message,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="monitor",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": result,
            "usage": {
                "llm": [],
                "service": [{"cost_cents": int(total_cost_cents), "provider": "Parallel Monitor API"}],
            },
        }

    except Exception as e:
        elapsed_time = _safe_time() - start_time

        error_message = format_error_message(
            params=tool_call,
            error=e,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"\u274c Monitor creation failed: {title_query}",
                message=error_message,
                status=MessageStatus.ERROR,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="monitor",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": {"error": str(e)},
            "usage": {"llm": [], "service": []},
        }
