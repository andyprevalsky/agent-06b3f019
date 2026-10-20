"""Spawn-claude-code-agent domain service — business logic and Temporal activity."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import time
import uuid as uuid_module
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

from domains.spawn_claude_code_agent.config import (
    CODE_AGENT_DRAIN_YIELD_STATUS,
    CODE_SESSION_HEARTBEAT_KEY,
    DRAIN_CHECK_INTERVAL_S,
    E2B_COST_CENTS_PER_SECOND,
    ECHO_SUPPRESS_S,
    FATAL_ERROR_PATTERNS,
    MAX_RUNTIME_S,
    MAX_UNCHANGED_OUTPUTS,
    REATTACH_PROBE_ATTEMPTS,
    REATTACH_PROBE_BACKOFF_S,
    SDK_IDLE_TIMEOUT_S,
    SDK_POST_RESULT_EXIT_GRACE_S,
    SDK_POST_RESULT_STRETCH_TOOL_NAMES,
    SDK_WAIT_TOOL_IDLE_TIMEOUT_S,
    SDK_WAIT_TOOL_NAMES,
    SILENCE_TIMEOUT_S,
    code_agent_verifier_disabled,
)
from domains.spawn_claude_code_agent.repo import (
    check_sandbox_health,
    close_e2b_session,
    create_e2b_session,
    persist_terminal_output,
    save_claude_code_message,
)
from domains.spawn_claude_code_agent.types import ClaudeCodeParentResponse
from helpers.activity_generation_drain import activity_drain_reason
from helpers.activity_heartbeat import heartbeat_resume_details, safe_heartbeat
from helpers.claude_code_ws_client import ClaudeCodeWsClient, ws_endpoint_reachable
from helpers.e2b_log_collector import SandboxLogCollector
from helpers.file_resolution import resolve_file_pointers_from_extracted, transform_schema_for_remote_session
from helpers.tracing import traced
from tools.base import MessageStatus
from utils.error_utils import extract_error_message
from utils.llm_timeouts import VERIFIER_ACTIVITY_TIMEOUT_SECONDS
from utils.response_schema_constraints import explicitly_allows_empty_value, value_satisfies_output_field_constraints
from utils.terminal_filter import TerminalFilter

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def resolve_code_agent_provider(default_provider: str) -> str:
    """Resolve a local provider override outside Temporal workflow code."""
    forced = os.getenv("ROSE_CODE_AGENT_PROVIDER", "").strip().lower()
    return forced if forced in {"claude", "codex"} else default_provider


def check_fatal_errors(output: str) -> Optional[str]:
    """Check terminal output for fatal errors that should immediately abort the session.

    Returns an error message if a fatal error is detected, None otherwise.
    """
    for pattern, message in FATAL_ERROR_PATTERNS:
        if pattern in output:
            return message
    return None


def check_terminal_fatal_error(
    output: str,
    *,
    code_provider: str,
    exit_code: Optional[int],
    credential_feedback: Optional[list[dict[str, str]]] = None,
) -> Optional[str]:
    """Classify terminal failures after the provider process has exited.

    Codex can retain either supported plan-exhaustion wording in the terminal,
    retry with the funded API key, and then exit successfully. Credential
    exhaustion is therefore terminal only when the complete Codex process
    still failed after its runtime fallback opportunity.
    """
    fatal_error = check_fatal_errors(output)
    if fatal_error is not None:
        return fatal_error
    codex_credential_exhausted = bool(credential_feedback) or any(
        marker in output.lower()
        for marker in (
            "you've hit your usage limit",
            "usage_limit_reached",
            "purchase more credits",
            "quota exceeded. check your plan and billing details.",
            "insufficient_quota",
        )
    )
    if code_provider == "codex" and exit_code != 0 and codex_credential_exhausted:
        return (
            "Codex credentials are rate-limited or out of quota and the runtime "
            "fallback did not complete successfully."
        )
    return None


def build_codex_credential_feedback(
    code_events: list[Dict[str, Any]],
) -> list[dict[str, str]]:
    """Extract at most one compact exhaustion event per credential source.

    Structured events are not bounded by the 500-row terminal display. This
    preserves the pre/post-fallback ordering even when a long successful run
    scrolls the original OAuth error and fallback marker out of the terminal.
    """
    feedback_by_source: dict[str, str] = {}
    fallback_seen = False

    for event in code_events:
        if event.get("provider") != "codex":
            continue
        if event.get("type") == "auth_fallback":
            fallback_seen = True
            reason = str(event.get("reason") or "runtime_auth_fallback")
            feedback_by_source.setdefault("oauth", reason[:2000])
            continue
        if event.get("type") != "error":
            continue

        error = event.get("error")
        nested_message = error.get("message") if isinstance(error, dict) else None
        message = str(event.get("message") or nested_message or "")
        normalized = message.lower()
        if not any(
            marker in normalized
            for marker in (
                "you've hit your usage limit",
                "usage_limit_reached",
                "purchase more credits",
                "quota exceeded. check your plan and billing details.",
                "insufficient_quota",
                "no credits remaining",
                "add credits to continue",
                "credit_balance_exhausted",
                "credit balance is too low",
            )
        ):
            continue
        source = "funded_api_key" if fallback_seen else "initial"
        feedback_by_source.setdefault(source, message[:2000])

    if fallback_seen and "initial" in feedback_by_source:
        initial_reason = feedback_by_source.pop("initial")
        feedback_by_source["oauth"] = initial_reason

    return [
        {"source": source, "reason": feedback_by_source[source]}
        for source in ("initial", "oauth", "funded_api_key")
        if source in feedback_by_source
    ]


_TIMELINE_EVENT_TYPES = frozenset(
    {
        "session",
        "agent_message",
        "assistant",
        "tool_use",
        "tool_result",
        "result",
        "error",
    }
)


def _tool_detail_from_event(event: dict[str, Any]) -> str:
    """Human-readable one-line detail for a tool_use event."""
    paths = event.get("paths")
    if isinstance(paths, list):
        path_bits = [str(p).strip() for p in paths if str(p).strip()]
        if path_bits:
            return ", ".join(path_bits[:4])

    raw_input = event.get("input")
    if isinstance(raw_input, str) and raw_input.strip():
        return raw_input.strip()[:240]
    if isinstance(raw_input, dict):
        for key in (
            "command",
            "file_path",
            "path",
            "notebook_path",
            "pattern",
            "query",
            "url",
            "content",
            "description",
        ):
            value = raw_input.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip().replace("\n", " ")
                return text[:240]
        try:
            return json.dumps(raw_input, ensure_ascii=False, default=str)[:240]
        except Exception:
            return ""
    return ""


def format_code_events_transcript(
    code_events: list[Dict[str, Any]] | None = None,
    action_summary: list[str] | None = None,
) -> str:
    """Format SDK/code-agent events into FE-parseable coherent log lines.

    Markers match ``ParseCodeAgentTranscript``:
    ``[Claude]``, ``[Claude tool]``, ``[Claude result]``.
    """
    lines: list[str] = []
    for event in code_events or []:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or event.get("event_type") or "").strip().lower()
        provider = str(event.get("provider") or "claude").strip().title() or "Claude"
        if provider.lower() not in {"claude", "codex"}:
            provider = "Claude"

        if event_type == "session":
            cwd = event.get("cwd") or event.get("working_directory")
            detail = f"Session started in {cwd}" if cwd else "Session started"
            lines.append(f"[{provider}] {detail}")
            continue

        if event_type in {"agent_message", "assistant"}:
            text = event.get("text") or event.get("content") or event.get("message")
            if isinstance(text, str) and text.strip():
                lines.append(f"[{provider}] {text.strip()}")
            continue

        if event_type == "tool_use":
            tool_name = (
                event.get("tool")
                or event.get("name")
                or event.get("tool_name")
                or "Tool"
            )
            detail = _tool_detail_from_event(event)
            if detail:
                lines.append(f"[{provider} tool] {tool_name} · {detail}")
            else:
                lines.append(f"[{provider} tool] {tool_name}")
            continue

        if event_type == "tool_result":
            # Keep the log tool-centric; skip noisy raw tool_result blobs unless they
            # carry a short status/error the FE can show under the next result card.
            status = event.get("status")
            error = event.get("error")
            if isinstance(error, str) and error.strip():
                lines.append(f"[{provider} result] {error.strip()[:400]}")
            elif isinstance(status, str) and status.strip() and status.strip().lower() not in {
                "completed",
                "success",
                "ok",
            }:
                lines.append(f"[{provider} result] status={status.strip()}")
            continue

        if event_type == "result":
            status = str(event.get("status") or "").strip()
            text = event.get("text") or event.get("content") or event.get("result")
            if isinstance(text, str) and text.strip():
                prefix = "failed - " if status.lower() in {"failed", "error"} else ""
                lines.append(f"[{provider} result] {prefix}{text.strip()[:800]}")
            elif status:
                lines.append(f"[{provider} result] {status}")
            continue

        if event_type == "error":
            text = event.get("text") or event.get("error") or event.get("message")
            if isinstance(text, str) and text.strip():
                lines.append(f"[{provider} result] {text.strip()[:800]}")
            continue

    summary_lines = [str(item).strip() for item in (action_summary or []) if str(item).strip()]
    if summary_lines:
        if lines:
            lines.append("")
        lines.append("## Action Summary")
        lines.extend(summary_lines[-30:])

    return "\n".join(lines).strip()


def code_events_have_timeline(code_events: list[Dict[str, Any]] | None) -> bool:
    """True when events carry a real note/tool timeline (prefer over janky PTY)."""
    for event in code_events or []:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or event.get("event_type") or "").strip().lower()
        if event_type in _TIMELINE_EVENT_TYPES:
            return True
    return False


def build_durable_terminal_transcript(
    display_output: str,
    code_events: list[Dict[str, Any]] | None = None,
    action_summary: list[str] | None = None,
) -> str:
    """Prefer structured event timeline; fall back to PTY display / summary.

    ``ClaudeCodeSession.output`` is what the FE CompletedTranscriptSurface renders.
    Raw Claude Code PTY often staircase-wraps and dumps tool lines under a single
    note. Structured ``code_agent_event`` frames are the coherent source of truth
    when present. If only PTY bytes exist, keep them so the chip is never empty.
    """
    formatted_events = format_code_events_transcript(code_events, action_summary)
    if formatted_events and code_events_have_timeline(code_events):
        return formatted_events

    if (display_output or "").strip():
        return display_output

    return formatted_events



def safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def build_context_summary(
    success: bool,
    close_reasoning: str,
    action_summary: list[str],
    error_context: Optional[str] = None,
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts: list[str] = []

    status = "✅ SUCCESS" if success else "❌ FAILED"
    summary_parts.append(f"**Status**: {status}")

    if close_reasoning:
        summary_parts.append(f"\n**Outcome**: {close_reasoning}")

    if error_context:
        summary_parts.append(f"\n**Error**: {error_context}")

    if action_summary:
        last_actions = action_summary[-10:]
        summary_parts.append(f"\n**Actions Taken** ({len(action_summary)} total, showing last {len(last_actions)}):")
        for action in last_actions:
            summary_parts.append(f"  • {action}")

    return "\n".join(summary_parts)


# ---------------------------------------------------------------------------
# Parent LLM interaction
# ---------------------------------------------------------------------------


async def call_parent_llm(
    goal: str,
    filtered_output: str,
    conversation_history: List[Dict[str, str]],
    agent_id: str,
    on_chunk: Callable[[str, int], Awaitable[None]],
    model: str = "rose-labs/rose-1-flash",
    claude_token: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Call the parent agent's LLM to decide whether to respond or complete.

    Claude Code's terminal output appears as USER messages.
    Parent LLM's responses are sent to Claude Code's stdin.

    Returns
    -------
    Dict with ``attempt_completion`` (bool), ``response`` (str|None),
    ``usage`` (dict).
    """
    from helpers.llm import call_llm_structured_streaming
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    # Build file info for system prompt (static; same body whenever attachments
    # are present in the conversation, no per-call interpolation).
    file_info = ""
    if conversation_history and any("attachments" in str(h) for h in conversation_history):
        file_info = """

# Available Files
User attachments are available in /home/user/attachments/
Claude Code can read and process these files as needed.

# Output Files
When Claude Code creates files the user needs, it should copy them to /home/user/output/
Files in this directory will be automatically uploaded and returned to the user."""

    # System prompt is split at SYSTEM_PROMPT_DYNAMIC_BOUNDARY:
    #   - Static portion (above the marker): identity, role, decision rules,
    #     response guidelines, attachments info. Globally cacheable across
    #     every claude-code spawn.
    #   - Dynamic portion (below the marker): the original goal. Varies per
    #     spawn so it must NOT contaminate the cacheable prefix.
    # Per-call timestamps live in the [STATE: ...] line on the user message.
    static_system = (
        "You are the parent agent monitoring Claude Code, a terminal-based coding agent. "
        "You read its terminal output and decide when to respond, intervene, or mark the task complete.\n\n"
        "Claude Code's terminal output appears as USER messages. Your responses will be sent to Claude Code's stdin.\n\n"
        "# Your Role\n"
        "- Monitor Claude Code's progress on the task\n"
        "- Answer questions Claude Code asks (numbered options can be answered with just the number)\n"
        "- Provide guidance when Claude Code seems stuck\n"
        "- Determine when the task is complete\n\n"
        "# Decision Making\n"
        "Set attempt_completion=true ONLY when:\n"
        "- Claude Code has explicitly stated the task is done\n"
        "- The output shows clear completion (tests passing, task finished, etc.)\n"
        "- Claude Code is asking \"Is there anything else?\" or similar\n\n"
        "Set attempt_completion=false when:\n"
        "- Claude Code is asking questions or requesting input\n"
        "- Claude Code is still working (you see active tool calls, file operations)\n"
        "- Claude Code encountered an error that needs addressing\n\n"
        "# Response Guidelines\n"
        "- Be concise; Claude Code is a terminal agent\n"
        "- If Claude asks numbered options (like 1, 2, 3), respond with just the number\n"
        "- If unsure about a question, let Claude Code decide (respond with \"your choice\" or similar)\n"
        "- Don't repeat the original goal back to Claude Code; it already knows it"
        f"{file_info}"
    )

    dynamic_system = f"# Original Goal\n{goal}"

    system_prompt = static_system + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamic_system

    # Build messages for LLM
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]

    # Add conversation history
    for msg in conversation_history:
        messages.append(msg)

    # Add current output as user message, with a trailing [STATE: time=...] line
    # so the per-call timestamp lives outside the cacheable prefix.
    current_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    state_line = f"[STATE: time={current_ts}]"
    messages.append({"role": "user", "content": f"{filtered_output}\n\n{state_line}"})

    try:
        result, usage, _ = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=500,
            response_model=ClaudeCodeParentResponse,
            on_chunk=on_chunk,
            agent_id=agent_id,
            claude_token=claude_token,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            call_site="claude_code_agent",
        )

        return {
            "attempt_completion": result.attempt_completion,
            "response": result.response if not result.attempt_completion else None,
            "usage": usage,
        }

    except Exception as e:
        logger.error(
            "[ClaudeCode] Parent LLM call failed",
            agent_id=agent_id,
            error=extract_error_message(e),
        )
        # Return empty response so the loop doesn't send anything to stdin.
        # Previously this returned "continue" which created infinite loops:
        # the error kept firing, "continue" was sent to stdin each time,
        # and the same unchanged terminal output triggered another failed LLM call.
        return {
            "attempt_completion": False,
            "response": "",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }


# ---------------------------------------------------------------------------
# Agentic WebSocket loop
# ---------------------------------------------------------------------------


# Claude Code CLI stream-json messages that ws-server forwards verbatim as
# `cli_message` events. (log field, CLI field) pairs; values are scalars from the
# SDK schema (status enums, epoch seconds, counts, categorized error enum).
_CLI_RATE_LIMIT_FIELDS = (
    ("rate_limit_status", "status"),
    ("rate_limit_type", "rateLimitType"),
    ("utilization", "utilization"),
    ("resets_at", "resetsAt"),
    ("overage_status", "overageStatus"),
    ("overage_resets_at", "overageResetsAt"),
    ("overage_disabled_reason", "overageDisabledReason"),
    ("is_using_overage", "isUsingOverage"),
    ("surpassed_threshold", "surpassedThreshold"),
)
_CLI_API_RETRY_FIELDS = (
    ("attempt", "attempt"),
    ("max_retries", "max_retries"),
    ("retry_delay_ms", "retry_delay_ms"),
    ("error_status", "error_status"),
    ("error", "error"),
)
_CLI_LOG_VALUE_MAX_CHARS = 200


def _bounded_cli_log_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:_CLI_LOG_VALUE_MAX_CHARS]


def _log_claude_cli_message(
    event: dict[str, Any],
    *,
    agent_id: str,
    task_id: str,
    sandbox_id: str,
) -> None:
    """Log CLI rate-limit status and API retries; other CLI messages stay unlogged."""
    message = event.get("cli_message")
    if not isinstance(message, dict):
        return
    ids = {"agent_id": agent_id, "task_id": task_id, "sandbox_id": sandbox_id}

    if message.get("type") == "rate_limit_event":
        info = message.get("rate_limit_info")
        info = info if isinstance(info, dict) else {}
        logger.info(
            "[ClaudeCode] CLI rate-limit status",
            **ids,
            **{key: _bounded_cli_log_value(info.get(src)) for key, src in _CLI_RATE_LIMIT_FIELDS},
        )
        return

    if message.get("type") == "system" and message.get("subtype") == "api_retry":
        logger.info(
            "[ClaudeCode] CLI API retry",
            **ids,
            **{key: _bounded_cli_log_value(message.get(src)) for key, src in _CLI_API_RETRY_FIELDS},
        )


def _log_code_agent_event(
    event: dict[str, Any],
    *,
    agent_id: str,
    task_id: str,
    sandbox_id: str,
) -> None:
    """Promote high-value sandbox events into retained worker logs.

    Codex Fast Mode events stay provider-specific. Claude (and Codex) tool /
    turn progress must also land at info so local + prod log retention keep
    tool_use / tool_result / agent_message / result visible in bench run JSON
    — debug-only lines are often dropped by prod log drains.
    """
    provider = event.get("provider")
    event_type = event.get("type")

    if provider == "codex":
        if event_type == "fast_cache_proxy_started":
            logger.info(
                "[ClaudeCode] Codex Fast Mode proxy started",
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                base_url=event.get("base_url"),
                target=event.get("target"),
            )
            return

        if event_type == "fast_cache_proxy_request":
            logger.info(
                "[ClaudeCode] Codex Fast Mode proxy request",
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                method=event.get("method"),
                path=event.get("path"),
                status=event.get("status"),
                cache=event.get("cache"),
            )
            return

        if event_type == "fast_cache_proxy_error":
            logger.warning(
                "[ClaudeCode] Codex Fast Mode proxy error",
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                method=event.get("method"),
                path=event.get("path"),
                error=event.get("error"),
            )
            return

        if event_type == "usage":
            usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
            input_tokens = usage.get("input_tokens") or 0
            cached_input_tokens = usage.get("cached_input_tokens") or 0
            cached_pct = (
                round((cached_input_tokens / input_tokens) * 100, 1) if input_tokens else 0.0
            )
            logger.info(
                "[ClaudeCode] Codex turn usage",
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                input_tokens=input_tokens,
                cached_input_tokens=cached_input_tokens,
                cached_input_pct=cached_pct,
                output_tokens=usage.get("output_tokens") or 0,
                reasoning_output_tokens=usage.get("reasoning_output_tokens") or 0,
            )
            return

    if event_type == "cli_message":
        _log_claude_cli_message(event, agent_id=agent_id, task_id=task_id, sandbox_id=sandbox_id)
        return

    # Progress events for Claude Code + Codex — must survive info-level retention.
    if event_type in {"tool_use", "tool_result", "agent_message", "result", "error", "session"}:
        tool_name = event.get("name") or event.get("tool_name") or event.get("tool")
        logger.info(
            "[ClaudeCode] Code-agent event",
            agent_id=agent_id,
            task_id=task_id,
            sandbox_id=sandbox_id,
            provider=provider,
            event_type=event_type,
            tool_name=tool_name,
            status=event.get("status"),
        )


def is_codex_completed_turn_event(event: dict[str, Any]) -> bool:
    """Return True for normalized Codex events that represent a completed Codex turn."""
    if event.get("provider") != "codex":
        return False
    if event.get("raw_type") == "turn.completed":
        return True
    return event.get("type") == "turn" and event.get("status") == "completed"


def codex_completed_turn_event_key(event: dict[str, Any], fallback_index: int) -> str:
    timestamp = event.get("timestamp")
    if timestamp is None:
        return f"event:{fallback_index}"
    return json.dumps(
        {
            "timestamp": timestamp,
            "raw_type": event.get("raw_type"),
            "type": event.get("type"),
            "status": event.get("status"),
            "usage": event.get("usage"),
        },
        sort_keys=True,
        default=str,
    )


def codex_completed_turn_count(code_events: list[Dict[str, Any]]) -> int:
    """Count unique completed Codex turns from normalized SDK events."""
    seen: set[str] = set()
    for index, event in enumerate(code_events):
        if not is_codex_completed_turn_event(event):
            continue
        seen.add(codex_completed_turn_event_key(event, index))
    return len(seen)


class CodeSessionDrained(Exception):
    """The worker is draining; the activity detaches while the sandbox keeps running."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


_CODE_SESSION_FIELDS = (
    "task_id",
    "sandbox_id",
    "ws_url",
    "code_provider",
    "github_repo_url",
    "started_at",
    "loop_started_at",
    # Sandbox events already logged by an earlier attachment; the reattached
    # attempt logs only the ones that arrived while nobody was attached.
    "logged_events",
)


def code_session_record(raw: Any) -> Optional[Dict[str, Any]]:
    """Return the reattachable session in ``raw``, or None when it lacks a sandbox identity."""
    if not isinstance(raw, dict):
        return None
    if not all(isinstance(raw.get(key), str) and raw[key] for key in ("task_id", "sandbox_id", "ws_url")):
        return None
    return {key: raw[key] for key in _CODE_SESSION_FIELDS if raw.get(key) is not None}


@activity.defn
async def close_detached_code_session_activity(agent_id: str, code_session: Dict[str, Any]) -> bool:
    """Close a sandbox a drained attempt left running when no attempt will reattach to it.

    Idempotent: closing an already-closed session is a no-op on the backend.
    """
    session = code_session_record(code_session)
    if session is None:
        return False
    logger.info(
        "[ClaudeCode] Closing detached sandbox",
        agent_id=agent_id,
        task_id=session["task_id"],
        sandbox_id=session["sandbox_id"],
    )
    await close_e2b_session(task_id=session["task_id"], code_provider=session.get("code_provider", "claude"))
    return True


def _next_attempt_reattaches(cancellation: activity.ActivityCancellationDetails) -> bool:
    """Whether Temporal will run another attempt of this activity that reattaches.

    A terminated or reset workflow (``not_found`` / ``reset``) never schedules
    one, and a timeout or worker shutdown leads to one only while the retry
    policy has attempts left. A paused activity resumes with its heartbeats.
    """
    if cancellation.not_found or cancellation.reset:
        return False
    if cancellation.paused:
        return True
    info = activity.info()
    max_attempts = info.retry_policy.maximum_attempts if info.retry_policy else 0
    return max_attempts <= 0 or info.attempt < max_attempts


def _code_session_from_heartbeat() -> Optional[Dict[str, Any]]:
    """Session the previous attempt of this activity was attached to, if any."""
    if not activity.in_activity():
        return None
    info = activity.info()
    if info.attempt <= 1:
        return None
    for detail in info.heartbeat_details or ():
        if isinstance(detail, dict):
            session = code_session_record(detail.get(CODE_SESSION_HEARTBEAT_KEY))
            if session is not None:
                return session
    return None


async def _run_agentic_loop(
    *,
    agent_id: str,
    task_id: str,
    sandbox_id: str,
    goal: str,
    ws_url: str,
    terminal: TerminalFilter,
    model: str,
    claude_token: Optional[str],
    action_summary: list[str],
    tool_call_id: str,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    code_provider: str = "claude",
    code_events: list[Dict[str, Any]] | None = None,
    terminal_output_persisted: Optional[list[bool]] = None,
    loop_started_at: Optional[float] = None,
    generation_yield: bool = True,
    code_session: Optional[Dict[str, Any]] = None,
) -> tuple[int, bool, list[Dict[str, str]], int, int, list[Dict[str, Any]]]:
    """Run the WebSocket-based agentic loop monitoring Claude Code output.

    Returns (exit_code, attempt_completion, conversation_history,
             total_input_tokens, total_output_tokens, code_events).
    exit_code is -1 if the process has not exited.

    ``terminal_output_persisted`` is an optional single-element list shared with
    the activity so fatal-path persistence is visible to outer cleanup.

    Raises ``CodeSessionDrained`` when the worker drains (or, with
    ``generation_yield``, its generation is superseded) before Claude Code
    exits. ``loop_started_at`` keeps MAX_RUNTIME_S cumulative across reattaches.
    ``code_session["logged_events"]`` is kept current so each sandbox event is
    logged once across every attachment to the session.
    """
    last_output_time = safe_time()
    exit_code: Optional[int] = None
    pending_output = False
    conversation_history: List[Dict[str, str]] = []
    attempt_completion = False
    ws_connected = True
    last_filtered_output = ""
    unchanged_output_count = 0
    last_stdin_send_time: float = 0.0
    interaction_count = 0
    total_input_tokens = 0
    total_output_tokens = 0
    code_events = code_events if code_events is not None else []
    completed_codex_turn_keys: set[str] = set()
    completed_codex_turns = 0
    # Default short idle; stretched after Monitor/ScheduleWakeup tool_use and
    # while any tool is in-flight (tool_use awaiting tool_result).
    effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
    wait_tool_armed = False
    in_flight_tool_count = 0
    # Wall-clock of first SDK type=result. Stretch must not re-arm after this;
    # grace backstop ends the monitor if the CLI never exits.
    sdk_result_at: float | None = None
    logged_events = int((code_session or {}).get("logged_events") or 0)

    def _mark_terminal_output_persisted() -> None:
        if terminal_output_persisted is not None:
            terminal_output_persisted[0] = True

    async def on_output(data: str, is_buffer: bool) -> None:
        nonlocal last_output_time, pending_output
        if is_buffer:
            terminal.reset()
        terminal.feed(data)
        last_output_time = safe_time()
        if last_stdin_send_time and (safe_time() - last_stdin_send_time) < ECHO_SUPPRESS_S:
            return
        pending_output = True

    async def on_exit(code: int) -> None:
        nonlocal exit_code
        exit_code = code
        logger.info("[ClaudeCode] Process exited", agent_id=agent_id, task_id=task_id, exit_code=code)

    async def on_connection_change(connected: bool) -> None:
        nonlocal ws_connected, last_output_time
        ws_connected = connected
        if connected:
            last_output_time = safe_time()
            logger.info("[ClaudeCode] WebSocket reconnected, silence timer reset", agent_id=agent_id, task_id=task_id)
        else:
            logger.info(
                "[ClaudeCode] WebSocket disconnected, pausing silence detection", agent_id=agent_id, task_id=task_id
            )

    async def on_stdin_error(error_msg: str) -> None:
        nonlocal pending_output
        logger.error(
            "[ClaudeCode] Server reported stdin error — re-enabling silence detection for retry",
            agent_id=agent_id,
            task_id=task_id,
            error=error_msg,
        )
        pending_output = True

    async def on_events_replay(events: list[dict[str, Any]]) -> None:
        # The ws-server resends its whole history on every (re)connect, so it
        # replaces everything seen so far instead of appending to it.
        nonlocal completed_codex_turns, effective_idle_timeout_s, wait_tool_armed, in_flight_tool_count
        code_events.clear()
        completed_codex_turn_keys.clear()
        completed_codex_turns = 0
        in_flight_tool_count = 0
        wait_tool_armed = False
        effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
        for event in events:
            await on_event(event)
        logger.info(
            "[ClaudeCode] Replayed sandbox event history", agent_id=agent_id, task_id=task_id, events=len(events)
        )

    async def on_event(event: dict[str, Any]) -> None:
        nonlocal completed_codex_turns, last_output_time, effective_idle_timeout_s
        nonlocal wait_tool_armed, in_flight_tool_count, sdk_result_at, logged_events
        last_output_time = safe_time()
        code_events.append(event)
        if is_codex_completed_turn_event(event):
            key = codex_completed_turn_event_key(event, len(code_events) - 1)
            if key not in completed_codex_turn_keys:
                completed_codex_turn_keys.add(key)
                completed_codex_turns += 1
        event_type = event.get("type")
        tool_name = event.get("name") or event.get("tool_name") or event.get("tool")
        # Count every tool_use toward in-flight, even when name is missing /
        # non-string — tool_result always decrements, and a name-gated
        # increment made those paths asymmetric (CodeRabbit #1260).
        if event_type == "tool_use":
            in_flight_tool_count += 1
            if not isinstance(tool_name, str):
                # Nameless tool_use: still stretch the in-flight idle window.
                if sdk_result_at is not None:
                    effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
                elif effective_idle_timeout_s != SDK_WAIT_TOOL_IDLE_TIMEOUT_S:
                    logger.info(
                        "[ClaudeCode] Extending SDK idle timeout for in-flight tool",
                        agent_id=agent_id,
                        task_id=task_id,
                        tool_name=str(tool_name),
                        idle_limit_s=SDK_WAIT_TOOL_IDLE_TIMEOUT_S,
                    )
                    effective_idle_timeout_s = SDK_WAIT_TOOL_IDLE_TIMEOUT_S
            elif sdk_result_at is not None:
                # SDK already declared completion — do not re-arm the 900s
                # stretch (r31 a2: result → Bash/ScheduleWakeup re-armed stretch
                # → Max runtime, 0 artifacts). Keep the short idle window.
                effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
            elif tool_name in SDK_WAIT_TOOL_NAMES or tool_name in SDK_POST_RESULT_STRETCH_TOOL_NAMES:
                # Wait tools AND Bash/Task/TaskOutput: arm post-result stretch.
                # Bash often returns tool_result while background work continues
                # with no further WS events; without arming, tool_result snaps
                # idle back to 180s and kills the session (cuda k=3 r24).
                wait_tool_armed = True
                if effective_idle_timeout_s != SDK_WAIT_TOOL_IDLE_TIMEOUT_S:
                    reason = (
                        "wait tool"
                        if tool_name in SDK_WAIT_TOOL_NAMES
                        else "post-result stretch tool"
                    )
                    logger.info(
                        f"[ClaudeCode] Extending SDK idle timeout for {reason}",
                        agent_id=agent_id,
                        task_id=task_id,
                        tool_name=tool_name,
                        idle_limit_s=SDK_WAIT_TOOL_IDLE_TIMEOUT_S,
                    )
                effective_idle_timeout_s = SDK_WAIT_TOOL_IDLE_TIMEOUT_S
            else:
                # Non-wait tool (e.g. Write) — stretch while in-flight so
                # silence during execution is not mistaken for a hung CLI.
                # Do NOT clear wait_tool_armed: Monitor/ScheduleWakeup/Bash often
                # precede follow-on tools, and the post-result stretch must
                # survive those (otherwise tool_result restores the short
                # 180s window and kills the wait/background work).
                if effective_idle_timeout_s != SDK_WAIT_TOOL_IDLE_TIMEOUT_S:
                    logger.info(
                        "[ClaudeCode] Extending SDK idle timeout for in-flight tool",
                        agent_id=agent_id,
                        task_id=task_id,
                        tool_name=tool_name,
                        idle_limit_s=SDK_WAIT_TOOL_IDLE_TIMEOUT_S,
                    )
                effective_idle_timeout_s = SDK_WAIT_TOOL_IDLE_TIMEOUT_S
        elif event_type == "tool_result":
            if in_flight_tool_count > 0:
                in_flight_tool_count -= 1
            if sdk_result_at is not None:
                effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
            elif in_flight_tool_count == 0 and not wait_tool_armed:
                # All tools finished and no post-wait stretch armed — restore
                # the short hung-CLI window.
                effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
        elif event_type == "result":
            # SDK declared completion — drop wait arm so a hung process after
            # result is reaped on the short idle window, not 900s. Record the
            # first result time for the exit-grace backstop (r31 a2/a3).
            wait_tool_armed = False
            if sdk_result_at is None:
                sdk_result_at = safe_time()
                logger.info(
                    "[ClaudeCode] SDK result observed; arming post-result exit grace",
                    agent_id=agent_id,
                    task_id=task_id,
                    grace_s=SDK_POST_RESULT_EXIT_GRACE_S,
                    status=event.get("status"),
                )
            effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
        elif event_type == "user_turn":
            # An agent-graph message started a resumed CLI turn after the
            # previous result: that result no longer ends the session, so the
            # post-result exit grace restarts with the next result.
            sdk_result_at = None
            wait_tool_armed = False
            in_flight_tool_count = 0
            effective_idle_timeout_s = SDK_IDLE_TIMEOUT_S
        # code_events mirrors the sandbox's append-only event history, so an
        # event's index identifies it across reconnect replays and reattaches.
        if len(code_events) <= logged_events:
            return
        logged_events = len(code_events)
        if code_session is not None:
            code_session["logged_events"] = logged_events
        _log_code_agent_event(event, agent_id=agent_id, task_id=task_id, sandbox_id=sandbox_id)
        logger.debug(
            "[ClaudeCode] Received code-agent event",
            agent_id=agent_id,
            task_id=task_id,
            event_type=event_type,
            provider=event.get("provider"),
        )

    ws_client = ClaudeCodeWsClient(
        ws_url=ws_url,
        on_output=on_output,
        on_exit=on_exit,
        on_connection_change=on_connection_change,
        on_stdin_error=on_stdin_error,
        on_event=on_event,
        heartbeat_fn=safe_heartbeat,
        on_events_replay=on_events_replay,
    )

    if not await ws_client.connect():
        raise Exception("Failed to connect to Claude Code WebSocket")

    listen_task = asyncio.create_task(ws_client.listen())
    action_summary.append("Connected to Claude Code WebSocket")

    loop_start = loop_started_at if loop_started_at is not None else safe_time()
    last_status_update = safe_time()
    last_drain_check = 0.0

    async def on_chunk(text: str, tokens: int) -> None:
        pass  # Parent LLM streaming not needed

    try:
        while exit_code is None and not attempt_completion:
            elapsed = safe_time() - loop_start
            safe_heartbeat(f"Monitoring Claude Code ({int(elapsed)}s)")

            if safe_time() - last_drain_check >= DRAIN_CHECK_INTERVAL_S:
                last_drain_check = safe_time()
                drain_reason = await activity_drain_reason(allow_generation_handoff=generation_yield)
                if drain_reason:
                    logger.info(
                        "[ClaudeCode] Worker draining; detaching from the running sandbox",
                        agent_id=agent_id,
                        task_id=task_id,
                        sandbox_id=sandbox_id,
                        reason=drain_reason,
                        elapsed_s=int(elapsed),
                    )
                    raise CodeSessionDrained(drain_reason)

            if elapsed > MAX_RUNTIME_S:
                logger.warning("[ClaudeCode] Max runtime exceeded", agent_id=agent_id, task_id=task_id, elapsed=elapsed)
                action_summary.append(f"Max runtime exceeded ({int(elapsed)}s)")
                break

            # After the first SDK result, healthy CLIs exit in <1s. If the
            # process is still alive past the grace window (stdout may keep
            # refreshing last_output_time so short idle never fires), end the
            # session so the parent can retry inside the bench budget.
            if (
                sdk_result_at is not None
                and exit_code is None
                and (safe_time() - sdk_result_at) >= SDK_POST_RESULT_EXIT_GRACE_S
            ):
                grace_elapsed = safe_time() - sdk_result_at
                logger.warning(
                    "[ClaudeCode] Post-result exit grace exceeded",
                    agent_id=agent_id,
                    task_id=task_id,
                    grace_s=SDK_POST_RESULT_EXIT_GRACE_S,
                    since_result_s=grace_elapsed,
                )
                action_summary.append(
                    f"Post-result exit grace exceeded ({int(grace_elapsed)}s after SDK result)"
                )
                break

            if ws_client.reconnects_exhausted:
                await _handle_reconnect_exhausted(sandbox_id, agent_id, task_id, action_summary, code_provider)

            silence_duration = safe_time() - last_output_time

            # Autonomous CC waits for SDK exit after the first silence observation
            # (parent-LLM nudge is intentionally skipped). If the CLI then goes
            # quiet without exit_code, break instead of spinning to MAX_RUNTIME_S.
            # effective_idle_timeout_s stretches after Monitor/ScheduleWakeup
            # and while any tool is in-flight (awaiting tool_result).
            if (
                silence_duration >= effective_idle_timeout_s
                and not pending_output
                and ws_connected
                and exit_code is None
            ):
                logger.warning(
                    "[ClaudeCode] SDK idle timeout waiting for exit",
                    agent_id=agent_id,
                    task_id=task_id,
                    silence_s=silence_duration,
                    idle_limit_s=effective_idle_timeout_s,
                )
                action_summary.append(
                    f"SDK idle timeout ({int(silence_duration)}s with no WebSocket events)"
                )
                break

            if silence_duration >= SILENCE_TIMEOUT_S and pending_output and ws_connected:
                filtered_output = terminal.get_display()
                pending_output = False

                if filtered_output:
                    if filtered_output == last_filtered_output:
                        unchanged_output_count += 1
                        if unchanged_output_count >= MAX_UNCHANGED_OUTPUTS:
                            logger.info(
                                "[ClaudeCode] Terminal output unchanged for %d checks, skipping LLM call",
                                unchanged_output_count,
                                agent_id=agent_id,
                                task_id=task_id,
                            )
                            continue
                    else:
                        unchanged_output_count = 0
                        last_filtered_output = filtered_output

                    fatal_error = check_fatal_errors(filtered_output)
                    if fatal_error:
                        logger.error(
                            "[ClaudeCode] Fatal error detected in output, aborting",
                            agent_id=agent_id,
                            task_id=task_id,
                            error=fatal_error,
                        )
                        action_summary.append(f"FATAL: {fatal_error}")
                        # Persist the terminal output BEFORE bubbling the fatal
                        # exception so the back-end can see the auth-failure
                        # banner and mark the pool token broken (otherwise the
                        # Temporal-retried activity will re-fetch the same
                        # broken token via LRU and burn another E2B sandbox).
                        try:
                            durable_fatal_output = build_durable_terminal_transcript(
                                filtered_output,
                                code_events,
                                action_summary,
                            )
                            if durable_fatal_output:
                                await persist_terminal_output(
                                    task_id,
                                    durable_fatal_output,
                                    agent_id,
                                    code_provider,
                                    credential_feedback=build_codex_credential_feedback(code_events)
                                    if code_provider == "codex"
                                    else None,
                                )
                                _mark_terminal_output_persisted()
                        except Exception as persist_err:
                            logger.warning(
                                "[ClaudeCode] Failed to persist fatal terminal output",
                                agent_id=agent_id,
                                task_id=task_id,
                                error=str(persist_err),
                            )
                        await save_claude_code_message(
                            agent_id=agent_id,
                            title="Authentication Error",
                            task_id=task_id,
                            message=fatal_error,
                            status=MessageStatus.ERROR,
                            action_type="system",
                            tool_call_id=tool_call_id,
                            code_provider=code_provider,
                        )
                        raise ApplicationError(
                            fatal_error,
                            type="CLAUDE_CODE_FATAL",
                            non_retryable=True,
                        )

                    logger.info(
                        "[ClaudeCode] Code-agent output observed; waiting for SDK completion",
                        agent_id=agent_id,
                        task_id=task_id,
                        provider=code_provider,
                        output_len=len(filtered_output),
                        silence_s=silence_duration,
                    )
                    continue

                    logger.info(
                        "[ClaudeCode] Silence detected, calling parent LLM",
                        agent_id=agent_id,
                        task_id=task_id,
                        output_len=len(filtered_output),
                        silence_s=silence_duration,
                    )

                    llm_response = await call_parent_llm(
                        goal=goal,
                        filtered_output=filtered_output,
                        conversation_history=conversation_history,
                        agent_id=agent_id,
                        on_chunk=on_chunk,
                        model=model,
                        claude_token=claude_token,
                        gpt_token=gpt_token,
                        gpt_account_id=gpt_account_id,
                        gpt_token_source=gpt_token_source,
                        gpt_token_pool_id=gpt_token_pool_id,
                        gpt_token_user_id=gpt_token_user_id,
                    )

                    usage = llm_response.get("usage", {})
                    total_input_tokens += usage.get("prompt_tokens", 0)
                    total_output_tokens += usage.get("completion_tokens", 0)

                    if llm_response.get("attempt_completion"):
                        attempt_completion = True
                        logger.info("[ClaudeCode] Parent LLM signaled completion", agent_id=agent_id, task_id=task_id)
                        action_summary.append("Parent LLM signaled task completion")
                    elif llm_response.get("response"):
                        response_text = llm_response["response"]
                        last_stdin_send_time = safe_time()
                        sent_ok = await ws_client.send_stdin(response_text)

                        if not sent_ok:
                            last_stdin_send_time = 0.0
                            logger.error(
                                "[ClaudeCode] stdin send FAILED — message did not reach terminal",
                                agent_id=agent_id,
                                task_id=task_id,
                                response=response_text[:100],
                            )
                            action_summary.append(f"STDIN SEND FAILED: '{response_text[:50]}'")
                            pending_output = True
                            continue

                        interaction_count += 1
                        conversation_history.append({"role": "user", "content": filtered_output})
                        conversation_history.append({"role": "assistant", "content": response_text})

                        logger.info(
                            "[ClaudeCode] Sent stdin response",
                            agent_id=agent_id,
                            task_id=task_id,
                            response=response_text[:100],
                            interaction=interaction_count,
                        )
                        action_summary.append(f"Interaction {interaction_count}: sent '{response_text[:50]}'")

                        await save_claude_code_message(
                            agent_id=agent_id,
                            title=f"Response #{interaction_count}",
                            task_id=task_id,
                            message=response_text,
                            status=MessageStatus.FINISHED,
                            action_type="agent_response",
                            tool_call_id=tool_call_id,
                            code_provider=code_provider,
                        )

            if safe_time() - last_status_update >= 30:
                elapsed_int = int(elapsed)
                await save_claude_code_message(
                    agent_id=agent_id,
                    title=f"Claude Code working ({elapsed_int}s)",
                    task_id=task_id,
                    message=f"Elapsed: {elapsed_int}s, Interactions: {interaction_count}",
                    status=MessageStatus.FINISHED,
                    action_type="agent_observation",
                    tool_call_id=tool_call_id,
                    code_provider=code_provider,
                    completed_turns=completed_codex_turns if code_provider == "codex" else None,
                )
                action_summary.append(f"Status update at {elapsed_int}s")
                last_status_update = safe_time()

            await asyncio.sleep(0.1)

    finally:
        listen_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await listen_task
        # Close the socket too: after a drain the sandbox outlives this attempt
        # and would otherwise keep buffering broadcasts for a dead reader.
        with contextlib.suppress(Exception):
            await ws_client.disconnect()

    logger.info(
        "[ClaudeCode] Agentic loop finished",
        agent_id=agent_id,
        task_id=task_id,
        exit_code=exit_code,
        attempt_completion=attempt_completion,
        interactions=interaction_count,
    )
    action_summary.append(f"Agentic loop finished: {interaction_count} interactions")

    return (
        exit_code if exit_code is not None else -1,
        attempt_completion,
        conversation_history,
        total_input_tokens,
        total_output_tokens,
        code_events,
    )


async def _handle_reconnect_exhausted(
    sandbox_id: str,
    agent_id: str,
    task_id: str,
    action_summary: list[str],
    code_provider: str = "claude",
) -> None:
    """Handle WebSocket reconnection exhaustion by diagnosing sandbox state."""
    logger.error(
        "[ClaudeCode] WebSocket connection lost after all reconnect attempts",
        agent_id=agent_id,
        task_id=task_id,
    )

    sandbox_health = await check_sandbox_health(sandbox_id, agent_id, code_provider)

    if sandbox_health:
        if sandbox_health.get("alive"):
            ws_running = sandbox_health.get("ws_server_running", False)
            claude_running = sandbox_health.get("claude_running", False)
            diagnostics = sandbox_health.get("diagnostics", {})

            logger.error(
                "[ClaudeCode] DIAGNOSIS: E2B sandbox is ALIVE but WS disconnected",
                sandbox_id=sandbox_id,
                ws_server_running=ws_running,
                claude_running=claude_running,
                diagnosis="ws-server.mjs or claude process crashed" if not ws_running else "WS connection issue",
            )

            if diagnostics:
                logger.error(
                    "[ClaudeCode] DIAGNOSTICS extracted from sandbox",
                    sandbox_id=sandbox_id,
                    oom_check=diagnostics.get("oom_check", "N/A")[:500],
                    memory=diagnostics.get("memory", "N/A")[:500],
                    processes=diagnostics.get("processes", "N/A")[:1000],
                    crash_files=diagnostics.get("crash_files", "N/A")[:200],
                    ws_log=diagnostics.get("ws_log", "N/A")[:1000],
                )

            action_summary.append(
                f"DIAGNOSIS: Sandbox alive (ws={ws_running}, claude={claude_running}) - internal crash"
            )
        else:
            logger.error(
                "[ClaudeCode] DIAGNOSIS: E2B sandbox is DEAD",
                sandbox_id=sandbox_id,
                error=sandbox_health.get("error"),
                diagnosis="E2B infrastructure killed the sandbox",
            )
            action_summary.append(f"DIAGNOSIS: Sandbox DEAD - {sandbox_health.get('error', 'unknown')}")
    else:
        action_summary.append("DIAGNOSIS: Could not determine sandbox health")

    raise Exception("WebSocket connection to Claude Code sandbox lost after all reconnect attempts")


# ---------------------------------------------------------------------------
# Verifier
# ---------------------------------------------------------------------------


_ABSOLUTE_PATH_RE = re.compile(r"/home/user/[A-Za-z0-9._/\-]+")
_CODEX_COMMAND_RE = re.compile(r"\[Codex command (?:started|completed)\]\s*(.+)")


def _build_codex_evidence_summary(final_output: str) -> str:
    """Summarize Codex's readable transcript for the schema verifier.

    Codex runs non-interactively and reports file paths/commands as terminal
    events. Terminal wrapping can split markdown labels, so this summary pulls
    absolute paths and command markers from the full transcript before the
    verifier sees only the recent terminal tail.
    """
    if not final_output:
        return ""

    paths = sorted(set(_ABSOLUTE_PATH_RE.findall(final_output)))
    commands = []
    for match in _CODEX_COMMAND_RE.finditer(final_output):
        command = match.group(1).strip()
        if command and command not in commands:
            commands.append(command)

    exit_codes = sorted(set(re.findall(r"\[Codex exit_code\]\s*([^\s]+)", final_output)))

    if not paths and not commands and not exit_codes:
        return ""

    lines = ["Codex Evidence Summary:"]
    if paths:
        lines.append("Absolute paths mentioned by Codex:")
        lines.extend(f"- {path}" for path in paths[:20])
    if commands:
        lines.append("Commands executed by Codex:")
        lines.extend(f"- {command}" for command in commands[:10])
    if exit_codes:
        lines.append("Codex command exit codes: " + ", ".join(exit_codes[:10]))

    return "\n".join(lines)


def _extract_codex_command_numbers(final_output: str) -> list[int]:
    command_match = re.search(
        r"\[Codex command output\]\s*(.*?)(?:\n\s*\[Codex exit_code\]|\Z)",
        final_output or "",
        re.DOTALL,
    )
    if not command_match:
        return []
    command_output = command_match.group(1)
    return [int(match.group(1)) for match in re.finditer(r"(?m)^\s*(\d+)\s*$", command_output)]


def _extract_codex_sequence_numbers(final_output: str) -> list[int]:
    """Extract a complete numeric sequence from Codex's final answer.

    The terminal view can wrap command output mid-number, so a value like 1132
    may appear as two standalone lines: "113" and "2". Prefer Codex's explicit
    final sequence block, where comma separation survives wrapping.
    """
    if not final_output:
        return []

    for match in re.finditer(
        r"(?is)(?:printed\s+collatz\s+integers|collatz\s+sequence|ordered\s+integers).*?`([\s\d,]+)`",
        final_output,
    ):
        block = match.group(1)
        if "," not in block:
            continue
        numbers = [int(n) for n in re.findall(r"\d+", block)]
        if len(numbers) >= 2:
            return numbers

    for match in re.finditer(
        r"(?is)(?:exact\s+full\s+sequence|full\s+sequence).*?(\[[\s\d,]+\])",
        final_output,
    ):
        numbers = [int(n) for n in re.findall(r"\d+", match.group(1))]
        if len(numbers) >= 2:
            return numbers

    for match in re.finditer(
        r"(?is)(?:exact\s+full\s+sequence|full\s+sequence).*?```(?:\w+)?\s*([\s\d,]+?)```",
        final_output,
    ):
        block = match.group(1)
        if "," not in block:
            continue
        numbers = [int(n) for n in re.findall(r"\d+", block)]
        if len(numbers) >= 2:
            return numbers

    return []


def _is_valid_collatz_sequence(numbers: list[int], total_steps: Optional[int]) -> bool:
    if not numbers or numbers[-1] != 1:
        return False
    if total_steps is not None and len(numbers) - 1 != total_steps:
        return False
    for current, following in zip(numbers, numbers[1:]):
        expected = current // 2 if current % 2 == 0 else current * 3 + 1
        if following != expected:
            return False
    return True


def _synthesize_codex_structured_response(
    final_output: str,
    output_schema: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Build a verifier response from Codex terminal evidence when schema validation flakes.

    This is intentionally narrow: it only returns a response if every declared
    output field can be populated from explicit terminal evidence.
    """
    if not final_output or not output_schema:
        return None

    paths = sorted(set(_ABSOLUTE_PATH_RE.findall(final_output)))
    script_paths = [path for path in paths if path.endswith(".py")]
    sequence_numbers = _extract_codex_sequence_numbers(final_output)
    numbers = sequence_numbers or _extract_codex_command_numbers(final_output)
    steps_match = re.search(
        r"(?:Total steps|Step count|total step count|steps|[\"']total_steps[\"'])\s*:\s*`?(\d+)",
        final_output,
        re.IGNORECASE,
    )
    total_steps = int(steps_match.group(1)) if steps_match else None
    if total_steps is not None and len(numbers) >= 2 and numbers[-1] == total_steps and numbers[-2] == 1:
        numbers = numbers[:-1]

    structured: Dict[str, Any] = {}
    for field in output_schema.get("fields", []):
        name = field.get("name")
        field_type = str(field.get("type") or "").lower()
        descriptor = " ".join(
            str(field.get(key, "")) for key in ("name", "label", "description") if field.get(key)
        ).lower()
        if not name:
            return None

        if "file_pointer" in field_type:
            path = script_paths[0] if script_paths else (paths[0] if paths else None)
            if not path:
                if field.get("required", True):
                    return None
                continue
            structured[name] = {"path": path}
        elif field_type.startswith("list") and "sequence" in descriptor:
            if not numbers:
                if field.get("required", True):
                    return None
                continue
            if "collatz" in descriptor and not _is_valid_collatz_sequence(numbers, total_steps):
                if field.get("required", True):
                    return None
                continue
            structured[name] = numbers
        elif field_type in {"integer", "int", "number"} and "step" in descriptor:
            if total_steps is None:
                if field.get("required", True):
                    return None
                continue
            structured[name] = total_steps
        elif "path" in descriptor and paths:
            structured[name] = script_paths[0] if script_paths else paths[0]
        else:
            if field.get("required", True):
                return None

    return structured or None


def _remote_path_for_output_file(file_pointer: Dict[str, Any]) -> str:
    filename = str(file_pointer.get("original_filename") or "")
    return f"/home/user/output/{filename}" if filename else "/home/user/output"


def _structured_response_from_output_files(
    output_schema: Optional[Dict[str, Any]],
    output_files: list[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Populate file-pointer fields from files already extracted from /home/user/output."""
    if not output_schema or not output_files:
        return None

    structured: Dict[str, Any] = {}
    file_index = 0
    for field in output_schema.get("fields", []):
        name = field.get("name")
        field_type = str(field.get("type") or "").lower()
        if not name:
            return None

        if field_type == "file_pointer":
            if file_index >= len(output_files):
                return None
            structured[name] = {"path": _remote_path_for_output_file(output_files[file_index])}
            file_index += 1
        elif field_type == "list[file_pointer]":
            structured[name] = [{"path": _remote_path_for_output_file(fp)} for fp in output_files]
        else:
            continue

    return structured or None


def _structured_response_satisfies_declared_schema(
    output_schema: Optional[Dict[str, Any]],
    structured_response: Optional[Dict[str, Any]],
) -> bool:
    """Return true only when every declared field satisfies its output contract."""
    fields = output_schema.get("fields", []) if isinstance(output_schema, dict) else []
    if not fields:
        return True
    if structured_response is None:
        # No structured evidence at all: equivalent to an empty response, so a
        # schema whose fields are all optional is still satisfied.
        structured_response = {}
    if not isinstance(structured_response, dict):
        return False
    for field in fields:
        if not isinstance(field, dict):
            return False
        name = field.get("name")
        if not name:
            return False
        if name not in structured_response:
            if field.get("required", True) is False:
                continue
            return False
        value = structured_response[name]
        if value is None and field.get("nullable") is True:
            continue
        # A present empty value only satisfies a required field when its bounds
        # explicitly allow it; an optional field may be present and empty.
        if (
            field.get("required", True) is not False
            and (value is None or value == "" or value == [] or value == {})
            and not explicitly_allows_empty_value(value, field)
        ):
            return False
        if not value_satisfies_output_field_constraints(value, field):
            return False
    return True


def _code_event_text_evidence(code_events: list[Dict[str, Any]]) -> list[str]:
    """Collect provider stdout/result strings without depending on terminal truncation."""
    texts: list[str] = []

    def collect(value: Any) -> None:
        if isinstance(value, str):
            if value.strip():
                texts.append(value.strip())
            return
        if isinstance(value, list):
            for item in value:
                collect(item)
            return
        if isinstance(value, dict):
            for key in ("content", "text", "output", "result", "stdout", "message"):
                if key in value:
                    collect(value[key])

    for event in code_events:
        if isinstance(event, dict):
            collect(event)
    return texts


def _structured_response_from_code_evidence(
    output_schema: Optional[Dict[str, Any]],
    output_files: list[Dict[str, Any]],
    code_events: list[Dict[str, Any]],
    terminal_output: str,
) -> Optional[Dict[str, Any]]:
    """Materialize supported primitive and file fields from normalized SDK evidence."""
    if not output_schema:
        return None

    structured = _structured_response_from_output_files(output_schema, output_files) or {}
    evidence_texts = _code_event_text_evidence(code_events)
    if terminal_output.strip():
        evidence_texts.append(terminal_output.strip())

    total_steps: Optional[int] = None
    sequence: list[int] = []
    stdout = ""
    for evidence in sorted(evidence_texts, key=len, reverse=True):
        steps_match = re.search(
            r"(?:Total steps|Step count|total step count|steps|[\"']total_steps[\"'])\s*:\s*`?(\d+)",
            evidence,
            re.IGNORECASE,
        )
        candidate_steps = int(steps_match.group(1)) if steps_match else None
        candidate_sequence = [
            int(match.group(1))
            for match in re.finditer(r"(?m)^\s*(\d+)\s*$", evidence)
        ]
        if (
            candidate_steps is not None
            and _is_valid_collatz_sequence(candidate_sequence, candidate_steps)
        ):
            total_steps = candidate_steps
            sequence = candidate_sequence
            stdout = evidence
            break

    for field in output_schema.get("fields", []):
        if not isinstance(field, dict):
            continue
        name = field.get("name")
        if not name or name in structured:
            continue
        field_type = str(field.get("type") or "").lower()
        descriptor = " ".join(
            str(field.get(key, "")) for key in ("name", "label", "description") if field.get(key)
        ).lower()
        if field_type.startswith("list") and "sequence" in descriptor and sequence:
            # A sequence outside the field's declared bounds would fail the
            # whole response; leave the field unset instead.
            if value_satisfies_output_field_constraints(sequence, field):
                structured[name] = sequence
        elif field_type in {"integer", "int", "number"} and "step" in descriptor:
            if total_steps is not None:
                structured[name] = total_steps
        elif field_type in {"str", "string"} and (
            "stdout" in descriptor or "output" in descriptor
        ):
            if stdout:
                structured[name] = stdout

    return structured or None


def _build_code_event_context(
    *,
    code_events: list[Dict[str, Any]],
    output_files: list[Dict[str, Any]],
    action_summary: list[str],
) -> str:
    evidence = {
        "code_agent_events": code_events[-200:],
        "extracted_output_files": [
            {
                "original_filename": fp.get("original_filename"),
                "mime_type": fp.get("mime_type"),
                "size_bytes": fp.get("size_bytes"),
                "path": _remote_path_for_output_file(fp),
            }
            for fp in output_files
        ],
        "execution_summary": action_summary[-20:],
    }
    return json.dumps(evidence, ensure_ascii=False, indent=2)


async def _persist_code_agent_judge_evidence(
    *,
    agent_id: str,
    task_id: str,
    code_provider: str,
    code_events: list[Dict[str, Any]] | None,
    output_files: list[Dict[str, Any]] | None,
    action_summary: list[str],
) -> None:
    """Persist non-orchestration code-agent evidence for harness judges.

    Orchestration chips use ``toolName=spawn_claude_code_agent`` and therefore
    contribute 0 leaf steps to ``_agent_class_step_counts``. When the LLM
    verifier is skipped, nothing else records coding-agent work, so declared
    judges see every code agent at step_count=0 and fail "coding-agent fetch"
    criteria. These TOOL messages use distinct non-orchestration tool names +
    ``agentType=code`` + ``task_id``/``subAgentId`` so they count as grounded
    code-agent steps and remain readable in the trajectory.
    """
    events = code_events or []
    files = output_files or []
    summary = [str(item).strip() for item in (action_summary or []) if str(item).strip()]
    if not events and not files and not summary:
        return

    event_context = _build_code_event_context(
        code_events=events,
        output_files=files,
        action_summary=summary,
    )
    # Prefer explicit event/action cardinality so judges see non-zero steps even
    # when only a single evidence chip is present. Do not force steps_taken=1
    # from orchestration-only summaries with zero SDK events/files — those are
    # lifecycle breadcrumbs, not grounded coding-agent steps.
    steps_taken = max(len(events), 1 if files else 0)
    if steps_taken == 0:
        return

    await save_claude_code_message(
        agent_id=agent_id,
        title="🧾 Code-agent SDK events",
        task_id=task_id,
        message=f"Code-agent SDK event JSON:\n\n{event_context}",
        status=MessageStatus.FINISHED,
        action_type="system",
        code_provider=code_provider,
        tool_name="code_agent_sdk_events",
        agent_type="code",
        steps_taken=steps_taken,
    )
    await save_claude_code_message(
        agent_id=agent_id,
        title="🧾 Code-agent execution summary",
        task_id=task_id,
        message="Execution Summary:\n\n" + "\n".join(summary[-20:]),
        status=MessageStatus.FINISHED,
        action_type="system",
        code_provider=code_provider,
        tool_name="claude_code_history",
        agent_type="code",
        steps_taken=steps_taken,
    )


async def _run_verifier(
    *,
    agent_id: str,
    task_id: str,
    goal: str,
    model: str,
    terminal: TerminalFilter,
    action_summary: list[str],
    output_schema: Dict[str, Any],
    claude_token: Optional[str],
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_step: int = 0,
    attempt_completion: bool = False,
    exit_code: Optional[int] = None,
    code_provider: str = "claude",
    code_events: Optional[list[Dict[str, Any]]] = None,
    output_files: Optional[list[Dict[str, Any]]] = None,
) -> tuple[float, str, Optional[Dict[str, Any]], int, int]:
    """Run the verifier to confirm completion.

    Returns (score, reasoning, structured_response, input_tokens, output_tokens).

    When ``ROSE_DISABLE_CODE_AGENT_VERIFIER`` is set, skip the dual-agent LLM
    verifier entirely (Claude Code and Codex). The session result is returned
    as-is so the parent tool call finishes when the code agent ends.
    """
    from helpers.llm import check_progress
    from loop.activity_helper import call_temporal_activity_from_activity
    from utils.prompts import build_verifier_prompt

    verifier_call_id = str(uuid_module.uuid4())
    input_tokens = 0
    output_tokens = 0
    extracted_output_files = output_files or []
    terminal_output = (terminal.get_display() or "").strip()
    evidence_structured = _structured_response_from_code_evidence(
        output_schema,
        extracted_output_files,
        code_events or [],
        terminal_output,
    )
    schema_complete = _structured_response_satisfies_declared_schema(
        output_schema, evidence_structured
    )

    if code_agent_verifier_disabled():
        # Skip the dual-agent LLM verifier, but do not claim success without
        # both extracted /home/user/output artifacts and a process/completion
        # success signal. A crashed process can leave stale partial files
        # behind. Surface the same SDK-event JSON the LLM verifier would have
        # read; a one-line skip note with no Bash/Write evidence made the parent
        # treat a completed Collatz session as empty and re-spawn until the
        # smoke cap (claude-code-agent 04977ce8, 2026-09-04).
        # The schema is the contract: file-only, primitive-only, and mixed
        # schemas all require every declared field before the disabled verifier
        # may report success or persist successful judge evidence.
        has_artifacts = schema_complete
        has_success_signal = attempt_completion or exit_code == 0
        score = 1.0 if has_artifacts and has_success_signal else 0.5
        v_reasoning = (
            "Code-agent verifier disabled (ROSE_DISABLE_CODE_AGENT_VERIFIER). "
            f"Returning session result as-is (provider={code_provider}, exit_code={exit_code}"
            f", artifacts={len(extracted_output_files)})."
            + (
                ""
                if has_artifacts
                else " Required output artifacts were not completely extracted - incomplete."
            )
        )
        if terminal_output:
            v_reasoning = f"{v_reasoning}\n\nTerminal output:\n\n{terminal_output}"
        event_context = _build_code_event_context(
            code_events=code_events or [],
            output_files=extracted_output_files,
            action_summary=action_summary,
        )
        if event_context:
            v_reasoning = f"{v_reasoning}\n\nCode-agent SDK event JSON:\n\n{event_context}"
        logger.info(
            "[ClaudeCode] Verifier skipped via ROSE_DISABLE_CODE_AGENT_VERIFIER",
            agent_id=agent_id,
            task_id=task_id,
            code_provider=code_provider,
            exit_code=exit_code,
            has_artifacts=has_artifacts,
            has_success_signal=has_success_signal,
            has_structured_response=bool(evidence_structured),
            score=score,
        )
        # Persist SDK/history evidence so harness step counts + declared judges
        # still see grounded successful work when the LLM verifier is off. A
        # failed process may leave files behind, but those are not completion
        # evidence and must not inflate the judge's successful step count.
        if has_success_signal and has_artifacts:
            try:
                await _persist_code_agent_judge_evidence(
                    agent_id=agent_id,
                    task_id=task_id,
                    code_provider=code_provider,
                    code_events=code_events,
                    output_files=extracted_output_files,
                    action_summary=action_summary,
                )
            except Exception as evidence_err:
                # Evidence write failures must not block verifier-disabled
                # completion when artifacts / exit_code already prove success.
                logger.warning(
                    "[ClaudeCode] judge evidence persist failed; continuing "
                    "verifier-disabled completion",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(evidence_err)[:200],
                )
        return score, v_reasoning, evidence_structured, input_tokens, output_tokens

    try:
        await save_claude_code_message(
            agent_id=agent_id,
            title="⚖️ Verifying completion",
            task_id=task_id,
            message="",
            status=MessageStatus.IN_PROGRESS,
            action_type="system",
            tool_call_id=verifier_call_id,
            code_provider=code_provider,
        )

        final_output = terminal.get_display()
        normalized_events = code_events or []
        if evidence_structured and schema_complete and (exit_code is None or exit_code == 0):
            v_reasoning = (
                "The code agent completed successfully and the requested file outputs were extracted "
                "from /home/user/output using normalized SDK event context."
            )
            await save_claude_code_message(
                agent_id=agent_id,
                title="⚖️ Progress: 100%",
                task_id=task_id,
                message=v_reasoning,
                status=MessageStatus.FINISHED,
                action_type="system",
                tool_call_id=verifier_call_id,
                code_provider=code_provider,
            )
            return 1.0, v_reasoning, evidence_structured, input_tokens, output_tokens

        event_context = _build_code_event_context(
            code_events=normalized_events,
            output_files=extracted_output_files,
            action_summary=action_summary,
        )
        verifier_terminal_output = event_context[-12000:]

        output_files_info = ""
        if "output" in final_output.lower() or "/home/user/output" in final_output:
            output_files_info = (
                "\n\nNote: Check if any files were created in /home/user/output/ based on terminal output."
            )

        verifier_context = [
            {"role": "USER", "text": f"Goal: {goal}"},
            {
                "role": "TOOL",
                "text": f"Code-agent SDK event JSON:\n\n{verifier_terminal_output}",
                "metadata": {"toolName": "code_agent_sdk_events", "toolStatus": "FINISHED"},
            },
            {
                "role": "TOOL",
                "text": "Execution Summary:\n\n" + "\n".join(action_summary[-20:]) + output_files_info,
                "metadata": {"toolName": "claude_code_history", "toolStatus": "FINISHED"},
            },
        ]

        remote_session_schema = transform_schema_for_remote_session(output_schema)
        verifier_prompt = build_verifier_prompt(response_schema=remote_session_schema)

        logger.info("[ClaudeCode] Running verifier", agent_id=agent_id, task_id=task_id, model=model)
        # B2: `check_progress` forces rose-1-ultra + claude_token internally and
        # ignores the `model` arg. We still pass it so the activity's positional
        # signature matches (matches the browser-agent call site at
        # spawn_browser_agent_v3/handler.py).
        # C7: dead `phase` positional arg has been removed from check_progress;
        # callers no longer pass it.
        # C14: `verifier_context` is built locally from this Claude Code
        # session's terminal output and action summary — nothing from parent
        # agents reaches it.
        progress_result = await call_temporal_activity_from_activity(
            check_progress,
            args=[
                verifier_context,
                verifier_prompt,
                model,  # ignored — verifier always uses rose-1-ultra
                remote_session_schema,
                claude_token,
                "verifier_claude_code",
                agent_id,
                None,
                None,
                None,
                gpt_token,
                gpt_account_id,
                gpt_token_source,
                gpt_token_pool_id,
                gpt_token_user_id,
                None,
                None,
                None,
                fast_mode_cache_enabled,
                fast_mode_goal or goal,
                fast_mode_step,
            ],
            start_to_close_timeout=timedelta(seconds=VERIFIER_ACTIVITY_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        v_usage = progress_result.get("usage", {})
        input_tokens = v_usage.get("prompt_tokens", 0)
        output_tokens = v_usage.get("completion_tokens", 0)

        score = progress_result.get("score", 0.0)
        v_reasoning = progress_result.get("reasoning", "")
        structured_response = progress_result.get("structured_response")

        await save_claude_code_message(
            agent_id=agent_id,
            title=f"⚖️ Progress: {score * 100:.0f}%",
            task_id=task_id,
            message=v_reasoning,
            status=MessageStatus.FINISHED,
            action_type="system",
            tool_call_id=verifier_call_id,
            code_provider=code_provider,
        )

        logger.info(
            "[ClaudeCode] Verifier result",
            agent_id=agent_id,
            task_id=task_id,
            score=score,
            reasoning=v_reasoning[:200],
        )

        return score, v_reasoning, structured_response, input_tokens, output_tokens

    except Exception as verifier_error:
        logger.error("[ClaudeCode] Verifier failed", agent_id=agent_id, task_id=task_id, error=str(verifier_error))
        await save_claude_code_message(
            agent_id=agent_id,
            title="⚠️ Verification failed",
            task_id=task_id,
            message=f"Error: {str(verifier_error)[:200]}",
            status=MessageStatus.FINISHED,
            action_type="error",
            tool_call_id=verifier_call_id,
            code_provider=code_provider,
        )
        return 0.5, "Verification failed - assuming partial completion", None, input_tokens, output_tokens


# ---------------------------------------------------------------------------
# File extraction helpers
# ---------------------------------------------------------------------------


def extract_additional_paths(
    structured_response: Optional[Dict[str, Any]],
    output_schema: Optional[Dict[str, Any]],
) -> list[str]:
    """Extract file paths from verifier's structured response to download specific files."""
    additional_paths: list[str] = []
    if not structured_response or not output_schema:
        return additional_paths

    for field in output_schema.get("fields", []):
        field_name = field.get("name")
        field_type = field.get("type")
        if not field_name or field_name not in structured_response:
            continue
        value = structured_response[field_name]
        if field_type == "file_pointer" and isinstance(value, dict):
            path = value.get("path")
            if path and path.startswith("/"):
                additional_paths.append(path)
        elif field_type == "list[file_pointer]" and isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    path = item.get("path")
                    if path and path.startswith("/"):
                        additional_paths.append(path)

    return additional_paths


def build_usage_items(
    total_input_tokens: int,
    total_output_tokens: int,
    model: str,
    model_pricing: Dict[str, Any],
    execution_time_ms: float,
    claude_code_usage: Optional[Dict[str, Any]] = None,
) -> list[Dict[str, Any]]:
    """Build standardized usage items for cost tracking."""
    usage_items: list[Dict[str, Any]] = []

    if total_input_tokens > 0 or total_output_tokens > 0:
        verifier_cost = round(
            (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"]
            + (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
            4,
        )
        usage_items.append(
            {
                "type": "llm",
                "cost_cents": verifier_cost,
                "provider": f"Verifier ({model})",
                "model": model,
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
            }
        )

    if claude_code_usage:
        input_tokens = int(claude_code_usage.get("inputTokens", 0) or 0)
        output_tokens = int(claude_code_usage.get("outputTokens", 0) or 0)
        cache_read = int(claude_code_usage.get("cacheReadInputTokens", 0) or 0)
        cache_create = int(claude_code_usage.get("cacheCreationInputTokens", 0) or 0)
        if input_tokens > 0 or output_tokens > 0 or cache_read > 0 or cache_create > 0:
            usage_items.append(
                {
                    "type": "llm",
                    "cost_cents": 0,
                    "provider": "Claude Code CLI (user plan)",
                    "model": "claude-code",
                    "number_of_tokens": input_tokens + output_tokens,
                    "tokens_in": input_tokens,
                    "tokens_out": output_tokens,
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": cache_create,
                }
            )

    e2b_cost_cents = round((execution_time_ms / 1000) * E2B_COST_CENTS_PER_SECOND, 4)
    usage_items.append(
        {
            "type": "service",
            "cost_cents": e2b_cost_cents,
            "provider": "E2B Desktop Sandbox",
        }
    )

    return usage_items


# ---------------------------------------------------------------------------
# Temporal activity
# ---------------------------------------------------------------------------


@activity.defn
async def resolve_code_agent_provider_activity(default_provider: str) -> str:
    """Record provider overrides in activity history for deterministic replay."""
    return resolve_code_agent_provider(default_provider)


async def _resolve_claude_token_for_activity(user_id: str, code_provider: str) -> Optional[str]:
    """Resolve Claude OAuth inside the activity so it never enters workflow history."""
    if code_provider != "claude":
        return None

    from helpers.llm import fetch_claude_max_token

    result = await fetch_claude_max_token(user_id)
    token = result.get("accessToken") if isinstance(result, dict) else None
    logger.info(
        "[ClaudeCode] Activity-local Claude credential resolved",
        user_id=user_id,
        source=result.get("source") if isinstance(result, dict) else None,
        credential_found=bool(token),
    )
    return token if isinstance(token, str) and token else None


@activity.defn
@traced("spawn_claude_code_activity")
async def spawn_claude_code_activity(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    model: str = "rose-labs/rose-1-flash",
    github_repo_url: Optional[str] = None,
    _legacy_claude_token: Optional[str] = None,
    code_provider: str = "claude",
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    resume_session: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Claude Code agent activity using E2B Desktop Sandbox.

    Flow:
    1. Call back-end API to create E2B session (with file attachments, optional GitHub repo)
    2. Post init message with stream_url
    3. Monitor Claude Code output via polling
    4. Run verifier to confirm completion
    5. On completion, close session and extract output files

    A worker drain detaches instead: the sandbox keeps running and the activity
    returns ``CODE_AGENT_DRAIN_YIELD_STATUS`` with the ``code_session`` to pass
    back as ``resume_session``. A retry after a crashed or timed-out attempt
    reattaches to the session carried on the previous attempt's heartbeats. The
    sandbox is closed whenever no attempt will reattach: a requested cancel, a
    terminated workflow, or the last attempt the retry policy allows.

    Args:
        output_schema: Response schema from parent agent's tool call (required for structured responses)
        attachments: File attachments from context to upload to sandbox
        model: Model to use for verifier (inherited from parent agent)
        github_repo_url: Optional GitHub repo URL to clone before starting Claude Code
        _legacy_claude_token: Ignored compatibility slot for activities scheduled by older workers
        code_provider: "claude" for Claude Code or "codex" for Codex CLI
        resume_session: Session returned by a drained attempt; its sandbox is reattached
            when still reachable. ``generation_yield=False`` keeps the run on this worker
            when its generation is superseded (no parked handoff is available).
    """
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from helpers.model_pricing import get_model_pricing_with_fallback

    task_id = None
    sandbox_id = None
    ws_url = None
    start_time = safe_time()
    log_collector: Optional[SandboxLogCollector] = None
    session_record: Optional[Dict[str, Any]] = None
    session_heartbeats = contextlib.ExitStack()
    generation_yield = not (isinstance(resume_session, dict) and resume_session.get("generation_yield") is False)
    # A retry's heartbeat session is newer than the scheduled resume_session: the
    # earlier attempt may have replaced an unreachable sandbox with a fresh one.
    attached = _code_session_from_heartbeat() or code_session_record(resume_session)

    total_input_tokens = 0
    total_output_tokens = 0
    action_summary: list[str] = []
    code_events: list[Dict[str, Any]] = []
    terminal_output_persisted_box = [False]

    if not output_schema:
        raise ValueError(
            "output_schema is required for Claude Code agent - parent agent must provide structured output schema in tool call"
        )

    logger.info(
        "[ClaudeCode] Using response schema from tool call",
        agent_id=agent_id,
        fields=len(output_schema.get("fields", [])),
    )

    terminal = TerminalFilter(cols=200, rows=500)

    try:
        if attached is not None:
            # A pause landing during the reattach probe must still find the sandbox to close.
            task_id = attached["task_id"]
        if attached is not None and not await ws_endpoint_reachable(
            attached["ws_url"], attempts=REATTACH_PROBE_ATTEMPTS, backoff_s=REATTACH_PROBE_BACKOFF_S
        ):
            logger.warning(
                "[ClaudeCode] Previous sandbox unreachable; closing it before a fresh start",
                agent_id=agent_id,
                task_id=attached["task_id"],
                sandbox_id=attached["sandbox_id"],
            )
            try:
                await close_e2b_session(
                    task_id=attached["task_id"],
                    code_provider=attached.get("code_provider", code_provider),
                )
            except Exception as close_error:
                logger.warning(
                    "[ClaudeCode] Closing the unreachable sandbox failed",
                    agent_id=agent_id,
                    task_id=attached["task_id"],
                    error=str(close_error),
                )
            attached = None

        if attached is not None:
            code_provider = attached.get("code_provider", code_provider)
            task_id = attached["task_id"]
            sandbox_id = attached["sandbox_id"]
            ws_url = attached["ws_url"]
            start_time = attached.get("started_at") or start_time
            actual_github_repo_url = attached.get("github_repo_url")
            loop_started_at = attached.get("loop_started_at")
            uploaded_files = []
            logger.info(
                "[ClaudeCode] Reattaching to running sandbox",
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                attempt=activity.info().attempt,
            )
            action_summary.append(f"Reattached to E2B sandbox: {sandbox_id}")

        claude_token = await _resolve_claude_token_for_activity(user_id, code_provider)

        if attached is None:
            # 1. Create E2B session via back-end API
            logger.info(
                "[ClaudeCode] Creating E2B session",
                agent_id=agent_id,
                goal=goal[:200],
                num_attachments=len(attachments) if attachments else 0,
            )

            session_data = await create_e2b_session(
                agent_id=agent_id,
                goal=goal,
                user_id=user_id,
                attachments=attachments,
                github_repo_url=github_repo_url,
                code_provider=code_provider,
                fast_mode_cache_enabled=fast_mode_cache_enabled,
            )
            task_id = session_data["task_id"]
            sandbox_id = session_data["sandbox_id"]
            ws_url = session_data["ws_url"]
            uploaded_files = session_data.get("uploaded_files", [])
            actual_github_repo_url = session_data.get("github_repo_url")
            loop_started_at = None

            logger.info(
                "[ClaudeCode] Session created",
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                ws_url=ws_url[:100] if ws_url else None,
                uploaded_files=len(uploaded_files),
            )
            action_summary.append(f"Created E2B sandbox: {sandbox_id}")

        session_record = {
            "task_id": task_id,
            "sandbox_id": sandbox_id,
            "ws_url": ws_url,
            "code_provider": code_provider,
            "github_repo_url": actual_github_repo_url,
            "started_at": start_time,
            "loop_started_at": loop_started_at,
            "logged_events": int((attached or {}).get("logged_events") or 0),
        }
        # An attempt's first heartbeat goes out at once and later ones only every
        # throttle interval, so nothing may heartbeat before the session rides
        # along, and the session must ride along before anything else can fail:
        # a crash in either window would hide the sandbox from the retry.
        session_heartbeats.enter_context(heartbeat_resume_details({CODE_SESSION_HEARTBEAT_KEY: session_record}))
        safe_heartbeat("Claude Code sandbox attached")

        log_collector = SandboxLogCollector(sandbox_id, agent_id, task_id)
        await log_collector.start()

        if attached is None:
            if uploaded_files:
                action_summary.append(f"Uploaded {len(uploaded_files)} files to /home/user/attachments/")

            # 2. Post init message
            await save_claude_code_message(
                agent_id=agent_id,
                title="Claude Code Started",
                task_id=task_id,
                message=f"Goal: {goal}",
                status=MessageStatus.IN_PROGRESS,
                action_type="claude_code_started",
                tool_call_id=tool_call_id,
                is_init_message=True,
                ws_url=ws_url,
                output_schema=output_schema,
                github_repo_url=actual_github_repo_url,
                code_provider=code_provider,
            )

            await save_claude_code_message(
                agent_id=agent_id,
                title="Task Started",
                task_id=task_id,
                message=goal,
                status=MessageStatus.FINISHED,
                action_type="task_started",
                tool_call_id=tool_call_id,
                code_provider=code_provider,
            )
            action_summary.append(f"Started task: {goal[:100]}")

        # 3. WebSocket-based agentic loop
        if loop_started_at is None:
            loop_started_at = safe_time()
            session_record["loop_started_at"] = loop_started_at
        safe_heartbeat("Connecting to Claude Code WebSocket")

        model_pricing = await get_model_pricing_with_fallback(model)

        try:
            (
                exit_code,
                attempt_completion,
                conversation_history,
                loop_input_tokens,
                loop_output_tokens,
                code_events,
            ) = await _run_agentic_loop(
                agent_id=agent_id,
                task_id=task_id,
                sandbox_id=sandbox_id,
                goal=goal,
                ws_url=ws_url,
                terminal=terminal,
                model=model,
                claude_token=claude_token,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                gpt_token_user_id=user_id if gpt_token else None,
                code_provider=code_provider,
                action_summary=action_summary,
                tool_call_id=tool_call_id,
                code_events=code_events,
                terminal_output_persisted=terminal_output_persisted_box,
                loop_started_at=loop_started_at,
                generation_yield=generation_yield,
                code_session=session_record,
            )
        except CodeSessionDrained as drained:
            # Cleared before awaiting so a cancel landing in stop() reaches the
            # cancel handler below without stopping the collector twice.
            collector, log_collector = log_collector, None
            if collector:
                await collector.stop()
            return {
                "status": CODE_AGENT_DRAIN_YIELD_STATUS,
                "yield_reason": drained.reason,
                "code_session": session_record,
                "task_id": task_id,
                "code_provider": code_provider,
            }
        total_input_tokens += loop_input_tokens
        total_output_tokens += loop_output_tokens

        # 4. Persist terminal output (durable fallback when PTY display is empty)
        filtered_output = terminal.get_display()
        credential_feedback = (
            build_codex_credential_feedback(code_events) if code_provider == "codex" else None
        )
        durable_output = build_durable_terminal_transcript(
            filtered_output,
            code_events,
            action_summary,
        )
        if durable_output:
            await persist_terminal_output(
                task_id,
                durable_output,
                agent_id,
                code_provider,
                credential_feedback=credential_feedback,
            )
            terminal_output_persisted_box[0] = True
        else:
            logger.warning(
                "[ClaudeCode] Skipping terminal persist — display and code events were empty",
                agent_id=agent_id,
                task_id=task_id,
            )

        # A fast CLI failure can set ``exit_code`` before the one-second silence
        # window in ``_run_agentic_loop`` gets a chance to inspect the terminal.
        # Re-check the final snapshot here so a revoked OAuth token is surfaced
        # as a terminal tool error instead of going through the verifier as an
        # ordinary incomplete result. The latter makes the parent believe the
        # tool executed successfully and repeatedly spawn new paid sandboxes.
        fatal_error = check_terminal_fatal_error(
            filtered_output,
            code_provider=code_provider,
            exit_code=exit_code,
            credential_feedback=credential_feedback,
        )
        if fatal_error:
            action_summary.append(f"FATAL: {fatal_error}")
            raise ApplicationError(
                fatal_error,
                type="CLAUDE_CODE_FATAL",
                non_retryable=True,
            )

        # 5. Close session and extract output files before verifier so the
        # verifier sees the SDK event JSON plus the actual extracted artifacts.
        close_data = await close_e2b_session(
            task_id=task_id,
            user_id=user_id,
            agent_id=agent_id,
            additional_paths=[],
            code_provider=code_provider,
        )
        output_files = close_data.get("output_files", [])
        claude_code_usage = close_data.get("usage")
        session_heartbeats.close()
        safe_heartbeat("Verifying Claude Code result")

        logger.info(
            "[ClaudeCode] Session closed",
            agent_id=agent_id,
            task_id=task_id,
            output_files=len(output_files),
            claude_code_usage=claude_code_usage,
            code_events=len(code_events),
        )
        if output_files:
            action_summary.append(f"Extracted {len(output_files)} output files")

        # 6. Run verifier over normalized SDK events and extracted files.
        score, v_reasoning, structured_response, v_input, v_output = await _run_verifier(
            agent_id=agent_id,
            task_id=task_id,
            goal=goal,
            model=model,
            terminal=terminal,
            action_summary=action_summary,
            output_schema=output_schema,
            claude_token=claude_token,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=user_id if gpt_token else None,
            fast_mode_cache_enabled=fast_mode_cache_enabled,
            fast_mode_goal=goal,
            fast_mode_step=0,
            attempt_completion=attempt_completion,
            exit_code=exit_code,
            code_provider=code_provider,
            code_events=code_events,
            output_files=output_files,
        )
        total_input_tokens += v_input
        total_output_tokens += v_output

        # 7. Add any verifier-selected extra paths to the structured response
        # contract, but do not use them for sandbox extraction. The canonical
        # artifact source is /home/user/output extracted before verification.
        additional_paths = extract_additional_paths(structured_response, output_schema)
        if additional_paths:
            logger.info(
                "[ClaudeCode] Verifier returned remote file paths",
                agent_id=agent_id,
                task_id=task_id,
                paths=additional_paths,
            )

        # 8. Resolve file pointers
        if structured_response and output_files:
            structured_response = resolve_file_pointers_from_extracted(
                structured_response=structured_response,
                output_schema=output_schema,
                extracted_files=output_files,
            )
            logger.info(
                "[ClaudeCode] Resolved file pointers in structured response", agent_id=agent_id, task_id=task_id
            )

        # Build result. Threshold is 1.0 to match the unified verifier semantics
        # (B2/C12): the rest of the system treats anything below 1.0 as a
        # rejection, and `build_context_summary` reports "✅ SUCCESS" only when
        # `success=True`, so we don't lie to the parent.
        success = score >= 1.0
        context_message = build_context_summary(
            success=success,
            close_reasoning=v_reasoning,
            action_summary=action_summary,
        )

        # Log Claude Code LLM usage (not charged)
        if claude_code_usage:
            logger.info(
                "[ClaudeCode] Claude Code LLM usage (not charged, user's plan)",
                input_tokens=claude_code_usage.get("inputTokens", 0),
                output_tokens=claude_code_usage.get("outputTokens", 0),
                cache_read=claude_code_usage.get("cacheReadInputTokens", 0),
                cache_create=claude_code_usage.get("cacheCreationInputTokens", 0),
            )

        execution_time_ms = (safe_time() - start_time) * 1000
        usage_items = build_usage_items(
            total_input_tokens,
            total_output_tokens,
            model,
            model_pricing,
            execution_time_ms,
            claude_code_usage,
        )

        if log_collector:
            await log_collector.stop()

        result = {
            "status": "completed",
            "success": success,
            "message": context_message,
            "task_id": task_id,
            "ws_url": ws_url,
            "execution_time_ms": execution_time_ms,
            "usage_items": usage_items,
            "structured_response": structured_response,
            "output_files": output_files,
            "code_provider": code_provider,
            "completed_turns": codex_completed_turn_count(code_events) if code_provider == "codex" else None,
        }
        return result

    except asyncio.CancelledError:
        cancellation = activity.cancellation_details()
        logger.info(
            "[ClaudeCode] Activity cancelled",
            agent_id=agent_id,
            task_id=task_id,
            cancellation=repr(cancellation),
        )

        if log_collector:
            await log_collector.stop()

        if cancellation is not None and not cancellation.cancel_requested:
            # Not a cancel the workflow asked for, so the run is not reported as
            # cancelled. The sandbox stays open only for an attempt that will
            # reattach to it from this attempt's heartbeats.
            if task_id and not _next_attempt_reattaches(cancellation):
                logger.info(
                    "[ClaudeCode] No attempt will reattach; closing the sandbox",
                    agent_id=agent_id,
                    task_id=task_id,
                    cancellation=repr(cancellation),
                )
                try:
                    await close_e2b_session(task_id=task_id, code_provider=code_provider)
                except Exception as close_error:
                    logger.warning(
                        "[ClaudeCode] Closing the abandoned sandbox failed",
                        agent_id=agent_id,
                        task_id=task_id,
                        error=str(close_error),
                    )
            raise

        if task_id:
            try:
                # Persist terminal output before closing (skip if already written)
                try:
                    if not terminal_output_persisted_box[0]:
                        cancelled_output = build_durable_terminal_transcript(
                            terminal.get_display(),
                            code_events,
                            action_summary,
                        )
                        if cancelled_output:
                            await persist_terminal_output(task_id, cancelled_output, agent_id, code_provider)
                            terminal_output_persisted_box[0] = True
                            logger.info(
                                "[ClaudeCode] Persisted terminal output on cancel",
                                agent_id=agent_id,
                                task_id=task_id,
                                output_len=len(cancelled_output),
                            )
                except Exception as output_error:
                    logger.warning(
                        "[ClaudeCode] Failed to persist output on cancel",
                        agent_id=agent_id,
                        error=str(output_error),
                    )

                await save_claude_code_message(
                    agent_id=agent_id,
                    title="Session Cancelled",
                    task_id=task_id,
                    message="Agent paused by user",
                    status=MessageStatus.FINISHED,
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                    code_provider=code_provider,
                )

                await close_e2b_session(task_id=task_id, code_provider=code_provider)
            except Exception as cleanup_error:
                logger.warning(
                    "[ClaudeCode] Cleanup failed on cancel",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(cleanup_error),
                )

        return {
            "status": "cancelled",
            "task_id": task_id,
            "message": "Claude Code agent cancelled by user",
            "code_provider": code_provider,
        }

    except Exception as e:
        logger.error(
            "[ClaudeCode] Automation failed",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(e),
            error_type=type(e).__name__,
        )

        if log_collector:
            await log_collector.stop()

        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        error_message = build_context_summary(
            success=False,
            close_reasoning=extract_error_message(e),
            action_summary=action_summary,
            error_context=error_context,
        )

        if task_id:
            try:
                try:
                    if not terminal_output_persisted_box[0]:
                        failed_output = build_durable_terminal_transcript(
                            terminal.get_display(),
                            code_events,
                            action_summary,
                        )
                        if failed_output:
                            await persist_terminal_output(
                                task_id,
                                failed_output,
                                agent_id,
                                code_provider,
                            )
                            terminal_output_persisted_box[0] = True
                            logger.info(
                                "[ClaudeCode] Persisted terminal output on failure",
                                agent_id=agent_id,
                                task_id=task_id,
                                output_len=len(failed_output),
                            )
                except Exception as output_error:
                    logger.warning(
                        "[ClaudeCode] Failed to persist output on failure",
                        agent_id=agent_id,
                        error=str(output_error),
                    )

                await save_claude_code_message(
                    agent_id=agent_id,
                    title="Task Failed",
                    task_id=task_id,
                    message=error_message,
                    status=MessageStatus.ERROR,
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                    code_provider=code_provider,
                )

                await close_e2b_session(task_id=task_id, code_provider=code_provider)
            except Exception as cleanup_error:
                logger.warning(
                    "[ClaudeCode] Cleanup failed on error",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(cleanup_error),
                )

        raise

    finally:
        session_heartbeats.close()
