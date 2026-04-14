"""Data access for the shared-memory domain.

HTTP calls to the backend memory API. Typed args in, typed results out.
"""

import httpx
import structlog

from config import load_config
from domains.shared_memory.config import (
    APPEND_SUFFIX,
    HTTP_TIMEOUT,
    LOG_PREFIX,
    MEMORY_API_PATH,
)
from domains.shared_memory.types import AppendEntryPayload, AppendResult, SharedMemoryData

logger = structlog.get_logger()


async def fetch_shared_memory(
    bus_id: str,
    current_hash: str | None = None,
) -> SharedMemoryData | None:
    """Fetch shared memory for a run from the backend API.

    Returns SharedMemoryData if content changed (or no hash provided),
    None if current_hash matches (304).
    """
    config = load_config()

    url = f"{config.backend.api_url}{MEMORY_API_PATH}/{bus_id}"
    if current_hash:
        url += f"?hash={current_hash}"

    headers = {
        "X-API-Key": config.backend.api_key,
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.get(url, headers=headers)

            if response.status_code == 304:
                return None

            if response.status_code == 200:
                data = response.json()
                logger.debug(
                    f"{LOG_PREFIX} Fetched memory",
                    bus_id=bus_id,
                    entry_count=len(data.get("content", [])),
                )
                return data

            logger.error(
                f"{LOG_PREFIX} Failed to fetch memory",
                bus_id=bus_id,
                status=response.status_code,
                body=response.text[:200],
            )
            return None

    except Exception as e:
        logger.error(
            f"{LOG_PREFIX} Error fetching memory",
            bus_id=bus_id,
            error=str(e),
        )
        return None


async def post_shared_memory_entry(
    bus_id: str,
    entry: AppendEntryPayload,
) -> AppendResult | None:
    """Append an entry to shared memory via the backend API.

    Returns AppendResult with the new hash on success, None on failure.
    """
    config = load_config()

    url = f"{config.backend.api_url}{MEMORY_API_PATH}/{bus_id}{APPEND_SUFFIX}"

    headers = {
        "X-API-Key": config.backend.api_key,
        "Content-Type": "application/json",
    }

    payload = {"entry": entry}

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.post(url, headers=headers, json=payload)

            if response.status_code == 200:
                return response.json()

            if response.status_code == 400:
                body = response.json()
                if "Memory limit exceeded" in body.get("error", ""):
                    logger.warning(
                        f"{LOG_PREFIX} Memory limit exceeded",
                        bus_id=bus_id,
                        max_tokens=body.get("max_tokens"),
                    )
                return None

            logger.error(
                f"{LOG_PREFIX} Failed to append",
                bus_id=bus_id,
                status=response.status_code,
                body=response.text[:200],
            )
            return None

    except Exception as e:
        logger.error(
            f"{LOG_PREFIX} Error appending",
            bus_id=bus_id,
            error=str(e),
        )
        return None
