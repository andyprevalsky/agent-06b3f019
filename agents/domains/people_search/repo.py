"""People search domain repo - Exa API data access."""

from __future__ import annotations

from typing import Any

import httpx

from config import load_config

from .config import (
    EXA_SEARCH_CATEGORY,
    EXA_SEARCH_URL,
    EXA_TIMEOUT_SECONDS,
    MAX_TEXT_CHARACTERS,
)


async def search_people_via_exa(query: str, max_results: int) -> dict[str, Any]:
    """
    Call Exa's people search API and return raw results.

    Args:
        query: Natural language query describing the person.
        max_results: Maximum number of results to return (1-100).

    Returns:
        Raw JSON response from Exa API containing 'results' list.

    Raises:
        httpx.HTTPStatusError: On non-2xx responses.
    """
    config = load_config()
    api_key = config.exa.api_key

    headers = {"x-api-key": api_key, "Content-Type": "application/json"}

    payload = {
        "query": query,
        "category": EXA_SEARCH_CATEGORY,
        "numResults": max_results,
        "contents": {"text": {"maxCharacters": MAX_TEXT_CHARACTERS}},
    }

    async with httpx.AsyncClient(timeout=EXA_TIMEOUT_SECONDS) as client:
        response = await client.post(EXA_SEARCH_URL, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()
