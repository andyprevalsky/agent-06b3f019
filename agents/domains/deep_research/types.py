"""Types for the deep-research domain."""

from typing import Any, Awaitable, Callable, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class PerplexityUsage(TypedDict, total=False):
    """Usage data returned by Perplexity API."""

    input_tokens: int
    output_tokens: int
    citation_tokens: int
    reasoning_tokens: int
    search_count: int


class DeepResearchResult(TypedDict, total=False):
    """Result from a deep research activity call."""

    report: str
    citations: list[str]
    query: str
    model: str
    report_length: int
    citation_count: int
    usage: PerplexityUsage | None
