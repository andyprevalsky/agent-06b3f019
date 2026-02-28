"""Web fetch tool - fetch and extract content from a URL with JavaScript rendering support."""

from typing import Dict, Any, Optional, Callable, Awaitable, List
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
from urllib.parse import urlparse, urljoin
import os

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event
from helpers.attachments import upload_to_storage

import re
import time
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


logger = structlog.get_logger()


class WebFetchManager(ToolManager):
    """Manager for web fetch operations using Parallel AI's extract capability."""

    tool_name = "web_fetch"
    read_only = True  # Research phase tool
    condensor_enabled = True  # Condense results before adding to context

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute web fetch and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'url', 'objective', optional 'excerpts', 'full_content'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking

        Returns:
            Result dict with content, sources, objective
        """
        url = tool_call.get("url", "")
        objective = tool_call.get("objective", "")
        excerpts = tool_call.get("excerpts", True)
        full_content = tool_call.get("full_content", False)
        download_files = tool_call.get("download_files", None)

        # Track start time for elapsed time calculation
        start_time = _safe_time()

        # Truncate long objective for display
        display_objective = objective if len(objective) <= 100 else objective[:97] + "..."

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🌐 Fetching web content",
                message=f"Extracting from {url}: {display_objective}",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="web_fetch",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute web fetch activity
        try:
            logger.info("Calling web_fetch_activity", url=url, objective_len=len(objective), download_files=download_files)
            result = await execute_activity(
                web_fetch_activity,
                args=[url, objective, excerpts, full_content, download_files, user_id],
                start_to_close_timeout=timedelta(seconds=180),  # Longer timeout when downloading files
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )

            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            # Parallel AI Extract pricing: ~$0.005 per URL
            total_cost_cents = 0.5

            # Only post FINISHED if condensor won't handle it
            # (condensor posts its own FINISHED with condensed result)
            if not self.condensor_enabled:
                # Format success message using standardized format
                message = format_tool_message(
                    params=tool_call,
                    result=result,
                    time_elapsed=elapsed_time,
                    cost_cents=total_cost_cents
                )

                # Post-execution success
                await handle_tool_event(
                    event=ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Web fetch completed",
                        message=message,
                        status=MessageStatus.FINISHED
                    ),
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="web_fetch",
                    execute_activity=execute_activity,
                    user_id=user_id,
                )

            # Return with standardized usage for workflow cost tracking
            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": total_cost_cents, "provider": "Parallel AI Extract"}],
                }
            }

        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time

            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Web fetch failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_fetch",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Re-raise so workflow knows the tool failed (like spawn_browser_agent)
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[WebFetchManager] = None


def get_manager() -> WebFetchManager:
    """Get or create web fetch manager singleton."""
    global _manager
    if _manager is None:
        _manager = WebFetchManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def web_fetch(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute web fetch tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'url', 'objective', optional 'excerpts', 'full_content'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with content, sources, objective
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================

IMAGE_EXTENSIONS = r'\.(?:png|jpg|jpeg|gif|svg|webp|ico|bmp|tiff|avif)'
FILE_EXTENSIONS = r'\.(?:pdf|doc|docx|xls|xlsx|csv|zip|rar|ppt|pptx|txt|mp3|mp4|mov|avi)'
_RE_FLAGS = re.IGNORECASE


def _extract_media_urls(text: str, base_url: str = "") -> Dict[str, List[str]]:
    """Extract image URLs and file/document links from page content."""
    # Markdown images: ![alt](url)
    md_images = re.findall(r'!\[.*?\]\((https?://[^)]+)\)', text, _RE_FLAGS)
    # Bare image URLs
    bare_images = re.findall(rf'(https?://\S+{IMAGE_EXTENSIONS})(?:\s|$|[)\]])', text, _RE_FLAGS)
    images = list(dict.fromkeys(md_images + bare_images))  # dedupe, preserve order
    image_set = set(images)

    # File/document links
    files = re.findall(rf'(https?://\S+{FILE_EXTENSIONS})(?:\s|$|[)\]])', text, _RE_FLAGS)
    files = list(dict.fromkeys(files))
    file_set = set(files)

    # Non-image markdown links: exclude ![...](url) by requiring no preceding !
    # (?<!!)\[ is a negative lookbehind for !
    all_links = re.findall(r'(?<!!)\[([^\]]*)\]\((https?://[^)]+)\)', text, _RE_FLAGS)
    # Filter out URLs already captured as images or files
    links = list(dict.fromkeys(
        url for _, url in all_links
        if url not in image_set and url not in file_set
    ))

    return {
        "images": images,
        "files": files,
        "links": links,
    }


MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024  # 50MB per file

MIME_TYPES = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "svg": "image/svg+xml",
    "webp": "image/webp",
    "zip": "application/zip",
    "rar": "application/x-rar-compressed",
    "json": "application/json",
    "txt": "text/plain",
    "mp3": "audio/mpeg",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "avi": "video/x-msvideo",
}


def _get_filename_from_url(url: str) -> str:
    """Extract filename from URL path.

    Handles CDN URLs with transform suffixes, e.g.:
    .../photo.jpg/:/cr=t:0%25/rs=w:600 → photo.jpg
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    # Split path into segments and find the last one with a file extension
    segments = [s for s in path.split("/") if s]
    for seg in reversed(segments):
        if "." in seg and not seg.startswith("."):
            # Check if this segment looks like a filename (has a common extension)
            ext = seg.rsplit(".", 1)[-1].lower()
            if ext in MIME_TYPES:
                return seg
    # Fallback to last segment
    filename = os.path.basename(path)
    return filename if filename else "download"


