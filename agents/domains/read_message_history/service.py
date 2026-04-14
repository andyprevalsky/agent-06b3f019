"""Read-message-history business logic layer.

Orchestrates data access and formats results.
Imports: own repo, own types, own config, providers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from domains.read_message_history.config import TOOL_NAME
from domains.read_message_history.repo import fetch_message_history as fetch_message_history
from helpers.handle_tool_event import handle_tool_event
from tools.base import (
    EventType,
    MessageStatus,
    ToolEvent,
    format_error_message,
    format_tool_message,
)

if TYPE_CHECKING:
    from domains.read_message_history.types import (
        ExecuteActivityCallable,
        ReadMetadata,
    )


def build_person_identifier(
    *,
    phone: str | None,
    email: str | None,
    first_name: str | None,
    last_name: str | None,
) -> str:
    """Build a display-friendly person identifier from available fields."""
    has_name = first_name and last_name and str(first_name).strip() and str(last_name).strip()
    has_email = email and str(email).strip()
    has_phone = phone and str(phone).strip()

    if has_name:
        return f"{first_name} {last_name}"
    if has_email:
        return str(email)
    if has_phone:
        return str(phone)
    return "Unknown"


def validate_identifiers(
    *,
    phone: str | None,
    email: str | None,
    first_name: str | None,
    last_name: str | None,
) -> bool:
    """Return True if at least one valid identifier is provided."""
    has_phone = phone and str(phone).strip()
    has_email = email and str(email).strip()
    has_name = first_name and last_name and str(first_name).strip() and str(last_name).strip()
    return bool(has_phone or has_email or has_name)


def build_read_metadata(
    *,
    phone: str | None,
    email: str | None,
    first_name: str | None,
    last_name: str | None,
    person: dict[str, Any] | None,
) -> dict[str, ReadMetadata]:
    """Build metadata dict for tool events (used by message_person for verification)."""
    return {
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


def format_messages_for_display(messages: list[dict[str, Any]]) -> str:
    """Format a list of message records into a human-readable string."""
    formatted: list[str] = []
    for i, msg in enumerate(messages, 1):
        channel = msg.get("channel", "UNKNOWN")
        from_addr = msg.get("from", "?")
        to_addr = msg.get("to", "?")
        timestamp = msg.get("timestamp", "")
        content = msg.get("message", "")
        formatted.append(f"**{i}. [{channel}]** {timestamp}\n   From: `{from_addr}` → To: `{to_addr}`\n   {content}")
    return "\n\n".join(formatted)


async def post_validation_error(
    *,
    agent_id: str,
    tool_call_id: str,
    execute_activity: ExecuteActivityCallable,
    user_id: str | None,
) -> None:
    """Post an error event when no valid identifier is provided."""
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Read message history failed: Missing identifier",
            message="At least one identifier is required: phone, email, or first_name + last_name.",
            status=MessageStatus.ERROR,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name=TOOL_NAME,
        execute_activity=execute_activity,
        user_id=user_id,
    )


async def post_in_progress(
    *,
    person_identifier: str,
    agent_id: str,
    tool_call_id: str,
    execute_activity: ExecuteActivityCallable,
    user_id: str | None,
) -> None:
    """Post an in-progress status event."""
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Reading message history",
            message=f"Looking up messages with **{person_identifier}**...",
            status=MessageStatus.IN_PROGRESS,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name=TOOL_NAME,
        execute_activity=execute_activity,
        user_id=user_id,
    )


async def post_result_event(
    *,
    result: dict[str, Any],
    tool_call: dict[str, Any],
    elapsed_time: float,
    read_metadata: dict[str, Any],
    person_identifier: str,
    agent_id: str,
    tool_call_id: str,
    execute_activity: ExecuteActivityCallable,
    user_id: str | None,
) -> None:
    """Post the appropriate result event based on the API response."""
    messages = result.get("messages", [])
    person = result.get("person")
    no_messages_msg = result.get("message")

    if not person:
        message = format_tool_message(
            params=tool_call,
            result={"message": no_messages_msg or f"No person found matching: {person_identifier}"},
            time_elapsed=elapsed_time,
            cost_cents=0,
        )
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Read message history failed for: {person_identifier}",
                message=message,
                status=MessageStatus.FINISHED,
                metadata=read_metadata,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )
    elif len(messages) == 0:
        person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        message = format_tool_message(
            params=tool_call,
            result={"message": f"No messages present for {person_name}"},
            time_elapsed=elapsed_time,
            cost_cents=0,
        )
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"No messages with {person_name}",
                message=message,
                status=MessageStatus.FINISHED,
                metadata=read_metadata,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )
    else:
        person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        messages_text = format_messages_for_display(messages)
        result_for_format = {
            "person": person,
            "message_count": len(messages),
            "messages": messages_text,
        }
        message = format_tool_message(
            params=tool_call,
            result=result_for_format,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Found {len(messages)} messages with {person_name}",
                message=message,
                status=MessageStatus.FINISHED,
                metadata=read_metadata,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )


async def post_error_event(
    *,
    error: Exception,
    tool_call: dict[str, Any],
    elapsed_time: float,
    agent_id: str,
    tool_call_id: str,
    execute_activity: ExecuteActivityCallable,
    user_id: str | None,
) -> None:
    """Post an error event when the activity fails."""
    error_message = format_error_message(
        params=tool_call,
        error=error,
        time_elapsed=elapsed_time,
        cost_cents=0,
    )
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Failed to read message history",
            message=error_message,
            status=MessageStatus.ERROR,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name=TOOL_NAME,
        execute_activity=execute_activity,
        user_id=user_id,
    )
