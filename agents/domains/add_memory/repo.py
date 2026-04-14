"""add-memory domain repo — data access to the SuperMemory API."""

import httpx
import structlog

from domains.add_memory.config import SUPERMEMORY_API_URL, SUPERMEMORY_TIMEOUT_SECONDS, get_supermemory_api_key
from domains.add_memory.types import MemoryResult

logger = structlog.get_logger()


async def save_memory_document(content: str, user_id: str) -> MemoryResult:
    """Store a memory document in SuperMemory.

    Args:
        content: The memory content to store.
        user_id: User ID used as containerTag for isolation.

    Returns:
        MemoryResult with document_id, status, and message.
    """
    api_key = get_supermemory_api_key()

    async with httpx.AsyncClient(timeout=SUPERMEMORY_TIMEOUT_SECONDS) as client:
        response = await client.post(
            SUPERMEMORY_API_URL,
            headers={
                "x-supermemory-api-key": api_key,
                "Content-Type": "application/json",
            },
            json={
                "content": content,
                "containerTag": user_id,
            },
        )
        response.raise_for_status()
        data = response.json()

    logger.info(
        "Memory saved to SuperMemory",
        document_id=data.get("id"),
        user_id=user_id,
        content_length=len(content),
    )

    return MemoryResult(
        document_id=data.get("id"),
        status=data.get("status", "queued"),
        message="Memory saved successfully",
    )
