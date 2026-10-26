"""People search handler -- thin entry point for tool execution and Temporal activity."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, List, Optional

import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from helpers.tracing import traced
from helpers.world_model_runtime import WorldModelToolExecutionAdapter
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message
from tools.people_search.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    LANTERN_COST_CENTS_PER_QUERY,
    QUERY_DISPLAY_MAX_LENGTH,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_INTERVAL_SECONDS,
)
from tools.people_search.service import execute_people_search

if TYPE_CHECKING:
    from tools.people_search.types import ExecuteActivityCallable

logger = structlog.get_logger()
DEMO_CACHE_HIT_FIELD = "_fast_cache_hit"


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _cost_for_provider(provider: str) -> float:
    """Map the routed provider to its flat per-query cost in cents."""
    if provider == "lantern":
        return LANTERN_COST_CENTS_PER_QUERY
    return 0.0


class PeopleSearchManager(ToolManager):
    """Manager for Lantern people search and source-profile retrieval."""

    tool_name = "people_search"
    read_only = True  # Research phase tool (explore agents only)

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
        fast_mode_cache_enabled: bool = False,
        fast_mode_goal: Optional[str] = None,
        fast_mode_cache_write_enabled: bool = False,
        world_model_mode: str = "real",
    ) -> dict[str, Any]:
        """Execute people search and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
            tool_call: Tool call dict with 'query', 'mode', 'provider', and
                optional 'limit' (discover) / 'fields' (enrich).
            tool_call_id: Unique ID for this tool call.
            agent_id: Agent ID for event routing.
            user_id: User ID for usage tracking.
            fast_mode_cache_enabled / fast_mode_goal: Fast Mode read switch.
            fast_mode_cache_write_enabled: Reserved for write-through (unused until
                people_search durable cache lands); Soft-complete still applies on read.

        Returns:
            Result dict with normalized people-search output and usage.
        """
        query = tool_call.get("query", "")
        mode = tool_call.get("mode", "discover")
        provider = tool_call.get("provider", "lantern")
        limit = tool_call.get("limit")
        fields = tool_call.get("fields")
        search_options = {
            target: tool_call[source]
            for source, target in (
                ("location", "location"),
                ("location_kind", "locationKind"),
                ("country_code", "countryCode"),
                ("companies", "companies"),
                ("titles", "titles"),
                ("cursor", "cursor"),
                ("source_record_id", "sourceRecordId"),
                ("generation", "generation"),
            )
            if tool_call.get(source) is not None
        }

        start_time = _safe_time()

        display_query = (
            query if len(query) <= QUERY_DISPLAY_MAX_LENGTH else query[: QUERY_DISPLAY_MAX_LENGTH - 3] + "..."
        )
        verb = "Enriching" if mode == "enrich" else "Searching for"
        search_title = f"{verb} people: {display_query}" if display_query else f"{verb} people"

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=search_title,
                message=f"Query: {display_query}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="people_search",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute people search activity
        try:
            logger.info("Calling people_search_activity", mode=mode, provider=provider, query_len=len(query))
            activity_args = [
                query,
                mode,
                provider,
                limit,
                fields,
                agent_id,
                world_model_mode,
                fast_mode_cache_enabled,
                fast_mode_goal,
                fast_mode_cache_write_enabled,
            ]
            if search_options or user_id:
                activity_args.append(search_options or None)
            if user_id:
                activity_args.append(user_id)
            result = await execute_activity(
                people_search_activity,
                args=activity_args,
                start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=RETRY_MAX_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            elapsed_time = _safe_time() - start_time
            cache_hit = isinstance(result, dict) and bool(result.get(DEMO_CACHE_HIT_FIELD))
            if cache_hit:
                result = {k: v for k, v in result.items() if k != DEMO_CACHE_HIT_FIELD}
            provider_used = result.get("provider_used", "") if isinstance(result, dict) else ""
            simulated = isinstance(result, dict) and bool(result.get("world_model_simulated"))
            total_cost_cents = 0.0 if cache_hit or simulated else _cost_for_provider(provider_used)

            message = format_tool_message(
                params=tool_call, result=result, time_elapsed=elapsed_time, cost_cents=total_cost_cents
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"People search: {display_query}" if display_query else "People search completed",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="people_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": (
                        []
                        if cache_hit or simulated
                        else [
                            {
                                "cost_cents": total_cost_cents,
                                "provider": f"People Search ({provider_used})" if provider_used else "People Search",
                            }
                        ]
                    ),
                },
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(params=tool_call, error=e, time_elapsed=elapsed_time, cost_cents=0)

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"❌ People search failed for {display_query}"
                    if display_query
                    else "❌ People search failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="people_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ========================================
# SINGLETON
# ========================================

_manager: PeopleSearchManager | None = None


def get_manager() -> PeopleSearchManager:
    """Get or create people search manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = PeopleSearchManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================


