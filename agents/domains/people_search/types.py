"""People search domain types - schemas, type aliases, and data structures."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class PersonResult(TypedDict):
    """A single person result from Exa search."""

    name: str
    title: str
    url: str
    profile_text: str
    image: str


class PeopleSearchResult(TypedDict):
    """Full result from a people search query."""

    candidates: list[PersonResult]
    answer: str
    query: str
    provider: str
    results_count: int
