"""Grep domain handler - thin entry point for tool execution."""

from typing import Any, Dict, Optional

from domains.grep.service import execute_grep, execute_grep_with_workflow
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


async def grep(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    """Execute grep tool.

    Supports both the newer activity-style call signature and the workflow-aware
    legacy dispatcher signature `(workflow_instance, tool_call, tool_call_id)`.
    The latter is used by AgentWorkflow so source gates can pause/resume.
    """
    if args and hasattr(args[0], "_handle_tool_event"):
        workflow_instance = args[0]
        tool_call = args[1]
        tool_call_id = args[2]
        return await execute_grep_with_workflow(workflow_instance, tool_call, tool_call_id)

    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=kwargs["execute_activity"],
        tool_call=kwargs["tool_call"],
        tool_call_id=kwargs["tool_call_id"],
        agent_id=kwargs["agent_id"],
        user_id=kwargs.get("user_id"),
    )
