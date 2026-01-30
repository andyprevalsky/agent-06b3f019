"""Send SMS as user tool - routes through user's iMessage client via Mac app."""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, extract_root_error
from helpers.handle_tool_event import handle_tool_event
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


def format_phone_number(number: str) -> str:
    """Format phone number for display as +1 (972) 977-7432."""
    import re
    digits = re.sub(r"[^\d]", "", number)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    match = re.fullmatch(r"(\d{3})(\d{3})(\d{4})", digits)
    if match:
        area, prefix, line = match.groups()
        return f"+1 ({area}) {prefix}-{line}"
    return number


def normalize_to_e164(number: str) -> str:
    """Normalize phone number to E.164 format (+19729777432)."""
    import re
    digits = re.sub(r"[^\d]", "", number)
    # Handle 10-digit US numbers
    if len(digits) == 10:
        return f"+1{digits}"
    # Handle 11-digit numbers starting with 1
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    # Already has country code or international
    if number.startswith("+"):
        return f"+{digits}"
    return f"+{digits}"


class SendSmsAsUserManager(ToolManager):
    """Manager for send_sms_as_user tool - sends iMessages via user's Mac app."""

    tool_name = "send_sms_as_user"
    requires_approval = True

    def get_approval_question(self, tool_call: Dict[str, Any]) -> str:
        """Build approval question showing recipient and message preview."""
        phone = tool_call.get("phone_number", "unknown")
        message = tool_call.get("message", "")
        system_name = tool_call.get("system_name", "Rose")

        formatted_phone = format_phone_number(phone)
        message_preview = message if len(message) <= 200 else message[:197] + "..."

        return f"""{system_name} wants to send an **iMessage** from your phone

**To:** {formatted_phone}

**Message:**
{message_preview}

Reply to approve, or say "no" to cancel."""

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute send_sms_as_user by queuing to backend for Mac app delivery.

        Args:
            execute_activity: workflow.execute_activity
            tool_call: Tool call dict with 'phone_number', 'message'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for queue routing

        Returns:
            Result dict with queue status
        """
        phone_number = tool_call.get("phone_number", "")
        message = tool_call.get("message", "")

        formatted_phone = format_phone_number(phone_number)
        display_message = message if len(message) <= 100 else message[:97] + "..."

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📱 Queueing iMessage",
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
                        title="✅ iMessage queued",
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
                        title="❌ Failed to queue iMessage",
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
                    title="❌ iMessage queue failed",
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


_manager: Optional[SendSmsAsUserManager] = None


def get_manager() -> SendSmsAsUserManager:
    global _manager
    if _manager is None:
        _manager = SendSmsAsUserManager()
    return _manager


async def send_sms_as_user(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
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


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
async def queue_imessage_activity(
    user_id: str,
    agent_id: str,
    phone_number: str,
    message: str,
) -> Dict[str, Any]:
    """Activity: Queue iMessage to backend for Mac app delivery."""
    config = load_config()

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/imessage/queue",
            headers={
                "x-api-key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json={
                "user_id": user_id,
                "agent_id": agent_id,
                "phone_number": phone_number,
                "message": message,
            },
        )

        if response.status_code not in [200, 201]:
            error_text = response.text
            logger.error("iMessage queue failed", status=response.status_code, error=error_text)
            return {"success": False, "error": f"API error: {response.status_code}"}

        result = response.json()
        logger.info("iMessage queued", queue_id=result.get("queue_id"))
        return {"success": True, "queue_id": result.get("queue_id")}
