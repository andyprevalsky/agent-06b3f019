"""Fast Mode binary blob storage.

Large cache values should not be written into Postgres JSON. Store raw bytes in
the existing Supabase `attachments` bucket under a dedicated cache prefix and
reference the object path from `FastModeCacheEntry.blobPath`.
"""

from __future__ import annotations

import hashlib
from typing import Optional

import httpx
import structlog

from config import load_config

logger = structlog.get_logger(__name__)

_BUCKET = "attachments"
_PREFIX = "fast-mode-cache"


def blob_path_for_key(key: str) -> str:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return f"{_PREFIX}/{digest[:2]}/{digest}"


async def upload_blob(path: str, body: bytes, content_type: str = "application/octet-stream") -> bool:
    """Upload or replace a blob if possible."""
    config = load_config()
    supabase_url = config.supabase.url
    supabase_key = config.supabase.service_role_key
    if not supabase_url or not supabase_key:
        logger.warning("demo_cache.blob_upload_missing_config", path=path)
        return False

    url = f"{supabase_url}/storage/v1/object/{_BUCKET}/{path}"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {supabase_key}",
                    "Content-Type": content_type,
                    "x-upsert": "true",
                },
                content=body,
            )
        if response.status_code in (200, 201):
            logger.info("demo_cache.blob_uploaded", path=path, bytes=len(body))
            return True
        logger.warning("demo_cache.blob_upload_failed", path=path, status=response.status_code)
        return False
    except Exception as exc:  # cache must never break a run
        logger.warning("demo_cache.blob_upload_error", path=path, error=str(exc))
        return False


async def download_blob(path: Optional[str]) -> Optional[bytes]:
    if not path:
        return None
    config = load_config()
    supabase_url = config.supabase.url
    supabase_key = config.supabase.service_role_key
    if not supabase_url or not supabase_key:
        logger.warning("demo_cache.blob_download_missing_config", path=path)
        return None

    url = f"{supabase_url}/storage/v1/object/{_BUCKET}/{path}"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(url, headers={"Authorization": f"Bearer {supabase_key}"})
        if response.status_code != 200:
            logger.warning("demo_cache.blob_download_failed", path=path, status=response.status_code)
            return None
        logger.info("demo_cache.blob_downloaded", path=path, bytes=len(response.content))
        return response.content
    except Exception as exc:  # cache must never break a run
        logger.warning("demo_cache.blob_download_error", path=path, error=str(exc))
        return None
