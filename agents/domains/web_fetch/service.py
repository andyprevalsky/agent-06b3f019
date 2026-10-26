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
from temporalio.exceptions import ApplicationError

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


FETCHABLE_URL_SCHEMES = ("http", "https")


def _fetchable_url_rejection_reason(url: str) -> Optional[str]:
    """Return why ``url`` cannot be fetched over HTTP, or None when it can."""
    candidate = (url or "").strip()
    if not candidate:
        return "no URL was provided"

    try:
        parsed = urlparse(candidate)
    except ValueError as e:  # malformed IPv6 literals, bad ports, etc.
        return f"it is not a parseable URL ({e})"

    scheme = (parsed.scheme or "").lower()
    if scheme not in FETCHABLE_URL_SCHEMES:
        return (
            f"scheme {parsed.scheme or '(none)'!r} is not fetchable — web_fetch only "
            "accepts absolute http:// or https:// URLs"
        )

    try:
        host = (parsed.hostname or "").strip().lower()
    except ValueError as e:
        return f"it has an invalid hostname ({e})"
    if not host:
        return "it has no hostname"
    # A real host is either dotted (example.com, 10.0.0.1), an IPv6 literal, or
    # bare "localhost". Anything else — "internal", "network" — is fabricated.
    if "." not in host and ":" not in host and host != "localhost":
        return f"{host!r} is not a resolvable hostname"

    return None


def assert_fetchable_url(url: str) -> str:
    """Reject non-fetchable strings before any paid provider call.

    Agents routinely hand ``web_fetch`` identifiers that merely look
    URL-shaped: grep result paths emitted by our own data domain
    (``network/+19729777432.contact``, ``messages/<thread>.thread``),
    fabricated internal hosts (``https://internal/...``), or a bare
    scheme-less token. Each of those previously burned a Firecrawl call plus a
    Parallel Extract fallback and still returned nothing useful.

    Fails loudly and non-retryably so the agent sees a real tool error and
    picks a real URL. Deliberately does NOT try to repair the input — a
    guessed scheme or host would just move the wasted call downstream.
    """
    reason = _fetchable_url_rejection_reason(url)
    if reason is None:
        return url.strip()

    raise ApplicationError(
        f"web_fetch cannot fetch {url!r}: {reason}. Pass an absolute http(s) URL to a real "
        "web page. Local identifiers such as grep result paths "
        "(e.g. 'network/<name>.contact', 'messages/<thread>.thread') are not web URLs — "
        "read them with the grep tool instead.",
        type="WebFetchProvidersFailed",
        non_retryable=True,
    )


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
    # Guard the provider boundary: a non-fetchable string must never cost a
    # Firecrawl + Parallel Extract round trip.
    assert_fetchable_url(url)

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
            retryable = is_retryable_provider_error("Firecrawl", firecrawl_error) or is_retryable_provider_error(
                "Parallel Extract", parallel_error
            )
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
    agent_id: Optional[str] = None,
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
    downloaded = await _download_files_with_demo_cache(
        deduped_urls,
        fast_mode_cache_enabled=fast_mode_cache_enabled,
        fast_mode_goal=fast_mode_goal,
        fast_mode_cache_write_enabled=fast_mode_cache_write_enabled,
        agent_id=agent_id,
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


async def _download_files_with_demo_cache(
    urls: List[str],
    *,
    fast_mode_cache_enabled: bool,
    fast_mode_goal: Optional[str],
    fast_mode_cache_write_enabled: bool = False,
    agent_id: Optional[str] = None,
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

    from providers.demo_cache import client as demo_cache_client
    from providers.demo_cache import normalize as demo_cache_normalize
    from providers.demo_cache.blob_store import blob_path_for_key, download_blob, upload_blob

    results: Dict[str, Optional[bytes]] = {}
    misses: List[str] = []

    for url in urls:
        key = demo_cache_normalize.file_key(fast_mode_goal, url)
        if read_cache:
            record = await demo_cache_client.cache_get_record(key)
            if record.get("hit"):
                value = record.get("value")
                if isinstance(value, dict) and value.get("download_failed") is True:
                    logger.info("demo_cache.file_hit", key=key, url=url, bytes=0, cached_failure=True)
                    results[url] = None
                    continue
                blob_path = record.get("blobPath")
                body = await download_blob(blob_path) if blob_path else None
                if body is not None:
                    logger.info("demo_cache.file_hit", key=key, url=url, bytes=len(body))
                    results[url] = body
                    continue
                logger.warning("demo_cache.file_blob_missing", key=key, url=url)
            else:
                logger.info("demo_cache.file_miss", key=key, url=url)
        else:
            logger.info("demo_cache.file_write_only", key=key, url=url)
        misses.append(url)

    if not misses:
        return results

    live = await download_files_batch(misses)
    # A frozen DEMO namespace (goal or tree root) must not gain blobs or rows from a live miss.
    write_allowed = await demo_cache_client.cache_write_allowed_for_agent(agent_id, fast_mode_goal)
    for url in misses:
        body = live.get(url)
        results[url] = body
        if not write_allowed:
            continue
        key = demo_cache_normalize.file_key(fast_mode_goal, url)
        if body is None:
            await demo_cache_client.cache_set(
                key,
                "file",
                demo_cache_normalize.goal_hash(fast_mode_goal),
                {
                    "url": demo_cache_normalize.normalize_url(url),
                    "download_failed": True,
                },
                goal=fast_mode_goal,
            )
            logger.info("demo_cache.file_stored", key=key, url=url, bytes=0, cached_failure=True)
            continue
        blob_path = blob_path_for_key(key)
        uploaded = await upload_blob(blob_path, body)
        if not uploaded:
            continue
        await demo_cache_client.cache_set(
            key,
            "file",
            demo_cache_normalize.goal_hash(fast_mode_goal),
            {
                "url": demo_cache_normalize.normalize_url(url),
                "size_bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            },
            blob_path=blob_path,
            goal=fast_mode_goal,
        )
        logger.info("demo_cache.file_stored", key=key, url=url, bytes=len(body))

    return results
