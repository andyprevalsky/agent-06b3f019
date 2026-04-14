"""Check monitor events domain handler.

Thin entry point: parse input, call service, return output.
Imports: own service, own types.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

from .service import get_manager

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable


async def check_monitor_events(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute check_monitor_events tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
        tool_call: Tool call dict with 'monitor_id', 'limit'.
        tool_call_id: Unique ID for this tool call.
        agent_id: Agent ID for event routing.
        user_id: User ID for usage tracking.

    Returns:
        Result dict with events.
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
