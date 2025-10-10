"""Web search tool for finding information online."""

from typing import Dict, List, Optional
from temporalio import activity
import httpx
import structlog

from config import load_config

logger = structlog.get_logger()


class WebSearcher:
    """Manager for web search operations."""
    
    def __init__(self):
        config = load_config()
        self.serper_api_key = config.search.serper_api_key
    
    async def search_serper(self, query: str, num_results: int = 10) -> List[Dict]:
        """Search using Serper API (recommended - simpler and faster)."""
        if not self.serper_api_key:
            raise ValueError("SERPER_API_KEY not configured")
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://google.serper.dev/search",
                headers={
                    "X-API-KEY": self.serper_api_key,
                    "Content-Type": "application/json"
                },
                json={
                    "q": query,
                    "num": num_results
                },
                timeout=30.0
            )
            response.raise_for_status()
            
            data = response.json()
            
            # Parse results
            results = []
            for item in data.get("organic", []):
                results.append({
                    "title": item.get("title"),
                    "url": item.get("link"),
                    "snippet": item.get("snippet"),
                    "source": "serper"
                })
            
            return results
    
    
    async def search(
        self,
        query: str,
        num_results: int = 10,
        provider: Optional[str] = None
    ) -> List[Dict]:
        """
        Perform a web search.
        
        Args:
            query: Search query
            num_results: Number of results to return
            provider: Search provider ("serper" or "google", auto-detect if None)
            
        Returns:
            List of search results with title, url, snippet
        """
        try:
            activity.heartbeat(f"Searching: {query}")
            
            # Use Serper (only provider now)
            if provider and provider != "serper":
                raise ValueError(f"Only 'serper' provider is supported, got: {provider}")
            
            results = await self.search_serper(query, num_results)
            
            logger.info(
                "Web search complete",
                query=query,
                provider=provider,
                result_count=len(results)
            )
            
            return results
            
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
async def web_search(
    query: str,
    num_results: int = 10,
    provider: Optional[str] = None
) -> List[Dict]:
    """
    Activity: Perform a web search.
    
    Args:
        query: Search query
        num_results: Number of results
        provider: Search provider (optional)
        
    Returns:
        List of search results
    """
    searcher = get_web_searcher()
    return await searcher.search(query, num_results, provider)

