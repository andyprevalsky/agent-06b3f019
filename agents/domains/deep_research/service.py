"""Business logic for the deep-research domain.

Pure functions for computing usage costs and formatting results.
No I/O, no framework dependencies.
"""

from typing import Any

from domains.deep_research.repo import deep_research_activity as deep_research_activity

from domains.deep_research.config import (
    PRICE_CITATION_TOKENS_PER_MILLION,
    PRICE_INPUT_TOKENS_PER_MILLION,
    PRICE_OUTPUT_TOKENS_PER_MILLION,
    PRICE_REASONING_TOKENS_PER_MILLION,
    PRICE_SEARCH_CENTS_PER_THOUSAND,
)
from domains.deep_research.types import DeepResearchResult


def compute_service_usage(result: DeepResearchResult) -> list[dict[str, Any]]:
    """Compute Perplexity service usage costs from a research result."""
    service_usage: list[dict[str, Any]] = []

    usage = result.get("usage")
    if not usage:
        return service_usage

    if usage.get("input_tokens"):
        cost = (usage["input_tokens"] * PRICE_INPUT_TOKENS_PER_MILLION) // 1_000_000
        service_usage.append({"cost_cents": cost, "provider": "Perplexity Input Tokens"})

    if usage.get("output_tokens"):
        cost = (usage["output_tokens"] * PRICE_OUTPUT_TOKENS_PER_MILLION) // 1_000_000
        service_usage.append({"cost_cents": cost, "provider": "Perplexity Output Tokens"})

    if usage.get("citation_tokens"):
        cost = (usage["citation_tokens"] * PRICE_CITATION_TOKENS_PER_MILLION) // 1_000_000
        service_usage.append({"cost_cents": cost, "provider": "Perplexity Citation Tokens"})

    if usage.get("reasoning_tokens"):
        cost = (usage["reasoning_tokens"] * PRICE_REASONING_TOKENS_PER_MILLION) // 1_000_000
        service_usage.append({"cost_cents": cost, "provider": "Perplexity Reasoning Tokens"})

    if usage.get("search_count"):
        cost = (usage["search_count"] * PRICE_SEARCH_CENTS_PER_THOUSAND) // 10  # 0.5 cents per search
        service_usage.append({"cost_cents": cost, "provider": "Perplexity Search Queries"})

    return service_usage


def build_completion_message(result: DeepResearchResult) -> str:
    """Build the user-facing completion message from a research result."""
    report = result.get("report", "")
    citations = result.get("citations", [])
    citation_count = result.get("citation_count", len(citations))

    if citation_count > 0:
        suffix = "s" if citation_count != 1 else ""
        return f"{report}\n\n*Research complete with {citation_count} citation{suffix}*"
    return report
