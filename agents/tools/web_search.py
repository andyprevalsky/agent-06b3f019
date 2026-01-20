"""Web search tool - migrated to event-driven architecture."""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageItem, UsageType, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event

# Config import is safe - no side effects at import time (load_dotenv is lazy)
import time
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0

logger = structlog.get_logger()


class WebSearchManager(ToolManager):
    """Manager for web search operations using Parallel AI's search capability."""
    
    tool_name = "web_search"
    read_only = True  # Research phase tool
    
    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute web search and post events via handle_tool_event.
        
        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'query' and optional 'max_tokens'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict with answer, sources, query, model
        """
        query = tool_call.get("query", "")
        max_tokens = tool_call.get("max_tokens", 1500)
        
        # Track start time for elapsed time calculation
        start_time = _safe_time()
        
        # Truncate long queries for display
        display_query = query if len(query) <= 100 else query[:97] + "..."
        
        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔍 Searching the web",
                message=f"Query: {display_query}",
                status=MessageStatus.IN_PROGRESS
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
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            # Parallel AI Search pricing: $0.005 for 10 results = 0.5 cents flat
            total_cost_cents = 0.5
            
            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents
            )
            
            # Post-execution success
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Web search completed",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Track usage for billing
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.USAGE,
                    tool_name="web_search",
                    usage_items=[
                        UsageItem(
                            type=UsageType.SERVICE,
                            cost_cents=total_cost_cents,
                            provider="Parallel AI Search"
                        )
                    ]
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return result
            
        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time

            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Web search failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Re-raise so workflow knows the tool failed (like spawn_browser_agent)
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[WebSearchManager] = None


def get_manager() -> WebSearchManager:
    """Get or create web search manager singleton."""
    global _manager
    if _manager is None:
        _manager = WebSearchManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def web_search(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute web search tool.
    
    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'query' and optional 'max_tokens'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict with answer, sources, query, model
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

def _format_search_results(results: list) -> str:
    """Format Parallel AI search results into a readable answer."""
    if not results:
        return "No results found."

    formatted_parts = []
    for r in results:
        title = r.get("title", "")
        excerpts = r.get("excerpts", [])
        excerpt_text = "\n".join(excerpts) if isinstance(excerpts, list) else str(excerpts)

        if title and excerpt_text:
            formatted_parts.append(f"**{title}**\n{excerpt_text}")
        elif excerpt_text:
            formatted_parts.append(excerpt_text)

    return "\n\n".join(formatted_parts) if formatted_parts else "No relevant content found."


@activity.defn
async def web_search_activity(query: str, max_tokens: int = 1500) -> Dict[str, Any]:
    """
    Activity: Perform a web search for quick facts and current information.

    Uses Parallel AI's search API for real-time web access.

    Best for: current events, factual lookups, recent news, latest information.

    Args:
        query: Search query or question
        max_tokens: Maximum tokens for response (default: 1500)

    Returns:
        Dict with:
            - answer: Answer with real-time web search results
            - sources: List of source URLs (if available)
            - query: Original query
            - provider: Provider used
    """
    try:
        activity.heartbeat(f"Web searching: {query}")

        config = load_config()
        api_key = config.parallel.api_key

        headers = {
            "x-api-key": api_key,
            "parallel-beta": "search-extract-2025-10-10",
            "Content-Type": "application/json"
        }

        payload = {
            "objective": query,
            "search_queries": [query],
            "max_results": 10,
            "excerpts": {"max_chars_per_result": max_tokens * 4}
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.parallel.ai/v1beta/search",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            data = response.json()

        results = data.get("results", [])

        # Format results into answer
        answer = _format_search_results(results)

        # Extract sources
        sources = [r.get("url") for r in results if r.get("url")]

        result = {
            "answer": answer,
            "sources": sources,
            "query": query,
            "provider": "parallel-ai",
        }

        logger.info(
            "Web search completed",
            query=query,
            answer_length=len(answer),
            results_count=len(results)
        )

        return result

    except Exception as e:
        logger.error("Web search failed", error=str(e), query=query)
        raise

