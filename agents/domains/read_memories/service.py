"""Read Memories domain service — business logic orchestration."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict

import structlog

from domains.read_memories.repo import fetch_memories

if TYPE_CHECKING:
    from domains.read_memories.types import MemoryResult

logger = structlog.get_logger()


async def read_memories_for_user(query: str, user_id: str) -> MemoryResult:
    """Fetch and format memories from SuperMemory.

    Calls the repo layer, then normalises the response into a
    consistent ``MemoryResult`` shape.

    Args:
        query: Search query (empty string returns profile only).
        user_id: User ID for isolation.

    Returns:
        Normalised result with ``profile`` and/or ``memories`` keys.
    """
    data: Dict[str, Any] = await fetch_memories(query, user_id)

    result: MemoryResult = {}

    if "profile" in data:
        result["profile"] = data["profile"]

    if "results" in data:
        result["memories"] = data["results"]

    # If the response structure is different, include raw data
    if not result:
        return data  # type: ignore[return-value]

    logger.info(
        "Memories retrieved from SuperMemory",
        user_id=user_id,
        query=query[:100] if query else "profile_only",
        has_profile="profile" in result,
        memory_count=len(result.get("memories", [])),
    )

    return result
