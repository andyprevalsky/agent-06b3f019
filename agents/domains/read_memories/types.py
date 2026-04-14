"""Read Memories domain types — schemas, type aliases, and typed dicts."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List, TypedDict

# Type alias for execute_activity callable used by tool managers
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class MemoryResult(TypedDict, total=False):
    """Structured result from SuperMemory profile/search."""

    profile: Dict[str, Any]
    memories: List[Dict[str, Any]]
