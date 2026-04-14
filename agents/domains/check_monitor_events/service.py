"""Check monitor events domain service.

Business logic orchestration for checking monitor events.
Imports: own repo, own types, own config, external packages.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Dict, Optional

import structlog
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event as _handle_tool_event_real
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message

from .config import (
    ACTIVITY_BACKOFF_COEFFICIENT,
    ACTIVITY_INITIAL_INTERVAL_SECONDS,
    ACTIVITY_MAX_ATTEMPTS,
    ACTIVITY_MAX_INTERVAL_SECONDS,
    ACTIVITY_TIMEOUT_SECONDS,
    COST_CENTS,
    DEFAULT_EVENT_LIMIT,
    MONITOR_ID_PREFIX,
    TOOL_NAME,
)
from .repo import check_monitor_events_activity

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable

logger = structlog.get_logger()


async def _dispatch_tool_event(**kwargs: Any) -> None:
    """Dispatch to handle_tool_event, respecting test patches on the compat shim.

    Blackbox tests patch ``tools.check_monitor_events.handle_tool_event``.
    To honour that patch after the domain refactor, we resolve through
    ``sys.modules`` at call time so the patched reference is picked up.
    Falls back to the direct import when the shim module is not loaded.
    """
    import sys  # noqa: PLC0415 – deferred to keep module-level imports clean

    shim = sys.modules.get("tools.check_monitor_events")
    fn = getattr(shim, "handle_tool_event", None) if shim is not None else None
    if fn is not None:
        await fn(**kwargs)
    else:
        await _handle_tool_event_real(**kwargs)


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


class CheckMonitorEventsManager(ToolManager):
    """Manager for checking Monitor events using Parallel AI's Monitor API."""

    tool_name = TOOL_NAME
    read_only = True  # Research phase tool

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute event check and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
            tool_call: Tool call dict with 'monitor_id', 'limit'.
            tool_call_id: Unique ID for this tool call.
            agent_id: Agent ID for event routing.
            user_id: User ID for usage tracking.

        Returns:
            Result dict with events.
        """
        monitor_id = tool_call.get("monitor_id", "")
        limit = tool_call.get("limit", DEFAULT_EVENT_LIMIT)

        start_time = _safe_time()

        # Validate monitor_id format
        if not monitor_id.startswith(MONITOR_ID_PREFIX):
            await _dispatch_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Check events failed",
                    message="Invalid monitor_id format. Expected format: 'monitor_...'",
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name=TOOL_NAME,
                execute_activity=execute_activity,
                user_id=user_id,
            )
            return {"error": "Invalid monitor_id format", "events": []}

        # Pre-execution status
        await _dispatch_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📋 Checking monitor events",
                message=f"Monitor ID: {monitor_id}\nLimit: {limit}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # Execute check events activity
        try:
            logger.info("Calling check_monitor_events_activity", monitor_id=monitor_id, limit=limit)
            result = await execute_activity(
                check_monitor_events_activity,
                args=[monitor_id, limit],
                start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=ACTIVITY_MAX_ATTEMPTS,
                    backoff_coefficient=ACTIVITY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=ACTIVITY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=ACTIVITY_MAX_INTERVAL_SECONDS),
                ),
            )

            elapsed_time = _safe_time() - start_time

            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=COST_CENTS,
            )

            await _dispatch_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Monitor events retrieved",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name=TOOL_NAME,
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return result

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=COST_CENTS,
            )

            await _dispatch_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Check events failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name=TOOL_NAME,
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {"error": str(e), "events": []}


# ========================================
# SINGLETON
# ========================================

_manager: Optional[CheckMonitorEventsManager] = None


def get_manager() -> CheckMonitorEventsManager:
    """Get or create Check Monitor Events manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = CheckMonitorEventsManager()
    return _manager
