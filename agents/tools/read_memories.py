"""Read Memories tool - retrieves memories from SuperMemory for the explore agent.

Searches the user's stored memories and profile to provide context for research.
Uses SuperMemory's search and profile APIs with user_id as containerTag.
"""

import time
import json
from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event

ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


def _safe_time() -> float:
    try:
        return time.time()
    except Exception:
        return 0.0


class ReadMemoriesManager(ToolManager):
    """Manager for reading memories from SuperMemory."""

    tool_name = "read_memories"
    read_only = True

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        query = tool_call.get("query", "")

        start_time = _safe_time()

        display_query = query if len(query) <= 100 else query[:97] + "..."

        # Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Reading memories",
                message=f"Query: {display_query}" if query else "Fetching user profile and memories",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="read_memories",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            result = await execute_activity(
                read_memories_activity,
                args=[query, user_id or ""],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )

            elapsed_time = _safe_time() - start_time

            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Memories retrieved",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="read_memories",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {"result": result, "usage": {"llm": [], "service": []}}

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
                    title="Failed to read memories",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="read_memories",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[ReadMemoriesManager] = None


def get_manager() -> ReadMemoriesManager:
    global _manager
    if _manager is None:
        _manager = ReadMemoriesManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def read_memories(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
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
async def read_memories_activity(query: str, user_id: str) -> Dict[str, Any]:
    """Activity: Search and retrieve memories from SuperMemory.

    Uses the /v4/profile endpoint which combines user profile + search in one call.
    If a query is provided, it returns profile + relevant search results.
    If no query, it returns just the user profile (static + dynamic facts).

    Args:
        query: Search query (optional - empty string returns profile only)
        user_id: User ID used as containerTag for isolation

    Returns:
        Dict with profile data and optional search results
    """
    import os

    activity.heartbeat(f"Reading memories: {query[:100] if query else 'profile only'}...")

    api_key = os.getenv("SUPERMEMORY_API_KEY", "")
    if not api_key:
        raise ValueError("SUPERMEMORY_API_KEY not configured")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Use /v4/profile which combines profile + search in one call
        payload: Dict[str, Any] = {"containerTag": user_id}
        if query:
            payload["q"] = query

        response = await client.post(
            "https://api.supermemory.ai/v4/profile",
            headers={
                "x-supermemory-api-key": api_key,
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    # Format the response for the agent
    result: Dict[str, Any] = {}

    # Extract profile if present
    if "profile" in data:
        result["profile"] = data["profile"]

    # Extract search results if present
    if "results" in data:
        result["memories"] = data["results"]

    # If the response structure is different, include raw data
    if not result:
        result = data

    logger.info(
        "Memories retrieved from SuperMemory",
        user_id=user_id,
        query=query[:100] if query else "profile_only",
        has_profile="profile" in result,
        memory_count=len(result.get("memories", [])),
    )

    return result
