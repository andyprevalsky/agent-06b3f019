"""Find All domain handler — thin entry point for the workflow helper."""

from __future__ import annotations

from typing import Any

from domains.find_all.service import FindAllManager
from tools.base import MessageStatus, ToolEvent

_manager: FindAllManager | None = None


def get_manager() -> FindAllManager:
    """Get or create the FindAll manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = FindAllManager()
    return _manager


async def find_all(
    workflow_instance: Any,
    tool_call: dict[str, Any],
    tool_call_id: str,
) -> MessageStatus | None:
    """Workflow helper — execute FindAll and forward events to the workflow."""
    manager = get_manager()
    last_status: MessageStatus | None = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "find_all")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        if event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="find_all")

    return last_status
