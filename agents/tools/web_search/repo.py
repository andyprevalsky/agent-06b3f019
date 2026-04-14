"""Web search data access -- HTTP calls to Parallel AI."""

from __future__ import annotations

from typing import Any

import httpx

from tools.web_search.config import (
    DEFAULT_MAX_RESULTS,
    HTTP_TIMEOUT,
    PARALLEL_API_URL,
    PARALLEL_BETA_HEADER,
)


async def fetch_search_results(
    query: str,
    api_key: str,
    max_chars_per_result: int,
) -> list[dict[str, Any]]:
    """Call Parallel AI search API and return raw results list.

    Args:
        query: Search query string.
        api_key: Parallel AI API key.
        max_chars_per_result: Maximum characters per result excerpt.

    Returns:
        List of result dicts from the API response.
    """
    headers = {
        "x-api-key": api_key,
        "parallel-beta": PARALLEL_BETA_HEADER,
        "Content-Type": "application/json",
    }

    payload = {
        "objective": query,
        "search_queries": [query],
        "max_results": DEFAULT_MAX_RESULTS,
        "excerpts": {"max_chars_per_result": max_chars_per_result},
    }

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.post(PARALLEL_API_URL, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()

    return data.get("results", [])
