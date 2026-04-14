"""add-memory domain types — schemas, typed dicts, and type aliases."""

from typing import Any, Awaitable, Callable, Dict, TypedDict

ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class MemoryResult(TypedDict):
    """Result returned by the SuperMemory document API."""

    document_id: str | None
    status: str
    message: str


class ToolResult(TypedDict):
    """Result returned by the add_memory tool entry point."""

    result: MemoryResult
    usage: Dict[str, list[Any]]
