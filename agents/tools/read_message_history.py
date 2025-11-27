"""Read message history with person tool - event-driven architecture."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message

# Import config with safe imports to avoid sandbox restrictions
with workflow.unsafe.imports_passed_through():
    from config import load_config

logger = structlog.get_logger()


class ReadMessageHistoryManager(ToolManager):
    """Manager for reading message history with a person."""

    tool_name = "read_message_history_with_person"

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute message history read and yield events.

        Yields:
            - Pre-execution status with person identifier
            - Post-execution status with message history or no messages message
        """
        phone = tool_call.get("phone")
        email = tool_call.get("email")
        first_name = tool_call.get("first_name")
        last_name = tool_call.get("last_name")

        # Get user_id from workflow instance
        user_id = workflow_instance.user_id

        # Track start time for elapsed time calculation
        start_time = time.time()

        # Validate at least one identifier is provided
        has_phone = phone and str(phone).strip()
        has_email = email and str(email).strip()
        has_name = first_name and last_name and str(first_name).strip() and str(last_name).strip()
        
        if not has_phone and not has_email and not has_name:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Missing identifier",
                message="At least one identifier is required: phone, email, or first_name + last_name.",
                status=MessageStatus.ERROR
            )
            return

        # Build person identifier for display
        if has_name:
            person_identifier = f"{first_name} {last_name}"
        elif has_email:
            person_identifier = email
        elif has_phone:
            person_identifier = phone
        else:
            person_identifier = "Unknown"

        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Reading message history",
            message=f"Looking up messages with **{person_identifier}**...",
            status=MessageStatus.IN_PROGRESS
        )

        # 2. Execute activity
        try:
            result = await workflow.execute_activity(
                read_message_history_activity,
                args=[user_id, phone, email, first_name, last_name],
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

            # Check if person was found and has messages
            messages = result.get("messages", [])
            person = result.get("person")
            no_messages_msg = result.get("message")

            # Build metadata for ALL cases - this allows message_person to verify read was done
            read_metadata = {
                "read_message_history_person": {
                    "phone": phone,
                    "email": email,
                    "first_name": first_name,
                    "last_name": last_name,
                    "person_id": person.get("id") if person else None,
                    "person_phone": person.get("phoneNumber") if person else None,
                    "person_email": person.get("email") if person else None,
                }
            }

            if not person:
                # No person found
                message = format_tool_message(
                    params=tool_call,
                    result={"message": no_messages_msg or f"No person found matching: {person_identifier}"},
                    time_elapsed=elapsed_time,
                    cost_cents=0
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Read message history failed for: {person_identifier}",
                    message=message,
                    status=MessageStatus.FINISHED,
                    metadata=read_metadata
                )
            elif len(messages) == 0:
                # Person found but no messages
                person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
                message = format_tool_message(
                    params=tool_call,
                    result={"message": f"No messages present for {person_name}"},
                    time_elapsed=elapsed_time,
                    cost_cents=0
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"No messages with {person_name}",
                    message=message,
                    status=MessageStatus.FINISHED,
                    metadata=read_metadata
                )
            else:
                # Person found with messages
                person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
                
                # Format messages for display (show all, nicely formatted)
                formatted_messages = []
                for i, msg in enumerate(messages, 1):
                    channel = msg.get("channel", "UNKNOWN")
                    from_addr = msg.get("from", "?")
                    to_addr = msg.get("to", "?")
                    timestamp = msg.get("timestamp", "")
                    content = msg.get("message", "")
                    
                    formatted_messages.append(
                        f"**{i}. [{channel}]** {timestamp}\n"
                        f"   From: `{from_addr}` → To: `{to_addr}`\n"
                        f"   {content}"
                    )
                
                messages_text = "\n\n".join(formatted_messages)

                result_for_format = {
                    "person": person,  # Include full person object
                    "message_count": len(messages),
                    "messages": messages_text
                }
                
                message = format_tool_message(
                    params=tool_call,
                    result=result_for_format,
                    time_elapsed=elapsed_time,
                    cost_cents=0
                )
                
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Found {len(messages)} messages with {person_name}",
                    message=message,
                    status=MessageStatus.FINISHED,
                    metadata=read_metadata
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
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Failed to read message history",
                message=error_message,
                status=MessageStatus.ERROR
            )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[ReadMessageHistoryManager] = None


def get_manager() -> ReadMessageHistoryManager:
    """Get or create read message history manager singleton."""
    global _manager
    if _manager is None:
        _manager = ReadMessageHistoryManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def read_message_history_with_person(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for read_message_history_with_person (event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'phone', 'email', 'first_name', 'last_name'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "read_message_history_with_person")


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def read_message_history_activity(
    user_id: str,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None
) -> Dict[str, Any]:
    """
    Activity: Read message history via backend API.

    Args:
        user_id: User ID for the request
        phone: Phone number (E.164 format)
        email: Email address
        first_name: First name
        last_name: Last name

    Returns:
        Dict with:
            - person: Person info (id, firstName, lastName, phoneNumber, email) or null
            - messages: Array of message records
            - message: Descriptive message if no person/messages found
            - count: Number of messages

    Raises:
        Exception: If API request fails
    """
    try:
        activity.heartbeat("Reading message history...")

        config = load_config()

        # Build request body
        body = {"user_id": user_id}
        if phone:
            body["phone"] = phone
        if email:
            body["email"] = email
        if first_name:
            body["firstName"] = first_name
        if last_name:
            body["lastName"] = last_name

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/people/messages",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "Content-Type": "application/json",
                },
                json=body
            )

            result = response.json()

            if response.status_code != 200:
                error_msg = result.get("error") or f"Backend error ({response.status_code})"
                raise Exception(error_msg)

            logger.info(
                "Message history retrieved",
                person=result.get("person"),
                message_count=result.get("count", 0)
            )

            return result

    except httpx.TimeoutException:
        logger.error("Read message history timeout")
        raise Exception("Request timed out while reading message history")
    except Exception as e:
        logger.error("Read message history failed", error=str(e))
        raise

