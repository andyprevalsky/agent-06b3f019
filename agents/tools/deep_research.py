"""
Deep research tool using Perplexity's sonar-deep-research model.
Migrated to new event-driven architecture.
"""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from datetime import timedelta
import structlog

from config import load_config
from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageItem, UsageType
from helpers.handle_tool_event import handle_tool_event

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


class DeepResearchManager(ToolManager):
    """Manager for deep research operations using Perplexity."""
    
    tool_name = "deep_research"
    read_only = True  # Research phase tool
    
    def __init__(self):
        # Don't initialize OpenAI client here - it uses threading.local which breaks Temporal
        # Client will be created inside the activity where it's safe
        self.model = "sonar-deep-research"
    
    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute deep research and post events via handle_tool_event.
        
        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'query', 'max_tokens'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict with report and citations
        """
        query = tool_call.get("query", "")
        max_tokens = tool_call.get("max_tokens", 8000)
        
        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔬 Conducting deep research",
                message=f"Topic: {query}\n\n*This may take several minutes as I analyze hundreds of sources...*",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="deep_research",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        
        # 2. Execute research activity (MOCKED - deep research disabled)
        try:
            # Mock result - deep research is currently disabled
            result = {
                "report": f"Deep research is currently disabled. Query was: {query}",
                "citations": [],
                "query": query,
                "model": "sonar-deep-research",
                "report_length": 0,
                "citation_count": 0,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "citation_tokens": 0,
                    "reasoning_tokens": 0,
                    "search_count": 0,
                }
            }
            # Original activity call (commented out):
            # result = await execute_activity(
            #     deep_research_activity,
            #     args=[query, max_tokens],
            #     start_to_close_timeout=timedelta(seconds=480)  # 8 minutes max
            # )
        except Exception as e:
            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Deep research failed",
                    message=str(e),
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="deep_research",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            return {"error": str(e)}
        
        # 3. Report usage (Perplexity's complex pricing)
        if result.get('usage'):
            usage = result['usage']
            usage_items = []
            
            # Input tokens: $2 per million = 200 cents per million
            if usage.get('input_tokens'):
                cost = (usage['input_tokens'] * 200) // 1_000_000
                usage_items.append(UsageItem(
                    type=UsageType.LLM,
                    cost_cents=cost,
                    provider="Perplexity Input Tokens",
                    number_of_tokens=usage['input_tokens'],
                    token_price_per_million_cents=200
                ))
            
            # Output tokens: $8 per million = 800 cents per million
            if usage.get('output_tokens'):
                cost = (usage['output_tokens'] * 800) // 1_000_000
                usage_items.append(UsageItem(
                    type=UsageType.LLM,
                    cost_cents=cost,
                    provider="Perplexity Output Tokens",
                    number_of_tokens=usage['output_tokens'],
                    token_price_per_million_cents=800
                ))
            
            # Citation tokens: $2 per million = 200 cents per million
            if usage.get('citation_tokens'):
                cost = (usage['citation_tokens'] * 200) // 1_000_000
                usage_items.append(UsageItem(
                    type=UsageType.LLM,
                    cost_cents=cost,
                    provider="Perplexity Citation Tokens",
                    number_of_tokens=usage['citation_tokens'],
                    token_price_per_million_cents=200
                ))
            
            # Reasoning tokens: $3 per million = 300 cents per million
            if usage.get('reasoning_tokens'):
                cost = (usage['reasoning_tokens'] * 300) // 1_000_000
                usage_items.append(UsageItem(
                    type=UsageType.LLM,
                    cost_cents=cost,
                    provider="Perplexity Reasoning Tokens",
                    number_of_tokens=usage['reasoning_tokens'],
                    token_price_per_million_cents=300
                ))
            
            # Search queries: $5 per 1,000 = 0.5 cents per search
            if usage.get('search_count'):
                cost = (usage['search_count'] * 5) // 10  # 0.5 cents per search
                usage_items.append(UsageItem(
                    type=UsageType.SERVICE,
                    cost_cents=cost,
                    provider="Perplexity Search Queries"
                ))
            
            # Emit usage event
            if usage_items:
                await handle_tool_event(
                    event=ToolEvent(
                        type=EventType.USAGE,
                        tool_name=self.tool_name,
                        usage_items=usage_items
                    ),
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="deep_research",
                    execute_activity=execute_activity,
                    user_id=user_id,
                )
        
        # 4. Success status with report
        report = result.get("report", "")
        citations = result.get("citations", [])
        citation_count = result.get("citation_count", len(citations))
        
        if citation_count > 0:
            message = f"{report}\n\n*Research complete with {citation_count} citation{'s' if citation_count != 1 else ''}*"
        else:
            message = report
        
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Deep research completed",
                message=message,
                status=MessageStatus.FINISHED
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="deep_research",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        
        return result


# ========================================
# ACTIVITY IMPLEMENTATION
# ========================================

@activity.defn
async def deep_research_activity(query: str, max_tokens: int = 8000) -> Dict[str, Any]:
    """
    Activity: Perform deep research using Perplexity API.
    
    Returns result with usage data for event-driven reporting.
    
    Note: Default max_tokens increased to 8000 to allow for more comprehensive
    reports. Deep research can take 30-120 seconds regardless of length.
    """
    # Import OpenAI here to avoid threading.local issues in workflow context
    from openai import AsyncOpenAI
    
    try:
        # Heartbeat
        try:
            activity.heartbeat(f"Deep researching: {query}")
        except RuntimeError:
            pass  # Not in activity context (testing)
        
        config = load_config()
        # Create client inside activity - safe from Temporal determinism constraints
        client = AsyncOpenAI(
            api_key=config.perplexity.api_key,
            base_url="https://api.perplexity.ai"
        )
        
        # Call Perplexity's deep research model
        response = await client.chat.completions.create(
            model="sonar-deep-research",
            messages=[
                {
                    "role": "system",
                    "content": "You are a thorough research assistant. Conduct comprehensive, multi-step research on the topic. Evaluate sources critically, synthesize findings, and provide well-cited reports with clear structure and evidence. Always include citations and sources in your response. Format your response with markdown."
                },
                {
                    "role": "user",
                    "content": query
                }
            ],
            max_tokens=max_tokens,
            temperature=0.2,  # Low temperature for factual research
        )
        
        report = response.choices[0].message.content
        
        # Extract citations
        citations = []
        if hasattr(response, 'citations') and response.citations:
            citations = response.citations
        elif hasattr(response.choices[0].message, 'citations') and response.choices[0].message.citations:
            citations = response.choices[0].message.citations
        
        # Extract usage (Perplexity returns detailed usage)
        usage = None
        if hasattr(response, 'usage') and response.usage:
            usage = {
                "input_tokens": getattr(response.usage, 'prompt_tokens', 0),
                "output_tokens": getattr(response.usage, 'completion_tokens', 0),
                "citation_tokens": getattr(response.usage, 'citation_tokens', 0),
                "reasoning_tokens": getattr(response.usage, 'reasoning_tokens', 0),
                "search_count": getattr(response.usage, 'num_search_queries', 0),
            }
        
        result = {
            "report": report,
            "citations": citations,
            "query": query,
            "model": "sonar-deep-research",
            "report_length": len(report),
            "citation_count": len(citations),
            "usage": usage
        }
        
        logger.info(
            "Deep research completed",
            query=query,
            report_length=len(report),
            citation_count=len(citations),
            has_usage=usage is not None
        )
        
        return result
        
    except Exception as e:
        logger.error("Deep research failed", error=str(e), query=query)
        raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[DeepResearchManager] = None


def get_manager() -> DeepResearchManager:
    """Get or create deep research manager singleton."""
    global _manager
    if _manager is None:
        _manager = DeepResearchManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def deep_research(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute deep_research tool.
    
    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'query', 'max_tokens'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict with report and citations
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
