"""Send email domain service - business logic orchestration.

Composes pre/post status messages, delegates to repo for data access,
and formats results. Typed args in, typed results out.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message

from .config import (
    ACTIVITY_BACKOFF_COEFFICIENT,
    ACTIVITY_INITIAL_INTERVAL_SECONDS,
    ACTIVITY_MAX_ATTEMPTS,
    ACTIVITY_MAX_INTERVAL_SECONDS,
    ACTIVITY_START_TO_CLOSE_TIMEOUT_SECONDS,
    DISPLAY_SUBJECT_MAX_LEN,
)
from .repo import send_email_activity

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:  # noqa: BLE001
        return 0.0


def _build_pre_message(to: str, subject: str, cc: str | None) -> str:
    """Build the pre-execution status message for display."""
    display_subject = (
        subject if len(subject) <= DISPLAY_SUBJECT_MAX_LEN else subject[: DISPLAY_SUBJECT_MAX_LEN - 3] + "..."
    )
    if cc:
        return f"**To:** {to}\n**Cc:** {cc}\n**Subject:** {display_subject}"
    return f"**To:** {to}\n**Subject:** {display_subject}"


async def execute_send_email(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """
    Orchestrate send_email: post status, call activity, post result.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'to', 'subject', 'body', optional 'cc'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking and email sending

    Returns:
        Result dict with messageId, threadId, etc. or error dict on failure.
    """
    to = tool_call.get("to", "")
    subject = tool_call.get("subject", "")
    body = tool_call.get("body", "")
    cc = tool_call.get("cc")

    start_time = _safe_time()

    # 1. Pre-execution status
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title="\U0001f4e7 Sending Email",
            message=_build_pre_message(to, subject, cc),
            status=MessageStatus.IN_PROGRESS,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name="send_email",
        execute_activity=execute_activity,
        user_id=user_id,
    )

    # 2. Execute email send activity
    try:
        result = await execute_activity(
            send_email_activity,
            args=[user_id, to, subject, body, cc],
            start_to_close_timeout=timedelta(seconds=ACTIVITY_START_TO_CLOSE_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(
                maximum_attempts=ACTIVITY_MAX_ATTEMPTS,
                backoff_coefficient=ACTIVITY_BACKOFF_COEFFICIENT,
                initial_interval=timedelta(seconds=ACTIVITY_INITIAL_INTERVAL_SECONDS),
                maximum_interval=timedelta(seconds=ACTIVITY_MAX_INTERVAL_SECONDS),
            ),
        )

        elapsed_time = _safe_time() - start_time

        message = format_tool_message(
            params=tool_call,
            result=result,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u2705 Email sent successfully",
                message=message,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_email",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return result

    except Exception as exc:
        elapsed_time = _safe_time() - start_time

        error_message = format_error_message(
            params=tool_call,
            error=exc,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Email send failed",
                message=error_message,
                status=MessageStatus.ERROR,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="send_email",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {"error": str(exc), "to": to, "subject": subject}
