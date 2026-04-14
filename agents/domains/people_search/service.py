"""People search domain service - business logic and result formatting."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

from .config import COST_PER_RESULT_CENTS, COST_PER_SEARCH_CENTS, PROFILE_TEXT_TRUNCATE_LENGTH
from .repo import search_people_via_exa

if TYPE_CHECKING:
    from .types import PeopleSearchResult

logger = structlog.get_logger()


def _format_person_result(person: dict[str, Any]) -> str:
    """Format a single person result into readable text."""
    title = person.get("title", "Unknown")
    url = person.get("url", "")
    text = person.get("text", "")

    parts = [f"**{title}**"]
    if url:
        parts.append(f"URL: {url}")
    if text:
        truncated_text = (
            text[:PROFILE_TEXT_TRUNCATE_LENGTH] + "..." if len(text) > PROFILE_TEXT_TRUNCATE_LENGTH else text
        )
        parts.append(truncated_text)

    return "\n".join(parts)


def format_results(raw_results: list[dict[str, Any]], query: str) -> PeopleSearchResult:
    """
    Transform raw Exa results into the domain's typed result format.

    Args:
        raw_results: Raw result dicts from Exa API.
        query: Original search query.

    Returns:
        Typed PeopleSearchResult with candidates and readable summary.
    """
    formatted_results = []
    for r in raw_results:
        formatted_results.append(
            {
                "name": r.get("author", r.get("title", "Unknown")),
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "profile_text": r.get("text", ""),
                "image": r.get("image", ""),
            }
        )

    summary_parts = [_format_person_result(r) for r in raw_results]
    summary = "\n\n---\n\n".join(summary_parts) if summary_parts else "No people found."

    return {
        "candidates": formatted_results,
        "answer": summary,
        "query": query,
        "provider": "exa",
        "results_count": len(raw_results),
    }


async def execute_people_search(query: str, max_results: int) -> PeopleSearchResult:
    """
    Execute a people search: call Exa API and format results.

    Args:
        query: Natural language query describing the person.
        max_results: Maximum number of results to return.

    Returns:
        Typed PeopleSearchResult with candidates and summary.

    Raises:
        Exception: On API errors (propagated from repo layer).
    """
    data = await search_people_via_exa(query, max_results)
    raw_results = data.get("results", [])
    result = format_results(raw_results, query)
    logger.info("Exa people search completed", query=query, results_count=len(raw_results))
    return result


def calculate_cost_cents(num_results: int) -> float:
    """Calculate the total cost in cents for a people search.

    Args:
        num_results: Number of results returned.

    Returns:
        Total cost in cents.
    """
    return COST_PER_SEARCH_CENTS + (num_results * COST_PER_RESULT_CENTS)
