"""Read Memories domain repo — data access to SuperMemory API."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict

import httpx

from domains.read_memories.config import (
    REQUEST_TIMEOUT_SECS,
    SUPERMEMORY_API_KEY,
    SUPERMEMORY_PROFILE_URL,
)

if TYPE_CHECKING:
    from domains.read_memories.types import MemoryResult


async def fetch_memories(query: str, user_id: str) -> MemoryResult:
    """Call SuperMemory /v4/profile endpoint.

    Args:
        query: Search query (empty string returns profile only).
        user_id: User ID used as containerTag for isolation.

    Returns:
        Raw response data from SuperMemory.

    Raises:
        ValueError: If SUPERMEMORY_API_KEY is not configured.
        httpx.HTTPStatusError: If the API returns a non-2xx status.
    """
    if not SUPERMEMORY_API_KEY:
        raise ValueError("SUPERMEMORY_API_KEY not configured")

    payload: Dict[str, Any] = {"containerTag": user_id}
    if query:
        payload["q"] = query

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECS) as client:
        response = await client.post(
            SUPERMEMORY_PROFILE_URL,
            headers={
                "x-supermemory-api-key": SUPERMEMORY_API_KEY,
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        return response.json()
