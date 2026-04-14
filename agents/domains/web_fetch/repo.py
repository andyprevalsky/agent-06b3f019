"""Web fetch domain repo — external data access (Parallel AI API, HTTP fetches, file uploads)."""

from typing import Any, Dict, List, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config
from domains.web_fetch.config import MAX_DOWNLOAD_SIZE, MIME_TYPES
from helpers.attachments import upload_to_storage

logger = structlog.get_logger()


async def fetch_parallel_ai_extract(
    url: str,
    objective: str,
    excerpts: bool,
) -> Dict[str, Any]:
    """Call Parallel AI extract API and return the raw JSON response.

    Args:
        url: URL to extract content from.
        objective: What content to focus on.
        excerpts: Whether to return focused excerpts.

    Returns:
        Raw JSON dict from the Parallel AI response.
    """
    config = load_config()
    api_key = config.parallel.api_key

    headers = {
        "x-api-key": api_key,
        "parallel-beta": "search-extract-2025-10-10",
        "Content-Type": "application/json",
    }

    # Always request full_content so we can extract images/links from the page.
    payload = {
        "urls": [url],
        "objective": objective,
        "excerpts": excerpts,
        "full_content": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            "https://api.parallel.ai/v1beta/extract",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        return response.json()


async def fetch_raw_html(url: str) -> Optional[str]:
    """Fetch raw HTML from a URL for asset extraction.

    Returns None on failure (logs a warning).
    """
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.text
    except Exception as e:
        logger.warning("[web_fetch] Failed to fetch raw HTML for asset extraction", url=url, error=str(e))
        return None


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
