"""Helper activity for saving tool usage to database."""

from typing import Any, Dict, List

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.workflow_generation import workflow_generation_headers

logger = structlog.get_logger()


@activity.defn
async def save_tool_usage(agent_id: str, user_id: str, tool_name: str, usage_items: List[Dict[str, Any]]) -> None:
    """
    Activity: Save tool usage to database.

    Args:
        agent_id: Agent ID
        user_id: User ID
        tool_name: Tool name (e.g., "web_search", "web_fetch")
        usage_items: List of UsageItem dicts with cost breakdown

    Note:
        This activity has a short timeout (10s) so it can retry independently
        from the expensive tool execution that produced the usage data.
    """
    try:
        activity.heartbeat(f"Saving usage for {tool_name}")

        # Calculate total cost from usage items
        total_cost_cents = sum(item.get("cost_cents", 0) for item in usage_items)

        logger.info(
            "Saving tool usage",
            agent_id=agent_id,
            tool_name=tool_name,
            total_cost_cents=total_cost_cents,
            item_count=len(usage_items),
        )

        config = load_config()
        backend_url = config.backend.api_url.rstrip("/")
        api_key = config.backend.api_key

        if not api_key:
            logger.error("BACKEND_API_KEY not configured")
            raise ValueError("BACKEND_API_KEY required for saving tool usage")

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{backend_url}/api/tool-usage",
                headers={
                    "X-API-Key": api_key,
                    "Content-Type": "application/json",
                    **workflow_generation_headers(),
                },
                json={
                    "agent_id": agent_id,
                    "user_id": user_id,
                    "tool_name": tool_name,
                    "total_cost_cents": total_cost_cents,
                    "usage_items": usage_items,
                },
            )

            if response.status_code not in (200, 201):
                logger.error("Failed to save tool usage", status_code=response.status_code, response_text=response.text)
                response.raise_for_status()

            logger.info("Tool usage saved", agent_id=agent_id, tool_name=tool_name, total_cost_cents=total_cost_cents)

    except Exception as e:
        logger.error("Failed to save tool usage", error=str(e), agent_id=agent_id, tool_name=tool_name)
        raise
