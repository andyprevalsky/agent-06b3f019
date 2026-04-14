"""Grep domain handler - thin entry point for tool execution."""

from typing import Any, Dict, Optional

from domains.grep.service import execute_grep
from domains.grep.types import ExecuteActivityCallable
from tools.base import ToolManager


class GrepManager(ToolManager):
    """Manager for grep operations over user's local data."""

    tool_name = "grep"
    read_only = True

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute grep search - delegates to service layer."""
        return await execute_grep(
            execute_activity=execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )


# Singleton
_manager: Optional[GrepManager] = None


def get_manager() -> GrepManager:
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = GrepManager()
    return _manager


async def grep(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute grep tool."""
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
