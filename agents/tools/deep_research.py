"""Deep research tool using Perplexity's sonar-deep-research model."""

from typing import Dict, Any, Optional, List
from temporalio import activity
import structlog
from openai import AsyncOpenAI

from config import load_config

logger = structlog.get_logger()


class DeepResearcher:
    """Manager for deep research operations using Perplexity."""
    
    def __init__(self):
        config = load_config()
        # Perplexity uses OpenAI-compatible API
        self.client = AsyncOpenAI(
            api_key=config.perplexity.api_key,
            base_url="https://api.perplexity.ai"
        )
        self.model = "sonar-deep-research"
    
    async def research(
        self,
        query: str,
        max_tokens: int = 4000
    ) -> Dict[str, Any]:
        """
        Perform deep, multi-step research on complex topics.
        
        This conducts thorough research by:
        - Breaking down complex queries into sub-questions
        - Searching and evaluating multiple sources
        - Synthesizing findings into a comprehensive report
        - Providing citations for all claims
        
        Args:
            query: Research topic or question (can be complex/multi-faceted)
            max_tokens: Maximum tokens for response (default: 4000)
            
        Returns:
            Dict with:
                - report: Comprehensive research report
                - citations: List of cited sources with URLs
                - query: Original query
                
        Note: This can take 30-120 seconds for complex queries.
        """
        try:
            # Heartbeat (only works in activity context)
            try:
                activity.heartbeat(f"Deep researching: {query}")
            except RuntimeError:
                pass  # Not in activity context (e.g., testing)
            
            # Call Perplexity's deep research model
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a thorough research assistant. Conduct comprehensive, multi-step research on the topic. Evaluate sources critically, synthesize findings, and provide well-cited reports with clear structure and evidence. Always include citations and sources in your response."
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
            
            # Extract citations from response
            citations = []
            if hasattr(response, 'citations') and response.citations:
                citations = response.citations
            elif hasattr(response.choices[0].message, 'citations') and response.choices[0].message.citations:
                citations = response.choices[0].message.citations
            
            result = {
                "report": report,
                "citations": citations,
                "query": query,
                "model": self.model,
                "report_length": len(report),
                "citation_count": len(citations)
            }
            
            logger.info(
                "Deep research completed",
                query=query,
                report_length=len(report),
                citation_count=len(citations)
            )
            
            return result
            
        except Exception as e:
            logger.error("Deep research failed", error=str(e), query=query)
            raise


# Singleton instance
_deep_researcher: Optional[DeepResearcher] = None


def get_deep_researcher() -> DeepResearcher:
    """Get or create deep researcher singleton."""
    global _deep_researcher
    if _deep_researcher is None:
        _deep_researcher = DeepResearcher()
    return _deep_researcher


@activity.defn
async def deep_research(
    query: str,
    max_tokens: int = 4000
) -> Dict[str, Any]:
    """
    Activity: Perform deep, multi-step research on complex topics.
    
    Uses Perplexity's sonar-deep-research model to conduct thorough research
    with multiple search steps, source evaluation, and synthesis.
    
    Best for:
    - Complex research questions requiring multiple sources
    - Comparative analysis (e.g., "Compare X vs Y")
    - In-depth topic exploration
    - Market research and competitive analysis
    - Technical deep dives
    
    Not needed for:
    - Simple facts (use web_search instead)
    - Current events (use web_search instead)
    - Quick lookups (use web_search instead)
    
    Args:
        query: Research topic or question
        max_tokens: Maximum tokens for response (default: 4000)
        
    Returns:
        Dict with comprehensive report, citations, and metadata
        
    Example:
        result = await deep_research(
            "Compare the pros and cons of PostgreSQL vs MongoDB for a SaaS application"
        )
        print(result["report"])
        print(f"Citations: {len(result['citations'])}")
        
    Note: This tool can take 30-120 seconds to complete due to multi-step research.
    """
    researcher = get_deep_researcher()
    return await researcher.research(query, max_tokens)


def format_pre_message(tool_call: Dict[str, Any]) -> Dict[str, str]:
    """Format the pre-execution message for deep research."""
    query = tool_call.get("query", "")
    
    # Truncate long queries for display
    display_query = query if len(query) <= 100 else query[:97] + "..."
    
    return {
        "title": "🔬 Conducting deep research",
        "message": f"Topic: {display_query}\n\n*This may take 30-120 seconds as I analyze multiple sources...*"
    }


def format_post_message(args: List[Any], result: Any) -> Dict[str, str]:
    """Format the post-execution message for deep research."""
    
    # Handle error case
    if isinstance(result, str):
        return {
            "title": "❌ Deep research failed",
            "message": result
        }
    
    # Parse result dict
    if not isinstance(result, dict):
        return {
            "title": "✅ Research completed",
            "message": str(result)
        }
    
    report = result.get("report", "")
    citations = result.get("citations", [])
    citation_count = result.get("citation_count", len(citations))
    
    # Build response with citation info
    if citation_count > 0:
        citation_info = f"\n\n*Research complete with {citation_count} citation{'s' if citation_count != 1 else ''}*"
        message = report + citation_info
    else:
        message = report
    
    return {
        "title": f"Deep research completed",
        "message": message
    }

