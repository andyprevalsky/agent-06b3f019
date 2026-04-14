"""Data access for the search-user-network domain.

Calls the backend /api/people/search endpoint for semantic/embedding-based
search across the user's stored contacts.
"""

from typing import Any, Dict

import httpx
import structlog
from temporalio import activity

from config import load_config

from .config import HTTP_TIMEOUT, INTERNAL_FIELDS

logger = structlog.get_logger()


async def fetch_network_matches(user_id: str, tool_call: Dict[str, Any]) -> Dict[str, Any]:
    """
    Search user's network for people matching criteria.

    Args:
        user_id: Supabase user ID
        tool_call: Dict with person signals (first_name, last_name, profession, etc.)

    Returns:
        Dict with results, count, and query keys.

    Raises:
        ValueError: On HTTP errors or timeouts.
    """
    activity.heartbeat("Starting network search")

    person_signals = {k: v for k, v in tool_call.items() if k not in INTERNAL_FIELDS and v is not None}

    config = load_config()

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/people/search",
            json=person_signals,
            headers={
                "X-API-Key": config.backend.api_key,
                "X-User-Id": user_id,
            },
        )

        activity.heartbeat("Search request sent")

        if response.status_code != 200:
            error_detail = response.text
            logger.error("Network search failed", status=response.status_code, error=error_detail)
            raise ValueError(f"Backend API error ({response.status_code}): {error_detail}")

        result = response.json()
        results = result.get("results", [])
        count = result.get("count", 0)

        activity.heartbeat(f"Found {count} matches")

        logger.info(
            "Network search completed",
            user_id=user_id,
            count=count,
            query_keys=list(person_signals.keys()),
        )

        return {"results": results, "count": count, "query": person_signals}
