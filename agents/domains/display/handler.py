"""Display domain handler - thin workflow-side entry point for the ``display`` tool.

    validate ─► display_media_activity ─┬─ inline ─► FINISHED "Displayed N item(s)"
                                        └─ pinned ─► IN_PROGRESS (pin metadata from backend)
                                                     wait receive_user_response(request_id)
                                                     FINISHED with the answer

The pinned wait has no deadline (plan row C11); a deployment cutover closes the
row like an approval wait does.
"""

from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.display.config import (
    DISPLAY_ACTIVITY_MAX_ATTEMPTS,
    DISPLAY_ACTIVITY_TIMEOUT_SECONDS,
    TOOL_NAME,
)
from domains.display.service import describe_answer, describe_error, describe_inline, validate_tool_call
from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested
from helpers.wait_condition_or_handoff import wait_condition_or_generation_handoff
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

with workflow.unsafe.imports_passed_through():
    from domains.display.repo import display_media_activity

logger = structlog.get_logger()


class DisplayManager(ToolManager):
    """Show media inline, or pin a question with options and wait for the answer."""

    tool_name = TOOL_NAME
    read_only = True  # Posts to the user's own trajectory; no external side effects.

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        validation = validate_tool_call(
            tool_call,
            agent_id=str(workflow_instance.agent_id),
            user_id=str(workflow_instance.user_id or ""),
            workflow_id=str(workflow.info().workflow_id),
            tool_call_id=tool_call_id,
        )
        if not validation.get("ok"):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid display call",
                message=str(validation.get("error")),
                status=MessageStatus.ERROR,
            )
            return
        payload = validation["payload"]

        try:
            result = await workflow.execute_activity(
                display_media_activity,
                args=[payload],
                start_to_close_timeout=timedelta(seconds=DISPLAY_ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=DISPLAY_ACTIVITY_MAX_ATTEMPTS),
            )
        except Exception as e:  # activity failure after retries → tool error, not a crash
            logger.error("[Display] activity failed", agent_id=payload["agent_id"], error=str(e))
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Display failed",
                message=f"Could not reach Rose to display media: {e}",
                status=MessageStatus.ERROR,
            )
            return

        if not result.get("ok"):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Display rejected",
                message=describe_error(str(result.get("error") or "Display failed"), list(result.get("details") or [])),
                status=MessageStatus.ERROR,
            )
            return

        body: Dict[str, Any] = dict(result.get("body") or {})
        if payload["placement"] == "inline":
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Displayed for the user",
                message=describe_inline(body),
                status=MessageStatus.FINISHED,
                metadata={"display": {"placement": "inline", "items": body.get("items") or []}},
            )
            return

        async for event in _pinned_question(workflow_instance, payload, body):
            yield event


async def _pinned_question(
    workflow_instance: Any, payload: Dict[str, Any], body: Dict[str, Any]
) -> AsyncGenerator[ToolEvent, None]:
    question: Dict[str, Any] = dict(body.get("question") or {})
    request_id = str(question.get("request_id") or "")
    metadata: Dict[str, Any] = dict(question.get("message_metadata") or {})
    title = "Asking the user" if question.get("deliver_to") == "user" else "Asking the parent agent"
    yield ToolEvent(
        type=EventType.POST_MESSAGE,
        title=title,
        message=payload["caption"],
        status=MessageStatus.IN_PROGRESS,
        metadata=metadata,
    )

    signals = workflow_instance._signal_responses
    answered_already = question.get("status") != "pending" and question.get("response") is not None
    if not answered_already:
        try:
            if request_id not in signals:
                await wait_condition_or_generation_handoff(
                    lambda: request_id in signals,
                    workflow_instance,
                    workflow_mod=workflow,
                )
        except GenerationHandoffRequested:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=title,
                message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                status=MessageStatus.FINISHED,
                metadata=metadata,
            )
            raise
    response: Optional[str] = (
        str(question.get("response")) if answered_already else str(signals.pop(request_id) or "")
    )
    logger.info(
        "[Display] pinned question answered",
        agent_id=payload["agent_id"],
        request_id=request_id,
        deliver_to=question.get("deliver_to"),
    )
    answer = describe_answer(response or "", question, payload["options"])
    yield ToolEvent(
        type=EventType.POST_MESSAGE,
        title="Answer received",
        message=f"Question:\n{payload['caption']}\n\n{answer}",
        status=MessageStatus.FINISHED,
        metadata={**metadata, "displayAnswer": {"response": response, "summary": answer}},
    )


# ── Singleton ──

_manager: Optional[DisplayManager] = None


def get_manager() -> DisplayManager:
    """Get or create the display manager singleton."""
    global _manager
    if _manager is None:
        _manager = DisplayManager()
    return _manager


async def display(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> MessageStatus | None:
    """Workflow helper for the display tool (TOOL_EXECUTORS entry)."""
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, TOOL_NAME)
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
