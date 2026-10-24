"""Display domain handler - thin workflow-side entry point for the ``display`` tool.

    validate ─► display_media_activity ─► FINISHED "Displayed N item(s)"

display never asks the user a question and never waits for an answer.
"""

from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.display.config import (
    DISPLAY_ACTIVITY_MAX_ATTEMPTS,
    DISPLAY_ACTIVITY_TIMEOUT_SECONDS,
    TOOL_NAME,
)
from domains.display.service import describe_error, describe_inline, validate_tool_call
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

with workflow.unsafe.imports_passed_through():
    from domains.display.service import display_media_activity

logger = structlog.get_logger()


class DisplayManager(ToolManager):
    """Show media inline for the user."""

    tool_name = TOOL_NAME
    read_only = True  # Posts to the user's own trajectory; no external side effects.

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        validation = validate_tool_call(
            tool_call,
            agent_id=str(workflow_instance.agent_id),
            user_id=str(workflow_instance.user_id or ""),
            workflow_id=str(workflow.info().workflow_id),
            tool_call_id=tool_call_id,
        )
        if not validation.get("ok"):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid display call",
                message=str(validation.get("error")),
                status=MessageStatus.ERROR,
            )
            return
        payload = validation["payload"]

        try:
            result = await workflow.execute_activity(
                display_media_activity,
                args=[payload],
                start_to_close_timeout=timedelta(seconds=DISPLAY_ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=DISPLAY_ACTIVITY_MAX_ATTEMPTS),
            )
        except Exception as e:  # activity failure after retries → tool error, not a crash
            logger.error("[Display] activity failed", agent_id=payload["agent_id"], error=str(e))
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Display failed",
                message=f"Could not reach Rose to display media: {e}",
                status=MessageStatus.ERROR,
            )
            return

        if not result.get("ok"):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Display rejected",
                message=describe_error(str(result.get("error") or "Display failed"), list(result.get("details") or [])),
                status=MessageStatus.ERROR,
            )
            return

        body: Dict[str, Any] = dict(result.get("body") or {})
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Displayed for the user",
            message=describe_inline(body),
            status=MessageStatus.FINISHED,
            metadata={"display": {"placement": "inline", "items": body.get("items") or []}},
        )


# ── Singleton ──

_manager: Optional[DisplayManager] = None


def get_manager() -> DisplayManager:
    """Get or create the display manager singleton."""
    global _manager
    if _manager is None:
        _manager = DisplayManager()
    return _manager


async def display(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> MessageStatus | None:
    """Workflow helper for the display tool (TOOL_EXECUTORS entry)."""
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, TOOL_NAME)
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
