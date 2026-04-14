"""Grep domain service - business logic orchestration."""

import time
from datetime import timedelta
from typing import Any, Dict, Optional

import structlog
from temporalio.common import RetryPolicy

from domains.grep.config import (
    ACTIVITY_BACKOFF_COEFFICIENT,
    ACTIVITY_INITIAL_INTERVAL_SECONDS,
    ACTIVITY_MAX_ATTEMPTS,
    ACTIVITY_MAX_INTERVAL_SECONDS,
    ACTIVITY_TIMEOUT_SECONDS,
    DISPLAY_PATTERN_MAX_LENGTH,
    LOG_PATTERN_MAX_LENGTH,
)
from domains.grep.repo import grep_activity
from domains.grep.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _truncate_pattern(pattern: str) -> str:
    """Truncate pattern for display in tool events."""
    if len(pattern) <= DISPLAY_PATTERN_MAX_LENGTH:
        return pattern
    return pattern[: DISPLAY_PATTERN_MAX_LENGTH - 3] + "..."


async def execute_grep(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute grep search and post events via handle_tool_event."""
    pattern = tool_call.get("pattern", "")
    source = tool_call.get("source", "messages")
    person_id = tool_call.get("person_id")
    since = tool_call.get("since")

    display_pattern = _truncate_pattern(pattern)

    start_time = _safe_time()

    # IN_PROGRESS
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Grep: {display_pattern}" if display_pattern else "Grep: all messages",
            message="",
            status=MessageStatus.IN_PROGRESS,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name="grep",
        execute_activity=execute_activity,
        user_id=user_id,
    )

    try:
        logger.info(
            "Calling grep_activity",
            pattern=pattern[:LOG_PATTERN_MAX_LENGTH],
            source=source,
            person_id=person_id[:8] if person_id else None,
            since=since,
        )

        result = await execute_activity(
            grep_activity,
            args=[pattern, source, person_id, since, user_id, agent_id],
            start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
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
                title=f"Grep: {display_pattern}" if display_pattern else "Grep completed",
                message=message,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="grep",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": result,
            "usage": {
                "llm": [],
                "service": [],
            },
        }

    except Exception as e:
        elapsed_time = _safe_time() - start_time

        error_message = format_error_message(
            params=tool_call,
            error=e,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Grep failed: {display_pattern}" if display_pattern else "Grep failed",
                message=error_message,
                status=MessageStatus.ERROR,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="grep",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        raise
