"""Web fetch domain service — business logic for URL content extraction."""

import os
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import structlog
from temporalio import activity

from domains.web_fetch.config import (
    FILE_EXTENSIONS,
    IMAGE_EXTENSIONS,
    MIME_TYPES,
    RE_FLAGS,
)
from domains.web_fetch.repo import (
    download_files_batch,
    fetch_parallel_ai_extract,
    fetch_raw_html,
    upload_file_to_storage,
)
from domains.web_fetch.types import MediaUrls

logger = structlog.get_logger()


# ── Pure helpers ──


def get_filename_from_url(url: str) -> str:
    """Extract filename from URL path.

    Handles CDN URLs with transform suffixes, e.g.:
    .../photo.jpg/:/cr=t:0%25/rs=w:600 -> photo.jpg
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    segments = [s for s in path.split("/") if s]
    for seg in reversed(segments):
        if "." in seg and not seg.startswith("."):
            ext = seg.rsplit(".", 1)[-1].lower()
            if ext in MIME_TYPES:
                return seg
    filename = os.path.basename(path)
    return filename if filename else "download"


def matches_extensions(url: str, extensions: List[str]) -> bool:
    """Check if a URL's file extension matches any in the requested list.

    Handles CDN URLs where the extension isn't at the end of the path, e.g.:
    .../photo.jpg/:/cr=t:0%25,l:0%25/rs=w:600,h:451 (GoDaddy image transforms)
    """
    parsed = urlparse(url)
    path = parsed.path.lower()
    for ext in extensions:
        ext_clean = ext.lower().lstrip(".")
        if path.endswith(f".{ext_clean}") or f".{ext_clean}/" in path:
            return True
    return False


def extract_media_urls(text: str, base_url: str = "") -> MediaUrls:
    """Extract image URLs and file/document links from page content."""
    # Markdown images: ![alt](url)
    md_images = re.findall(r"!\[.*?\]\((https?://[^)]+)\)", text, RE_FLAGS)
    # Bare image URLs
    bare_images = re.findall(rf"(https?://\S+{IMAGE_EXTENSIONS})(?:\s|$|[)\]])", text, RE_FLAGS)
    images = list(dict.fromkeys(md_images + bare_images))
    image_set = set(images)

    # File/document links
    files = re.findall(rf"(https?://\S+{FILE_EXTENSIONS})(?:\s|$|[)\]])", text, RE_FLAGS)
    files = list(dict.fromkeys(files))
    file_set = set(files)

    # Non-image markdown links: exclude ![...](url) by requiring no preceding !
    all_links = re.findall(r"(?<!!)\[([^\]]*)\]\((https?://[^)]+)\)", text, RE_FLAGS)
    links = list(dict.fromkeys(url for _, url in all_links if url not in image_set and url not in file_set))

    return {
        "images": images,
        "files": files,
        "links": links,
    }


def extract_asset_urls_from_html(html: str, base_url: str) -> List[str]:
    """Extract asset URLs from raw HTML src/href attributes.

    Captures URLs from <img src>, <a href>, <source src>, <video src>, <audio src>,
    <link href>, etc. that point to downloadable files. Resolves relative and
    protocol-relative URLs against the base URL.
    """
    attr_urls = re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', html, re.IGNORECASE)

    resolved = []
    for raw_url in attr_urls:
        raw_url = raw_url.strip()
        if not raw_url or raw_url.startswith(("data:", "javascript:", "mailto:", "#")):
            continue
        full_url = urljoin(base_url, raw_url)
        resolved.append(full_url)

    return list(dict.fromkeys(resolved))


def format_extract_results(results: List[Dict[str, Any]], full_content: bool) -> str:
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
            excerpts_list = r.get("excerpts", [])
            content = "\n".join(excerpts_list) if isinstance(excerpts_list, list) else str(excerpts_list)

        if title and content:
            formatted_parts.append(f"**{title}** ({url})\n{content}")
        elif content:
            formatted_parts.append(f"**{url}**\n{content}")

    return "\n\n---\n\n".join(formatted_parts) if formatted_parts else "No relevant content found."


# ── Orchestration ──


async def download_matching_files(
    urls: List[str],
    extensions: List[str],
    user_id: str,
) -> List[Dict[str, Any]]:
    """Download files matching requested extensions and upload to storage.

    Filters candidate URLs by extension, dedupes by filename, downloads all
    matching files via a shared HTTP client, then uploads to Supabase storage.

    Args:
        urls: Candidate URLs discovered on the page.
        extensions: Requested file extensions (e.g. ["pdf", "csv"]).
        user_id: User ID for storage path.

    Returns:
        List of FilePointer dicts for successfully uploaded files.
    """
    matching_urls = [u for u in urls if matches_extensions(u, extensions)]

    if not matching_urls:
        logger.info("No URLs matched requested extensions", extensions=extensions, candidate_count=len(urls))
        return []

    # Dedupe by base filename
    seen_filenames: set[str] = set()
    deduped_urls: list[str] = []
    for u in matching_urls:
        fname = get_filename_from_url(u)
        if fname not in seen_filenames:
            seen_filenames.add(fname)
            deduped_urls.append(u)
    matching_urls = deduped_urls

    logger.info(
        "Downloading files from web_fetch",
        matching_count=len(matching_urls),
        extensions=extensions,
    )

    # Download all files with a shared HTTP client (connection pooling)
    downloaded = await download_files_batch(matching_urls)

    file_pointers: list[Dict[str, Any]] = []
    for file_url in matching_urls:
        content = downloaded.get(file_url)
        if content is None:
            continue

        filename = get_filename_from_url(file_url)
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


async def fetch_and_extract(
    url: str,
    objective: str,
    excerpts: bool = True,
    full_content: bool = False,
    download_files: Optional[List[str]] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Fetch URL content via Parallel AI, extract media, and optionally download files.

    This is the core business logic for the web_fetch activity.

    Args:
        url: URL to fetch and extract from.
        objective: What content to focus on extracting.
        excerpts: Return focused excerpts (default: True).
        full_content: Return complete page content (default: False).
        download_files: File extensions to auto-download (e.g. ["pdf", "csv"]).
        user_id: User ID for storage uploads.

    Returns:
        Dict with content, sources, images, files, links, objective, results,
        errors, and downloaded_files.
    """
    activity.heartbeat(f"Fetching {url}: {objective[:50]}...")

    data = await fetch_parallel_ai_extract(url, objective, excerpts)

    results = data.get("results", [])
    errors = data.get("errors", [])

    if errors:
        logger.warning("Web fetch had errors", errors=errors)

    content = format_extract_results(results, full_content)
    sources = [r.get("url") for r in results if r.get("url")]

    # Extract media URLs from full page content
    media: MediaUrls = {"images": [], "files": [], "links": []}
    for r in results:
        page_text = r.get("full_content", "")
        if page_text:
            page_media = extract_media_urls(page_text, url)
            media["images"].extend(page_media["images"])
            media["files"].extend(page_media["files"])
            media["links"].extend(page_media["links"])
    media = {k: list(dict.fromkeys(v)) for k, v in media.items()}

    # Download files if requested
    downloaded_files_list: list[Dict[str, Any]] = []
    if download_files and user_id:
        candidate_urls = media["files"] + media["images"]

        # Also fetch raw HTML to extract src/href asset URLs that Parallel AI's
        # markdown conversion may have dropped
        activity.heartbeat("Fetching raw HTML for asset extraction...")
        raw_html = await fetch_raw_html(url)
        if raw_html:
            html_asset_urls = extract_asset_urls_from_html(raw_html, url)
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

        downloaded_files_list = await download_matching_files(
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
        "downloaded_files": downloaded_files_list,
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
        downloaded_count=len(downloaded_files_list),
        errors_count=len(errors),
    )

    return result
