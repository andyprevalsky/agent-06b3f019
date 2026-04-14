"""Send SMS as user domain handler - tool entry point and Temporal activity."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any, Optional

import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, extract_root_error

from .repo import queue_imessage_via_backend
from .service import build_approval_question, build_queue_display_message, normalize_to_e164

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable

logger = structlog.get_logger()


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
async def queue_imessage_activity(
    user_id: str,
    agent_id: str,
    phone_number: str,
    message: str,
) -> dict[str, Any]:
    """Activity: Queue iMessage to backend for Mac app delivery."""
    return await queue_imessage_via_backend(user_id, agent_id, phone_number, message)


# ========================================
# TOOL MANAGER
# ========================================


class SendSmsAsUserManager(ToolManager):
    """Manager for send_sms_as_user tool - sends iMessages via user's Mac app."""

    tool_name = "send_sms_as_user"
    requires_approval = True

    def get_approval_question(self, tool_call: dict[str, Any]) -> str:
        """Build approval question showing recipient and message preview."""
        phone = tool_call.get("phone_number", "unknown")
        message = tool_call.get("message", "")
        system_name = tool_call.get("system_name", "Rose")
        return build_approval_question(phone, message, system_name)

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute send_sms_as_user by queuing to backend for Mac app delivery."""
        phone_number = tool_call.get("phone_number", "")
        message = tool_call.get("message", "")

        formatted_phone, display_message = build_queue_display_message(phone_number, message)

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\U0001f4f1 Queueing iMessage",
                message=f"**To:** {formatted_phone}\n\n**Message:**\n{display_message}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_sms_as_user",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Queue to backend via activity
        try:
            e164_phone = normalize_to_e164(phone_number)
            result = await execute_activity(
                queue_imessage_activity,
                args=[user_id, agent_id, e164_phone, message],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )

            if result.get("success"):
                await handle_tool_event(
                    event=ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="\u2705 iMessage queued",
                        message=f"**To:** {formatted_phone}\n\nMessage queued for delivery via Mac app.",
                        status=MessageStatus.FINISHED,
                    ),
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="send_sms_as_user",
                    execute_activity=execute_activity,
                    user_id=user_id,
                )

                return {
                    "result": {
                        "success": True,
                        "queue_id": result.get("queue_id"),
                        "phone_number": phone_number,
                        "message": "iMessage queued for delivery via Mac app",
                    },
                    "usage": {"llm": [], "service": []},
                }
            else:
                error_msg = result.get("error", "Unknown error")
                await handle_tool_event(
                    event=ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="\u274c Failed to queue iMessage",
                        message=f"Error: {error_msg}",
                        status=MessageStatus.ERROR,
                    ),
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="send_sms_as_user",
                    execute_activity=execute_activity,
                    user_id=user_id,
                )

                return {
                    "result": {"error": error_msg, "phone_number": phone_number},
                    "usage": {"llm": [], "service": []},
                }

        except Exception as e:
            error_msg = extract_root_error(e)
            logger.error("iMessage queue failed", error=error_msg, phone=phone_number[:4] + "****")

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="\u274c iMessage queue failed",
                    message=f"Error: {error_msg}",
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="send_sms_as_user",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": {"error": error_msg, "phone_number": phone_number},
                "usage": {"llm": [], "service": []},
            }


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SendSmsAsUserManager] = None


def get_manager() -> SendSmsAsUserManager:
    """Get or create send_sms_as_user manager singleton."""
    global _manager
    if _manager is None:
        _manager = SendSmsAsUserManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================


async def send_sms_as_user(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Execute send_sms_as_user tool.

    Args:
        execute_activity: workflow.execute_activity
        tool_call: Tool call dict with 'phone_number', 'message'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for queue routing

    Returns:
        Result dict with queue status
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
