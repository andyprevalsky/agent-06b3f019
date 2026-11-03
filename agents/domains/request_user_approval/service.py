"""Request user approval domain service.

Business logic orchestration for approval requests.
Imports: own repo, own types, own config, external packages.

Approval SMS (per attention request):

    create row + chip
         |
         v
    initial write_lock SMS  <--- the only notification
         |
         +-- user responds ----> done
         +-- later waits -------> silence (no reminder SMS)
         +-- cutover -----------> reuse same row, no second SMS
"""

from __future__ import annotations

from helpers.wmh_activity_policy import wmh_activity_timeout_options
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Callable, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from helpers.generation_handoff import (
    DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    GenerationHandoffRequested,
)
from helpers.sms_activities import notify_sms_event_activity
from helpers.wait_condition_or_handoff import wait_condition_or_generation_handoff
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

from .config import (
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

DEPLOY_INTERRUPTED_ERROR_CODE = "DEPLOY_INTERRUPTED"


def _attention_request_id_from_metadata(metadata: Dict[str, Any]) -> Optional[str]:
    nested = metadata.get("requestUserApproval")
    if isinstance(nested, dict):
        request_id = nested.get("attentionRequestId")
        if isinstance(request_id, str) and request_id:
            return request_id
    request_id = metadata.get("attentionRequestId")
    if isinstance(request_id, str) and request_id:
        return request_id
    return None


def pending_approval_requests_to_resume(messages: list[Dict[str, Any]]) -> list[Dict[str, str]]:
    """Return every approval wait that must be re-armed after cutover.

    ``wait_for`` already resumes its original target across continue_as_new.
    Approval waits did not: the replacement run created a new row, SMS approved
    the original attn_id, and the live wait (keyed on the new id) ignored it.

    DAG cutover can cancel sibling approval waits without entering
    ``GenerationHandoffRequested``. Those rows stay in the transcript as
    in-progress chips and must be stashed too, or SMS can approve an id the
    continued workflow is no longer waiting on.
    """
    groups: Dict[str, Dict[str, Any]] = {}
    order: list[str] = []
    for msg in messages:
        if msg.get("role") != "TOOL":
            continue
        metadata = msg.get("metadata")
        if not isinstance(metadata, dict):
            continue
        request_id = _attention_request_id_from_metadata(metadata)
        if not request_id:
            continue
        group = groups.get(request_id)
        if group is None:
            group = {
                "completed": False,
                "interrupted": False,
                "in_progress": False,
                "question": "",
            }
            groups[request_id] = group
            order.append(request_id)

        status = str(metadata.get("toolStatus") or "").upper()
        error_code = metadata.get("errorCode")
        text = str(msg.get("text") or msg.get("message") or "")
        attention_message = metadata.get("attentionMessage")
        nested = metadata.get("requestUserApproval")
        nested_question = ""
        if isinstance(nested, dict):
            raw_question = nested.get("question")
            if isinstance(raw_question, str):
                nested_question = raw_question
        if isinstance(attention_message, str) and attention_message:
            group["question"] = attention_message
        elif nested_question:
            group["question"] = nested_question
        elif (
            status == "IN_PROGRESS"
            and text
            and text != DEPLOY_INTERRUPTED_TOOL_MESSAGE
            and not group["question"]
        ):
            group["question"] = text
        if error_code == DEPLOY_INTERRUPTED_ERROR_CODE or text == DEPLOY_INTERRUPTED_TOOL_MESSAGE:
            group["interrupted"] = True
        elif status in ("FINISHED", "SUCCESS", "COMPLETED"):
            group["completed"] = True
        elif status == "IN_PROGRESS":
            group["in_progress"] = True

    pending: list[Dict[str, str]] = []
    for request_id in order:
        group = groups[request_id]
        if group["completed"]:
            continue
        if group["interrupted"] or group["in_progress"]:
            pending.append(
                {
                    "request_id": request_id,
                    "question": str(group.get("question") or ""),
                }
            )
    return pending


def pending_approval_request_to_resume(messages: list[Dict[str, Any]]) -> Optional[str]:
    """Return the newest still-open approval attn_id, or None."""
    pending = pending_approval_requests_to_resume(messages)
    if not pending:
        return None
    return pending[-1]["request_id"]


def _resume_entry(request_id: str, question: str = "") -> Dict[str, Any]:
    return {"request_id": request_id, "question": question}


def _resume_entries(pending: Any) -> list[Dict[str, Any]]:
    if isinstance(pending, dict):
        raw_requests = pending.get("requests")
        if isinstance(raw_requests, list):
            entries: list[Dict[str, Any]] = []
            for item in raw_requests:
                if not isinstance(item, dict):
                    continue
                request_id = item.get("request_id")
                if isinstance(request_id, str) and request_id:
                    question = item.get("question")
                    entries.append(
                        _resume_entry(
                            request_id,
                            question if isinstance(question, str) else "",
                        )
                    )
            return entries
        request_id = pending.get("request_id")
        if isinstance(request_id, str) and request_id:
            question = pending.get("question")
            return [
                _resume_entry(
                    request_id,
                    question if isinstance(question, str) else "",
                )
            ]
    if isinstance(pending, str) and pending:
        return [_resume_entry(pending)]
    return []


def _set_resume_entries(workflow_instance: Any, entries: list[Dict[str, Any]]) -> None:
    if not entries:
        workflow_instance._pending_approval_resume = None
        return
    if len(entries) == 1:
        workflow_instance._pending_approval_resume = _resume_entry(
            str(entries[0]["request_id"]),
            str(entries[0].get("question") or ""),
        )
        return
    workflow_instance._pending_approval_resume = {
        "requests": [
            _resume_entry(
                str(entry["request_id"]),
                str(entry.get("question") or ""),
            )
            for entry in entries
        ]
    }


def _stashed_approval_request_id(
    workflow_instance: Any, question: Optional[str] = None
) -> Optional[str]:
    entries = _resume_entries(getattr(workflow_instance, "_pending_approval_resume", None))
    if not entries:
        entries = pending_approval_requests_to_resume(
            getattr(workflow_instance, "context", None) or []
        )
        if entries:
            _set_resume_entries(workflow_instance, entries)
    if not entries:
        return None
    if question:
        for entry in entries:
            if entry["question"] == question:
                return entry["request_id"]
        return None
    if len(entries) == 1:
        return entries[0]["request_id"]
    return None


def _stash_approval_resume(
    workflow_instance: Any,
    request_id: str,
    question: str = "",
) -> None:
    if not request_id:
        return
    entries = _resume_entries(getattr(workflow_instance, "_pending_approval_resume", None))
    for entry in entries:
        if entry["request_id"] == request_id:
            if question and not entry["question"]:
                entry["question"] = question
            _set_resume_entries(workflow_instance, entries)
            return
    entries.append(_resume_entry(request_id, question))
    _set_resume_entries(workflow_instance, entries)


def _clear_approval_resume(workflow_instance: Any, request_id: str) -> None:
    entries = [
        entry
        for entry in _resume_entries(getattr(workflow_instance, "_pending_approval_resume", None))
        if entry["request_id"] != request_id
    ]
    _set_resume_entries(workflow_instance, entries)


def stash_pending_approvals_from_context(workflow_instance: Any) -> None:
    """Re-arm every still-open approval wait found in the transcript."""
    for item in pending_approval_requests_to_resume(
        getattr(workflow_instance, "context", None) or []
    ):
        _stash_approval_resume(workflow_instance, item["request_id"], item["question"])


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

        # 1. Create attention request in database, or reuse the in-flight
        # row after a cooperative continue_as_new so SMS still approves
        # the original attn_id.
        try:
            info = workflow.info()
            workflow_id = info.workflow_id
            user_id = workflow_instance.user_id
            agent_id = workflow_instance.agent_id

            request_id = _stashed_approval_request_id(workflow_instance, question)
            if not request_id:
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
            await wait_condition_or_generation_handoff(
                lambda: len(workflow_instance.context) > 0 and workflow_instance.context[-1].get("role") == "USER",
                workflow_instance,
                workflow_mod=workflow,
            )

            logger.info("User responded to approval request", request_id=request_id)
            _clear_approval_resume(workflow_instance, request_id)

        except GenerationHandoffRequested:
            _stash_approval_resume(workflow_instance, request_id, question)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔐 Requesting user approval",
                message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                status=MessageStatus.FINISHED,
                metadata=event_metadata,
            )
            raise
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


