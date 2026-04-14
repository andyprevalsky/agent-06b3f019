"""Types for the shared-memory domain."""

from typing import Any, TypedDict


class MemoryEntry(TypedDict, total=False):
    """A single entry in shared memory."""

    type: str
    content: str
    timestamp: str
    message_id: str
    files: list[dict[str, str]]


class SharedMemoryData(TypedDict):
    """Response from fetching shared memory."""

    content: list[MemoryEntry]
    hash: str


class AppendResult(TypedDict):
    """Response from appending to shared memory."""

    hash: str


class AppendEntryPayload(TypedDict, total=False):
    """Payload shape for the entry object sent to the append endpoint."""

    type: str
    content: str
    message_id: str
    files: list[dict[str, Any]]
