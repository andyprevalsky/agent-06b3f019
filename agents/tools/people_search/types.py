"""People search domain types."""

from typing import Any, Awaitable, Callable, Dict, List, Optional, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class PersonSource(TypedDict):
    """Provenance for a single normalized person result."""

    provider: str  # "exa" | "parallel"
    url: Optional[str]
    snippet: Optional[str]


class PersonResult(TypedDict, total=False):
    """One normalized person, provider-agnostic.

    For mode='discover', the standard profile fields are populated. For
    mode='enrich', ``attributes`` carries the caller-requested ``fields``.
    """

    name: Optional[str]
    profile_url: Optional[str]
    title: Optional[str]
    company: Optional[str]
    location: Optional[str]
    summary: Optional[str]
    attributes: Dict[str, Any]  # enrich: requested fields -> value (or None)
    source: PersonSource
    confidence: str  # "high" | "medium" | "low"


class PeopleSearchResult(TypedDict):
    """Structured normalized result returned by the people_search tool."""

    query: str
    mode_used: str  # "enrich" | "discover"
    provider_used: str  # "exa" | "parallel"
    providers_attempted: List[str]
    results: List[PersonResult]
    warnings: List[str]