async def _send_approval_sms(
    workflow_instance: Any,
    *,
    user_id: Any,
    agent_id: Any,
    workflow_id: Any,
    question: str,
    request_id: str,
    metadata: Optional[Dict[str, Any]],
) -> None:
    """Send the initial write_lock SMS. Never a follow-up reminder."""
    try:
        notification_args = [
            user_id,
            "write_lock",
            agent_id,
            {
                "question": question,
                "attention_request_id": request_id,
                "workflow_id": workflow_id,
                "metadata": metadata or None,
            },
        ]
        world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
        if world_model_mode != "real":
            notification_args.append(world_model_mode)
        await workflow.execute_activity(
            notify_sms_event_activity,
            args=notification_args,
            **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=SMS_NOTIFY_TIMEOUT_SECONDS)),
            retry_policy=RetryPolicy(maximum_attempts=SMS_NOTIFY_MAX_ATTEMPTS),
        )
        logger.info(
            "Sent write_lock SMS notification",
            request_id=request_id,
            agent_id=agent_id,
        )
    except Exception as sms_err:
        logger.warning(
            "Failed to send write_lock SMS notification: %s",
            sms_err,
        )


def _approval_event_metadata(
    question: str, metadata: Optional[Dict[str, Any]], request_id: str
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    metadata_payload = dict(metadata or {})
    metadata_payload["attentionRequestId"] = request_id
    event_metadata = {
        "isUserAttentionMessage": True,
        "attentionMessage": question,
        "requestUserApproval": metadata_payload,
    }
    return metadata_payload, event_metadata


async def request_user_approval_direct(
    workflow_instance: Any,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    *,
    close_on_cancel: bool = False,
    park: Optional[Callable[[Dict[str, str]], bool]] = None,
    resume_request: Optional[Dict[str, str]] = None,
) -> ApprovalResult:
    """Direct call helper for tools that need to request user approval.

    Used by tools that make direct calls (e.g. message_person).

    Args:
        workflow_instance: The workflow instance (self).
        question: The question to ask the user.
        image_url: Optional image URL (e.g. product thumbnail).
        metadata: Optional additional metadata.
        close_on_cancel: Close only the interrupted approval chip; never invent
            a response.
        park: Called with ``{"attention_request_id", "tool_call_id"}`` when a
            generation handoff interrupts the wait. Returning True means the
            caller parked that request for the next generation: the request
            and its chip stay open and ``GenerationHandoffRequested(parked=True)``
            is raised. Otherwise both are closed with DEPLOY_INTERRUPTED.
        resume_request: The dict ``park`` received in the previous generation.
            Re-waits on the same attention request: no new request, chip, or SMS.

    Returns:
        Dict with response, question, and attention_request_id.

    Raises:
        UserRejectedError: If the user rejects the approval request.
    """
    if resume_request:
        request_id = str(resume_request["attention_request_id"])
        tool_call_id = str(resume_request["tool_call_id"])
        metadata_payload, event_metadata = _approval_event_metadata(question, metadata, request_id)
        logger.info(
            "Resuming approval wait after generation handoff",
            request_id=request_id,
            agent_id=workflow_instance.agent_id,
        )
        return await _await_approval_response(
            workflow_instance,
            question=question,
            request_id=request_id,
            tool_call_id=tool_call_id,
            event_metadata=event_metadata,
            metadata_payload=metadata_payload,
            park=park,
            close_on_cancel=close_on_cancel,
        )

    info = workflow.info()
    workflow_id = info.workflow_id
    user_id = workflow_instance.user_id
    agent_id = workflow_instance.agent_id

    tool_call_id = str(workflow.uuid4())

    event_metadata = None
    metadata_payload: Optional[Dict[str, Any]] = None

    # Create the approval request via activity, or reuse the in-flight row
    # after continue_as_new so a late SMS approve of the original attn_id
    # still unblocks this wait.
    try:
        request_id = _stashed_approval_request_id(workflow_instance, question)
        reused_request = bool(request_id)
        if not request_id:
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
            "Approval request created, waiting for user response"
            if not reused_request
            else "Reusing in-flight approval request after generation handoff",
            request_id=request_id,
            workflow_id=workflow_id,
        )

        metadata_payload, event_metadata = _approval_event_metadata(question, metadata, request_id)

        # Send SMS write_lock notification for EVERY agent that blocks on
        # approval — root or sub-agent, any source. agent_started stays
        # root-only (per-spawn firehose at 10k agents); a write_lock/payment
        # approval is O(approvals) and must reach the user or the child hangs
        # silently. Benchmarks are suppressed centrally on the backend
        # (Agent.isBenchmark). Skip on resume — the original wait already notified.
        if not reused_request:
            await _send_approval_sms(
                workflow_instance,
                user_id=user_id,
                agent_id=agent_id,
                workflow_id=workflow_id,
                question=question,
                request_id=request_id,
                metadata=metadata,
            )

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
    return await _await_approval_response(
        workflow_instance,
        question=question,
        request_id=request_id,
        tool_call_id=tool_call_id,
        event_metadata=event_metadata,
        metadata_payload=metadata_payload,
        park=park,
        close_on_cancel=close_on_cancel,
        opening_event=pre_event,
    )


