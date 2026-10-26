"""Inspect-code domain service: run one inspection and render it for the caller."""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, Optional

import structlog
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent

from .config import (
    INSPECT_ACTIVITY_MAX_ATTEMPTS,
    INSPECT_ACTIVITY_TIMEOUT_SECONDS,
    MAX_QUESTION_CHARS,
)
from .repo import inspect_code_activity
from .types import TOOL_NAME, ExecuteActivityCallable, InspectResult

logger = structlog.get_logger()


def _citation_text(citation: Dict[str, Any]) -> str:
    end = citation.get("end_line")
    return f"{citation.get('path')}:{citation.get('line')}" + (f"-{end}" if end else "")


def render_inspection(result: InspectResult) -> str:
    """The text the calling agent reads: provenance line, answer, citation check."""
    head = str(result.get("head") or "")[:12]
    provenance = (
        f"Code session {result.get('code_session_id')}, checkpoint {result.get('checkpoint_seq')} "
        f"({result.get('checkpoint_created_at')})"
        + (f", branch {result.get('branch')}" if result.get("branch") else "")
        + (f" @ {head}" if head else "")
        + (f", directory ~/{result.get('work_dir')}" if result.get("work_dir") else "")
    )
    parts = [provenance, str(result.get("answer") or "").strip()]
    citations = [_citation_text(c) for c in result.get("citations") or [] if isinstance(c, dict)]
    if citations:
        parts.append("Verified citations: " + ", ".join(citations))
    unverified = [str(c) for c in result.get("unverified_citations") or []]
    if unverified:
        parts.append("Not found in the checkpoint: " + ", ".join(unverified))
    return "\n\n".join(part for part in parts if part)


def inspection_error(result: InspectResult) -> Optional[str]:
    """The failure the calling agent should see, or None for an answer."""
    if result.get("http_status") is not None or (result.get("error") and not result.get("status")):
        return str(result.get("error") or "The code inspection failed.")
    status = result.get("status")
    if status == "answered" and result.get("answer"):
        return None
    if status == "usage_limited":
        resets = result.get("resets_at")
        return "Every code-agent credential is at its usage limit" + (f" until {resets}." if resets else ".")
    return str(result.get("error") or "The code inspection returned no answer.")


async def execute_inspect_code(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Run inspect_code. Returns {"result": text} or {"error": message}; never raises on refusals."""
    code_session_id = str(tool_call.get("code_session_id") or "").strip()
    question = str(tool_call.get("question") or "").strip()
    title = f"Inspecting code session {code_session_id[:8]}"
    if not code_session_id or not question or len(question) > MAX_QUESTION_CHARS:
        return {
            "error": f"inspect_code needs a code_session_id and a 1-{MAX_QUESTION_CHARS} character question.",
            "usage": {"llm": [], "service": []},
        }

    async def post(status: MessageStatus, title_text: str, message: str) -> None:
        await handle_tool_event(
            event=ToolEvent(type=EventType.POST_MESSAGE, title=title_text, message=message, status=status),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=TOOL_NAME,
            execute_activity=execute_activity,
            user_id=user_id,
        )

    await post(MessageStatus.IN_PROGRESS, title, question)
    try:
        result = await execute_activity(
            inspect_code_activity,
            args=[code_session_id, question, user_id or "", agent_id],
            start_to_close_timeout=timedelta(seconds=INSPECT_ACTIVITY_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(maximum_attempts=INSPECT_ACTIVITY_MAX_ATTEMPTS),
        )
    except Exception as error:  # transport failure after the retry
        message = f"The code inspection could not reach the backend: {error}"[:500]
        await post(MessageStatus.ERROR, "Code inspection failed", message)
        return {"error": message, "usage": {"llm": [], "service": []}}
    failure = inspection_error(result)
    if failure is not None:
        logger.info("[InspectCode] inspection failed", code_session_id=code_session_id, error=failure[:200])
        await post(MessageStatus.ERROR, "Code inspection failed", failure)
        return {"error": failure, "usage": {"llm": [], "service": []}}
    text = render_inspection(result)
    await post(MessageStatus.FINISHED, f"Inspected code session {code_session_id[:8]}", text)
    return {"result": text, "inspection": result, "usage": {"llm": [], "service": []}}
