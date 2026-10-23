"""Spawn-agent domain service: validation, parsing, and explore agent activity."""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity

from domains.grep.service import fit_grep_result_to_budget
from domains.spawn_agent.config import (
    EXPLORE_COMPLETION_DEFERRED_FOR_MESSAGE,
    EXPLORE_MESSAGE_TRUNCATE_LEN,
    EXPLORE_WINDDOWN_WINDOW,
    explore_limits_for_depth,
    resolve_explore_depth,
    resolve_explore_oai_demo,
)
from domains.spawn_agent.repo import (
    _resolve_explore_attachments_activity as _resolve_explore_attachments_activity,
)
from domains.spawn_agent.repo import (
    fetch_explore_tool_evidence as fetch_explore_tool_evidence,
)
from domains.spawn_agent.repo import (
    fetch_full_network_metadata as fetch_full_network_metadata,
)
from domains.spawn_agent.repo import (
    save_explore_message,
)
from domains.spawn_agent.types import VALID_AGENT_TYPES
from helpers.activity_heartbeat import heartbeat_resume_details
from helpers.agent_addressing import task_name_error
from helpers.summarize import TOOL_RESULT_HARD_CAP_CHARS
from helpers.tracing import span, traced
from helpers.workflow_generation import WorkflowGenerationSealed
from tools.base import MessageStatus
from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT
from utils.tool_schemas import get_explore_agent_tools

logger = structlog.get_logger()

# Return gathered tool evidence just before the depth's activity timeout.
# Leave room to drain pending FE posts and persist the final explore chip.
LIVE_EXPLORE_DRAIN_SLACK_SECONDS = 15

COMMON_CSV_HEADER_NAMES = {
    "address",
    "city",
    "company",
    "contact",
    "country",
    "email",
    "first_name",
    "firstname",
    "last_name",
    "lastname",
    "linkedin",
    "name",
    "phone",
    "state",
    "title",
    "url",
    "website",
    "zip",
}

_TOOL_EVIDENCE_METADATA_KEYS = {
    "cost",
    "cost_cents",
    "elapsed",
    "elapsed_ms",
    "model",
    "provider",
    "provider_used",
    "query",
    "status",
    "success",
    "usage",
    "url",
}

EXPLORE_FALLBACK_PAYLOAD_BUDGET = 12_000
_EXPLORE_STUB_MARKERS = ("fast mode", "cached trajectory")
_DIRECT_FETCH_FAILURE = re.compile(
    r"^the (?:requested )?(?:url|page) https?://\S+ returned\b",
    re.IGNORECASE,
)


def _explore_tool_failure(tool_name: str, value: Any) -> str:
    """Recognize explicit tool failures without treating quoted 404s as failures."""
    if tool_name not in {"web_search", "web_fetch"}:
        return ""
    if tool_name == "web_fetch" and isinstance(value, str):
        content = value.strip()
        if _DIRECT_FETCH_FAILURE.match(content) and any(
            marker in content.lower() for marker in ("404", "page not found", "ページが見つかりません")
        ):
            return content
    if not isinstance(value, dict):
        return ""
    if value.get("success") is False or value.get("ok") is False:
        return str(value.get("error") or value.get("message") or "Tool failed.")
    status = value.get("status") or value.get("status_code") or value.get("http_status")
    if isinstance(status, int) and status >= 400:
        return str(value.get("error") or value.get("content") or f"HTTP {status}")
    if str(status).lower() in {"error", "failed", "failure"} or value.get("error"):
        return str(value.get("error") or value.get("message") or "Tool failed.")
    if tool_name == "web_fetch":
        content = str(value.get("content") or "").strip()
        if _DIRECT_FETCH_FAILURE.match(content) and any(
            marker in content.lower() for marker in ("404", "page not found", "ページが見つかりません")
        ):
            return content
    return ""


def _render_explore_tool_result(tool_name: str, value: Any) -> str:
    """Expose search/fetch content and URLs as readable text instead of JSON."""
    if tool_name in {"web_search", "web_fetch"} and isinstance(value, dict):
        body = value.get("answer") if tool_name == "web_search" else value.get("content")
        if isinstance(body, str):
            urls: List[str] = []
            if isinstance(value.get("url"), str):
                urls.append(value["url"])
            sources = value.get("sources")
            if isinstance(sources, list):
                urls.extend(source for source in sources if isinstance(source, str))
            unique_urls = list(dict.fromkeys(urls))
            source_text = "\n".join(f"Source: {url}" for url in unique_urls)
            primary_field = "answer" if tool_name == "web_search" else "content"
            details = {key: item for key, item in value.items() if key not in {primary_field, "url", "sources"}}
            if isinstance(sources, list) and any(not isinstance(source, str) for source in sources):
                details["sources"] = [source for source in sources if not isinstance(source, str)]
            elif sources is not None and not isinstance(sources, list):
                details["sources"] = sources
            if value.get("url") is not None and not isinstance(value.get("url"), str):
                details["url"] = value["url"]
            detail_text = json.dumps(details, ensure_ascii=False, default=str) if details else ""
            return "\n\n".join(part for part in (source_text, body.strip(), detail_text) if part)
    if isinstance(value, str) and tool_name in {"web_search", "web_fetch", "inspect_code", "list_agents"}:
        return value

    def render(item: Any) -> str:
        return json.dumps(item, ensure_ascii=tool_name not in {"web_search", "web_fetch"}, default=str)

    if tool_name == "grep" and isinstance(value, dict):
        value = fit_grep_result_to_budget(value, TOOL_RESULT_HARD_CAP_CHARS, render)
    return render(value)


