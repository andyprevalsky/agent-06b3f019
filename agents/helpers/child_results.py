"""Helpers for reconstructing terminal child-agent results from persisted state."""

from __future__ import annotations

from typing import Any, Dict, Optional

import structlog
from temporalio import activity

from helpers.fetch_config import _fetch_agent_data_impl

logger = structlog.get_logger()

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}


def _latest_completion_summary(messages: list[Dict[str, Any]]) -> Dict[str, Any]:
    for message in reversed(messages):
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        summary = metadata.get("completionSummary")
        if not isinstance(summary, dict):
            continue
        if metadata.get("isFinalSummary") or metadata.get("toolName") == "completion_summary":
            return summary
    return {}


def _tool_counts(completion_summary: Dict[str, Any]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    tool_usage = completion_summary.get("toolUsage")
    if not isinstance(tool_usage, list):
        return counts
    for item in tool_usage:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        count = item.get("count")
        if isinstance(name, str) and isinstance(count, int):
            counts[name] = count
    return counts


def _best_effort_text(agent: Dict[str, Any], messages: list[Dict[str, Any]], completion_summary: Dict[str, Any]) -> str:
    summary = completion_summary.get("summary")
    if isinstance(summary, str) and summary.strip():
        return summary.strip()

    status_message = agent.get("status_message")
    if isinstance(status_message, str) and status_message.strip():
        return status_message.strip()

    for message in reversed(messages):
        text = message.get("text")
        if isinstance(text, str) and text.strip():
            return text.strip()

    goal = agent.get("goal")
    return f"Completed: {goal}" if isinstance(goal, str) and goal else ""


@activity.defn
async def fetch_child_terminal_result_activity(child_agent_id: str) -> Optional[Dict[str, Any]]:
    """Return a parent-signal-compatible result if the child is durably terminal."""
    activity.heartbeat("Fetching child terminal result")

    data = await _fetch_agent_data_impl(child_agent_id)
    agent = data.get("agent") or {}
    messages = data.get("messages") or []
    status = str(agent.get("status") or "").upper()

    if status not in TERMINAL_STATUSES:
        return None

    completion_summary = _latest_completion_summary(messages if isinstance(messages, list) else [])
    structured_response = agent.get("structured_output")
    summary = _best_effort_text(agent, messages if isinstance(messages, list) else [], completion_summary)

    if status == "COMPLETED":
        return {
            "status": "completed",
            "goal": agent.get("goal", ""),
            "summary": summary,
            "structured_response": structured_response,
            "tool_counts": _tool_counts(completion_summary),
        }

    failure_context = agent.get("failure_context")
    if not isinstance(failure_context, dict):
        failure_context = {}
    if structured_response is not None and "partial_structured_response" not in failure_context:
        failure_context = {**failure_context, "partial_structured_response": structured_response}

    return {
        "status": "failed",
        "goal": agent.get("goal", ""),
        "summary": summary,
        "error_reason": agent.get("status_message") or status,
        "failure_context": failure_context,
        "structured_response": structured_response,
        "tool_counts": {},
    }
