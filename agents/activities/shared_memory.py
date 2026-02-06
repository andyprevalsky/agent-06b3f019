"""
Shared Memory Activities - Get and append to shared memory for agent runs.

Shared memory allows all agents in a run (sharing the same busId) to access
a common memory store. This is used to persist user messages across all agents.
"""

from typing import Dict, List, Optional, Any
from temporalio import activity
import httpx
import structlog

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def get_shared_memory(bus_id: str, current_hash: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Fetch shared memory for a run.

    Args:
        bus_id: The busId (root agent ID) that identifies the run
        current_hash: Optional hash of currently cached content

    Returns:
        Dict with { content: List[MemoryEntry], hash: str } if changed or no hash provided
        None if current_hash matches (no update needed)
    """
    config = load_config()

    url = f"{config.backend.api_url}/api/memory/{bus_id}"
    if current_hash:
        url += f"?hash={current_hash}"

    headers = {
        "X-API-Key": config.backend.api_key,
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)

            if response.status_code == 304:
                # Hash matches, no update needed
                return None

            if response.status_code == 200:
                data = response.json()
                logger.debug(
                    "[SharedMemory] Fetched memory",
                    bus_id=bus_id,
                    entry_count=len(data.get("content", [])),
                )
                return data

            logger.error(
                "[SharedMemory] Failed to fetch memory",
                bus_id=bus_id,
                status=response.status_code,
                body=response.text[:200],
            )
            return None

    except Exception as e:
        logger.error(
            "[SharedMemory] Error fetching memory",
            bus_id=bus_id,
            error=str(e),
        )
        return None


@activity.defn
async def append_shared_memory(
    bus_id: str,
    entry_type: str,
    content: str,
    message_id: Optional[str] = None,
    files: Optional[List[Dict[str, str]]] = None,
) -> Optional[Dict[str, str]]:
    """
    Append an entry to shared memory.

    Args:
        bus_id: The busId (root agent ID) that identifies the run
        entry_type: Type of entry (e.g., "USER_MESSAGE")
        content: The content to append
        message_id: Optional message ID for deduplication
        files: Optional list of file references [{ original_filename, mime_type }]

    Returns:
        Dict with { hash: str } on success, None on failure
    """
    config = load_config()

    url = f"{config.backend.api_url}/api/memory/{bus_id}/append"

    headers = {
        "X-API-Key": config.backend.api_key,
        "Content-Type": "application/json",
    }

    entry: Dict[str, Any] = {
        "type": entry_type,
        "content": content,
    }
    if message_id:
        entry["message_id"] = message_id
    if files:
        entry["files"] = files

    payload = {"entry": entry}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, headers=headers, json=payload)

            if response.status_code == 200:
                data = response.json()
                logger.info(
                    "[SharedMemory] Appended entry",
                    bus_id=bus_id,
                    type=entry_type,
                    message_id=message_id,
                )
                return data

            if response.status_code == 400:
                # Could be token limit exceeded or duplicate message
                body = response.json()
                if "Memory limit exceeded" in body.get("error", ""):
                    logger.warning(
                        "[SharedMemory] Memory limit exceeded",
                        bus_id=bus_id,
                        max_tokens=body.get("max_tokens"),
                    )
                return None

            logger.error(
                "[SharedMemory] Failed to append",
                bus_id=bus_id,
                status=response.status_code,
                body=response.text[:200],
            )
            return None

    except Exception as e:
        logger.error(
            "[SharedMemory] Error appending",
            bus_id=bus_id,
            error=str(e),
        )
        return None
