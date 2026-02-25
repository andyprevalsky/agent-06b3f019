"""
Tool for proactively messaging the user from the PLAN phase.

Cases:
1. Clarifications / approvals → block until the user replies (is_question=True)
2. Heads-up / plan visibility → send message and keep working (is_question=False)

SMS Fallback:
- SMS-initiated goals: send SMS immediately for questions
- Web/Mac-initiated: wait 15 min, then send SMS if no response
"""

from typing import Dict, Any, Optional, AsyncGenerator
from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

# Import SMS activities (will be executed via workflow.execute_activity)
with workflow.unsafe.imports_passed_through():
    from helpers.sms_activities import (
        get_agent_source,
        enqueue_sms_question_activity,
        handle_agent_unblocked_activity,
    )

logger = structlog.get_logger()

# Timeout before sending SMS for non-SMS-initiated goals
SMS_FALLBACK_TIMEOUT_MINUTES = 15


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

        When is_question=True we pause until receive_user_response signal arrives.
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

        # Execute phase variant always uses is_question=False
        tool_name = tool_call.get("tool", "send_message_to_user")
        if tool_name == "send_message_to_user_execute_phase":
            is_question = False
        else:
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

        # 2. For sub-agents, auto-respond instead of blocking
        is_sub_agent = getattr(workflow_instance, 'depth', 0) >= 1
        if is_sub_agent:
            logger.info(
                "Sub-agent called send_message_to_user with is_question=True, auto-responding",
                agent_id=workflow_instance.agent_id,
                depth=workflow_instance.depth,
            )
            auto_response = (
                "Please do not ask me anymore questions. I trust your judgment, intuition, "
                "and ability to make reasonable assumptions. Please proceed to the Autonomous Execution phase."
            )
            # Post auto-response as USER message to DB (will be polled on next iteration)
            await workflow_instance._post_message(auto_response, "USER", {"autoResponse": True})
            # Mark tool as finished
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Auto-response (sub-agent)",
                message=message,
                status=MessageStatus.FINISHED,
                metadata=_metadata(is_waiting=False),
            )
            return

        # 3. Get agent source to determine SMS behavior
        agent_source = await workflow.execute_activity(
            get_agent_source,
            args=[workflow_instance.agent_id],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        sms_sent = False

        # 4. Handle SMS fallback based on source
        if agent_source == "SMS":
            # SMS-initiated: send SMS immediately
            logger.info(
                "SMS-initiated goal, sending SMS question immediately",
                agent_id=workflow_instance.agent_id,
            )
            await workflow.execute_activity(
                enqueue_sms_question_activity,
                args=[
                    workflow_instance.user_id,
                    workflow_instance.agent_id,
                    workflow.info().workflow_id,
                    message,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            sms_sent = True
        else:
            # Web/Mac-initiated: wait 15 min, then send SMS if no response
            logger.info(
                "Non-SMS goal, waiting for response with SMS fallback timeout",
                agent_id=workflow_instance.agent_id,
                timeout_minutes=SMS_FALLBACK_TIMEOUT_MINUTES,
            )
            try:
                await workflow.wait_condition(
                    lambda: workflow_instance._has_new_messages,
                    timeout=timedelta(minutes=SMS_FALLBACK_TIMEOUT_MINUTES),
                )
                # User responded within timeout - no need for SMS
                logger.info(
                    "User responded within timeout, no SMS needed",
                    agent_id=workflow_instance.agent_id,
                )
            except TimeoutError:
                # No response within timeout - send SMS
                logger.info(
                    "No response within timeout, sending SMS",
                    agent_id=workflow_instance.agent_id,
                )
                await workflow.execute_activity(
                    enqueue_sms_question_activity,
                    args=[
                        workflow_instance.user_id,
                        workflow_instance.agent_id,
                        workflow.info().workflow_id,
                        message,
                    ],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                sms_sent = True

        # 5. If we haven't received a response yet (SMS path or after timeout), wait indefinitely
        if not workflow_instance._has_new_messages:
            try:
                await workflow.wait_condition(
                    lambda: workflow_instance._has_new_messages
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

        # Reset flag so subsequent waits work correctly
        workflow_instance._has_new_messages = False

        logger.info(
            "User responded to send_message_to_user request",
            agent_id=workflow_instance.agent_id,
            sms_was_sent=sms_sent,
        )

        # 6. Clean up SMS queue state (remove from active/pending)
        if sms_sent:
            await workflow.execute_activity(
                handle_agent_unblocked_activity,
                args=[workflow_instance.user_id, workflow_instance.agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # 7. Success status - mark as finished (frontend will swallow this)
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

async def send_message_to_user(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str):
    """
    Workflow helper for send_message_to_user (lightweight version).

    This is a simple visibility/clarification bridge: it never writes to DB or
    trigger notifications, it only mirrors text into the chat transcript.

    For sub-agents (depth >= 1), auto-responds instead of blocking.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "send_message_to_user")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
