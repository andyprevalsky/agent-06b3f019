"""Web fetch domain service — Firecrawl scrape + file download orchestration.

The Haiku filter pass (markdown summarization + link curation) is owned by
``helpers/summarize.py::summarize_and_filter_links`` and invoked as a separate
Temporal activity by the handler so claude/gpt token rotation signals flow
through the workflow.

This module owns the two side-effecting steps that don't need LLM tokens:
  1. Firecrawl scrape (``fetch_firecrawl_scrape``).
  2. Batch file download + Supabase upload after Haiku picks the file URLs.
"""

from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

import structlog
from temporalio import activity

from domains.web_fetch.repo import (
    download_files_batch,
    fetch_firecrawl_scrape,
    upload_file_to_storage,
)

logger = structlog.get_logger()


def get_filename_from_url(url: str) -> str:
    """Best-effort filename derivation from a URL's path component."""
    parsed = urlparse(url)
    name = unquote(parsed.path.rsplit("/", 1)[-1]) or "download"
    return name


async def scrape_url(url: str) -> Dict[str, Any]:
    """Fetch a URL via Firecrawl and return ``{markdown, links, metadata}``.

    Pure delegation today — split out so the Temporal activity wrapper stays
    a thin shim and so tests can mock the network call by patching
    ``fetch_firecrawl_scrape``.
    """
    activity.heartbeat(f"Firecrawl scrape: {url[:80]}")
    return await fetch_firecrawl_scrape(url)


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
