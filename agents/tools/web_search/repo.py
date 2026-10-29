"""Web search data access -- HTTP calls to Parallel AI and Exa, with DDGS fallback."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import httpx

from helpers.http_client import get_http_client
from tools.web_search.config import (
    DEFAULT_MAX_RESULTS,
    EXA_SEARCH_TYPE,
    EXA_SEARCH_URL,
    HTTP_TIMEOUT,
    PARALLEL_API_URL,
    PARALLEL_SEARCH_MODE,
)
from tools.web_search.types import ProviderFailure, ProviderFailureKind


def parse_retry_after(headers: httpx.Headers) -> Optional[float]:
    """Return the provider's Retry-After in seconds (delta-seconds or HTTP-date), if valid."""
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return None
    if not math.isfinite(seconds):
        return None
    return max(0.0, seconds)


def classify_provider_failure(provider: str, error: BaseException) -> ProviderFailure:
    """Classify an authenticated provider failure from its HTTP status / exception type.

    ``TimeoutError`` is the search deadline expiring around the request.
    """
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status == 429:
            kind = ProviderFailureKind.RATE_LIMITED
        elif status >= 500:
            kind = ProviderFailureKind.UNAVAILABLE
        elif status == 408:
            kind = ProviderFailureKind.TIMEOUT
        else:
            kind = ProviderFailureKind.REJECTED
        return ProviderFailure(
            provider=provider,
            kind=kind,
            http_status=status,
            retry_after_seconds=parse_retry_after(error.response.headers),
            error_type=type(error).__name__,
        )
    if isinstance(error, (httpx.TimeoutException, TimeoutError)):
        return ProviderFailure(provider, ProviderFailureKind.TIMEOUT, error_type=type(error).__name__)
    if isinstance(error, httpx.TransportError):
        return ProviderFailure(provider, ProviderFailureKind.TRANSPORT, error_type=type(error).__name__)
    return ProviderFailure(provider, ProviderFailureKind.ERROR, error_type=type(error).__name__)


def classify_ddgs_failure(error: BaseException) -> ProviderFailure:
    """Classify a DDGS failure by its typed exception.

    DDGS drops every non-200 engine response before aggregation, so its base
    ``DDGSException`` means only that no engine returned results; it cannot tell
    blocked engines from an empty result set.
    """
    from ddgs.exceptions import DDGSException, RatelimitException, TimeoutException

    if isinstance(error, RatelimitException):
        kind = ProviderFailureKind.RATE_LIMITED
    elif isinstance(error, (TimeoutException, TimeoutError)):
        kind = ProviderFailureKind.TIMEOUT
    elif isinstance(error, DDGSException):
        kind = ProviderFailureKind.NO_RESULTS
    else:
        kind = ProviderFailureKind.ERROR
    return ProviderFailure("ddgs", kind, error_type=type(error).__name__)


async def fetch_search_results(
    query: str,
    api_key: str,
    max_chars_per_result: int,
    timeout: float = HTTP_TIMEOUT,
) -> list[dict[str, Any]]:
    """Call Parallel AI search API and return raw results list.

    Args:
        query: Search query string.
        api_key: Parallel AI API key.
        max_chars_per_result: Maximum characters per result excerpt.
        timeout: HTTP timeout; callers pass the search deadline's remaining time.

    Returns:
        List of result dicts from the API response.

    Raises:
        httpx.HTTPStatusError: On non-2xx response (e.g. 401 expired key).
        httpx.TimeoutException: On request timeout.
    """
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }

    # Match chat's Parallel V1 Turbo request contract
    # (back-end/src/providers/chat/chatTools.ts).
    payload = {
        "mode": PARALLEL_SEARCH_MODE,
        "objective": query,
        "search_queries": [query],
        "advanced_settings": {
            "max_results": DEFAULT_MAX_RESULTS,
            "excerpt_settings": {"max_chars_per_result": max_chars_per_result},
        },
    }

    response = await get_http_client().post(PARALLEL_API_URL, headers=headers, json=payload, timeout=timeout)
    response.raise_for_status()
    data = response.json()

    return data.get("results", [])


async def fetch_search_results_exa(
    query: str,
    api_key: str,
    max_chars_per_result: int,
    timeout: float = HTTP_TIMEOUT,
) -> list[dict[str, Any]]:
    """Call Exa Search API and return results in the Parallel shape (title, url, excerpts).

    Raises:
        httpx.HTTPStatusError: On non-2xx response (incl. 429 rate-limit).
        httpx.TimeoutException: On request timeout.
    """
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }
    payload = {
        "query": query,
        "type": EXA_SEARCH_TYPE,
        "numResults": DEFAULT_MAX_RESULTS,
        # Highlights are token-efficient, query-relevant excerpts.
        "contents": {"highlights": True},
    }

    response = await get_http_client().post(EXA_SEARCH_URL, headers=headers, json=payload, timeout=timeout)
    response.raise_for_status()
    data = response.json()

    results = []
    for item in data.get("results", []):
        highlights = [h for h in item.get("highlights") or [] if isinstance(h, str) and h]
        # Keep received text intact until the activity can retain it with
        # trusted caller scope. The existing excerpt budget is applied there.
        excerpt = "\n".join(highlights)
        results.append(
            {
                "title": item.get("title") or "",
                "url": item.get("url") or "",
                "excerpts": [excerpt] if excerpt else [],
            }
        )
    return results


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
