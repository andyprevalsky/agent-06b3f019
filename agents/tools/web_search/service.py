"""Web search business logic -- orchestrates search and formats results."""

from __future__ import annotations

from typing import TYPE_CHECKING

import structlog
from temporalio import activity

from config import load_config
from tools.web_search.config import DEFAULT_MAX_TOKENS
from tools.web_search.repo import fetch_search_results

if TYPE_CHECKING:
    from tools.web_search.types import SearchResult

logger = structlog.get_logger()


def format_search_results(results: list[dict]) -> str:
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


async def execute_search(query: str, max_tokens: int = DEFAULT_MAX_TOKENS) -> SearchResult:
    """Perform a web search via Parallel AI and return structured result.

    This is the core business logic -- called by the Temporal activity.

    Args:
        query: Search query or question.
        max_tokens: Maximum tokens for response.

    Returns:
        SearchResult with answer, sources, query, and provider.
    """
    activity.heartbeat(f"Web searching: {query}")

    app_config = load_config()
    api_key = app_config.parallel.api_key

    raw_results = await fetch_search_results(
        query=query,
        api_key=api_key,
        max_chars_per_result=max_tokens * 4,
    )

    answer = format_search_results(raw_results)
    sources = [r.get("url") for r in raw_results if r.get("url")]

    result: SearchResult = {
        "answer": answer,
        "sources": sources,
        "query": query,
        "provider": "parallel-ai",
    }

    logger.info(
        "Web search completed",
        query=query,
        answer_length=len(answer),
        results_count=len(raw_results),
    )

    return result
