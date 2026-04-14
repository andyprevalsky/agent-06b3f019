"""Send email domain handler - thin entry point.

Delegates to service layer. Registered as tool in the agent workflow.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from tools.base import ToolManager

from .service import execute_send_email

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable


class SendEmailManager(ToolManager):
    """Manager for sending emails via user's connected Gmail account."""

    tool_name = "send_email"

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute email send - delegates to service layer."""
        return await execute_send_email(
            execute_activity=execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )


# ── Singleton ──

_manager: SendEmailManager | None = None


def get_manager() -> SendEmailManager:
    """Get or create send email manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = SendEmailManager()
    return _manager


# ── Tool entry point ──


async def send_email(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """
    Execute send_email tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'to', 'subject', 'body', optional 'cc'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with messageId, threadId, etc.
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
