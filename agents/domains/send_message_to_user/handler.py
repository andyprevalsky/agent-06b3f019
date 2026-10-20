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
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

from domains.send_message_to_user.config import SMS_FALLBACK_TIMEOUT_MINUTES, SUB_AGENT_AUTO_RESPONSE
from domains.send_message_to_user.service import (
    is_sub_agent,
    validate_inline_view,
    validate_tool_call,
)
from domains.send_message_to_user.types import build_attention_metadata
from helpers.generation_handoff import (
    DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    GenerationHandoffRequested,
)
from helpers.wait_condition_or_handoff import wait_condition_or_generation_handoff
from helpers.wmh_activity_policy import wmh_activity_timeout_options
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from utils.llm_timeouts import SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS
from utils.rose_desktop import is_rose_desktop_user

# Import activities (executed via workflow.execute_activity)
with workflow.unsafe.imports_passed_through():
    from helpers.sms_activities import (
        get_agent_source,
        notify_sms_event_activity,
    )
    from helpers.user_ui_activities import resolve_user_ui_inline_view_activity

logger = structlog.get_logger()


class SendMessageToUserManager(ToolManager):
    """Manager for lightweight user notifications/clarifications."""

    tool_name = "send_message_to_user"
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance: Any,
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

        # ── 0b. Optional inline view, pinned to the user's ACTIVE published UI ──
        inline_view, inline_error = await _resolve_inline_view(workflow_instance, tool_call.get("inline_view"))
        if inline_error is not None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid inline view",
                message=inline_error,
                status=MessageStatus.ERROR,
            )
            return

        # ── 1. Emit attention / info event ──
        initial_status = MessageStatus.IN_PROGRESS if is_question else MessageStatus.FINISHED
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Attn: User" if is_question else "FYI for User",
            message=message,
            status=initial_status,
            metadata=build_attention_metadata(message, is_question, is_waiting=is_question, inline_view=inline_view),
        )

        if not is_question:
            return

        # ── 2. Sub-agent auto-respond ──
        if is_sub_agent(workflow_instance):
            logger.info(
                "Sub-agent called send_message_to_user with is_question=True, auto-responding",
                agent_id=workflow_instance.agent_id,
                depth=workflow_instance.depth,
            )
            await workflow_instance._post_message(SUB_AGENT_AUTO_RESPONSE, "USER", {"autoResponse": True})
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Auto-response (sub-agent)",
                message=message,
                status=MessageStatus.FINISHED,
                metadata=build_attention_metadata(message, is_question, is_waiting=False, inline_view=inline_view),
            )
            return

        # ── 3. Get agent source ──
        agent_source = await workflow.execute_activity(
            get_agent_source,
            args=[workflow_instance.agent_id],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        sms_sent = False

        # ── 4. SMS notification ──
        if agent_source == "SMS":
            logger.info(
                "SMS-initiated goal, sending SMS question immediately",
                agent_id=workflow_instance.agent_id,
            )
            try:
                notification_args = [
                    workflow_instance.user_id,
                    "planner_message",
                    workflow_instance.agent_id,
                    {"message": message, "is_question": True},
                ]
                world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
                if world_model_mode != "real":
                    notification_args.append(world_model_mode)
                await workflow.execute_activity(
                    notify_sms_event_activity,
                    args=notification_args,
                    **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS)),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                sms_sent = True
            except Exception as e:
                logger.error("Failed to send SMS question: %s", e)
        else:
            logger.info(
                "Non-SMS goal, waiting for response with SMS fallback timeout",
                agent_id=workflow_instance.agent_id,
                timeout_minutes=SMS_FALLBACK_TIMEOUT_MINUTES,
            )
            try:
                await wait_condition_or_generation_handoff(
                    lambda: workflow_instance._has_new_messages,
                    workflow_instance,
                    timeout=timedelta(minutes=SMS_FALLBACK_TIMEOUT_MINUTES),
                    workflow_mod=workflow,
                )
                logger.info(
                    "User responded within timeout, no SMS needed",
                    agent_id=workflow_instance.agent_id,
                )
            except GenerationHandoffRequested:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Waiting for reply",
                    message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    status=MessageStatus.FINISHED,
                    metadata=build_attention_metadata(message, is_question, is_waiting=True, inline_view=inline_view),
                )
                raise
            except (TimeoutError, TemporalTimeoutError):
                logger.info(
                    "No response within timeout, sending SMS",
                    agent_id=workflow_instance.agent_id,
                )
                try:
                    notification_args = [
                        workflow_instance.user_id,
                        "planner_message",
                        workflow_instance.agent_id,
                        {"message": message, "is_question": True},
                    ]
                    world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
                    if world_model_mode != "real":
                        notification_args.append(world_model_mode)
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=notification_args,
                        **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS)),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                    sms_sent = True
                except Exception as e:
                    logger.error("Failed to send SMS fallback: %s", e)

        # ── 5. Wait for user response ──
        if not workflow_instance._has_new_messages:
            try:
                await wait_condition_or_generation_handoff(
                    lambda: workflow_instance._has_new_messages,
                    workflow_instance,
                    workflow_mod=workflow,
                )
            except GenerationHandoffRequested:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Waiting for reply",
                    message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    status=MessageStatus.FINISHED,
                    metadata=build_attention_metadata(message, is_question, is_waiting=True, inline_view=inline_view),
                )
                raise
            except Exception as e:
                logger.error("Error waiting for user response: %s", e)
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Error waiting for response",
                    message=str(e),
                    status=MessageStatus.ERROR,
                    metadata=build_attention_metadata(message, is_question, is_waiting=True, inline_view=inline_view),
                )
                return

        workflow_instance._has_new_messages = False

        logger.info(
            "User responded to send_message_to_user request",
            agent_id=workflow_instance.agent_id,
            sms_was_sent=sms_sent,
        )

        # ── 6. Done ──
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="User response received",
            message=message,
            status=MessageStatus.FINISHED,
            metadata=build_attention_metadata(message, is_question, is_waiting=False, inline_view=inline_view),
        )


async def _resolve_inline_view(
    workflow_instance: Any, raw: Any
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate `inline_view` and pin it to the user's active published version.

    Inline views are a Rose Desktop feature (utils.rose_desktop): for every other
    account the argument is ignored, exactly as the stock schema's parse drops it.
    """
    if not is_rose_desktop_user(getattr(workflow_instance, "user_id", None)):
        return None, None
    normalized, error = validate_inline_view(raw)
    if error is not None or normalized is None:
        return None, error
    try:
        resolved = await workflow.execute_activity(
            resolve_user_ui_inline_view_activity,
            args=[workflow_instance.user_id, normalized["view"]],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
    except Exception as e:  # activity failure after retries → tool error, not a crash
        logger.error("Failed to resolve inline view", view=normalized["view"], error=str(e))
        return None, f"Could not resolve inline view '{normalized['view']}': {e}"
    if not resolved.get("ok"):
        return None, str(resolved.get("error") or "Inline view is not available.")
    return {
        "view": normalized["view"],
        "versionId": resolved["version_id"],
        "props": normalized["props"],
    }, None


# ── Singleton ──

_manager: Optional[SendMessageToUserManager] = None


def get_manager() -> SendMessageToUserManager:
    """Get or create send_message_to_user manager singleton."""
    global _manager
    if _manager is None:
        _manager = SendMessageToUserManager()
    return _manager


# ── Workflow helper ──


async def send_message_to_user(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> MessageStatus | None:
    """Workflow helper for send_message_to_user.

    For sub-agents (depth >= 1), auto-responds instead of blocking.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "send_message_to_user")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
