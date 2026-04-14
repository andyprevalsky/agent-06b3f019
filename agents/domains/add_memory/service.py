"""add-memory domain service — business logic orchestration."""

from datetime import timedelta
from typing import Any, Dict, Optional

from temporalio import activity
from temporalio.common import RetryPolicy

from domains.add_memory.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    DISPLAY_CONTENT_MAX_LENGTH,
    DISPLAY_CONTENT_TRUNCATION_LENGTH,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_INTERVAL_SECONDS,
)
from domains.add_memory.repo import save_memory_document
from domains.add_memory.types import ExecuteActivityCallable, ToolResult


def truncate_for_display(content: str) -> str:
    """Truncate content for display in tool events."""
    if len(content) <= DISPLAY_CONTENT_MAX_LENGTH:
        return content
    return content[:DISPLAY_CONTENT_TRUNCATION_LENGTH] + "..."


@activity.defn
async def add_memory_activity(content: str, user_id: str) -> Dict[str, Any]:
    """Temporal activity: Store a memory in SuperMemory.

    Args:
        content: The memory content to store.
        user_id: User ID used as containerTag for isolation.

    Returns:
        Dict with document_id, status, and message.
    """
    activity.heartbeat(f"Saving memory: {content[:100]}...")
    result = await save_memory_document(content, user_id)
    # Return as plain dict for Temporal serialization
    return dict(result)


async def execute_add_memory(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    agent_id: str,
    user_id: Optional[str] = None,
) -> ToolResult:
    """Execute the add-memory tool: schedule the activity and return the result.

    Args:
        execute_activity: Callable to schedule Temporal activities.
        tool_call: Tool call parameters (expects "content" key).
        agent_id: Agent ID (unused here, passed for consistency).
        user_id: User ID for memory isolation.

    Returns:
        ToolResult with the memory result and empty usage.
    """
    content = tool_call.get("content", "")

    result = await execute_activity(
        add_memory_activity,
        args=[content, user_id or ""],
        start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
        retry_policy=RetryPolicy(
            maximum_attempts=RETRY_MAX_ATTEMPTS,
            backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
            initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
            maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
        ),
    )

    return ToolResult(result=result, usage={"llm": [], "service": []})