async def _await_approval_response(
    workflow_instance: Any,
    *,
    question: str,
    request_id: str,
    tool_call_id: str,
    event_metadata: Dict[str, Any],
    metadata_payload: Dict[str, Any],
    park: Optional[Callable[[Dict[str, str]], bool]],
    close_on_cancel: bool = False,
    opening_event: Optional[ToolEvent] = None,
) -> ApprovalResult:
    completion_event: Optional[ToolEvent] = None
    rejection_feedback_resolved = False
    # Delivery may persist before its await acknowledges the opened chip.
    try:
        if opening_event is not None:
            await workflow_instance._handle_tool_event(opening_event, tool_call_id, TOOL_NAME)

        # Snapshot context length before waiting
        context_len_before_wait = len(workflow_instance.context)

        # Initial notification already went out. An existing response needs no wait.
        try:
            if request_id not in workflow_instance._signal_responses:
                await wait_condition_or_generation_handoff(
                    lambda: request_id in workflow_instance._signal_responses,
                    workflow_instance,
                    workflow_mod=workflow,
                )
        except GenerationHandoffRequested as exc:
            parked = park is not None and park({"attention_request_id": request_id, "tool_call_id": tool_call_id})
            _stash_approval_resume(workflow_instance, request_id, question)
            if parked:
                raise GenerationHandoffRequested(exc.task_queue, parked=True) from None
            interrupt_event = ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔐 Requesting user approval",
                message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                status=MessageStatus.FINISHED,
                metadata=event_metadata,
            )
            completion_event = interrupt_event
            await workflow_instance._handle_tool_event(interrupt_event, tool_call_id, TOOL_NAME)
            raise

        signal_response = workflow_instance._signal_responses.pop(request_id)
        _clear_approval_resume(workflow_instance, request_id)

        if signal_response and signal_response.strip() == REJECTION_SENTINEL:
            logger.info("User rejected approval request (via signal)", request_id=request_id)

            reject_event = ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✗ User rejected action",
                message="",
                status=MessageStatus.FINISHED,
                metadata=event_metadata,
            )
            completion_event = reject_event

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
            reject_event.message = rejection_text
            rejection_feedback_resolved = True
            await workflow_instance._handle_tool_event(reject_event, tool_call_id, TOOL_NAME)

            raise UserRejectedError("User rejected the approval request", rejection_message=rejection_text)

        # Every deployment replaces old workflow histories before candidate workers
        # activate, so fresh histories always consume request-scoped signal data.
        response_text = signal_response.strip() if signal_response else ""

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
        completion_event = post_event
        await workflow_instance._handle_tool_event(post_event, tool_call_id, TOOL_NAME)

        return {
            "response": response_text,
            "question": question,
            "attention_request_id": metadata_payload.get("attentionRequestId") if metadata_payload else None,
        }

    except asyncio.CancelledError:
        if close_on_cancel:
            if completion_event is None:
                _stash_approval_resume(workflow_instance, request_id, question)
                completion_event = ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Approval interrupted",
                    message="Approval wait interrupted.",
                    status=MessageStatus.FINISHED,
                    metadata={**event_metadata, "excludeFromModel": True},
                )
            elif completion_event.title == "✗ User rejected action" and not rejection_feedback_resolved:
                # A poll may publish feedback before its await acknowledges it.
                for i in range(len(workflow_instance.context) - 1, context_len_before_wait - 1, -1):
                    if workflow_instance.context[i].get("role") == "USER":
                        completion_event.message = workflow_instance.context[i].get("text", "")
                        break
            await workflow_instance._handle_tool_event(completion_event, tool_call_id, TOOL_NAME)
        raise


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

    # Setup handoffs (login/card) SMS for every agent that requests them —
    # root or sub-agent. Same rationale as write_lock: the user must learn a
    # child is waiting. Benchmarks suppressed centrally (Agent.isBenchmark).
    if sms_event_type:
        try:
            notification_args = [
                user_id,
                sms_event_type,
                agent_id,
                {
                    "question": question,
                    "attention_request_id": request_id,
                    "workflow_id": workflow_id,
                    **dict(sms_payload or {}),
                },
            ]
            world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
            if world_model_mode != "real":
                notification_args.append(world_model_mode)
            await workflow.execute_activity(
                notify_sms_event_activity,
                args=notification_args,
                **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=SMS_NOTIFY_TIMEOUT_SECONDS)),
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
