"""Spawn-agent domain service: validation, parsing, and explore agent activity."""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity

from domains.spawn_agent.config import (
    EXPLORE_MAX_ITERATIONS,
    EXPLORE_MESSAGE_TRUNCATE_LEN,
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
from helpers.tracing import traced
from tools.base import MessageStatus
from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT

logger = structlog.get_logger()


# =============================================================================
# VALIDATION
# =============================================================================


def validate_spawn_params(tool_call: dict) -> None:
    """Validate required fields per agent type. Raises ValueError with descriptive messages."""
    agent_type = tool_call.get("type")

    if not agent_type:
        raise ValueError(
            "spawn_agent requires 'type'. Must be one of: 'browser', 'code', 'sub_agent', 'explore', 'for_each'."
        )

    if agent_type not in VALID_AGENT_TYPES:
        raise ValueError(
            f"spawn_agent type='{agent_type}' is invalid. Must be one of: {', '.join(sorted(VALID_AGENT_TYPES))}."
        )

    if not tool_call.get("goal"):
        raise ValueError(f"spawn_agent(type='{agent_type}') requires 'goal'. Describe the task for the agent.")

    if agent_type == "browser" and not tool_call.get("start_url"):
        raise ValueError("spawn_agent(type='browser') requires 'start_url'. Provide the URL to navigate to.")

    if agent_type in ("browser", "code", "sub_agent", "for_each") and not tool_call.get("output_schema"):
        raise ValueError(
            f"spawn_agent(type='{agent_type}') requires 'output_schema'. "
            "Define the expected response structure with fields."
        )

    if agent_type in ("sub_agent", "for_each"):
        start_phase = tool_call.get("start_phase")
        if start_phase is not None and str(start_phase).strip().upper() not in ("RESEARCH", "EXECUTE"):
            raise ValueError(
                "spawn_agent(type='sub_agent'|'for_each') start_phase must be either 'RESEARCH' or 'EXECUTE'."
            )

    if agent_type == "for_each":
        has_items = isinstance(tool_call.get("items"), list) and len(tool_call.get("items")) > 0
        has_csv = isinstance(tool_call.get("items_csv"), str) and bool(tool_call.get("items_csv").strip())
        if not has_items and not has_csv:
            raise ValueError("spawn_agent(type='for_each') requires either 'items' (list) or 'items_csv' (string).")

    if agent_type == "explore":
        if tool_call.get("output_schema"):
            raise ValueError(
                "spawn_agent(type='explore') does not use 'output_schema'. "
                "Explore agents return free-form research summaries."
            )


def resolve_start_phase(tool_call: Dict[str, Any]) -> str:
    """Resolve public start_phase names to internal phase names."""
    phase = str(tool_call.get("start_phase", "RESEARCH")).strip().upper()
    return "execute" if phase == "EXECUTE" else "plan"


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
    network_metadata: str = "",
    local_data_summary: str = "",
    task_id: str = "",
    init_tool_call_id: str = "",
    claude_token: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    attachment_texts: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Run the explore agent loop inside a Temporal activity.

    Uses run_agent with is_inside_temporal_activity=True and read-only tools
    (web_search, web_fetch, grep, attempt_completion).

    Returns:
        Dict with status, accumulated_usage, tokens_in, tokens_out
    """
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from loop.activity_helper import call_temporal_activity_from_activity
    from loop.run_agent import run_agent
    from tools.grep import GrepManager
    from tools.web_fetch import WebFetchManager
    from tools.web_search import WebSearchManager

    activity.heartbeat(f"Starting explore agent: {goal[:100]}...")

    # Accumulate usage from all tool calls inside the explore agent
    accumulated_usage: List[Dict] = []

    # Accumulate per-iteration LLM usage with actual_model from Rose response
    llm_iteration_usage: List[Dict] = []

    # Collect raw tool call results for callers that need evidence
    tool_call_results: List[str] = []

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
            }
        )

    # Wrap execute_activity to inject taskId into all internal tool messages
    async def tagged_execute_activity(activity_fn, args=None, **kwargs):
        """Wraps call_temporal_activity_from_activity to tag internal messages with explore taskId."""
        if activity_fn.__name__ == "post_agent_message" and args and len(args) >= 4:
            metadata = args[3]
            if isinstance(metadata, dict):
                metadata["taskId"] = task_id
                metadata["agentType"] = "explore"
                metadata["subAgentId"] = task_id
        return await call_temporal_activity_from_activity(activity_fn, args=args, **kwargs)

    # Build system prompt with network metadata and local data summary.
    # The system prompt is byte-identical across explore-agent calls — this
    # is the cache window. Per-call dynamic state (current time) is prepended
    # to the user goal as a [STATE: ...] line so it does not contaminate the
    # cacheable prefix. Mirrors the v3 browser-agent pattern (see
    # domains/spawn_browser_agent_v3/handler.py — build_state_line).
    system_prompt = EXPLORE_AGENT_SYSTEM_PROMPT.format(
        network_metadata=f"\nUSER NETWORK:\n{network_metadata}" if network_metadata else "",
        local_data_summary=f"\n{local_data_summary}" if local_data_summary else "",
    )

    async def explore_system_prompt():
        return system_prompt

    async def explore_verifier_prompt():
        return "Verify the research is complete and the summary addresses the original goal."

    async def explore_execute_tool(tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool inside the explore activity context."""
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
            )
        elif tool_name == "web_fetch":
            manager = WebFetchManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
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
        elif tool_name == "attempt_completion":
            return {"success": True, "message": "Completion accepted"}
        else:
            return {"error": True, "message": f"Unknown tool: {tool_name}"}

        # Extract and accumulate usage
        if isinstance(result, dict) and "usage" in result:
            accumulated_usage.append(result["usage"])
            actual_result = result.get("result", result)
        else:
            actual_result = result

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
        await save_explore_message(
            agent_id=agent_id,
            title="Explore agent thinking",
            message=message[:EXPLORE_MESSAGE_TRUNCATE_LEN],
            status=MessageStatus.FINISHED,
            task_id=task_id,
        )

    # Build initial context with goal + any resolved attachment content.
    # Prepend a [STATE: time=...] line so the explore agent can compute
    # relative time ranges (e.g. for grep `since` filtering) without baking
    # the timestamp into the cacheable system prompt.
    current_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    state_line = f"[STATE: now={current_ts}]"
    initial_user_text = f"{state_line}\n\n{goal}"
    if attachment_texts:
        initial_user_text = initial_user_text + "\n\n" + "\n\n".join(attachment_texts)

    # Run the agent loop
    result = await run_agent(
        agent_id=agent_id,
        user_id=user_id,
        system_prompt=explore_system_prompt,
        verifier_prompt_generator=explore_verifier_prompt,
        model=model,
        tools=["web_search", "web_fetch", "grep", "attempt_completion"],
        initial_context=[{"role": "USER", "text": initial_user_text}],
        task_id=task_id,
        is_inside_temporal_activity=True,
        execute_tool=explore_execute_tool,
        post_message=explore_post_message,
        max_iterations=EXPLORE_MAX_ITERATIONS,
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
    )

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

    return {
        "status": "completed" if result.get("status") == "completed" else "error",
        "result": final_response,
        "tokens_in": result.get("tokens_in", 0),
        "tokens_out": result.get("tokens_out", 0),
        "accumulated_usage": accumulated_usage,
        "llm_iteration_usage": llm_iteration_usage,
        "tool_call_results": tool_call_results,
    }
