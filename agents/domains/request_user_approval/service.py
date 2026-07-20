"""Request user approval domain service.

Business logic orchestration for approval requests.
Imports: own repo, own types, own config, external packages.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

from .config import (
    APPROVAL_SIGNAL_PARAM_REFRESH_PATCH,
    CREATE_REQUEST_MAX_ATTEMPTS,
    CREATE_REQUEST_TIMEOUT_SECONDS,
    REJECTION_SENTINEL,
    SMS_NOTIFY_MAX_ATTEMPTS,
    SMS_NOTIFY_TIMEOUT_SECONDS,
    TOOL_NAME,
)
from .repo import create_approval_request_activity
from .types import ApprovalResult, UserRejectedError

logger = structlog.get_logger()


def _build_approval_completion_message(question: str, response_text: str) -> str:
    """Render approval evidence into message text for verifier/model context."""
    response = response_text.strip() if response_text else "Approved"
    return f"Approval request:\n{question}\n\nUser response:\n{response}"


class RequestUserApprovalManager(ToolManager):
    """Manager for user approval requests (used by tools, not LLM directly)."""

    tool_name = TOOL_NAME
    read_only = True  # This is a gating mechanism, not a write action itself

    async def execute_tool(
        self, workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute user approval request and yield events.

        Waits indefinitely for user response (no timeout - approval is blocking).

        Yields:
            Pre-execution status (question to user).
            Post-execution status (after user responds).
        """
        question = tool_call.get("question", "")
        image_url = tool_call.get("image_url")
        metadata = tool_call.get("metadata")
        event_metadata = None

        if not question:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid approval request",
                message="Question is required",
                status=MessageStatus.ERROR,
            )
            return

        # 1. Create attention request in database
        try:
            info = workflow.info()
            workflow_id = info.workflow_id
            user_id = workflow_instance.user_id
            agent_id = workflow_instance.agent_id

            request_id = await workflow.execute_activity(
                create_approval_request_activity,
                args=[
                    str(user_id) if user_id else "",
                    str(agent_id) if agent_id else "",
                    str(workflow_id) if workflow_id else "",
                    str(question) if question else "",
                    str(image_url) if image_url else "",
                    metadata or None,
                ],
                start_to_close_timeout=timedelta(seconds=CREATE_REQUEST_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=CREATE_REQUEST_MAX_ATTEMPTS),
            )

            if metadata or request_id:
                payload = dict(metadata or {})
                payload["attentionRequestId"] = request_id
                event_metadata = {"requestUserApproval": payload}

            logger.info(
                "Approval request created, waiting for user response",
                request_id=request_id,
                workflow_id=workflow_id,
            )

        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed to create approval request",
                message=str(e),
                status=MessageStatus.ERROR,
                metadata={"requestUserApproval": metadata} if metadata else None,
            )
            return

        # 2. Pre-execution status - show the question
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="🔐 Requesting user approval",
            message=question,
            status=MessageStatus.IN_PROGRESS,
            metadata=event_metadata,
        )

        # 3. Wait indefinitely for user response (approval is blocking)
        try:
            await workflow.wait_condition(
                lambda: len(workflow_instance.context) > 0 and workflow_instance.context[-1].get("role") == "USER"
            )

            logger.info("User responded to approval request", request_id=request_id)

        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed waiting for user response",
                message=str(e),
                status=MessageStatus.ERROR,
            )
            return

        # 4. Get the response from context
        wf_context = workflow_instance.context
        user_messages: list[str] = []

        # Walk backwards and collect all consecutive USER messages
        for i in range(len(wf_context) - 1, -1, -1):
            if wf_context[i].get("role") == "USER":
                user_messages.insert(0, wf_context[i].get("text", ""))
            else:
                break

        response_text = "\n\n".join(user_messages)

        logger.info("User approval response received", request_id=request_id, response_length=len(response_text))

        # 5. Success status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✓ User approval received",
            message=_build_approval_completion_message(question, response_text),
            status=MessageStatus.FINISHED,
            metadata=event_metadata,
        )


