"""Business logic for the knowledge-base domain.

Trajectory compression and blueprint orchestration live here.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from domains.knowledge_base.config import (
    ERROR_TEXT_MAX_LENGTH,
    GOAL_DISPLAY_MAX_LENGTH,
    SKIP_TOOLS,
    URL_DISPLAY_MAX_LENGTH,
    USER_MESSAGE_TRUNCATE_LENGTH,
)
from helpers.background_agents import is_agent_authored_user_metadata

if TYPE_CHECKING:
    from domains.knowledge_base.types import ContextMessage


# ── Trajectory compression helpers ──────────────────────────────────


def _extract_key_param(tool_name: str, metadata: dict, text: str) -> str:
    """Extract the most important parameter from a tool call for the trajectory line."""
    data = metadata.get("data", {}) or {}

    if tool_name == "web_search":
        return f'"{data.get("query", "")}"' if data.get("query") else ""
    if tool_name == "web_fetch":
        url = data.get("url", "")
        if url:
            try:
                parsed = urlparse(url)
                return parsed.netloc or url[:URL_DISPLAY_MAX_LENGTH]
            except Exception:
                return url[:URL_DISPLAY_MAX_LENGTH]
        return ""
    if tool_name in ("spawn_browser_agent", "spawn_sub_agent", "spawn_claude_code_agent"):
        goal = data.get("goal", "")
        return f'"{goal[:GOAL_DISPLAY_MAX_LENGTH]}"' if goal else ""
    if tool_name == "send_message_to_user":
        return ""

    return ""


def _extract_result_summary(tool_name: str, metadata: dict, text: str) -> str:
    """Extract a concise result summary for the trajectory line."""
    title = metadata.get("title", "")

    if tool_name in ("spawn_browser_agent", "spawn_sub_agent", "spawn_claude_code_agent"):
        return "SUCCESS" if metadata.get("toolStatus") == "FINISHED" else "completed"
    if tool_name == "web_search":
        if "results" in text.lower():
            return text[:60]
        return "results returned"
    if tool_name == "web_fetch":
        return "200" if metadata.get("toolStatus") == "FINISHED" else "fetched"
    if tool_name == "attempt_completion":
        return "SUCCESS"
    if tool_name == "send_message_to_user":
        return "sent"

    if title and len(title) < 50:
        return title
    return "completed"


def build_trajectory_blueprint(  # noqa: C901
    context: list[ContextMessage],
    title: str,
) -> str:
    """Build a condensed trajectory-format blueprint from conversation context.

    Deterministic extraction (no LLM needed). Produces a compact text format:
    - Header: STATUS, COST, DURATION
    - TRAJECTORY: one line per tool call with phase, tool name, key param, result
    - PLAN: full set_plan payload (if present)
    - USER MESSAGES: all user messages verbatim

    Typical output: 400-900 tokens per blueprint (vs ~12K for old JSON format).
    """
    trajectory_lines: list[str] = []
    user_messages: list[str] = []
    plan_json: str | None = None
    cost_dollars = None
    duration_seconds = None
    status = "SUCCESS"
    step = 0
    current_phase = "PLAN"
    seen_tool_calls: set[str] = set()

    for msg in context:
        role = msg.get("role", "")
        metadata = msg.get("metadata", {}) or {}
        text = msg.get("text", "")

        # Collect user messages (skip hidden/system messages)
        if (
            role == "USER"
            and text
            and not metadata.get("hidden")
            and not metadata.get("isCustomSystemPrompt")
            and not is_agent_authored_user_metadata(metadata)
        ):
            user_messages.append(text)

        # Track reasoning steps (ASSISTANT messages without tool calls)
        if role == "ASSISTANT" and text and not metadata.get("tool_calls"):
            trajectory_lines.append(f"  t:{step}  [{current_phase}]  reasoning")
            step += 1

        # Process tool messages
        if role == "TOOL":
            tool_name = metadata.get("toolName", "")
            tool_status = metadata.get("toolStatus", "")
            tool_call_id = metadata.get("toolCallId", "")

            # Skip verifier-feedback rows (now tagged attempt_completion + verifierMessage=True).
            # These are scoring messages, not real tool results.
            if metadata.get("verifierMessage"):
                continue

            # Skip internal tools
            if tool_name in SKIP_TOOLS:
                if tool_name == "completion_summary" and tool_status == "FINISHED":
                    summary_data = metadata.get("completionSummary", {})
                    cost_dollars = summary_data.get("costDollars")
                    duration_seconds = summary_data.get("durationSeconds")
                elif tool_name == "completion_summary" and tool_status == "ERROR":
                    status = "FAILED"
                    summary_data = metadata.get("completionSummary", {})
                    duration_seconds = summary_data.get("durationSeconds")
                continue

            # Skip IN_PROGRESS messages (only care about FINISHED/ERROR)
            if tool_status not in ("FINISHED", "ERROR"):
                continue

            # Dedupe by tool_call_id
            if tool_call_id:
                if tool_call_id in seen_tool_calls:
                    continue
                seen_tool_calls.add(tool_call_id)

            # Extract key param from tool call
            key_param = _extract_key_param(tool_name, metadata, text)

            # Build result summary
            if tool_status == "ERROR" or metadata.get("error"):
                error_text = text[:ERROR_TEXT_MAX_LENGTH] if text else "error"
                result_summary = f"FAILED ({error_text})"
            else:
                result_summary = _extract_result_summary(tool_name, metadata, text)

            # Handle set_plan specially — extract full plan
            if tool_name == "set_plan" and tool_status == "FINISHED":
                plan_data = metadata.get("data", {})
                if plan_data and plan_data.get("tasks"):
                    plan_json = json.dumps(plan_data, indent=2, default=str)
                trajectory_lines.append(
                    f"  t:{step}  [{current_phase}]  set_plan → {len(plan_data.get('tasks', []))} tasks"
                )
                step += 1
                current_phase = "EXECUTE"
                continue

            # Regular tool call
            line = f"  t:{step}  [{current_phase}]  {tool_name}"
            if key_param:
                line += f"({key_param})"
            line += f" → {result_summary}"
            trajectory_lines.append(line)
            step += 1

    # Build the blueprint text
    lines = [f"STATUS: {status}"]
    if cost_dollars is not None:
        lines.append(f"COST: ${cost_dollars}")
    if duration_seconds is not None:
        minutes = duration_seconds // 60
        seconds = duration_seconds % 60
        lines.append(f"DURATION: {minutes}m {seconds}s")

    lines.append("")
    lines.append("TRAJECTORY:")
    if trajectory_lines:
        lines.extend(trajectory_lines)
    else:
        lines.append("  (no tool calls)")

    if plan_json:
        lines.append("")
        lines.append("PLAN:")
        lines.append(plan_json)

    if user_messages:
        lines.append("")
        lines.append("USER MESSAGES:")
        for um in user_messages:
            truncated = um[:USER_MESSAGE_TRUNCATE_LENGTH] + "..." if len(um) > USER_MESSAGE_TRUNCATE_LENGTH else um
            lines.append(f'  - "{truncated}"')

    return "\n".join(lines)
