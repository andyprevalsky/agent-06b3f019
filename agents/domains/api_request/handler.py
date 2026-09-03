"""api_request domain handler."""

from typing import Any, Dict, Optional

from domains.api_request.service import execute_api_request
from domains.api_request.types import ExecuteActivityCallable
from tools.base import ToolManager


class ApiRequestManager(ToolManager):
    """Manager for api_request tool."""

    tool_name = "api_request"
    read_only = True

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await execute_api_request(
            execute_activity=execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )


_manager: Optional[ApiRequestManager] = None


def get_manager() -> ApiRequestManager:
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = ApiRequestManager()
    return _manager


async def api_request(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=kwargs["execute_activity"],
        tool_call=kwargs["tool_call"],
        tool_call_id=kwargs["tool_call_id"],
        agent_id=kwargs["agent_id"],
        user_id=kwargs.get("user_id"),
    )
