"""Web fetch tool - fetch and extract content from a URL with JavaScript rendering support."""

from typing import Dict, Any, Optional, Callable, Awaitable, List
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event

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


class WebFetchManager(ToolManager):
    """Manager for web fetch operations using Parallel AI's extract capability."""

    tool_name = "web_fetch"
    read_only = True  # Research phase tool
    condensor_enabled = True  # Condense results before adding to context

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute web fetch and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'url', 'objective', optional 'excerpts', 'full_content'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking

        Returns:
            Result dict with content, sources, objective
        """
        url = tool_call.get("url", "")
        objective = tool_call.get("objective", "")
        excerpts = tool_call.get("excerpts", True)
        full_content = tool_call.get("full_content", False)

        # Track start time for elapsed time calculation
        start_time = _safe_time()

        # Truncate long objective for display
        display_objective = objective if len(objective) <= 100 else objective[:97] + "..."

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🌐 Fetching web content",
                message=f"Extracting from {url}: {display_objective}",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="web_fetch",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute web fetch activity
        try:
            logger.info("Calling web_fetch_activity", url=url, objective_len=len(objective))
            result = await execute_activity(
                web_fetch_activity,
                args=[url, objective, excerpts, full_content],
                start_to_close_timeout=timedelta(seconds=120),  # Longer timeout for JS rendering
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )

            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            # Parallel AI Extract pricing: ~$0.005 per URL
            total_cost_cents = 0.5

            # Only post FINISHED if condensor won't handle it
            # (condensor posts its own FINISHED with condensed result)
            if not self.condensor_enabled:
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
                        title="Web fetch completed",
                        message=message,
                        status=MessageStatus.FINISHED
                    ),
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="web_fetch",
                    execute_activity=execute_activity,
                    user_id=user_id,
                )

            # Return with standardized usage for workflow cost tracking
            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": total_cost_cents, "provider": "Parallel AI Extract"}],
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
                    title="❌ Web fetch failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_fetch",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Re-raise so workflow knows the tool failed (like spawn_browser_agent)
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[WebFetchManager] = None


def get_manager() -> WebFetchManager:
    """Get or create web fetch manager singleton."""
    global _manager
    if _manager is None:
        _manager = WebFetchManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def web_fetch(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute web fetch tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'url', 'objective', optional 'excerpts', 'full_content'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with content, sources, objective
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

def _format_extract_results(results: List[Dict[str, Any]], full_content: bool) -> str:
    """Format Parallel AI extract results into a readable answer."""
    if not results:
        return "No content extracted."

    formatted_parts = []
    for r in results:
        url = r.get("url", "")
        title = r.get("title", "")

        if full_content:
            content = r.get("full_content", "")
        else:
            excerpts = r.get("excerpts", [])
            content = "\n".join(excerpts) if isinstance(excerpts, list) else str(excerpts)

        if title and content:
            formatted_parts.append(f"**{title}** ({url})\n{content}")
        elif content:
            formatted_parts.append(f"**{url}**\n{content}")

    return "\n\n---\n\n".join(formatted_parts) if formatted_parts else "No relevant content found."


@activity.defn
async def web_fetch_activity(
    url: str,
    objective: str,
    excerpts: bool = True,
    full_content: bool = False
) -> Dict[str, Any]:
    """
    Activity: Fetch and extract content from a URL with JavaScript rendering support.

    Uses Parallel AI's extract API for content extraction from JS-rendered pages.

    Best for: SPAs, dynamic content, pages requiring JavaScript to load.

    Args:
        url: URL to fetch and extract from
        objective: What content to focus on extracting
        excerpts: Return focused excerpts (default: True)
        full_content: Return complete page content (default: False)

    Returns:
        Dict with:
            - content: Extracted content from the URL
            - sources: List of source URLs
            - objective: Original objective
            - results: Raw results from API
    """
    try:
        activity.heartbeat(f"Fetching {url}: {objective[:50]}...")

        config = load_config()
        api_key = config.parallel.api_key

        headers = {
            "x-api-key": api_key,
            "parallel-beta": "search-extract-2025-10-10",
            "Content-Type": "application/json"
        }

        # Parallel AI API requires urls as an array
        payload = {
            "urls": [url],
            "objective": objective,
            "excerpts": excerpts,
            "full_content": full_content
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                "https://api.parallel.ai/v1beta/extract",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            data = response.json()

        results = data.get("results", [])
        errors = data.get("errors", [])

        # Log any errors from the API
        if errors:
            logger.warning("Web fetch had errors", errors=errors)

        # Format results into content
        content = _format_extract_results(results, full_content)

        # Extract successful sources
        sources = [r.get("url") for r in results if r.get("url")]

        result = {
            "content": content,
            "sources": sources,
            "objective": objective,
            "results": results,
            "errors": errors,
        }

        logger.info(
            "Web fetch completed",
            url=url,
            objective=objective[:100],
            content_length=len(content),
            results_count=len(results),
            errors_count=len(errors)
        )

        return result

    except Exception as e:
        logger.error("Web fetch failed", error=str(e), url=url, objective=objective)
        raise
