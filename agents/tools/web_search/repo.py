"""Web search data access -- HTTP calls to Parallel AI with DDGS fallback."""

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

    Raises:
        httpx.HTTPStatusError: On non-2xx response (e.g. 401 expired key).
        httpx.TimeoutException: On request timeout.
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


def fetch_search_results_ddgs(query: str, max_results: int = DEFAULT_MAX_RESULTS) -> list[dict[str, Any]]:
    """Fetch search results via DuckDuckGo (no API key required).

    Converts DDGS result format (title, href, body) to the same shape
    used by Parallel AI (title, url, excerpts list) so callers are
    provider-agnostic.

    Args:
        query: Search query string.
        max_results: Maximum number of results to return.

    Returns:
        List of result dicts with keys: title, url, excerpts.
    """
    from ddgs import DDGS  # lazy import — only needed on fallback path

    raw = DDGS().text(query, max_results=max_results)
    results = []
    for r in raw or []:
        title = r.get("title", "")
        body = r.get("body", "")
        url = r.get("href", "")
        results.append({"title": title, "url": url, "excerpts": [body] if body else []})
    return results
