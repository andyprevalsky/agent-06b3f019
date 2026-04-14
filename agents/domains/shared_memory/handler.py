"""Handler layer for the shared-memory domain.

Thin Temporal activity wrappers: parse input, call service, return output.
"""

from typing import Any

from temporalio import activity

from domains.shared_memory.service import append_memory, get_memory
from domains.shared_memory.types import AppendResult, SharedMemoryData


@activity.defn
async def get_shared_memory(
    bus_id: str,
    current_hash: str | None = None,
) -> SharedMemoryData | None:
    """Fetch shared memory for a run.

    Returns dict with content and hash if changed, None if unchanged (304).
    """
    return await get_memory(bus_id=bus_id, current_hash=current_hash)


@activity.defn
async def append_shared_memory(
    bus_id: str,
    entry_type: str,
    content: str,
    message_id: str | None = None,
    files: list[dict[str, Any]] | None = None,
) -> AppendResult | None:
    """Append an entry to shared memory.

    Returns dict with hash on success, None on failure.
    """
    return await append_memory(
        bus_id=bus_id,
        entry_type=entry_type,
        content=content,
        message_id=message_id,
        files=files,
    )
