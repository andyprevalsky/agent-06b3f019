"""Send SMS as user tool - routes through user's iMessage client."""

from typing import Dict, Any, Optional, Callable, Awaitable
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from helpers.handle_tool_event import handle_tool_event

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

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


class SendSmsAsUserManager(ToolManager):
    """Manager for send_sms_as_user tool."""

    tool_name = "send_sms_as_user"

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute send_sms_as_user (currently disabled).
        
        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'phone_number', 'message'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict indicating tool is disabled
        """
        # Tool is currently disabled - requires Mac app integration
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📵 send_sms_as_user disabled",
                message="This tool is currently disabled. It requires the Rose Mac app to send messages through the user's iMessage. Use 'message_person' tool instead to send messages via SMS or email.",
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_sms_as_user",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        
        return {"disabled": True, "message": "Tool is currently disabled. Use message_person instead."}


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
    Execute send_sms_as_user tool (currently disabled).
    
    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'phone_number', 'message'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict indicating tool is disabled
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
