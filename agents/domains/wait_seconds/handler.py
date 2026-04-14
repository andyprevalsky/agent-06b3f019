"""Wait-seconds domain handler — thin runtime entry point.

Parses input, delegates to service, yields ``ToolEvent`` objects.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator

from temporalio import workflow

from domains.wait_seconds.service import format_duration, validate_seconds
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager


class WaitSecondsManager(ToolManager):
    """Manager for wait/sleep operations."""

    tool_name = "wait_seconds"

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute wait and yield events.

        Yields:
            Pre-execution status, then post-execution status.
        """
        seconds = tool_call.get("seconds", 1)

        # Validate
        error = validate_seconds(seconds)
        if error is not None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Invalid wait duration",
                message=error,
                status=MessageStatus.ERROR,
            )
            return

        duration = format_duration(seconds)

        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\u23f1\ufe0f Waiting {duration}",
            message="",
            status=MessageStatus.IN_PROGRESS,
        )

        # 2. Execute wait using workflow.sleep (deterministic)
        try:
            await workflow.sleep(seconds)
        except Exception as exc:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Wait failed",
                message=str(exc),
                status=MessageStatus.ERROR,
            )
            return

        # 3. Success status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\u2713 Waited {duration}",
            message="",
            status=MessageStatus.FINISHED,
        )


# ========================================
# SINGLETON
# ========================================

_manager: WaitSecondsManager | None = None


def get_manager() -> WaitSecondsManager:
    """Get or create wait seconds manager singleton."""
    global _manager
    if _manager is None:
        _manager = WaitSecondsManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================


async def wait_seconds(workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str) -> MessageStatus | None:
    """Workflow helper for wait_seconds (event-driven system).

    Yields events via ``_handle_tool_event`` and returns the last status.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "wait_seconds")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
