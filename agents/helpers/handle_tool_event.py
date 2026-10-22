"""
Standalone ToolEvent handler - works in both workflow and activity contexts.

Handles FE state changes:
- POST_MESSAGE → post to DB via post_agent_message activity
- STREAM_MESSAGE → broadcast to Supabase Realtime (no DB write)

Usage tracking is handled by workflow._track_usage() - tools return standardized usage dicts.
"""

from datetime import timedelta
from typing import Any, Awaitable, Callable, Optional

import structlog

# All imports at module level - no inline imports to avoid workflow sandbox issues
from temporalio.common import RetryPolicy

from helpers.messages import post_agent_message, stream_assistant_chunk
from tools.base import AssistantEvent, EventType

logger = structlog.get_logger()

# Type alias for execute_activity callable (either workflow.execute_activity or call_temporal_activity_from_activity)
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


async def handle_tool_event(
    event,  # ToolEvent - type hint omitted to avoid circular import
    agent_id: str,
    tool_call_id: str,
    tool_name: str,
    execute_activity: ExecuteActivityCallable,  # workflow.execute_activity or call_temporal_activity_from_activity
    user_id: Optional[str] = None,  # Required for USAGE events with SERVICE type
    sub_agent_id: Optional[str] = None,  # For routing browser agent events
):
    """
    Handle a ToolEvent or AssistantEvent - routes to appropriate FE/DB updates.

    Args:
        event: ToolEvent or AssistantEvent instance
        agent_id: Agent ID for DB updates
        tool_call_id: Unique ID for this tool call
        tool_name: Name of the tool
        execute_activity: Callable to execute activities (workflow.execute_activity or call_temporal_activity_from_activity)
        user_id: User ID (required for ToolUsage inserts)
        sub_agent_id: Optional sub-agent ID for routing (browser agent)
    """
    # Handle AssistantEvent separately - posts as ASSISTANT role
    if isinstance(event, AssistantEvent):
        # Output files from a child are transcript artifacts, not a new parent
        # assistant turn. Keep their established role/file pointer for the UI,
        # while giving realtime readers an explicit way to distinguish them.
        artifact_metadata = (
            {"artifactOnly": True, "sourceToolCallId": tool_call_id}
            if event.file_pointer and not event.message
            else None
        )
        await execute_activity(
            post_agent_message,
            args=[agent_id, event.message or "", "ASSISTANT", artifact_metadata, event.file_pointer],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        return

    # Handle ToolEvent types
    if event.type == EventType.POST_MESSAGE:
        # Build metadata - merge event metadata with standard tool fields
        metadata = {
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "toolStatus": event.status.value if event.status else "IN_PROGRESS",
            "title": event.title or tool_name,
        }

        # Add sub_agent_id for routing if provided
        if sub_agent_id:
            metadata["subAgentId"] = sub_agent_id

        # Merge any custom metadata from the event
        if event.metadata:
            metadata.update(event.metadata)

        # Include structured data (e.g., plan tasks) in metadata for FE
        if event.data:
            metadata["data"] = event.data

        # Get file_pointer if present (for file attachment messages)
        file_pointer = getattr(event, "file_pointer", None)

        await execute_activity(
            post_agent_message,
            args=[agent_id, event.message or "", "TOOL", metadata, file_pointer],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

    elif event.type == EventType.STREAM_MESSAGE:
        # Stream chunks to Supabase Realtime (NOT an activity - direct HTTP call)
        # Works the same in both workflow and activity contexts
        await stream_assistant_chunk(
            agent_id=agent_id,
            stream_id=event.stream_id or "",
            delta=event.delta or "",
            done=event.done or False,
            sequence=event.sequence or 0,
            sub_agent_id=sub_agent_id or event.sub_agent_id,
            llm_started_at_ms=event.llm_started_at_ms,
        )
