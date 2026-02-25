"""
Tool for requesting user signup when agent needs authenticated user actions.

Displays a signup prompt UI and BLOCKS the agent until:
1. User signs up (success)
2. User dismisses the prompt (continue as anonymous)
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()


class RequestUserSignupManager(ToolManager):
    """Manager for requesting user signup from within agent workflow."""

    tool_name = "request_user_signup"
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Request user to sign up.

        Blocks until user signs up or dismisses the prompt.
        """
        reason = tool_call.get("reason", "This action requires a signed-in account.")

        def _metadata(is_waiting: bool) -> Dict[str, Any]:
            """Build metadata for frontend rendering."""
            return {
                "isUserAttentionMessage": True,
                "attentionMessage": reason,
                "requestUserSignup": {
                    "isWaitingForUser": is_waiting,
                    "attentionKind": "signup",
                },
            }

        # Emit the signup request message (blocks agent)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Account Required",
            message=reason,
            status=MessageStatus.IN_PROGRESS,
            metadata=_metadata(is_waiting=True),
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

            if signup_completed:
                logger.info(
                    "User completed signup",
                    agent_id=workflow_instance.agent_id
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Signup Complete",
                    message="User has signed up. Continuing...",
                    status=MessageStatus.FINISHED,
                    metadata=_metadata(is_waiting=False),
                )
            elif signup_dismissed:
                logger.info(
                    "User dismissed signup prompt",
                    agent_id=workflow_instance.agent_id
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Signup Skipped",
                    message="Continuing as anonymous user.",
                    status=MessageStatus.FINISHED,
                    metadata=_metadata(is_waiting=False),
                )
            else:
                # User sent a message instead - treat as continue
                logger.info(
                    "User responded with message instead of signup action",
                    agent_id=workflow_instance.agent_id
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Continuing",
                    message="Continuing with current session.",
                    status=MessageStatus.FINISHED,
                    metadata=_metadata(is_waiting=False),
                )

        except Exception as e:
            logger.error(f"Error waiting for signup response: {e}")
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Error",
                message=str(e),
                status=MessageStatus.ERROR,
                metadata=_metadata(is_waiting=False),
            )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[RequestUserSignupManager] = None


def get_manager() -> RequestUserSignupManager:
    """Get or create request_user_signup manager singleton."""
    global _manager
    if _manager is None:
        _manager = RequestUserSignupManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def request_user_signup(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for request_user_signup.

    Displays a signup prompt and blocks until user signs up or dismisses.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "request_user_signup")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
