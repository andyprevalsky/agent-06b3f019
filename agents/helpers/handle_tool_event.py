"""
Standalone ToolEvent handler - works in both workflow and activity contexts.

All FE state changes flow through this single function:
- POST_MESSAGE → post to DB via post_agent_message activity
- STREAM_MESSAGE → broadcast to Supabase Realtime (no DB write)
- USAGE → route to appropriate DB update (LLM tokens vs tool costs)
"""

from datetime import timedelta
from typing import Optional, Callable, Awaitable, Any
import structlog

# All imports at module level - no inline imports to avoid workflow sandbox issues
from temporalio.common import RetryPolicy
from tools.base import EventType, UsageType
from helpers.messages import post_agent_message, stream_assistant_chunk
from helpers.update_tokens import update_agent_tokens_activity
from helpers.save_tool_usage import save_tool_usage

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
    Handle a ToolEvent - routes to appropriate FE/DB updates.
    
    Args:
        event: ToolEvent instance
        agent_id: Agent ID for DB updates
        tool_call_id: Unique ID for this tool call
        tool_name: Name of the tool
        execute_activity: Callable to execute activities (workflow.execute_activity or call_temporal_activity_from_activity)
        user_id: User ID (required for ToolUsage inserts)
        sub_agent_id: Optional sub-agent ID for routing (browser agent)
    """
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
        
        await execute_activity(
            post_agent_message,
            args=[agent_id, event.message or "", "TOOL", metadata],
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
        )
    
    elif event.type == EventType.USAGE:
        if not event.usage_items:
            return
        
        for item in event.usage_items:
            if item.type == UsageType.LLM:
                # LLM tokens → atomic update Agent.tokensIn/tokensOut/tokenCount
                # Use split tokens if available, otherwise fall back to number_of_tokens for tokens_in
                t_in = item.tokens_in if item.tokens_in is not None else (item.number_of_tokens or 0)
                t_out = item.tokens_out if item.tokens_out is not None else 0
                await _update_agent_tokens(
                    agent_id=agent_id,
                    tokens_in=t_in,
                    tokens_out=t_out,
                    execute_activity=execute_activity,
                )
            elif item.type == UsageType.SERVICE:
                # Tool costs → insert into ToolUsage table
                if not user_id:
                    logger.warning(f"USAGE event missing user_id for SERVICE type: {tool_name}")
                    continue
                
                await _save_tool_usage(
                    agent_id=agent_id,
                    user_id=user_id,
                    tool_name=event.tool_name or tool_name,
                    cost_cents=item.cost_cents,
                    usage_items=[item],
                    execute_activity=execute_activity,
                )


async def _update_agent_tokens(
    agent_id: str,
    tokens_in: int,
    tokens_out: int,
    execute_activity: ExecuteActivityCallable,
):
    """Atomically update Agent token counts in DB."""
    await execute_activity(
        update_agent_tokens_activity,
        args=[agent_id, tokens_in, tokens_out],
        start_to_close_timeout=timedelta(seconds=15),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )


async def _save_tool_usage(
    agent_id: str,
    user_id: str,
    tool_name: str,
    cost_cents: int,
    usage_items: list,
    execute_activity: ExecuteActivityCallable,
):
    """Save tool usage to ToolUsage table."""
    # Convert usage items to dicts for JSON serialization
    usage_items_dicts = [
        item.to_dict() if hasattr(item, 'to_dict') else {
            "type": item.type.value if hasattr(item.type, 'value') else str(item.type),
            "cost_cents": item.cost_cents,
            "provider": item.provider,
        }
        for item in usage_items
    ]
    
    await execute_activity(
        save_tool_usage,
        args=[agent_id, user_id, tool_name, cost_cents, usage_items_dicts],
        start_to_close_timeout=timedelta(seconds=15),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )
