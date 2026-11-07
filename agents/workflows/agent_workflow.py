"""Main agent workflow for executing autonomous tasks.

Uses run_agent for the core loop. Workflow handles:
- Signals (pause, resume, user response, sub-agent progress)
- Sub-agent orchestration
- continue_as_new for context overflow
"""

import asyncio
import contextlib
import hashlib
import json as _json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import structlog
import structlog.contextvars
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, FailureError
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

# Import pass-through for workflow context:
# - Our own modules are safe (config.py has no import-time side effects)
# - Third-party libraries (httpx, instructor) may have import-time issues
# - This is a safety net, not strictly required for our code
with workflow.unsafe.imports_passed_through():
    from domains.agent_messaging.handler import kill_agent, send_message_to_agent
    from domains.spawn_agent.config import is_demo_cache_task, is_oai_demo_mass_agent_task
    from domains.spawn_agent.handler import (  # Unified: browser/code/general_purpose/explore
        drain_fast_mode_explores,
        spawn_agent,
    )
    from domains.spawn_agent.oai_demo_report_files import materialize_oai_demo_report_files_activity
    from domains.user_tools.handler import declared_user_tools, pin_user_tools, run_user_tool
    from domains.wait_for.service import pending_timestamp_wait_to_resume
    from helpers import (
        check_user_usage,
        fetch_agent_config,
        fetch_agent_queue_pointer,
        finalize_workflow_replacement_bootstrap,
        generate_completion_summary,
        get_model_context_window,
        get_user_context,
        get_user_custom_system_prompt,
        get_user_system_name,
        mark_finished,
        poll_new_messages,
        post_agent_message,
        resolve_fast_cache_context_activity,
        update_agent_status,
    )
    from helpers.agent_addressing import background_tree_entries, with_legacy_spawn_task_name
    from helpers.background_agents import CHILD_WORKFLOW_AGENT_TYPES, is_agent_authored_user_metadata
    from helpers.completion_summary_contract import (
        is_ablated_completion_summary,
        is_raw_tool_envelope,
    )
    from helpers.context_compaction import build_context_compaction_metadata
    from helpers.context_scope import filter_internal_subagent_messages
    from helpers.error_alert import report_failure_activity
    from helpers.generation_handoff import (
        DEPLOY_INTERRUPTED_TOOL_MESSAGE,
        GenerationHandoffRequested,
        pending_tool_record,
        pending_tool_resumes_fit,
        should_handoff_to_generation,
    )
    from helpers.handle_tool_event import handle_tool_event
    from helpers.llm import (
        call_llm_activity,
        fetch_compute_token_activity,
        persist_response_schema_activity,
        release_compute_token_lineage_activity,
        set_response_schema_activity,
    )
    from helpers.messages import update_agent_tree_state
    from helpers.model_pricing import get_anthropic_pricing, get_default_pricing
    from helpers.query_parent_state import query_parent_state_activity
    from helpers.save_tool_usage import save_tool_usage
    from helpers.sms_activities import get_agent_source, notify_sms_event_activity
    from helpers.wait_condition_or_handoff import (
        GENERATION_HANDOFF_SIGNAL,
        note_generation_handoff,
        wait_condition_or_generation_handoff,
    )
    from helpers.wait_on_world_clock import _read_world_time_ms, _refresh_world_time_cursor
    from helpers.wait_wake import note_context_snapshot, wake_mark
    from helpers.wmh_activity_policy import wmh_activity_timeout_options
    from helpers.workflow_safe import context_logger
    from helpers.world_model_runtime import world_clock_activity
    from loop.context_utils import refresh_user_pause
    from loop.dag_executor import (
        TaskDAG,
        execute_dag,
        extract_plan_from_context,
        latest_real_user_instruction,
        plan_superseded_by_new_user_instruction,
    )
    from loop.run_agent import (
        _is_requirement_agent_row,
        _real_user_requirement_keys,
        _requirement_keys,
        _run_verifier,
        _verifier_superseded_by_user_feedback,
        run_agent,
    )
    from providers.demo_cache.google_oauth_demo_fixture import matches_demo_goal, normalize_completion_notice
    from providers.rose.pricing import get_model_pricing as get_in_process_model_pricing
    from tools.attempt_completion import attempt_completion
    from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent
    from tools.call_phone_number import call_phone_number
    from tools.call_phone_number import get_manager as get_call_phone_manager
    from tools.display import display
    from tools.gate import (
        GateRejectedError,
        build_subscription_gate,
        mint_subscription_checkout_activity,
        raise_gate_direct,
    )
    from tools.google_oauth_demo import google_oauth_demo
    from tools.grep import grep
    from tools.knowledge_base import save_blueprint_activity
    from tools.message_person import message_person
    from tools.prompts import TOOL_PROMPTS

    # Tool executors (map tool name → workflow helper)
    from tools.read_tool_output import read_tool_output_for_workflow
    from tools.request_user_approval import (
        UserRejectedError,
        request_user_approval_direct,
        stash_pending_approvals_from_context,
    )
    from tools.request_user_signup import request_user_signup
    from tools.send_message_to_user import send_message_to_user
    from tools.set_plan import set_plan
    from tools.wait_for import wait_for
    from tools.web_fetch import web_fetch
    from tools.web_search import web_search
    from utils.attention_requests import REJECTION_SENTINEL
    from utils.error_utils import error_chain_has_type, extract_error_message
    from utils.format_tool_display import format_tool_display
    from utils.llm_timeouts import SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS, STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS
    from utils.prompts import (
        build_system_prompt,
        build_verifier_prompt,
        render_project_context,
        user_context_with_project,
    )
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS
    from utils.user_tool_models import is_user_tool_name
    from workflows.agent_control import AgentControlMixin
    from workflows.background_agents import BackgroundAgentsMixin
    from workflows.environment_context import EnvironmentContextMixin

logger = context_logger()

# Loop-critical control-plane read (poll_new_messages), modelled on Claude
# Code's session-transcript ingress client: 20 s per request
# (claude-code-src/src/services/api/sessionIngress.ts:428), 10 attempts
# (:25), 500 ms base delay (:26) doubling to an 8 s cap (:178). Worst case is
# about 10 x 20 s + 47.5 s of backoff, enough to ride out a saturated-worker
# burst (RCA P9: 30 s x 3 gave up after ~94 s) before the run() wrapper ends
# the agent FAILED with the real error. Permanent 4xx responses are raised
# non-retryable by the activity itself.
CONTROL_PLANE_POLL_TIMEOUT = timedelta(seconds=20)
CONTROL_PLANE_POLL_RETRY = RetryPolicy(
    initial_interval=timedelta(milliseconds=500),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=8),
    maximum_attempts=10,
)

# Consecutive transient parent-state read failures (while paused-by-parent) after
# which a child treats its parent as gone and aborts. Backstop for when the parent
# is unreachable in a way that can't be classified as terminal. With the loop's 1s
# floor sleep this is ~30s+ of continuous unreachability before giving up.
_ORPHAN_TRANSIENT_FAILURE_LIMIT = 30
# 50-way Fast Mode fan-out was flooding the parent workflow and the backend
# with per-message tree broadcasts + per-iteration parent queries. Those
# activities timed out (10s parent query, 10s tree update) and left children
# ACTIVE when the 900s harness cap hit. Coalesce to one emit/query per
# interval so cost stays O(1) per agent per window, not O(messages).
_TREE_STATE_EMIT_MIN_INTERVAL = timedelta(seconds=3)
_PARENT_STATE_QUERY_MIN_INTERVAL = timedelta(seconds=15)
_QUERY_PARENT_STATE_TIMEOUT = timedelta(seconds=60)

CLOUD_AGENT_TOOL_NAME = "cloud_agent"
CREATING_CLOUD_AGENT_TITLE = "Creating Cloud Agent"
PREPARING_CLOUD_AGENT_TITLE = "Preparing Cloud Agent"
STARTING_REASONING_TITLE = "Starting Reasoning"
CLOUD_AGENT_READY_TITLE = "Cloud Agent Ready"
CLOUD_AGENT_IN_PROGRESS_TITLES = {
    CREATING_CLOUD_AGENT_TITLE,
    PREPARING_CLOUD_AGENT_TITLE,
    STARTING_REASONING_TITLE,
}
FAST_MODE_WRITE_THROUGH_USER_IDS = {"1f85ff25-6e29-4c1b-8739-f917bd101a30"}
# Simulate mode: the runner creates the world session before the root starts.
# Registration retries a missing world briefly, then the agent fails closed.
WORLD_CLOCK_REGISTER_ATTEMPTS = 3
WORLD_CLOCK_REGISTER_RETRY_SECONDS = 2
# Simulate mode: a failed post-tool cursor read is retried with a short backoff
# before the next simulated-time consumer, so a transient WMH blip cannot leave
# the agent on the time from before its last action.
WORLD_CLOCK_REFRESH_ATTEMPTS = 3
WORLD_CLOCK_REFRESH_RETRY_SECONDS = 5
WORLD_CLOCK_UNAVAILABLE_MESSAGE = (
    "Simulated world clock unavailable: no WMH world session acknowledged this agent, "
    "so it cannot start on the world's time. Create the world session before starting the agent."
)
# Reserved responses emitted by auth completion and gate-resolution providers.
ATTENTION_CONTROL_RESPONSES = frozenset(
    {REJECTION_SENTINEL, "__AUTH_ASSISTANCE_COMPLETED__", "RESOLVED", "SOURCE_CONNECTED", "SUBSCRIPTION_ACTIVE"}
)


def _resolve_usage_model(actual_model: Optional[str], requested_model: str) -> str:
    """Return durable provider provenance for usage accounting.

    Legacy DEMO cache entries serialize the literal ``unknown`` when the
    original transport model was not stored. Treating that sentinel as a model
    creates an unactionable ``unclassified`` bucket in benchmark artifacts.
    The requested pool alias is still known and encodes the credential path, so
    use it for missing/unknown replay provenance.
    """
    candidate = str(actual_model or "").strip()
    return requested_model if not candidate or candidate == "unknown" else candidate


def _demo_cache_compute_affinity_key(user_id: str, goal: str) -> str:
    material = _json.dumps(
        {"version": 1, "user_id": user_id, "goal": goal},
        sort_keys=True,
        separators=(",", ":"),
    )
    return "fast-cache-agent-provider:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


# =============================================================================
# TOOL CONFIGURATION
# =============================================================================

# Tool name → executor function mapping
TOOL_EXECUTORS = {
    "read_tool_output": read_tool_output_for_workflow,
    "google_workspace_run": google_oauth_demo,
    "spawn_agent": spawn_agent,  # Unified: browser/code/general_purpose/explore
    "wait_for": wait_for,
    "send_message_to_user": send_message_to_user,
    "send_message_to_user_execute_phase": send_message_to_user,  # Same handler, forces is_question=False
    "display": display,
    "web_search": web_search,
    "web_fetch": web_fetch,
    "message_person": message_person,
    "set_plan": set_plan,
    "attempt_completion": attempt_completion,
    "request_user_signup": request_user_signup,
    "call_phone_number": call_phone_number,
    "grep": grep,
    "send_message_to_agent": send_message_to_agent,
    "kill_agent": kill_agent,
}

# Tools requiring user approval before execution
# NOTE: message_person handles approval internally (after message generation, not before)
APPROVAL_REQUIRED_TOOLS = {
    "call_phone_number": get_call_phone_manager,
}


_SNAKE_HEADING = re.compile(r"^#+\s+([a-z][a-z0-9_]{2,})\s*$", flags=re.MULTILINE)


