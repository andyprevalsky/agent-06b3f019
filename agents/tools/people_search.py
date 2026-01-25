"""Exa people search tool - search for people using Exa's people index."""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event
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


class ExaPeopleSearchManager(ToolManager):
    """Manager for searching people using Exa's people search API."""

    tool_name = "people_search"
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
        Execute Exa people search and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'query' and optional 'max_results'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking

        Returns:
            Result dict with candidates, query, provider
        """
        query = tool_call.get("query", "")
        max_results = tool_call.get("max_results", 10)

        # Track start time for elapsed time calculation
        start_time = _safe_time()

        # Truncate long queries for display
        display_query = query if len(query) <= 100 else query[:97] + "..."

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Searching for people",
                message=f"Query: {display_query}",
                status=MessageStatus.IN_PROGRESS
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
                    maximum_interval=timedelta(seconds=10)
                )
            )

            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            # Exa pricing: $5/1000 search = 0.5 cents + $1/1000 text content = 0.1 cents/result
            num_results = len(result.get("candidates", []))
            total_cost_cents = 0.5 + (num_results * 0.1)

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
                    title="People search completed",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="people_search",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Return with standardized usage for workflow cost tracking
            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": int(total_cost_cents), "provider": "Exa People Search"}],
                }
            }

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
                    title="People search failed",
                    message=error_message,
                    status=MessageStatus.ERROR
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
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
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


# ========================================
# TEMPORAL ACTIVITY
# ========================================

def _format_person_result(person: Dict[str, Any]) -> str:
    """Format a single person result into readable text."""
    title = person.get("title", "Unknown")
    url = person.get("url", "")
    text = person.get("text", "")

    parts = [f"**{title}**"]
    if url:
        parts.append(f"URL: {url}")
    if text:
        # Truncate very long text
        truncated_text = text[:2000] + "..." if len(text) > 2000 else text
        parts.append(truncated_text)

    return "\n".join(parts)


@activity.defn
async def people_search_activity(query: str, max_results: int = 10) -> Dict[str, Any]:
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
    try:
        activity.heartbeat(f"Searching for people: {query}")

        config = load_config()
        api_key = config.exa.api_key

        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }

        payload = {
            "query": query,
            "category": "people",
            "numResults": max_results,
            "contents": {
                "text": {"maxCharacters": 5000}
            }
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.exa.ai/search",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            data = response.json()

        results = data.get("results", [])

        # Format results for LLM consumption
        formatted_results = []
        for r in results:
            formatted_results.append({
                "name": r.get("author", r.get("title", "Unknown")),
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "profile_text": r.get("text", ""),
                "image": r.get("image", ""),
            })

        # Also create a readable summary
        summary_parts = []
        for r in results:
            summary_parts.append(_format_person_result(r))

        summary = "\n\n---\n\n".join(summary_parts) if summary_parts else "No people found."

        result = {
            "candidates": formatted_results,
            "answer": summary,  # Using 'answer' so format_result displays it in UI
            "query": query,
            "provider": "exa",
            "results_count": len(results),
        }

        logger.info(
            "Exa people search completed",
            query=query,
            results_count=len(results)
        )

        return result

    except Exception as e:
        logger.error("Exa people search failed", error=str(e), query=query)
        raise