def _fallback_trace_text(item: Any) -> str:
    """Normalize legacy JSON trace entries as well as new readable entries."""
    raw = str(item or "").strip()
    if not raw:
        return ""
    match = re.match(r"^\[([^\]]+)\]\s*(.*)$", raw, re.DOTALL)
    if match and match.group(1) in {"web_search", "web_fetch"}:
        tool_name, payload = match.groups()
        try:
            value = json.loads(payload)
        except (TypeError, ValueError):
            value = None
        if value is not None:
            if _explore_tool_failure(tool_name, value):
                return ""
            return f"[{tool_name}] {_render_explore_tool_result(tool_name, value)}"
        if tool_name == "web_fetch":
            body = payload.split("**Result:**", 1)[-1].strip()
            if _explore_tool_failure(tool_name, body):
                return ""
    marker = "**Result:**"
    if raw.startswith(("**Params Passed:**", marker)) and marker in raw:
        raw = raw.split(marker, 1)[1].strip()
    return raw


def _bounded_explore_parts(parts: List[str], budget: int) -> str:
    """Share the payload budget across results so late evidence stays visible."""
    if not parts or budget <= 0:
        return ""
    separator = "\n\n"
    separator_cost = len(separator) * (len(parts) - 1)
    if separator_cost >= budget:
        return parts[-1][:budget]
    available = budget - separator_cost
    lo, hi = 0, max(len(part) for part in parts)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if sum(min(len(part), mid) for part in parts) <= available:
            lo = mid
        else:
            hi = mid - 1
    cap = lo
    marker = "\n[...truncated...]\n"
    excerpts: List[str] = []
    for part in parts:
        if len(part) <= cap:
            excerpts.append(part)
        elif cap > len(marker) + 2:
            head = (cap - len(marker)) // 2
            tail = cap - len(marker) - head
            excerpts.append(part[:head] + marker + part[-tail:])
        else:
            excerpts.append(part[:cap])
    return separator.join(excerpts)


def compile_explore_wrap_up(
    final_response: Any = "",
    tool_call_results: Optional[List[Any]] = None,
    *,
    budget: int = EXPLORE_FALLBACK_PAYLOAD_BUDGET,
) -> str:
    """Build the user-facing explore chip from a completion or tool evidence.

    Soft-complete plumbing ("Fast Mode cache trajectory ended...") is treated
    as empty so the parent chip gets synthesized research, not Thinking... /
    Research started. Used by the explore activity return path and by Fast
    Mode drain when the activity times out after tools already ran.
    """
    text = str(final_response or "").strip()
    lowered = text.lower()
    if text and any(marker in lowered for marker in _EXPLORE_STUB_MARKERS) and len(text) < 400:
        text = ""
    if text:
        return text
    parts = [_fallback_trace_text(item) for item in tool_call_results or []]
    return _bounded_explore_parts([part for part in parts if part], budget)


def compile_explore_grep_evidence(tool_call_results: List[Any], *, budget: int = 6_000) -> str:
    """Keep bounded, original grep results beside an explore agent's summary."""
    grep_results = [str(item).strip() for item in tool_call_results if str(item).lstrip().startswith("[grep]")]
    return _bounded_explore_parts(list(dict.fromkeys(grep_results))[-3:], budget)


_SOURCE_GOAL_TERMS = {
    "email": ("email", "gmail"),
    "gmail": ("email", "gmail"),
    "imessage": ("imessage", "i message"),
    "whatsapp": ("whatsapp", "whats app"),
    "sms": ("sms", "text message", "text messages"),
    "transactions": ("transaction", "transactions", "plaid", "bank"),
    "documents": ("document", "documents", "file", "files", "notes"),
}


# Tree navigation, not research: a successful listing never satisfies the
# completion guard, whose rejection names the evidence tools. The listing still
# stays a readable trace in tool_call_results (wait_for's judge reads them).
_NON_EVIDENCE_EXPLORE_TOOLS = frozenset({"list_agents"})


def _has_usable_tool_evidence(value: Any) -> bool:
    """Return whether a successful tool result contains non-empty evidence."""
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized or normalized.lower() in {"null", "none", "[]", "{}"}:
            return False
        lowered = normalized.lower()
        return not lowered.startswith(
            ("error:", "error ", "failed:", "failed ", "failure:", "failure ", "exception:", "exception ")
        )
    if isinstance(value, dict):
        if value.get("success") is False or value.get("ok") is False:
            return False
        status = str(value.get("status") or "").strip().lower()
        if status in {"error", "failed", "failure"}:
            return False
        if any(value.get(key) for key in ("error", "errors", "exception")):
            return False
        return any(
            _has_usable_tool_evidence(item)
            for key, item in value.items()
            if key not in _TOOL_EVIDENCE_METADATA_KEYS and key not in {"ok", "error", "errors", "exception"}
        )
    if isinstance(value, (list, tuple, set)):
        return any(_has_usable_tool_evidence(item) for item in value)
    return bool(value)


def _unavailable_source_is_required(source: str, goal: str, require_source_access: Any) -> bool:
    """Distinguish required connector failures from opportunistic probes.

    The explore model may broaden a mixed-source grep beyond the user's request.
    An explicit ``require_source_access=False`` makes that broadening best-effort,
    unless the requested source is named in the explore goal itself. Calls with
    no hint preserve the existing fail-closed connector behavior.
    """
    if require_source_access is not False:
        return True
    normalized_goal = " ".join(str(goal or "").lower().replace("-", " ").split())
    normalized_source = str(source or "").lower().replace("-", "_")
    terms = _SOURCE_GOAL_TERMS.get(normalized_source, (normalized_source.replace("_", " "),))
    return any(term in normalized_goal for term in terms)


# =============================================================================
# VALIDATION
# =============================================================================


