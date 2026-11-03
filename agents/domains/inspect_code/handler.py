"""Inspect-code domain handler - thin entry point for tool execution."""

from typing import Any, Dict, Optional

from tools.base import ToolManager

from .service import execute_inspect_code
from .types import TOOL_NAME, ExecuteActivityCallable


class InspectCodeManager(ToolManager):
    """Ask a short-lived read-only code agent about a code session's latest checkpoint."""

    tool_name = TOOL_NAME
    read_only = True

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await execute_inspect_code(
            execute_activity=execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )


_MANAGER = InspectCodeManager()


def get_manager() -> InspectCodeManager:
    return _MANAGER