def _matches_extensions(url: str, extensions: List[str]) -> bool:
    """Check if a URL's file extension matches any in the requested list.

    Handles CDN URLs where the extension isn't at the end of the path, e.g.:
    .../photo.jpg/:/cr=t:0%25,l:0%25/rs=w:600,h:451 (GoDaddy image transforms)
    """
    parsed = urlparse(url)
    path = parsed.path.lower()
    for ext in extensions:
        ext_clean = ext.lower().lstrip(".")
        # Check both exact end match and .ext/ (extension followed by path separator)
        if path.endswith(f".{ext_clean}") or f".{ext_clean}/" in path:
            return True
    return False


def _extract_asset_urls_from_html(html: str, base_url: str) -> List[str]:
    """Extract asset URLs from raw HTML src/href attributes.

    Captures URLs from <img src>, <a href>, <source src>, <video src>, <audio src>,
    <link href>, etc. that point to downloadable files. Resolves relative and
    protocol-relative URLs against the base URL.
    """
    # Match src="..." and href="..." attributes (single or double quotes)
    attr_urls = re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', html, re.IGNORECASE)

    resolved = []
    for raw_url in attr_urls:
        raw_url = raw_url.strip()
        if not raw_url or raw_url.startswith(("data:", "javascript:", "mailto:", "#")):
            continue
        # Resolve relative/protocol-relative URLs
        full_url = urljoin(base_url, raw_url)
        resolved.append(full_url)

    return list(dict.fromkeys(resolved))  # dedupe, preserve order


async def _fetch_raw_html(url: str) -> Optional[str]:
    """Fetch raw HTML from a URL for asset extraction."""
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.text
    except Exception as e:
        logger.warning("[web_fetch] Failed to fetch raw HTML for asset extraction", url=url, error=str(e))
        return None


async def _download_and_upload_files(
    urls: List[str],
    extensions: List[str],
    user_id: str,
) -> List[Dict[str, Any]]:
    """Download files matching requested extensions and upload to Supabase storage.

    Args:
        urls: Candidate URLs discovered on the page (files + images)
        extensions: Requested file extensions to download (e.g. ["pdf", "csv"])
        user_id: User ID for storage path

    Returns:
        List of FilePointer dicts for successfully downloaded files
    """
    # Filter URLs by requested extensions
    matching_urls = [u for u in urls if _matches_extensions(u, extensions)]

    if not matching_urls:
        logger.info("No URLs matched requested extensions", extensions=extensions, candidate_count=len(urls))
        return []

    # Dedupe by base filename — CDN URLs often have the same image at different sizes
    # e.g. blob-f7a5f2e.png/:/rs=w:57 and blob-f7a5f2e.png/:/rs=w:180 are the same image
    seen_filenames = set()
    deduped_urls = []
    for u in matching_urls:
        fname = _get_filename_from_url(u)
        if fname not in seen_filenames:
            seen_filenames.add(fname)
            deduped_urls.append(u)
    matching_urls = deduped_urls

    logger.info(
        "Downloading files from web_fetch",
        matching_count=len(matching_urls),
        extensions=extensions,
    )

    file_pointers = []
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        for url in matching_urls:
            try:
                activity.heartbeat(f"Downloading {_get_filename_from_url(url)}...")
                response = await client.get(url)
                response.raise_for_status()

                content = response.content
                if len(content) > MAX_DOWNLOAD_SIZE:
                    logger.warning("File too large, skipping", url=url, size=len(content))
                    continue

                filename = _get_filename_from_url(url)
                ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
                mime_type = MIME_TYPES.get(ext, "application/octet-stream")

                file_pointer = await upload_to_storage(
                    user_id=user_id,
                    file_content=content,
                    filename=filename,
                    mime_type=mime_type,
                )
                file_pointers.append(file_pointer)

                logger.info(
                    "[web_fetch] Downloaded and uploaded file",
                    url=url,
                    filename=filename,
                    size_bytes=len(content),
                )

            except Exception as e:
                logger.warning("[web_fetch] Failed to download file", url=url, error=str(e))
                continue

    return file_pointers