async def request_user_approval_direct(
    workflow_instance: Any,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> ApprovalResult:
    """Direct call helper for tools that need to request user approval.

    Used by tools that make direct calls (e.g. message_person).

    Args:
        workflow_instance: The workflow instance (self).
        question: The question to ask the user.
        image_url: Optional image URL (e.g. product thumbnail).
        metadata: Optional additional metadata.

    Returns:
        Dict with response, question, and attention_request_id.

    Raises:
        UserRejectedError: If the user rejects the approval request.
    """
    info = workflow.info()
    workflow_id = info.workflow_id
    user_id = workflow_instance.user_id
    agent_id = workflow_instance.agent_id

    tool_call_id = workflow.uuid4()

    event_metadata = None
    metadata_payload: Optional[Dict[str, Any]] = None

    # Create the approval request via activity
    try:
        request_id = await workflow.execute_activity(
            create_approval_request_activity,
            args=[
                str(user_id) if user_id else "",
                str(agent_id) if agent_id else "",
                str(workflow_id) if workflow_id else "",
                str(question) if question else "",
                str(image_url) if image_url else "",
                metadata or None,
            ],
            start_to_close_timeout=timedelta(seconds=CREATE_REQUEST_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(maximum_attempts=CREATE_REQUEST_MAX_ATTEMPTS),
        )

        logger.info(
            "Approval request created, waiting for user response",
            request_id=request_id,
            workflow_id=workflow_id,
        )

        metadata_payload = dict(metadata or {})
        metadata_payload["attentionRequestId"] = request_id
        event_metadata = {
            "isUserAttentionMessage": True,
            "attentionMessage": question,
            "requestUserApproval": metadata_payload,
        }

        # Send SMS write_lock notification to every ROOT agent regardless of
        # source so payment approvals reach the user (with the enriched
        # merchant/reviews/cost breakdown + agent link) whether the run started
        # from SMS, web, or mac-app. Sub-agents are excluded (scale); benchmark
        # runs are suppressed centrally on the backend (Agent.isBenchmark).
        if getattr(workflow_instance, "parent_workflow_id", None) is None:
            try:
                from helpers.sms_activities import notify_sms_event_activity

                await workflow.execute_activity(
                    notify_sms_event_activity,
                    args=[
                        user_id,
                        "write_lock",
                        agent_id,
                        {
                            "question": question,
                            "attention_request_id": request_id,
                            "workflow_id": workflow_id,
                            "metadata": metadata or None,
                        },
                    ],
                    start_to_close_timeout=timedelta(seconds=SMS_NOTIFY_TIMEOUT_SECONDS),
                    retry_policy=RetryPolicy(maximum_attempts=SMS_NOTIFY_MAX_ATTEMPTS),
                )
                logger.info("Sent write_lock SMS notification", request_id=request_id, agent_id=agent_id)
            except Exception as sms_err:
                logger.warning(f"Failed to send write_lock SMS notification: {sms_err}")

    except Exception as e:
        error_event = ToolEvent(
            type=EventType.POST_MESSAGE,
            title="❌ Failed to create approval request",
            message=str(e),
            status=MessageStatus.ERROR,
            metadata={"requestUserApproval": metadata} if metadata else None,
        )
        await workflow_instance._handle_tool_event(error_event, tool_call_id, TOOL_NAME)
        raise

    pre_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="🔐 Requesting user approval",
        message=question,
        status=MessageStatus.IN_PROGRESS,
        metadata=event_metadata,
    )
    await workflow_instance._handle_tool_event(pre_event, tool_call_id, TOOL_NAME)

    # Snapshot context length before waiting
    context_len_before_wait = len(workflow_instance.context)

    # Wait indefinitely for this specific request's response
    await workflow.wait_condition(lambda: request_id in workflow_instance._signal_responses)

    signal_response = workflow_instance._signal_responses.pop(request_id)

    if signal_response and signal_response.strip() == REJECTION_SENTINEL:
        logger.info("User rejected approval request (via signal)", request_id=request_id)

        # Poll messages to get the user's rejection feedback text from DB
        await workflow_instance._poll_messages(datetime.fromtimestamp(0, tz=timezone.utc))

        # Extract rejection message only from messages added during this approval window
        rejection_text = ""
        for i in range(len(workflow_instance.context) - 1, context_len_before_wait - 1, -1):
            if workflow_instance.context[i].get("role") == "USER":
                rejection_text = workflow_instance.context[i].get("text", "")
                break

        if rejection_text:
            logger.info("User rejection message", request_id=request_id, rejection_text=rejection_text[:100])

        # Post FINISHED to close the approval chip cleanly
        reject_event = ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✗ User rejected action",
            message=rejection_text,
            status=MessageStatus.FINISHED,
            metadata=event_metadata,
        )
        await workflow_instance._handle_tool_event(reject_event, tool_call_id, TOOL_NAME)

        raise UserRejectedError("User rejected the approval request", rejection_message=rejection_text)

    if workflow.patched(APPROVAL_SIGNAL_PARAM_REFRESH_PATCH):
        # Approval responses are request-scoped signal data. Reading trailing
        # chat messages here loses text entered in the approval UI because that
        # text is persisted on the attention request and signal, not as a normal
        # USER row.
        response_text = signal_response.strip() if signal_response else ""
    else:
        # Replay compatibility for histories created before request-scoped
        # approval text was consumed directly from the signal.
        await workflow_instance._poll_messages(datetime.fromtimestamp(0, tz=timezone.utc))
        user_messages: list[str] = []
        for message in reversed(workflow_instance.context):
            if message.get("role") != "USER":
                break
            user_messages.insert(0, message.get("text", ""))
        response_text = "\n\n".join(user_messages)

    logger.info(
        "User approval response received",
        request_id=request_id,
        response_length=len(response_text),
        response_preview=response_text[:50] if response_text else "",
    )

    post_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="✓ User approval received",
        message=_build_approval_completion_message(question, response_text),
        status=MessageStatus.FINISHED,
        metadata=event_metadata,
    )
    await workflow_instance._handle_tool_event(post_event, tool_call_id, TOOL_NAME)

    return {
        "response": response_text,
        "question": question,
        "attention_request_id": metadata_payload.get("attentionRequestId") if metadata_payload else None,
    }