def validate_spawn_params(tool_call: dict) -> None:
    """Validate required fields per agent type. Raises ValueError with descriptive messages."""
    agent_type = tool_call.get("type")

    if not agent_type:
        raise ValueError(
            "spawn_agent requires 'type'. Must be one of: 'browser', 'code', 'general_purpose', 'explore', 'for_each'."
        )

    if agent_type not in VALID_AGENT_TYPES:
        raise ValueError(
            f"spawn_agent type='{agent_type}' is invalid. Must be one of: {', '.join(sorted(VALID_AGENT_TYPES))}."
        )

    from domains.spawn_agent.config import (
        disabled_general_purpose_rejection_message,
        is_disabled_general_purpose_type,
    )

    if is_disabled_general_purpose_type(agent_type):
        raise ValueError(disabled_general_purpose_rejection_message(agent_type=agent_type))

    # PLAN-phase gate: only `explore` is legal during PLAN. The PLAN-loop
    # response_model already narrows the schema to SpawnExploreAgentTool, but
    # Anthropic's native tool calling doesn't enforce `const` constraints
    # unless `strict: true` is set, and Sonnet has been observed emitting
    # `type=general_purpose` against the const in PLAN. Bounce it here so the
    # main-loop posts an ERROR tool_result and the agent re-plans instead of
    # blocking on a non-explore child workflow that won't return before EXECUTE.
    phase = (tool_call.get("_phase") or "").strip().upper()
    if phase == "PLAN" and agent_type != "explore":
        raise ValueError(
            f"spawn_agent(type='{agent_type}') is not allowed during PLAN. Only type='explore' "
            "may be spawned in PLAN. Call attempt_completion to transition to EXECUTE, then "
            "spawn this agent (the planner's DAG will run it)."
        )

    if not tool_call.get("goal"):
        raise ValueError(f"spawn_agent(type='{agent_type}') requires 'goal'. Describe the task for the agent.")

    if agent_type == "browser" and not tool_call.get("start_url"):
        raise ValueError("spawn_agent(type='browser') requires 'start_url'. Provide the URL to navigate to.")

    if agent_type in ("browser", "code", "general_purpose", "for_each") and not tool_call.get("output_schema"):
        raise ValueError(
            f"spawn_agent(type='{agent_type}') requires 'output_schema'. "
            "Define the expected response structure with fields."
        )

    if agent_type in ("general_purpose", "for_each"):
        start_phase = tool_call.get("start_phase")
        if start_phase is not None and str(start_phase).strip().upper() not in ("PLAN", "EXECUTE"):
            raise ValueError(
                "spawn_agent(type='general_purpose'|'for_each') start_phase must be either 'PLAN' or 'EXECUTE'."
            )

    if agent_type == "for_each":
        has_items = isinstance(tool_call.get("items"), list) and len(tool_call.get("items")) > 0
        has_csv = isinstance(tool_call.get("items_csv"), str) and bool(tool_call.get("items_csv").strip())
        if not has_items and not has_csv:
            raise ValueError("spawn_agent(type='for_each') requires either 'items' (list) or 'items_csv' (string).")

    if agent_type == "explore" and tool_call.get("output_schema"):
        raise ValueError(
            "spawn_agent(type='explore') does not use 'output_schema'. "
            "Explore agents return free-form research summaries."
        )

    # task_name is required of the model by the SpawnAgentTool schema (validated
    # before dispatch); internal callers (DAG, for_each items) fill it. Here a
    # supplied name must be a valid slug.
    if tool_call.get("task_name") is not None:
        task_name_problem = task_name_error(tool_call.get("task_name"))
        if task_name_problem:
            raise ValueError(task_name_problem)


def resolve_start_phase(tool_call: Dict[str, Any]) -> str:
    """Resolve public start_phase names to internal phase names."""
    phase = str(tool_call.get("start_phase", "PLAN")).strip().upper()
    return "execute" if phase == "EXECUTE" else "plan"


def _looks_like_common_csv_header(row: List[str]) -> bool:
    """Return True for common field-name headers when csv.Sniffer is inconclusive."""
    cleaned = [str(cell).strip() for cell in row if str(cell).strip()]
    if len(cleaned) < 2 or len(set(cell.lower() for cell in cleaned)) != len(cleaned):
        return False

    normalized = [cell.lower().replace(" ", "_").replace("-", "_") for cell in cleaned]
    return any(cell in COMMON_CSV_HEADER_NAMES for cell in normalized)


def coerce_for_each_items(tool_call: Dict[str, Any]) -> List[Any]:
    """Parse for_each items from list or CSV input."""
    items = tool_call.get("items")
    if isinstance(items, list) and items:
        return items

    csv_raw = tool_call.get("items_csv")
    if not isinstance(csv_raw, str) or not csv_raw.strip():
        return []

    text = csv_raw.strip()
    rows: List[Any] = []

    # Use DictReader only when header is likely present. This avoids dropping
    # the first row for plain CSV lists with no header.
    has_header = False
    try:
        has_header = csv.Sniffer().has_header(text[:4096])
    except Exception:
        has_header = False

    if not has_header:
        try:
            first_row = next(csv.reader(io.StringIO(text)), [])
            has_header = _looks_like_common_csv_header(first_row)
        except Exception:
            has_header = False

    if has_header:
        try:
            dict_reader = csv.DictReader(io.StringIO(text))
            if dict_reader.fieldnames:
                rows = [dict(r) for r in dict_reader]
                rows = [r for r in rows if any(v not in (None, "") for v in r.values())]
                if rows:
                    return rows
        except Exception:
            pass

    # Fallback: plain CSV rows (single-column or multi-column)
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if not row:
            continue
        cleaned = [str(c).strip() for c in row if str(c).strip()]
        if not cleaned:
            continue
        if len(cleaned) == 1:
            rows.append(cleaned[0])
        else:
            rows.append({"values": cleaned})

    return rows


