"""Entry point for the search-user-network domain.

Thin handler: wires tool calls to the service layer and exposes
the Temporal activity for worker registration.
"""

from typing import Any, Dict, Optional

import httpx
import structlog
from temporalio import activity

from tools.base import ToolManager

from .repo import fetch_network_matches
from .service import execute_search
from .types import ExecuteActivityCallable

logger = structlog.get_logger()


class SearchUserNetworkManager(ToolManager):
    """Manager for search_user_network_for_people tool."""

    tool_name = "search_user_network_for_people"
    read_only = True

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute network search via the service layer."""
        return await execute_search(
            execute_activity=execute_activity,
            activity_fn=search_user_network_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )


# Singleton
_manager: Optional[SearchUserNetworkManager] = None


def get_manager() -> SearchUserNetworkManager:
    """Get or create search user network manager singleton."""
    global _manager
    if _manager is None:
        _manager = SearchUserNetworkManager()
    return _manager


async def search_user_network_for_people(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute search_user_network_for_people tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with person signals
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for search scope

    Returns:
        Result dict with search results.
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


@activity.defn
async def search_user_network_activity(user_id: str, tool_call: Dict[str, Any]) -> Dict[str, Any]:
    """
    Activity: Search user's network for people matching criteria.

    Delegates to the repo layer for data access.

    Args:
        user_id: Supabase user ID
        tool_call: Dict with person signals

    Returns:
        Dict with results, count, and query.
    """
    try:
        return await fetch_network_matches(user_id, tool_call)
    except httpx.TimeoutException as e:
        logger.error("Network search timeout", user_id=user_id)
        raise ValueError("Request timed out while searching network") from e
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Network search HTTP error", error=error_msg, user_id=user_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Network search error", error=str(e), user_id=user_id)
        raise
