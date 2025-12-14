"""
Tool for proactively messaging the user from the PLAN phase.

Cases:
1. Clarifications / approvals → block until the user replies (is_question=True)
2. Heads-up / plan visibility → send message and keep working (is_question=False)
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()


class SendMessageToUserManager(ToolManager):
    """Manager for lightweight user notifications/clarifications (no DB writes)."""

    tool_name = "send_message_to_user"
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Communicate with the user from the PLAN phase.

        When is_question=True we pause until the next USER reply appears in context.
        When is_question=False we simply surface the message for visibility.
        """
        message = tool_call.get("message")
        if not isinstance(message, str) or not message.strip():
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing message",
                message="send_message_to_user requires a non-empty `message` string describing what the user needs to know.",
                status=MessageStatus.ERROR,
            )
            return

        is_question = tool_call.get("is_question", True)
        if not isinstance(is_question, bool):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid is_question",
                message="`is_question` must be a boolean. Use true to block for a response, false to send an FYI.",
                status=MessageStatus.ERROR,
            )
            return

        message = message.strip()

        def _metadata(is_waiting: bool) -> Dict[str, Any]:
            """Shared metadata for attention rendering."""
            return {
                "isUserAttentionMessage": True,
                "attentionMessage": message,
                "sendMessageToUser": {
                    "isQuestion": is_question,
                    "attentionKind": "question" if is_question else "info",
                    "isWaitingForUser": is_waiting,
                },
            }

        # 1. Emit the attention/info message. Non-blocking messages instantly finish.
        initial_status = MessageStatus.IN_PROGRESS if is_question else MessageStatus.FINISHED
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Attn: User" if is_question else "FYI for User",
            message=message,
            status=initial_status,
            metadata=_metadata(is_waiting=is_question),
        )

        if not is_question:
            # No blocking required - informative ping only.
            return

        # 2. Wait for user message to appear in context
        try:
            await workflow.wait_condition(
                lambda: (
                    len(workflow_instance.context) > 0 and
                    workflow_instance.context[-1].get("role") == "USER"
                )
            )

            logger.info(
                "User responded to send_message_to_user request",
                agent_id=workflow_instance.agent_id
            )

        except Exception as e:
            logger.error(f"Error waiting for user response: {e}")
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Error waiting for response",
                message=str(e),
                status=MessageStatus.ERROR,
                metadata=_metadata(is_waiting=True),
            )
            return

        # 3. Success status - mark as finished (frontend will swallow this)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="User response received",
            message=message,
            status=MessageStatus.FINISHED,
            metadata=_metadata(is_waiting=False),
        )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SendMessageToUserManager] = None


def get_manager() -> SendMessageToUserManager:
    """Get or create send_message_to_user manager singleton."""
    global _manager
    if _manager is None:
        _manager = SendMessageToUserManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def send_message_to_user(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str) -> None:
    """
    Workflow helper for send_message_to_user (lightweight version).

    This is a simple visibility/clarification bridge: it never writes to DB or
    trigger notifications, it only mirrors text into the chat transcript.
    """
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "send_message_to_user")
