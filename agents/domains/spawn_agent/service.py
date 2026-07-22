"""Spawn-agent domain service: validation, parsing, and explore agent activity."""

from __future__ import annotations

import asyncio
import csv
import io
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity

from domains.spawn_agent.config import (
    EXPLORE_DEFAULT_DEPTH,
    EXPLORE_MESSAGE_TRUNCATE_LEN,
    EXPLORE_WINDDOWN_WINDOW,
    explore_limits_for_depth,
)
from domains.spawn_agent.repo import (
    _resolve_explore_attachments_activity as _resolve_explore_attachments_activity,
)
from domains.spawn_agent.repo import (
    fetch_full_network_metadata as fetch_full_network_metadata,
)
from domains.spawn_agent.repo import (
    save_explore_message,
)
from domains.spawn_agent.types import VALID_AGENT_TYPES
from helpers.tracing import span, traced
from tools.base import MessageStatus
from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT
from utils.tool_schemas import EXPLORE_AGENT_TOOLS

logger = structlog.get_logger()

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
    """Build a per-item sub-agent goal from shared goal + row context."""
    item_text = json.dumps(item, ensure_ascii=True) if isinstance(item, dict) else str(item)
    return f"{base_goal}\n\nUse this row context for the task below.\nRow item:\n{item_text}"


# =============================================================================
# EXPLORE AGENT ACTIVITY
# =============================================================================


