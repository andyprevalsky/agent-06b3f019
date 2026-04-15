"""Web search domain types."""

from typing import Any, Awaitable, Callable, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class SearchResult(TypedDict):
    """Structured result from a web search."""

    answer: str
    sources: list[str]
    query: str
    provider: str
