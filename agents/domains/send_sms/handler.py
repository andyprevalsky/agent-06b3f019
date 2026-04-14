"""Send-SMS domain handler — runtime entry point.

Thin orchestration layer: parses tool_call input, calls service functions,
and posts ToolEvents. Re-exports send_sms_activity from repo for
worker.py registration and test imports via the tools shim.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import structlog
from temporalio.common import RetryPolicy

from domains.send_sms.service import compute_service_usage, format_phone_number, send_sms_activity, truncate_message
from domains.send_sms.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, extract_root_error

__all__ = [
    "SendSmsManager",
    "send_sms",
    "send_sms_activity",
]

logger = structlog.get_logger()


# =============================================================================
# MANAGER
# =============================================================================


class SendSmsManager(ToolManager):
    """Manager for sending SMS messages via Surge SMS API."""

    tool_name = "send_sms"

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute SMS send and post events via handle_tool_event."""
        phone_number = tool_call.get("phone_number", "")
        message = tool_call.get("message", "")

        display_message = truncate_message(message)
        formatted_phone = format_phone_number(phone_number)

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\U0001f4f1 Sending SMS",
                message=f"""**To:** `{formatted_phone}`

**Message:**
{display_message}""",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_sms",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute SMS send activity
        try:
            result = await execute_activity(
                send_sms_activity,
                args=[phone_number, message],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )
        except Exception as e:
            error_msg = extract_root_error(e)
            logger.error("SMS send failed", error=error_msg, phone=phone_number[:4] + "****")
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="\u274c SMS send failed",
                    message=f"Error: {error_msg}",
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="send_sms",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": {"error": error_msg, "phone_number": phone_number},
                "usage": {"llm": [], "service": []},
            }

        # 3. Success status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u2705 SMS sent successfully",
                message=f"""**To:** {formatted_phone}
**Message:**
{display_message}""",
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_sms",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": result,
            "usage": {
                "llm": [],
                "service": compute_service_usage(),
            },
        }


# =============================================================================
# SINGLETON
# =============================================================================

_manager: SendSmsManager | None = None


def get_manager() -> SendSmsManager:
    """Get or create send SMS manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = SendSmsManager()
    return _manager


# =============================================================================
# TOOL ENTRY POINT
# =============================================================================


async def send_sms(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Execute send_sms tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'phone_number', 'message'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with success status, phone_number, message_id
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
