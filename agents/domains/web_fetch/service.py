"""Web fetch domain service — provider scrape + file download orchestration.

The Haiku filter pass (markdown summarization + link curation) is owned by
``helpers/summarize.py::summarize_and_filter_links`` and invoked as a separate
Temporal activity by the handler so claude/gpt token rotation signals flow
through the workflow.

This module owns the two side-effecting steps that don't need LLM tokens:
  1. Provider scrape (Firecrawl primary, Parallel Extract fallback).
  2. Batch file download + Supabase upload after Haiku picks the file URLs.
"""

from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

import httpx
import structlog
from temporalio import activity

from domains.web_fetch.repo import (
    download_files_batch,
    fetch_firecrawl_scrape,
    fetch_parallel_extract,
    upload_file_to_storage,
)

logger = structlog.get_logger()

FIRECRAWL_RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}
FIRECRAWL_NON_RETRYABLE_STATUSES = {400, 401, 402, 403, 404, 409, 413}
PARALLEL_RETRYABLE_STATUSES = {408, 429, 500, 502, 503}
PARALLEL_NON_RETRYABLE_STATUSES = {400, 401, 402, 403, 404, 422}


class WebFetchProvidersFailed(RuntimeError):
    """Both scrape providers failed, with retryability classified at provider boundary."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


def _http_status(error: BaseException) -> Optional[int]:
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code
    return None


def _is_retryable_provider_error(provider: str, error: BaseException) -> bool:
    """Classify provider failures using the providers' documented retry guidance.

    Firecrawl docs mark 408/429/5xx as retryable and most 4xx client errors as
    non-retryable. Parallel docs mark 408/429/5xx as retryable and
    401/402/403/404/422 as non-retryable.
    """
    if isinstance(error, (httpx.TimeoutException, httpx.TransportError)):
        return True

    status = _http_status(error)
    if status is None:
        message = str(error).lower()
        deterministic_phrases = (
            "not configured",
            "returned empty markdown",
            "returned no results",
            "invalid url",
            "unsupported",
        )
        return not any(phrase in message for phrase in deterministic_phrases)

    retryable_statuses = FIRECRAWL_RETRYABLE_STATUSES if provider == "Firecrawl" else PARALLEL_RETRYABLE_STATUSES
    non_retryable_statuses = (
        FIRECRAWL_NON_RETRYABLE_STATUSES if provider == "Firecrawl" else PARALLEL_NON_RETRYABLE_STATUSES
    )
    if status in retryable_statuses:
        return True
    if status in non_retryable_statuses:
        return False

    # Unknown 5xx should get a retry; unknown 4xx is usually request/input/config.
    return status >= 500


def get_filename_from_url(url: str) -> str:
    """Best-effort filename derivation from a URL's path component."""
    parsed = urlparse(url)
    name = unquote(parsed.path.rsplit("/", 1)[-1]) or "download"
    return name


async def scrape_url(url: str) -> Dict[str, Any]:
    """Fetch a URL and return ``{markdown, links, metadata}``.

    Firecrawl is primary. Parallel Extract is the public-page fallback when
    Firecrawl rejects a site, times out, or otherwise fails.
    """
    activity.heartbeat(f"Firecrawl scrape: {url[:80]}")
    try:
        return await fetch_firecrawl_scrape(url)
    except Exception as firecrawl_error:
        logger.warning(
            "[web_fetch] Firecrawl scrape failed; falling back to Parallel Extract",
            url=url,
            error=str(firecrawl_error),
        )

        activity.heartbeat(f"Parallel Extract fallback: {url[:80]}")
        try:
            return await fetch_parallel_extract(url)
        except Exception as parallel_error:
            retryable = _is_retryable_provider_error(
                "Firecrawl", firecrawl_error
            ) or _is_retryable_provider_error("Parallel Extract", parallel_error)
            raise WebFetchProvidersFailed(
                "web_fetch failed with Firecrawl and Parallel Extract. "
                f"Firecrawl error: {firecrawl_error}; Parallel Extract error: {parallel_error}",
                retryable=retryable,
            ) from parallel_error


async def download_and_attach(
    file_urls: List[str],
    user_id: Optional[str],
) -> List[Dict[str, Any]]:
    """Download a curated list of file URLs and upload each to Supabase storage.

    Returns the list of file_pointer dicts (one per successfully uploaded
    file). Failures are logged and silently dropped — the agent surfaces the
    summary regardless, and the missing files won't appear as attachments.

    Skips entirely when ``user_id`` is None (anonymous / no storage scope).
    """
    if not file_urls or not user_id:
        return []

    # Dedupe by URL first (Haiku is asked to dedupe but we double up just in
    # case), then by derived filename so two URLs that map to the same name
    # don't double-upload.
    deduped_urls = list(dict.fromkeys(file_urls))

    activity.heartbeat(f"Downloading {len(deduped_urls)} file(s)")
    downloaded = await download_files_batch(deduped_urls)

    seen_filenames: set[str] = set()
    file_pointers: List[Dict[str, Any]] = []

    for file_url in deduped_urls:
        content = downloaded.get(file_url)
        if content is None:
            continue
        filename = get_filename_from_url(file_url)
        if filename in seen_filenames:
            continue
        seen_filenames.add(filename)

        file_pointer = await upload_file_to_storage(
            user_id=user_id,
            file_content=content,
            filename=filename,
        )
        file_pointers.append(file_pointer)
        logger.info(
            "[web_fetch] Downloaded and uploaded file",
            url=file_url,
            filename=filename,
            size_bytes=len(content),
        )

    return file_pointers