def _format_extract_results(results: List[Dict[str, Any]], full_content: bool) -> str:
    """Format Parallel AI extract results into a readable answer."""
    if not results:
        return "No content extracted."

    formatted_parts = []
    for r in results:
        url = r.get("url", "")
        title = r.get("title", "")

        if full_content:
            content = r.get("full_content", "")
        else:
            excerpts = r.get("excerpts", [])
            content = "\n".join(excerpts) if isinstance(excerpts, list) else str(excerpts)

        if title and content:
            formatted_parts.append(f"**{title}** ({url})\n{content}")
        elif content:
            formatted_parts.append(f"**{url}**\n{content}")

    return "\n\n---\n\n".join(formatted_parts) if formatted_parts else "No relevant content found."


@activity.defn
async def web_fetch_activity(
    url: str,
    objective: str,
    excerpts: bool = True,
    full_content: bool = False,
    download_files: Optional[List[str]] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Activity: Fetch and extract content from a URL with JavaScript rendering support.

    Uses Parallel AI's extract API for content extraction from JS-rendered pages.

    Best for: SPAs, dynamic content, pages requiring JavaScript to load.

    Args:
        url: URL to fetch and extract from
        objective: What content to focus on extracting
        excerpts: Return focused excerpts (default: True)
        full_content: Return complete page content (default: False)
        download_files: File extensions to auto-download (e.g. ["pdf", "csv"])
        user_id: User ID for storage uploads

    Returns:
        Dict with:
            - content: Extracted content from the URL
            - sources: List of source URLs
            - objective: Original objective
            - results: Raw results from API
            - downloaded_files: List of FilePointer dicts (if download_files was set)
    """
    try:
        activity.heartbeat(f"Fetching {url}: {objective[:50]}...")

        config = load_config()
        api_key = config.parallel.api_key

        headers = {
            "x-api-key": api_key,
            "parallel-beta": "search-extract-2025-10-10",
            "Content-Type": "application/json"
        }

        # Always request full_content so we can extract images/links from the page.
        # Use excerpts for the formatted content the LLM reads; full_content for media parsing.
        payload = {
            "urls": [url],
            "objective": objective,
            "excerpts": excerpts,
            "full_content": True,  # Always fetch full content for media extraction
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                "https://api.parallel.ai/v1beta/extract",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            data = response.json()

        results = data.get("results", [])
        errors = data.get("errors", [])

        # Log any errors from the API
        if errors:
            logger.warning("Web fetch had errors", errors=errors)

        # Format results into content (uses excerpts unless user requested full_content)
        content = _format_extract_results(results, full_content)

        # Extract successful sources
        sources = [r.get("url") for r in results if r.get("url")]

        # Extract image URLs and file links from full page content
        media: Dict[str, List[str]] = {"images": [], "files": [], "links": []}
        for r in results:
            page_text = r.get("full_content", "")
            if page_text:
                page_media = _extract_media_urls(page_text, url)
                media["images"].extend(page_media["images"])
                media["files"].extend(page_media["files"])
                media["links"].extend(page_media["links"])
        # Dedupe across results
        media = {k: list(dict.fromkeys(v)) for k, v in media.items()}

        # Download files if requested
        downloaded_files = []
        if download_files and user_id:
            candidate_urls = media["files"] + media["images"]

            # Also fetch raw HTML to extract src/href asset URLs that Parallel AI's
            # markdown conversion may have dropped (e.g. <img src="//cdn.example.com/photo.jpg">)
            activity.heartbeat("Fetching raw HTML for asset extraction...")
            raw_html = await _fetch_raw_html(url)
            if raw_html:
                html_asset_urls = _extract_asset_urls_from_html(raw_html, url)
                # Merge HTML assets into candidates, deduping against what we already have
                existing = set(candidate_urls)
                for asset_url in html_asset_urls:
                    if asset_url not in existing:
                        candidate_urls.append(asset_url)
                        existing.add(asset_url)
                logger.info(
                    "[web_fetch] Extracted asset URLs from raw HTML",
                    html_asset_count=len(html_asset_urls),
                    total_candidates=len(candidate_urls),
                )

            downloaded_files = await _download_and_upload_files(
                urls=candidate_urls,
                extensions=download_files,
                user_id=user_id,
            )

        result = {
            "content": content,
            "sources": sources,
            "images": media["images"],
            "files": media["files"],
            "links": media["links"],
            "objective": objective,
            "results": results,
            "errors": errors,
            "downloaded_files": downloaded_files,
        }

        logger.info(
            "Web fetch completed",
            url=url,
            objective=objective[:100],
            content_length=len(content),
            results_count=len(results),
            images_count=len(media["images"]),
            links_count=len(media["links"]),
            files_count=len(media["files"]),
            downloaded_count=len(downloaded_files),
            errors_count=len(errors)
        )

        return result

    except Exception as e:
        logger.error("Web fetch failed", error=str(e), url=url, objective=objective)
        raise
