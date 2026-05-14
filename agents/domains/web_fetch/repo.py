"""Web fetch domain repo — external data access (Firecrawl scrape, HTTP file downloads, storage uploads)."""

from typing import Any, Dict, List, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config
from domains.web_fetch.config import FIRECRAWL_SCRAPE_TIMEOUT_SECONDS, MAX_DOWNLOAD_SIZE, MIME_TYPES
from helpers.attachments import upload_to_storage

logger = structlog.get_logger()


async def fetch_firecrawl_scrape(url: str) -> Dict[str, Any]:
    """Call Firecrawl `/v2/scrape` and return the page as markdown + link inventory.

    Firecrawl handles JS rendering, paywall/ad stripping, and main-content
    extraction in one paid hop (1 credit). We ask for only the formats we
    actually use downstream so credits stay at 1 per call:
      - ``markdown`` for the cleaned page body (Haiku summarizes it).
      - ``links`` for the discovered URL inventory (Haiku decides which to
        download via our own httpx — we deliberately don't use Firecrawl's
        ``parsers`` / ``json`` extraction because we already pay Anthropic
        for the downstream Haiku pass).

    Returns the unwrapped ``data`` block ``{"markdown": str, "links": [str]}``.
    Raises ``httpx.HTTPStatusError`` on Firecrawl errors so the caller can
    surface the failure to the agent rather than silently degrading.
    """
    config = load_config()
    api_key = config.firecrawl.api_key
    if not api_key:
        raise RuntimeError("FIRECRAWL_API_KEY is not configured (agents/.env)")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "url": url,
        "formats": ["markdown", "links"],
        "onlyMainContent": True,
    }

    async with httpx.AsyncClient(timeout=FIRECRAWL_SCRAPE_TIMEOUT_SECONDS) as client:
        response = await client.post(
            "https://api.firecrawl.dev/v2/scrape",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        body = response.json()

    data = body.get("data") or {}
    return {
        "markdown": data.get("markdown") or "",
        "links": data.get("links") or [],
        "metadata": data.get("metadata") or {},
    }


async def download_files_batch(urls: List[str]) -> Dict[str, Optional[bytes]]:
    """Download multiple files using a shared HTTP client for connection pooling.

    Args:
        urls: List of URLs to download.

    Returns:
        Dict mapping each URL to its content bytes, or None if download failed/too large.
    """
    results: Dict[str, Optional[bytes]] = {}
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        for url in urls:
            try:
                activity.heartbeat(f"Downloading {url.rsplit('/', 1)[-1][:50]}...")
                response = await client.get(url)
                response.raise_for_status()

                content = response.content
                if len(content) > MAX_DOWNLOAD_SIZE:
                    logger.warning("File too large, skipping", url=url, size=len(content))
                    results[url] = None
                    continue

                results[url] = content
            except Exception as e:
                logger.warning("[web_fetch] Failed to download file", url=url, error=str(e))
                results[url] = None

    return results


async def upload_file_to_storage(
    user_id: str,
    file_content: bytes,
    filename: str,
) -> Dict[str, Any]:
    """Upload file bytes to Supabase storage.

    Args:
        user_id: User ID for storage path.
        file_content: Raw file bytes.
        filename: Name for the stored file.

    Returns:
        FilePointer dict from upload_to_storage.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime_type = MIME_TYPES.get(ext, "application/octet-stream")

    return await upload_to_storage(
        user_id=user_id,
        file_content=file_content,
        filename=filename,
        mime_type=mime_type,
    )