@activity.defn
@traced("spawn_explore_agent_activity")
async def spawn_explore_agent_activity(  # noqa: C901
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
) -> Dict[str, Any]:
    """Run the explore agent loop inside a Temporal activity.

    Uses run_agent with is_inside_temporal_activity=True and read-only tools
    (web_search, web_fetch, grep, attempt_completion_with_result).

    Returns:
        Dict with status, accumulated_usage, tokens_in, tokens_out
    """
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from loop.activity_helper import call_temporal_activity_from_activity
    from loop.run_agent import run_agent
    from providers.fast_cache.client import resolve_agent_fast_mode
    from tools.grep import GrepManager
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
    ) = await resolve_agent_fast_mode(agent_id)
    _explore_fast_mode_goal = goal or _explore_fast_mode_goal

    activity.heartbeat(f"Starting explore agent: {goal[:100]}...")

    # Accumulate usage from all tool calls inside the explore agent
    accumulated_usage: List[Dict] = []

    # Accumulate per-iteration LLM usage with actual_model from Rose response
    llm_iteration_usage: List[Dict] = []

    # Collect raw tool call results for callers that need evidence
    tool_call_results: List[str] = []
    has_usable_tool_evidence = False

    # Data sources the explore agent tried to grep but whose connector isn't
    # connected. Surfaced to the parent workflow, which raises one blocking
    # source_connect gate per unavailable source after this explore returns.
    unavailable_sources_collected: List[Dict] = []

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
            }
        )

    # FE message posts are fire-and-forget so they never block the explore leaf's
    # loop. Each post is a ~500ms createMessage round-trip (Fly->Render + awaited
    # Supabase broadcast); awaiting one per cached turn serializes fanout leaves on
    # UI/debug persistence. The explore runs with no poll_messages, so context is
    # already in-process; the post is FE/persistence-only. Backgrounded tasks are
    # drained after run_agent so no message is lost.
    _pending_fe_posts: "list[asyncio.Task]" = []
    _FE_POST_DRAIN_THRESHOLD = 64

    async def tagged_execute_activity(activity_fn, args=None, **kwargs):
        """Wraps call_temporal_activity_from_activity to tag internal messages with explore taskId.

        post_agent_message is dispatched in the background (create_task) so the tool
        call returns immediately; every other activity is awaited as before.
        """
        if activity_fn.__name__ == "post_agent_message" and args and len(args) >= 4:
            metadata = args[3]
            if isinstance(metadata, dict):
                metadata["taskId"] = task_id
                metadata["agentType"] = "explore"
                metadata["subAgentId"] = task_id
            _pending_fe_posts.append(
                asyncio.create_task(call_temporal_activity_from_activity(activity_fn, args=args, **kwargs))
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
            for result in results:
                if isinstance(result, BaseException):
                    logger.warning("Explore FE post failed during drain", error=str(result))

    async def _maybe_drain_pending_fe_posts() -> None:
        if len(_pending_fe_posts) >= _FE_POST_DRAIN_THRESHOLD:
            await _drain_pending_fe_posts()

    # Send the system prompt verbatim. Contact + message-thread context is
    # fetched on-demand via the grep tool (network / agent_network_* / messages
    # source modes), not via prefetched system-prompt blocks. The prompt is
    # byte-identical across explore-agent calls — this is the cache window.
    # Per-call dynamic state (current time) is prepended to the user goal as
    # a [STATE: ...] line so it does not contaminate the cacheable prefix.
    system_prompt = EXPLORE_AGENT_SYSTEM_PROMPT

    async def explore_system_prompt():
        return system_prompt

    async def explore_verifier_prompt():
        return "Verify the research is complete and the summary addresses the original goal."

    async def explore_execute_tool(tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool inside the explore activity context."""
        nonlocal has_usable_tool_evidence
        activity.heartbeat(f"Explore agent executing: {tool_name}")

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
            )
        elif tool_name == "people_search":
            manager = PeopleSearchManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
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
                    key = st.get("source") if isinstance(st, dict) else st
                    if key and not any(u.get("source") == key for u in unavailable_sources_collected):
                        unavailable_sources_collected.append(st)
        elif tool_name in ("attempt_completion", "attempt_completion_with_result"):
            if not attachment_texts and not has_usable_tool_evidence:
                return {
                    "error": True,
                    "message": (
                        "Completion rejected: no evidence tool has succeeded yet. "
                        "Call web_search, people_search, web_fetch, or grep successfully before completing."
                    ),
                }
            return {"success": True, "message": "Completion accepted"}
        else:
            return {"error": True, "message": f"Unknown tool: {tool_name}"}

        # Extract and accumulate usage
        if isinstance(result, dict) and "usage" in result:
            accumulated_usage.append(result["usage"])
            actual_result = result.get("result", result)
        else:
            actual_result = result

        if _has_usable_tool_evidence(actual_result):
            has_usable_tool_evidence = True

        # Serialize the actual result into message so run_agent puts it in context.
        try:
            result_str = json.dumps(actual_result, default=str)
        except Exception:
            result_str = str(actual_result)

        # Collect raw tool results for callers (e.g. wait_for condition evaluator)
        tool_call_results.append(f"[{tool_name}] {result_str}")

        return {"success": True, "message": result_str}

    async def explore_post_message(message: str, role: str, metadata: Optional[Dict] = None):
        """Post messages from the explore agent to DB."""
        is_tool_error = role == "TOOL" and bool(metadata and metadata.get("error"))
        message_status = MessageStatus.ERROR if is_tool_error else MessageStatus.FINISHED
        title = str(metadata.get("title")) if metadata and metadata.get("title") else "Explore agent thinking"
        tool_call_id = str(metadata.get("toolCallId")) if metadata and metadata.get("toolCallId") else None
        async with span(
            "explore_fe_posts.enqueue",
            agent_id=agent_id,
            task_id=task_id,
            role=role,
            message_len=len(message or ""),
            pending_count=len(_pending_fe_posts),
        ):
            _pending_fe_posts.append(
                asyncio.create_task(
                    save_explore_message(
                        agent_id=agent_id,
                        title=title,
                        message=message[:EXPLORE_MESSAGE_TRUNCATE_LEN],
                        status=message_status,
                        task_id=task_id,
                        tool_call_id=tool_call_id,
                    )
                )
            )
        await _maybe_drain_pending_fe_posts()

    # Build initial context with goal + any resolved attachment content.
    # Prepend a [STATE: time=...] line so the explore agent can compute
    # relative time ranges (e.g. for grep `since` filtering) without baking
    # the timestamp into the cacheable system prompt.
    current_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Resolve the caller's thoroughness. The depth tag rides in the per-call goal
    # (NOT the cacheable system prompt); the turn cap comes from the same depth.
    effective_depth = depth or EXPLORE_DEFAULT_DEPTH
    resolved_max_iterations = max_iterations or explore_limits_for_depth(effective_depth)[0]
    state_line = f"[STATE: now={current_ts}] [Thoroughness: {effective_depth}]"
    initial_user_text = f"{state_line}\n\n{goal}"
    if attachment_texts:
        initial_user_text = initial_user_text + "\n\n" + "\n\n".join(attachment_texts)

    # Run the agent loop. Wrap in try/finally so backgrounded FE posts are always
    # drained — if run_agent raises, the already-scheduled _pending_fe_posts tasks
    # would otherwise dangle on the shared worker loop (asyncio "Task exception was
    # never retrieved") and the final iteration's FE messages would be dropped on
    # exactly the error path where visibility matters most.
    try:
        result = await run_agent(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=explore_system_prompt,
            verifier_prompt_generator=explore_verifier_prompt,
            model=model,
            tools=EXPLORE_AGENT_TOOLS,
            initial_context=[{"role": "USER", "text": initial_user_text}],
            task_id=task_id,
            is_inside_temporal_activity=True,
            execute_tool=explore_execute_tool,
            post_message=explore_post_message,
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
            # Fast Mode: key this explore agent by ITS OWN goal (not the shared parent
            # agent_id), so the N parallel explore agents under one sub-agent don't all
            # collide on (parent_goal, explore_agent, iteration) and bust each other.
            fast_mode_cache_enabled=_explore_fast_mode_enabled,
            goal_text=_explore_fast_mode_goal,
        )
    finally:
        # Flush any backgrounded FE posts before returning/propagating so the FE
        # receives every tool message even though they no longer blocked the leaf loop.
        await _drain_pending_fe_posts()

    # Defensive fallback: when the explore agent terminates with attempt_completion
    # but leaves result empty, the parent receives no evidence. Synthesize a
    # payload from accumulated tool results so the parent always has grounded data
    # to act on instead of hallucinating or re-spawning sub-agents.
    final_response = result.get("final_response", "") or ""
    if not final_response.strip() and tool_call_results:
        # Cap the synthesized payload so we don't ship 100 KB+ back through the
        # parent context. 12 KB matches the explore message truncation tier and
        # leaves headroom for evidence from up to ~3 web_search results.
        EXPLORE_FALLBACK_PAYLOAD_BUDGET = 12_000
        joined = "\n\n".join(tool_call_results)
        if len(joined) > EXPLORE_FALLBACK_PAYLOAD_BUDGET:
            joined = joined[:EXPLORE_FALLBACK_PAYLOAD_BUDGET] + "\n\n[truncated]"
        final_response = (
            "Explore sub-agent completed without a final summary. "
            "Raw tool results below; extract the requested values directly:\n\n"
            f"{joined}"
        )

    # A required data source that isn't connected means the explore could not
    # do its job — it is FAILED (the parent will raise the connect gate). This
    # takes precedence over the run's own completed/error status.
    has_unavailable = bool(unavailable_sources_collected)
    unavailable_names = ", ".join(str(u.get("source")) for u in unavailable_sources_collected)
    # A tool-free explore completion is not grounded research. Models can
    # occasionally call attempt_completion immediately and claim that search
    # was unavailable even though the tools were present. Treat that as a
    # failed child so the parent can replace it instead of accepting an empty
    # evidence payload and looping on verifier feedback. Attachment-backed
    # explores may legitimately summarize the supplied content without another
    # tool call, so preserve that path.
    completed_without_tool_evidence = (
        result.get("status") == "completed" and not has_usable_tool_evidence and not attachment_texts
    )
    run_completed = result.get("status") == "completed" and not completed_without_tool_evidence
    result_payload = {
        "status": "error" if has_unavailable else ("completed" if run_completed else "error"),
        "result": final_response,
        "summary": final_response,
        "final_response": final_response,
        "best_effort_response": result.get("best_effort_response") or final_response,
        "error_reason": (
            f"required data source(s) not connected: {unavailable_names}"
            if has_unavailable
            else (
                "explore completed without tool evidence"
                if completed_without_tool_evidence
                else (None if run_completed else (result.get("message") or result.get("status")))
            )
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
