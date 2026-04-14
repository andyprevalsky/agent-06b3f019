"""People search domain handler - tool entry point and Temporal activity."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Optional

import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message

from .config import DEFAULT_MAX_RESULTS, QUERY_DISPLAY_MAX_LENGTH
from .service import calculate_cost_cents, execute_people_search

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
async def people_search_activity(query: str, max_results: int = DEFAULT_MAX_RESULTS) -> dict[str, Any]:
    """
    Activity: Search for people using Exa's people search API.

    Uses Exa's people category to find professionals by name, role, company, or skills.

    Best for: finding people, professionals, executives, experts in specific fields.

    Args:
        query: Natural language query describing the person (e.g., "Andy Prevalsky", "VP Engineering at Google")
        max_results: Maximum number of results to return (1-100, default: 10)

    Returns:
        Dict with:
            - candidates: List of people results with profile data
            - query: Original query
            - provider: "exa"
    """
    activity.heartbeat(f"Searching for people: {query}")
    return await execute_people_search(query, max_results)


# ========================================
# TOOL MANAGER
# ========================================


class ExaPeopleSearchManager(ToolManager):
    """Manager for searching people using Exa's people search API."""

    tool_name = "people_search"
    read_only = True  # Research phase tool

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute Exa people search and post events via handle_tool_event."""
        query = tool_call.get("query", "")
        max_results = tool_call.get("max_results", DEFAULT_MAX_RESULTS)

        start_time = _safe_time()

        # Truncate long queries for display
        display_query = (
            query if len(query) <= QUERY_DISPLAY_MAX_LENGTH else query[: QUERY_DISPLAY_MAX_LENGTH - 3] + "..."
        )

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Searching for people",
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
            logger.info("Calling people_search_activity", query=query, max_results=max_results)
            result = await execute_activity(
                people_search_activity,
                args=[query, max_results],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )

            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            num_results = len(result.get("candidates", []))
            total_cost_cents = calculate_cost_cents(num_results)

            message = format_tool_message(
                params=tool_call, result=result, time_elapsed=elapsed_time, cost_cents=total_cost_cents
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="People search completed",
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
                    "service": [{"cost_cents": int(total_cost_cents), "provider": "Exa People Search"}],
                },
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time
            error_message = format_error_message(params=tool_call, error=e, time_elapsed=elapsed_time, cost_cents=0)

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="People search failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="people_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {"error": str(e), "query": query}


# ========================================
# SINGLETON
# ========================================

_manager: Optional[ExaPeopleSearchManager] = None


def get_manager() -> ExaPeopleSearchManager:
    """Get or create exa people search manager singleton."""
    global _manager
    if _manager is None:
        _manager = ExaPeopleSearchManager()
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
    """
    Execute people_search tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'query' and optional 'max_results'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with candidates, query, provider
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
