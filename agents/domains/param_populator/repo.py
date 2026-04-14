"""param_populator domain — data access layer.

Wraps external data fetching so the service layer never touches I/O directly.
"""

from __future__ import annotations

from typing import Any

from helpers.fetch_config import _fetch_agent_data_impl


async def fetch_agent_context(agent_id: str) -> list[dict[str, Any]]:
    """Fetch the conversation messages for an agent from the backend DB.

    Returns:
        List of message dicts (the ``messages`` key from the agent endpoint).
    """
    data = await _fetch_agent_data_impl(agent_id)
    return data.get("messages", [])
