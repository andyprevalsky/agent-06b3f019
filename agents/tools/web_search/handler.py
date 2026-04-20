"""Web search handler -- thin entry point for tool execution and Temporal activity."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Optional

import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from helpers.tracing import traced
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message
from tools.web_search.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    COST_CENTS_PER_QUERY,
    QUERY_DISPLAY_MAX_LENGTH,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_INTERVAL_SECONDS,
)
from tools.web_search.service import execute_search

if TYPE_CHECKING:
    from tools.web_search.types import ExecuteActivityCallable

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


class WebSearchManager(ToolManager):
    """Manager for web search operations using Parallel AI's search capability."""

    tool_name = "web_search"
    read_only = True  # Research phase tool

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute web search and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
            tool_call: Tool call dict with 'query' and optional 'max_tokens'.
            tool_call_id: Unique ID for this tool call.
            agent_id: Agent ID for event routing.
            user_id: User ID for usage tracking.

        Returns:
            Result dict with answer, sources, query, model.
        """
        query = tool_call.get("query", "")
        max_tokens = tool_call.get("max_tokens", 1500)

        start_time = _safe_time()

        # Truncate long queries for display
        display_query = (
            query if len(query) <= QUERY_DISPLAY_MAX_LENGTH else query[: QUERY_DISPLAY_MAX_LENGTH - 3] + "..."
        )

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Searching the web",
                message=f"Query: {display_query}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="web_search",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute web search activity
        try:
            logger.info("Calling web_search_activity", query_type=type(query).__name__, query_len=len(query))
            result = await execute_activity(
                web_search_activity,
                args=[query, max_tokens],
                start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=RETRY_MAX_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            total_cost_cents = COST_CENTS_PER_QUERY

            message = format_tool_message(
                params=tool_call, result=result, time_elapsed=elapsed_time, cost_cents=total_cost_cents
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Web search completed",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": total_cost_cents, "provider": "Parallel AI Search"}],
                },
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(params=tool_call, error=e, time_elapsed=elapsed_time, cost_cents=0)

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="\u274c Web search failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ========================================
# SINGLETON
# ========================================

_manager: WebSearchManager | None = None


def get_manager() -> WebSearchManager:
    """Get or create web search manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = WebSearchManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================


async def web_search(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """Execute web search tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity.
        tool_call: Tool call dict with 'query' and optional 'max_tokens'.
        tool_call_id: Unique ID for this tool call.
        agent_id: Agent ID for event routing.
        user_id: User ID for usage tracking.

    Returns:
        Result dict with answer, sources, query, model.
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
@traced("web_search_activity")
async def web_search_activity(query: str, max_tokens: int = 1500) -> dict[str, Any]:
    """Activity: Perform a web search for quick facts and current information.

    Uses Parallel AI's search API for real-time web access.

    Best for: current events, factual lookups, recent news, latest information.

    Args:
        query: Search query or question.
        max_tokens: Maximum tokens for response (default: 1500).

    Returns:
        Dict with answer, sources, query, and provider.
    """
    try:
        return await execute_search(query=query, max_tokens=max_tokens)
    except Exception:
        logger.error("Web search failed", query=query)
        raise
