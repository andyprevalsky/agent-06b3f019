"""Send SMS tool - event-driven architecture."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageType, UsageItem

# Import config with safe imports to avoid sandbox restrictions
with workflow.unsafe.imports_passed_through():
    from config import load_config

logger = structlog.get_logger()


class SendSmsManager(ToolManager):
    """Manager for sending SMS messages via MessageBird API."""
    
    tool_name = "send_sms"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute SMS send and yield events.
        
        Yields:
            - Pre-execution status with message preview
            - Usage tracking event
            - Post-execution status with success/error
        """
        phone_number = tool_call.get("phone_number", "")
        message = tool_call.get("message", "")
        
        # Truncate long messages for display
        display_message = message if len(message) <= 50 else message[:47] + "..."
        # Mask phone for display
        def format_phone_number(number: str) -> str:
            """Format phone number for display as +1 (972) 977-7432 or leave as-is on failure."""
            import re
            match = re.fullmatch(r"\+?1?(\d{3})(\d{3})(\d{4})", re.sub(r"[^\d+]", "", number))
            if match:
                area, prefix, line = match.groups()
                return f"+1 ({area}) {prefix}-{line}"
            return number
        
        formatted_phone_number = format_phone_number(phone_number)
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="📱 Sending SMS",
            message=f"""**To:** `{formatted_phone_number}`

**Message:**  
{display_message}""",
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Execute SMS send activity
        try:
            result = await workflow.execute_activity(
                send_sms_activity,
                args=[phone_number, message],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            # 3. Report usage (estimated cost: $0.015 per SMS)
            cost_cents = 2  # $0.015 = 1.5 cents, round to 2 cents
            yield ToolEvent(
                type=EventType.USAGE,
                tool_name="send_sms",
                usage_items=[
                    UsageItem(
                        type=UsageType.SERVICE,
                        cost_cents=cost_cents,
                        provider="MessageBird SMS"
                    )
                ]
            )
            
            # 4. Post-execution success
            phone_number = result.get("phone_number", "user")
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✅ SMS sent successfully",
                message=f"""**To:** {formatted_phone_number}
**Message:**  
{display_message}""",
                status=MessageStatus.FINISHED
            )
            
        except Exception as e:
            # Error status
            error_msg = str(e)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ SMS send failed",
                message=f"Error: {error_msg}",
                status=MessageStatus.ERROR
            )
            # Don't raise - error event already posted the formatted message


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SendSmsManager] = None


def get_manager() -> SendSmsManager:
    """Get or create send SMS manager singleton."""
    global _manager
    if _manager is None:
        _manager = SendSmsManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def send_sms(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for send_sms (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'message'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "send_sms")


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def send_sms_activity(phone_number: str, message: str) -> Dict[str, Any]:
    """
    Activity: Send SMS message via backend API (backend handles MessageBird).
    
    Agent doesn't need MessageBird credentials - backend does the API call.
    
    Args:
        phone_number: Phone number in E.164 format (e.g., +19729777432)
        message: SMS message content
        
    Returns:
        Dict with:
            - success: Boolean
            - phone_number: Recipient phone
            - message_id: MessageBird message ID (if available)
    """
    try:
        activity.heartbeat(f"Sending SMS to {phone_number[:4]}****")
        
        config = load_config()
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Call backend API to send SMS (backend handles MessageBird credentials)
            response = await client.post(
                f"{config.backend.api_url}/api/send-sms",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "phone_number": phone_number,
                    "message": message
                }
            )
            
            if response.status_code not in [200, 201]:
                error_data = response.text
                raise Exception(f"Backend API error ({response.status_code}): {error_data}")
            
            result = response.json()
            
            logger.info(
                "SMS sent successfully",
                phone=phone_number,
                message_id=result.get("message_id", "unknown")
            )
            
            return result
        
    except Exception as e:
        logger.error("SMS send failed", error=str(e))
        raise

