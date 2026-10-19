"""Web search business logic -- orchestrates search and formats results."""

from __future__ import annotations

import asyncio
import random
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional

import structlog
from temporalio import activity
from temporalio.exceptions import ApplicationError

from config import load_config
from tools.web_search.config import (
    DDGS_FALLBACK_RESERVE_SECONDS,
    DEFAULT_MAX_TOKENS,
    HTTP_TIMEOUT,
    PROVIDER_MAX_ATTEMPTS,
    PROVIDER_RETRY_AFTER_MAX_SECONDS,
    PROVIDER_RETRY_BUDGET_SECONDS,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_INTERVAL_SECONDS,
    SEARCH_DEADLINE_SECONDS,
)
from tools.web_search.repo import (
    classify_ddgs_failure,
    classify_provider_failure,
    fetch_search_results,
    fetch_search_results_ddgs,
    fetch_search_results_exa,
)
from tools.web_search.types import ProviderFailure, ProviderFailureKind

if TYPE_CHECKING:
    from tools.web_search.types import SearchResult

logger = structlog.get_logger()

# ApplicationError.type for a search that no provider answered.
WEB_SEARCH_UNAVAILABLE_ERROR_TYPE = "WebSearchProviderUnavailable"

# Called with the HTTP timeout (seconds) remaining before the provider deadline.
ProviderCall = Callable[[float], Awaitable[list[dict[str, Any]]]]


def format_search_results(results: list[dict]) -> str:
    """Format search results into a readable answer."""
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


def _retry_delay(failure: ProviderFailure, elapsed: float) -> Optional[float]:
    """Seconds to wait before retrying this provider, or None when it must not be retried now."""
    if not failure.transient or failure.attempts >= PROVIDER_MAX_ATTEMPTS:
        return None
    backoff = min(
        RETRY_INITIAL_INTERVAL_SECONDS * RETRY_BACKOFF_COEFFICIENT ** (failure.attempts - 1),
        RETRY_MAX_INTERVAL_SECONDS,
    )
    # Jitter de-synchronizes the many agents that were rejected together.
    delay = backoff * random.uniform(0.5, 1.0)
    if failure.retry_after_seconds is not None:
        if failure.retry_after_seconds > PROVIDER_RETRY_AFTER_MAX_SECONDS:
            return None
        delay += failure.retry_after_seconds
    if elapsed + delay > PROVIDER_RETRY_BUDGET_SECONDS:
        return None
    return delay


async def _search_authenticated(
    providers: list[tuple[str, ProviderCall]],
    failures: list[ProviderFailure],
    deadline: float,
) -> Optional[tuple[str, list[dict[str, Any]]]]:
    """Try each provider in order; retry transient failures per provider on its own schedule.

    A provider whose request fails transiently is retried no earlier than its
    Retry-After (plus jittered backoff) while the next provider is tried at once.
    Every request is bounded by the time remaining before ``deadline`` (a
    ``time.monotonic()`` value), and no retry is scheduled at or past it.
    Returns ``(provider, results)`` from the first provider that answers (an
    empty list is that provider's genuine answer), else records each provider's
    final failure in ``failures`` and returns None.
    """
    started = time.monotonic()
    calls = dict(providers)
    attempts = dict.fromkeys(calls, 0)
    not_before = dict.fromkeys(calls, started)
    last_failure: dict[str, ProviderFailure] = {}
    active = list(calls)

    while active:
        for name in [n for n in active if not_before[n] <= time.monotonic()]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            attempts[name] += 1
            try:
                # httpx timeouts apply per phase; the outer bound caps the whole request.
                async with asyncio.timeout(remaining):
                    return name, await calls[name](min(HTTP_TIMEOUT, remaining))
            except Exception as error:
                failure = classify_provider_failure(name, error)
                failure.attempts = attempts[name]
                last_failure[name] = failure
                delay = _retry_delay(failure, time.monotonic() - started)
                if delay is not None and time.monotonic() + delay >= deadline:
                    delay = None
                logger.warning(
                    "web_search.provider_failed",
                    provider=name,
                    kind=failure.kind.value,
                    http_status=failure.http_status,
                    retry_after_seconds=failure.retry_after_seconds,
                    error_type=failure.error_type,
                    attempt=failure.attempts,
                    retry_in_seconds=None if delay is None else round(delay, 3),
                )
                if delay is None:
                    active.remove(name)
                else:
                    not_before[name] = time.monotonic() + delay
        if time.monotonic() >= deadline:
            break
        if active:
            await asyncio.sleep(max(0.0, min(not_before[n] for n in active) - time.monotonic()))

    failures.extend(last_failure[name] for name, _ in providers if name in last_failure)
    return None


