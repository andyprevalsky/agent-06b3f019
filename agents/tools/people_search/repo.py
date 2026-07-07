"""People search data access -- sync HTTP calls to Exa and Parallel."""

from __future__ import annotations

from typing import Any, Optional

from helpers.http_client import get_http_client
from tools.people_search.config import (
    EXA_CATEGORY,
    EXA_SEARCH_URL,
    EXA_TYPE,
    HTTP_TIMEOUT,
    PARALLEL_ENTITY_SEARCH_URL,
    PARALLEL_ENTITY_TYPE,
)


def build_exa_output_schema(fields: list[str]) -> dict[str, Any]:
    """Build an Exa ``outputSchema`` requesting the given attribute names.

    Exa synthesizes structured output per result against this JSON schema. We
    request each field as an optional string so partial data still returns.
    """
    return {
        "type": "object",
        "properties": {field: {"type": "string"} for field in fields},
        "required": [],
    }


async def fetch_exa_people(
    query: str,
    api_key: str,
    num_results: int,
    output_schema: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Call Exa Search API (people category) and return raw results list.

    Args:
        query: Natural-language people request.
        api_key: Exa API key.
        num_results: Number of results to request (Exa supports 1-100).
        output_schema: Optional Exa ``outputSchema`` for field-level enrichment.

    Returns:
        List of result dicts from the API's ``results`` array.

    Raises:
        httpx.HTTPStatusError: On non-2xx response (incl. 429 rate-limit).
        httpx.TimeoutException: On request timeout.
    """
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }

    payload: dict[str, Any] = {
        "query": query,
        "category": EXA_CATEGORY,
        "type": EXA_TYPE,
        "numResults": num_results,
        # Highlights are token-efficient, query-relevant excerpts.
        "contents": {"highlights": True},
    }
    if output_schema is not None:
        payload["outputSchema"] = output_schema

    response = await get_http_client().post(EXA_SEARCH_URL, headers=headers, json=payload, timeout=HTTP_TIMEOUT)
    response.raise_for_status()
    data = response.json()

    return data.get("results", [])


async def fetch_parallel_people(
    objective: str,
    api_key: str,
    match_limit: int,
) -> list[dict[str, Any]]:
    """Call Parallel Fast Entity Search and return raw entities list.

    Recall-optimized; returns fixed attributes (name, url, description) with no
    citations or deep enrichment.

    Args:
        objective: Natural-language description of the target people.
        api_key: Parallel API key.
        match_limit: Number of matches to request (Parallel requires >= 5).

    Returns:
        List of entity dicts from the API's ``entities`` array.

    Raises:
        httpx.HTTPStatusError: On non-2xx response (incl. 429 rate-limit).
        httpx.TimeoutException: On request timeout.
    """
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }

    payload = {
        "entity_type": PARALLEL_ENTITY_TYPE,
        "objective": objective,
        "match_limit": match_limit,
    }

    response = await get_http_client().post(
        PARALLEL_ENTITY_SEARCH_URL, headers=headers, json=payload, timeout=HTTP_TIMEOUT
    )
    response.raise_for_status()
    data = response.json()

    return data.get("entities", [])