async def people_search(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
    world_model_mode: str = "real",
) -> dict[str, Any]:
    """Execute people search tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
        tool_call: Tool call dict with 'query', 'mode', 'provider', and optional
            'limit' / 'fields'.
        tool_call_id: Unique ID for this tool call.
        agent_id: Agent ID for event routing.
        user_id: User ID for usage tracking.

    Returns:
        Result dict with normalized people-search output and usage.
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
        world_model_mode=world_model_mode,
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
@traced("people_search_activity")
async def people_search_activity(
    query: str,
    mode: str,
    provider: str = "lantern",
    limit: Optional[int] = None,
    fields: Optional[List[str]] = None,
    agent_id: Optional[str] = None,
    world_model_mode: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
    search_options: Optional[dict[str, Any]] = None,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """Activity: Find people or retrieve source profiles through Lantern.

    Legacy provider names also execute through Lantern. Errors preserve plan,
    rate-limit and disambiguation details without switching providers.

    Fast Mode read: soft-complete without a live Lantern call. There is no
    durable people_search Fast Mode namespace yet (unlike web_search/web_fetch);
    falling through burned OAi-demo warm-path cents via People Search (parallel).

    Args:
        query: Natural-language people request.
        mode: 'enrich' (one person, field-level) or 'discover' (a list).
        provider: 'lantern'; legacy 'exa'/'parallel' activity inputs are accepted.
        limit: discover only; clamped to the public 1..25 range.
        fields: enrich only; the attributes to return for the person.
        agent_id / world_model_mode: World-model harness routing (precedes Fast
            Mode flags so older seven-arg payloads stay compatible).
        fast_mode_cache_enabled / fast_mode_goal: Fast Mode read switch.
        fast_mode_cache_write_enabled: Reserved; write-through still live until
            a people_search cache key exists.
        search_options: Structured constraints, exact cursor or source record ID.
            Appended to preserve historical positional activity payloads.
        user_id: Credential owner, supplied by the workflow rather than the model.

    Returns:
        Dict with query, mode_used, provider_used, providers_attempted, results, warnings.
    """
    from providers.demo_cache.client import soft_complete_allowed_for_agent

    read_cache = fast_mode_cache_enabled and bool(fast_mode_goal)
    if read_cache and await soft_complete_allowed_for_agent(agent_id, fast_mode_goal):
        logger.info(
            "demo_cache.people_search_soft_complete",
            query=query[:120],
            mode=mode,
            provider=provider,
        )
        return {
            "query": query,
            "mode_used": mode,
            "provider_used": "fast-mode-soft-complete",
            "providers_attempted": [],
            "results": [],
            "warnings": ["Fast Mode cache miss for people_search. Returning without a live provider call."],
            DEMO_CACHE_HIT_FIELD: True,
        }

    async def real_executor(_tool_name: str, _tool_args: dict[str, Any], _tool_call_id: str) -> dict[str, Any]:
        return await execute_people_search(
            query=query,
            mode=mode,
            provider=provider,
            limit=limit,
            fields=fields,
            search_options=search_options,
            user_id=user_id,
        )

    # Preserve the pre-FM contract: omitted / "real" mode allows live fallback.
    effective_wm = None if world_model_mode in (None, "real") else world_model_mode
    tool_args = {"query": query, "mode": mode, "provider": provider, "limit": limit, "fields": fields}
    if search_options:
        tool_args["search_options"] = search_options
    try:
        return await WorldModelToolExecutionAdapter.from_env(
            agent_id=agent_id,
            mode=effective_wm,
        ).execute(
            "people_search",
            tool_args,
            "people_search_activity",
            real_executor,
            allow_real_fallback=effective_wm is None,
        )
    except Exception:
        logger.error("People search failed", query=query, mode=mode, provider=provider)
        raise
