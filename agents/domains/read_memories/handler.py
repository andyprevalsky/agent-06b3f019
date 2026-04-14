"""Read Memories domain handler — tool entry point and Temporal activity."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Dict, Optional

from temporalio import activity
from temporalio.common import RetryPolicy

from domains.read_memories.config import (
    ACTIVITY_TIMEOUT_SECS,
    DISPLAY_QUERY_MAX_LEN,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECS,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_INTERVAL_SECS,
)
from domains.read_memories.service import read_memories_for_user
from helpers.handle_tool_event import handle_tool_event

if TYPE_CHECKING:
    from domains.read_memories.types import ExecuteActivityCallable

from tools.base import (
    EventType,
    MessageStatus,
    ToolEvent,
    ToolManager,
    format_error_message,
    format_tool_message,
)


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

        display_query = query if len(query) <= DISPLAY_QUERY_MAX_LEN else query[:97] + "..."

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
                start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECS),
                retry_policy=RetryPolicy(
                    maximum_attempts=RETRY_MAX_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECS),
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


# ── Singleton ──

_manager: Optional[ReadMemoriesManager] = None


def get_manager() -> ReadMemoriesManager:
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = ReadMemoriesManager()
    return _manager


# ── Tool entry point ──


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


# ── Temporal activity ──


@activity.defn
async def read_memories_activity(query: str, user_id: str) -> Dict[str, Any]:
    """Activity: Search and retrieve memories from SuperMemory.

    Uses the /v4/profile endpoint which combines user profile + search in one call.
    If a query is provided, it returns profile + relevant search results.
    If no query, it returns just the user profile (static + dynamic facts).

    Args:
        query: Search query (optional — empty string returns profile only).
        user_id: User ID used as containerTag for isolation.

    Returns:
        Dict with profile data and optional search results.
    """
    activity.heartbeat(f"Reading memories: {query[:100] if query else 'profile only'}...")
    return await read_memories_for_user(query, user_id)