def build_for_each_goal(base_goal: str, item: Any) -> str:
    """Build a per-item sub-agent goal from shared goal + row context.

    ``sort_keys=True`` is required for Fast Mode stability: FastModeCacheEntry
    values round-trip through Postgres JSONB (which reorders object keys), so
    insertion-order dumps diverge from the Jul 2026 OAi-demo namespaces and from
    any later replay that re-materializes items from cached JSON.
    """
    item_text = json.dumps(item, ensure_ascii=True, sort_keys=True) if isinstance(item, dict) else str(item)
    return f"{base_goal}\n\nUse this row context for the task below.\nRow item:\n{item_text}"


# =============================================================================
# EXPLORE AGENT ACTIVITY
# =============================================================================


# A message can only target an explore task after its spawn posted the address,
# which precedes the activity's schedule time; the margin absorbs clock skew.
EXPLORE_INBOX_SINCE_MARGIN_SECONDS = 60


def _explore_inbox_since_floor() -> Optional[str]:
    """Initial inbox cursor: the activity's schedule time minus a margin (None outside an activity)."""
    try:
        scheduled = activity.info().scheduled_time
    except Exception:
        return None
    if not isinstance(scheduled, datetime):
        return None
    if scheduled.tzinfo is None:
        scheduled = scheduled.replace(tzinfo=timezone.utc)
    return (scheduled - timedelta(seconds=EXPLORE_INBOX_SINCE_MARGIN_SECONDS)).isoformat()


