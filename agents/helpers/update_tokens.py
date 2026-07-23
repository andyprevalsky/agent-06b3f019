"""Workflow-fenced agent accounting activities."""

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.workflow_generation import workflow_generation_headers

logger = structlog.get_logger()


@activity.defn
async def update_agent_tree_cost_activity(
    agent_id: str,
    tree_cost_cents: int,
    own_cost_cents: float = 0,
) -> None:
    """
    Update Agent.treeCostCents and ownCostCents in the database.

    Args:
        agent_id: Agent ID
        tree_cost_cents: Subtree cost in cents (for frontend display + price limit)
        own_cost_cents: This agent's own cost in cents (actual_model-aware)
    """
    try:
        activity.heartbeat(f"Updating cost for agent {agent_id}")

        config = load_config()

        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}",
                json={
                    "tree_cost_cents": tree_cost_cents,
                    "own_cost_cents": own_cost_cents,
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json",
                    **workflow_generation_headers(),
                },
                timeout=15.0,
            )

            response.raise_for_status()

            logger.debug(
                "Agent cost updated",
                agent_id=agent_id,
                tree_cost_cents=tree_cost_cents,
                own_cost_cents=own_cost_cents,
            )

    except Exception as e:
        logger.warning(
            f"Failed to update agent cost (non-fatal): {e}",
            agent_id=agent_id,
            tree_cost_cents=tree_cost_cents,
        )
