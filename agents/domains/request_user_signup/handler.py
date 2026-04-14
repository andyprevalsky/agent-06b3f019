"""Runtime handler for request-user-signup domain.

Entry point: ToolManager subclass + workflow helper function.
Imports: own service, own types, own config, providers (tools.base).
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow

from domains.request_user_signup.config import TOOL_NAME
from domains.request_user_signup.service import (
    build_signup_metadata,
    extract_reason,
    outcome_display,
    resolve_signup_outcome,
)
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

logger = structlog.get_logger()


class RequestUserSignupManager(ToolManager):
    """Manager for requesting user signup from within agent workflow."""

    tool_name = TOOL_NAME
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Request user to sign up.

        Blocks until user signs up or dismisses the prompt.
        """
        reason = extract_reason(tool_call)

        # Emit the signup request message (blocks agent)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Account Required",
            message=reason,
            status=MessageStatus.IN_PROGRESS,
            metadata=build_signup_metadata(reason, is_waiting=True),
        )

        # Wait for user response (signup complete or dismissed)
        try:
            await workflow.wait_condition(
                lambda: (
                    workflow_instance._has_new_messages
                    or workflow_instance._signup_completed
                    or workflow_instance._signup_dismissed
                )
            )

            # Determine outcome and reset flags
            signup_completed = workflow_instance._signup_completed
            signup_dismissed = workflow_instance._signup_dismissed

            workflow_instance._has_new_messages = False
            workflow_instance._signup_completed = False
            workflow_instance._signup_dismissed = False

            outcome = resolve_signup_outcome(
                signup_completed=signup_completed,
                signup_dismissed=signup_dismissed,
            )

            logger.info(
                "Signup prompt resolved",
                outcome=outcome.value,
                agent_id=workflow_instance.agent_id,
            )

            title, message = outcome_display(outcome)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=title,
                message=message,
                status=MessageStatus.FINISHED,
                metadata=build_signup_metadata(reason, is_waiting=False),
            )

        except Exception as e:
            logger.error(f"Error waiting for signup response: {e}")
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Error",
                message=str(e),
                status=MessageStatus.ERROR,
                metadata=build_signup_metadata(reason, is_waiting=False),
            )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[RequestUserSignupManager] = None


def get_manager() -> RequestUserSignupManager:
    """Get or create request_user_signup manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = RequestUserSignupManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================


async def request_user_signup(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> Optional[MessageStatus]:
    """Workflow helper for request_user_signup.

    Displays a signup prompt and blocks until user signs up or dismisses.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, TOOL_NAME)
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
