"""Send email tool - event-driven architecture."""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event

# Config import is safe - no side effects at import time (load_dotenv is lazy)
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


class SendEmailManager(ToolManager):
    """Manager for sending emails via user's connected Gmail account."""

    tool_name = "send_email"

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute email send and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'to', 'subject', 'body', optional 'cc'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking and email sending

        Returns:
            Result dict with messageId, threadId, etc.
        """
        to = tool_call.get("to", "")
        subject = tool_call.get("subject", "")
        body = tool_call.get("body", "")
        cc = tool_call.get("cc")

        # Track start time for elapsed time calculation
        start_time = _safe_time()

        # Truncate long subjects for display
        display_subject = subject if len(subject) <= 50 else subject[:47] + "..."

        # 1. Pre-execution status
        pre_message = f"**To:** {to}\n**Subject:** {display_subject}"
        if cc:
            pre_message = f"**To:** {to}\n**Cc:** {cc}\n**Subject:** {display_subject}"

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📧 Sending Email",
                message=pre_message,
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_email",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute email send activity
        try:
            result = await execute_activity(
                send_email_activity,
                args=[user_id, to, subject, body, cc],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )

            # 3. Calculate elapsed time
            elapsed_time = _safe_time() - start_time

            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Post-execution success
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="✅ Email sent successfully",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="send_email",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return result

        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time

            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Email send failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="send_email",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {"error": str(e), "to": to, "subject": subject}


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SendEmailManager] = None


def get_manager() -> SendEmailManager:
    """Get or create send email manager singleton."""
    global _manager
    if _manager is None:
        _manager = SendEmailManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def send_email(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute send_email tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'to', 'subject', 'body', optional 'cc'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with messageId, threadId, etc.
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
async def send_email_activity(
    user_id: str,
    to: str,
    subject: str,
    body: str,
    cc: Optional[str] = None
) -> Dict[str, Any]:
    """
    Activity: Send email via backend API (backend handles Gmail OAuth).

    Args:
        user_id: User ID for the request
        to: Recipient email address
        subject: Email subject
        body: Email body content
        cc: Optional CC recipient

    Returns:
        Dict with:
            - messageId: Gmail message ID
            - threadId: Gmail thread ID

    Raises:
        Exception: If email fails to send (Gmail not connected, auth error, etc.)
    """
    try:
        activity.heartbeat(f"Sending email to {to[:20]}...")

        config = load_config()

        async with httpx.AsyncClient(timeout=30.0) as client:
            payload = {
                "user_id": user_id,  # For internal API key auth
                "to": to,
                "subject": subject,
                "body": body,
            }
            if cc:
                payload["cc"] = cc

            response = await client.post(
                f"{config.backend.api_url}/api/integrations/email/send",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json=payload
            )

            result = response.json()

            if response.status_code != 200:
                # Extract error message from backend response
                error_msg = result.get("message") or result.get("error") or f"Backend error ({response.status_code})"
                raise Exception(error_msg)

            logger.info(
                "Email sent successfully",
                to=to,
                message_id=result.get("messageId", "unknown")
            )

            return {
                "messageId": result.get("messageId"),
                "threadId": result.get("threadId"),
                "to": to,
                "subject": subject,
            }

    except httpx.TimeoutException:
        logger.error("Send email timeout", to=to)
        raise Exception("Request timed out while sending email")
    except Exception as e:
        logger.error("Send email failed", error=str(e), to=to)
        raise
