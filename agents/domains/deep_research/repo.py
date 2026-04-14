"""Data access for the deep-research domain.

Calls the Perplexity API via OpenAI-compatible client.
This is a Temporal activity — safe to use I/O, network, etc.
"""

import contextlib

import structlog
from temporalio import activity

from config import load_config
from domains.deep_research.config import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_TEMPERATURE,
    PERPLEXITY_BASE_URL,
    PERPLEXITY_MODEL,
    RESEARCH_SYSTEM_PROMPT,
)
from domains.deep_research.types import DeepResearchResult

logger = structlog.get_logger()


@activity.defn
async def deep_research_activity(query: str, max_tokens: int = DEFAULT_MAX_TOKENS) -> DeepResearchResult:
    """Activity: Perform deep research using Perplexity API.

    Returns result with usage data for event-driven reporting.

    Note: Default max_tokens increased to 8000 to allow for more comprehensive
    reports. Deep research can take 30-120 seconds regardless of length.
    """
    # Import OpenAI here to avoid threading.local issues in workflow context
    from openai import AsyncOpenAI

    try:
        # Heartbeat
        with contextlib.suppress(RuntimeError):
            activity.heartbeat(f"Deep researching: {query}")

        config = load_config()
        # Create client inside activity — safe from Temporal determinism constraints
        client = AsyncOpenAI(api_key=config.perplexity.api_key, base_url=PERPLEXITY_BASE_URL)

        # Call Perplexity's deep research model
        response = await client.chat.completions.create(
            model=PERPLEXITY_MODEL,
            messages=[
                {"role": "system", "content": RESEARCH_SYSTEM_PROMPT},
                {"role": "user", "content": query},
            ],
            max_tokens=max_tokens,
            temperature=DEFAULT_TEMPERATURE,
        )

        report = response.choices[0].message.content

        # Extract citations
        citations: list[str] = []
        if hasattr(response, "citations") and response.citations:
            citations = response.citations
        elif hasattr(response.choices[0].message, "citations") and response.choices[0].message.citations:
            citations = response.choices[0].message.citations

        # Extract usage (Perplexity returns detailed usage)
        usage = None
        if hasattr(response, "usage") and response.usage:
            usage = {
                "input_tokens": getattr(response.usage, "prompt_tokens", 0),
                "output_tokens": getattr(response.usage, "completion_tokens", 0),
                "citation_tokens": getattr(response.usage, "citation_tokens", 0),
                "reasoning_tokens": getattr(response.usage, "reasoning_tokens", 0),
                "search_count": getattr(response.usage, "num_search_queries", 0),
            }

        result: DeepResearchResult = {
            "report": report,
            "citations": citations,
            "query": query,
            "model": PERPLEXITY_MODEL,
            "report_length": len(report),
            "citation_count": len(citations),
            "usage": usage,
        }

        logger.info(
            "Deep research completed",
            query=query,
            report_length=len(report),
            citation_count=len(citations),
            has_usage=usage is not None,
        )

        return result

    except Exception as e:
        logger.error("Deep research failed", error=str(e), query=query)
        raise
