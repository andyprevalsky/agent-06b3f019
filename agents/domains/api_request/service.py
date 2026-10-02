"""api_request domain service."""

import json
import time
from datetime import timedelta
from typing import Any, Dict, Optional

import structlog
from temporalio.common import RetryPolicy

from domains.api_request.config import LOG_URL_MAX_LENGTH
from domains.api_request.repo import api_request_activity
from domains.api_request.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message

logger = structlog.get_logger()

ACTIVITY_TIMEOUT_SECONDS = 130
ACTIVITY_MAX_ATTEMPTS = 3
SAFE_HTTP_METHODS = frozenset({"GET", "HEAD"})


def _safe_time() -> float:
    try:
        return time.time()
    except Exception:
        return 0.0


def _public_params(tool_call: Dict[str, Any]) -> Dict[str, Any]:
    params: Dict[str, Any] = {}
    for key in ("method", "url", "query", "body", "headers"):
        value = tool_call.get(key)
        if value is not None:
            params[key] = value
    return params


def _format_title(prefix: str, tool_call: Dict[str, Any]) -> str:
    method = str(tool_call.get("method") or "GET").upper()
    url = str(tool_call.get("url") or "")
    display_url = url if len(url) <= LOG_URL_MAX_LENGTH else f"{url[: LOG_URL_MAX_LENGTH - 3]}..."
    return f"{prefix} {method} {display_url}"


def _has_idempotency_key(tool_call: Dict[str, Any]) -> bool:
    headers = tool_call.get("headers")
    if not isinstance(headers, dict):
        return False
    return any(str(key).lower() == "idempotency-key" for key in headers)


def _activity_max_attempts(tool_call: Dict[str, Any]) -> int:
    method = str(tool_call.get("method") or "GET").upper()
    if method in SAFE_HTTP_METHODS or _has_idempotency_key(tool_call):
        return ACTIVITY_MAX_ATTEMPTS
    return 1


async def execute_api_request(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute api_request and post tool events."""
    progress_title = _format_title("API request", tool_call)
    completed_title = _format_title("API request completed", tool_call)
    failed_title = _format_title("API request failed", tool_call)
    start_time = _safe_time()

    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title=progress_title,
            message="",
            status=MessageStatus.IN_PROGRESS,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name="api_request",
        execute_activity=execute_activity,
        user_id=user_id,
    )

    try:
        result = await execute_activity(
            api_request_activity,
            args=[tool_call, user_id, agent_id],
            start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(maximum_attempts=_activity_max_attempts(tool_call)),
        )

        # The Google OAuth benchmark has one guarded, in-memory API fixture.
        # Give its operations separate visible tool cards without any Google IO.
        if result.get("demo_fixture") is True:
            for index, row in enumerate(result["body"]["rows"], start=1):
                await handle_tool_event(
                    event=ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"DEMO · {row['tool']}",
                        message=json.dumps(row, indent=2),
                        status=MessageStatus.FINISHED,
                        metadata={"demoFixture": True, "demoParentToolCallId": tool_call_id},
                    ),
                    agent_id=agent_id,
                    tool_call_id=f"{tool_call_id}-demo-{index}",
                    tool_name=row["tool"],
                    execute_activity=execute_activity,
                    user_id=user_id,
                )

        elapsed_time = _safe_time() - start_time
        message = format_tool_message(
            params=_public_params(tool_call),
            result=result,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        status = MessageStatus.FINISHED
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=completed_title if result.get("ok") else failed_title,
                message=message,
                status=status,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="api_request",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": result,
            "usage": {"llm": [], "service": []},
        }
    except Exception as exc:
        elapsed_time = _safe_time() - start_time
        error_message = format_error_message(
            params=_public_params(tool_call),
            error=exc,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=failed_title,
                message=error_message,
                status=MessageStatus.ERROR,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="api_request",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        raise
