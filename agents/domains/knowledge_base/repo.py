"""Data access for the knowledge-base domain.

All HTTP calls to the backend blueprints API live here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from domains.knowledge_base.types import BlueprintSearchResult, SavedBlueprintResponse


async def search_blueprints(
    *,
    api_url: str,
    api_key: str,
    goal: str,
    user_id: str,
    limit: int,
) -> list[BlueprintSearchResult]:
    """Search blueprints by goal similarity via the backend API.

    Returns:
        List of matching blueprints ordered by similarity.
    """
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_url}/api/blueprints/search",
            json={"goal": goal, "user_id": user_id, "limit": limit},
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()


async def save_blueprint(
    *,
    api_url: str,
    api_key: str,
    user_id: str,
    title: str,
    blueprint: str,
) -> SavedBlueprintResponse:
    """Persist a compressed blueprint via the backend API.

    Returns:
        The created blueprint record.
    """
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_url}/api/blueprints",
            json={"user_id": user_id, "title": title, "blueprint": blueprint},
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()
