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
from providers.fast_cache import client as fast_cache_client
from providers.fast_cache import normalize as fast_cache_normalize
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message
from tools.web_search.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    COST_CENTS_PER_QUERY,
    DEFAULT_MAX_TOKENS,
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
FAST_CACHE_HIT_FIELD = "_fast_cache_hit"


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
        fast_mode_cache_enabled: bool = False,
        fast_mode_goal: Optional[str] = None,
        fast_mode_cache_write_enabled: bool = False,
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
        max_tokens = tool_call.get("max_tokens", DEFAULT_MAX_TOKENS)

        start_time = _safe_time()

        # Truncate long queries for display
        display_query = (
            query if len(query) <= QUERY_DISPLAY_MAX_LENGTH else query[: QUERY_DISPLAY_MAX_LENGTH - 3] + "..."
        )
        search_title = f"Searching the web for {display_query}" if display_query else "Searching the web"

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
            tool_name="web_search",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute web search activity
        try:
            logger.info("Calling web_search_activity", query_type=type(query).__name__, query_len=len(query))
            result = await execute_activity(
                web_search_activity,
                args=[query, max_tokens, fast_mode_cache_enabled, fast_mode_goal, fast_mode_cache_write_enabled],
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
            cache_hit = isinstance(result, dict) and bool(result.get(FAST_CACHE_HIT_FIELD))
            if cache_hit:
                result = {k: v for k, v in result.items() if k != FAST_CACHE_HIT_FIELD}
            total_cost_cents = 0 if cache_hit else COST_CENTS_PER_QUERY

            message = format_tool_message(
                params=tool_call, result=result, time_elapsed=elapsed_time, cost_cents=total_cost_cents
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Searched the web for {display_query}" if display_query else "Web search completed",
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
                    "service": (
                        [] if cache_hit else [{"cost_cents": total_cost_cents, "provider": "Parallel AI Search"}]
                    ),
                },
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(params=tool_call, error=e, time_elapsed=elapsed_time, cost_cents=0)

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"\u274c Web search failed for {display_query}" if display_query else "\u274c Web search failed",
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
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
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
        fast_mode_cache_enabled=fast_mode_cache_enabled,
        fast_mode_goal=fast_mode_goal,
        fast_mode_cache_write_enabled=fast_mode_cache_write_enabled,
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
@traced("web_search_activity")
async def web_search_activity(
    query: str,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
) -> dict[str, Any]:
    """Activity: Perform a web search for quick facts and current information.

    Uses Parallel AI's search API for real-time web access.

    Best for: current events, factual lookups, recent news, latest information.

    Args:
        query: Search query or question.
        max_tokens: Maximum tokens for response. Defaults to DEFAULT_MAX_TOKENS
            (source-of-truth cap in tools/web_search/config.py).
        fast_mode_cache_enabled / fast_mode_goal: Fast Mode read/replay switch.
        fast_mode_cache_write_enabled: Write-through switch for allowlisted
            accounts. When true and reads are off, the live provider result is
            stored without first checking cache.

    Returns:
        Dict with answer, sources, query, and provider.
    """
    read_cache = fast_mode_cache_enabled and bool(fast_mode_goal)
    write_cache = (fast_mode_cache_enabled or fast_mode_cache_write_enabled) and bool(fast_mode_goal)
    cache_key = (
        fast_cache_normalize.web_search_key(fast_mode_goal, query, max_tokens) if write_cache else None
    )
    if cache_key is not None and read_cache:
        stored = await fast_cache_client.cache_get(cache_key)
        if stored is not None:
            logger.info("fast_cache.web_search_hit", key=cache_key)
            if isinstance(stored, dict):
                return {**stored, FAST_CACHE_HIT_FIELD: True}
            return stored
        logger.info("fast_cache.web_search_miss", key=cache_key)
    elif cache_key is not None:
        logger.info("fast_cache.web_search_write_only", key=cache_key)

    try:
        result = await execute_search(query=query, max_tokens=max_tokens)
    except Exception:
        logger.error("Web search failed", query=query)
        raise

    if cache_key is not None and write_cache:
        await fast_cache_client.cache_set(
            cache_key, "web_search", fast_cache_normalize.goal_hash(fast_mode_goal), result
        )
        logger.info("fast_cache.web_search_stored", key=cache_key)
    return result
