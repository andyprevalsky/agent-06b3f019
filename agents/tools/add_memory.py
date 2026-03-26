"""Add Memory tool - stores information in SuperMemory for cross-agent persistence.

Saves memories that persist across all agents for a given user.
Uses SuperMemory's document API with user_id as containerTag for isolation.
"""

import time
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


class AddMemoryManager(ToolManager):
    """Manager for adding memories to SuperMemory."""

    tool_name = "add_memory"
    read_only = False

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        content = tool_call.get("content", "")

        start_time = _safe_time()

        display_content = content if len(content) <= 100 else content[:97] + "..."

        # Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Saving memory",
                message=f"Content: {display_content}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="add_memory",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            result = await execute_activity(
                add_memory_activity,
                args=[content, user_id or ""],
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
                    title="Memory saved",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="add_memory",
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
                    title="Failed to save memory",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="add_memory",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[AddMemoryManager] = None


def get_manager() -> AddMemoryManager:
    global _manager
    if _manager is None:
        _manager = AddMemoryManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def add_memory(
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
async def add_memory_activity(content: str, user_id: str) -> Dict[str, Any]:
    """Activity: Store a memory in SuperMemory.

    Args:
        content: The memory content to store
        user_id: User ID used as containerTag for isolation

    Returns:
        Dict with document id and status
    """
    import os

    activity.heartbeat(f"Saving memory: {content[:100]}...")

    api_key = os.getenv("SUPERMEMORY_API_KEY", "")
    if not api_key:
        raise ValueError("SUPERMEMORY_API_KEY not configured")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.supermemory.ai/v3/documents",
            headers={
                "x-supermemory-api-key": api_key,
                "Content-Type": "application/json",
            },
            json={
                "content": content,
                "containerTag": user_id,
            },
        )
        response.raise_for_status()
        data = response.json()

    logger.info(
        "Memory saved to SuperMemory",
        document_id=data.get("id"),
        user_id=user_id,
        content_length=len(content),
    )

    return {
        "document_id": data.get("id"),
        "status": data.get("status", "queued"),
        "message": "Memory saved successfully",
    }
