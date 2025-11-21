"""Send SMS as user tool - routes through user's iMessage client."""

from typing import Dict, Any, Optional, AsyncGenerator
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from tools.request_user_attention import request_user_attention_direct

logger = structlog.get_logger()


def _format_preview(phone_number: str, message: str) -> str:
    """Format phone and message preview for UI."""
    masked_phone = phone_number
    digits = ''.join(ch for ch in phone_number if ch.isdigit())
    if len(digits) >= 4:
        masked_phone = f"{phone_number[:-4]}****"
    clipped_message = message if len(message) <= 200 else message[:197] + "..."
    return f"""**To:** `{masked_phone}`

**Preview:**  
{clipped_message}"""


def _build_question(phone_number: str, message: str) -> str:
    """Build the question shown in the attention request."""
    return f"""Rose wants to send a iMessage through your account

## To: {phone_number}

## Message: {message}"""


class SendSmsAsUserManager(ToolManager):
    """Manager for send_sms_as_user tool."""

    tool_name = "send_sms_as_user"

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        phone_number = tool_call.get("phone_number")
        message = tool_call.get("message")

        if not phone_number or not isinstance(phone_number, str):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing phone number",
                message="Please provide a `phone_number` in E.164 format.",
                status=MessageStatus.ERROR,
            )
            return

        if not message or not isinstance(message, str):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing message",
                message="Please provide a `message` to send via iMessage.",
                status=MessageStatus.ERROR,
            )
            return

        preview = _format_preview(phone_number, message)

        attention_metadata = {
            "onSuccess": "sendSmsThroughIMessage",
            "to": phone_number,
            "message": message,
        }
        request_metadata = {"requestUserAttention": dict(attention_metadata)}

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="📲 Requesting approval to send SMS via your Mac",
            message=preview,
            status=MessageStatus.IN_PROGRESS,
            metadata=request_metadata,
        )

        question = _build_question(phone_number, message)

        try:
            logger.info(
                "Creating send_sms_as_user attention request",
                phone_number=phone_number,
            )
            result = await request_user_attention_direct(
                workflow_instance,
                question,
                metadata=attention_metadata,
            )
            if result.get("attention_request_id"):
                request_metadata["requestUserAttention"]["attentionRequestId"] = result["attention_request_id"]
        except Exception as exc:
            logger.error(
                "Failed to request user attention for send_sms_as_user",
                error=str(exc),
            )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed to request approval",
                message=str(exc),
                status=MessageStatus.ERROR,
                metadata=request_metadata,
            )
            raise

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✅ Waiting for user approval",
            message="Once you confirm in the Mac app, I'll continue.",
            status=MessageStatus.FINISHED,
            metadata=request_metadata,
        )


_manager: Optional[SendSmsAsUserManager] = None


def get_manager() -> SendSmsAsUserManager:
    global _manager
    if _manager is None:
        _manager = SendSmsAsUserManager()
    return _manager


async def send_sms_as_user(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "send_sms_as_user")

