"""Handler (runtime) for the send-message-to-user domain.

Thin entry point: parse input -> call service -> emit events.

Cases:
1. Clarifications / approvals -> block until the user replies (is_question=True)
2. Heads-up / plan visibility -> send message and keep working (is_question=False)

When is_question=True:
- SMS-initiated goals: sends SMS immediately
- Web/Mac-initiated: waits 15 min, then sends SMS if no response
- Blocks until the user responds (via web chat or SMS supervisor reply_to_agent)
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.send_message_to_user.config import SMS_FALLBACK_TIMEOUT_MINUTES, SUB_AGENT_AUTO_RESPONSE
from domains.send_message_to_user.service import is_sub_agent, validate_tool_call
from domains.send_message_to_user.types import build_attention_metadata
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

# Import activities (executed via workflow.execute_activity)
with workflow.unsafe.imports_passed_through():
    from helpers.sms_activities import (
        get_agent_source,
        notify_sms_event_activity,
    )

logger = structlog.get_logger()


class SendMessageToUserManager(ToolManager):
    """Manager for lightweight user notifications/clarifications."""

    tool_name = "send_message_to_user"
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance: object,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Communicate with the user from the PLAN phase.

        When is_question=True we pause until receive_user_response signal arrives.
        When is_question=False we simply surface the message for visibility.
        """
        # ── 0. Validate ──
        result = validate_tool_call(tool_call)
        if not result["ok"]:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing message" if "non-empty" in result["message"] else "❌ Invalid is_question",
                message=result["message"],
                status=MessageStatus.ERROR,
            )
            return

        message: str = result["message"]
        is_question: bool = result["is_question"]

        # ── 1. Emit attention / info event ──
        initial_status = MessageStatus.IN_PROGRESS if is_question else MessageStatus.FINISHED
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Attn: User" if is_question else "FYI for User",
            message=message,
            status=initial_status,
            metadata=build_attention_metadata(message, is_question, is_waiting=is_question),
        )

        if not is_question:
            return

        # ── 2. Sub-agent auto-respond ──
        if is_sub_agent(workflow_instance):
            logger.info(
                "Sub-agent called send_message_to_user with is_question=True, auto-responding",
                agent_id=workflow_instance.agent_id,  # type: ignore[union-attr]
                depth=workflow_instance.depth,  # type: ignore[union-attr]
            )
            await workflow_instance._post_message(  # type: ignore[union-attr]
                SUB_AGENT_AUTO_RESPONSE, "USER", {"autoResponse": True}
            )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Auto-response (sub-agent)",
                message=message,
                status=MessageStatus.FINISHED,
                metadata=build_attention_metadata(message, is_question, is_waiting=False),
            )
            return

        # ── 3. Get agent source ──
        agent_source = await workflow.execute_activity(
            get_agent_source,
            args=[workflow_instance.agent_id],  # type: ignore[union-attr]
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        sms_sent = False

        # ── 4. SMS notification ──
        if agent_source == "SMS":
            logger.info(
                "SMS-initiated goal, sending SMS question immediately",
                agent_id=workflow_instance.agent_id,  # type: ignore[union-attr]
            )
            try:
                await workflow.execute_activity(
                    notify_sms_event_activity,
                    args=[
                        workflow_instance.user_id,  # type: ignore[union-attr]
                        "planner_message",
                        workflow_instance.agent_id,  # type: ignore[union-attr]
                        {"message": message, "is_question": True},
                    ],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                sms_sent = True
            except Exception as e:
                logger.error("Failed to send SMS question: %s", e)
        else:
            logger.info(
                "Non-SMS goal, waiting for response with SMS fallback timeout",
                agent_id=workflow_instance.agent_id,  # type: ignore[union-attr]
                timeout_minutes=SMS_FALLBACK_TIMEOUT_MINUTES,
            )
            try:
                await workflow.wait_condition(
                    lambda: workflow_instance._has_new_messages,  # type: ignore[union-attr]
                    timeout=timedelta(minutes=SMS_FALLBACK_TIMEOUT_MINUTES),
                )
                logger.info(
                    "User responded within timeout, no SMS needed",
                    agent_id=workflow_instance.agent_id,  # type: ignore[union-attr]
                )
            except TimeoutError:
                logger.info(
                    "No response within timeout, sending SMS",
                    agent_id=workflow_instance.agent_id,  # type: ignore[union-attr]
                )
                try:
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=[
                            workflow_instance.user_id,  # type: ignore[union-attr]
                            "planner_message",
                            workflow_instance.agent_id,  # type: ignore[union-attr]
                            {"message": message, "is_question": True},
                        ],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                    sms_sent = True
                except Exception as e:
                    logger.error("Failed to send SMS fallback: %s", e)

        # ── 5. Wait for user response ──
        if not workflow_instance._has_new_messages:  # type: ignore[union-attr]
            try:
                await workflow.wait_condition(
                    lambda: workflow_instance._has_new_messages  # type: ignore[union-attr]
                )
            except Exception as e:
                logger.error("Error waiting for user response: %s", e)
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Error waiting for response",
                    message=str(e),
                    status=MessageStatus.ERROR,
                    metadata=build_attention_metadata(message, is_question, is_waiting=True),
                )
                return

        workflow_instance._has_new_messages = False  # type: ignore[union-attr]

        logger.info(
            "User responded to send_message_to_user request",
            agent_id=workflow_instance.agent_id,  # type: ignore[union-attr]
            sms_was_sent=sms_sent,
        )

        # ── 6. Done ──
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="User response received",
            message=message,
            status=MessageStatus.FINISHED,
            metadata=build_attention_metadata(message, is_question, is_waiting=False),
        )


# ── Singleton ──

_manager: Optional[SendMessageToUserManager] = None


def get_manager() -> SendMessageToUserManager:
    """Get or create send_message_to_user manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = SendMessageToUserManager()
    return _manager


# ── Workflow helper ──


async def send_message_to_user(
    workflow_instance: object,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> MessageStatus | None:
    """Workflow helper for send_message_to_user.

    For sub-agents (depth >= 1), auto-responds instead of blocking.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "send_message_to_user")  # type: ignore[union-attr]
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
