"""Web fetch domain service — provider scrape + file download orchestration.

The Haiku filter pass (markdown summarization + link curation) is owned by
``helpers/summarize.py::summarize_and_filter_links`` and invoked as a separate
Temporal activity by the handler so claude/gpt token rotation signals flow
through the workflow.

This module owns the two side-effecting steps that don't need LLM tokens:
  1. Provider scrape (Firecrawl primary, Parallel Extract fallback).
  2. Batch file download + Supabase upload after Haiku picks the file URLs.
"""

import hashlib
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

import structlog
from temporalio import activity

from domains.web_fetch.repo import (
    download_files_batch,
    fetch_firecrawl_scrape,
    fetch_parallel_extract,
    is_retryable_provider_error,
    upload_file_to_storage,
)

logger = structlog.get_logger()

class WebFetchProvidersFailed(RuntimeError):
    """Both scrape providers failed, with retryability classified at provider boundary."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


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
            retryable = is_retryable_provider_error(
                "Firecrawl", firecrawl_error
            ) or is_retryable_provider_error("Parallel Extract", parallel_error)
            raise WebFetchProvidersFailed(
                "web_fetch failed with Firecrawl and Parallel Extract. "
                f"Firecrawl error: {firecrawl_error}; Parallel Extract error: {parallel_error}",
                retryable=retryable,
            ) from parallel_error


async def download_and_attach(
    file_urls: List[str],
    user_id: Optional[str],
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
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
    downloaded = await _download_files_with_fast_cache(
        deduped_urls,
        fast_mode_cache_enabled=fast_mode_cache_enabled,
        fast_mode_goal=fast_mode_goal,
        fast_mode_cache_write_enabled=fast_mode_cache_write_enabled,
    )

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


async def _download_files_with_fast_cache(
    urls: List[str],
    *,
    fast_mode_cache_enabled: bool,
    fast_mode_goal: Optional[str],
    fast_mode_cache_write_enabled: bool = False,
) -> Dict[str, Optional[bytes]]:
    """Download URL bytes with Fast Mode record/replay.

    The third-party URL fetch is read-only and deterministic enough for demo
    replay. Supabase upload of the resulting attachment remains per-run so the
    current agent has a valid file pointer, but the external file host is not hit
    again on cache hits.
    """
    read_cache = fast_mode_cache_enabled and bool(fast_mode_goal)
    write_cache = (fast_mode_cache_enabled or fast_mode_cache_write_enabled) and bool(fast_mode_goal)
    if not write_cache:
        return await download_files_batch(urls)

    from providers.fast_cache import client as fast_cache_client
    from providers.fast_cache import normalize as fast_cache_normalize
    from providers.fast_cache.blob_store import blob_path_for_key, download_blob, upload_blob

    results: Dict[str, Optional[bytes]] = {}
    misses: List[str] = []

    for url in urls:
        key = fast_cache_normalize.file_key(fast_mode_goal, url)
        if read_cache:
            record = await fast_cache_client.cache_get_record(key)
            if record.get("hit"):
                value = record.get("value")
                if isinstance(value, dict) and value.get("download_failed") is True:
                    logger.info("fast_cache.file_hit", key=key, url=url, bytes=0, cached_failure=True)
                    results[url] = None
                    continue
                blob_path = record.get("blobPath")
                body = await download_blob(blob_path) if blob_path else None
                if body is not None:
                    logger.info("fast_cache.file_hit", key=key, url=url, bytes=len(body))
                    results[url] = body
                    continue
                logger.warning("fast_cache.file_blob_missing", key=key, url=url)
            else:
                logger.info("fast_cache.file_miss", key=key, url=url)
        else:
            logger.info("fast_cache.file_write_only", key=key, url=url)
        misses.append(url)

    if not misses:
        return results

    live = await download_files_batch(misses)
    for url in misses:
        body = live.get(url)
        results[url] = body
        key = fast_cache_normalize.file_key(fast_mode_goal, url)
        if body is None:
            await fast_cache_client.cache_set(
                key,
                "file",
                fast_cache_normalize.goal_hash(fast_mode_goal),
                {
                    "url": fast_cache_normalize.normalize_url(url),
                    "download_failed": True,
                },
            )
            logger.info("fast_cache.file_stored", key=key, url=url, bytes=0, cached_failure=True)
            continue
        blob_path = blob_path_for_key(key)
        uploaded = await upload_blob(blob_path, body)
        if not uploaded:
            continue
        await fast_cache_client.cache_set(
            key,
            "file",
            fast_cache_normalize.goal_hash(fast_mode_goal),
            {
                "url": fast_cache_normalize.normalize_url(url),
                "size_bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            },
            blob_path=blob_path,
        )
        logger.info("fast_cache.file_stored", key=key, url=url, bytes=len(body))

    return results