def _unavailable_error(query: str, failures: list[ProviderFailure]) -> ApplicationError:
    """Typed, truthful error for a search that no provider answered."""
    if any(f.kind is ProviderFailureKind.RATE_LIMITED for f in failures):
        status = "search_provider_rate_limited"
        headline = "Web search unavailable: search providers rate-limited this request"
    elif any(f.transient for f in failures):
        status = "search_provider_unavailable"
        headline = "Web search unavailable: search providers are unavailable"
    else:
        status = "search_provider_failed"
        headline = "Web search failed: no search provider returned results"
    message = f"{headline} ({'; '.join(f.describe() for f in failures)})."
    if status != "search_provider_failed":
        message += " The query was not answered; this is a provider outage, not an empty result."
    return ApplicationError(
        message,
        {"status": status, "query": query[:200], "providers": [f.to_detail() for f in failures]},
        type=WEB_SEARCH_UNAVAILABLE_ERROR_TYPE,
        # Each provider already had its bounded, Retry-After-aware retries;
        # re-running the activity would only multiply load on limited providers.
        non_retryable=True,
    )


async def execute_search(query: str, max_tokens: int = DEFAULT_MAX_TOKENS) -> SearchResult:
    """Perform a web search and return structured result.

    Tries the configured authenticated providers (Parallel AI, then Exa) with
    bounded, Retry-After-aware retries for transient failures, then the keyless
    DuckDuckGo metasearch once. If no provider answers, raises a non-retryable
    ``ApplicationError`` of type ``WebSearchProviderUnavailable`` whose message
    and details state each provider's failure; it never reports "No results".
    The whole search, including the fallback, is bounded by one
    ``SEARCH_DEADLINE_SECONDS`` deadline inside the activity timeout.

    Args:
        query: Search query or question.
        max_tokens: Maximum tokens for response.

    Returns:
        SearchResult with answer, sources, query, and provider.
    """
    deadline = time.monotonic() + SEARCH_DEADLINE_SECONDS
    activity.heartbeat(f"Web searching: {query}")

    app_config = load_config()
    max_chars_per_result = max_tokens * 4
    parallel_key = app_config.parallel.api_key
    exa_key = app_config.exa.api_key

    providers: list[tuple[str, ProviderCall]] = []
    if parallel_key:
        providers.append(
            (
                "parallel-ai",
                lambda timeout: fetch_search_results(
                    query=query, api_key=parallel_key, max_chars_per_result=max_chars_per_result, timeout=timeout
                ),
            )
        )
    if exa_key:
        providers.append(
            (
                "exa",
                lambda timeout: fetch_search_results_exa(
                    query=query, api_key=exa_key, max_chars_per_result=max_chars_per_result, timeout=timeout
                ),
            )
        )

    failures: list[ProviderFailure] = []
    answered = (
        await _search_authenticated(providers, failures, deadline - DDGS_FALLBACK_RESERVE_SECONDS)
        if providers
        else None
    )
    if answered is not None:
        provider, raw_results = answered
    else:
        logger.info(
            "Web search using DuckDuckGo fallback",
            query=query,
            provider_failures=[f.to_detail() for f in failures],
        )
        provider = "ddgs"
        try:
            # DDGS is synchronous (threads + blocking HTTP); keep it off the worker event
            # loop and stop waiting for it at the search deadline.
            raw_results = await asyncio.wait_for(
                asyncio.to_thread(fetch_search_results_ddgs, query),
                timeout=max(0.0, deadline - time.monotonic()),
            )
        except Exception as error:
            failures.append(classify_ddgs_failure(error))
            raw_results = []
        else:
            if not raw_results:
                failures.append(ProviderFailure("ddgs", ProviderFailureKind.NO_RESULTS))
        if not raw_results:
            raise _unavailable_error(query, failures)

    answer = format_search_results(raw_results)
    sources = [r.get("url") for r in raw_results if r.get("url")]

    result: SearchResult = {
        "answer": answer,
        "sources": sources,
        "query": query,
        "provider": provider,
    }

    logger.info(
        "Web search completed",
        query=query,
        answer_length=len(answer),
        results_count=len(raw_results),
        provider=provider,
        provider_failures=[f.to_detail() for f in failures] or None,
    )

    return result
