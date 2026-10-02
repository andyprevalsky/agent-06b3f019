"""Pure helpers for cooperative generation handoff decisions."""

from __future__ import annotations

import json
from typing import Any

# Same bytes as back-end DEPLOY_INTERRUPTED_TOOL_MESSAGE. An in-tool wait that
# yields for cutover closes the chip with this so the next generation retries.
DEPLOY_INTERRUPTED_TOOL_MESSAGE = "new code version deployed, retry this tool"


class GenerationHandoffRequested(Exception):
    """Raised when an in-tool wait must yield so the workflow can continue_as_new.

    Only raise when no Temporal activity is running. With ``parked=False`` the
    caller closes the in-progress tool chip with DEPLOY_INTERRUPTED and the
    next generation's LLM retries the tool. ``parked=True`` means the raising
    tool already handed its resume record to ``park_pending_tool``: its chip
    stays open, and the workflow re-enters the same tool call on the live
    generation before its next LLM turn, so the tool picks up where it parked.
    """

    def __init__(self, task_queue: str, *, parked: bool = False):
        self.task_queue = task_queue
        self.parked = parked
        super().__init__(task_queue)


# continue_as_new arguments share Temporal's 2MB payload cap with the carried
# context. Parked tools whose combined records exceed this fall back to
# DEPLOY_INTERRUPTED rather than risking a continue_as_new the server rejects.
PENDING_TOOL_RESUME_MAX_BYTES = 256_000


def pending_tool_resumes_fit(records: list[dict[str, Any]]) -> bool:
    """Return True when the parked-tool records are small enough to carry together."""
    try:
        encoded = json.dumps(records, separators=(",", ":"))
    except (TypeError, ValueError):
        return False
    return len(encoded.encode("utf-8")) <= PENDING_TOOL_RESUME_MAX_BYTES


def pending_tool_record(
    tool_name: str,
    tool_args: dict[str, Any],
    tool_call_id: str,
    resume: dict[str, Any],
) -> dict[str, Any]:
    """Build the continue_as_new record that re-enters one parked tool call."""
    return {
        "tool_name": tool_name,
        "tool_args": dict(tool_args),
        "tool_call_id": tool_call_id,
        "resume": resume,
    }


def park_pending_tool(workflow_instance: Any, tool_call_id: str, resume: dict[str, Any]) -> bool:
    """Ask the workflow to carry this tool call across the coming continue_as_new.

    Call at the moment a handoff is observed, before raising. True means the
    record is stored and the tool must raise ``GenerationHandoffRequested(...,
    parked=True)`` leaving its chip and any attention request open. False means
    take the DEPLOY_INTERRUPTED path: parking is only enabled for run_agent
    turns (the DAG treats any tool return as task completion) and only while
    the combined records fit the payload budget.
    """
    parker = getattr(workflow_instance, "_park_pending_tool", None)
    if not callable(parker):
        return False
    return parker(tool_call_id, resume) is True


def take_tool_resume(workflow_instance: Any, tool_call_id: str) -> dict[str, Any] | None:
    """Return the resume payload a previous generation parked for this tool call."""
    taker = getattr(workflow_instance, "_take_tool_resume", None)
    if not callable(taker):
        return None
    resume = taker(tool_call_id)
    return resume if isinstance(resume, dict) else None


def should_handoff_to_generation(
    current_task_queue: str | None,
    live_task_queue: str | None,
) -> bool:
    """Return True when this workflow should continue_as_new onto ``live_task_queue``.

    Handoff is required only when both queues are known and differ. Missing
    values fail open (keep running) so a transient pointer read never aborts
    an agent mid-loop.
    """
    current = (current_task_queue or "").strip()
    live = (live_task_queue or "").strip()
    if not current or not live:
        return False
    return current != live


def parse_shutdown_grace_seconds(raw: str | None, default: int = 2100) -> int:
    """Parse ``WORKER_SHUTDOWN_GRACE_PERIOD`` values like ``35m``, ``2100s``, or ``2100``."""
    if raw is None:
        return default
    text = raw.strip().lower()
    if not text:
        return default
    try:
        if text.endswith("ms"):
            return max(1, int(float(text[:-2]) / 1000.0))
        if text.endswith("s"):
            return max(1, int(float(text[:-1])))
        if text.endswith("m"):
            return max(1, int(float(text[:-1]) * 60))
        if text.endswith("h"):
            return max(1, int(float(text[:-1]) * 3600))
        return max(1, int(float(text)))
    except ValueError:
        return default
