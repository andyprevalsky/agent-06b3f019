"""Web search tool - migrated to event-driven architecture."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
from openai import AsyncOpenAI
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message

# Import config with safe imports to avoid sandbox restrictions
with workflow.unsafe.imports_passed_through():
    from config import load_config

logger = structlog.get_logger()


class WebSearchManager(ToolManager):
    """Manager for web search operations using OpenAI's web search capability."""
    
    tool_name = "web_search"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute web search and yield events.
        
        Yields:
            - Pre-execution status with query
            - Post-execution status with results and sources
        """
        query = tool_call.get("query", "")
        max_tokens = tool_call.get("max_tokens", 1500)
        
        # Track start time for elapsed time calculation
        start_time = time.time()
        
        # Truncate long queries for display
        display_query = query if len(query) <= 100 else query[:97] + "..."
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="🔍 Searching the web",
            message=f"Query: {display_query}",
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Execute web search activity
        try:
            logger.info("Calling web_search_activity", query_type=type(query).__name__, query_len=len(query))
            result = await workflow.execute_activity(
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
            elapsed_time = time.time() - start_time
            # Estimate cost - OpenAI Responses API pricing (adjust based on actual pricing)
            # For now, estimate minimal cost
            total_cost_cents = 0  # Will need to calculate based on actual API pricing
            
            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents
            )
            
            # Post-execution success
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Web search completed",
                message=message,
                status=MessageStatus.FINISHED
            )
            
        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = time.time() - start_time
            
            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )
            
            # Error status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Web search failed",
                message=error_message,
                status=MessageStatus.ERROR
            )
            # Don't raise - error event already posted the formatted message


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
# WORKFLOW HELPER
# ========================================

async def web_search(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for web search (new event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'query' and optional 'max_tokens'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "web_search")


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