def structured_response_from_schema_headings(text: str, schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Parse `# field_name` markdown sections into a structured_response dict."""
    if not text:
        return {}
    fields = schema.get("fields") or [] if isinstance(schema, dict) else []
    names = [str(field.get("name")) for field in fields if isinstance(field, dict) and field.get("name")]
    if not names:
        seen: set[str] = set()
        names = []
        for name in _SNAKE_HEADING.findall(text):
            if name not in seen:
                seen.add(name)
                names.append(name)
    if not names:
        return {}
    matches: List[Tuple[int, str, int]] = []
    for name in names:
        found = re.search(rf"^#+\s+{re.escape(name)}\s*$", text, flags=re.IGNORECASE | re.MULTILINE)
        if found:
            matches.append((found.start(), name, found.end()))
    if not matches:
        return {}
    matches.sort()
    out: Dict[str, Any] = {}
    for index, (_start, name, end) in enumerate(matches):
        next_start = matches[index + 1][0] if index + 1 < len(matches) else len(text)
        body = text[end:next_start].strip()
        if body:
            out[name] = body
    return out


_PLUMBING_TOOL_MARKERS = (
    "research started.",
    "agent initializing",
    "agent initialization complete",
    "running verifier to check completion",
    "explore agent thinking",
    "**params passed:**",
)
_ROW_ITEM_TO_SCHEMA = {
    "name": "creator_name",
    "creator_name": "creator_name",
    "rank": "rank_from_initial_list",
    "rank_from_initial_list": "rank_from_initial_list",
}
_SCHEMA_FIELD_SECTION_ALIASES = {
    "creator_name": ("creator name", "assigned creator"),
    "platform_handles_and_urls": (
        "handles",
        "platform",
        "youtube",
        "instagram",
        "tiktok",
        "substack",
        "account stats",
    ),
    "posting_cadence_by_platform": ("cadence", "posting frequency", "updated weekly"),
    "hook_formulas": ("hook", "title pattern", "headline formula"),
    "top_5_performing_pieces_last_90_days": (
        "top 5",
        "performing",
        "last ~90",
        "last 90",
        "recent long-form",
        "recent newsletter",
    ),
    "core_content_pillars": ("pillar", "formats across"),
    "audience_persona": ("audience", "persona", "promise"),
    "monetization_funnels": ("monetiz", "sponsorship", "paid/free", "pricing"),
    "content_gaps": ("gap", "underserved"),
    "opportunities_for_aman": ("takeaway", "opportunit", "whitespace", "competitive"),
    "engagement_approach": ("engagement", "collab"),
    "citations_sources": ("citation", "source note"),
    "confidence_level": ("confidence",),
}
_EVIDENCE_TOOLS = {
    "attempt_completion",
    "attempt_completion_with_result",
    "spawn_agent",
    "send_message_to_user",
    "web_fetch",
    "web_search",
    "grep",
    "people_search",
}
_FLEX_HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*$", flags=re.MULTILINE)


def _message_body(message: Dict[str, Any]) -> str:
    if not isinstance(message, dict):
        return ""
    text = str(message.get("text") or message.get("message") or "").strip()
    if text:
        return text
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    return str(metadata.get("result") or metadata.get("content") or metadata.get("message") or "").strip()


def _is_plumbing_tool_text(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return True
    if is_raw_tool_envelope(text):
        return True
    # Long narrative reports are evidence; short status chips are plumbing.
    if len(lowered) >= 200:
        return False
    return any(marker in lowered for marker in _PLUMBING_TOOL_MARKERS)


def last_real_completion_text(
    context: List[Dict[str, Any]],
    structured_response: Optional[Dict[str, Any]] = None,
) -> str:
    """Best user-facing Task Complete body from already-replayed trajectory evidence."""
    for message in reversed(context or []):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        tool_name = str(metadata.get("toolName") or "")
        status = str(metadata.get("toolStatus") or "").upper()
        text = _message_body(message)
        if is_ablated_completion_summary(text):
            continue
        if _is_plumbing_tool_text(text):
            continue
        if tool_name in _EVIDENCE_TOOLS and status in {"FINISHED", ""} and len(text) >= 200:
            return text
        if (
            str(message.get("role") or "").upper() == "ASSISTANT"
            and len(text) >= 200
            and (metadata.get("plannedToolName") == "reasoning" or metadata.get("dagTaskIndex") is not None)
        ):
            return text
    if isinstance(structured_response, dict):
        for value in structured_response.values():
            if isinstance(value, str) and len(value.strip()) >= 200 and not is_ablated_completion_summary(value):
                return value.strip()
    return ""


_FAST_MODE_CARD_MARKERS = (
    "fast mode",
    "cached trajectory",
    "based on prior tool evidence",
    "verified results are included below",
)


def completion_card_has_fast_mode_markers(text: str) -> bool:
    """True when Task Complete text still carries Fast Mode ablation copy."""
    lowered = str(text or "").lower()
    return any(marker in lowered for marker in _FAST_MODE_CARD_MARKERS)


def strip_fast_mode_card_narration(text: str) -> str:
    """Drop Fast Mode lead-in sentences; keep extracted report text.

    July Fast Mode sometimes prefixes a valid Extracted Output block with
    ``DEMO cache trajectory ended...``. T7 forbids that substring even
    when the rest of the card is a real 200+ character summary.
    """
    raw = str(text or "").strip()
    if not raw or not completion_card_has_fast_mode_markers(raw):
        return raw
    parts = re.split(r"(?<=[.!?])\s+", raw)
    kept = [part.strip() for part in parts if part.strip() and not completion_card_has_fast_mode_markers(part)]
    return " ".join(kept).strip()


def brief_card_summary(text: str, *, min_chars: int = 200, max_chars: int = 800) -> str:
    """Collapse a long replayed report into a Task Complete card body."""
    kept: List[str] = []
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if is_ablated_completion_summary(line) or _is_plumbing_tool_text(line):
            continue
        if completion_card_has_fast_mode_markers(line) and len(line) < 200:
            continue
        kept.append(line)
    blob = " ".join(kept).strip()
    if not blob:
        return ""
    if len(blob) <= max_chars:
        return blob
    clipped = blob[:max_chars]
    for separator in (". ", "! ", "? "):
        idx = clipped.rfind(separator)
        if idx >= min_chars:
            return clipped[: idx + 1].strip()
    return clipped.strip()


def _completion_message_identity(message: Dict[str, Any]) -> str:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    tool_call_id = str(metadata.get("toolCallId") or "").strip()
    if tool_call_id:
        return f"tc:{tool_call_id}"
    return f"{message.get('role')}|{_message_body(message)[:80]}"


def _merge_completion_transcripts(
    polled: Optional[List[Dict[str, Any]]],
    context: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Keep both in-memory context and posted rows; prefer the longer body."""
    merged: List[Dict[str, Any]] = []
    seen: Dict[str, int] = {}
    for source in (context or [], polled or []):
        if not isinstance(source, list):
            continue
        for message in source:
            if not isinstance(message, dict):
                continue
            key = _completion_message_identity(message)
            existing = seen.get(key)
            if existing is None:
                seen[key] = len(merged)
                merged.append(message)
                continue
            if len(_message_body(message)) > len(_message_body(merged[existing])):
                merged[existing] = message
    return merged


def card_summary_from_evidence(
    context: List[Dict[str, Any]],
    structured_response: Optional[Dict[str, Any]] = None,
    *,
    min_chars: int = 200,
) -> str:
    """1-2 sentence Task Complete summary from replayed evidence, never Fast Mode copy."""
    candidate = last_real_completion_text(context, structured_response)
    brief = strip_fast_mode_card_narration(brief_card_summary(candidate, min_chars=min_chars))
    if brief and not is_ablated_completion_summary(brief) and len(brief) >= min_chars:
        return brief
    if isinstance(structured_response, dict):
        parts = [
            str(value).strip()
            for value in structured_response.values()
            if isinstance(value, str) and value.strip() and not is_ablated_completion_summary(value)
        ]
        brief = strip_fast_mode_card_narration(brief_card_summary(" ".join(parts), min_chars=min_chars))
        if brief and len(brief) >= min_chars:
            return brief
    return ""


def _json_objects_in_text(text: str) -> List[Dict[str, Any]]:
    raw = str(text or "")
    if "{" not in raw:
        return []
    decoder = _json.JSONDecoder()
    found: List[Dict[str, Any]] = []
    index = 0
    while True:
        start = raw.find("{", index)
        if start < 0:
            break
        try:
            obj, consumed = decoder.raw_decode(raw[start:])
        except _json.JSONDecodeError:
            index = start + 1
            continue
        if isinstance(obj, dict):
            found.append(obj)
        index = start + max(int(consumed), 1)
    return found


def _markdown_sections(text: str) -> List[Tuple[str, str]]:
    matches = list(_FLEX_HEADING.finditer(text or ""))
    if not matches:
        return []
    sections: List[Tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end() : end].strip()
        if body:
            sections.append((match.group(1).strip(), body))
    return sections


def _section_matches_field(title: str, field_name: str) -> bool:
    lowered = title.lower()
    human = field_name.replace("_", " ")
    if human in lowered or field_name.lower() in lowered:
        return True
    for alias in _SCHEMA_FIELD_SECTION_ALIASES.get(field_name, ()):
        if alias in lowered:
            return True
    return False


def _schema_field_types(schema: Optional[Dict[str, Any]]) -> Dict[str, str]:
    return {
        str(field.get("name")): str(field.get("type") or "")
        for field in (schema or {}).get("fields") or []
        if isinstance(field, dict) and field.get("name")
    }


def _may_fill(current: Dict[str, Any], name: str, value: Any, field_type: str) -> bool:
    """Whether a transcript-derived value may fill ``name``.

    An absent key is filled as before (a demo root's report text is materialized
    into files later). A key the verifier returned empty ([] / "") was judged
    ungrounded; only a value of the field's own type may replace it.
    """
    if value in (None, "", [], {}):
        return False
    if name not in current or current[name] is None:
        return True
    return current[name] in ("", [], {}) and _fits_field_type(value, field_type)


def _fits_field_type(value: Any, field_type: str) -> bool:
    """True when a transcript-derived value has the field's declared response_schema type."""
    if not field_type:
        return True  # untyped legacy schema field
    if field_type == "str":
        return isinstance(value, str)
    if field_type == "int":
        return isinstance(value, int) and not isinstance(value, bool)
    if field_type == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if field_type == "bool":
        return isinstance(value, bool)
    if field_type in ("object", "file_pointer"):
        return isinstance(value, dict)
    if field_type.startswith("list["):
        if not isinstance(value, list):
            return False
        item_type = field_type[len("list[") : -1]
        return all(_fits_field_type(item, item_type) for item in value)
    return True


def _fill_from_row_and_sections(
    merged: Dict[str, Any],
    names: List[str],
    context: List[Dict[str, Any]],
    types: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    empty = (None, "", [], {})
    types = types or {}

    def fits(name: str, value: Any) -> bool:
        return _may_fill(merged, name, value, types.get(name, ""))

    def missing() -> List[str]:
        return [name for name in names if name not in merged or merged[name] in empty]

    for message in context or []:
        if not isinstance(message, dict):
            continue
        for obj in _json_objects_in_text(_message_body(message)):
            for raw_key, value in obj.items():
                target = _ROW_ITEM_TO_SCHEMA.get(str(raw_key))
                if target and target in names and merged.get(target) in empty + (None,):
                    if value not in empty and fits(target, value):
                        merged[target] = value
            for name in names:
                if (
                    name in obj
                    and obj[name] not in empty
                    and merged.get(name) in empty + (None,)
                    and fits(name, obj[name])
                ):
                    merged[name] = obj[name]
            items = obj.get("items")
            if (
                isinstance(items, list)
                and "top_creators_analysis" in names
                and merged.get("top_creators_analysis") in empty + (None,)
            ):
                analyses = []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    nested = item.get("structured_response") or item.get("structuredResponse") or item
                    if isinstance(nested, dict) and nested:
                        analyses.append(nested)
                if analyses:
                    merged["top_creators_analysis"] = analyses
        if not missing():
            return merged

    used_titles: Set[str] = set()
    for message in reversed(context or []):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        tool_name = str(metadata.get("toolName") or "")
        role = str(message.get("role") or "").upper()
        if role == "USER" and tool_name not in _EVIDENCE_TOOLS:
            continue
        text = _message_body(message)
        if len(text) < 200 or _is_plumbing_tool_text(text):
            continue
        for title, body in _markdown_sections(text):
            if title in used_titles:
                continue
            for name in missing():
                if not _section_matches_field(title, name) or not fits(name, body):
                    continue
                merged[name] = body
                used_titles.add(title)
                break
        if not missing():
            break
    return merged


def coalesce_structured_response(
    context: List[Dict[str, Any]],
    schema: Optional[Dict[str, Any]],
    structured_response: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Merge verifier output with `# field_name` sections from the transcript."""
    merged: Dict[str, Any] = dict(structured_response) if isinstance(structured_response, dict) else {}
    names = [
        str(field.get("name"))
        for field in (schema or {}).get("fields") or []
        if isinstance(field, dict) and field.get("name")
    ]
    if not names:
        for message in reversed(context or []):
            text = _message_body(message)
            extracted = structured_response_from_schema_headings(text, None)
            if not extracted:
                continue
            for key, value in extracted.items():
                if key not in merged or merged[key] in (None, "", [], {}):
                    merged[key] = value
        return merged or structured_response

    def _missing(current: Dict[str, Any]) -> List[str]:
        empty = (None, "", [], {})
        return [name for name in names if name not in current or current[name] in empty]

    field_types = _schema_field_types(schema)

    if not _missing(merged):
        return merged
    for message in reversed(context or []):
        text = _message_body(message)
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        extracted = structured_response_from_schema_headings(text, schema)
        if not extracted:
            extracted = _structured_from_payload(message, names)
        if not extracted:
            extracted = _structured_from_payload(metadata, names)
        if not extracted:
            continue
        for key, value in extracted.items():
            if _may_fill(merged, key, value, field_types.get(key, "")):
                merged[key] = value
        if not _missing(merged):
            break
    return merged or structured_response


def structured_response_from_evidence(
    context: List[Dict[str, Any]],
    schema: Optional[Dict[str, Any]],
    structured_response: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Fill schema outputs from replayed assemble / explore / row-item evidence."""
    merged = coalesce_structured_response(context, schema, structured_response)
    merged = dict(merged) if isinstance(merged, dict) else {}
    names = [
        str(field.get("name"))
        for field in (schema or {}).get("fields") or []
        if isinstance(field, dict) and field.get("name")
    ]
    if names:
        merged = _fill_from_row_and_sections(merged, names, context, _schema_field_types(schema))
    return merged or structured_response


def _structured_from_payload(payload: Any, names: List[str]) -> Dict[str, Any]:
    """Pull schema keys off a dict / JSON string without inventing values."""
    if not names:
        return {}
    obj = payload
    if isinstance(obj, str):
        raw = obj.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                obj = _json.loads(raw)
            except _json.JSONDecodeError:
                return {}
    if not isinstance(obj, dict):
        return {}
    nested = obj.get("structured_response") or obj.get("structuredResponse") or obj
    if not isinstance(nested, dict):
        return {}
    found = {name: nested[name] for name in names if name in nested and nested[name] not in (None, "", [], {})}
    items = nested.get("items") if "items" in nested else obj.get("items")
    if "top_creators_analysis" in names and "top_creators_analysis" not in found and isinstance(items, list):
        analyses = []
        for item in items:
            if not isinstance(item, dict):
                continue
            row = item.get("structured_response") or item.get("structuredResponse") or item
            if isinstance(row, dict) and row:
                analyses.append(row)
        if analyses:
            found["top_creators_analysis"] = analyses
    return found


def _canonical_pending_approval_resume(pending_approval: Any) -> Optional[Dict[str, Any]]:
    """Normalize approval resume so serialize and restore stay symmetric."""
    if isinstance(pending_approval, dict):
        raw_requests = pending_approval.get("requests")
        if isinstance(raw_requests, list):
            return {"requests": list(raw_requests)}
        request_id = pending_approval.get("request_id")
        if isinstance(request_id, str) and request_id:
            question = pending_approval.get("question")
            return {
                "request_id": request_id,
                "question": question if isinstance(question, str) else "",
            }
        return None
    if isinstance(pending_approval, str) and pending_approval:
        return {"request_id": pending_approval, "question": ""}
    return None


# Bounded wait for in-flight background tasks to park/finish before continue_as_new
# (browser step + worker pointer cache TTL fit well inside it).
CONTINUATION_BACKGROUND_SETTLE_SECONDS = 180.0
# Context overflow defers continue_as_new while background activities run, up to
# these history bounds (Temporal hard limits: 51,200 events / 50 MB).
OVERFLOW_DEFER_MAX_HISTORY_EVENTS = 30_000
OVERFLOW_DEFER_MAX_HISTORY_BYTES = 30 * 1024 * 1024
# Temporal rejects a command whose payloads exceed ~2 MiB (TMPRL1103) and retries the
# failed workflow task forever, so a continuation that big can never hand off. Warn well
# before the limit so a growing context is visible instead of wedging a cutover.
CONTINUATION_PAYLOAD_WARN_BYTES = 1_500_000


@workflow.defn
class AgentWorkflow(BackgroundAgentsMixin, AgentControlMixin, EnvironmentContextMixin):
    """
    Main workflow for autonomous agent task execution.

    Two-phase execution:
    1. PLAN: Research, ask questions, create execution plan
    2. EXECUTE: Run the plan with full tool access
    """

    def __init__(self):
        # Live queue pushed by the cutover owner (generation_handoff_available);
        # handoff-aware parks wake on a seq bump and confirm via the pointer.
        self._generation_handoff_hint: Optional[str] = None
        self._generation_handoff_hint_seq: int = 0
        # Workflow time of this run's last park-side pointer read (safety re-check clock).
        self._generation_handoff_checked_at: Optional[float] = None
        self.agent_id: Optional[str] = None
        self.user_id: Optional[str] = None
        self.goal: Optional[str] = None
        # DEMO cache namespace goal — the persisted Agent-row goal, which may
        # differ from the workflow-input goal (chat escalation passes an LLM-refined
        # goal that varies run to run). All cache keying threads this, never self.goal.
        self.demo_cache_goal: Optional[str] = None
        # Tree-root goal for DEMO inheritance. Child cache keys stay on
        # demo_cache_goal; wait_for / spawn gates read this when the child's
        # own spawn goal is not the catalog prefix.
        self.root_goal: Optional[str] = None
        self._browser_activity_cleanup_unknown: bool = False
        self.fast_mode_cache_enabled: bool = False
        self.memory_enabled: bool = False
        # User-authored tools pinned once per run (domains/user_tools); carried
        # across continue_as_new so a mid-run publish never changes the toolset.
        self.user_tools: Dict[str, Any] = {}
        self.user_tools_pinned: bool = False
        # Fast Mode button — LLM provider speed only (Anthropic speed / OpenAI priority).
        # Independent of DEMO cache replay (self.fast_mode_cache_enabled).
        self.provider_fast_mode: bool = True
        self.world_model_mode: str = "real"
        # Simulate-mode logical clock: seconds of wall-clock wait that wait_for /
        # wait_seconds skipped (utils/simulated_clock.py). Always 0 in real mode.
        self.simulated_clock_offset_seconds: int = 0
        # Simulate mode: this agent's time on its world's shared clock (epoch ms).
        self.simulated_world_time_ms: Optional[int] = None
        self.model: str = "anthropic/claude-sonnet-4.6"
        self.reasoning_max_tokens: int = 256
        self.verifier: Optional[Dict] = None
        self.last_message_check: Optional[datetime] = datetime(1970, 1, 1).replace(tzinfo=timezone.utc)
        self.max_context_tokens: Optional[int] = None
        self.token_count: int = 0
        self.tokens_in: int = 0
        self.tokens_out: int = 0
        self.context_size: int = 0  # Current context window usage (from last LLM call)
        self.is_paused: bool = False
        # Authentication can pause itself while waiting for the user's reply.
        self._pause_signal_sequence: int = 0
        self._user_pause_active: bool = False  # Explicit PAUSE signal, not budget/auth waits.
        self._paused_by_parent: bool = False  # Track if pause was inherited from parent
        # Orphan detection: every child must stop once Temporal confirms that its
        # parent chain is gone. Otherwise an active child can keep spending after a
        # deployment replaces the root, then signal a workflow that no longer exists.
        self._orphaned: bool = False
        self._parent_query_failures_while_paused: int = 0
        self._has_new_messages: bool = False
        self._last_signal_response: Optional[str] = None  # Stores response from receive_user_response signal
        self._signal_responses: dict = {}  # Per-request responses keyed by attention request ID
        # In-flight approval identity that must be re-armed after continue_as_new.
        # Creating a new attn_id on retry is how SMS approves a stale row.
        self._pending_approval_resume: Optional[Dict[str, str]] = None
        # Free-form feedback can change the required final shape after the run
        # starts. Revisions let prompt/verifier boundaries refresh exactly once
        # per accepted batch while still catching feedback that arrives during
        # the schema-generation activity.
        self._response_schema_feedback: List[str] = []
        self._response_schema_feedback_sources: List[Optional[Tuple[str, ...]]] = []
        self._response_schema_feedback_rows: Set[Tuple[str, ...]] = set()
        self._response_schema_task_base: Optional[str] = None
        self._response_schema_task_baseline_rows: Set[Tuple[str, ...]] = set()
        self._response_schema_attention_events: Dict[str, str] = {}
        self._response_schema_pending_signals: Dict[str, int] = {}
        self._response_schema_baseline_initialized = False
        self._response_schema_revision: int = 0
        # The startup agent-config read failed, so output_schema and the project
        # section are unknown (not known-absent) until a later read succeeds.
        self._agent_config_unavailable: bool = False
        # Getter reloads back off across turns while the read keeps failing.
        self._agent_config_retry_count: int = 0
        self._agent_config_retry_at: Optional[datetime] = None
        self._response_schema_applied_revision: int = 0
        self._response_schema_accepted_revision: int = 0
        self._response_schema_initialized: bool = False
        self._response_schema_refresh_task: Optional[asyncio.Task[Any]] = None
        self._response_schema_refresh_failed_revision: int = 0
        self._response_schema_refresh_error: Optional[str] = None
        self._response_schema_refresh_failure_reason: Optional[str] = None
        # Live exception identity is only for the normal LLM retry boundary;
        # continuation state stores the existing error text, never an exception.
        self._response_schema_refresh_exception: Optional[Exception] = None
        self._has_credits: bool = True  # Cached credit status
        self._last_credit_check: int = 0  # Iteration count at last check
        self.write_lock_enabled: bool = True  # Write lock for browser agent actions

        # Signup request state (for request_user_signup tool)
        self._signup_completed: bool = False
        self._signup_dismissed: bool = False

        # Context - kept in sync with run_agent for tools that check it
        self.context: List[Dict] = []
        self._cloud_agent_lifecycle_tool_call_id: Optional[str] = None
        self._cloud_agent_lifecycle_start_phase: Optional[str] = None
        self._cloud_agent_lifecycle_updates_sent: Set[str] = set()
        self._cloud_agent_lifecycle_finished: bool = False

        # Sub-agent tracking
        self.parent_workflow_id: Optional[str] = None
        self.parent_agent_id: Optional[str] = None  # Parent agent ID for tree structure
        self.pending_children: Set[str] = set()
        self.child_tool_ids: Dict[str, str] = {}
        self.child_last_tokens: Dict[str, Dict[str, int]] = {}
        self.child_tool_counts: Dict[str, int] = {}  # Aggregated tool counts from sub-agents
        self.child_results: Dict[str, Dict] = {}  # Store child results for file extraction after wait_condition
        self.depth: int = 0
        self.root_agent_id: Optional[str] = None

        # Tree state tracking (for sub-agent tree UI)
        self.bus_id: Optional[str] = None  # Shared bus channel ID for tree updates
        self.tools_in_use: Set[str] = set()  # Currently executing tools (display strings)
        self.message_count: int = 0  # Total message count for this agent
        self.output_schema: Optional[Dict] = None  # Structured output schema (for prompts, verifier, tree, completion)
        self.start_time: Optional[datetime] = None  # Workflow start time for duration tracking

        # System prompt building state (for build_system_prompt callback)
        self._current_tools: List[str] = []  # Tools enabled for current phase
        self._disabled_tools: List[str] = []  # Tools disabled for current phase (shown in PLAN)

        # Cost limit tracking (hierarchical relay: child → parent → root)
        # Uses float to avoid int truncation losing sub-cent costs on cheap models
        self.own_cost_cents: float = 0.0  # This agent's direct cost (LLM + tools)
        self.children_cost_cents: Dict[str, float] = {}  # child_agent_id -> subtree_cost
        self.subtree_cost_cents: float = 0.0  # own + sum(children) - what we report to parent
        self.price_limit_cents: int = 100  # Default price limit (100 cents = $1.00)
        self._cost_limit_reached: bool = False  # Flag for cost limit status
        # When a successful spawn_browser_agent return itself trips the price
        # limit (batched browser LLM costs applied on tool completion), allow
        # one more agent turn so attempt_completion can latch COMPLETED instead
        # of stranding a finished shopping run on COST_LIMIT_REACHED.
        self._cost_limit_wrapup_pending: bool = False
        self._cost_limit_wrapup_consumed: bool = False
        self._is_finished: bool = False  # Latched True after _mark_complete/_mark_failed runs
        # Debounce the tree-cost persist + Processing status broadcast. These two
        # activities fire from 4 call sites; unthrottled they flood the backend
        # (→ activity timeouts that stall the loop) and race (→ FE cost flicker).
        # Coalesce bursts to at most one emit per _TREE_COST_EMIT_MIN_INTERVAL;
        # terminal/cost-limit transitions force-flush so the final value lands.
        self._last_tree_cost_emit_at: Optional[datetime] = None
        self._last_tree_state_emit_at: Optional[datetime] = None
        self._last_parent_state_query_at: Optional[datetime] = None
        self._last_parent_state: Dict = {}
        self._pending_message_handles: List[Any] = []
        self._cached_local_data_summary: Optional[str] = None
        self.child_workflow_ids: Dict[str, str] = {}  # child_agent_id -> child_temporal_workflow_id

        # Tree token tracking (hierarchical relay: child → parent → root)
        # Own tokens are in self.tokens_in/out (used for cost calc)
        # Children's tokens aggregated here for tree totals
        self.children_tokens_in: Dict[str, int] = {}  # child_agent_id -> subtree_tokens_in
        self.children_tokens_out: Dict[str, int] = {}  # child_agent_id -> subtree_tokens_out
        self.tree_tokens_in: int = 0  # own + sum(children) - for display
        self.tree_tokens_out: int = 0  # own + sum(children) - for display

        # Selected compute token (passed to Rose for direct provider calls)
        self.compute_token_provider: Optional[str] = None  # "claude" | "gpt"
        self.claude_max_token: Optional[str] = None
        self.claude_max_token_fetched_at: Optional[datetime] = None  # Legacy alias for tests/callers
        self.claude_max_token_source: Optional[str] = None  # 'user' or 'pool' — used for rotation on rate_limit
        self.claude_max_token_pool_id: Optional[str] = None  # Integration ID when source='pool'
        self.gpt_code_token: Optional[str] = None
        self.gpt_code_account_id: Optional[str] = None
        self.gpt_code_token_source: Optional[str] = None
        self.gpt_code_token_pool_id: Optional[str] = None
        # The exact Integration row the active compute token was leased from;
        # failure reports name it so they never reach the user's other logins.
        self.compute_token_integration_id: Optional[str] = None
        self.compute_token_lineage_key: Optional[str] = None
        self.compute_token_demo_cache_affinity_key: Optional[str] = None
        self.compute_token_fetched_at: Optional[datetime] = None  # For 5-min TTL refresh

        # Model pricing (fetched at workflow start for cost calculation)
        self.input_cents_per_1k: float = 0.0  # Price per 1k input tokens in cents
        self.output_cents_per_1k: float = 0.0  # Price per 1k output tokens in cents
        self.model_pricing_cache: Dict[str, Dict[str, float]] = {}  # model -> {input_cents_per_1k, output_cents_per_1k}
        self.actual_model: Optional[str] = None  # The model that actually served requests (from Rose response)

        # User customization (fetched at workflow start for dynamic name in approvals/SMS)
        self.system_name: str = "Rose"  # Default to "Rose", fetched from user settings
        self.custom_system_prompt: Optional[str] = None  # Custom personality prompt to inject
        # `## Project` section from the agent's project placement ("" = Home); kept
        # apart from the per-user user_context_section and recomputed each start.
        self.project_context_section: str = ""

        # Agent source (WEB, MAC_APP, SMS) — cached at startup for SMS notification gating
        self.agent_source: str = "WEB"
        self._deployment_resume: bool = False
        self._world_clock_events: set[str] = set()
        self._resume_prior_status: str = "ACTIVE"
        self._resume_status_message: Optional[str] = None
        self._resume_progress: float = 0.0
        self.iteration_offset: int = 0
        self._deployment_initialized: bool = False
        self._deployment_validation: bool = False
        # Cooperative cutover can carry an in-flight tool call (a browser task
        # paused at a step boundary or waiting on approval/auth) across
        # continue_as_new instead of interrupting it. Only run_agent turns
        # park; the DAG treats any tool return as that task's completion.
        self._tool_parking_enabled: bool = False
        self._active_tool_calls: Dict[str, Tuple[str, Dict[str, Any]]] = {}
        self._pending_tool_resumes: List[Dict[str, Any]] = []
        self._tool_resume_hints: Dict[str, Dict[str, Any]] = {}
        # Background spawn_agent tasks (workflows/background_agents.py).
        self._init_background_state()
        # kill_agent state (workflows/agent_control.py).
        self._init_agent_control_state()

    @staticmethod
    def _serialized_datetime(value: Optional[datetime]) -> Optional[str]:
        return value.isoformat() if isinstance(value, datetime) else None

    @staticmethod
    def _restored_datetime(value: Any) -> Optional[datetime]:
        if not isinstance(value, str) or not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def _restore_deployment_state(self, state: Optional[Dict]) -> None:
        """Restore durable deployment or continue-as-new workflow state."""
        if not state:
            return
        if state.get("version") != 1 or state.get("kind") not in {
            "deployment",
            "continuation",
            "validation",
        }:
            raise ValueError("Unsupported workflow resume state")

        def _number(name: str, default: float = 0) -> float:
            value = state.get(name, default)
            return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default

        def _number_map(name: str) -> Dict[str, float]:
            value = state.get(name)
            if not isinstance(value, dict):
                return {}
            return {
                str(key): item
                for key, item in value.items()
                if isinstance(item, (int, float)) and not isinstance(item, bool)
            }

        self._deployment_resume = True
        self._resume_prior_status = str(state.get("prior_status") or "ACTIVE")
        prior_status_message = state.get("prior_status_message")
        self._resume_status_message = prior_status_message if isinstance(prior_status_message, str) else None
        self._resume_progress = float(_number("progress"))
        # A simulated agent keeps reading world time after continue-as-new.
        self.simulated_clock_offset_seconds = int(_number("simulated_clock_offset_seconds"))
        world_cursor = state.get("simulated_world_time_ms")
        self.simulated_world_time_ms = world_cursor if type(world_cursor) is int else None
        self.token_count = int(_number("token_count"))
        self.tokens_in = int(_number("tokens_in"))
        self.tokens_out = int(_number("tokens_out"))
        self.tree_tokens_in = int(_number("tree_tokens_in", self.tokens_in))
        self.tree_tokens_out = int(_number("tree_tokens_out", self.tokens_out))
        self.context_size = int(_number("context_size"))
        self.message_count = int(_number("message_count"))
        self.start_time = self._restored_datetime(state.get("workflow_started_at"))
        self.own_cost_cents = float(_number("own_cost_cents"))
        self.subtree_cost_cents = float(_number("subtree_cost_cents", self.own_cost_cents))
        self.children_cost_cents = _number_map("children_cost_cents")
        self.children_tokens_in = {key: int(value) for key, value in _number_map("children_tokens_in").items()}
        self.children_tokens_out = {key: int(value) for key, value in _number_map("children_tokens_out").items()}
        self.child_tool_counts = {
            key: int(value) for key, value in _number_map("child_tool_counts").items() if value >= 0
        }
        child_last_tokens = state.get("child_last_tokens")
        if isinstance(child_last_tokens, dict):
            for child_id, child_tokens in child_last_tokens.items():
                if not isinstance(child_tokens, dict):
                    continue
                self.child_last_tokens[str(child_id)] = {
                    "tokens_in": int(child_tokens.get("tokens_in", 0)),
                    "tokens_out": int(child_tokens.get("tokens_out", 0)),
                    "token_count": int(child_tokens.get("token_count", 0)),
                }
        self.iteration_offset = int(_number("iteration_offset"))
        if isinstance(state.get("max_iterations"), int):
            self.max_iterations = state["max_iterations"]
        if isinstance(state.get("context_gates"), dict):
            self.context_gates = {
                str(key): value for key, value in state["context_gates"].items() if isinstance(value, bool)
            }
        if isinstance(state.get("memory_enabled"), bool):
            self.memory_enabled = state["memory_enabled"]
        if isinstance(state.get("user_tools"), dict):
            self.user_tools = dict(state["user_tools"])
            self.user_tools_pinned = True
        self._cost_limit_reached = self._resume_prior_status == "COST_LIMIT_REACHED"
        if self._resume_prior_status == "OUT_OF_CREDITS":
            self._has_credits = False
        self.is_paused = self._resume_prior_status in {"PAUSED", "COST_LIMIT_REACHED", "OUT_OF_CREDITS"}
        self._user_pause_active = False

        runtime = state.get("runtime_state")
        if not isinstance(runtime, dict):
            return

        self._deployment_validation = runtime.get("deployment_validation") is True
        self.last_message_check = self._restored_datetime(runtime.get("last_message_check"))
        self._paused_by_parent = runtime.get("paused_by_parent") is True
        self._user_pause_active = self.is_paused and runtime.get("user_pause_active") is True
        pause_sequence = runtime.get("pause_signal_sequence")
        if type(pause_sequence) is int and pause_sequence >= 0:
            self._pause_signal_sequence = pause_sequence
        self._orphaned = runtime.get("orphaned") is True
        # kill_agent's killer survives continue_as_new (abort reason + parent report).
        kill_request = runtime.get("kill_request")
        self._kill_request = dict(kill_request) if isinstance(kill_request, dict) else None
        abort_info = runtime.get("abort_info")
        self._abort_info = dict(abort_info) if isinstance(abort_info, dict) else None
        self._parent_query_failures_while_paused = int(runtime.get("parent_query_failures", 0))
        self._has_new_messages = runtime.get("has_new_messages") is True
        self._last_signal_response = (
            runtime.get("last_signal_response") if isinstance(runtime.get("last_signal_response"), str) else None
        )
        if isinstance(runtime.get("signal_responses"), dict):
            self._signal_responses = dict(runtime["signal_responses"])
        self._pending_approval_resume = _canonical_pending_approval_resume(runtime.get("pending_approval_resume"))
        if isinstance(runtime.get("response_schema_feedback"), list):
            source_rows = runtime.get("response_schema_feedback_sources")
            self._response_schema_feedback = []
            self._response_schema_feedback_sources = []
            for index, value in enumerate(runtime["response_schema_feedback"]):
                if not isinstance(value, str):
                    continue
                source = source_rows[index] if isinstance(source_rows, list) and index < len(source_rows) else None
                self._response_schema_feedback.append(value)
                self._response_schema_feedback_sources.append(
                    tuple(source)
                    if isinstance(source, list) and source and all(isinstance(part, str) for part in source)
                    else None
                )
        self._response_schema_revision = int(runtime.get("response_schema_revision", 0))
        self._response_schema_applied_revision = int(runtime.get("response_schema_applied_revision", 0))
        self._response_schema_initialized = runtime.get("response_schema_initialized") is True
        self._response_schema_refresh_failed_revision = int(runtime.get("response_schema_refresh_failed_revision", 0))
        self._response_schema_refresh_error = (
            runtime.get("response_schema_refresh_error")
            if isinstance(runtime.get("response_schema_refresh_error"), str)
            else None
        )
        accepted_revision = runtime.get("response_schema_accepted_revision")
        if isinstance(accepted_revision, int) and accepted_revision >= 0:
            self._response_schema_accepted_revision = accepted_revision
        elif self._response_schema_refresh_failed_revision == 0 and self._response_schema_refresh_error is None:
            # Legacy successful processing included adoption. A consumed failure
            # cannot prove which input revision the native contract covers.
            self._response_schema_accepted_revision = self._response_schema_applied_revision
        else:
            self._response_schema_accepted_revision = 0
        if (
            self._response_schema_accepted_revision < self._response_schema_applied_revision
            and self._response_schema_refresh_failed_revision >= self._response_schema_applied_revision
        ):
            # Older snapshots acknowledged failed generation as processed.
            # Reopen that input for the existing retry owner after deployment.
            self._response_schema_applied_revision = self._response_schema_accepted_revision
        self._response_schema_refresh_exception = None
        failure_reason = runtime.get("response_schema_refresh_failure_reason")
        self._response_schema_refresh_failure_reason = (
            failure_reason if isinstance(failure_reason, str) else self._response_schema_refresh_error
        )
        if isinstance(runtime.get("response_schema_feedback_rows"), list):
            self._response_schema_feedback_rows = {
                tuple(value)
                for value in runtime["response_schema_feedback_rows"]
                if isinstance(value, list) and all(isinstance(part, str) for part in value)
            }
        if isinstance(runtime.get("response_schema_task_base"), str):
            self._response_schema_task_base = runtime["response_schema_task_base"]
        if isinstance(runtime.get("response_schema_task_baseline_rows"), list):
            self._response_schema_task_baseline_rows = {
                tuple(value)
                for value in runtime["response_schema_task_baseline_rows"]
                if isinstance(value, list) and all(isinstance(part, str) for part in value)
            }
        if isinstance(runtime.get("response_schema_attention_events"), dict):
            self._response_schema_attention_events = {
                key: value
                for key, value in runtime["response_schema_attention_events"].items()
                if isinstance(key, str) and isinstance(value, str)
            }
        if isinstance(runtime.get("response_schema_pending_signals"), dict):
            self._response_schema_pending_signals = {
                key: value
                for key, value in runtime["response_schema_pending_signals"].items()
                if isinstance(key, str) and isinstance(value, int) and value > 0
            }
        self._response_schema_baseline_initialized = runtime.get("response_schema_baseline_initialized") is True
        self._has_credits = runtime.get("has_credits", self._has_credits) is True
        self._last_credit_check = int(runtime.get("last_credit_check", 0))
        self.write_lock_enabled = runtime.get("write_lock_enabled", True) is True
        self._browser_activity_cleanup_unknown = runtime.get("browser_activity_cleanup_unknown") is True
        self._signup_completed = runtime.get("signup_completed") is True
        self._signup_dismissed = runtime.get("signup_dismissed") is True
        if isinstance(runtime.get("context"), list):
            self.context = list(runtime["context"])
        self._cloud_agent_lifecycle_tool_call_id = (
            runtime.get("cloud_agent_lifecycle_tool_call_id")
            if isinstance(runtime.get("cloud_agent_lifecycle_tool_call_id"), str)
            else None
        )
        self._cloud_agent_lifecycle_start_phase = (
            runtime.get("cloud_agent_lifecycle_start_phase")
            if isinstance(runtime.get("cloud_agent_lifecycle_start_phase"), str)
            else None
        )
        if isinstance(runtime.get("cloud_agent_lifecycle_updates_sent"), list):
            self._cloud_agent_lifecycle_updates_sent = {
                value for value in runtime["cloud_agent_lifecycle_updates_sent"] if isinstance(value, str)
            }
        self._cloud_agent_lifecycle_finished = runtime.get("cloud_agent_lifecycle_finished") is True
        if isinstance(runtime.get("pending_children"), list):
            self.pending_children = {value for value in runtime["pending_children"] if isinstance(value, str)}
        for field_name in (
            "child_tool_ids",
            "child_results",
            "child_workflow_ids",
        ):
            value = runtime.get(field_name)
            if isinstance(value, dict):
                setattr(self, field_name, dict(value))
        runtime_child_tool_counts = runtime.get("child_tool_counts")
        if isinstance(runtime_child_tool_counts, dict):
            self.child_tool_counts.update(
                {
                    str(key): int(value)
                    for key, value in runtime_child_tool_counts.items()
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
                }
            )
        if isinstance(runtime.get("tools_in_use"), list):
            self.tools_in_use = {value for value in runtime["tools_in_use"] if isinstance(value, str)}
        if isinstance(runtime.get("output_schema"), dict):
            self.output_schema = runtime["output_schema"]
        runtime_start_time = self._restored_datetime(runtime.get("start_time"))
        if runtime_start_time is not None:
            self.start_time = runtime_start_time
        self._last_tree_cost_emit_at = self._restored_datetime(runtime.get("last_tree_cost_emit_at"))
        self._last_tree_state_emit_at = self._restored_datetime(runtime.get("last_tree_state_emit_at"))
        self._last_parent_state_query_at = self._restored_datetime(runtime.get("last_parent_state_query_at"))
        last_parent_state = runtime.get("last_parent_state")
        self._last_parent_state = dict(last_parent_state) if isinstance(last_parent_state, dict) else {}
        # Runtime keys are persisted across continuation runs, so the DEMO cache
        # fields keep their original stored names (fast_cache_*).
        for runtime_key, field_name in (
            ("compute_token_lineage_key", "compute_token_lineage_key"),
            ("compute_token_fast_cache_affinity_key", "compute_token_demo_cache_affinity_key"),
            ("actual_model", "actual_model"),
            ("system_name", "system_name"),
            ("custom_system_prompt", "custom_system_prompt"),
            ("agent_source", "agent_source"),
            ("user_context_section", "user_context_section"),
            ("project_context_section", "project_context_section"),
            ("fast_cache_goal", "demo_cache_goal"),
            ("root_goal", "root_goal"),
        ):
            value = runtime.get(runtime_key)
            if isinstance(value, str):
                setattr(self, field_name, value)
        if isinstance(runtime.get("model_pricing_cache"), dict):
            self.model_pricing_cache = dict(runtime["model_pricing_cache"])
        actual_input_price = runtime.get("input_cents_per_1k")
        if isinstance(actual_input_price, (int, float)) and not isinstance(actual_input_price, bool):
            self.input_cents_per_1k = float(actual_input_price)
        actual_output_price = runtime.get("output_cents_per_1k")
        if isinstance(actual_output_price, (int, float)) and not isinstance(actual_output_price, bool):
            self.output_cents_per_1k = float(actual_output_price)
        if "cost_limit_wrapup_pending" in runtime:
            self._cost_limit_wrapup_pending = runtime.get("cost_limit_wrapup_pending") is True
        if "cost_limit_wrapup_consumed" in runtime:
            self._cost_limit_wrapup_consumed = runtime.get("cost_limit_wrapup_consumed") is True
        if (
            self._resume_prior_status == "COST_LIMIT_REACHED"
            and self._cost_limit_wrapup_pending
            and not self._cost_limit_wrapup_consumed
            and runtime.get("cost_limit_wrapup_paused") is False
            and self._has_credits
            and not self._user_pause_active
            and not self._paused_by_parent
        ):
            self.is_paused = False
        self._restore_background_state(runtime.get("background_agents"))
        pending_tool_resumes = runtime.get("pending_tool_resumes")
        if isinstance(pending_tool_resumes, list):
            # A spawn_agent parked by a generation before task_name gets a stable one.
            self._pending_tool_resumes = [
                with_legacy_spawn_task_name(record)
                for record in pending_tool_resumes
                if isinstance(record, dict)
                and isinstance(record.get("tool_name"), str)
                and isinstance(record.get("tool_call_id"), str)
                and isinstance(record.get("tool_args"), dict)
                and isinstance(record.get("resume"), dict)
            ]

    def _maybe_arm_cost_limit_wrapup_after_browser(
        self,
        *,
        tool_name: str,
        result: Any,
        paused_before: bool,
        cost_limit_before: bool,
        pause_sequence_before: Optional[int] = None,
    ) -> None:
        """Allow one attempt_completion turn when browser costs newly trip the limit.

        Only arms for verified browser usage that newly crosses the limit.
        Existing user/parent pauses and intervening pause signals stay intact.
        """
        if tool_name not in {"spawn_browser_agent", "spawn_agent"}:
            return
        if not isinstance(result, dict):
            return
        success = result.get("success") is True or str(result.get("status") or "").lower() in {
            "completed",
            "success",
        }
        if not success:
            return
        if not self._cost_limit_reached and (
            self.parent_workflow_id is not None or self.subtree_cost_cents < self.price_limit_cents
        ):
            return
        # Tool did not newly trip the limit — do not clear an unrelated pause.
        if cost_limit_before or paused_before or self._paused_by_parent or not self._has_credits:
            return
        # Terminal accounting arms before a budget pause. Any pause that is
        # present now belongs to an independent control and must stay paused.
        if pause_sequence_before is not None and (
            self.is_paused or self._pause_signal_sequence != pause_sequence_before
        ):
            return
        workflow.logger.warning(
            "💰 Successful spawn_browser_agent tripped the cost limit "
            f"({self.subtree_cost_cents:.1f}c >= {self.price_limit_cents}c); "
            "allowing one wrap-up turn for attempt_completion"
        )
        self.is_paused = False
        self._user_pause_active = False
        self._cost_limit_reached = True
        self._cost_limit_wrapup_pending = True
        self._cost_limit_wrapup_consumed = False

    def _apply_deployment_control_state(self, agent_config: Dict[str, Any]) -> None:
        """Let a pause/resume/limit update that raced cutover win from the DB."""
        status = agent_config.get("status")
        if status == "PAUSED":
            self._resume_prior_status = "PAUSED"
            self.is_paused = True
            self._cost_limit_reached = False
        elif status == "COST_LIMIT_REACHED":
            self._resume_prior_status = "COST_LIMIT_REACHED"
            self.is_paused = True
            self._cost_limit_reached = True
        elif status == "OUT_OF_CREDITS":
            self._resume_prior_status = "OUT_OF_CREDITS"
            self.is_paused = True
            self._has_credits = False
        elif status == "ACTIVE":
            self._resume_prior_status = "ACTIVE"
            self.is_paused = False
            self._user_pause_active = False
            self._cost_limit_reached = False
            self._has_credits = True
        price_limit = agent_config.get("price_limit_cents")
        if isinstance(price_limit, int) and not isinstance(price_limit, bool) and price_limit > 0:
            self.price_limit_cents = price_limit

    def _continuation_resume_state(self) -> Dict[str, Any]:
        """Snapshot every mutable value needed after a continue-as-new boundary.

        The conversation is NOT part of this snapshot: it travels once as the
        continuation's ``context`` argument. Carrying a second copy doubled the
        payload, and Temporal fails the workflow task (TMPRL1103) when a command's
        payloads exceed ~2 MB, which wedged a cooperative cutover for a 1 MB agent.
        """
        # Tree totals are derived state. Recompute at the serialization boundary
        # so even a zero-cost/direct-token call cannot leave the durable tree
        # snapshot behind the own counters.
        self.tree_tokens_in = self.tokens_in + sum(self.children_tokens_in.values())
        self.tree_tokens_out = self.tokens_out + sum(self.children_tokens_out.values())
        if self._cost_limit_reached:
            prior_status = "COST_LIMIT_REACHED"
        elif not self._has_credits:
            prior_status = "OUT_OF_CREDITS"
        elif self.is_paused:
            prior_status = "PAUSED"
        else:
            prior_status = "ACTIVE"

        return {
            "version": 1,
            "kind": "continuation",
            "prior_status": prior_status,
            "prior_status_message": self._resume_status_message,
            "progress": self._resume_progress,
            "simulated_clock_offset_seconds": self.simulated_clock_offset_seconds,
            "simulated_world_time_ms": self.simulated_world_time_ms,
            "token_count": self.token_count,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "tree_tokens_in": self.tree_tokens_in,
            "tree_tokens_out": self.tree_tokens_out,
            "context_size": self.context_size,
            "message_count": self.message_count,
            "own_cost_cents": self.own_cost_cents,
            "subtree_cost_cents": self.subtree_cost_cents,
            "children_cost_cents": dict(self.children_cost_cents),
            "children_tokens_in": dict(self.children_tokens_in),
            "children_tokens_out": dict(self.children_tokens_out),
            "child_last_tokens": dict(self.child_last_tokens),
            "iteration_offset": self.iteration_offset,
            "max_iterations": self.max_iterations,
            "context_gates": dict(self.context_gates),
            "memory_enabled": bool(getattr(self, "memory_enabled", False)),
            **({"user_tools": dict(self.user_tools)} if getattr(self, "user_tools_pinned", False) else {}),
            "runtime_state": {
                "last_message_check": self._serialized_datetime(self.last_message_check),
                "cost_limit_wrapup_paused": self._cost_limit_wrapup_pending and self.is_paused,
                "paused_by_parent": self._paused_by_parent,
                "pause_signal_sequence": self._pause_signal_sequence,
                "user_pause_active": self._user_pause_active,
                "orphaned": self._orphaned,
                "kill_request": dict(self._kill_request) if self._kill_request is not None else None,
                "abort_info": dict(self._abort_info) if self._abort_info is not None else None,
                "parent_query_failures": self._parent_query_failures_while_paused,
                "has_new_messages": self._has_new_messages,
                "last_signal_response": self._last_signal_response,
                "signal_responses": dict(self._signal_responses),
                "pending_approval_resume": _canonical_pending_approval_resume(self._pending_approval_resume),
                "response_schema_feedback": list(self._response_schema_feedback),
                "response_schema_feedback_sources": [
                    list(self._response_schema_feedback_sources[index])
                    if index < len(self._response_schema_feedback_sources)
                    and self._response_schema_feedback_sources[index] is not None
                    else None
                    for index in range(len(self._response_schema_feedback))
                ],
                "response_schema_feedback_rows": [list(key) for key in sorted(self._response_schema_feedback_rows)],
                "response_schema_task_base": self._response_schema_task_base,
                "response_schema_task_baseline_rows": [
                    list(key) for key in sorted(self._response_schema_task_baseline_rows)
                ],
                "response_schema_attention_events": dict(self._response_schema_attention_events),
                "response_schema_pending_signals": dict(self._response_schema_pending_signals),
                "response_schema_baseline_initialized": self._response_schema_baseline_initialized,
                "response_schema_revision": self._response_schema_revision,
                "response_schema_applied_revision": self._response_schema_applied_revision,
                "response_schema_accepted_revision": self._response_schema_accepted_revision,
                "response_schema_initialized": self._response_schema_initialized,
                "response_schema_refresh_failed_revision": (self._response_schema_refresh_failed_revision),
                "response_schema_refresh_error": self._response_schema_refresh_error,
                "response_schema_refresh_failure_reason": self._response_schema_refresh_failure_reason,
                "has_credits": self._has_credits,
                "last_credit_check": self._last_credit_check,
                "write_lock_enabled": self.write_lock_enabled,
                **({"browser_activity_cleanup_unknown": True}
                   if self._browser_activity_cleanup_unknown else {}),
                "signup_completed": self._signup_completed,
                "signup_dismissed": self._signup_dismissed,
                "cloud_agent_lifecycle_tool_call_id": self._cloud_agent_lifecycle_tool_call_id,
                "cloud_agent_lifecycle_start_phase": self._cloud_agent_lifecycle_start_phase,
                "cloud_agent_lifecycle_updates_sent": sorted(self._cloud_agent_lifecycle_updates_sent),
                "cloud_agent_lifecycle_finished": self._cloud_agent_lifecycle_finished,
                "pending_children": sorted(self.pending_children),
                "child_tool_ids": dict(self.child_tool_ids),
                "child_tool_counts": dict(self.child_tool_counts),
                "child_results": dict(self.child_results),
                "child_workflow_ids": dict(self.child_workflow_ids),
                "tools_in_use": sorted(self.tools_in_use),
                "output_schema": self.output_schema,
                "start_time": self._serialized_datetime(self.start_time),
                "last_tree_cost_emit_at": self._serialized_datetime(self._last_tree_cost_emit_at),
                "last_tree_state_emit_at": self._serialized_datetime(self._last_tree_state_emit_at),
                "last_parent_state_query_at": self._serialized_datetime(self._last_parent_state_query_at),
                "last_parent_state": dict(self._last_parent_state),
                "compute_token_lineage_key": self.compute_token_lineage_key,
                "compute_token_fast_cache_affinity_key": (self.compute_token_demo_cache_affinity_key),
                "input_cents_per_1k": self.input_cents_per_1k,
                "output_cents_per_1k": self.output_cents_per_1k,
                "model_pricing_cache": dict(self.model_pricing_cache),
                "actual_model": self.actual_model,
                "system_name": self.system_name,
                "custom_system_prompt": self.custom_system_prompt,
                "agent_source": self.agent_source,
                "user_context_section": getattr(self, "user_context_section", ""),
                "project_context_section": self.project_context_section,
                "fast_cache_goal": self.demo_cache_goal,
                "root_goal": self.root_goal,
                "cost_limit_wrapup_pending": self._cost_limit_wrapup_pending,
                "cost_limit_wrapup_consumed": self._cost_limit_wrapup_consumed,
                "pending_tool_resumes": list(self._pending_tool_resumes),
                "background_agents": self._background_state_snapshot(),
            },
        }

    def _continuation_args(
        self,
        context: Optional[List[Dict]],
        start_phase: str = "execute_continued",
    ) -> List[Any]:
        """Build the canonical continue_as_new argument contract.

        Default ``execute_continued`` skips PLAN/DAG (paused + execute-phase
        handoff). PLAN-phase generation handoff passes ``start_phase="plan"``
        so the resumed workflow finishes planning instead of jumping to execute.
        """
        args = [
            self.agent_id,
            self.user_id,
            self.goal,
            self.model,
            self.reasoning_max_tokens,
            self.verifier,
            # None means "the live conversation": run() adopts a list argument over restored state.
            context if isinstance(context, list) else list(self.context),
            self.parent_workflow_id,
            self.parent_agent_id,
            self.depth,
            self.bus_id,
            start_phase,
            self.max_iterations,
            self.price_limit_cents,
            self.context_gates or None,
            # Temporal slot is the Fast Mode *button* (LLM speed). DEMO cache
            # classification is recomputed in run() from the goal — do not pass
            # self.fast_mode_cache_enabled here or a button-on non-DEMO segment
            # loses provider_fast_mode across continue_as_new.
            self.provider_fast_mode,
            self._continuation_resume_state(),
        ]
        if self.world_model_mode != "real":
            args.append(self.world_model_mode)
        payload_bytes = len(_json.dumps(args, default=str))
        if payload_bytes > CONTINUATION_PAYLOAD_WARN_BYTES:
            workflow.logger.warning(
                f"Continuation payload is {payload_bytes} bytes "
                f"(Temporal rejects ~2 MiB); context messages={len(args[6] or [])}"
            )
        return args

    def _iteration_resume_kwargs(self) -> Dict[str, int]:
        """Keep iteration/cache history across replacement and continuation runs."""
        values = {
            "iteration_offset": self.iteration_offset,
            "demo_cache_position_offset": self.iteration_offset,
        }
        if self.max_iterations is not None:
            values["max_iterations"] = self.max_iterations
        return values

    # =========================================================================
    # SIGNALS
    # =========================================================================

    @workflow.signal(name=GENERATION_HANDOFF_SIGNAL)
    def generation_handoff_available(self, task_queue: str) -> None:
        """Cutover owner: the live pointer moved to ``task_queue``; idle parks re-check now.

        Idempotent per queue. The pointer read stays authoritative (continuation
        admission happens there), so a stale or spoofed hint cannot move us.
        """
        if note_generation_handoff(self, task_queue):
            workflow.logger.info(f"Generation handoff signalled: live={task_queue}")

    @workflow.signal
    async def pause(self, cause: str = "user"):
        """Pause with producer-supplied cause; omitted cause preserves legacy user controls."""
        workflow.logger.info("🔴 Received PAUSE signal")
        self._pause_signal_sequence = getattr(self, "_pause_signal_sequence", 0) + 1
        self._user_pause_active = cause == "user" or (self.is_paused and self._user_pause_active)
        episode_cause = "user" if self._user_pause_active else cause
        self.is_paused = True
        await self._update_tree_state(status="PAUSED")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                # A user pause keeps the legacy zero-argument signal: a child on a
                # draining older generation defines `pause(self)` and would fail its
                # workflow task on every retry if given a cause.
                if episode_cause == "user":
                    await handle.signal("pause")
                else:
                    await handle.signal("pause", episode_cause)
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade pause to child: {e}")

    @workflow.signal
    async def resume(self):
        """Resume workflow execution. Blocked if parent is still paused/cost-limited."""
        if self.parent_workflow_id:
            state = await self._query_parent_state()
            if state.get("is_cost_limit_reached") or state.get("is_paused"):
                workflow.logger.warning("Cannot resume — parent is still paused/cost-limited")
                return
        if not self._has_credits:
            credit_state = await workflow.execute_activity(
                check_user_usage,
                args=[self.user_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            if not credit_state or credit_state.get("has_credits") is not True:
                workflow.logger.warning("Cannot resume — user still has no credits")
                self.is_paused = True
                return
            self._has_credits = True
        workflow.logger.info("🟢 Received RESUME signal")
        self.is_paused = False
        self._user_pause_active = False
        self._paused_by_parent = False
        await self._update_tree_state(status="ACTIVE")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("resume")
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade resume to child: {e}")

    @workflow.signal
    async def receive_user_response(self, response: str):
        """Receive user response - sets flag and stores response for approval checks."""
        workflow.logger.info(f"💬 Received user response (length={len(response)})")
        self._wake_background_waiters()
        # Try to parse as JSON with request_id (from attention request endpoints)
        try:
            data = _json.loads(response)
            if isinstance(data, dict) and "request_id" in data:
                req_id = data["request_id"]
                actual_response = data.get("response", "")
                # Explicit authored provenance is separate from the gate protocol.
                if "user_message" in data:
                    self._record_response_schema_feedback(data["user_message"], request_id=req_id, authored=True)
                else:
                    if isinstance(actual_response, str) and actual_response.strip() == REJECTION_SENTINEL:
                        await self._receive_rejection_schema_feedback()
                    self._record_response_schema_feedback(actual_response)
                # Publish only after intake: request-scoped waiters may run while
                # legacy rejection feedback awaits its durable poll.
                self._signal_responses[req_id] = actual_response
                workflow.logger.info(f"💬 Stored response for request {req_id}")
                return
        except (ValueError, TypeError, KeyError):
            pass
        # Legacy: plain string (from chat messages, SMS, etc.)
        self._last_signal_response = response
        self._has_new_messages = True
        self._record_response_schema_feedback(response)
        # A real user message ends every in-tool wait (wait_for, idle turn wait).
        self._note_wait_wake("user_message")

    @workflow.signal
    async def receive_agent_message(self, data: dict):
        """Another agent in this tree stored a message for us ({message_id}).

        Only wakes the loop: the row is polled like any other, never counts as
        user feedback, and never lifts a pause.
        """
        if isinstance(data, dict) and data.get("wake_task_id"):
            # Another agent messaged one of our finished explore/browser/code tasks:
            # start its next run (the row is task-addressed, so our loop is not woken).
            await self._wake_background_task_from_signal(data)
            return
        if self._accept_agent_message_signal(data):
            workflow.logger.info(f"📨 Received agent message {str((data or {}).get('message_id'))[:36]}")

    @workflow.signal
    async def kill(self, data: dict):
        """kill_agent: kill this agent and its subtree ({by_agent_id}), or one own
        background task ({task_id})."""
        await self._accept_kill_signal(data)

    @staticmethod
    def _response_schema_attention_event_id(message: Dict) -> Optional[str]:
        metadata = message.get("metadata") or {}
        request_id = metadata.get("attentionRequestId")
        if metadata.get("source") == "attention_response" and isinstance(request_id, str) and request_id:
            return request_id
        return None

    def _record_response_schema_feedback(
        self,
        response: Any,
        *,
        request_id: Optional[str] = None,
        authored: bool = False,
    ) -> None:
        """Queue one authored event, independently of its signal/row delivery order."""
        if not isinstance(response, str):
            return
        normalized = response.strip()
        if not normalized or (
            not authored
            and (normalized in ATTENTION_CONTROL_RESPONSES or normalized.casefold() in {"approve", "approved"})
        ):
            return
        if request_id is not None:
            if request_id in self._response_schema_attention_events:
                return
            self._response_schema_attention_events[request_id] = response
        self._append_response_schema_feedback(
            response,
            ("attention_response", request_id) if request_id is not None else None,
        )
        text = response.strip()
        if text:
            if request_id is None:
                self._response_schema_pending_signals[text] = self._response_schema_pending_signals.get(text, 0) + 1
            self._bind_response_schema_feedback_rows(self.context)
        self._response_schema_revision += 1
        self._response_schema_refresh_error = None
        self._has_new_messages = True
        self._start_response_schema_refresh()

    def _append_response_schema_feedback(self, response: str, source: Optional[Tuple[str, ...]] = None) -> None:
        """Keep authored text paired with proven source identity; legacy text stays unknown."""
        count = len(self._response_schema_feedback)
        self._response_schema_feedback_sources = self._response_schema_feedback_sources[:count]
        self._response_schema_feedback_sources.extend([None] * (count - len(self._response_schema_feedback_sources)))
        self._response_schema_feedback.append(response)
        self._response_schema_feedback_sources.append(source)

    def _establish_response_schema_task_boundary(self, messages: List[Dict]) -> None:
        """A fresh task consumes the observed USER prefix, not future source IDs."""
        latest_index = next(
            (
                index
                for index in range(len(messages) - 1, -1, -1)
                if latest_real_user_instruction([messages[index]]) is not None
            ),
            None,
        )
        if latest_index is None:
            return
        self._response_schema_task_base = messages[latest_index]["text"]
        for message in messages[: latest_index + 1]:
            keys = _requirement_keys([message])
            self._response_schema_task_baseline_rows.update(keys)
            self._response_schema_feedback_rows.update(keys)
            event_id = self._response_schema_attention_event_id(message)
            if keys and event_id is not None and isinstance(message.get("text"), str):
                self._response_schema_attention_events.setdefault(event_id, message["text"])
        self._response_schema_baseline_initialized = True

    def _bind_response_schema_feedback_rows(self, messages: List[Dict]) -> None:
        """Associate accepted plain-signal occurrences with durable USER identities."""
        if not self._response_schema_baseline_initialized:
            first_user = next((message for message in messages if _real_user_requirement_keys([message])), None)
            if first_user is not None:
                if first_user.get("text") in (self.goal, self.demo_cache_goal):
                    self._response_schema_feedback_rows.update(_real_user_requirement_keys([first_user]))
                self._response_schema_baseline_initialized = True
        for message in messages:
            keys = _requirement_keys([message])
            if not keys or not isinstance(message.get("text"), str):
                continue
            event_id = self._response_schema_attention_event_id(message)
            if event_id is not None:
                if event_id in self._response_schema_attention_events:
                    self._response_schema_feedback_rows.update(keys)
                # Canonical attention rows never consume another event's legacy
                # text occurrence, even when two authors wrote the same text.
                continue
            key = next(iter(keys))
            text = message["text"].strip()
            if key in self._response_schema_feedback_rows or not self._response_schema_pending_signals.get(text, 0):
                continue
            self._response_schema_feedback_rows.add(key)
            self._response_schema_pending_signals[text] -= 1
            if self._response_schema_pending_signals[text] == 0:
                del self._response_schema_pending_signals[text]

    def _admit_durable_response_schema_feedback(self) -> None:
        """Queue requirement rows once (real USER rows and ancestor task updates), including rows polled before their signal."""
        self._bind_response_schema_feedback_rows(self.context)
        for message in self.context:
            keys = _requirement_keys([message])
            text = message.get("text")
            event_id = self._response_schema_attention_event_id(message)
            if (
                not keys
                or not (keys - self._response_schema_feedback_rows)
                or not isinstance(text, str)
                or (event_id is None and text.strip() in ATTENTION_CONTROL_RESPONSES)
            ):
                continue
            self._response_schema_feedback_rows.update(keys)
            if event_id is not None:
                if event_id in self._response_schema_attention_events:
                    continue
                self._response_schema_attention_events[event_id] = text
            self._append_response_schema_feedback(text, next(iter(keys)))
            self._response_schema_revision += 1
            self._response_schema_refresh_error = None
            self._has_new_messages = True
        self._start_response_schema_refresh()

    async def _receive_rejection_schema_feedback(self) -> None:
        """Accept durable rejection text before releasing the request-scoped wait."""
        self._bind_response_schema_feedback_rows(self.context)
        timestamps = [self._restored_datetime(message.get("timestamp")) for message in self.context]
        last_checked = max(
            (
                value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
                for value in timestamps
                if value is not None
            ),
            default=datetime.fromtimestamp(0, tz=timezone.utc),
        )
        last_checked = max(datetime.fromtimestamp(0, tz=timezone.utc), last_checked - timedelta(milliseconds=1))
        try:
            await self._poll_messages(last_checked)
        except ActivityError as error:
            if any(
                error_chain_has_type(error, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            workflow.logger.warning(f"Rejection feedback poll failed; retaining received input: {error}")
        self._admit_durable_response_schema_feedback()

    @workflow.signal
    async def child_progress(self, data: dict):
        """Receive progress update from child agent."""
        child_agent_id = data.get("child_agent_id", "")
        progress = data.get("progress", 0.0)
        tokens_in = data.get("tokens_in", 0)
        tokens_out = data.get("tokens_out", 0)
        token_count = data.get("token_count", 0)
        goal = data.get("goal", "")

        # Progress counters describe the child, never this workflow. Keep the
        # latest observation for restart-safe child bookkeeping, while
        # child_cost_update remains the authoritative subtree aggregation path.
        # Invariant: self.tokens_* and self.token_count are own-only at every
        # persistence boundary.
        self.child_last_tokens[child_agent_id] = {
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "token_count": token_count,
        }

        # Post progress update
        child_tool_id = self.child_tool_ids.get(child_agent_id)
        if child_tool_id:
            await self._post_message(
                f"Progress: {int(progress * 100)}%",
                "TOOL",
                metadata={
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_general_purpose_agent",
                    "toolStatus": "IN_PROGRESS",
                    "title": goal[:30] if goal else "Sub-agent",
                    "subAgentId": child_agent_id,
                    "progress": progress,
                },
            )

    @workflow.signal
    async def child_completed(self, data: dict):
        """Receive completion signal from child agent (success or failure)."""
        child_agent_id = data.get("child_agent_id", "")
        if self._is_finished:
            # Late signal from a child stopped when this agent finished: the
            # parent is done, so nothing is posted or aggregated.
            self.pending_children.discard(child_agent_id)
            workflow.logger.info(f"Ignoring child_completed from {child_agent_id[:8]} after finish")
            return
        result = data.get("result", {})
        # A child woken by an agent message reports again: append a notification,
        # never rewrite its original spawn result (workflows/agent_control.py).
        if await self._on_rewoken_child_completed(child_agent_id, result if isinstance(result, dict) else {}):
            return
        child_status = result.get("status", "completed")

        child_tool_id = self.child_tool_ids.get(child_agent_id)
        goal_text = result.get("goal", "")

        child_status_normalized = str(child_status or "").strip().lower()
        child_failed = (
            child_status_normalized in {"failed", "error", "max_iterations"} or result.get("success") is False
        )

        if child_failed:
            # Child agent failed
            workflow.logger.warning(f"❌ Child {child_agent_id[:8]} failed: {result.get('error_reason', 'unknown')}")

            if child_tool_id:
                best_effort = (
                    result.get("best_effort_response")
                    or result.get("final_response")
                    or result.get("summary")
                    or result.get("message")
                    or "Sub-agent failed"
                )
                structured_response = (
                    result.get("structured_response")
                    or result.get("partial_structured_response")
                    or (result.get("failure_context") or {}).get("partial_structured_response")
                )
                metadata = {
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_general_purpose_agent",
                    "toolStatus": "ERROR",
                    "title": f"❌ Sub-agent failed: {goal_text[:30]}",
                    "subAgentId": child_agent_id,
                    "error": True,
                    "error_reason": result.get("error_reason") or result.get("message") or child_status_normalized,
                }
                if structured_response is not None:
                    metadata["structuredResponse"] = structured_response
                    metadata["structured_response"] = structured_response
                await self._post_message(
                    best_effort,
                    "TOOL",
                    metadata=metadata,
                )
        else:
            # Child agent succeeded
            workflow.logger.info(f"✅ Child {child_agent_id[:8]} completed")

            # Aggregate tool counts from child
            child_counts = result.get("tool_counts", {})
            for tool_name, count in child_counts.items():
                self.child_tool_counts[tool_name] = self.child_tool_counts.get(tool_name, 0) + count

            if child_tool_id:
                summary = result.get("summary", "")
                structured_response = result.get("structured_response")
                await self._post_message(
                    summary if summary else f"Completed: {goal_text}",
                    "TOOL",
                    metadata={
                        "toolCallId": child_tool_id,
                        "toolName": "spawn_general_purpose_agent",
                        "toolStatus": "FINISHED",
                        "title": f"Sub-agent completed: {goal_text[:30]}",
                        "subAgentId": child_agent_id,
                        "progress": 1.0,
                        "structuredResponse": structured_response,
                        "childToolCounts": child_counts,
                    },
                )

        # Store result for file extraction in spawn_sub_agents after wait_condition
        self.child_results[child_agent_id] = result

        self.pending_children.discard(child_agent_id)
        # wait_for(agents=[...]) listing this child ends now.
        self._note_wait_wake(
            "child_completed", agent_id=child_agent_id, status="failed" if child_failed else "completed"
        )
        # A background general_purpose/for_each carried across a continuation
        # has no live task: this signal posts its notification.
        await self._on_background_child_completed(child_agent_id)

    @workflow.signal
    async def signup_completed(self):
        """Signal that user has completed signup (from request_user_signup tool)."""
        workflow.logger.info("✅ Received signup_completed signal")
        self._signup_completed = True

    @workflow.signal
    async def signup_dismissed(self):
        """Signal that user dismissed the signup prompt (continuing as anonymous)."""
        workflow.logger.info("⏭️ Received signup_dismissed signal")
        self._signup_dismissed = True

    @workflow.signal
    async def child_cost_update(self, data: dict):
        """Receive cost and token update from a child agent (hierarchical relay upward)."""
        child_agent_id = data.get("child_agent_id", "")
        subtree_cost = data.get("subtree_cost_cents", 0)
        subtree_tokens_in = data.get("subtree_tokens_in", 0)
        subtree_tokens_out = data.get("subtree_tokens_out", 0)

        # Update this child's cost and tokens in our tracking
        self.children_cost_cents[child_agent_id] = subtree_cost
        self.children_tokens_in[child_agent_id] = subtree_tokens_in
        self.children_tokens_out[child_agent_id] = subtree_tokens_out

        # Recalculate our subtree and propagate upward
        await self._update_cost_and_signal_parent()

    @workflow.signal
    async def parent_finished(self, data: Optional[Dict[str, Any]] = None):
        """Parent finished while this agent ran in its background: stop as orphaned.

        A killed parent says so ({killed_by, killed_parent}): this agent fails with
        "Killed by K (parent P was killed)".
        """
        data = data if isinstance(data, dict) else {}
        killed_by = data.get("killed_by") if isinstance(data.get("killed_by"), str) else None
        message = (
            f"Killed by {killed_by} (parent {data.get('killed_parent') or 'agent'} was killed)" if killed_by else None
        )
        self._abort_run(message, killed_by=killed_by)

    @workflow.signal
    async def cost_limit_reached(self):
        """Received from parent when cost limit exceeded."""
        workflow.logger.warning("⚠️ Cost limit reached signal received - pausing")
        self.is_paused = True
        self._cost_limit_reached = True
        self._paused_by_parent = True
        await self._update_tree_state(status="COST_LIMIT_REACHED")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("cost_limit_reached")
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade cost_limit_reached to child: {e}")

    @workflow.signal
    async def price_limit_increased(self, data: dict):
        """Price limit increased. Cascades to children."""
        if self.parent_workflow_id:
            state = await self._query_parent_state()
            if state.get("is_cost_limit_reached"):
                workflow.logger.warning("Cannot accept price_limit_increased — parent still cost-limited")
                return

        new_limit = data.get("new_limit_cents", 25)
        workflow.logger.info(f"💰 Price limit increased to {new_limit} cents")

        self.price_limit_cents = new_limit
        self._cost_limit_reached = False
        self.is_paused = False
        self._user_pause_active = False
        self._paused_by_parent = False
        await self._update_tree_state(status="ACTIVE")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("price_limit_increased", data)
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade price_limit_increased to child: {e}")

    # =========================================================================
    # MAIN RUN
    # =========================================================================

    @workflow.run
    async def run(
        self,
        agent_id: str,
        user_id: str,
        goal: str,
        model: str,
        reasoning_max_tokens: int,
        verifier: Dict,
        context: Optional[List[Dict]] = None,
        parent_workflow_id: Optional[str] = None,
        parent_agent_id: Optional[str] = None,
        depth: int = 0,
        bus_id: Optional[str] = None,
        start_phase: str = "plan",  # "plan" runs PLAN→EXECUTE, "execute" skips PLAN
        max_iterations: Optional[int] = None,  # Step limit for execute phase (sub-agents use 25)
        price_limit_cents: int = 100,  # Price limit in cents (default $1.00)
        context_gates: Optional[Dict[str, bool]] = None,  # Control which user context sections to include
        fast_mode_cache_enabled: bool = False,  # Temporal arg: Fast Mode *button* (LLM speed)
        resume_state: Optional[Dict] = None,  # Deployment or continue-as-new durable runtime state
        world_model_mode: str = "real",  # Per-agent provider/environment execution mode
        memory_enabled: bool = False,  # Planner memory: get_memories fork from the finalized-run history
    ) -> Dict:
        """Execute agent task; an escaping activity failure ends the agent FAILED."""
        try:
            return await self._run_phases(
                agent_id,
                user_id,
                goal,
                model,
                reasoning_max_tokens,
                verifier,
                context,
                parent_workflow_id,
                parent_agent_id,
                depth,
                bus_id,
                start_phase,
                max_iterations,
                price_limit_cents,
                context_gates,
                fast_mode_cache_enabled,
                resume_state,
                world_model_mode,
                memory_enabled,
            )
        except FailureError as e:
            # Only Temporal failures (ActivityError, ApplicationError, ...) end the
            # execution; other exceptions fail just the workflow task, which
            # Temporal retries without a terminal status. An escaping activity
            # failure (e.g. poll_new_messages timing out on a saturated worker)
            # would otherwise close the execution with the agent row still ACTIVE,
            # and the parent would wait on it indefinitely. End it FAILED instead.
            if self._is_finished or any(
                error_chain_has_type(e, kind)
                for kind in ("CancelledError", "WorkflowGenerationSealed", "GenerationHandoffRequested")
            ):
                raise
            message = f"Execution stopped by an unrecoverable error: {extract_error_message(e)}"
            await self._mark_failed(context=self.context, reason="workflow_error", message=message)
            return {"status": "failed", "reason": "workflow_error", "goal": goal}

    async def _run_phases(
        self,
        agent_id: str,
        user_id: str,
        goal: str,
        model: str,
        reasoning_max_tokens: int,
        verifier: Dict,
        context: Optional[List[Dict]] = None,
        parent_workflow_id: Optional[str] = None,
        parent_agent_id: Optional[str] = None,
        depth: int = 0,
        bus_id: Optional[str] = None,
        start_phase: str = "plan",  # "plan" runs PLAN→EXECUTE, "execute" skips PLAN
        max_iterations: Optional[int] = None,  # Step limit for execute phase (sub-agents use 25)
        price_limit_cents: int = 100,  # Price limit in cents (default $1.00)
        context_gates: Optional[Dict[str, bool]] = None,  # Control which user context sections to include
        fast_mode_cache_enabled: bool = False,  # Temporal arg: Fast Mode *button* (LLM speed)
        resume_state: Optional[Dict] = None,  # Deployment or continue-as-new durable runtime state
        world_model_mode: str = "real",  # Per-agent provider/environment execution mode
        memory_enabled: bool = False,  # Planner memory: get_memories fork from the finalized-run history
    ) -> Dict:
        """Execute agent task: optionally PLAN phase → EXECUTE phase."""
        # Bind agent_id to structlog context so ALL downstream structlog calls
        # (tools, helpers, activities) automatically include agent_id in JSON output
        structlog.contextvars.clear_contextvars()
        root_agent_id = agent_id if depth == 0 else (bus_id or parent_agent_id or agent_id)
        structlog.contextvars.bind_contextvars(agent_id=agent_id, root_agent_id=root_agent_id)

        self.agent_id = agent_id
        self.root_agent_id = root_agent_id
        self.user_id = user_id
        self.goal = goal
        self.demo_cache_goal = goal  # Overridden by the persisted row goal below
        self.demo_cache_root_goal = goal
        self.model = model
        self.current_phase = "PLAN"
        self.reasoning_max_tokens = reasoning_max_tokens
        self.verifier = verifier
        self.parent_workflow_id = parent_workflow_id
        self.parent_agent_id = parent_agent_id
        self.depth = depth
        self.bus_id = bus_id
        self.context_gates = context_gates or {}  # Empty dict = all gates open (default)
        # Arg is the Fast Mode button (LLM provider speed). Cache replay is
        # DEMO-prompt only and ignores the button. Catalog DEMO / demo_cache:on
        # goals (incl. small fleet-concurrency probes) share the same gate via
        # is_demo_cache_task; mass-agent-only spawn rules stay on
        # is_oai_demo_mass_agent_task.
        self.provider_fast_mode = bool(fast_mode_cache_enabled)
        self.fast_mode_cache_enabled = is_demo_cache_task(self)
        self.world_model_mode = world_model_mode if world_model_mode in {"simulate", "shadow"} else "real"
        self.memory_enabled = bool(memory_enabled)
        self.simulated_clock_offset_seconds = 0
        self.simulated_world_time_ms = None
        self.max_iterations = max_iterations
        self.price_limit_cents = price_limit_cents  # Use passed value instead of hardcoded default
        self.compute_token_lineage_key = f"agent:{agent_id}"
        self.compute_token_demo_cache_affinity_key = (
            _demo_cache_compute_affinity_key(user_id, goal) if self.fast_mode_cache_enabled else None
        )
        self._restore_deployment_state(resume_state)
        # continue_as_new / deployment resume may restore demo_cache_goal from
        # runtime_state. Recompute the DEMO cache gate from the restored goals
        # so a non-demo input goal cannot leave cache replay disabled when the
        # durable goal is demo (the persisted-goal resolver below no-ops when
        # the restored goal already matches).
        self.fast_mode_cache_enabled = is_demo_cache_task(self)
        self.compute_token_demo_cache_affinity_key = (
            _demo_cache_compute_affinity_key(user_id, self.demo_cache_goal or goal)
            if self.fast_mode_cache_enabled
            else None
        )
        if isinstance(context, list):
            self.context = list(context)
        if self.start_time is None:
            self.start_time = workflow.now()  # Track duration across continue-as-new boundaries
        is_deployment_bootstrap = bool(resume_state and resume_state.get("kind") == "deployment")
        if is_deployment_bootstrap:
            # The replacement was reserved before Temporal start. A user can
            # pause/resume or raise the cost limit in that gap, so reconcile the
            # serialized DB winner before acknowledging/restoring status.
            deployment_control = await workflow.execute_activity(
                fetch_agent_config,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=6),
            )
            self._apply_deployment_control_state(deployment_control)
            # Publish restored durable state and only then consume the replacement
            # claim. The migration gate treats a cleared claim as READY, so this
            # single retry-safe activity cannot acknowledge a half-restored agent.
            bootstrap_status = self._resume_prior_status if self.is_paused else "ACTIVE"
            bootstrap_result = await workflow.execute_activity(
                finalize_workflow_replacement_bootstrap,
                args=[
                    agent_id,
                    bootstrap_status,
                    self._resume_progress,
                    self._resume_status_message or "Resumed after code update",
                    self.token_count,
                    self.context_size,
                    self.message_count,
                    self.tokens_in,
                    self.tokens_out,
                    self.iteration_offset,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=6),
            )
            self._apply_deployment_control_state(
                {
                    "status": bootstrap_result.get("status"),
                    "price_limit_cents": self.price_limit_cents,
                }
            )
            if self.is_paused:
                # Deployment-restored cold states must not enter run_agent's
                # bounded pause polling before reaching a durable wait. Consume no
                # workflow timers or activities until a valid signal unpauses us.
                handoff_queue = await self._wait_for_unpause_or_handoff()
                await self._prepare_response_schema_continuation()
                await self._flush_pending_messages()
                if handoff_queue:
                    workflow.continue_as_new(
                        args=self._continuation_args(context),
                        task_queue=handoff_queue.strip(),
                    )
                else:
                    workflow.continue_as_new(args=self._continuation_args(context))
                return {"status": "paused", "goal": goal}

        workflow.logger.info(f"Agent starting: agent={agent_id}, goal='{goal[:50]}', depth={depth}")

        if not self._deployment_resume:
            await self._register_on_world_clock()
            await self._advance_cloud_agent_lifecycle(PREPARING_CLOUD_AGENT_TITLE, "IN_PROGRESS")
        else:
            await self._recover_world_time_cursor()

        # Post an early heartbeat so external monitors (FE tree, benchmark
        # stall detector) see the agent is alive while init activities run.
        # Init is several short serialized activities and under parallel
        # benchmark load the round trips can stack to >60 s before the first
        # ASSISTANT/TOOL row lands. Without this row the agent looks silent
        # from message-creation time onward and the benchmark fires
        # `tree stalled` before any LLM call has happened. The row is purely
        # a liveness signal — UI renders it as a thin "Initializing" chip
        # and the row becomes irrelevant once a real tool message arrives.
        init_message_posted = False
        if not self._deployment_resume:
            with contextlib.suppress(Exception):
                await workflow.execute_activity(
                    post_agent_message,
                    args=[
                        agent_id,
                        "Agent initializing — fetching context, system prompt, and tool config.",
                        "TOOL",
                        {
                            "toolCallId": "tc-agent-init",
                            "toolName": "agent_init",
                            "toolStatus": "IN_PROGRESS",
                            "title": "Initializing",
                        },
                        None,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                init_message_posted = True

        # Fetch model context window
        if self.max_context_tokens is None:
            try:
                self.max_context_tokens = await workflow.execute_activity(
                    get_model_context_window,
                    args=[model],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            except Exception:
                self.max_context_tokens = 200_000

        # Update status
        startup_status = self._resume_prior_status if self.is_paused else "ACTIVE"
        startup_message = self._resume_status_message or (
            "Restored after code update" if self._deployment_resume else "Agent started"
        )
        with contextlib.suppress(Exception):
            await workflow.execute_activity(
                update_agent_status,
                args=[
                    agent_id,
                    startup_status,
                    self._resume_progress,
                    startup_message,
                    self.token_count,
                    self.context_size,
                    self.message_count,
                    self.tokens_in,
                    self.tokens_out,
                    None,
                    self.iteration_offset,
                ],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # Fetch and cache agent source (WEB, MAC_APP, SMS) for notification gating
        try:
            self.agent_source = await workflow.execute_activity(
                get_agent_source,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            workflow.logger.info(f"Agent source: {self.agent_source}")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch agent source, defaulting to WEB: {e}")

        # Fast Mode: cache keys namespace by exact goal hash. Chat escalation may
        # start this workflow with an LLM-refined goal that differs from the
        # persisted Agent row and varies run to run — keying on it would give every
        # chat-originated run a fresh, empty cache namespace. Resolve the durable
        # DB-row goal once and thread it into all cache keying (the DAG path
        # already resolves it via ensure_position_context; this aligns the
        # explicitly-threaded plan/execute/verifier/summary paths with it).
        try:
            cache_context = await workflow.execute_activity(
                resolve_fast_cache_context_activity,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            persisted_goal = cache_context.get("goal") if isinstance(cache_context, dict) else None
            root_goal = cache_context.get("root_goal") if isinstance(cache_context, dict) else None
            if persisted_goal:
                if persisted_goal != self.demo_cache_goal:
                    workflow.logger.info(
                        "Fast Mode cache goal resolved from agent row (differs from workflow input goal)"
                    )
                self.demo_cache_goal = persisted_goal
            if root_goal:
                self.demo_cache_root_goal = root_goal
                self.root_goal = root_goal
            if isinstance(cache_context, dict) and cache_context.get("resolved", isinstance(persisted_goal, str)):
                self.fast_mode_cache_enabled = bool(cache_context.get("enabled"))
                self.provider_fast_mode = bool(cache_context.get("provider_fast_mode", self.provider_fast_mode))
            self.compute_token_demo_cache_affinity_key = (
                _demo_cache_compute_affinity_key(user_id, self.demo_cache_goal)
                if self.fast_mode_cache_enabled
                else None
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to resolve Fast Mode cache context, using workflow input goal: {e}")

        # Helper: gate is open unless explicitly False
        def _gate_open(name: str) -> bool:
            return self.context_gates.get(name, True)

        # Kick SMS off the critical path — start now, await after first LLM.
        # Prod traces showed ~2–4s here before any model call.
        self._deferred_startup_sms_handle = None
        if not parent_workflow_id and not self._deployment_resume:
            try:
                notification_args = [user_id, "agent_started", agent_id, {"goal": goal}]
                if self.world_model_mode != "real":
                    notification_args.append(self.world_model_mode)
                self._deferred_startup_sms_handle = workflow.start_activity(
                    notify_sms_event_activity,
                    args=notification_args,
                    **wmh_activity_timeout_options(
                        self.world_model_mode, timedelta(seconds=SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS)
                    ),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                workflow.logger.info("Started agent_started SMS notification (deferred await)")
            except Exception as e:
                workflow.logger.warning(f"Failed to start agent_started SMS notification: {e}")

        # Parallelize independent startup fetches (historically one Temporal RTT each).
        user_context_section = getattr(self, "user_context_section", "")

        async def _fetch_user_context() -> str:
            try:
                return await workflow.execute_activity(
                    get_user_context,
                    args=[user_id, self.context_gates],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch user context: {e}")
                return user_context_section

        async def _fetch_system_name() -> Optional[str]:
            try:
                return await workflow.execute_activity(
                    get_user_system_name,
                    args=[user_id],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch system name, using default 'Rose': {e}")
                return None

        async def _fetch_custom_system_prompt() -> Optional[str]:
            if not _gate_open("custom_system_prompt"):
                workflow.logger.info("Skipping custom system prompt (gate closed)")
                return None
            try:
                return await workflow.execute_activity(
                    get_user_custom_system_prompt,
                    args=[user_id],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch custom system prompt: {e}")
                return None

        async def _fetch_agent_config() -> Dict[str, Any]:
            try:
                return await workflow.execute_activity(
                    fetch_agent_config,
                    args=[agent_id],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch agent config for response_schema: {e}")
                self._agent_config_unavailable = True
                return {}

        (
            user_context_section,
            fetched_system_name,
            fetched_custom_system_prompt,
            agent_config,
            _,
        ) = await asyncio.gather(
            _fetch_user_context(),
            _fetch_system_name(),
            _fetch_custom_system_prompt(),
            _fetch_agent_config(),
            self._refresh_compute_token(user_id),
        )

        self.user_context_section = user_context_section or ""
        if self.context_gates:
            workflow.logger.info(f"Context gates applied: {self.context_gates}")
        if fetched_system_name:
            self.system_name = fetched_system_name
            workflow.logger.info(f"Using system name: {self.system_name}")
        if fetched_custom_system_prompt:
            self.custom_system_prompt = fetched_custom_system_prompt
            workflow.logger.info(f"Custom system prompt loaded: {len(self.custom_system_prompt)} chars")

        # Inject custom system prompt as hidden USER message for new agents
        if self.custom_system_prompt and not context and not self._deployment_resume:
            try:
                await self._post_message(
                    f"Personality instructions: {self.custom_system_prompt}",
                    "USER",
                    metadata={
                        "hidden": True,
                        "isCustomSystemPrompt": True,
                    },
                )
                workflow.logger.info("Injected custom system prompt as hidden USER message")
            except Exception as e:
                workflow.logger.warning(f"Failed to inject custom system prompt: {e}")

        response_schema = self.output_schema
        fetched_parent_agent_id = None
        if agent_config:
            # Continuation state owns the accepted contract. The database may
            # lag if its write failed or its acknowledgement was lost.
            if not (self._deployment_resume and isinstance(response_schema, dict) and response_schema.get("fields")):
                response_schema = agent_config.get("response_schema") or response_schema
            fetched_parent_agent_id = agent_config.get("parent_agent_id")
            self._apply_agent_project(agent_config)
            self.output_schema = response_schema
            self.write_lock_enabled = agent_config.get("write_lock_enabled", True)
            workflow.logger.info(
                f"Fetched output_schema: {response_schema is not None}, write_lock_enabled: {self.write_lock_enabled}"
            )

        # If no schema was provided at create time, generate one synchronously NOW.
        # The schema appears in the initial main/verifier system prompts. Awaiting
        # startup generation establishes the initial contract; later genuine user
        # feedback refreshes the accepted native schema asynchronously.
        is_sub_agent = bool(parent_workflow_id or parent_agent_id or fetched_parent_agent_id)
        # Pin the user's published tools once (root, real world only; restored on continue_as_new).
        await pin_user_tools(
            self,
            is_root=not is_sub_agent and self.depth == 0 and self.world_model_mode == "real",
            wf_api=workflow,
        )
        startup_execute_context: Optional[List[Dict[str, Any]]] = None
        # Chat re-escalation after a terminal run starts a new workflow with
        # plan|execute and no resume_state. continue_as_new / deploy resume
        # keep the live schema and plan — a later USER there is mid-run
        # feedback, not a new task.
        is_fresh_start = resume_state is None and start_phase in ("plan", "execute")
        prior_run_superseded = False
        if is_fresh_start and not is_sub_agent:
            startup_execute_context = await workflow.execute_activity(
                poll_new_messages,
                args=[agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
                retry_policy=CONTROL_PLANE_POLL_RETRY,
            )
            startup_execute_context = filter_internal_subagent_messages(startup_execute_context)
            prior_run_superseded = plan_superseded_by_new_user_instruction(startup_execute_context)
            if prior_run_superseded:
                self._establish_response_schema_task_boundary(startup_execute_context)
                # A completed or followed-up run's schema is not live. Chat
                # persist has already moved Agent.goal to the router task;
                # still skip generate-from-row here so a stale leftover cannot
                # win a race, then regenerate from the latest USER below.
                response_schema = None
                self.output_schema = None
        if response_schema is None and self.goal and not is_sub_agent and not prior_run_superseded:
            try:
                generated = await workflow.execute_activity(
                    set_response_schema_activity,
                    args=[
                        agent_id,
                        # Persisted-row goal: schema generation is content-keyed on
                        # this text, so the stable goal keeps it cacheable (and
                        # matches the TS-side setResponseSchema, which reads the
                        # Agent row).
                        [self.demo_cache_goal],
                        self._active_compute_token_payload(),
                        self.fast_mode_cache_enabled,
                        True,
                    ],
                    start_to_close_timeout=timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                if isinstance(generated, dict) and generated.get("schema"):
                    self.output_schema = generated["schema"]
                    response_schema = self.output_schema
                    workflow.logger.info(
                        f"Generated output_schema synchronously with "
                        f"{len(self.output_schema.get('fields', []))} field(s)"
                    )
            except Exception as e:
                if any(
                    error_chain_has_type(e, kind)
                    for kind in (
                        "CancelledError",
                        "WorkflowGenerationSealed",
                        "GenerationHandoffRequested",
                    )
                ):
                    raise
                workflow.logger.warning(f"Failed to generate response_schema at startup: {e}")
        elif response_schema is None and is_sub_agent:
            workflow.logger.info("Skipping response_schema generation for sub-agent")

        if prior_run_superseded and startup_execute_context is not None:
            await self._regenerate_output_schema_for_new_instruction(startup_execute_context)
            response_schema = self.output_schema

        # Later feedback updates this native contract for actor and verifier.
        self._response_schema_initialized = True
        self._start_response_schema_refresh()

        # Resolve model pricing in-process so startup is not blocked by the activity queue.
        pricing = get_in_process_model_pricing(model) or get_default_pricing(model)
        if pricing:
            self.input_cents_per_1k = pricing["input_cents_per_1k"]
            self.output_cents_per_1k = pricing["output_cents_per_1k"]
            workflow.logger.info(
                f"💰 Resolved model pricing: input={self.input_cents_per_1k}c/1k, output={self.output_cents_per_1k}c/1k"
            )

        # Broadcast initial tree state with schema (only for sub-agents with bus_id)
        if self.bus_id:
            await self._update_tree_state(progress=0.0, status=startup_status)

        # If sub-agent, check parent's pause/cost-limit state before starting work
        # (covers race condition where signal arrived after spawn but before we're ready)
        if self.parent_workflow_id:
            await self._check_parent_state()
            if self._orphaned:
                abort_reason, abort_message = self._abort_reason()
                await self._mark_failed(
                    context=context or [], reason=abort_reason, message=abort_message, verifier_reasoning=abort_message
                )
                return {"status": "failed", "reason": abort_reason, "goal": self.goal}

        if self._world_clock_missing():
            # Simulate mode never starts or plans on the real date: the runner
            # creates the WMH world session before starting the root.
            await self._mark_failed(
                context=context or [],
                reason="world_clock_unavailable",
                message=WORLD_CLOCK_UNAVAILABLE_MESSAGE,
            )
            return {"status": "failed", "reason": "world_clock_unavailable", "goal": self.goal}

        # =====================================================================
        # Tool lists from centralized source of truth
        # =====================================================================
        plan_tools = PLAN_PHASE_TOOLS
        execute_tools = (
            ["google_workspace_run", "attempt_completion"] if matches_demo_goal(self.goal) else EXECUTE_PHASE_TOOLS
        )

        # Determine whether to skip PLAN phase and/or DAG. ``execute_dag_resume``
        # is a local checkpoint/debug phase: it keeps the persisted plan, marks
        # already-finished DAG nodes from DB messages, then runs remaining nodes.
        resume_dag_from_context = start_phase == "execute_dag_resume"
        skip_plan = start_phase in ("execute", "execute_continued", "execute_dag_resume", "resume")
        skip_dag = start_phase in ("execute_continued", "resume")

        if init_message_posted:
            with contextlib.suppress(Exception):
                await workflow.execute_activity(
                    post_agent_message,
                    args=[
                        agent_id,
                        "Agent initialization complete.",
                        "TOOL",
                        {
                            "toolCallId": "tc-agent-init",
                            "toolName": "agent_init",
                            "toolStatus": "FINISHED",
                            "title": "Initialized",
                        },
                        None,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )

        # Pre-flight credit gate: if a user starts with exhausted free credits
        # and no subscription, block before spending more compute or running tools.
        if not self.is_paused:
            await self._check_credits()
        self._deployment_initialized = True
        if self._deployment_validation:
            # Candidate-image validation deliberately stops at the last safe
            # boundary before the LLM loop. The deploy gate queries this flag,
            # inspects history for workflow-task failures, then terminates the
            # isolated synthetic execution.
            # cutover-class: deploy-gate — isolated validation run, never a user agent
            await workflow.wait_condition(lambda: not self._deployment_validation)

        # =====================================================================
        # PHASE 1: PLAN (research + create execution plan)
        # =====================================================================
        if not skip_plan:
            self.current_phase = "PLAN"
            self._current_tools = plan_tools
            self._disabled_tools = execute_tools
            workflow.logger.info(f"▶ PLAN phase: {len(plan_tools)} tools")

            plan_result = await self._run_agent_turns(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=self.build_system_prompt,
                verifier_prompt_generator=self._make_verifier_prompt_generator(),
                model=model,
                tools=plan_tools,
                is_inside_temporal_activity=False,
                check_paused=self._check_paused,
                check_aborted=self._check_orphaned,
                wait_for_messages=self._wait_for_messages,
                on_context_overflow=self._handle_context_overflow,
                check_credits=self._check_credits,
                check_generation_handoff=self._check_generation_handoff,
                post_message=self._post_message,
                poll_messages=self._poll_messages,
                execute_tool=self._execute_interruptible_tool,
                update_tree_state=self._update_tree_state,
                get_children_tokens=self._get_children_tokens,
                on_tokens=self._on_tokens,  # Real-time cost tracking and limit checking
                max_context_tokens=self.max_context_tokens,
                reasoning_max_tokens=reasoning_max_tokens,
                is_plan_loop=True,  # PLAN phase: requires set_plan, posts "sit back" message
                response_schema=response_schema,
                get_response_schema=self._make_response_schema_getter(),
                claude_token=self._active_claude_token(),
                get_claude_token=self._active_claude_token,
                get_claude_token_source=self._active_claude_source,
                get_claude_token_pool_id=self._active_claude_pool_id,
                gpt_token=self._active_gpt_token(),
                gpt_account_id=self._active_gpt_account_id(),
                get_gpt_token=self._active_gpt_token,
                get_gpt_account_id=self._active_gpt_account_id,
                get_gpt_token_source=self._active_gpt_source,
                get_gpt_token_pool_id=self._active_gpt_pool_id,
                compute_token_lineage_key=self.compute_token_lineage_key,
                compute_token_demo_cache_affinity_key=self.compute_token_demo_cache_affinity_key,
                fast_mode_cache_enabled=self.fast_mode_cache_enabled,
                goal_text=self.demo_cache_goal,
            )

            await self._track_tokens_and_cost(plan_result)
            if plan_result["status"] == "completed" and _verifier_superseded_by_user_feedback(
                plan_result, self.context, requirement_revision=self._response_schema_revision
            ):
                await self._prepare_response_schema_continuation()
                await self._flush_pending_messages()
                workflow.continue_as_new(args=self._continuation_args(self.context, start_phase="plan"))
                return plan_result

            if plan_result["status"] != "completed":
                return await self._handle_incomplete(plan_result, "PLAN")

            workflow.logger.info("✓ PLAN complete, starting EXECUTE")
        else:
            workflow.logger.info("⏭️ Skipping PLAN phase, starting EXECUTE directly")

        # =====================================================================
        # PHASE 2: EXECUTE (run the plan with full tool access)
        # =====================================================================
        self.current_phase = "EXECUTE"
        self._current_tools = execute_tools
        self._disabled_tools = []  # No disabled tools in EXECUTE phase
        workflow.logger.info(f"▶ EXECUTE phase: {len(execute_tools)} tools")

        # Get context from PLAN phase (or poll if skipped)
        if not skip_plan:
            execute_context = plan_result.get("context", [])
        elif startup_execute_context is not None:
            execute_context = startup_execute_context
        else:
            # Poll messages to get context if we skipped PLAN
            # Use epoch timestamp to get ALL messages (not None - that crashes poll_new_messages)
            execute_context = await workflow.execute_activity(
                poll_new_messages,
                args=[agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
                retry_policy=CONTROL_PLANE_POLL_RETRY,
            )
            execute_context = filter_internal_subagent_messages(execute_context)

        # Try DAG execution if a plan exists (skip after continue_as_new — DAG already ran)
        if skip_dag:
            workflow.logger.info("[DAG] Skipping DAG (continued after context reset)")
        else:
            plan_data = extract_plan_from_context(execute_context)
            if (
                resume_state is None
                and start_phase in ("plan", "execute")
                and plan_data
                and plan_superseded_by_new_user_instruction(execute_context)
            ):
                workflow.logger.info(
                    "[DAG] Skipping stale plan superseded by a newer USER instruction after completion_summary"
                )
                plan_data = None
            if plan_data:
                workflow.logger.info("[DAG] Found plan, attempting DAG execution")
                try:
                    dag = TaskDAG(plan_data)
                except ValueError as exc:
                    raw_tasks = plan_data.get("tasks", []) if isinstance(plan_data, dict) else []
                    if any(isinstance(task, str) for task in raw_tasks):
                        workflow.logger.warning(f"[DAG] Stale persisted plan; falling back to normal execution: {exc}")
                        dag = None
                    else:
                        raise

                if dag is not None:
                    if resume_dag_from_context:
                        resumed = dag.resume_completed_tasks_from_context(execute_context)
                        workflow.logger.info(f"[DAG] Resuming from context; completed tasks={resumed}")

                    execute_system_prompt = await self.build_system_prompt()

                    # Planned spawns start in the background (like LLM spawns);
                    # a user / agent message mid-DAG hands back to run_agent.
                    with self._planned_dag_background() as dag_hooks:
                        dag_result = await execute_dag(
                            dag=dag,
                            agent_id=agent_id,
                            user_id=user_id,
                            model=model,
                            context=execute_context,
                            execute_activity=workflow.execute_activity,
                            post_message=self._post_message,
                            execute_tool=self._execute_tool,
                            handle_tool_event_fn=self._handle_tool_event,
                            poll_messages=self._poll_messages,
                            claude_token=self._active_claude_token(),
                            claude_token_source=self._active_claude_source(),
                            claude_token_pool_id=self._active_claude_pool_id(),
                            gpt_token=self._active_gpt_token(),
                            gpt_account_id=self._active_gpt_account_id(),
                            gpt_token_source=self._active_gpt_source(),
                            gpt_token_pool_id=self._active_gpt_pool_id(),
                            on_tokens=self._on_tokens,
                            system_prompt_text=execute_system_prompt,
                            tool_names=execute_tools,
                            interrupts=dag_hooks,
                        )

                    # A completed DAG hands off to normal completion. A failed or
                    # stalled DAG recovers via run_agent (the LLM loop), the same
                    # way the completed-but-unverified branch below does: run_agent
                    # reads the recorded context from the DB and iterates. It does
                    # NOT replay the DAG — execute_dag runs exactly once and is
                    # never re-entered — so completed siblings are not re-executed.
                    # The completed path must use the attempt_completion tool so
                    # the UI and transcript show the same visible completion
                    # attempt as an LLM-initiated finish.
                    if dag_result["status"] == "generation_handoff":
                        workflow.logger.info(
                            "[DAG] Cooperative generation handoff during planned task — "
                            "continue_as_new before dependents or post-DAG completion"
                        )
                        return await self._handle_incomplete(dag_result, "EXECUTE")
                    if dag_result["status"] == "completed":
                        workflow.logger.info("[DAG] Tasks completed, attempting completion")
                        await self._flush_pending_messages()
                        post_dag_result = await self._attempt_post_dag_completion(
                            agent_id=agent_id,
                            user_id=user_id,
                            model=model,
                        )
                        if (
                            post_dag_result
                            and post_dag_result.get("score", 0.0) >= 1.0
                            and not post_dag_result.get("superseded_by_user_feedback")
                        ):
                            completion_revision = self._response_schema_revision
                            await self._await_deferred_startup()
                            await self._drain_fast_mode_explores()
                            await self._prepare_response_schema_continuation()
                            if (
                                completion_revision == self._response_schema_revision
                                and self._response_schema_accepted_revision >= self._response_schema_revision
                                and not _verifier_superseded_by_user_feedback(
                                    post_dag_result,
                                    self.context,
                                    requirement_revision=self._response_schema_revision,
                                )
                            ):
                                workflow.logger.info(
                                    f"✓ Post-DAG verifier passed (score={post_dag_result['score']}) — marking complete"
                                )
                                await self._mark_complete(
                                    execute_context,
                                    post_dag_result.get("structured_response"),
                                )
                                return {"status": "completed", "goal": goal}
                        if post_dag_result and post_dag_result.get("verifier_error"):
                            message = post_dag_result.get("reasoning") or "Post-DAG verifier failed"
                            workflow.logger.warning(f"[DAG] Post-DAG attempt_completion errored: {message}")
                            return await self._handle_incomplete(
                                {
                                    "status": "error",
                                    "context": post_dag_result.get("context", []),
                                    "message": message,
                                },
                                "EXECUTE",
                            )
                        workflow.logger.info(
                            f"[DAG] Post-DAG verifier did not pass "
                            f"(score={post_dag_result.get('score', 0.0) if post_dag_result else 'n/a'}) "
                            "— falling through to run_agent for recovery"
                        )
                    else:
                        # Failed/stalled DAG: recover via the LLM loop, exactly like
                        # the completed-but-unverified path above. Do NOT return —
                        # fall through to run_agent, which reads the recorded context
                        # (completed results + the failure) from the DB and iterates.
                        # This does not replay the DAG (execute_dag is never re-entered).
                        workflow.logger.info(
                            f"[DAG] {dag_result.get('message', 'Execution incomplete')} "
                            "— falling through to run_agent for recovery"
                        )
            else:
                workflow.logger.info("[DAG] No plan found, using LLM-driven execution")

        # LLM-driven execution (after DAG, or if no plan)
        # Note: Don't pass initial_context - run_agent polls from DB each step
        # DAG already posted all results to DB via post_message callback

        # A deploy that migrated this agent mid-wait must resume the scheduled
        # wait from its original absolute target BEFORE the LLM loop runs, so the
        # agent picks up where it left off instead of the wait firing early/late.
        if self._deployment_resume:
            await self._resume_interrupted_wait(execute_context)

        # Refresh compute token before execute phase (may have expired during PLAN)
        await self._refresh_compute_token(user_id)

        execute_result = await self._run_agent_turns(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=self.build_system_prompt,
            verifier_prompt_generator=self._make_verifier_prompt_generator(),
            model=model,
            tools=execute_tools,
            initial_context=None,  # Don't pass - run_agent polls from DB
            is_inside_temporal_activity=False,
            check_paused=self._check_paused,
            check_aborted=self._check_orphaned,
            wait_for_messages=self._wait_for_messages,
            on_context_overflow=self._handle_context_overflow,
            check_credits=self._check_credits,
            check_generation_handoff=self._check_generation_handoff,
            post_message=self._post_message,
            poll_messages=self._poll_messages,
            execute_tool=self._execute_interruptible_tool,
            update_tree_state=self._update_tree_state,
            get_children_tokens=self._get_children_tokens,
            on_tokens=self._on_tokens,  # Real-time cost tracking and limit checking
            max_context_tokens=self.max_context_tokens,
            reasoning_max_tokens=reasoning_max_tokens,
            skip_blueprint_query=True,
            response_schema=response_schema,
            get_response_schema=self._make_response_schema_getter(),
            claude_token=self._active_claude_token(),
            get_claude_token=self._active_claude_token,
            get_claude_token_source=self._active_claude_source,
            get_claude_token_pool_id=self._active_claude_pool_id,
            gpt_token=self._active_gpt_token(),
            gpt_account_id=self._active_gpt_account_id(),
            get_gpt_token=self._active_gpt_token,
            get_gpt_account_id=self._active_gpt_account_id,
            get_gpt_token_source=self._active_gpt_source,
            get_gpt_token_pool_id=self._active_gpt_pool_id,
            compute_token_lineage_key=self.compute_token_lineage_key,
            compute_token_demo_cache_affinity_key=self.compute_token_demo_cache_affinity_key,
            fast_mode_cache_enabled=self.fast_mode_cache_enabled,
            goal_text=self.demo_cache_goal,
            **self._iteration_resume_kwargs(),
        )

        await self._track_tokens_and_cost(execute_result)

        if execute_result["status"] == "completed":
            # Finish native startup/child awaits before deciding whether this
            # verdict still belongs to the current user requirements.
            completion_revision = self._response_schema_revision
            await self._await_deferred_startup()
            await self._drain_fast_mode_explores()
            await self._prepare_response_schema_continuation()
            if completion_revision != self._response_schema_revision or _verifier_superseded_by_user_feedback(
                execute_result,
                self.context,
                requirement_revision=self._response_schema_revision,
            ):
                await self._flush_pending_messages()
                workflow.continue_as_new(args=self._continuation_args(self.context, start_phase="execute_continued"))
                return execute_result
            self._require_current_response_schema_acceptance()
            await self._mark_complete(execute_result.get("context", []), execute_result.get("structured_response"))
            return {"status": "completed", "goal": goal}

        return await self._handle_incomplete(execute_result, "EXECUTE")

    # =========================================================================
    # CALLBACKS FOR run_agent
    # =========================================================================

    async def _attempt_post_dag_completion(
        self,
        agent_id: str,
        user_id: str,
        model: str,
    ) -> Optional[Dict]:
        """Call attempt_completion after a successful DAG, then verify it.

        After the DAG finishes, the transcript should show a real
        attempt_completion tool call, not a hidden custom verifier call. This
        preserves the same UI/tool-result contract as an LLM-initiated
        completion attempt while still avoiding an extra LLM detour before the
        attempt.

        Returns the verifier result dict (with `score`, `reasoning`,
        `structured_response`) or an error-shaped dict if the verifier failed.
        """
        tool_call_id = f"post-dag-attempt-completion-{workflow.uuid4()}"
        try:
            await self._execute_tool(
                "attempt_completion",
                {"_verification_pending": True},
                tool_call_id,
            )

            # Refresh compute token in case it expired during DAG.
            await self._refresh_compute_token(user_id)

            context = await workflow.execute_activity(
                poll_new_messages,
                args=[agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
                retry_policy=CONTROL_PLANE_POLL_RETRY,
            )
            context = filter_internal_subagent_messages(context)

            result = await _run_verifier(
                execute_activity=workflow.execute_activity,
                context=context,
                verifier_prompt_generator=self._make_verifier_prompt_generator(),
                model=model,
                agent_id=agent_id,
                task_id=None,
                post_message=self._post_message,
                response_schema=self.output_schema,
                get_response_schema=self._make_response_schema_getter(),
                get_requirement_revision=lambda: self._response_schema_revision,
                poll_messages=self._poll_messages,
                claude_token=self._active_claude_token(),
                claude_token_source=self._active_claude_source(),
                claude_token_pool_id=self._active_claude_pool_id(),
                claude_token_user_id=user_id,
                gpt_token=self._active_gpt_token(),
                gpt_account_id=self._active_gpt_account_id(),
                gpt_token_source=self._active_gpt_source(),
                gpt_token_pool_id=self._active_gpt_pool_id(),
                gpt_token_user_id=user_id,
                compute_token_lineage_key=self.compute_token_lineage_key,
                compute_token_demo_cache_affinity_key=self.compute_token_demo_cache_affinity_key,
                is_plan_loop=False,
                tool_call_id=tool_call_id,
                fast_mode_cache_enabled=self.fast_mode_cache_enabled,
                fast_mode_goal=self.demo_cache_goal,
                fast_mode_step=0,
                interrupts=self._dag_hooks(),
            )

            # Route verifier cost through _on_tokens so this LLM call doesn't
            # drop off the cost ledger. _run_verifier uses the normal
            # verifier_execute call path for attempt_completion.
            v_usage = result.get("usage", {}) if result else {}
            v_tokens_in = v_usage.get("prompt_tokens", 0)
            v_tokens_out = v_usage.get("completion_tokens", 0)
            if v_tokens_in > 0 or v_tokens_out > 0:
                try:
                    await self._on_tokens(
                        v_tokens_in,
                        v_tokens_out,
                        v_usage.get("actual_model"),
                        cache_read_input_tokens=v_usage.get("cache_read_input_tokens", 0),
                        cache_creation_input_tokens=v_usage.get("cache_creation_input_tokens", 0),
                        call_site="verifier_execute",
                        claude_token_error=v_usage.get("claude_token_error"),
                        gpt_token_error=v_usage.get("gpt_token_error"),
                        claude_token_rotated=v_usage.get("claude_token_rotated", False),
                        gpt_token_rotated=v_usage.get("gpt_token_rotated", False),
                        compute_token_used=v_usage.get("compute_token_used"),
                        from_fast_cache=v_usage.get("from_fast_cache", False),
                        cache_sequence_id=v_usage.get("cache_sequence_id"),
                    )
                except Exception as e:
                    workflow.logger.warning(f"[DAG] _on_tokens failed for post-DAG verifier: {e}")

            _verifier_superseded_by_user_feedback(
                result, self.context, requirement_revision=self._response_schema_revision
            )
            return result
        except Exception as e:
            if any(
                error_chain_has_type(e, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            if self._response_schema_accepted_revision < self._response_schema_revision:
                workflow.logger.warning(f"Post-DAG schema prerequisite remains retryable: {extract_error_message(e)}")
                return None
            message = f"Post-DAG attempt_completion verifier failed: {extract_error_message(e)}"
            workflow.logger.warning(f"[DAG] {message}")
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Attempt completion failed",
                    message=message,
                    status=MessageStatus.ERROR,
                ),
                tool_call_id,
                "attempt_completion",
            )
            context = await workflow.execute_activity(
                poll_new_messages,
                args=[agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
                retry_policy=CONTROL_PLANE_POLL_RETRY,
            )
            return {
                "score": 0.0,
                "reasoning": message,
                "structured_response": None,
                "verifier_error": True,
                "context": filter_internal_subagent_messages(context),
            }

    def _make_verifier_prompt_generator(self):
        """Create a generator function that builds the verifier prompt at verification time.

        Completion verification must use the latest accepted schema revision.
        """

        async def generate() -> str:
            await self._wait_for_response_schema_refresh()
            self._require_current_response_schema_acceptance()
            return build_verifier_prompt(response_schema=self.output_schema)

        return generate

    async def _load_output_schema(self, *, poll_until_present: bool, max_attempts: int = 5) -> None:
        """Read the agent config while its output_schema or project is unknown.

        ``poll_until_present`` keeps polling a successful read that returns no
        schema yet (async schema generation at completion); otherwise the first
        successful read is final: no schema then means the task has none.

        A failed startup read leaves the project section unknown too, so any
        later successful read applies it, even when output_schema is already set
        (an accepted schema is never replaced by a read).
        """
        attempt = 0
        while (self.output_schema is None or self._agent_config_unavailable) and attempt < max_attempts:
            attempt += 1
            try:
                agent_config = await workflow.execute_activity(
                    fetch_agent_config,
                    args=[self.agent_id],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch output_schema (attempt {attempt}): {e}")
                if attempt < max_attempts:
                    await asyncio.sleep(1)
                continue
            self._agent_config_unavailable = False
            self._agent_config_retry_count = 0
            self._agent_config_retry_at = None
            self._apply_agent_project(agent_config)
            if self.output_schema is None:
                self.output_schema = agent_config.get("response_schema")
            workflow.logger.info(
                f"Fetched output_schema attempt {attempt}/{max_attempts}: {self.output_schema is not None}"
            )
            if self.output_schema is not None or not poll_until_present:
                return
            if attempt < max_attempts:
                workflow.logger.info("Schema not ready, waiting 1s...")
                await asyncio.sleep(1)

    def _make_response_schema_getter(self):
        """Create a getter that returns the current output_schema.

        Called at verification time after verifier_prompt_generator. Waiting
        here too keeps direct getter callers from observing a pending revision.
        """

        async def get_schema() -> Optional[Dict]:
            await self._wait_for_response_schema_refresh()
            self._require_current_response_schema_acceptance()
            if self.output_schema is None and self._agent_config_unavailable:
                await self._reload_agent_config_with_backoff()
            return self.output_schema

        return get_schema

    async def _reload_agent_config_with_backoff(self) -> None:
        """One config read per turn; failures back off exponentially across turns.

        Recovers the output schema and the project section after a failed
        startup read. The getter and the system-prompt builder run every
        main-loop turn, so retries must not stack inside a turn. Delay 1 s
        doubling to a 60 s cap plus up to 25% jitter (claude-code withRetry.ts
        getRetryDelay; codex async-utils backoff.rs) spreads a correlated
        backend outage. workflow.now()/random() keep it deterministic.
        """
        now = workflow.now()
        if self._agent_config_retry_at is not None and now < self._agent_config_retry_at:
            return
        await self._load_output_schema(poll_until_present=False, max_attempts=1)
        if not self._agent_config_unavailable:
            return
        self._agent_config_retry_count += 1
        base = min(2.0 ** (self._agent_config_retry_count - 1), 60.0)
        delay = base + workflow.random().random() * 0.25 * base
        self._agent_config_retry_at = now + timedelta(seconds=delay)

    def _require_current_response_schema_acceptance(self) -> None:
        """Do not certify a processed failure as acceptance of new requirements."""
        if self._response_schema_accepted_revision < self._response_schema_revision:
            raise RuntimeError(
                self._response_schema_refresh_failure_reason
                or "No output schema has been accepted for the current user requirements"
            )

    async def _response_schema_user_messages(self) -> List[str]:
        """Return durable, ordered user requirements for schema generation."""
        messages: List[str] = []
        goal = self._response_schema_task_base or (self.demo_cache_goal or self.goal or "").strip()
        if goal:
            messages.append(goal)
        if isinstance(self.output_schema, dict) and self.output_schema.get("fields"):
            messages.append(
                "Current output schema (preserve fields unless later user feedback changes them):\n"
                + _json.dumps(self.output_schema, sort_keys=True, separators=(",", ":"))
            )

        # A continue-as-new resets in-memory context and revision counters.
        # Reload durable USER rows so a later revision still includes feedback
        # accepted by an earlier workflow run.
        try:
            persisted_messages = await workflow.execute_activity(
                poll_new_messages,
                args=[self.agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
                retry_policy=CONTROL_PLANE_POLL_RETRY,
            )
        except Exception as e:
            if any(
                error_chain_has_type(e, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            workflow.logger.warning(f"Failed to reload durable feedback for response_schema refresh: {e}")
            persisted_messages = []

        seen_rows: Set[Tuple[str, ...]] = set()
        covered_feedback: Dict[str, int] = {}
        requirements = list(persisted_messages or []) + list(self.context)
        requirements.sort(key=lambda message: str(message.get("timestamp") or ""))
        first_user_row = True
        for message in requirements:
            if (message.get("role") or "").upper() != "USER":
                continue
            if (message.get("metadata") or {}).get("hidden") or (message.get("metadata") or {}).get(
                "excludeFromModel"
            ):
                # Hidden from this agent's model (e.g. a message addressed to one browser task).
                continue
            # A task update from an ancestor agent changes requirements like a user correction.
            if is_agent_authored_user_metadata(message.get("metadata")) and not _is_requirement_agent_row(message):
                continue
            text = message.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            message_id = message.get("message_id") or message.get("id")
            event_id = self._response_schema_attention_event_id(message)
            key = (
                ("attention_response", event_id)
                if event_id is not None
                else (("id", str(message_id)) if message_id else ("legacy", str(message.get("timestamp") or ""), text))
            )
            if key in self._response_schema_task_baseline_rows:
                continue
            if key in seen_rows:
                continue
            seen_rows.add(key)
            # The initial goal is already the first requirement. A later real
            # USER row can repeat it intentionally to restore the original task.
            is_initial_goal = (
                self._response_schema_task_base is None
                and event_id is None
                and text.strip() == goal
                and (first_user_row or (key[0] == "legacy" and not key[1]))
            )
            first_user_row = False
            if is_initial_goal:
                continue
            messages.append(text)
            covered_feedback[text] = covered_feedback.get(text, 0) + 1

        # Plain signals may precede their durable poll. Match occurrences rather
        # than unique text so A -> B -> A keeps the user's final correction.
        for index, feedback in enumerate(self._response_schema_feedback):
            source = (
                self._response_schema_feedback_sources[index]
                if index < len(self._response_schema_feedback_sources)
                else None
            )
            if source is not None and source in self._response_schema_task_baseline_rows:
                continue
            text = feedback
            if not text.strip():
                continue
            if covered_feedback.get(text, 0):
                covered_feedback[text] -= 1
            else:
                messages.append(text)

        return messages

    def _start_response_schema_refresh(self) -> None:
        """Start one coalescing background schema worker without blocking reasoning."""
        if not self._response_schema_initialized:
            return
        if self._response_schema_applied_revision >= self._response_schema_revision:
            return
        if (
            self._response_schema_refresh_error is not None
            and self._response_schema_refresh_failed_revision >= self._response_schema_revision
        ):
            return
        if self._response_schema_refresh_task is not None:
            return
        self._response_schema_refresh_task = asyncio.create_task(self._run_response_schema_refreshes())

    def _record_response_schema_refresh_failure(self, revision: int, error: Exception) -> None:
        """Leave failed input pending for the existing LLM retry owner."""
        reason = extract_error_message(error)
        self._response_schema_refresh_failed_revision = revision
        self._response_schema_refresh_error = reason
        self._response_schema_refresh_failure_reason = reason
        self._response_schema_refresh_exception = error
        workflow.logger.warning(f"Response schema refresh failed at revision {revision}: {reason}")

    async def _run_response_schema_refreshes(self) -> None:
        """Apply the newest feedback revision through the normal activity retry policy."""
        restart_pending = True
        try:
            while self._response_schema_applied_revision < self._response_schema_revision:
                target_revision = self._response_schema_revision
                if self._response_schema_accepted_revision >= target_revision:
                    # A lost persistence acknowledgement retries the accepted
                    # write, without making another model call.
                    schema = self.output_schema
                else:
                    user_messages = await self._response_schema_user_messages()
                    try:
                        generated = await workflow.start_activity(
                            set_response_schema_activity,
                            args=[
                                self.agent_id,
                                user_messages,
                                self._active_compute_token_payload(),
                                self.fast_mode_cache_enabled,
                                False,
                                False,
                            ],
                            start_to_close_timeout=timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS),
                            retry_policy=RetryPolicy(maximum_attempts=3),
                        )
                    except Exception as error:
                        if any(
                            error_chain_has_type(error, kind)
                            for kind in (
                                "CancelledError",
                                "WorkflowGenerationSealed",
                                "GenerationHandoffRequested",
                            )
                        ):
                            raise
                        if target_revision < self._response_schema_revision:
                            self._response_schema_applied_revision = target_revision
                            continue
                        self._record_response_schema_refresh_failure(target_revision, error)
                        return
                    if target_revision < self._response_schema_revision:
                        self._response_schema_applied_revision = target_revision
                        continue
                    schema = generated.get("schema") if isinstance(generated, dict) else None
                    if not (isinstance(schema, dict) and schema.get("fields")):
                        self._record_response_schema_refresh_failure(
                            target_revision,
                            ValueError("schema generation returned no fields"),
                        )
                        return
                    if schema != self.output_schema:
                        self.output_schema = schema
                    self._response_schema_accepted_revision = target_revision
                    self._response_schema_refresh_failure_reason = None

                try:
                    await workflow.execute_activity(
                        persist_response_schema_activity,
                        args=[self.agent_id, schema],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                except Exception as error:
                    if any(
                        error_chain_has_type(error, kind)
                        for kind in (
                            "CancelledError",
                            "WorkflowGenerationSealed",
                            "GenerationHandoffRequested",
                        )
                    ):
                        raise
                    self._record_response_schema_refresh_failure(target_revision, error)
                    return
                self._response_schema_applied_revision = target_revision
                self._response_schema_refresh_failed_revision = 0
                self._response_schema_refresh_error = None
                self._response_schema_refresh_exception = None
        except BaseException:
            restart_pending = False
            raise
        finally:
            if restart_pending:
                self._response_schema_refresh_task = None
                self._start_response_schema_refresh()

    async def _wait_for_response_schema_refresh(self) -> None:
        """Expose failed calls to the normal LLM retry owner without acknowledging input."""
        while self._response_schema_applied_revision < self._response_schema_revision:
            if (
                self._response_schema_refresh_error is not None
                and self._response_schema_refresh_failed_revision >= self._response_schema_revision
            ):
                error = getattr(self, "_response_schema_refresh_exception", None) or RuntimeError(
                    self._response_schema_refresh_error
                )
                self._response_schema_refresh_error = None
                self._response_schema_refresh_exception = None
                if self._response_schema_accepted_revision >= self._response_schema_revision:
                    # Native acceptance survives a failed DB write; the next
                    # boundary retries persistence, carrying the accepted schema.
                    return
                raise error
            self._start_response_schema_refresh()
            task = self._response_schema_refresh_task
            if task is None:
                raise RuntimeError("Response schema refresh did not start")
            try:
                await task
            finally:
                if task.done() and self._response_schema_refresh_task is task:
                    self._response_schema_refresh_task = None

    async def _prepare_response_schema_continuation(self) -> None:
        """Settle an in-flight call, preserving failed input for the resumed loop."""
        try:
            await self._wait_for_response_schema_refresh()
        except Exception as error:
            if any(
                error_chain_has_type(error, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            workflow.logger.warning(
                f"Schema refresh remains pending across continuation: {extract_error_message(error)}"
            )

    async def _regenerate_output_schema_for_new_instruction(self, context: List[Dict[str, Any]]) -> None:
        """Replace a completed-run schema with one generated from the latest USER.

        Chat re-escalation nulls Agent.responseSchema before Temporal start.
        Mid-run refresh still preserves fields. A superseded fresh start is a
        new task, so generate from the latest real USER text only.
        """
        latest = latest_real_user_instruction(context)
        if not latest:
            return
        pending_feedback = self._response_schema_applied_revision < self._response_schema_revision
        self._response_schema_revision += 1
        target_revision = self._response_schema_revision
        if pending_feedback:
            # The coalescing worker owns input already queued before this snapshot.
            return
        try:
            generated = await workflow.execute_activity(
                set_response_schema_activity,
                args=[
                    self.agent_id,
                    [latest],
                    self._active_compute_token_payload(),
                    self.fast_mode_cache_enabled,
                    False,
                    False,
                ],
                start_to_close_timeout=timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as e:
            if any(
                error_chain_has_type(e, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            self._record_response_schema_refresh_failure(target_revision, e)
            return
        if target_revision < self._response_schema_revision:
            self._response_schema_applied_revision = target_revision
            return
        schema = generated.get("schema") if isinstance(generated, dict) else None
        if not (isinstance(schema, dict) and schema.get("fields")):
            self._record_response_schema_refresh_failure(
                target_revision, ValueError("schema generation returned no fields")
            )
            return
        if schema != self.output_schema:
            self.output_schema = schema
        self._response_schema_accepted_revision = target_revision
        self._response_schema_refresh_failure_reason = None
        workflow.logger.info(
            f"Regenerated output_schema from latest USER instruction with {len(schema['fields'])} field(s)"
        )
        # As with mid-run feedback, accept in native state before persistence.
        # A failed write acknowledgement must not restore a completed task's schema.
        try:
            await workflow.execute_activity(
                persist_response_schema_activity,
                args=[self.agent_id, schema],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as e:
            if any(
                error_chain_has_type(e, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            self._record_response_schema_refresh_failure(target_revision, e)
            return
        self._response_schema_applied_revision = target_revision
        self._response_schema_refresh_failed_revision = 0
        self._response_schema_refresh_error = None

    def _apply_agent_project(self, agent_config: Dict[str, Any]) -> None:
        """Derive the project section from a fetched agent config.

        An empty config (failed fetch) keeps the section restored from the
        previous run, so continue_as_new never loses or duplicates it.
        """
        if agent_config:
            self.project_context_section = render_project_context(agent_config.get("project"))

    async def build_system_prompt(self) -> str:
        """Build system prompt for the current phase.

        Called by run_agent before each LLM call.
        """
        await self._advance_cloud_agent_lifecycle(STARTING_REASONING_TITLE, "IN_PROGRESS")
        if self._agent_config_unavailable:
            # The startup config read failed: recover the project section (and
            # a missing schema) instead of running without them for the rest of
            # the run. Bounded to one read per turn with backoff.
            await self._reload_agent_config_with_backoff()
        return build_system_prompt(
            phase=self.current_phase,
            enabled_tools=self._current_tools,
            disabled_tools=self._disabled_tools,
            user_context_section=user_context_with_project(self.user_context_section, self.project_context_section),
            response_schema=self.output_schema,
            tool_prompts=TOOL_PROMPTS,
        )

    async def _wait_for_messages(self) -> bool:
        """Wait for new messages."""
        try:
            # cutover-class: bounded — 30s slice; next run_agent iteration re-checks handoff
            await workflow.wait_condition(
                lambda: self._has_new_messages or not self.is_paused, timeout=timedelta(seconds=30)
            )
            result = self._has_new_messages
            self._has_new_messages = False
            return result
        except (asyncio.TimeoutError, TemporalTimeoutError):
            return False

    async def _handle_context_overflow(self, compressed_context: List[Dict]) -> None:
        """Handle context overflow via continue_as_new."""
        workflow.logger.info("Context overflow → continue_as_new")

        # The native continuation snapshot carries accepted and pending input;
        # failed generation is retried by the resumed LLM loop.
        await self._prepare_response_schema_continuation()

        # Post a visible tool message so the user sees the context reset
        with contextlib.suppress(Exception):
            await workflow.execute_activity(
                post_agent_message,
                args=[
                    self.agent_id,
                    "Context compressed — continuing with summarized history.",
                    "TOOL",
                    {
                        "toolCallId": str(workflow.uuid4()),
                        "toolName": "context_reset",
                        "toolStatus": "FINISHED",
                        "title": "Context Reset",
                        "contextCompaction": build_context_compaction_metadata(compressed_context),
                    },
                ],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        in_flight = self._in_flight_background_ids()
        if in_flight and not self._continuation_history_pressure():
            # continue_as_new would abandon these activities and relaunch them from
            # scratch. Keep this run on the compressed context instead (run_agent
            # uses it in-run when this hook returns); the next overflow, once they
            # have finished, continues as new.
            workflow.logger.info(
                f"[background] context overflow: deferring continue_as_new while {len(in_flight)} "
                f"background task(s) run: {in_flight}"
            )
            # Same starting state a continued run would have: later
            # continue_as_new(self.context) paths must not carry the old history.
            self.context = list(compressed_context)
            return
        if in_flight:
            await self._settle_background_tasks_for_continuation(
                "context overflow (history limit)", CONTINUATION_BACKGROUND_SETTLE_SECONDS
            )

        # The canonical continuation contract also carries mutable counters,
        # credentials, and signal state so compaction cannot reset billing/limits.
        await self._drain_fast_mode_explores()
        await self._flush_pending_messages()
        workflow.continue_as_new(args=self._continuation_args(compressed_context))

    def _in_flight_background_ids(self) -> List[str]:
        """Activity-backed background tasks whose executor is still running in this run.

        general_purpose/for_each children are durable workflows that report through
        ``child_completed`` across continue_as_new, so they never hold a continuation.
        """
        return [
            bg_id
            for bg_id, handle in getattr(self, "_background_handles", {}).items()
            if not handle.done()
            and (self._background_tasks.get(bg_id) or {}).get("agent_type") not in CHILD_WORKFLOW_AGENT_TYPES
        ]

    async def _settle_background_tasks_for_continuation(self, reason: str, bound_seconds: float) -> List[str]:
        """Before continue_as_new: let in-flight background tasks park or finish (bounded).

        Generation handoff: browser/code activities see GENERATION_SUPERSEDED at
        their next step boundary and park with resume state; explore cannot park
        mid-run and finishes. Returns the ids still running at the bound — those
        keep the old behaviour (relaunched from scratch by the next run), logged.
        """
        pending = self._in_flight_background_ids()
        if not pending:
            return []
        workflow.logger.info(
            f"[background] {reason}: waiting up to {bound_seconds:.0f}s for {len(pending)} in-flight "
            f"background task(s) to park or finish before continue_as_new: {pending}"
        )
        with contextlib.suppress(asyncio.TimeoutError, TemporalTimeoutError):
            # cutover-class: bounded — explicit settle bound, then continue_as_new regardless
            await workflow.wait_condition(
                lambda: not self._in_flight_background_ids(), timeout=timedelta(seconds=bound_seconds)
            )
        left = self._in_flight_background_ids()
        if left:
            workflow.logger.warning(
                f"[background] {reason}: {len(left)} background task(s) did not park within "
                f"{bound_seconds:.0f}s and will restart in the next run: {left}"
            )
        return left

    def _continuation_history_pressure(self) -> bool:
        """True when this run's history is too large to keep deferring continue_as_new."""
        info = workflow.info()
        return (
            info.get_current_history_length() >= OVERFLOW_DEFER_MAX_HISTORY_EVENTS
            or info.get_current_history_size() >= OVERFLOW_DEFER_MAX_HISTORY_BYTES
        )

    async def _check_paused(self) -> bool:
        """Check if paused, querying parent state first (non-root only)."""
        await self._check_parent_state()
        # Yield to event loop so Temporal processes any pending signals before we read is_paused
        await asyncio.sleep(0)
        return self.is_paused

    async def _check_paused_before_turn(self) -> bool:
        """Consume browser wrap-up once per turn, never once per stream check."""
        if await self._check_paused():
            return True
        if self._cost_limit_wrapup_pending and self._cost_limit_reached and not self._is_finished:
            if not self._cost_limit_wrapup_consumed:
                # Admission belongs to the turn boundary, not stream polling.
                self._cost_limit_wrapup_consumed = True
                return False
            # Wrap-up turn used without completing — re-assert the cost pause.
            self._cost_limit_wrapup_pending = False
            self._cost_limit_reached = False
            await self._check_cost_limit()
        return self.is_paused

    def _refund_unaccepted_browser_wrapup_turn(self) -> None:
        """Keep the loop's bounded pre-response retry on the same allowance.

        Accepted responses never call this hook; every provider attempt still
        uses the normal accounting owner, and genuine pauses remain untouched.
        """
        if self._cost_limit_wrapup_pending and not self._is_finished:
            self._cost_limit_wrapup_consumed = False

    async def _check_orphaned(self) -> bool:
        """Terminal abort signal for run_agent. True once this child has been
        orphaned (parent workflow gone) — set by _check_parent_state during the
        preceding _check_paused. The loop then returns status='aborted' instead of
        waiting forever on a parent that will never resume it."""
        return self._orphaned

    async def _check_generation_handoff(self) -> Optional[str]:
        """Return live task queue when this execution should hand off generations.

        Safe checkpoint: called at the top of a run_agent iteration and from
        in-tool parks after any prior activity completed. Returns None when we
        are already on the live generation (or the pointer cannot be read).
        """
        try:
            pointer = await workflow.execute_activity(
                fetch_agent_queue_pointer,
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as e:
            workflow.logger.warning(f"Generation pointer check failed (continuing): {e}")
            return None
        live_queue = (pointer or {}).get("task_queue")
        current_queue = workflow.info().task_queue
        if should_handoff_to_generation(current_queue, live_queue):
            workflow.logger.info(f"Generation handoff required: current={current_queue} live={live_queue}")
            return live_queue
        if live_queue:
            # Confirmed on the live generation: drop a stale hint (e.g. a rollback)
            # so parks return to safety-slice re-checks instead of 30s polling.
            self._generation_handoff_hint = None
        return None

    def _park_pending_tool(self, tool_call_id: str, resume: Dict[str, Any]) -> bool:
        """Carry one in-flight tool call across the coming generation handoff.

        Called by a tool at the moment it observes the handoff (see
        ``helpers.generation_handoff.park_pending_tool``). Returns False when
        the tool must instead close its chip with DEPLOY_INTERRUPTED.
        """
        if tool_call_id in self._background_tasks:
            # Background records already travel in the continuation snapshot;
            # keep the hint so the next generation relaunches it in the background.
            self._background_tasks[tool_call_id]["resume"] = dict(resume)
            workflow.logger.info(f"Parked background task {tool_call_id} for generation handoff")
            return True
        if not self._tool_parking_enabled:
            return False
        active = self._active_tool_calls.get(tool_call_id)
        if active is None:
            return False
        tool_name, tool_args = active
        records = [record for record in self._pending_tool_resumes if record.get("tool_call_id") != tool_call_id]
        records.append(pending_tool_record(tool_name, tool_args, tool_call_id, resume))
        if not pending_tool_resumes_fit(records):
            workflow.logger.warning(f"Parked tool records exceed the handoff budget; interrupting {tool_name}")
            return False
        self._pending_tool_resumes = records
        workflow.logger.info(f"Parked {tool_name} ({tool_call_id}) for generation handoff")
        return True

    def _take_tool_resume(self, tool_call_id: str) -> Optional[Dict[str, Any]]:
        """Return (once) the resume payload a previous generation parked for this call."""
        if tool_call_id in self._background_resume_hints:
            return self._background_resume_hints.pop(tool_call_id)
        return self._tool_resume_hints.pop(tool_call_id, None)

    async def _resume_pending_tools(self) -> Optional[str]:
        """Re-enter tool calls the previous generation parked, before the next LLM turn.

        Each call re-runs through ``_execute_tool`` with its original arguments
        and tool_call_id, so it posts its own result row exactly as if it had
        never been interrupted. Returns the live queue when a resumed tool had
        to hand off again.

        Re-entry repeats the APPROVAL_REQUIRED_TOOLS gate, so a tool in that
        map must never park; it would ask the user to approve the same call twice.
        """
        records, self._pending_tool_resumes = self._pending_tool_resumes, []
        if not records:
            return None
        workflow.logger.info(f"Resuming {len(records)} tool call(s) parked by the previous generation")
        self._tool_resume_hints = {record["tool_call_id"]: record["resume"] for record in records}
        try:
            results = await asyncio.gather(
                *(
                    self._execute_tool(record["tool_name"], dict(record["tool_args"]), record["tool_call_id"])
                    for record in records
                )
            )
        finally:
            self._tool_resume_hints = {}
        for result in results:
            if isinstance(result, dict) and result.get("generation_handoff"):
                handoff_queue = result.get("handoff_task_queue")
                if isinstance(handoff_queue, str) and handoff_queue.strip():
                    return handoff_queue.strip()
        return None

    async def _run_agent_turns(self, **run_agent_kwargs: Any) -> Dict:
        """Run the LLM loop for one phase with tool parking enabled.

        Parked tool calls from the previous generation finish first so their
        results are in the conversation before the next LLM call.
        """
        self._tool_parking_enabled = True
        try:
            handoff_queue = await self._resume_pending_tools()
            if handoff_queue:
                return {
                    "status": "generation_handoff",
                    "handoff_task_queue": handoff_queue,
                    "context": list(self.context),
                }
            run_agent_kwargs["get_requirement_revision"] = lambda: self._response_schema_revision
            run_agent_kwargs["check_paused_before_turn"] = self._check_paused_before_turn
            run_agent_kwargs["on_unaccepted_turn_retry"] = self._refund_unaccepted_browser_wrapup_turn
            run_agent_kwargs.setdefault("user_tools", declared_user_tools(self))
            # Read the latest known schema without waiting for async schema regeneration.
            run_agent_kwargs["get_jev_response_schema"] = lambda: self.output_schema
            run_agent_kwargs["jev_goal"] = self.goal
            run_agent_kwargs["jev_agent_kind"] = "normal_child" if self.parent_agent_id else "normal_root"
            run_agent_kwargs["get_pending_background_status"] = self._pending_background_status_text
            run_agent_kwargs["verifier_interrupts"] = self._dag_hooks()
            run_agent_kwargs["sync_environment_context"] = self._sync_environment_context
            run_agent_kwargs["get_environment_tail"] = self._environment_tail_seed
            self._relaunch_background_tasks()
            self._background_spawns_enabled = True
            return await run_agent(**run_agent_kwargs)
        finally:
            self._tool_parking_enabled = False
            self._background_spawns_enabled = False

    async def _wait_for_unpause_or_handoff(self) -> Optional[str]:
        """Block until unpaused, re-checking generation handoff every 30s.

        Returns the live task queue when cooperative cutover is required while
        paused; otherwise None once the agent is unpaused.
        """
        if not self.is_paused:
            return None
        try:
            await wait_condition_or_generation_handoff(
                lambda: not self.is_paused,
                self,
                workflow_mod=workflow,
            )
        except GenerationHandoffRequested as exc:
            return exc.task_queue
        return None

    async def _check_credits(self) -> None:
        """Check user credits. Sets is_paused=True if depleted."""
        try:
            result = await workflow.execute_activity(
                check_user_usage,
                args=[self.user_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Credit check failed (continuing): {e}")
            return

        if result and not result.get("has_credits", True):
            workflow.logger.warning("💰 Credits depleted - pausing agent")
            self._has_credits = False
            if result.get("tier") is None:
                # A subscription gate must remain awake to receive the Stripe
                # webhook resolution. raise_gate_direct treats is_paused as an
                # explicit interruption, so setting it before the wait exits
                # the gate immediately and leaves the agent unable to resume.
                checkout_url = None
                try:
                    checkout_url = await workflow.execute_activity(
                        mint_subscription_checkout_activity,
                        args=[self.user_id],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                except Exception as e:
                    workflow.logger.warning(
                        f"Subscription checkout URL unavailable; raising subscription gate with default action: {e}"
                    )

                try:
                    await raise_gate_direct(
                        self,
                        build_subscription_gate(
                            checkout_url=checkout_url,
                            reason="Your free credits are exhausted — subscribe to continue this task.",
                            title="Subscribe to continue this task",
                        ),
                        gate_key="subscription",
                    )
                    restored = await workflow.execute_activity(
                        check_user_usage,
                        args=[self.user_id],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    if restored is None:
                        restored = await workflow.execute_activity(
                            check_user_usage,
                            args=[self.user_id],
                            start_to_close_timeout=timedelta(seconds=15),
                            retry_policy=RetryPolicy(maximum_attempts=2),
                        )
                    self._has_credits = bool(restored and restored.get("has_credits"))
                    self.is_paused = self.is_paused or not self._has_credits
                except GateRejectedError:
                    self.is_paused = True
                except Exception as e:
                    workflow.logger.warning(f"Credit gate setup failed after depletion (pausing): {e}")
                    self.is_paused = True
            else:
                self.is_paused = True
            return

        self._has_credits = True

    # Direct compute token TTL: 5 minutes
    COMPUTE_TOKEN_TTL = timedelta(minutes=5)

    def _clear_compute_token(self) -> None:
        self.compute_token_provider = None
        self.claude_max_token = None
        self.claude_max_token_source = None
        self.claude_max_token_pool_id = None
        self.gpt_code_token = None
        self.gpt_code_account_id = None
        self.gpt_code_token_source = None
        self.gpt_code_token_pool_id = None
        self.compute_token_integration_id = None
        self.compute_token_fetched_at = None
        self.claude_max_token_fetched_at = None

    def _remember_compute_token(self, token: Optional[Dict[str, Any]]) -> bool:
        if not token or token.get("type") not in ("claude", "gpt") or not token.get("accessToken"):
            return False
        now = workflow.now()
        self._clear_compute_token()
        self.compute_token_provider = token.get("type")
        self.compute_token_integration_id = token.get("integrationId")
        if token.get("lineageKey"):
            self.compute_token_lineage_key = token.get("lineageKey")
        if self.compute_token_provider == "claude":
            self.claude_max_token = token.get("accessToken")
            self.claude_max_token_source = token.get("source")
            self.claude_max_token_pool_id = token.get("poolTokenId")
            self.claude_max_token_fetched_at = now
        else:
            self.gpt_code_token = token.get("accessToken")
            self.gpt_code_account_id = token.get("accountId")
            self.gpt_code_token_source = token.get("source")
            self.gpt_code_token_pool_id = token.get("poolTokenId")
        self.compute_token_fetched_at = now
        return True

    async def _refresh_compute_token(
        self, user_id: str, *, force: bool = False, token_type: Optional[str] = None
    ) -> None:
        """Fetch or refresh the selected direct compute token if missing or expired."""
        now = workflow.now()
        fetched_at = self.compute_token_fetched_at or self.claude_max_token_fetched_at
        if not force and fetched_at:
            age = now - fetched_at
            if age < self.COMPUTE_TOKEN_TTL:
                return  # Still fresh
            workflow.logger.info(f"🔑 Compute token expired ({age.total_seconds():.0f}s old), refreshing")

        try:
            result = await workflow.execute_activity(
                fetch_compute_token_activity,
                args=[
                    user_id,
                    self.compute_token_lineage_key,
                    self.agent_id,
                    self.agent_id,
                    self.compute_token_demo_cache_affinity_key,
                    token_type,
                ],
                start_to_close_timeout=timedelta(seconds=20),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            if result and result.get("accessToken") and result.get("type") in ("claude", "gpt"):
                self._remember_compute_token(result)
                workflow.logger.info(
                    f"🔑 Compute token selected (type={self.compute_token_provider}, source={result.get('source')})"
                )
                return
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch compute token: {e}")

        self._clear_compute_token()

    async def _rotate_compute_token(self, user_id: str) -> None:
        """Release lineage, clear the cached token, and fetch the next available compute token."""
        failed_provider = self.compute_token_provider
        rotate_token_type: Optional[str] = None
        if failed_provider == "claude":
            rotate_token_type = "gpt"
        elif failed_provider == "gpt":
            rotate_token_type = "claude"
        if self.compute_token_lineage_key:
            try:
                await workflow.execute_activity(
                    release_compute_token_lineage_activity,
                    args=[self.compute_token_lineage_key],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as release_error:
                workflow.logger.warning(f"Failed to release compute token lineage during rotation: {release_error}")
        self._clear_compute_token()
        await self._refresh_compute_token(user_id, force=True, token_type=rotate_token_type)

    def _active_claude_token(self) -> Optional[str]:
        return self.claude_max_token if self.compute_token_provider == "claude" else None

    def _active_gpt_token(self) -> Optional[str]:
        return self.gpt_code_token if self.compute_token_provider == "gpt" else None

    def _active_gpt_account_id(self) -> Optional[str]:
        return self.gpt_code_account_id if self.compute_token_provider == "gpt" else None

    def _active_claude_source(self) -> Optional[str]:
        return self.claude_max_token_source if self.compute_token_provider == "claude" else None

    def _active_claude_pool_id(self) -> Optional[str]:
        return self.claude_max_token_pool_id if self.compute_token_provider == "claude" else None

    def _active_gpt_source(self) -> Optional[str]:
        return self.gpt_code_token_source if self.compute_token_provider == "gpt" else None

    def _active_gpt_pool_id(self) -> Optional[str]:
        return self.gpt_code_token_pool_id if self.compute_token_provider == "gpt" else None

    def _active_compute_token_payload(self) -> Optional[Dict[str, Any]]:
        if self.compute_token_provider == "claude" and self.claude_max_token:
            return {
                "type": "claude",
                "accessToken": self.claude_max_token,
                "userId": self.user_id,
                "source": self.claude_max_token_source,
                "poolTokenId": self.claude_max_token_pool_id,
                "integrationId": self.compute_token_integration_id,
                "lineageKey": self.compute_token_lineage_key,
                "agentId": self.agent_id,
                "rootAgentId": self.agent_id,
                "fastCacheAffinityKey": self.compute_token_demo_cache_affinity_key,
            }
        if self.compute_token_provider == "gpt" and self.gpt_code_token:
            return {
                "type": "gpt",
                "accessToken": self.gpt_code_token,
                "userId": self.user_id,
                "accountId": self.gpt_code_account_id,
                "source": self.gpt_code_token_source,
                "poolTokenId": self.gpt_code_token_pool_id,
                "integrationId": self.compute_token_integration_id,
                "lineageKey": self.compute_token_lineage_key,
                "agentId": self.agent_id,
                "rootAgentId": self.agent_id,
                "fastCacheAffinityKey": self.compute_token_demo_cache_affinity_key,
            }
        return None

    async def _refresh_claude_token(self, user_id: str) -> None:
        """Compatibility wrapper for older tests/callers."""
        await self._refresh_compute_token(user_id)

    async def _flush_pending_messages(self) -> None:
        """Await Fast Mode message writes started off the critical path."""
        handles = self._pending_message_handles
        self._pending_message_handles = []
        for handle in handles:
            try:
                await handle
            except Exception as e:
                workflow.logger.error(f"Failed to post message: {e}")

    async def _drain_fast_mode_explores(self) -> None:
        """No-op unless leftover explore handles were tracked."""
        if not getattr(self, "fast_mode_cache_enabled", False):
            return
        await drain_fast_mode_explores(self)

    async def _post_message(
        self,
        text: str,
        role: str = "ASSISTANT",
        metadata: Optional[Dict] = None,
        *,
        update_tree: bool = True,
    ) -> None:
        """Post message to database."""
        if role == "TOOL" and isinstance(metadata, dict):
            # e.g. a background general_purpose / for_each child's progress and
            # completion rows under its spawn's id: FE-only, like the executor's.
            metadata = self._background_row_metadata(metadata.get("toolCallId"), metadata)
        try:
            # Fast Mode replay is CPU/DB local. Awaiting every post_message
            # activity under 50-way fan-out was the 900s leftover-ACTIVE
            # bottleneck: each July GP step blocked on a 30s write. Start the
            # write and keep looping; flush before terminal status so the
            # transcript is durable when COMPLETED lands.
            if self.fast_mode_cache_enabled and not self._is_finished and is_oai_demo_mass_agent_task(self):
                handle = workflow.start_activity(
                    post_agent_message,
                    args=[self.agent_id, text, role, metadata],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                self._pending_message_handles.append(handle)
                self.message_count += 1
                if len(self._pending_message_handles) >= 20:
                    await self._flush_pending_messages()
                if update_tree:
                    await self._update_tree_state()
                return
            await workflow.execute_activity(
                post_agent_message,
                args=[self.agent_id, text, role, metadata],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            # Track message count and broadcast tree state
            self.message_count += 1
            if update_tree:
                await self._update_tree_state()
        except Exception as e:
            workflow.logger.error(f"Failed to post message: {e}")

    async def _find_cloud_agent_lifecycle_tool_call_id(self) -> Optional[str]:
        """Find the chat-mode cloud-agent tool call that this workflow should update."""
        if self._cloud_agent_lifecycle_tool_call_id:
            return self._cloud_agent_lifecycle_tool_call_id

        messages = await workflow.execute_activity(
            poll_new_messages,
            args=[self.agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
            start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
            retry_policy=CONTROL_PLANE_POLL_RETRY,
        )

        terminal_tool_call_ids = set()
        pending_tool_call_id = None

        for msg in messages or []:
            if (msg.get("role") or "").upper() != "TOOL":
                continue
            metadata = msg.get("metadata") or {}
            if metadata.get("toolName") != CLOUD_AGENT_TOOL_NAME:
                continue

            tool_call_id = metadata.get("toolCallId")
            if metadata.get("toolStatus") in {"FINISHED", "ERROR"} and tool_call_id:
                terminal_tool_call_ids.add(tool_call_id)
            elif (
                metadata.get("toolStatus") == "IN_PROGRESS"
                and metadata.get("title") in CLOUD_AGENT_IN_PROGRESS_TITLES
                and tool_call_id
            ):
                pending_tool_call_id = tool_call_id
                # The chat handler stamps startPhase only on the initial
                # "Creating Cloud Agent" row. The front-end dedups tool
                # messages by toolCallId keeping the LATEST, so every
                # lifecycle update we post must carry startPhase forward or
                # the phase is erased from the rendered chip.
                if metadata.get("startPhase") in {"plan", "execute"}:
                    self._cloud_agent_lifecycle_start_phase = metadata.get("startPhase")

        if pending_tool_call_id and pending_tool_call_id not in terminal_tool_call_ids:
            self._cloud_agent_lifecycle_tool_call_id = pending_tool_call_id
            return pending_tool_call_id

        if pending_tool_call_id in terminal_tool_call_ids:
            self._cloud_agent_lifecycle_finished = True
            return None

        # Direct API / SMS root spawns never get a chat-mode cloud_agent chip.
        # Synthesize a stable toolCallId so Preparing/Starting Reasoning/Ready
        # still emit (spawn-latency ratchet + FE parity). Sub-agents skip this
        # to avoid an extra message-poll on every token callback.
        if not self.parent_workflow_id:
            self._cloud_agent_lifecycle_tool_call_id = f"tc-cloud-agent-{self.agent_id}"
            # current_phase is set in run(); bare unit instances may not have it yet.
            self._cloud_agent_lifecycle_start_phase = self._cloud_agent_lifecycle_start_phase or (
                "execute" if getattr(self, "current_phase", None) == "EXECUTE" else "plan"
            )
            return self._cloud_agent_lifecycle_tool_call_id

        # Cache absence for sub-agents so later token callbacks do not keep
        # scheduling message-poll activities before user-visible tool execution.
        self._cloud_agent_lifecycle_finished = True
        return None

    async def _await_deferred_startup(self) -> None:
        """Await SMS activity kicked off during startup (off critical path).

        SMS notify is ~2–4s on prod traces. Started during init and awaited after
        the first reasoning turn begins (or at end-of-run for short/smoke paths
        that never emit tokens). Idempotent — safe to call multiple times.
        """
        sms_handle = getattr(self, "_deferred_startup_sms_handle", None)
        self._deferred_startup_sms_handle = None

        if sms_handle is not None:
            try:
                await sms_handle
                workflow.logger.info("Completed deferred agent_started SMS notification")
            except Exception as e:
                workflow.logger.warning(f"Deferred agent_started SMS notification failed: {e}")

    async def _advance_cloud_agent_lifecycle(self, title: str, tool_status: str) -> None:
        """Advance the chat-mode cloud-agent chip without exposing it to LLM context."""
        if self._cloud_agent_lifecycle_finished:
            return

        update_key = f"{tool_status}:{title}"
        if update_key in self._cloud_agent_lifecycle_updates_sent:
            return

        try:
            tool_call_id = await self._find_cloud_agent_lifecycle_tool_call_id()
            if not tool_call_id:
                return

            lifecycle_metadata = {
                "toolCallId": tool_call_id,
                "toolName": CLOUD_AGENT_TOOL_NAME,
                "toolStatus": tool_status,
                "title": title,
            }
            if self._cloud_agent_lifecycle_start_phase:
                lifecycle_metadata["startPhase"] = self._cloud_agent_lifecycle_start_phase
            await self._post_message(
                "",
                "TOOL",
                lifecycle_metadata,
            )
            self._cloud_agent_lifecycle_updates_sent.add(update_key)
            if tool_status in {"FINISHED", "ERROR"}:
                self._cloud_agent_lifecycle_finished = True
        except Exception as e:
            workflow.logger.warning(f"Failed to advance cloud agent lifecycle tool: {e}")

    async def _resume_interrupted_wait(self, conversation: List[Dict]) -> None:
        """Re-arm a deploy-interrupted timestamp ``wait_for`` from its original target.

        When a deploy migrates an agent mid-wait (workflow replacement), the
        in-flight ``wait_for`` sleep is torn down and its tool call is force-closed
        with the ``DEPLOY_INTERRUPTED`` sentinel. Re-issue the wait against its
        ORIGINAL absolute target with ``resume=True`` so the agent resolves it
        deterministically instead of the completion depending on the LLM re-issuing
        the tool: a future target sleeps the remaining delta; an already-elapsed
        target completes immediately. No-op when there is nothing to resume.
        """
        try:
            target = pending_timestamp_wait_to_resume(conversation or [])
        except Exception as e:  # never block resume on a best-effort re-arm
            workflow.logger.warning(f"[deploy-resume] wait resume check failed: {e}")
            return
        if not target:
            return
        workflow.logger.info(f"[deploy-resume] Resuming interrupted wait_for until {target}")
        await wait_for(self, {"until_timestamp": target, "resume": True}, f"wait-resume-{workflow.uuid4()}")

    async def _poll_messages(self, last_checked: datetime) -> List[Dict]:
        """Poll for new messages using the timestamp provided by run_agent.

        Args:
            last_checked: The timestamp to poll from (managed by run_agent, not workflow state)
        """
        # Wake events after this mark are unseen by the LLM turn this poll feeds:
        # a wait that turn issues ends on them at once (helpers/wait_wake.py).
        snapshot_mark = wake_mark(self)
        try:
            messages = await workflow.execute_activity(
                poll_new_messages,
                args=[self.agent_id, last_checked],  # Use run_agent's timestamp, not self.last_message_check
                start_to_close_timeout=CONTROL_PLANE_POLL_TIMEOUT,
                retry_policy=CONTROL_PLANE_POLL_RETRY,
            )
            note_context_snapshot(self, snapshot_mark)

            # Update workflow context for tools that check it. Return the raw
            # poll result so run_agent can still advance last_checked past
            # filtered sub-agent rows and avoid re-polling them forever.
            if messages:

                def _message_dedupe_key(msg: Dict) -> str:
                    metadata = msg.get("metadata") or {}
                    return "|".join(
                        [
                            str(msg.get("role") or ""),
                            str(msg.get("timestamp") or ""),
                            str(metadata.get("toolCallId") or ""),
                            str(metadata.get("toolName") or ""),
                            str(msg.get("text") or "")[:256],
                        ]
                    )

                seen_message_ids = {
                    msg.get("message_id") or msg.get("id")
                    for msg in self.context
                    if msg.get("message_id") or msg.get("id")
                }
                seen_message_keys = {
                    _message_dedupe_key(msg) for msg in self.context if not (msg.get("message_id") or msg.get("id"))
                }
                for msg in filter_internal_subagent_messages(messages):
                    message_id = msg.get("message_id") or msg.get("id")
                    if message_id:
                        if message_id in seen_message_ids:
                            refresh_user_pause(self.context, msg)
                            continue
                        seen_message_ids.add(message_id)
                    else:
                        message_key = _message_dedupe_key(msg)
                        if message_key in seen_message_keys:
                            continue
                        seen_message_keys.add(message_key)
                    self.context.append(msg)
                self.context.sort(key=lambda x: x.get("timestamp", ""))
                self._admit_durable_response_schema_feedback()

            return messages
        except Exception as e:
            workflow.logger.error(f"Failed to poll messages for {self.agent_id}: {e}")
            raise

    async def _execute_tool(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool, then (simulate mode) re-read this agent's world-time cursor.

        A simulated action advances the agent on its world clock by the WMH's
        predicted duration, and a call that delivered a child's result has
        moved this agent to that child's finish, so the next "now" it sees is
        the world's.
        Outside a WMH world no cursor exists and nothing extra runs.
        """
        result = await self._execute_tool_once(tool_name, tool_args, tool_call_id)
        await self._refresh_world_time_cursor_after_tool()
        return result

    async def _refresh_world_time_cursor_after_tool(self) -> None:
        """Simulate mode: re-read the cursor after a tool, retrying a failed read with a bounded backoff.

        Without a cursor (outside a WMH world) nothing runs. When every attempt
        fails the agent keeps its last acknowledged world time, which never
        moves backwards, and the failure is logged as an error.
        """
        for attempt in range(WORLD_CLOCK_REFRESH_ATTEMPTS):
            if (
                type(getattr(self, "simulated_world_time_ms", None)) is not int
                or getattr(self, "world_model_mode", "real") != "simulate"
            ):
                return
            if attempt:
                # cutover-class: bounded — at most two 5s pauses after a failed simulated-clock read
                await workflow.sleep(timedelta(seconds=WORLD_CLOCK_REFRESH_RETRY_SECONDS))
            if await _refresh_world_time_cursor(self) is not None:
                return
        workflow.logger.error(
            f"[world_clock] Agent {self.agent_id} could not refresh its world time after a tool; "
            "keeping its last acknowledged world time"
        )

    async def _execute_tool_once(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool - supports both new and legacy signatures during migration.

        Every error return path MUST first emit a paired TOOL event via
        _handle_tool_event so the next iteration's LLM call sees alternating
        USER/ASSISTANT/TOOL turns. Returning an error dict without posting a
        tool_result leaves the prior ASSISTANT tool_use unpaired, which trips
        role_alternation and causes the LLM to re-emit the same tool_calls
        (regression: smoke task `parallel-tool-calls`).
        """
        if (
            (self._cost_limit_wrapup_pending or self._cost_limit_wrapup_consumed)
            and self._cost_limit_reached
            and tool_name not in {"attempt_completion", "attempt_completion_with_result"}
        ):
            # Every productive call is refused, including an older turn that
            # was already in flight when browser accounting armed the allowance.
            # Only an admitted wrap-up turn can spend that future allowance.
            if self._cost_limit_wrapup_consumed:
                self._cost_limit_wrapup_pending = False
                if not self.is_paused:
                    self._cost_limit_reached = False
                    await self._check_cost_limit()
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Cost limit reached",
                    message="Cost limit reached",
                    status=MessageStatus.ERROR,
                ),
                tool_call_id,
                tool_name,
            )
            return {"error": True, "message": "Cost limit reached"}
        if tool_name == "attempt_completion":
            # Pending background agents do not block completion: the verifier
            # sees their status, and a finishing parent stops them.
            # Leftover-safe: Fast Mode waits for explore like live, so this
            # is a no-op unless something still tracked a handle.
            await self._drain_fast_mode_explores()
        if is_user_tool_name(tool_name):
            # Pinned user-authored tool: runs its own activity and posts its own
            # FINISHED/ERROR TOOL message (never raises).
            return await run_user_tool(self, tool_name, tool_args, tool_call_id, wf_api=workflow)
        if tool_name not in TOOL_EXECUTORS:
            error_msg = f"Unknown tool: {tool_name}"
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"❌ {tool_name.replace('_', ' ').title()} failed",
                    message=error_msg,
                    status=MessageStatus.ERROR,
                ),
                tool_call_id,
                tool_name,
            )
            return {"error": True, "message": error_msg}

        # Semantic validation: validate tool args against Pydantic model_validators
        from utils.tool_schemas import TOOL_MODELS

        if tool_name in TOOL_MODELS:
            try:
                TOOL_MODELS[tool_name](**{"tool": tool_name, **tool_args})
            except Exception as e:
                error_msg = f"Invalid parameters for {tool_name}: {e}"
                await self._handle_tool_event(
                    ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"❌ {tool_name.replace('_', ' ').title()} failed",
                        message=error_msg,
                        status=MessageStatus.ERROR,
                    ),
                    tool_call_id,
                    tool_name,
                )
                return {"error": True, "message": error_msg}

        if self._spawn_runs_in_background(tool_name, tool_args):
            return await self._start_background_spawn(tool_args, tool_call_id)
        if tool_name == "spawn_agent":
            tool_args = {key: value for key, value in tool_args.items() if key != "run_in_background"}

        # Track tool as in-use with human-readable display string
        tool_display = format_tool_display(tool_name, tool_args)
        self.tools_in_use.add(tool_display)
        await self._update_tree_state()

        try:
            # Check approval requirement
            if tool_name in APPROVAL_REQUIRED_TOOLS:
                manager = APPROVAL_REQUIRED_TOOLS[tool_name]()
                if manager.requires_approval:
                    # Pass system_name for dynamic name in approval messages
                    question = manager.get_approval_question(
                        {"tool": tool_name, "system_name": self.system_name, **tool_args}
                    )
                    # Let UserRejectedError bubble up to outer Exception handler
                    # which posts ERROR for tool_call_id_A
                    approval = await request_user_approval_direct(
                        self,
                        question=question,
                        metadata={"toolApproval": True},
                    )
                    approval_response = str(approval.get("response") or "").strip()
                    if approval_response.casefold() not in {
                        "",
                        "approve",
                        "approved",
                    }:
                        tool_args = await self._repopulate_approved_tool_args(
                            tool_name,
                            tool_args,
                            approval_response,
                        )

            executor = TOOL_EXECUTORS[tool_name]
            self._active_tool_calls[tool_call_id] = (tool_name, dict(tool_args))

            # Tools migrated to new signature: (execute_activity, tool_call, tool_call_id, agent_id, user_id)
            # These return results and call handle_tool_event internally
            NEW_SIGNATURE_TOOLS = {
                "web_search",
                "web_fetch",
                "attempt_completion",
                "call_phone_number",
            }

            if tool_name in NEW_SIGNATURE_TOOLS:
                tool_call_dict = {"tool": tool_name, **tool_args}
                if tool_name in ("attempt_completion", "spawn_agent"):
                    tool_call_dict["_phase"] = self.current_phase

                # web_fetch's WebFetchManager invokes summarize_tool_result on
                # large bodies; pass auth so the summarizer can use claudeAuth
                # ($0) instead of falling through OpenRouter waterfall.
                extra_executor_kwargs: Dict[str, Any] = {}
                if self.world_model_mode != "real" and tool_name in ("web_search", "web_fetch", "call_phone_number"):
                    extra_executor_kwargs["world_model_mode"] = self.world_model_mode
                # Fast Mode: pass the goal so web_search/web_fetch can either
                # read+write (Fast Mode on) or write-only for allowlisted accounts.
                fast_mode_write_through = self.user_id in FAST_MODE_WRITE_THROUGH_USER_IDS
                if tool_name in ("web_search", "web_fetch") and (
                    self.fast_mode_cache_enabled or fast_mode_write_through
                ):
                    extra_executor_kwargs["fast_mode_cache_enabled"] = self.fast_mode_cache_enabled
                    extra_executor_kwargs["fast_mode_goal"] = self.demo_cache_goal
                    extra_executor_kwargs["fast_mode_cache_write_enabled"] = (
                        self.fast_mode_cache_enabled or fast_mode_write_through
                    )
                if tool_name == "web_fetch":
                    extra_executor_kwargs.update(
                        {
                            "compute_token_lineage_key": self.compute_token_lineage_key,
                            "claude_token": self._active_claude_token(),
                            "claude_token_source": self._active_claude_source(),
                            "claude_token_pool_id": self._active_claude_pool_id(),
                            "gpt_token": self._active_gpt_token(),
                            "gpt_account_id": self._active_gpt_account_id(),
                            "gpt_token_source": self._active_gpt_source(),
                            "gpt_token_pool_id": self._active_gpt_pool_id(),
                        }
                    )

                result = await executor(
                    execute_activity=workflow.execute_activity,
                    tool_call=tool_call_dict,
                    tool_call_id=tool_call_id,
                    agent_id=self.agent_id,
                    user_id=self.user_id,
                    **extra_executor_kwargs,
                )
                # Track usage if returned by tool (standardized format)
                original_usage = {}
                rotation_signal: Optional[Dict[str, Any]] = None
                if isinstance(result, dict) and "usage" in result:
                    original_usage = result.get("usage", {})
                    await self._track_usage(original_usage, tool_name=tool_name)
                    rotation_signal = result.get("summarizer_rotation_signal")
                    # Extract actual result for caller
                    result = result.get("result", result)

                # Route rotation signals from the per-tool summarizer through
                # _on_tokens so pool-token rotation kicks in on 401/429/stall
                # the same way it would for the main LLM call.
                if rotation_signal:
                    try:
                        await self._on_tokens(
                            tokens_in_delta=rotation_signal.get("prompt_tokens", 0),
                            tokens_out_delta=rotation_signal.get("completion_tokens", 0),
                            actual_model=rotation_signal.get("actual_model", "unknown"),
                            cache_read_input_tokens=rotation_signal.get("cache_read_input_tokens", 0),
                            cache_creation_input_tokens=rotation_signal.get("cache_creation_input_tokens", 0),
                            call_site=f"summarize_{tool_name}",
                            claude_token_error=rotation_signal.get("claude_token_error"),
                            claude_token_rotated=rotation_signal.get("claude_token_rotated", False),
                            gpt_token_error=rotation_signal.get("gpt_token_error"),
                            gpt_token_rotated=rotation_signal.get("gpt_token_rotated", False),
                            compute_token_used=rotation_signal.get("compute_token_used"),
                            from_fast_cache=rotation_signal.get("from_fast_cache", False),
                            cache_sequence_id=rotation_signal.get("cache_sequence_id"),
                        )
                    except Exception as e:
                        workflow.logger.warning(f"_on_tokens failed for {tool_name} summarizer: {e}")

                # Post downloaded files as ASSISTANT messages (like browser/code agents do)
                # This makes FilePointers visible in the frontend and agent context
                downloaded_files = (
                    (result.get("original", {}) or {}).get("downloaded_files", []) if isinstance(result, dict) else []
                )
                if not downloaded_files and isinstance(result, dict):
                    downloaded_files = result.get("downloaded_files", [])
                for fp in downloaded_files:
                    await self._handle_tool_event(
                        AssistantEvent(message="", file_pointer=fp),
                        tool_call_id,
                        tool_name,
                    )

                return {"success": True, "message": f"{tool_name} completed", "result": result}
            else:
                # Legacy signature: (workflow_instance, tool_call, tool_call_id)
                # These yield ToolEvents and call workflow_instance._handle_tool_event
                tool_call_dict = {"tool": tool_name, **tool_args}
                if tool_name == "spawn_agent":
                    tool_call_dict["_phase"] = self.current_phase
                executor_result = await executor(self, tool_call_dict, tool_call_id)
                if isinstance(executor_result, dict):
                    original_usage = executor_result.get("usage", {})
                    if original_usage:
                        await self._track_usage(original_usage, tool_name=tool_name)
                    result = executor_result.get("result", executor_result)
                    return {"success": True, "message": f"{tool_name} completed", "result": result}
                # spawn_agent returns (last_status, summary) tuple
                if isinstance(executor_result, tuple):
                    last_status, result_text = executor_result
                else:
                    last_status, result_text = executor_result, ""
                failed = last_status == MessageStatus.ERROR
                if failed:
                    return {"error": True, "message": result_text or f"{tool_name} failed"}
                return {"success": True, "message": result_text or f"{tool_name} completed"}

        except GenerationHandoffRequested as exc:
            # In-tool wait yielded so the top-of-loop checkpoint can continue_as_new.
            if exc.parked:
                # The tool parked itself with _park_pending_tool; its chip stays
                # open and the next generation re-enters this exact call.
                workflow.logger.info(f"Tool {tool_name} parked for generation handoff")
                return {
                    "success": True,
                    "message": "",
                    "generation_handoff": True,
                    "handoff_task_queue": exc.task_queue,
                    "pending_tool_resume": True,
                }
            # The tool already closed its chip with DEPLOY_INTERRUPTED; do not ERROR.
            workflow.logger.info(f"Tool {tool_name} interrupted for generation handoff")
            return {
                "success": True,
                "message": DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                "generation_handoff": True,
                "handoff_task_queue": exc.task_queue,
            }

        except asyncio.CancelledError:
            # User paused the agent - don't show as error
            workflow.logger.info(f"Tool {tool_name} cancelled (user paused)")
            return {"success": False, "message": "User paused the agent during browser execution"}

        except Exception as e:
            error_msg = extract_error_message(e)

            # Include user's rejection feedback in the error message
            if isinstance(e, UserRejectedError) and e.rejection_message:
                error_msg = f'User rejected with feedback: "{e.rejection_message}"'
                workflow.logger.info(f"Tool {tool_name} rejected by user: {e.rejection_message[:100]}")
            else:
                workflow.logger.error(f"Tool {tool_name} failed: {error_msg}")

            # For spawn_agent (general_purpose type), include child-agent context so frontend renders
            # as a proper sub-agent failure (SubAgentTree) instead of a raw chip
            error_metadata = None
            if tool_name == "spawn_agent" and tool_args.get("type") == "general_purpose":
                meta = {}
                # Find the child agent spawned by this tool_call_id
                for child_id, tid in getattr(self, "child_tool_ids", {}).items():
                    if tid == tool_call_id:
                        meta["subAgentIds"] = [child_id]
                        break
                bus_id = getattr(self, "bus_id", None)
                if bus_id:
                    meta["busId"] = bus_id
                spawn_group_id = tool_args.get("_spawn_group_id")
                if isinstance(spawn_group_id, str) and spawn_group_id:
                    meta["spawnGroupId"] = spawn_group_id
                if meta:
                    error_metadata = meta

            # Emit error event so it shows in frontend
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"❌ {tool_name.replace('_', ' ').title()} failed",
                    message=error_msg,
                    status=MessageStatus.ERROR,
                    metadata=error_metadata,
                ),
                tool_call_id,
                tool_name,
            )
            return {"error": True, "message": error_msg}
        finally:
            self._active_tool_calls.pop(tool_call_id, None)
            # Remove tool from in-use and broadcast tree state
            self.tools_in_use.discard(tool_display)
            await self._update_tree_state()

    async def _repopulate_approved_tool_args(
        self,
        tool_name: str,
        original_args: Dict[str, Any],
        approval_response: str,
    ) -> Dict[str, Any]:
        """Apply approval-time feedback to one already-approved tool call.

        This is parameter population, not a new action proposal: validation
        requires the original tool and execution resumes directly with the
        refreshed arguments.
        """
        system_prompt_text = await self.build_system_prompt()
        original_json = _json.dumps(original_args, ensure_ascii=False, sort_keys=True)
        extra_message = (
            f"Update the parameters for the already-approved `{tool_name}` call using the user's "
            "approval-time feedback.\n\n"
            f"Original parameters:\n{original_json}\n\n"
            f"User approval feedback:\n{approval_response}\n\n"
            f"Call exactly `{tool_name}` once with the complete updated parameters. Preserve every "
            "original parameter unless the feedback requires changing it. Do not call another tool "
            "and do not ask for approval; this action is already approved."
        )

        # Force the canonical backend context so same-worker and cross-worker
        # activities see identical context, including the just-finished approval
        # event. The stable system/history prefix remains cache-readable; the
        # unique instruction is trailing and skip_cache_write avoids caching it.
        llm_result = await workflow.execute_activity(
            call_llm_activity,
            args=[
                self.agent_id,
                self.model,
                self._current_tools,
                256,
                self.agent_id,
                None,
                None,
                self._active_claude_token(),
                "approval_param_populator",
                system_prompt_text,
                extra_message,
                tool_name,
                True,
                "",
                self._active_claude_source(),
                self._active_claude_pool_id(),
                self.user_id,
                self._active_gpt_token(),
                self._active_gpt_account_id(),
                self._active_gpt_source(),
                self._active_gpt_pool_id(),
                self.user_id,
                self.compute_token_lineage_key,
                self.compute_token_demo_cache_affinity_key,
                self.user_id,
                self.fast_mode_cache_enabled,
                self.demo_cache_goal,
                None,
                True,
                True,
                f"agent:{self.agent_id}:call:approval_param_populator",
            ],
            start_to_close_timeout=timedelta(seconds=600),
            retry_policy=RetryPolicy(maximum_attempts=2),
            heartbeat_timeout=timedelta(seconds=180),
        )

        matching_calls = [call for call in llm_result.get("tool_calls", []) if call.get("tool") == tool_name]
        if len(matching_calls) != 1:
            raise ValueError(
                f"Approval parameter population expected exactly one {tool_name} call; received {len(matching_calls)}"
            )

        refreshed_args = {key: value for key, value in matching_calls[0].items() if key != "tool"}
        merged_args = dict(original_args)
        merged_args.update(refreshed_args)

        usage = llm_result.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        if prompt_tokens > 0 or completion_tokens > 0:
            try:
                await self._on_tokens(
                    prompt_tokens,
                    completion_tokens,
                    usage.get("actual_model"),
                    cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
                    cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
                    call_site="approval_param_populator",
                    claude_token_rotated=usage.get("claude_token_rotated", False),
                    claude_token_error=usage.get("claude_token_error"),
                    gpt_token_error=usage.get("gpt_token_error"),
                    gpt_token_rotated=usage.get("gpt_token_rotated", False),
                    compute_token_used=usage.get("compute_token_used"),
                    from_fast_cache=usage.get("from_fast_cache", False),
                    cache_sequence_id=usage.get("cache_sequence_id"),
                )
            except Exception as error:
                workflow.logger.warning(f"on_tokens failed for approval_param_populator: {error}")

        return merged_args

    async def _handle_tool_event(self, event: ToolEvent, tool_call_id: str, tool_name: str) -> None:
        """
        Handle ToolEvent emitted by tool managers.

        Delegates to standalone handle_tool_event function which routes events
        to appropriate FE/DB updates. Works in both workflow and activity contexts.

        Note: Cost tracking is handled separately via _track_usage() for tools that
        return standardized usage dicts, not through events.
        """
        if isinstance(event, ToolEvent):
            phase = getattr(self, "current_phase", None)
            metadata = dict(event.metadata or {})
            if phase:
                metadata.setdefault("phase", phase)
            # A background spawn's executor rows are FE-only (its "started" row is
            # the model's result for this id): workflows/background_agents.py.
            event.metadata = self._background_row_metadata(tool_call_id, metadata)
        self._record_background_event(event, tool_call_id)
        self._note_environment_activity(event, tool_call_id)

        # handle_tool_event imported at module level within imports_passed_through
        await handle_tool_event(
            event=event,
            agent_id=self.agent_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            execute_activity=workflow.execute_activity,  # Workflow context
            user_id=self.user_id,
            sub_agent_id=None,  # Main workflow doesn't have sub_agent_id
        )

    # =========================================================================
    # HELPERS
    # =========================================================================

    def _usage_checkpoint(self) -> Dict[str, float | int]:
        """Own-only durable high-water attached to each idempotent usage write."""
        return {
            "token_count": self.token_count,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "own_cost_cents": self.own_cost_cents,
        }

    async def _track_tokens_and_cost(self, result: Dict) -> None:
        """Track context size and token_count from run_agent result.

        NOTE: tokens_in/out and cost are now tracked in real-time via _on_tokens callback
        during run_agent execution. This method only handles:
        1. context_size update (current context window)
        2. token_count update (total tokens for display)

        For non-run_agent LLM calls (e.g., completion summary), use _track_llm_cost directly.
        """
        # Update token_count (for display purposes)
        self.token_count += result.get("token_count", 0)

        # Update context_size to latest value (not cumulative - represents current context window)
        if "context_size" in result:
            self.context_size = result["context_size"]

        # NOTE: tokens_in/out and cost tracking moved to _on_tokens callback
        # which is called after each LLM call in run_agent for real-time limit checking

    async def _track_llm_cost(
        self,
        tokens_in: int,
        tokens_out: int,
        call_site: str = "unknown",
        actual_model: Optional[str] = None,
        cache_read_input_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
        from_fast_cache: bool = False,
    ) -> None:
        """Track cost for LLM calls outside run_agent (e.g., completion summary).

        Use this for LLM calls that don't go through run_agent and thus don't trigger _on_tokens.

        Args:
            tokens_in: Input/prompt tokens
            tokens_out: Output/completion tokens
            call_site: Label identifying the LLM call source (e.g., completion_summary, context_compression)
            actual_model: Model that served the request when available.
            cache_read_input_tokens: Cached input tokens read.
            cache_creation_input_tokens: Tokens written to cache.
            from_fast_cache: True when Fast Mode replayed this usage without a provider call.
        """
        # Update workflow token state
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out

        # Calculate cost from tokens using stored pricing (fractional cents)
        cost_cents = 0.0
        model_for_usage = _resolve_usage_model(actual_model, self.model)
        zero_user_charge = model_for_usage.endswith(("-claude", "-gpt", "-foundry"))
        if from_fast_cache or zero_user_charge:
            workflow.logger.info(
                f"💰 $0 user charge: actual_model={model_for_usage}, "
                f"in={tokens_in}, out={tokens_out}, cache_read={cache_read_input_tokens}, call_site={call_site}"
            )
            try:
                await workflow.execute_activity(
                    save_tool_usage,
                    args=[
                        self.agent_id,
                        self.user_id,
                        call_site,
                        [
                            {
                                "type": "llm",
                                "cost_cents": 0,
                                "call_site": call_site,
                                "tokens_in": tokens_in,
                                "tokens_out": tokens_out,
                                "model": model_for_usage,
                                "cache_read_input_tokens": cache_read_input_tokens,
                                "cache_creation_input_tokens": cache_creation_input_tokens,
                                "from_fast_cache": from_fast_cache,
                            }
                        ],
                        self._usage_checkpoint(),
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to save tool usage for {call_site}: {e}")
            await self._update_cost_and_signal_parent()
            return

        if self.input_cents_per_1k > 0 or self.output_cents_per_1k > 0:
            cost_cents = (tokens_in * self.input_cents_per_1k / 1000) + (tokens_out * self.output_cents_per_1k / 1000)
            if cost_cents > 0:
                self.own_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost ({call_site}): +{cost_cents:.2f}c (total: {self.own_cost_cents:.1f}c, "
                    f"in={tokens_in}, out={tokens_out})"
                )

                # Save to ToolUsage table for call_site tracking
                try:
                    await workflow.execute_activity(
                        save_tool_usage,
                        args=[
                            self.agent_id,
                            self.user_id,
                            call_site,
                            [
                                {
                                    "type": "llm",
                                    "cost_cents": cost_cents,
                                    "call_site": call_site,
                                    "tokens_in": tokens_in,
                                    "tokens_out": tokens_out,
                                    "model": model_for_usage,
                                    "cache_read_input_tokens": cache_read_input_tokens,
                                    "cache_creation_input_tokens": cache_creation_input_tokens,
                                }
                            ],
                            self._usage_checkpoint(),
                        ],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                except Exception as e:
                    workflow.logger.warning(f"Failed to save tool usage for {call_site}: {e}")

        # Token aggregation is independent of price. Direct-token and unknown-
        # price calls must still update the child subtree reported to the parent.
        await self._update_cost_and_signal_parent()

    async def _track_usage(
        self, usage: Optional[Dict] = None, tool_name: Optional[str] = None, call_site: Optional[str] = None,
        browser_completed: bool = False,
    ) -> None:
        """
        Track usage from any activity result.

        This is THE SINGLE POINT where all costs are:
        1. Calculated (LLM tokens → cost via pricing)
        2. Added to own_cost_cents
        3. Written to ToolUsage table (if tool_name provided)
        4. Signaled to parent for hierarchical relay

        Args:
            usage: Dict with "llm" and/or "service" lists
            tool_name: Tool name for ToolUsage table (optional for internal LLM calls)
            call_site: Label identifying the LLM call source (e.g., planner, explore_agent, browser_agent).
                       Falls back to tool_name if not provided.
        """
        if not usage:
            return

        paused_before = self.is_paused
        cost_limit_before = self._cost_limit_reached
        pause_sequence_before = self._pause_signal_sequence

        total_cost_cents = 0
        usage_items_for_db = []

        # Process LLM usage items
        for llm in usage.get("llm", []):
            tokens_in = llm.get("tokens_in", 0)
            tokens_out = llm.get("tokens_out", 0)
            model = llm.get("model") or self.model
            provider = llm.get("provider") or model
            effective_call_site = call_site or tool_name or "unknown"
            cache_read = llm.get("cache_read_input_tokens", 0)
            cache_write = llm.get("cache_creation_input_tokens", 0)
            cache_sequence_id = llm.get("cache_sequence_id")
            from_fast_cache = bool(llm.get("from_fast_cache"))

            if from_fast_cache:
                workflow.logger.info(
                    f"💰 $0 cost (fast cache replay): actual_model={model}, "
                    f"in={tokens_in}, out={tokens_out}, cache_read={cache_read}, call_site={effective_call_site}"
                )
                usage_items_for_db.append(
                    {
                        "type": "llm",
                        "cost_cents": 0,
                        "call_site": effective_call_site,
                        "provider": provider,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": model,
                        "cache_read_input_tokens": cache_read,
                        "cache_creation_input_tokens": cache_write,
                        "from_fast_cache": True,
                        **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
                    }
                )
                continue

            # own_cost_cents and price_limit_cents are the user's charge ledger.
            # Foundry's separate Azure bill is monitored through Azure billing;
            # it must not consume a user's $0 compute-token limit.
            if isinstance(model, str) and model.endswith(("-claude", "-gpt", "-foundry")):
                workflow.logger.info(
                    f"💰 $0 user charge: actual_model={model}, "
                    f"in={tokens_in}, out={tokens_out}, call_site={effective_call_site}"
                )
                usage_items_for_db.append(
                    {
                        "type": "llm",
                        "cost_cents": 0,
                        "call_site": effective_call_site,
                        "provider": provider,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": model,
                        "cache_read_input_tokens": cache_read,
                        "cache_creation_input_tokens": cache_write,
                        **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
                    }
                )
                continue

            # Get pricing for this model (fetch if not cached)
            pricing = await self._get_model_pricing(model)
            if not pricing:
                workflow.logger.warning(
                    f"⚠️ No pricing for model {model}, skipping cost for {tokens_in}/{tokens_out} tokens"
                )
                continue

            input_rate = pricing["input_cents_per_1k"]
            output_rate = pricing["output_cents_per_1k"]

            # Apply provider-specific cache discounts if cache fields present
            is_anthropic = model and ("claude" in model.lower() or model.lower().endswith("-claude"))
            cache_read_mult = 0.1 if is_anthropic else 0.25
            cache_write_mult = 1.25 if is_anthropic else 1.0

            cost_cents = (
                (tokens_in * input_rate / 1000)
                + (cache_read * input_rate * cache_read_mult / 1000)
                + (cache_write * input_rate * cache_write_mult / 1000)
                + (tokens_out * output_rate / 1000)
            )
            usage_item = {
                "type": "llm",
                "cost_cents": cost_cents,
                "call_site": effective_call_site,
                "provider": provider,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "model": model,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
                **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
            }
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c ({provider}, in={tokens_in}, out={tokens_out}, call_site={effective_call_site})"
                )
                usage_items_for_db.append(usage_item)

        # Process service usage items (pre-calculated costs)
        for svc in usage.get("service", []):
            cost_cents = svc.get("cost_cents", 0)
            provider = svc.get("provider", "Service")
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(f"💰 Service cost: +{cost_cents}c ({provider})")
                effective_call_site = call_site or tool_name or "unknown"
                usage_items_for_db.append(
                    {
                        "type": "service",
                        "cost_cents": cost_cents,
                        "call_site": effective_call_site,
                        "provider": provider,
                    }
                )

        if total_cost_cents > 0:
            # Update workflow cost state
            self.own_cost_cents += total_cost_cents
            workflow.logger.info(f"💰 Total own_cost_cents: {self.own_cost_cents}c (+{total_cost_cents}c)")

            # Admit the verified terminal result before any persistence/signal
            # await can admit another child cost update and publish a cost stop.
            if browser_completed:
                self.subtree_cost_cents = self.own_cost_cents + sum(self.children_cost_cents.values())
                self._maybe_arm_cost_limit_wrapup_after_browser(
                    tool_name=tool_name,
                    result={"success": True},
                    paused_before=paused_before,
                    cost_limit_before=cost_limit_before or self._cost_limit_reached,
                    pause_sequence_before=pause_sequence_before,
                )
            await self._update_cost_and_signal_parent()

        # Write to ToolUsage table (if tool_name provided). This intentionally
        # includes zero-cost direct-token LLM rows so cache/accounting diagnostics
        # can see the same LLM calls that worker logs emit.
        effective_call_site = call_site or tool_name or "unknown"
        if tool_name and usage_items_for_db:
            try:
                await workflow.execute_activity(
                    save_tool_usage,
                    args=[
                        self.agent_id,
                        self.user_id,
                        effective_call_site,
                        usage_items_for_db,
                        self._usage_checkpoint(),
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to save tool usage to DB: {e}")

    async def _get_model_pricing(self, model: str) -> Optional[Dict[str, float]]:
        """Get pricing for a model, using cache or fetching if needed."""
        # Check if it's the workflow's primary model
        if model == self.model and (self.input_cents_per_1k > 0 or self.output_cents_per_1k > 0):
            return {
                "input_cents_per_1k": self.input_cents_per_1k,
                "output_cents_per_1k": self.output_cents_per_1k,
            }

        # Check cache
        if model in self.model_pricing_cache:
            return self.model_pricing_cache[model]

        # Pricing is an in-process constant table. Keep this on the workflow
        # path so cost accounting cannot stall user-visible tools behind the
        # activity queue under benchmark load.
        pricing = get_in_process_model_pricing(model)
        if pricing is None:
            pricing = get_default_pricing(model)
            workflow.logger.warning(f"💰 Using default pricing fallback for {model}: {pricing}")
        else:
            workflow.logger.info(f"💰 Resolved pricing for {model}: {pricing}")
        self.model_pricing_cache[model] = pricing
        return pricing

    # =========================================================================
    # COST LIMIT HELPERS
    # =========================================================================

    async def _query_parent_state(self) -> Dict:
        """Query parent workflow's state via activity (uses Temporal client).

        ExternalWorkflowHandle only supports signal/cancel, not query.
        This activity bridges the gap by querying via the client.
        Returns empty dict on failure (caller decides how to handle).
        """
        if not self.parent_workflow_id:
            return {}
        now = workflow.now()
        if (
            not self._paused_by_parent
            and self._last_parent_state_query_at is not None
            and (now - self._last_parent_state_query_at) < _PARENT_STATE_QUERY_MIN_INTERVAL
        ):
            return dict(self._last_parent_state)
        try:
            state = await workflow.execute_activity(
                query_parent_state_activity,
                args=[self.parent_workflow_id],
                start_to_close_timeout=_QUERY_PARENT_STATE_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to query parent state: {e}")
            self._last_parent_state_query_at = now
            return dict(self._last_parent_state)
        self._last_parent_state_query_at = now
        if isinstance(state, dict):
            self._last_parent_state = dict(state)
            return state
        return dict(self._last_parent_state)

    async def _check_parent_state(self) -> None:
        """Pull-based parent state check. Mirrors parent's pause/cost-limit state.

        Handles both directions:
        - Parent paused → child inherits pause (sets _paused_by_parent)
        - Parent unpaused → child unpauses (only if _paused_by_parent, not manual/credits)
        """
        if not self.parent_workflow_id:
            return

        state = await self._query_parent_state()

        # Parent confirmed gone (terminated / not found). Every child is now
        # orphaned, including an active or independently-paused child: continuing
        # would spend resources for a root that can no longer consume its result.
        # A finished parent (still queryable after close) is gone the same way;
        # this backs up the parent_finished signal for a child it raced.
        if state.get("parent_missing") or state.get("is_finished") is True:
            if not self._orphaned:
                workflow.logger.warning("Parent workflow gone — orphaned child aborting")
                self._orphaned = True
                self.is_paused = False
                self._user_pause_active = False
                self._paused_by_parent = False
            self._parent_query_failures_while_paused = 0
            return

        if not state:
            # Transient failure. If we've been paused-by-parent and unable to read
            # the parent for many consecutive checks, treat the parent as gone
            # (backstop for when terminal status can't be classified) and abort.
            if self._paused_by_parent and not self._orphaned:
                self._parent_query_failures_while_paused += 1
                if self._parent_query_failures_while_paused >= _ORPHAN_TRANSIENT_FAILURE_LIMIT:
                    workflow.logger.warning(
                        "Parent unreachable for %d consecutive checks while paused — orphaned child aborting",
                        self._parent_query_failures_while_paused,
                    )
                    self._orphaned = True
                    self.is_paused = False
                    self._user_pause_active = False
                    self._paused_by_parent = False
            return

        # Successful read — reset the transient-failure backstop.
        self._parent_query_failures_while_paused = 0

        parent_cost_limited = state.get("is_cost_limit_reached", False)
        parent_paused = state.get("is_paused", False)

        if parent_cost_limited:
            if not self._cost_limit_reached:
                workflow.logger.warning("Parent hit cost limit — inheriting state")
                self._cost_limit_reached = True
                self.is_paused = True
                self._paused_by_parent = True
                await self._update_tree_state(status="COST_LIMIT_REACHED")
        elif parent_paused:
            if not self.is_paused:
                workflow.logger.warning("Parent is paused — inheriting state")
                self._user_pause_active = state.get("user_pause_active") is True
                self.is_paused = True
                self._paused_by_parent = True
                await self._update_tree_state(status="PAUSED")
            elif self._paused_by_parent:
                self._user_pause_active = state.get("user_pause_active") is True
        else:
            # Parent is running — unpause if we were paused by parent
            if self._paused_by_parent:
                workflow.logger.info("Parent resumed — clearing inherited pause")
                self._cost_limit_reached = False
                self.is_paused = False
                self._user_pause_active = False
                self._paused_by_parent = False
                await self._update_tree_state(status="ACTIVE")

    def _get_pending_child_workflow_ids(self) -> List[str]:
        """Get workflow IDs of pending children for signaling."""
        return [self.child_workflow_ids[cid] for cid in self.pending_children if cid in self.child_workflow_ids]

    def _get_children_tokens(self) -> Tuple[int, int]:
        """Get current sum of children's tokens for tree aggregation."""
        return (
            sum(self.children_tokens_in.values()),
            sum(self.children_tokens_out.values()),
        )

    async def _on_tokens(
        self,
        tokens_in_delta: int,
        tokens_out_delta: int,
        actual_model: Optional[str] = None,
        cache_read_input_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
        call_site: str = "unknown",
        claude_token_error: Optional[str] = None,
        gpt_token_error: Optional[str] = None,
        claude_token_rotated: bool = False,
        gpt_token_rotated: bool = False,
        compute_token_used: Optional[Dict[str, Any]] = None,
        from_fast_cache: bool = False,
        iteration: Optional[int] = None,
        cache_sequence_id: Optional[str] = None,
    ) -> None:
        """Callback for run_agent to report token usage after each LLM call.

        This enables real-time cost tracking and limit checking, not just at phase boundaries.

        Args:
            tokens_in_delta: Non-cached input tokens (Anthropic semantics)
            tokens_out_delta: Output/completion tokens
            actual_model: The model that actually served the request
            cache_read_input_tokens: Cached input tokens read (discounted pricing)
            cache_creation_input_tokens: Tokens written to cache (may cost extra for Anthropic)
            call_site: Label identifying the LLM call source (e.g., plan_loop, execute_loop, verifier_execute)
            claude_token_error: Why the claude token call failed (auth_error, rate_limit, stall, server_error)
            claude_token_rotated: True when RoseClient swapped tokens inside a successful claudeAuth call.
            gpt_token_rotated: True when RoseClient swapped tokens inside a successful gptAuth call.
            from_fast_cache: True when Fast Mode replayed this usage without a provider call.
        """
        # Update workflow token state (keep in sync with run_agent local vars)
        self.tokens_in += tokens_in_delta
        self.tokens_out += tokens_out_delta
        self.token_count += tokens_in_delta + tokens_out_delta
        if (
            call_site in {"execute_loop", "verifier_execute"}
            and isinstance(iteration, int)
            and not isinstance(iteration, bool)
        ):
            self.iteration_offset = max(self.iteration_offset, iteration)
        self.context_size = tokens_in_delta + cache_read_input_tokens + cache_creation_input_tokens
        await self._advance_cloud_agent_lifecycle(CLOUD_AGENT_READY_TITLE, "FINISHED")
        await self._await_deferred_startup()

        # Track actual_model for credit billing
        if actual_model:
            self.actual_model = actual_model

            token_used_type = compute_token_used.get("type") if compute_token_used else None
            if compute_token_used and (
                (token_used_type == "claude" and actual_model.endswith("-claude"))
                or (token_used_type == "gpt" and actual_model.endswith("-gpt"))
            ):
                # Usage carries only the lease identity, never the credential.
                # When RoseClient rotated to another lease inside the call,
                # re-read the lineage-bound lease from the backend. Without a
                # rotation the call used a credential this workflow supplied,
                # so the cached token stays as it is.
                if self.user_id and (claude_token_rotated or gpt_token_rotated):
                    await self._refresh_compute_token(self.user_id, force=True, token_type=token_used_type)
                    workflow.logger.info(
                        f"🔑 Workflow cached compute token re-read after in-call rotation "
                        f"(type={self.compute_token_provider}, source={compute_token_used.get('source')})"
                    )

            if (
                self.compute_token_provider == "claude"
                and self.claude_max_token
                and actual_model.endswith("-claude")
                and claude_token_rotated
                and not compute_token_used
            ):
                workflow.logger.info("🔁 Claude token rotated inside RoseClient; refreshing workflow cached token")
                if self.user_id:
                    try:
                        await self._rotate_compute_token(self.user_id)
                    except Exception as refresh_error:
                        workflow.logger.warning(
                            f"Rotation refetch failed after successful claudeAuth call: {refresh_error}"
                        )

            # Detect direct-token fallback: we had a selected token but Rose fell through to
            # the waterfall. Rotate on auth/rate-limit (token is bad) and on stall (RoseClient
            # already exhausted in-place TTFT-bumped retries on the same token, so the slot
            # itself is unhappy — swap to a different one). 5xx still keeps the token: it's
            # provider-side, retrying the same slot next call is the right call.
            if (
                self.compute_token_provider == "claude"
                and self.claude_max_token
                and actual_model != "unknown"
                and not actual_model.endswith("-claude")
            ):
                if claude_token_error in ("auth_error", "rate_limit", "stall"):
                    workflow.logger.warning(
                        f"⚠️ Claude token {claude_token_error}: actual_model={actual_model}, "
                        f"re-leasing after the {self.claude_max_token_source} token failed"
                    )
                    # RoseClient already reported each failed attempt with that
                    # attempt's own login (provider cool-down / stall mark). This
                    # usage names only the last error, and after an in-call
                    # rotation the cached lease is not the failed one, so the
                    # workflow never reports it: it only re-leases (T7).
                    if self.user_id:
                        try:
                            await self._rotate_compute_token(self.user_id)
                        except Exception as refresh_error:
                            workflow.logger.warning(f"Rotation refetch failed: {refresh_error}")
                else:
                    workflow.logger.info(
                        f"ℹ️ Claude token fallback (transient: {claude_token_error}): "
                        f"actual_model={actual_model}, keeping token for retry"
                    )
            if (
                self.compute_token_provider == "gpt"
                and self.gpt_code_token
                and actual_model.endswith("-gpt")
                and gpt_token_rotated
                and not compute_token_used
            ):
                workflow.logger.info("🔁 GPT token rotated inside RoseClient; refreshing workflow cached token")
                if self.user_id:
                    try:
                        await self._rotate_compute_token(self.user_id)
                    except Exception as refresh_error:
                        workflow.logger.warning(
                            f"GPT rotation refetch failed after successful gptAuth call: {refresh_error}"
                        )

            if (
                self.compute_token_provider == "gpt"
                and self.gpt_code_token
                and actual_model != "unknown"
                and not actual_model.endswith("-gpt")
            ):
                if gpt_token_error in ("auth_error", "rate_limit", "stall"):
                    workflow.logger.warning(
                        f"⚠️ GPT token {gpt_token_error}: actual_model={actual_model}, "
                        f"re-leasing after the {self.gpt_code_token_source} token failed"
                    )
                    # RoseClient already reported each failed attempt with that
                    # attempt's own login (provider cool-down / stall mark). This
                    # usage names only the last error, and after an in-call
                    # rotation the cached lease is not the failed one, so the
                    # workflow never reports it: it only re-leases (T7).
                    if self.user_id:
                        try:
                            await self._rotate_compute_token(self.user_id)
                        except Exception as refresh_error:
                            workflow.logger.warning(f"GPT rotation refetch failed: {refresh_error}")
                else:
                    workflow.logger.info(
                        f"ℹ️ GPT token fallback (transient: {gpt_token_error}): "
                        f"actual_model={actual_model}, keeping token for retry"
                    )

        # Use actual_model pricing if available
        # For Anthropic models: hardcoded pricing (includes -claude passthrough = $0)
        # For OpenRouter models: falls back to pool-average (self.input_cents_per_1k)
        input_rate = self.input_cents_per_1k
        output_rate = self.output_cents_per_1k
        if actual_model:
            actual_pricing = get_anthropic_pricing(actual_model)
            if actual_pricing is not None:
                input_rate = actual_pricing["input_cents_per_1k"]
                output_rate = actual_pricing["output_cents_per_1k"]
                if input_rate == 0 and output_rate == 0:
                    workflow.logger.info(
                        f"💰 $0 user charge: actual_model={actual_model}, in={tokens_in_delta}, out={tokens_out_delta}"
                    )

        # Calculate cost with provider-specific cache discounts
        # Anthropic direct: cache read = 0.1x input, cache write = 1.25x input
        # OpenRouter (all other providers): cache read = 0.25x input, cache write = 1.0x input
        is_anthropic = actual_model and ("claude" in actual_model.lower() or actual_model.lower().endswith("-claude"))
        cache_read_mult = 0.1 if is_anthropic else 0.25
        cache_write_mult = 1.25 if is_anthropic else 1.0

        cost_cents = 0.0
        if from_fast_cache:
            workflow.logger.info(
                f"💰 $0 cost (fast cache replay): actual_model={actual_model or self.model}, "
                f"in={tokens_in_delta}, out={tokens_out_delta}, cache_read={cache_read_input_tokens}, call_site={call_site}"
            )
        elif input_rate > 0 or output_rate > 0:
            input_cost = tokens_in_delta * input_rate / 1000
            cache_read_cost = cache_read_input_tokens * input_rate * cache_read_mult / 1000
            cache_write_cost = cache_creation_input_tokens * input_rate * cache_write_mult / 1000
            output_cost = tokens_out_delta * output_rate / 1000
            cost_cents = input_cost + cache_read_cost + cache_write_cost + output_cost

            if cost_cents > 0:
                self.own_cost_cents += cost_cents
                cache_info = ""
                if cache_read_input_tokens > 0 or cache_creation_input_tokens > 0:
                    cache_info = f", cache_read={cache_read_input_tokens}@{cache_read_mult}x, cache_write={cache_creation_input_tokens}@{cache_write_mult}x"
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c (total own: {self.own_cost_cents:.1f}c, "
                    f"in={tokens_in_delta}, out={tokens_out_delta}{cache_info})"
                )

        # Token aggregation is independent of price. Direct-token and demo-cache
        # calls must still update the child subtree reported to the parent.
        await self._update_cost_and_signal_parent()

        # Save ToolUsage record for credit billing (with actual_model and correct cost)
        model_for_usage = _resolve_usage_model(actual_model, self.model)
        try:
            await workflow.execute_activity(
                save_tool_usage,
                args=[
                    self.agent_id,
                    self.user_id,
                    call_site,
                    [
                        {
                            "type": "llm",
                            "cost_cents": cost_cents,
                            "call_site": call_site,
                            "tokens_in": tokens_in_delta,
                            "tokens_out": tokens_out_delta,
                            "model": model_for_usage,
                            "cache_read_input_tokens": cache_read_input_tokens,
                            "cache_creation_input_tokens": cache_creation_input_tokens,
                            "from_fast_cache": from_fast_cache,
                            "iteration": iteration,
                            **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
                        }
                    ],
                    self._usage_checkpoint(),
                ],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to save LLM usage to DB: {e}")

    async def _update_cost_and_signal_parent(self, force: bool = False) -> None:
        """Recalculate subtree cost/tokens and signal parent (or check limit if root).

        The DB persist + Processing status broadcast are debounced (coalesced to at
        most one emit per 3s) so the fan-out does not flood the backend — the flood
        causes the activity timeouts that stall the loop and the out-of-order
        broadcasts that flicker the FE cost. Pass force=True on terminal/cost-limit
        transitions to flush the final value immediately. Parent cost signal and the
        root cost-limit check normally run immediately. Verified browser terminal
        usage settles its existing completion allowance before publishing a stop.
        """
        # Recalculate subtree cost
        self.subtree_cost_cents = self.own_cost_cents + sum(self.children_cost_cents.values())

        # Recalculate tree tokens (own + all children's subtrees)
        self.tree_tokens_in = self.tokens_in + sum(self.children_tokens_in.values())
        self.tree_tokens_out = self.tokens_out + sum(self.children_tokens_out.values())

        # Signal parent (if we have one)
        if self.parent_workflow_id:
            if not self._orphaned:
                try:
                    parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                    await parent.signal(
                        "child_cost_update",
                        {
                            "child_agent_id": self.agent_id,
                            "subtree_cost_cents": self.subtree_cost_cents,
                            "subtree_tokens_in": self.tree_tokens_in,
                            "subtree_tokens_out": self.tree_tokens_out,
                        },
                    )
                except Exception as e:
                    workflow.logger.warning(f"Failed to signal parent cost update: {e}")
        else:
            # We are root - check cost limit
            await self._check_cost_limit()

        # Debounce the DB persist + Processing status broadcast — the flooding pair.
        # (Parent signal + cost-limit check above always run; only the FE-display
        # writes below are coalesced.) workflow.now() keeps this deterministic.
        now = workflow.now()
        if (
            not force
            and self._last_tree_cost_emit_at is not None
            and (now - self._last_tree_cost_emit_at) < timedelta(seconds=3)
        ):
            return
        self._last_tree_cost_emit_at = now

        # Persist subtree cost to DB (for all agents, so frontend can display it)
        await self._persist_tree_cost()

        # Broadcast updated tree tokens to this agent's channel (for frontend display)
        # This applies to all agents (root and non-root) when receiving child updates
        # Skip if paused, cost-limited, or already finished — don't overwrite
        # PAUSED/COST_LIMIT_REACHED/COMPLETED/FAILED DB status with ACTIVE.
        # Regression: a late child_cost_update signal arriving after _mark_complete
        # would broadcast status=ACTIVE/Processing over the terminal status,
        # making the benchmark harness poll forever until the stall threshold
        # deleted the agent (404/DELETED at 136s).
        if not self._cost_limit_reached and not self.is_paused and not self._is_finished:
            try:
                await workflow.execute_activity(
                    update_agent_status,
                    args=[
                        self.agent_id,
                        "ACTIVE",
                        0.5,
                        "Processing",
                        self.token_count,
                        self.context_size,
                        self.message_count,
                        self.tokens_in,
                        self.tokens_out,
                        None,
                        self.iteration_offset,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to broadcast tree tokens: {e}")

    async def _check_cost_limit(self) -> None:
        """Check if subtree cost exceeds limit. Only root calls this.

        The limit authorizes *future* spend. Once the terminal flag is latched
        there is no future spend to stop, so pausing here can only corrupt an
        already-decided lifecycle state: `_mark_complete` latches `_is_finished`
        and then tracks the completion summary's own LLM cost, and a sub-agent's
        final `child_cost_update` signal lands on this same path. Without this
        guard either one rewrites a verifier-100% root as COST_LIMIT_REACHED —
        a terminal status for every poller — and cascades a spurious pause to
        its children.
        """
        if self.parent_workflow_id is not None:
            return  # Only root checks limit

        if self._is_finished:
            return  # No further work to authorize; see docstring.

        if self.subtree_cost_cents >= self.price_limit_cents and not self._cost_limit_reached:
            workflow.logger.warning(f"💰 Cost limit exceeded: {self.subtree_cost_cents}c >= {self.price_limit_cents}c")
            self._cost_limit_reached = True
            self.is_paused = True

            # Flush the tree cost that just tripped the limit. The caller's
            # persist is debounced to one emit per 3s and this transition is
            # terminal — the agent pauses immediately after — so a suppressed
            # emit leaves the pre-trip value (typically 0) as the last number
            # written. Every downstream consumer then reads a cost-limited run
            # as costing 0c: the agent row, the FE cost display, and the
            # benchmark's cost_cents/stop_metadata, which is what made the
            # 50c-cap trip on agent a67ef234-e1d8-4e72-adda-020cdcab6059
            # unreconcilable from its own run record.
            await self._persist_tree_cost()

            # Update status to COST_LIMIT_REACHED. The decision inputs go in the
            # status message so the reason survives into the agent row, every
            # realtime broadcast, and the benchmark run record — worker logs are
            # not retained long enough to reconstruct this after the fact.
            try:
                await workflow.execute_activity(
                    update_agent_status,
                    args=[
                        self.agent_id,
                        "COST_LIMIT_REACHED",
                        0.0,
                        (
                            f"Cost limit reached: {self.subtree_cost_cents:.1f}c >= "
                            f"{self.price_limit_cents}c (own {self.own_cost_cents:.1f}c + "
                            f"children {sum(self.children_cost_cents.values()):.1f}c)"
                        ),
                        self.token_count,
                        self.context_size,
                        self.message_count,
                        self.tokens_in,
                        self.tokens_out,
                        None,
                        self.iteration_offset,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            except Exception as e:
                workflow.logger.error(f"Failed to update status to COST_LIMIT_REACHED: {e}")

            # Send SMS notification for cost_limit (root + SMS-source only)
            if self.agent_source == "SMS":
                try:
                    notification_args = [
                        self.user_id,
                        "cost_limit",
                        self.agent_id,
                        {
                            "tree_cost_cents": int(self.subtree_cost_cents),
                            "price_limit_cents": self.price_limit_cents,
                        },
                    ]
                    if self.world_model_mode != "real":
                        notification_args.append(self.world_model_mode)
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=notification_args,
                        **wmh_activity_timeout_options(
                            self.world_model_mode, timedelta(seconds=SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS)
                        ),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    workflow.logger.info("Sent cost_limit SMS notification")
                except Exception as e:
                    workflow.logger.warning(f"Failed to send cost_limit SMS notification: {e}")

            # Cascade to children (pull-based checks cover spawn race conditions)
            for child_wf_id in self._get_pending_child_workflow_ids():
                try:
                    handle = workflow.get_external_workflow_handle(child_wf_id)
                    await handle.signal("cost_limit_reached")
                except Exception as e:
                    workflow.logger.warning(f"Failed to cascade cost_limit_reached to child: {e}")

    async def _persist_tree_cost(self) -> None:
        """Persist subtree cost and own cost to DB."""
        from helpers.update_tokens import update_agent_tree_cost_activity

        try:
            await workflow.execute_activity(
                update_agent_tree_cost_activity,
                args=[self.agent_id, int(self.subtree_cost_cents), self.own_cost_cents],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to persist tree cost: {e}")

    async def _update_tree_state(
        self,
        progress: float = None,
        status: str = None,
        structured_output: Dict = None,
        failure_context: Dict = None,
    ) -> None:
        """
        Broadcast tree state update to the bus channel and persist to DB.

        Only broadcasts if this agent has a bus_id (i.e., is part of a sub-agent tree).
        Used for real-time sub-agent tree UI updates.
        """
        # In-flight activity-backed background tasks, persisted as
        # Agent.backgroundTasks so other agents' list_agents can see and
        # message them. A change is always written, even without a bus.
        # Only a write that carries a changed snapshot sends backgroundTasks, and
        # those writes are serialized (_background_tasks_write_lock) with the
        # snapshot taken inside the lock: the backend applies writes in arrival
        # order, so an older snapshot must never be in flight beside a newer one.
        background_changed = self._background_tree_snapshot() != getattr(self, "_persisted_background_tasks", [])
        if not self.bus_id:
            if status is not None:
                # No bus to broadcast on, but an explicit transition (e.g. paused
                # awaiting the user's auth help) must still reach the DB, exactly
                # as it does for a tree member; otherwise the root reads ACTIVE.
                async with self._background_tasks_write_lock:
                    payload: Dict[str, Any] = {"status": status, "_statusExplicit": True}
                    background_tasks = self._background_tree_snapshot()
                    carries_background = background_tasks != getattr(self, "_persisted_background_tasks", [])
                    if carries_background:
                        payload["backgroundTasks"] = background_tasks
                    if await self._send_tree_state(list(self.tools_in_use), payload) and carries_background:
                        self._persisted_background_tasks = background_tasks
                return
            if background_changed:
                await self._persist_background_tasks()
            return

        # Per-message broadcasts from 50 parallel children melt the 10s tree
        # activity. Keep status transitions and the first message (so FE can
        # leave "spinning up...") immediate; coalesce the rest.
        explicit_status = status is not None
        now = workflow.now()
        if (
            not explicit_status
            and not background_changed
            and self.message_count != 1
            and is_oai_demo_mass_agent_task(self)
            and self._last_tree_state_emit_at is not None
            and (now - self._last_tree_state_emit_at) < _TREE_STATE_EMIT_MIN_INTERVAL
        ):
            return
        self._last_tree_state_emit_at = now

        tools_list = list(self.tools_in_use)

        # Build broadcast payload
        # Compute default status from flags, but mark whether it was explicit
        if self._cost_limit_reached:
            default_status = "COST_LIMIT_REACHED"
        elif not self._has_credits:
            default_status = "OUT_OF_CREDITS"
        elif self.is_paused:
            default_status = "PAUSED"
        else:
            default_status = "ACTIVE"

        broadcast_payload = {
            "agentId": self.agent_id,
            "parentAgentId": self.parent_agent_id,
            "goal": self.goal,
            "status": status or default_status,
            "progress": progress if progress is not None else 0.0,
            "toolsInUse": tools_list,
            "messageCount": self.message_count,
            "costCents": int(self.subtree_cost_cents),
            # Track if status was explicitly set (for DB persistence decision)
            "_statusExplicit": status is not None,
            # Codex-style address ("/root/venue_capacities_0") once known.
            "taskPath": getattr(self, "_own_task_path", None) or ("/root" if not self.depth else None),
        }

        # Always include output schema (available from spawn, cached in instance)
        if self.output_schema:
            broadcast_payload["outputSchema"] = self.output_schema

        # Include structured output (actual values) only for completed agents
        if structured_output:
            broadcast_payload["structuredOutput"] = structured_output

        # Include failure context for failed agents
        if failure_context:
            broadcast_payload["failureContext"] = failure_context

        # Execute activity that does both broadcast AND DB persist
        # (broadcast must be in activity to avoid workflow sandbox httpx issues)
        if not background_changed:
            await self._send_tree_state(tools_list, broadcast_payload)
            return
        async with self._background_tasks_write_lock:
            background_tasks = self._background_tree_snapshot()
            if background_tasks == getattr(self, "_persisted_background_tasks", []):
                # The write ahead of this one already carried this snapshot.
                await self._send_tree_state(tools_list, broadcast_payload)
                return
            broadcast_payload["backgroundTasks"] = background_tasks
            if await self._send_tree_state(tools_list, broadcast_payload):
                self._persisted_background_tasks = background_tasks

    async def _send_tree_state(self, tools_list: List[str], broadcast_payload: Dict[str, Any]) -> bool:
        try:
            await workflow.execute_activity(
                update_agent_tree_state,
                args=[self.agent_id, tools_list, self.bus_id, broadcast_payload],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            return True
        except Exception as e:
            workflow.logger.debug(f"Tree state update failed (non-fatal): {e}")
            return False

    def _background_tree_snapshot(self) -> List[Dict[str, Any]]:
        return background_tree_entries(
            getattr(self, "_background_tasks", {}),
            CHILD_WORKFLOW_AGENT_TYPES,
            getattr(self, "_background_finished", {}),
        )

    async def _persist_background_tasks(self) -> None:
        """Bus-less agents (a root before its first spawn) still persist their in-flight tasks.

        Serialized with every other backgroundTasks write; the snapshot is read
        inside the lock, so writes reach the backend in snapshot order.
        """
        async with self._background_tasks_write_lock:
            background_tasks = self._background_tree_snapshot()
            if background_tasks == getattr(self, "_persisted_background_tasks", []):
                return
            try:
                await workflow.execute_activity(
                    update_agent_tree_state,
                    args=[self.agent_id, list(self.tools_in_use), None, {"backgroundTasks": background_tasks}],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                self._persisted_background_tasks = background_tasks
            except Exception as e:
                workflow.logger.debug(f"Background task persistence failed (non-fatal): {e}")

    async def _handle_incomplete(self, result: Dict, phase: str) -> Dict:
        """Handle non-completed phase result."""
        workflow.logger.info(f"{phase} ended: {result['status']}")

        if result["status"] == "paused":
            handoff_queue = await self._wait_for_unpause_or_handoff()
            # Preserve feedback received while paused before continue-as-new
            # resets this workflow instance's revision counters.
            await self._prepare_response_schema_continuation()
            # Skip PLAN and DAG, and carry the complete mutable runtime snapshot.
            await self._drain_fast_mode_explores()
            await self._flush_pending_messages()
            if handoff_queue:
                workflow.continue_as_new(
                    args=self._continuation_args(result.get("context")),
                    task_queue=handoff_queue.strip(),
                )
            else:
                workflow.continue_as_new(args=self._continuation_args(result.get("context")))
            return result

        if result["status"] == "generation_handoff":
            # Cooperative cutover: current tools/LLM finished; move to the live
            # generation queue before the next LLM call. Do NOT terminate.
            # Cancelled sibling approval waits never enter GenerationHandoffRequested,
            # so re-arm every still-open approval chip from the transcript.
            stash_pending_approvals_from_context(self)
            handoff_queue = result.get("handoff_task_queue")
            if not isinstance(handoff_queue, str) or not handoff_queue.strip():
                workflow.logger.error("generation_handoff missing handoff_task_queue; failing open")
                return result
            await self._prepare_response_schema_continuation()
            # In-flight background browser/code tasks park at their next step
            # (GENERATION_SUPERSEDED); without this wait they restart from scratch.
            await self._settle_background_tasks_for_continuation(
                "generation handoff", CONTINUATION_BACKGROUND_SETTLE_SECONDS
            )
            await self._drain_fast_mode_explores()
            await self._flush_pending_messages()
            workflow.logger.info(f"continue_as_new onto generation queue {handoff_queue} (cooperative cutover)")
            workflow.continue_as_new(
                args=self._continuation_args(
                    result.get("context"),
                    start_phase="plan" if phase == "PLAN" else "execute_continued",
                ),
                task_queue=handoff_queue.strip(),
            )
            return result

        if result["status"] == "aborted":
            # Orphaned (parent workflow gone), killed by kill_agent, or otherwise
            # terminally aborted. Finalize as failed immediately — do NOT
            # wait_condition or continue_as_new.
            abort_reason, abort_message = self._abort_reason()
            await self._mark_failed(
                context=result.get("context", []),
                reason=abort_reason,
                message=abort_message,
                verifier_progress=result.get("verifier_progress", 0.0),
                # The failed row's reason (SubAgentTree "Why not complete") is the abort.
                verifier_reasoning=abort_message,
                partial_structured_response=result.get("partial_structured_response"),
            )
            return {"status": "failed", "reason": abort_reason, "goal": self.goal}

        if result["status"] == "max_iterations":
            completion_revision = self._response_schema_revision
            if bool(getattr(self, "fast_mode_cache_enabled", False)) and is_oai_demo_mass_agent_task(self):
                await self._await_deferred_startup()
                await self._drain_fast_mode_explores()
            await self._prepare_response_schema_continuation()
            if completion_revision != self._response_schema_revision or _verifier_superseded_by_user_feedback(
                result,
                self.context,
                requirement_revision=self._response_schema_revision,
            ):
                result["verifier_superseded_by_user_feedback"] = True
            verifier_progress = float(result.get("verifier_progress", 0.0) or 0.0)
            verifier_reasoning = str(result.get("verifier_reasoning") or "")
            fm_trajectory_complete = (
                bool(getattr(self, "fast_mode_cache_enabled", False))
                and self._response_schema_accepted_revision >= self._response_schema_revision
                and not result.get("verifier_superseded_by_user_feedback")
                and is_oai_demo_mass_agent_task(self)
                and (verifier_progress >= 1.0 or "fast mode cache trajectory ended" in verifier_reasoning.lower())
            )
            if fm_trajectory_complete:
                self._require_current_response_schema_acceptance()
                # Fast Mode replay hit the step cap after the verifier already
                # accepted the cached work (100% / trajectory-end). Mark
                # COMPLETED so the parent for_each does not ERROR the child.
                await self._mark_complete(
                    result.get("context", []),
                    result.get("partial_structured_response") or result.get("structured_response"),
                )
                return {"status": "completed", "goal": self.goal}
            await self._mark_failed(
                context=result.get("context", []),
                reason="max_iterations",
                message="Max Steps Reached",
                verifier_progress=verifier_progress,
                verifier_reasoning=verifier_reasoning,
                partial_structured_response=result.get("partial_structured_response"),
            )
            return {"status": "failed", "reason": "max_iterations", "goal": self.goal}

        if result["status"] == "error":
            await self._mark_failed(
                context=result.get("context", []),
                reason="error",
                message=result.get("message", "Unknown error"),
                verifier_progress=result.get("verifier_progress", 0.0),
                verifier_reasoning=result.get("verifier_reasoning", ""),
                partial_structured_response=result.get("partial_structured_response"),
            )
            return {"status": "failed", "reason": "error", "goal": self.goal}

        # Fallback for unknown statuses
        return result

    def _extract_failure_context(
        self,
        context: List[Dict],
        verifier_progress: float = 0.0,
        verifier_reasoning: str = "",
        partial_structured_response: Optional[Dict] = None,
    ) -> Dict:
        """Extract comprehensive failure context for parent agent learning.

        Returns dict with:
        - trajectory: List of {tool_name, success, error_message}
        - last_reasoning: Last ASSISTANT message (what agent was thinking)
        - last_plan: Plan from set_plan if exists
        - progress_estimate: Verifier-determined progress (0-100%)
        - verifier_reasoning: Why verifier thinks agent isn't done
        - partial_structured_response: Any partial structured data extracted
        - steps_taken: Number of tool calls made
        """
        trajectory = []
        seen_tool_calls = set()
        last_reasoning = None
        last_plan = None

        for msg in context:
            role = msg.get("role")
            metadata = msg.get("metadata") or {}

            # Extract last assistant reasoning
            if role == "ASSISTANT":
                text = msg.get("text", "")
                if text and not metadata.get("reasoning"):  # Skip pure reasoning blocks
                    last_reasoning = text[:500]  # Truncate to 500 chars

            # Extract plan from set_plan tool
            if role == "TOOL":
                tool_name = metadata.get("toolName")
                tool_status = metadata.get("toolStatus")

                if tool_name == "set_plan" and tool_status == "FINISHED":
                    plan_data = metadata.get("data", {})
                    tasks = plan_data.get("tasks", [])
                    if tasks:
                        # Extract task goals as plan summary
                        plan_goals = []
                        for task in tasks[:5]:  # Limit to 5 tasks
                            if isinstance(task, dict):
                                plan_goals.append(task.get("goal", str(task))[:100])
                            else:
                                plan_goals.append(str(task)[:100])
                        last_plan = plan_goals

                # Build trajectory (skip internal tools).
                # Verifier feedback is now tagged toolName="attempt_completion" with
                # metadata.verifierMessage=True; skip those rows so the trajectory
                # only contains real tool calls, not scoring messages.
                if metadata.get("verifierMessage"):
                    continue
                if not tool_name or tool_name in {"completion_summary", "set_plan"}:
                    continue

                tool_call_id = metadata.get("toolCallId")
                if tool_call_id and tool_call_id in seen_tool_calls:
                    continue
                if tool_call_id:
                    seen_tool_calls.add(tool_call_id)

                if tool_status not in {"FINISHED", "ERROR"}:
                    continue

                is_error = metadata.get("error", False) or tool_status == "ERROR"
                error_message = msg.get("text", "") if is_error else None

                trajectory.append(
                    {
                        "tool_name": tool_name,
                        "success": not is_error,
                        "error_message": error_message[:200] if error_message else None,
                    }
                )

        # Use verifier progress if available, fallback to step-based estimate
        steps_taken = len(trajectory)
        if verifier_progress > 0:
            progress_estimate = f"{verifier_progress * 100:.0f}%"
        else:
            successful_steps = sum(1 for t in trajectory if t["success"])
            progress_estimate = (
                f"{successful_steps}/{steps_taken} steps succeeded" if steps_taken > 0 else "No steps completed"
            )

        return {
            "trajectory": trajectory,
            "last_reasoning": last_reasoning,
            "last_plan": last_plan,
            "progress_estimate": progress_estimate,
            "verifier_reasoning": verifier_reasoning,
            "partial_structured_response": partial_structured_response,
            "steps_taken": steps_taken,
        }

    async def _register_on_world_clock(self) -> None:
        """Simulate mode: register on the world clock, retrying a missing world a bounded number of times."""
        for attempt in range(WORLD_CLOCK_REGISTER_ATTEMPTS):
            if attempt:
                # cutover-class: bounded — at most two 2s pauses before the agent fails closed
                await workflow.sleep(timedelta(seconds=WORLD_CLOCK_REGISTER_RETRY_SECONDS))
            await self._world_clock_event("register")
            if self.world_model_mode != "simulate" or "register" in self._world_clock_events:
                return

    async def _recover_world_time_cursor(self) -> None:
        """Simulate mode: a resumed agent whose continuation state lacks a cursor re-reads its world time.

        State persisted before the cursor existed has none, and without it the
        resumed agent would plan on the real date. Outside simulate mode, or
        with a persisted cursor, nothing runs.
        """
        if self.world_model_mode != "simulate" or type(self.simulated_world_time_ms) is int:
            return
        time_ms = await _read_world_time_ms(self)
        if time_ms is None:
            workflow.logger.error(f"[world_clock] Resumed agent {self.agent_id} could not recover its world time")
            return
        self.simulated_world_time_ms = time_ms
        self.simulated_clock_offset_seconds = time_ms // 1000 - int(workflow.now().timestamp())

    def _world_clock_missing(self) -> bool:
        """True when a simulated agent has no acknowledged world time to start from."""
        return (
            self.world_model_mode == "simulate"
            and not self._deployment_resume
            and type(getattr(self, "simulated_world_time_ms", None)) is not int
        )

    async def _world_clock_event(self, operation: str) -> None:
        """Simulate mode: register or finish this agent on its world's shared clock.

        Children start at their parent's world time; a finished child lets its
        parent resume at the children's latest finish, so finish precedes the
        parent signal. Best effort: an unavailable clock leaves the run intact.
        """
        if self.world_model_mode != "simulate" or operation in self._world_clock_events:
            return
        pending = getattr(self, "_world_clock_pending_events", None)
        if pending is None:
            pending = self._world_clock_pending_events = {}
        if operation in pending:
            await pending[operation].wait()
            return
        completed = asyncio.Event()
        pending[operation] = completed
        result = None
        try:
            with contextlib.suppress(Exception):
                result = await workflow.execute_activity(
                    world_clock_activity,
                    args=[operation, self.agent_id, self.parent_agent_id if operation == "register" else None],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
        finally:
            pending.pop(operation, None)
            completed.set()
        if isinstance(result, dict) and type(result.get("time_ms")) is int:
            self._world_clock_events.add(operation)
        if operation == "register" and isinstance(result, dict) and type(result.get("time_ms")) is int:
            # This agent's "now" is its world-time cursor from its first step: a
            # child starts at its parent's world time and the world starts at
            # its pinned scenario date, not today's date.
            self.simulated_clock_offset_seconds = result["time_ms"] // 1000 - int(workflow.now().timestamp())
            self.simulated_world_time_ms = result["time_ms"]

    async def _mark_failed(
        self,
        context: List[Dict],
        reason: str,
        message: str,
        verifier_progress: float = 0.0,
        verifier_reasoning: str = "",
        partial_structured_response: Optional[Dict] = None,
    ) -> None:
        """Mark task as failed and signal parent.

        Order:
        1. Post FINISHED message with error → FE shows failure in CompletionSummaryCard
        2. Update tree state (broadcast FAILED) with failure_context
        3. Update DB status to FAILED
        4. Signal parent with failure context for learning (if sub-agent)
        """
        workflow.logger.warning(f"❌ Marking task failed: {reason} - {message}")
        # Leftover-safe drain (no-op when Fast Mode waited like live).
        await self._drain_fast_mode_explores()
        # Latch the terminal flag FIRST — see _mark_complete for the regression
        # this prevents (status=ACTIVE clobbering FAILED on late child cost signals).
        self._is_finished = True
        # No background agent keeps running (or billing) after its parent ends.
        await self._stop_pending_background_agents()
        await self._world_clock_event("finish")
        await self._flush_pending_messages()

        # Force a final tree-cost persist so the debounced emitter's last (≤3s
        # stale) value is corrected to the exact terminal cost. Recalc first; do
        # NOT route through _update_cost_and_signal_parent (its cost-limit check
        # could clobber the terminal status).
        self.subtree_cost_cents = self.own_cost_cents + sum(self.children_cost_cents.values())
        await self._persist_tree_cost()

        tool_call_id = str(workflow.uuid4())

        # Extract comprehensive failure context for parent learning
        failure_context = self._extract_failure_context(
            context,
            verifier_progress=verifier_progress,
            verifier_reasoning=verifier_reasoning,
            partial_structured_response=partial_structured_response,
        )

        # Calculate duration
        duration_seconds = 0
        if self.start_time:
            duration_seconds = int((workflow.now() - self.start_time).total_seconds())

        try:
            # 1. Post FINISHED message with error details
            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "toolName": "completion_summary",
                    "toolStatus": "ERROR",
                    "isFinalSummary": True,
                    "title": f"❌ {message}",
                    "completionSummary": {
                        "summary": f"Agent failed: {message}",
                        "outputs": [],
                        "toolUsage": [],
                        "totalToolCalls": failure_context["steps_taken"],
                        "durationSeconds": duration_seconds,
                        "costDollars": 0,
                        "error": True,
                        "errorReason": reason,
                    },
                },
            )

            # 2. Broadcast FAILED status to tree with failure context
            await self._update_tree_state(progress=1.0, status="FAILED", failure_context=failure_context)

            # 3. Update DB status to FAILED
            await workflow.execute_activity(
                update_agent_status,
                args=[
                    self.agent_id,
                    "FAILED",
                    1.0,
                    message,
                    self.token_count,
                    self.context_size,
                    len(context),
                    self.tokens_in,
                    self.tokens_out,
                    partial_structured_response,
                    self.iteration_offset,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        except Exception as e:
            workflow.logger.error(f"Failed to mark failed: {e}")

        # 3b. Record the failure in the worker log — root agents only. Sub-agent
        # failures are frequently recovered by the parent; a sub-failure that
        # breaks the run propagates to the root's _mark_failed. The bug report
        # itself comes from the backend's 24h stuck-agent job, which covers every
        # run that is not COMPLETED. The activity never raises.
        if not self.parent_workflow_id:
            try:
                await workflow.execute_activity(
                    report_failure_activity,
                    args=[
                        self.agent_id,
                        "agent_workflow",
                        message,
                        {
                            "reason": reason,
                            "steps_taken": failure_context.get("steps_taken"),
                            "verifier_reasoning": verifier_reasoning,
                        },
                    ],
                    start_to_close_timeout=timedelta(seconds=20),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"report_failure_activity dispatch failed (non-fatal): {e}")

        # 4. Signal parent with failure context for learning (orphans stay
        # silent; a killed agent reports its failure like any other).
        if self.parent_workflow_id and self._reports_finish_to_parent():
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal(
                    "child_completed",
                    {
                        "child_agent_id": self.agent_id,
                        "result": {
                            "status": "failed",
                            "goal": self.goal,
                            "summary": f"Failed: {message}",
                            "error_reason": reason,
                            "failure_context": failure_context,  # Full context for parent learning
                            "structured_response": partial_structured_response,
                            "tool_counts": {},
                        },
                    },
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent: {e}")

    async def _completion_transcript(self, context: List[Dict]) -> List[Dict]:
        """Durable posted transcript, including assemble/explore rows posted after context snapshot."""
        try:
            polled = await workflow.execute_activity(
                poll_new_messages,
                args=[self.agent_id, datetime.fromtimestamp(0, tz=timezone.utc), True],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:
            workflow.logger.warning(f"completion transcript poll failed: {exc}")
            polled = None
        return _merge_completion_transcripts(
            polled if isinstance(polled, list) else None,
            list(context or []),
        )

    def _coalesce_structured_response(self, context: List[Dict], structured_response: Optional[Dict]) -> Optional[Dict]:
        """Fill missing schema fields from `# field_name` sections in the transcript.

        Fast Mode assemble-final (and other dag_reasoning slots) often persist the
        deliverable as markdown headings that match the output schema, while the
        verifier `output` dict stays empty because schema gen missed. Without this
        merge, Task Complete has a summary but no Output section.
        """
        return structured_response_from_evidence(context, self.output_schema, structured_response)

    def _format_outputs(self, structured_response: Optional[Dict]) -> List[Dict]:
        """Convert structured_response → CompletionSummaryCard outputs format."""
        if not structured_response:
            return []

        fields = (self.output_schema or {}).get("fields", []) if isinstance(self.output_schema, dict) else []
        outputs = []

        for field in fields:
            field_name = field.get("name")
            if field_name and field_name in structured_response:
                outputs.append(
                    {
                        "key": field_name,
                        "label": field.get("description") or field_name.replace("_", " ").title(),
                        "value": structured_response[field_name],
                    }
                )

        if outputs:
            return outputs

        for field_name, value in structured_response.items():
            if not isinstance(field_name, str) or not field_name or field_name.startswith("_"):
                continue
            outputs.append(
                {
                    "key": field_name,
                    "label": field_name.replace("_", " ").title(),
                    "value": value,
                }
            )
        return outputs

    async def _mark_complete(self, context: List[Dict], structured_response: Optional[Dict] = None) -> None:
        """Mark task complete and signal parent.

        Order:
        1. Post IN_PROGRESS message → FE shows loading state
        2. Generate completion summary (LLM call)
        3. Post FINISHED message with isFinalSummary → FE renders CompletionSummaryCard
        4. Mark finished in DB
        5. Update tree state (broadcast COMPLETED)
        6. Signal parent (if sub-agent)
        7. Save blueprint (fire-and-forget, no UI)
        """
        await self._await_deferred_startup()
        self._require_current_response_schema_acceptance()
        workflow.logger.info("✓ Marking task complete")
        # Leftover-safe drain (no-op when Fast Mode waited like live).
        await self._drain_fast_mode_explores()
        # Latch the terminal flag FIRST so any late child_cost_update signal
        # (which calls _update_cost_and_signal_parent → broadcast) cannot
        # overwrite the COMPLETED status with ACTIVE/Processing.
        self._is_finished = True
        # No background agent keeps running (or billing) after its parent ends.
        await self._stop_pending_background_agents()
        await self._world_clock_event("finish")
        await self._flush_pending_messages()

        # Force a final tree-cost persist so the debounced emitter's last (≤3s
        # stale) value is corrected to the exact terminal cost. Recalc first, then
        # persist DIRECTLY — never via _update_cost_and_signal_parent. That path
        # stamps `_last_tree_cost_emit_at`, which would then debounce away the
        # persist triggered by the completion summary's own `_track_llm_cost`
        # below, silently under-reporting the run to the agent row, the FE cost
        # display, and the benchmark's `cost_cents`. Letting a verified agent
        # resolve must never make its spend disappear. Cemented by
        # wf_mark_complete_persists_summary_cost.
        self.subtree_cost_cents = self.own_cost_cents + sum(self.children_cost_cents.values())
        await self._persist_tree_cost()

        # Poll for output_schema if missing (handles race condition with async schema generation)
        await self._load_output_schema(poll_until_present=True)

        tool_counts = {}
        summary = ""
        summary_error: Optional[str] = None
        tool_call_id = str(workflow.uuid4())

        try:
            # Post IN_PROGRESS message for FE loading state
            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "toolName": "completion_summary",
                    "toolStatus": "IN_PROGRESS",
                    "title": "Generating summary",
                },
            )

            # Generate summary - pass structured_response, output_schema, and child_tool_counts.
            # The summary is presentation, not part of the completion contract:
            # the verifier already scored this run complete. A failure here is
            # surfaced (logged + carried on the final message) but must never
            # abort the durable terminal transition below, otherwise a
            # fully-verified agent is discarded — see
            # docs/rca/cases/2026-07-11-completion-gated-behind-final-summary-message-post.md
            try:
                summary_result = await workflow.execute_activity(
                    generate_completion_summary,
                    args=[
                        context,
                        # Persisted-row goal: the summary prompt labels this "ORIGINAL
                        # GOAL" and it doubles as the DEMO cache namespace.
                        self.demo_cache_goal,
                        self.model,
                        structured_response,
                        self.output_schema,
                        self.child_tool_counts,
                        self._active_claude_token(),
                        self._active_claude_source(),
                        self._active_claude_pool_id(),
                        self.user_id,
                        self._active_gpt_token(),
                        self._active_gpt_account_id(),
                        self._active_gpt_source(),
                        self._active_gpt_pool_id(),
                        self.user_id,
                        self.agent_id,
                        self.compute_token_lineage_key,
                        self.compute_token_demo_cache_affinity_key,
                        self.fast_mode_cache_enabled,
                        0,  # Fast Mode step — one completion summary per agent
                    ],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                summary_result = summary_result or {}
            except Exception as summary_exc:
                summary_error = str(summary_exc)
                summary_result = {}
                workflow.logger.error(f"completion_summary generation failed, completing without it: {summary_error}")

            summary = strip_fast_mode_card_narration(summary_result.get("summary", ""))
            transcript = await self._completion_transcript(context)
            structured_response = self._coalesce_structured_response(transcript, structured_response)
            summary_is_invalid = is_ablated_completion_summary(summary)
            needs_demo_detail = is_oai_demo_mass_agent_task(self) and len(str(summary or "").strip()) < 200
            if summary_is_invalid or needs_demo_detail:
                recovered = strip_fast_mode_card_narration(card_summary_from_evidence(transcript, structured_response))
                if (
                    recovered
                    and not is_ablated_completion_summary(recovered)
                    and (not needs_demo_detail or len(recovered) >= 200)
                ):
                    summary = recovered
            # This is the final, general publication boundary.  Never persist
            # tool I/O or a cache sentinel as the Task Complete narration, even
            # when no suitable report exists in the transcript.
            summary = strip_fast_mode_card_narration(summary)
            if is_ablated_completion_summary(summary):
                summary = f"Completed: {self.goal}" if self.goal else "Completed."
            if (
                is_oai_demo_mass_agent_task(self)
                and not self.parent_workflow_id
                and isinstance(structured_response, dict)
            ):
                try:
                    materialized = await workflow.execute_activity(
                        materialize_oai_demo_report_files_activity,
                        args=[self.user_id, structured_response, self.output_schema, self.agent_id],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                    if isinstance(materialized, dict):
                        next_response = materialized.get("structured_response")
                        if isinstance(next_response, dict):
                            structured_response = next_response
                        next_schema = materialized.get("output_schema")
                        if isinstance(next_schema, dict):
                            self.output_schema = next_schema
                except Exception as report_exc:
                    workflow.logger.error(
                        f"oai demo report file materialization failed, keeping original outputs: {report_exc}"
                    )

            if not summary and summary_error:
                # Two consumers treat an empty summary as "nothing happened":
                # the root completion SMS is gated on `summary` being truthy,
                # and the parent's child_completed handler falls back to a goal
                # restatement. Restate the goal here — the same shape
                # helpers/child_results.py:_best_effort_text already uses — so
                # the degradation is a missing narration, never a lost
                # notification. No findings are invented; the verified outputs
                # ride along in completionSummary.outputs / structured_response.
                summary = f"Completed: {self.goal}" if self.goal else "Completed."
            tool_counts = summary_result.get("tool_counts", {})
            # Track completion summary LLM cost (doesn't go through run_agent)
            await self._track_llm_cost(
                summary_result.get("usage", {}).get("prompt_tokens", 0),
                summary_result.get("usage", {}).get("completion_tokens", 0),
                call_site="completion_summary",
                actual_model=summary_result.get("usage", {}).get("actual_model"),
                cache_read_input_tokens=summary_result.get("usage", {}).get("cache_read_input_tokens", 0),
                cache_creation_input_tokens=summary_result.get("usage", {}).get("cache_creation_input_tokens", 0),
                from_fast_cache=summary_result.get("usage", {}).get("from_fast_cache", False),
            )
            self.token_count += summary_result.get("usage", {}).get("total_tokens", 0)

            # Build tool usage array for frontend
            tool_usage = [{"name": k, "count": v} for k, v in tool_counts.items()] if tool_counts else []
            total_tool_calls = sum(tool_counts.values()) if tool_counts else 0

            # Calculate duration
            duration_seconds = 0
            if self.start_time:
                duration_seconds = int((workflow.now() - self.start_time).total_seconds())

            # Calculate cost from token usage (approximate: $0.001/1k input, $0.003/1k output)
            cost_dollars = (self.tokens_in / 1000 * 0.001) + (self.tokens_out / 1000 * 0.003)

            # Post FINISHED message with completion summary (same toolCallId).
            # This intentionally happens before the durable terminal status:
            # pollers and benchmark evaluators treat COMPLETED as a safe point
            # to read the transcript, so terminal status must mean the final
            # summary is already observable.
            # Suppress the automatic tree broadcast here; otherwise _post_message
            # would emit its default ACTIVE state after we latched _is_finished.
            structured_response, summary = normalize_completion_notice(self.goal, structured_response, summary)
            formatted_outputs = self._format_outputs(structured_response)
            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "isFinalSummary": True,
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "title": "✅ Task Complete",
                    "completionSummary": {
                        "summary": summary,
                        "outputs": formatted_outputs,
                        "toolUsage": tool_usage,
                        "totalToolCalls": total_tool_calls,
                        "durationSeconds": duration_seconds,
                        "costDollars": round(cost_dollars, 4),
                        # Present only when the summary LLM call failed. The run
                        # still completes on its verified outputs; nothing is
                        # invented in its place, and the failure stays visible.
                        **({"summaryError": summary_error} if summary_error else {}),
                    },
                },
                update_tree=False,
            )

            # Mark finished (includes structured_response for persistence).
            # mark_finished only reads the first USER text as the goal
            # (extract_goal_from_context). Forwarding the full conversation
            # put a 638092-byte payload on the activity command (TMPRL1103
            # warn 512KB) and left ed9a3b6e ACTIVE until the 900s smoke cap.
            # message_count still records the real transcript length.
            finished_steps = [{"role": "USER", "text": self.goal or "No goal specified"}]
            await workflow.execute_activity(
                mark_finished,
                args=[
                    self.agent_id,
                    finished_steps,
                    self.token_count,
                    self.context_size,
                    len(context),
                    self.tokens_in,
                    self.tokens_out,
                    summary if self.parent_workflow_id else "",
                    structured_response,
                    self.iteration_offset,
                    self.root_agent_id or self.agent_id,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            # Broadcast COMPLETED status with structured output to tree
            # (output_schema is already cached from startup and included in all broadcasts)
            await self._update_tree_state(progress=1.0, status="COMPLETED", structured_output=structured_response)

            # Completion lifecycle SMS is root-only. Sub-agents report to their
            # parent; notifying per child would fan out at tree scale.
            if not self.parent_workflow_id and summary:
                try:
                    notification_args = [
                        self.user_id,
                        "completion",
                        self.agent_id,
                        {"summary": summary, "outputs": formatted_outputs},
                    ]
                    if self.world_model_mode != "real":
                        notification_args.append(self.world_model_mode)
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=notification_args,
                        **wmh_activity_timeout_options(
                            self.world_model_mode, timedelta(seconds=SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS)
                        ),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    workflow.logger.info(f"Sent completion SMS notification: agent={self.agent_id}")
                except Exception as sms_error:
                    # Log but don't fail completion if SMS fails
                    workflow.logger.warning(f"Failed to send completion SMS notification: {sms_error}")

        except Exception as e:
            workflow.logger.error(f"Failed to mark complete: {e}")
            raise

        # Signal parent with tool_counts for aggregation
        if self.parent_workflow_id:
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal(
                    "child_completed",
                    {
                        "child_agent_id": self.agent_id,
                        "result": {
                            "status": "completed",
                            "goal": self.goal,
                            "summary": summary,
                            "structured_response": structured_response,
                            "tool_counts": tool_counts,
                        },
                    },
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent: {e}")

        # Save blueprint (fire-and-forget, no tool messages - just logs)
        # This is the last step so it doesn't block completion UX
        if False:
            try:
                await workflow.execute_activity(
                    save_blueprint_activity,
                    args=[self.user_id, context],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                workflow.logger.info("Blueprint saved successfully")
            except Exception as e:
                workflow.logger.warning(f"Blueprint save failed (non-fatal): {e}")

    @workflow.query
    def get_status(self) -> Dict:
        """Query current status."""
        return {
            "agent_id": self.agent_id,
            "goal": self.goal,
            "tokens": self.token_count,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "context_size": self.context_size,
            "message_count": self.message_count,
            "iteration_offset": self.iteration_offset,
            "workflow_started_at": self._serialized_datetime(self.start_time),
        }

    @workflow.query
    def is_paused_query(self) -> bool:
        """Query if workflow is paused."""
        return self.is_paused

    @workflow.query
    def is_cost_limit_reached_query(self) -> bool:
        """Query if cost limit has been reached."""
        return self._cost_limit_reached

    @workflow.query
    def parent_state_query(self) -> Dict:
        """Combined query for children to check parent's pause/cost-limit state."""
        return {
            "is_paused": self.is_paused,
            "is_cost_limit_reached": self._cost_limit_reached,
            "is_finished": self._is_finished,
            "user_pause_active": self.is_paused and self._user_pause_active,
        }

    @workflow.query
    def deployment_initialized_query(self) -> bool:
        """True only after candidate common initialization and credit preflight."""
        return self._deployment_initialized