@activity.defn
@traced("spawn_explore_agent_activity")
async def spawn_explore_agent_activity(
    agent_id: str,
    user_id: str,
    goal: str,
    model: str,
    task_id: str = "",
    init_tool_call_id: str = "",
    claude_token: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    attachment_texts: Optional[List[str]] = None,
    max_context_tokens: int = 200_000,
    depth: Optional[str] = None,
    max_iterations: Optional[int] = None,
    world_model_mode: str = "real",
    local_data_summary: str = "",
    oai_demo: Optional[bool] = None,
    inbox_address: Optional[str] = None,
    task_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the explore agent loop inside a Temporal activity.

    Uses run_agent with is_inside_temporal_activity=True and read-only tools
    (web_search, web_fetch, grep, list_agents, attempt_completion_with_result).
    ``task_name`` names this explore task under its owner (``<owner path>/<task_name>``,
    the list_agents YOU ARE HERE node).

    Returns:
        Dict with status, accumulated_usage, tokens_in, tokens_out
    """
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from helpers.agent_inbox import AgentInbox, agent_message_metadata
    from loop.activity_helper import call_temporal_activity_from_activity
    from loop.run_agent import run_agent
    from providers.fast_cache.client import resolve_agent_fast_mode
    from tools.api_request import ApiRequestManager
    from tools.grep import GrepManager
    from tools.inspect_code import InspectCodeManager
    from tools.list_agents import explore_list_agents
    from tools.people_search import PeopleSearchManager
    from tools.web_fetch import WebFetchManager
    from tools.web_search import WebSearchManager

    # Fast Mode is inherited from the parent (explore agents share the parent's
    # agent_id, which carries the persisted flag). Resolve it once for inner
    # request caches only. Do not cache the terminal explore result: replaying the
    # whole tool hides the inner LLM/web_search/web_fetch waterfall from the UI.
    (
        _explore_fast_mode_enabled,
        _explore_fast_mode_goal,
        _explore_fast_mode_write_enabled,
        _,
        _,
        _,
    ) = await resolve_agent_fast_mode(agent_id)
    _explore_fast_mode_goal = goal or _explore_fast_mode_goal
    # Classification is the handler's mass-agent flag when provided. Do not
    # re-read Fast Mode resolver goals — they disagree with truncated child
    # goals and with resolver failures. Old callers omit the flag and fall
    # back to the explore goal prefix only.
    _oai_demo = resolve_explore_oai_demo(goal, oai_demo=oai_demo)

    # Do NOT re-promote depth from an independently resolved Fast Mode flag.
    # `_spawn_explore` already paired depth + max_iterations with the activity
    # timeout using workflow_instance.fast_mode_cache_enabled. Re-resolving here
    # from resolve_agent_fast_mode can bump iterations to deep while the caller
    # still holds the quick timeout.

    activity.heartbeat(f"Starting explore agent: {goal[:100]}...")
    _heartbeat_stop = asyncio.Event()

    # Accumulate usage from all tool calls inside the explore agent
    accumulated_usage: List[Dict] = []

    # Accumulate per-iteration LLM usage with actual_model from Rose response
    llm_iteration_usage: List[Dict] = []
    explore_task_key = task_id or init_tool_call_id or hashlib.sha256(goal.encode()).hexdigest()[:16]
    explore_cache_sequence_id = f"agent:{agent_id}:task:{explore_task_key}:call:explore_agent"

    # Collect raw tool call results for callers that need evidence
    tool_call_results: List[str] = []
    # The local summary is fetched by a trusted backend activity before this
    # leaf starts. Treat it as grounded evidence so an aggregate/latest-message
    # lookup can complete without a redundant grep solely to satisfy the guard.
    has_usable_tool_evidence = bool(local_data_summary.strip())
    completion_no_evidence_rejects = 0

    # Data sources the explore agent tried to grep but whose connector isn't
    # connected. Surfaced to the parent workflow, which raises one blocking
    # source_connect gate per unavailable source after this explore returns.
    unavailable_sources_collected: List[Dict] = []

    # Every heartbeat replaces the details a timeout hands the parent, so the
    # latest evidence also rides on beats from the LLM helpers run_agent calls.
    resume_details: Dict[str, Any] = {}

    def _heartbeat_payload() -> Dict[str, Any]:
        compiled = compile_explore_wrap_up("", tool_call_results)
        resume_details.update(result=compiled, tool_call_results=list(tool_call_results[-8:]))
        return dict(resume_details)

    async def _heartbeat_loop() -> None:
        """Keep the activity alive during wrap-up LLM calls; details hold evidence."""
        while not _heartbeat_stop.is_set():
            try:
                activity.heartbeat(_heartbeat_payload())
            except Exception:
                logger.warning("Explore heartbeat failed", agent_id=agent_id, task_id=task_id)
            try:
                await asyncio.wait_for(_heartbeat_stop.wait(), timeout=30)
            except asyncio.TimeoutError:
                continue

    heartbeat_task = asyncio.create_task(_heartbeat_loop())

    async def on_tokens(
        tokens_in_delta: int,
        tokens_out_delta: int,
        actual_model: Optional[str] = None,
        cache_read_input_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
        call_site: str = "explore_agent",
        claude_token_error: Optional[str] = None,
        gpt_token_error: Optional[str] = None,
        claude_token_rotated: bool = False,
        gpt_token_rotated: bool = False,
        compute_token_used: Optional[Dict[str, Any]] = None,
        from_fast_cache: bool = False,
        iteration: Optional[int] = None,
        cache_sequence_id: Optional[str] = None,
    ):
        """Track each LLM call's tokens with the actual model used."""
        llm_iteration_usage.append(
            {
                "tokens_in": tokens_in_delta,
                "tokens_out": tokens_out_delta,
                "model": actual_model or model,
                "provider": "Explore Agent",
                "call_site": call_site,
                "cache_read_input_tokens": cache_read_input_tokens,
                "cache_creation_input_tokens": cache_creation_input_tokens,
                "from_fast_cache": from_fast_cache,
                "iteration": iteration,
                "cache_sequence_id": cache_sequence_id or explore_cache_sequence_id,
            }
        )

    # Background FE posts so fanout does not serialize on createMessage.
    # Fast Mode does not change this — cache only mocks external lib calls.
    _pending_fe_posts: "list[asyncio.Task]" = []
    # A timeout can cancel the awaiter while a threshold drain is in progress.
    # Keep those drains alive until final cleanup has observed their results.
    _inflight_fe_drains: "list[asyncio.Task[None]]" = []
    # Tail of the in-flight post chain for each chip, keyed by toolCallId.
    _fe_post_chain: "dict[str, asyncio.Task]" = {}
    _FE_POST_DRAIN_THRESHOLD = 64

    def _dispatch_fe_post(chain_key: Optional[str], coro_factory) -> None:
        """Background one FE post, ordered against earlier posts for the same chip.

        Posts for DIFFERENT chips stay fully concurrent — that concurrency is the
        whole point of backgrounding. Posts that share a toolCallId are chained,
        because the FE resolves a chip by toolCallId with last write wins: an
        IN_PROGRESS landing after its own ERROR strands a spinner that
        `cleanOrphanedInProgress` never reaps (it exempts agentType 'explore').
        Prod agent a6b8593a persisted ERROR at .959 before IN_PROGRESS at .982.
        """
        previous = _fe_post_chain.get(chain_key) if chain_key else None

        async def _ordered():
            if previous is not None:
                # Order only; a failed predecessor must not cancel its successor.
                await asyncio.gather(previous, return_exceptions=True)
            return await coro_factory()

        task = asyncio.create_task(_ordered())
        if chain_key:
            _fe_post_chain[chain_key] = task
        _pending_fe_posts.append(task)

    async def tagged_execute_activity(activity_fn, args=None, **kwargs):
        """Wraps call_temporal_activity_from_activity to tag internal messages with explore taskId.

        post_agent_message is dispatched in the background (create_task) so the tool
        call returns immediately; every other activity is awaited as before.
        """
        if activity_fn.__name__ == "post_agent_message" and args and len(args) >= 4:
            metadata = args[3]
            chain_key: Optional[str] = None
            if isinstance(metadata, dict):
                metadata["taskId"] = task_id
                metadata["agentType"] = "explore"
                metadata["subAgentId"] = task_id
                tool_call_id = metadata.get("toolCallId")
                # DEMO fixture cards have distinct visible IDs but belong to
                # one ordered tool call. Preserve their script order in the FE.
                chain_id = metadata.get("demoParentToolCallId") or tool_call_id
                chain_key = str(chain_id) if chain_id else None
            _dispatch_fe_post(
                chain_key,
                lambda: call_temporal_activity_from_activity(activity_fn, args=args, **kwargs),
            )
            return None
        return await call_temporal_activity_from_activity(activity_fn, args=args, **kwargs)

    async def _drain_pending_fe_posts() -> None:
        """Await all backgrounded FE posts so none is lost when the activity returns."""
        # Include already-done tasks: one that failed before the drain still holds
        # an unretrieved exception, which asyncio would log as "Task exception was
        # never retrieved" (and the FE post is silently dropped). gather() retrieves
        # every result so we can surface failures instead.
        pending = list(_pending_fe_posts)
        _pending_fe_posts.clear()
        if pending:
            async with span(
                "explore_fe_posts.drain",
                agent_id=agent_id,
                task_id=task_id,
                pending_count=len(pending),
            ):
                results = await asyncio.gather(*pending, return_exceptions=True)
            # Only NOW drop the chain tails, and only those still pointing at a
            # task we just drained. Clearing them before the gather would publish
            # "no predecessor" across an await: a concurrent post for the same
            # toolCallId would then start unchained and could overtake the one
            # still draining — recreating the very write inversion the chain
            # exists to prevent. A key whose tail was replaced during the await
            # belongs to a newer in-flight post and must be left alone.
            drained = set(pending)
            for key, task in list(_fe_post_chain.items()):
                if task in drained:
                    _fe_post_chain.pop(key, None)
            sealed: Optional[BaseException] = None
            for result in results:
                if isinstance(result, BaseException):
                    logger.warning("Explore FE post failed during drain", error=str(result))
                    if isinstance(result, WorkflowGenerationSealed):
                        sealed = result
            if sealed is not None:
                # A deploy replaced this generation. `return_exceptions=True`
                # turns every failure into a value, so the stop signal used to be
                # downgraded to a log line and the explore activity kept working
                # -- it went quiet 1s after the seal, then emitted one more fenced
                # write 17s later from this queue. Re-raise so the activity dies
                # here, exactly as a direct post does.
                raise sealed

    async def _maybe_drain_pending_fe_posts() -> None:
        if len(_pending_fe_posts) >= _FE_POST_DRAIN_THRESHOLD:
            drain = asyncio.create_task(_drain_pending_fe_posts())
            _inflight_fe_drains.append(drain)
            await asyncio.shield(drain)

    # Send the system prompt verbatim. Contact + message-thread context is
    # fetched on-demand via the grep tool (network / agent_network_* / messages
    # source modes), not via prefetched system-prompt blocks. The prompt is
    # byte-identical across explore-agent calls — this is the cache window.
    # Per-call dynamic state (current time) is prepended to the user goal as
    # a [STATE: ...] line so it does not contaminate the cacheable prefix.
    system_prompt = EXPLORE_AGENT_SYSTEM_PROMPT

    async def explore_system_prompt():
        return system_prompt

    # Agent-to-agent messages addressed to this explore task (the spawning tool
    # call id). The parent owns the inbox rows; explore shares its agent_id.
    # Read piggybacks on the per-step progress post (helpers/agent_inbox.py);
    # the cursor starts at the activity's schedule time so the backend read
    # stays a bounded (agentId, timestamp > since) range.
    agent_inbox = AgentInbox.create(agent_id, inbox_address, {"since": _explore_inbox_since_floor()})

    async def explore_poll_inbox() -> List[Dict[str, Any]]:
        if agent_inbox is None:
            return []
        rows: List[Dict[str, Any]] = []
        for message in await agent_inbox.next_step_messages():
            # Stored like a backend agent-message row: raw payload + metadata;
            # build_llm_messages renders it as an inter-agent (assistant) message.
            rows.append(
                {
                    "role": "USER",
                    "text": str(message.get("text") or ""),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "metadata": {**agent_message_metadata(message), "inboxAddress": inbox_address},
                }
            )
        return rows

    async def explore_verifier_prompt():
        return "Verify the research is complete and the summary addresses the original goal."

    async def explore_execute_tool(tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool inside the explore activity context."""
        nonlocal has_usable_tool_evidence, completion_no_evidence_rejects
        activity.heartbeat(_heartbeat_payload())

        tool_call_dict = {"tool": tool_name, **tool_args}

        if tool_name == "web_search":
            manager = WebSearchManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
                fast_mode_cache_enabled=_explore_fast_mode_enabled,
                fast_mode_goal=_explore_fast_mode_goal,
                fast_mode_cache_write_enabled=_explore_fast_mode_write_enabled,
                world_model_mode=world_model_mode,
            )
        elif tool_name == "people_search":
            manager = PeopleSearchManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
                fast_mode_cache_enabled=_explore_fast_mode_enabled,
                fast_mode_goal=_explore_fast_mode_goal,
                fast_mode_cache_write_enabled=_explore_fast_mode_write_enabled,
                world_model_mode=world_model_mode,
            )
        elif tool_name == "web_fetch":
            manager = WebFetchManager()
            # Pass auth so the per-tool summarizer uses claudeAuth ($0) rather
            # than the OpenRouter waterfall (which may be out of credits).
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
                claude_token=claude_token,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                fast_mode_cache_enabled=_explore_fast_mode_enabled,
                fast_mode_goal=_explore_fast_mode_goal,
                fast_mode_cache_write_enabled=_explore_fast_mode_write_enabled,
                world_model_mode=world_model_mode,
            )
        elif tool_name == "grep":
            manager = GrepManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
            if isinstance(result, dict):
                for st in result.get("unavailable_sources") or []:
                    if isinstance(st, dict):
                        source = st.get("source")
                        normalized = st
                    else:
                        source = str(st) if st else None
                        normalized = {"source": source} if source else None
                    if (
                        source
                        and normalized
                        and _unavailable_source_is_required(source, goal, tool_args.get("require_source_access"))
                        and not any(u.get("source") == source for u in unavailable_sources_collected)
                    ):
                        unavailable_sources_collected.append(normalized)
        elif tool_name == "inspect_code":
            result = await InspectCodeManager().execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
            if result.get("error"):
                return {"error": True, "message": str(result["error"])}
        elif tool_name == "list_agents":
            result = await explore_list_agents(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                owner_agent_id=agent_id,
                user_id=user_id,
                explore_task_id=inbox_address or task_id,
                explore_task_name=task_name,
                explore_goal=goal,
            )
            if result.get("error"):
                return result
        elif tool_name == "api_request":
            from utils.kill_switches import api_request_disabled

            if api_request_disabled():
                return {
                    "error": True,
                    "message": "api_request is temporarily disabled.",
                }
            manager = ApiRequestManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
        elif tool_name in ("attempt_completion", "attempt_completion_with_result"):
            if not attachment_texts and not has_usable_tool_evidence:
                completion_no_evidence_rejects += 1
                # Fast Mode cold stubs replay attempt_completion_with_result
                # forever. One reject is enough signal; accepting the next
                # ends the leaf so the chip does not fill with 50 rejects.
                if completion_no_evidence_rejects >= 2 and _oai_demo:
                    return {"success": True, "message": "Completion accepted"}
                from utils.kill_switches import api_request_disabled

                evidence_tools = "web_search, people_search, web_fetch, or grep"
                if not api_request_disabled():
                    evidence_tools = "web_search, people_search, web_fetch, grep, or api_request"
                return {
                    "error": True,
                    "message": (
                        "Completion rejected: no evidence tool has succeeded yet. "
                        f"Call {evidence_tools} successfully before completing."
                    ),
                }
            if agent_inbox is not None and await agent_inbox.unread_before_finish():
                return {"error": True, "message": EXPLORE_COMPLETION_DEFERRED_FOR_MESSAGE}
            return {"success": True, "message": "Completion accepted"}
        else:
            return {"error": True, "message": f"Unknown tool: {tool_name}"}

        # Extract and accumulate usage
        if isinstance(result, dict) and "usage" in result:
            accumulated_usage.append(result["usage"])
            actual_result = result.get("result", result)
        else:
            actual_result = result

        failure = _explore_tool_failure(tool_name, actual_result)
        if failure:
            return {"error": True, "message": failure}

        if tool_name not in _NON_EVIDENCE_EXPLORE_TOOLS and _has_usable_tool_evidence(actual_result):
            has_usable_tool_evidence = True
        result_str = _render_explore_tool_result(tool_name, actual_result)

        # Keep readable tool evidence for heartbeat, completion fallback, and
        # wait_for's out-of-band condition evaluator.
        tool_call_results.append(f"[{tool_name}] {result_str}")
        activity.heartbeat(_heartbeat_payload())

        return {"success": True, "message": result_str}

    async def explore_post_message(message: str, role: str, metadata: Optional[Dict] = None):
        """Post messages from the explore agent to DB."""
        is_tool_error = role == "TOOL" and bool(metadata and metadata.get("error"))
        message_status = MessageStatus.ERROR if is_tool_error else MessageStatus.FINISHED
        title = str(metadata.get("title")) if metadata and metadata.get("title") else "Explore agent thinking"
        tool_call_id = str(metadata.get("toolCallId")) if metadata and metadata.get("toolCallId") else None
        # Carry the caller's toolName through. Stamping every explore message
        # `spawn_agent` made a tool's message collide with that tool's own chip
        # under the shared toolCallId, and the FE (last write wins) dropped the
        # tool's formatted chip in favour of this one.
        tool_name = str(metadata.get("toolName")) if metadata and metadata.get("toolName") else None
        async with span(
            "explore_fe_posts.enqueue",
            agent_id=agent_id,
            task_id=task_id,
            role=role,
            message_len=len(message or ""),
            pending_count=len(_pending_fe_posts),
        ):
            # Same chain as the tool managers' posts: both writers can target one
            # toolCallId, so both must respect that chip's ordering invariant.
            async def _post_and_stash_inbox() -> None:
                # Fire-and-forget like every FE post; its piggybacked inbox read
                # is delivered at the next step.
                pending = await save_explore_message(
                    agent_id=agent_id,
                    title=title,
                    message=message[:EXPLORE_MESSAGE_TRUNCATE_LEN],
                    status=message_status,
                    task_id=task_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    inbox=agent_inbox.read_request() if agent_inbox is not None else None,
                )
                if agent_inbox is not None:
                    agent_inbox.stash(pending)

            _dispatch_fe_post(tool_call_id, _post_and_stash_inbox)
        await _maybe_drain_pending_fe_posts()

    # Build initial context with goal + any resolved attachment content.
    # Prepend a [STATE: time=...] line so the explore agent can compute
    # relative time ranges (e.g. for grep `since` filtering) without baking
    # the timestamp into the cacheable system prompt.
    current_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Resolve the caller's thoroughness. The depth tag rides in the per-call goal
    # (NOT the cacheable system prompt); the turn cap must match the activity
    # timeout sized by the handler. When max_iterations is provided, trust that
    # contract — never bump iterations from a separately resolved Fast Mode flag.
    if depth in ("quick", "medium", "deep"):
        effective_depth = depth
    else:
        effective_depth = resolve_explore_depth(
            depth,
            fast_mode_cache_enabled=_explore_fast_mode_enabled,
            oai_demo=_oai_demo,
        )
    depth_cap = explore_limits_for_depth(effective_depth)[0]
    if max_iterations is None:
        resolved_max_iterations = depth_cap
    else:
        resolved_max_iterations = max_iterations
    state_line = f"[STATE: now={current_ts}] [Thoroughness: {effective_depth}]"
    initial_user_text = f"{state_line}\n\n{goal}"
    if local_data_summary:
        initial_user_text = (
            initial_user_text + "\n\nLOCAL DATA SUMMARY (aggregate facts from the user's connected data; "
            "use these directly and use grep only for missing message-level details). "
            "A thread label is a valid contact identifier. If it contains only a phone number, "
            "report that identifier exactly; do not guess or use unrelated web, email, or document "
            "searches to invent a person's identity. Search only sources relevant to the goal:\n" + local_data_summary
        )
    if attachment_texts:
        initial_user_text = initial_user_text + "\n\n" + "\n\n".join(attachment_texts)

    # Run the agent loop. Wrap in try/finally so backgrounded FE posts are always
    # drained — if run_agent raises, the already-scheduled _pending_fe_posts tasks
    # would otherwise dangle on the shared worker loop (asyncio "Task exception was
    # never retrieved") and the final iteration's FE messages would be dropped on
    # exactly the error path where visibility matters most.
    result: Dict[str, Any] = {}
    try:
        with heartbeat_resume_details(resume_details):
            run_agent_coro = run_agent(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=explore_system_prompt,
                verifier_prompt_generator=explore_verifier_prompt,
                model=model,
                tools=get_explore_agent_tools(),
                initial_context=[{"role": "USER", "text": initial_user_text}],
                task_id=task_id,
                is_inside_temporal_activity=True,
                execute_tool=explore_execute_tool,
                post_message=explore_post_message,
                poll_inbox=explore_poll_inbox if agent_inbox is not None else None,
                max_iterations=resolved_max_iterations,
                winddown_window=EXPLORE_WINDDOWN_WINDOW,
                max_context_tokens=max_context_tokens,
                skip_verification=True,
                skip_blueprint_query=True,
                skip_status_updates=True,
                claude_token=claude_token,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                get_gpt_token_source=(lambda: gpt_token_source),
                get_gpt_token_pool_id=(lambda: gpt_token_pool_id),
                on_tokens=on_tokens,
                call_site_override="explore_agent",
                jev_goal=goal,
                cache_sequence_id=explore_cache_sequence_id,
                # Fast Mode: key this explore agent by ITS OWN goal (not the shared parent
                # agent_id), so the N parallel explore agents under one sub-agent don't all
                # collide on (parent_goal, explore_agent, iteration) and bust each other.
                fast_mode_cache_enabled=_explore_fast_mode_enabled,
                goal_text=_explore_fast_mode_goal,
            )
            if _oai_demo:
                result = await run_agent_coro
            else:
                deadline_expired = False
                try:
                    # The parent waits this depth's whole activity timeout
                    # (quick/medium 600s, deep 1800s); wrap up just inside it.
                    async with asyncio.timeout(
                        explore_limits_for_depth(effective_depth)[1].total_seconds() - LIVE_EXPLORE_DRAIN_SLACK_SECONDS
                    ) as deadline:
                        result = await run_agent_coro
                except asyncio.TimeoutError:
                    deadline_expired = True
                else:
                    deadline_expired = deadline.expired()
                if deadline_expired:
                    # run_agent catches CancelledError and returns status="paused".
                    # The timeout context distinguishes that local wind-down from
                    # an external pause, which must keep its cancellation behavior.
                    logger.info("Explore agent returning gathered evidence before its activity timeout")
                    result = {"status": "completed"}
    finally:
        _heartbeat_stop.set()
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except (asyncio.CancelledError, Exception):
            pass
        # A timed-out explore may have been awaiting a threshold drain. Its
        # shielded posts must finish before a final drain or activity return.
        drain_error: BaseException | None = None
        if _inflight_fe_drains:
            results = await asyncio.shield(asyncio.gather(*_inflight_fe_drains, return_exceptions=True))
            drain_error = next((item for item in results if isinstance(item, BaseException)), None)
        # Flush posts queued after the last threshold drain as well.
        try:
            await _drain_pending_fe_posts()
        finally:
            if drain_error is not None:
                raise drain_error

    # Defensive fallback: when the explore agent terminates with attempt_completion
    # but leaves result empty, the parent receives no evidence. Synthesize a
    # payload from accumulated tool results so the parent always has grounded data
    # to act on instead of hallucinating or re-spawning sub-agents.
    final_response = compile_explore_wrap_up(
        result.get("final_response", "") or "",
        tool_call_results,
    )

    # Disconnected sources are a gap notice, not a hard explore failure. Grep
    # already skipped them and the parent still raises source_connect gates;
    # keep the explore's own completion status so the user-visible result is
    # not clobbered by "required data source(s) not connected".
    has_unavailable = bool(unavailable_sources_collected)
    unavailable_names = ", ".join(str(u.get("source")) for u in unavailable_sources_collected)
    notice_marker = "⚠️ Source(s) not connected:"
    if has_unavailable and notice_marker not in (final_response or ""):
        notice = (
            f"\n\n{notice_marker} {unavailable_names}. These were skipped — "
            "do NOT retry them. A one-time connect request will be sent to the user "
            "after this exploration finishes when connect gates are enabled."
        )
        final_response = f"{(final_response or '').rstrip()}{notice}"

    # A tool-free explore completion is not grounded research. Models can
    # occasionally call attempt_completion immediately and claim that search
    # was unavailable even though the tools were present. Treat that as a
    # failed child so the parent can replace it instead of accepting an empty
    # evidence payload and looping on verifier feedback. Attachment-backed
    # explores may legitimately summarize the supplied content without another
    # tool call, so preserve that path.
    completed_without_tool_evidence = (
        result.get("status") == "completed"
        and not has_usable_tool_evidence
        and not attachment_texts
        and not local_data_summary
    )
    run_completed = result.get("status") == "completed" and not completed_without_tool_evidence
    result_payload = {
        "status": "completed" if run_completed else "error",
        "result": final_response,
        "summary": final_response,
        "final_response": final_response,
        "best_effort_response": result.get("best_effort_response") or final_response,
        "error_reason": (
            "explore completed without tool evidence"
            if completed_without_tool_evidence
            else (None if run_completed else (result.get("message") or result.get("status")))
        ),
        "unavailable_sources": unavailable_sources_collected,
        "partial_structured_response": result.get("partial_structured_response"),
        "structured_response": result.get("structured_response") or result.get("partial_structured_response"),
        "tokens_in": result.get("tokens_in", 0),
        "tokens_out": result.get("tokens_out", 0),
        "accumulated_usage": accumulated_usage,
        "llm_iteration_usage": llm_iteration_usage,
        "tool_call_results": tool_call_results,
    }
    return result_payload
