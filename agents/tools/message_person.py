"""Message person tool - unified SMS/email sending with read-first enforcement."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message

# Import activities from existing tools
with workflow.unsafe.imports_passed_through():
    from tools.send_sms import send_sms_activity
    from tools.send_email import send_email_activity

logger = structlog.get_logger()


def _normalize_phone(phone: Optional[str]) -> Optional[str]:
    """Normalize phone number for comparison (remove spaces, dashes, etc.)."""
    if not phone:
        return None
    # Keep only digits and leading +
    normalized = ''.join(c for c in phone if c.isdigit() or c == '+')
    return normalized if normalized else None


def _normalize_email(email: Optional[str]) -> Optional[str]:
    """Normalize email for comparison (lowercase, strip whitespace)."""
    if not email:
        return None
    return email.lower().strip()


def _check_read_history_in_context(
    context: list,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None
) -> tuple[bool, Optional[Dict]]:
    """
    Check if read_message_history_with_person was called for the same person.
    
    Returns:
        Tuple of (found: bool, person_info: Optional[Dict])
    """
    normalized_phone = _normalize_phone(phone)
    normalized_email = _normalize_email(email)
    normalized_first = first_name.lower().strip() if first_name else None
    normalized_last = last_name.lower().strip() if last_name else None
    
    for msg in context:
        metadata = msg.get("metadata", {})
        if not metadata:
            continue
        
        # Look for read_message_history_person metadata
        read_info = metadata.get("read_message_history_person")
        if not read_info:
            continue
        
        # Check if this read matches the person we're trying to message
        read_phone = _normalize_phone(read_info.get("phone") or read_info.get("person_phone"))
        read_email = _normalize_email(read_info.get("email") or read_info.get("person_email"))
        read_first = read_info.get("first_name", "").lower().strip() if read_info.get("first_name") else None
        read_last = read_info.get("last_name", "").lower().strip() if read_info.get("last_name") else None
        
        # Match by phone
        if normalized_phone and read_phone and normalized_phone == read_phone:
            return True, read_info
        
        # Match by email
        if normalized_email and read_email and normalized_email == read_email:
            return True, read_info
        
        # Match by full name
        if normalized_first and normalized_last and read_first and read_last:
            if normalized_first == read_first and normalized_last == read_last:
                return True, read_info
    
    return False, None


class MessagePersonManager(ToolManager):
    """Manager for sending messages to a person via SMS or email."""

    tool_name = "message_person"

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute message send and yield events.
        
        Pre-check: Verifies that read_message_history_with_person was called
        for the same person in the workflow context.

        Yields:
            - Pre-execution status with message preview
            - Post-execution status with success/error
        """
        channel = tool_call.get("channel", "").lower()
        phone = tool_call.get("phone")
        email = tool_call.get("email")
        first_name = tool_call.get("first_name")
        last_name = tool_call.get("last_name")
        message = tool_call.get("message", "")
        subject = tool_call.get("subject")

        # Get user_id from workflow instance
        user_id = workflow_instance.user_id

        # Track start time for elapsed time calculation
        start_time = time.time()

        # Build person identifier for display
        if first_name and last_name:
            person_identifier = f"{first_name} {last_name}"
        elif email:
            person_identifier = email
        elif phone:
            person_identifier = phone
        else:
            person_identifier = "Unknown"

        # Validate channel
        if channel not in ["sms", "email"]:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid channel",
                message=f"Channel must be 'sms' or 'email', got: '{channel}'",
                status=MessageStatus.ERROR
            )
            return

        # Validate required fields based on channel
        if channel == "sms" and not phone:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing phone number",
                message="Phone number is required for SMS channel. Please provide a phone number in E.164 format (e.g., +19729777432).",
                status=MessageStatus.ERROR
            )
            return

        if channel == "email":
            if not email:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Missing email address",
                    message="Email address is required for email channel.",
                    status=MessageStatus.ERROR
                )
                return
            if not subject:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Missing email subject",
                    message="Subject is required for email channel.",
                    status=MessageStatus.ERROR
                )
                return

        if not message:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing message",
                message="Message content is required.",
                status=MessageStatus.ERROR
            )
            return

        # CHECK: Verify that read_message_history_with_person was called for this person
        context = workflow_instance.context
        history_read, read_info = _check_read_history_in_context(
            context, phone, email, first_name, last_name
        )

        if not history_read:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Must read message history first",
                message=(
                    f"**Error:** You must call `read_message_history_with_person` for **{person_identifier}** "
                    f"before sending a message to them.\n\n"
                    f"This ensures you have context about your previous conversations. "
                    f"Please call `read_message_history_with_person` with the same identifier "
                    f"(phone: {phone}, email: {email}, name: {first_name} {last_name}) first, "
                    f"then retry this message."
                ),
                status=MessageStatus.ERROR
            )
            return

        # Truncate long messages for display
        display_message = message if len(message) <= 100 else message[:97] + "..."

        # 1. Pre-execution status
        if channel == "sms":
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📱 Sending SMS",
                message=f"**To:** {phone}\n**Message:** {display_message}",
                status=MessageStatus.IN_PROGRESS
            )
        else:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📧 Sending Email",
                message=f"**To:** {email}\n**Subject:** {subject}\n**Message:** {display_message}",
                status=MessageStatus.IN_PROGRESS
            )

        # 2. Execute send activity based on channel
        try:
            if channel == "sms":
                result = await workflow.execute_activity(
                    send_sms_activity,
                    args=[phone, message],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        backoff_coefficient=2.0,
                        initial_interval=timedelta(seconds=1),
                        maximum_interval=timedelta(seconds=10)
                    )
                )
            else:  # email
                result = await workflow.execute_activity(
                    send_email_activity,
                    args=[user_id, email, subject, message, None],  # No CC
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        backoff_coefficient=2.0,
                        initial_interval=timedelta(seconds=1),
                        maximum_interval=timedelta(seconds=10)
                    )
                )

            # 3. Calculate elapsed time
            elapsed_time = time.time() - start_time

            # Format success message
            formatted_message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=2 if channel == "sms" else 0  # SMS has a small cost
            )

            # Post-execution success
            if channel == "sms":
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="✅ SMS sent successfully",
                    message=formatted_message,
                    status=MessageStatus.FINISHED
                )
            else:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="✅ Email sent successfully",
                    message=formatted_message,
                    status=MessageStatus.FINISHED
                )

        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = time.time() - start_time

            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Error status
            channel_name = "SMS" if channel == "sms" else "Email"
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"❌ {channel_name} send failed",
                message=error_message,
                status=MessageStatus.ERROR
            )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[MessagePersonManager] = None


def get_manager() -> MessagePersonManager:
    """Get or create message person manager singleton."""
    global _manager
    if _manager is None:
        _manager = MessagePersonManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def message_person(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for message_person (event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'channel', 'phone'/'email', 'message', optional 'subject'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "message_person")

