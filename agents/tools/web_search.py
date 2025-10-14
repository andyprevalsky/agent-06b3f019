"""Web search tool using OpenAI gpt-4.1 with real-time web search capability."""

from typing import Dict, Any, Optional, List
from temporalio import activity
import structlog
from openai import AsyncOpenAI

from config import load_config

logger = structlog.get_logger()


class WebSearcher:
    """
    Manager for web search operations using OpenAI's web search capability.
    
    Uses the Responses API with gpt-4.1 and web_search tool enabled for real-time web access.
    """
    
    def __init__(self):
        config = load_config()
        self.openai_client = AsyncOpenAI(api_key=config.openai.api_key)
        self.model = config.openai.model  # gpt-4.1
    
    async def search(self, query: str, max_tokens: int = 1500) -> Dict[str, Any]:
        """
        Perform web search using OpenAI gpt-4.1 with web_search tool.
        
        Args:
            query: Search query - can be a question or topic
            max_tokens: Maximum tokens for response (default: 1500)
            
        Returns:
            Dict with:
                - answer: Answer with real-time web search results
                - sources: List of source URLs (if available)
                - query: Original query
                - model: Model used
        """
        try:
            # Heartbeat (only works in activity context)
            try:
                activity.heartbeat(f"Web searching: {query}")
            except RuntimeError:
                pass  # Not in activity context (e.g., testing)
            
            # Call OpenAI Responses API with web_search tool
            # Note: Responses API doesn't support max_tokens parameter
            response = await self.openai_client.responses.create(
                model=self.model,
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
                "model": self.model,
            }
            
            logger.info(
                "Web search completed",
                query=query,
                answer_length=len(answer),
                model=self.model
            )
            
            return result
            
        except Exception as e:
            logger.error("Web search failed", error=str(e), query=query)
            raise


# Singleton instance
_web_searcher: Optional[WebSearcher] = None


def get_web_searcher() -> WebSearcher:
    """Get or create web searcher singleton."""
    global _web_searcher
    if _web_searcher is None:
        _web_searcher = WebSearcher()
    return _web_searcher


@activity.defn
async def web_search(query: str, max_tokens: int = 1500) -> Dict[str, Any]:
    """
    Activity: Perform a web search for quick facts and current information.
    
    Uses OpenAI's gpt-4o-search-preview model which has real-time web access
    to answer queries with up-to-date information.
    
    Best for: current events, factual lookups, recent news, latest information.
    
    Args:
        query: Search query or question
        max_tokens: Maximum tokens for response (default: 1500)
        
    Returns:
        Dict with:
            - answer: Answer with real-time web search results
            - sources: List of source URLs (if available)
            - query: Original query
            - model: Model used (gpt-4o-search-preview)
        
    Example:
        result = await web_search("What's the latest news about AI?")
        print(result["answer"])
    """
    searcher = get_web_searcher()
    return await searcher.search(query, max_tokens)


def format_pre_message(tool_call: Dict[str, Any]) -> Dict[str, str]:
    """Format the pre-execution message for web search."""
    query = tool_call.get("query", "")
    
    # Truncate long queries for display
    display_query = query if len(query) <= 100 else query[:97] + "..."
    
    return {
        "title": "🔍 Searching the web",
        "message": f"Query: {display_query}"
    }


def format_post_message(tool_call: Dict[str, Any], result: Any) -> Dict[str, str]:
    """Format the post-execution message for web search."""
    
    # Handle error case
    if isinstance(result, str):
        return {
            "title": "❌ Web search failed",
            "message": result
        }
    
    # Parse result dict
    if not isinstance(result, dict):
        return {
            "title": "Web search completed",
            "message": str(result)
        }
    
    answer = result.get("answer", "")
    sources = result.get("sources", [])
    
    # Build response with sources
    if sources:
        source_list = "\n".join([f"- {src}" for src in sources[:5]])  # Show max 5 sources
        if len(sources) > 5:
            source_list += f"\n- ...and {len(sources) - 5} more"
        
        message = f"{answer}\n\n**Sources:**\n{source_list}"
    else:
        message = answer
    
    return {
        "title": "Web search completed",
        "message": message
    }
