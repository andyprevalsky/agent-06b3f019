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
    EXA_COST_CENTS_PER_QUERY,
    PARALLEL_COST_CENTS_PER_QUERY,
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


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _cost_for_provider(provider: str) -> float:
    """Map the routed provider to its flat per-query cost in cents."""
    if provider == "exa":
        return EXA_COST_CENTS_PER_QUERY
    if provider == "parallel":
        return PARALLEL_COST_CENTS_PER_QUERY
    return 0.0


class PeopleSearchManager(ToolManager):
    """Manager for people search across Exa and Parallel (enrich + discover)."""

    tool_name = "people_search"
    read_only = True  # Research phase tool (explore agents only)

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute people search and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
            tool_call: Tool call dict with 'query', 'mode', 'provider', and
                optional 'limit' (discover) / 'fields' (enrich).
            tool_call_id: Unique ID for this tool call.
            agent_id: Agent ID for event routing.
            user_id: User ID for usage tracking.

        Returns:
            Result dict with normalized people-search output and usage.
        """
        query = tool_call.get("query", "")
        mode = tool_call.get("mode", "discover")
        provider = tool_call.get("provider", "exa")
        limit = tool_call.get("limit")
        fields = tool_call.get("fields")

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
            result = await execute_activity(
                people_search_activity,
                args=[query, mode, provider, limit, fields],
                start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=RETRY_MAX_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            elapsed_time = _safe_time() - start_time
            provider_used = result.get("provider_used", "") if isinstance(result, dict) else ""
            total_cost_cents = _cost_for_provider(provider_used)

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
                    "service": [
                        {
                            "cost_cents": total_cost_cents,
                            "provider": f"People Search ({provider_used})" if provider_used else "People Search",
                        }
                    ],
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
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
@traced("people_search_activity")
async def people_search_activity(
    query: str,
    mode: str,
    provider: str,
    limit: Optional[int] = None,
    fields: Optional[List[str]] = None,
) -> dict[str, Any]:
    """Activity: Find or enrich people via Exa or Parallel (sync, sub-minute).

    Routing is (mode x provider), both chosen explicitly by the model. On a
    rate-limit or transport error the tool auto-retries the other provider.
    Returns one normalized envelope regardless of provider.

    Args:
        query: Natural-language people request.
        mode: 'enrich' (one person, field-level) or 'discover' (a list).
        provider: 'exa' or 'parallel'.
        limit: discover only; clamped to the public 1..25 range.
        fields: enrich only; the attributes to return for the person.

    Returns:
        Dict with query, mode_used, provider_used, providers_attempted, results, warnings.
    """
    async def real_executor(_tool_name: str, _tool_args: dict[str, Any], _tool_call_id: str) -> dict[str, Any]:
        return await execute_people_search(
            query=query,
            mode=mode,
            provider=provider,
            limit=limit,
            fields=fields,
        )

    try:
        return await WorldModelToolExecutionAdapter.from_env().execute(
            "people_search",
            {"query": query, "mode": mode, "provider": provider, "limit": limit, "fields": fields},
            "people_search_activity",
            real_executor,
        )
    except Exception:
        logger.error("People search failed", query=query, mode=mode, provider=provider)
        raise