async def request_user_attention_direct(
    workflow_instance: Any,
    question: str,
    *,
    title: str = "User action required",
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    sms_event_type: Optional[str] = None,
    sms_payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create a user attention request without waiting for an approval response.

    This is for setup handoffs where the user must open an external link and
    return later, not answer "yes/no" inside Rose.
    """
    info = workflow.info()
    workflow_id = info.workflow_id
    user_id = workflow_instance.user_id
    agent_id = workflow_instance.agent_id
    tool_call_id = workflow.uuid4()

    request_id = await workflow.execute_activity(
        create_approval_request_activity,
        args=[
            str(user_id) if user_id else "",
            str(agent_id) if agent_id else "",
            str(workflow_id) if workflow_id else "",
            str(question) if question else "",
            str(image_url) if image_url else "",
            metadata or None,
        ],
        start_to_close_timeout=timedelta(seconds=CREATE_REQUEST_TIMEOUT_SECONDS),
        retry_policy=RetryPolicy(maximum_attempts=CREATE_REQUEST_MAX_ATTEMPTS),
    )

    metadata_payload = dict(metadata or {})
    metadata_payload["attentionRequestId"] = request_id
    event_metadata = {
        **metadata_payload,
        "isUserAttentionMessage": True,
        "attentionMessage": question,
    }

    # Root agents of any source get the handoff SMS (login/card-setup). Benchmark
    # runs are suppressed centrally on the backend (Agent.isBenchmark).
    if sms_event_type and getattr(workflow_instance, "parent_workflow_id", None) is None:
        try:
            from helpers.sms_activities import notify_sms_event_activity

            await workflow.execute_activity(
                notify_sms_event_activity,
                args=[
                    user_id,
                    sms_event_type,
                    agent_id,
                    {
                        "question": question,
                        "attention_request_id": request_id,
                        "workflow_id": workflow_id,
                        **dict(sms_payload or {}),
                    },
                ],
                start_to_close_timeout=timedelta(seconds=SMS_NOTIFY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=SMS_NOTIFY_MAX_ATTEMPTS),
            )
            logger.info(
                "Sent user attention SMS notification",
                request_id=request_id,
                agent_id=agent_id,
                event_type=sms_event_type,
            )
        except Exception as sms_err:
            logger.warning(f"Failed to send user attention SMS notification: {sms_err}")

    pre_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title=title,
        message=question,
        status=MessageStatus.IN_PROGRESS,
        metadata=event_metadata,
    )
    await workflow_instance._handle_tool_event(pre_event, tool_call_id, TOOL_NAME)

    return {
        "question": question,
        "attention_request_id": request_id,
    }


# ========================================
# SINGLETON
# ========================================

_manager: Optional[RequestUserApprovalManager] = None


def get_manager() -> RequestUserApprovalManager:
    """Get or create request user approval manager singleton."""
    global _manager
    if _manager is None:
        _manager = RequestUserApprovalManager()
    return _manager
