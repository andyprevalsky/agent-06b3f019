"""Business logic for the shared-memory domain.

Orchestrates repo calls. Typed args in, typed results out.
"""

from typing import Any

import structlog

from domains.shared_memory.config import LOG_PREFIX
from domains.shared_memory.repo import fetch_shared_memory, post_shared_memory_entry
from domains.shared_memory.types import AppendEntryPayload, AppendResult, SharedMemoryData

logger = structlog.get_logger()


async def get_memory(
    bus_id: str,
    current_hash: str | None = None,
) -> SharedMemoryData | None:
    """Fetch shared memory for a run, returning None if unchanged."""
    return await fetch_shared_memory(bus_id=bus_id, current_hash=current_hash)


async def append_memory(
    bus_id: str,
    entry_type: str,
    content: str,
    message_id: str | None = None,
    files: list[dict[str, Any]] | None = None,
) -> AppendResult | None:
    """Append an entry to shared memory.

    Builds the entry payload and delegates to the repo layer.
    """
    entry: AppendEntryPayload = {
        "type": entry_type,
        "content": content,
    }
    if message_id:
        entry["message_id"] = message_id
    if files:
        entry["files"] = files

    result = await post_shared_memory_entry(bus_id=bus_id, entry=entry)

    if result is not None:
        logger.info(
            f"{LOG_PREFIX} Appended entry",
            bus_id=bus_id,
            type=entry_type,
            message_id=message_id,
        )

    return result
