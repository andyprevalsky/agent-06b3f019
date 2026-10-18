"""People search domain types."""

from typing import Any, Awaitable, Callable, Dict, List, NotRequired, Optional, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class PersonSource(TypedDict):
    """Provenance for a single normalized person result."""

    provider: str  # "lantern"
    url: Optional[str]
    snippet: Optional[str]
    record_id: NotRequired[Optional[str]]
    retrieved_at: NotRequired[Optional[str]]


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
    profile: Dict[str, Any]  # Full returned source record, including provenance.


class PeopleSearchResult(TypedDict):
    """Structured normalized result returned by the people_search tool."""

    query: str
    mode_used: str  # "enrich" | "discover"
    provider_used: str  # "lantern"
    providers_attempted: List[str]
    results: List[PersonResult]
    warnings: List[str]
    next_cursor: NotRequired[Optional[str]]
    generation: NotRequired[Optional[str]]
    source_metadata: NotRequired[Dict[str, Any]]
    search_metadata: NotRequired[Dict[str, Any]]
