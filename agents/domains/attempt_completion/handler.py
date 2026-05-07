"""Attempt-completion domain handler — runtime entry point.

Thin orchestration layer: parses tool_call input, posts tool events,
and delegates to service for the completion result.

Business logic lives in ``domains.attempt_completion.service``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

from domains.attempt_completion.config import EVENT_MESSAGE, EVENT_TITLE, TOOL_NAME
from domains.attempt_completion.service import build_completion_result
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

if TYPE_CHECKING:
    from domains.attempt_completion.types import ExecuteActivityCallable


# =============================================================================
# MANAGER
# =============================================================================


class AttemptCompletionManager(ToolManager):
    """Manager for attempt_completion — universal phase/task completion."""

    tool_name = TOOL_NAME

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Signal that the agent believes its task/phase is complete.

        The workflow/activity runs the verifier after this to confirm.
        If verification passes the loop exits; otherwise the agent continues.

        ``result`` is accepted as an optional final payload for unverified
        loops. It is returned to the caller but never surfaced in the
        user-visible completion event. Verified flows remain machine-checkable:
        the verifier reads prior tool-call results, not this payload.
        """
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=EVENT_TITLE,
                message=EVENT_MESSAGE,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )

        raw_result = tool_call.get("result")
        result = raw_result if isinstance(raw_result, str) else None
        return build_completion_result(result=result)


# =============================================================================
# SINGLETON
# =============================================================================

_manager: Optional[AttemptCompletionManager] = None


def get_manager() -> AttemptCompletionManager:
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = AttemptCompletionManager()
    return _manager


# =============================================================================
# TOOL ENTRY POINT
# =============================================================================


async def attempt_completion(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute attempt_completion tool — thin dispatch to manager."""
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
