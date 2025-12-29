"""Web search tool - migrated to event-driven architecture."""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
from openai import AsyncOpenAI

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
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
    """Manager for web search operations using OpenAI's web search capability."""
    
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
            total_cost_cents = 0  # Will need to calculate based on actual API pricing
            
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
            
            return {"error": str(e), "query": query}


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

@activity.defn
async def web_search_activity(query: str, max_tokens: int = 1500) -> Dict[str, Any]:
    """
    Activity: Perform a web search for quick facts and current information.
    
    Uses OpenAI's gpt-4.1 model with web_search tool enabled for real-time web access.
    
    Best for: current events, factual lookups, recent news, latest information.
    
    Args:
        query: Search query or question
        max_tokens: Maximum tokens for response (default: 1500)
        
    Returns:
        Dict with:
            - answer: Answer with real-time web search results
            - sources: List of source URLs (if available)
            - query: Original query
            - model: Model used
    """
    try:
        activity.heartbeat(f"Web searching: {query}")
        
        config = load_config()
        openai_client = AsyncOpenAI(api_key=config.openai.api_key)
        model = config.openai.model  # gpt-4.1
        
        # Call OpenAI Responses API with web_search tool
        # Note: Responses API doesn't support max_tokens parameter
        response = await openai_client.responses.create(
            model=model,
            tools=[{"type": "web_search"}],
            input=query
        )
        
        # Extract answer from response
        answer = response.output_text
        
        # Extract sources if available
        sources = []
        if hasattr(response, 'sources'):
            sources = response.sources
        
        result = {
            "answer": answer,
            "sources": sources,
            "query": query,
            "model": model,
        }
        
        logger.info(
            "Web search completed",
            query=query,
            answer_length=len(answer),
            model=model
        )
        
        return result
        
    except Exception as e:
        logger.error("Web search failed", error=str(e), query=query)
        raise

