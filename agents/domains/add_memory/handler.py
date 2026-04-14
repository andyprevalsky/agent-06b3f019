"""add-memory domain handler — thin tool entry point.

Parses input, delegates to service, emits tool events for UI updates.
"""

import time
from typing import Any, Dict, Optional

from domains.add_memory.service import execute_add_memory, truncate_for_display
from domains.add_memory.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message


def _safe_time() -> float:
    """Return current time, falling back to 0.0 on failure (Temporal sandbox safety)."""
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
        display_content = truncate_for_display(content)

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
            tool_result = await execute_add_memory(
                execute_activity=execute_activity,
                tool_call=tool_call,
                agent_id=agent_id,
                user_id=user_id,
            )

            elapsed_time = _safe_time() - start_time

            message = format_tool_message(
                params=tool_call,
                result=tool_result["result"],
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

            return dict(tool_result)

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
    global _manager  # noqa: PLW0603
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
