"""Business logic for the search-user-network domain."""

import time
from typing import Any, Dict, List, Optional

import structlog
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message

from .config import (
    ACTIVITY_TIMEOUT,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_INTERVAL,
    TITLE_MAX_LENGTH,
    TOOL_NAME,
)
from .types import ExecuteActivityCallable

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def build_display_title(tool_call: Dict[str, Any]) -> str:
    """Build display title from search criteria."""
    first_name = tool_call.get("first_name") or ""
    last_name = tool_call.get("last_name") or ""
    full_name = f"{first_name} {last_name}".strip()
    title_name = full_name if full_name else "contacts"
    if len(title_name) > TITLE_MAX_LENGTH:
        title_name = title_name[: TITLE_MAX_LENGTH - 3] + "..."
    return title_name


def format_search_criteria(tool_call: Dict[str, Any]) -> str:
    """Format search criteria for display in pre-message."""
    parts: List[str] = []

    first_name = tool_call.get("first_name", "")
    last_name = tool_call.get("last_name", "")
    if first_name or last_name:
        parts.append(f"Name: {first_name} {last_name}".strip())

    field_labels = [
        ("profession", "Profession"),
        ("company", "Company"),
        ("title", "Title"),
        ("industry", "Industry"),
        ("location", "Location"),
        ("relation", "Relationship"),
    ]
    for key, label in field_labels:
        if tool_call.get(key):
            parts.append(f"{label}: {tool_call[key]}")

    if tool_call.get("skills"):
        skills = tool_call["skills"]
        if isinstance(skills, list):
            parts.append(f"Skills: {', '.join(skills[:5])}")

    return "\n".join(parts) if parts else "Searching all contacts..."


async def execute_search(
    execute_activity: ExecuteActivityCallable,
    activity_fn: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute network search: post events and call the activity.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        activity_fn: The Temporal activity function to invoke
        tool_call: Tool call dict with person signals
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for search scope

    Returns:
        Result dict with search results.
    """
    title_name = build_display_title(tool_call)
    start_time = _safe_time()

    # Pre-execution status
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\U0001f50d Searching network for {title_name}",
            message=format_search_criteria(tool_call),
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": 0},
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name=TOOL_NAME,
        execute_activity=execute_activity,
        user_id=user_id,
    )

    try:
        logger.info(
            "Calling search_user_network_activity",
            user_id=user_id,
            first_name=tool_call.get("first_name") or "",
            last_name=tool_call.get("last_name") or "",
        )

        result = await execute_activity(
            activity_fn,
            args=[user_id, tool_call],
            start_to_close_timeout=ACTIVITY_TIMEOUT,
            retry_policy=RetryPolicy(
                maximum_attempts=RETRY_MAX_ATTEMPTS,
                backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                initial_interval=RETRY_INITIAL_INTERVAL,
                maximum_interval=RETRY_MAX_INTERVAL,
            ),
        )

        elapsed_time = _safe_time() - start_time
        total_cost_cents = 0

        message = format_tool_message(
            params=tool_call,
            result=result,
            time_elapsed=elapsed_time,
            cost_cents=total_cost_cents,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Network search completed: {title_name}",
                message=message,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return result

    except Exception as e:
        elapsed_time = _safe_time() - start_time

        error_message = format_error_message(
            params=tool_call,
            error=e,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"\u274c Network search failed: {title_name}",
                message=error_message,
                status=MessageStatus.ERROR,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {"error": str(e), "results": [], "count": 0}
