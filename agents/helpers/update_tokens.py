"""Workflow-fenced agent accounting activities."""

from typing import Optional

import structlog
from temporalio import activity

from config import load_config
from helpers.http_client import get_http_client
from helpers.workflow_generation import workflow_generation_headers

logger = structlog.get_logger()


@activity.defn
async def update_agent_tree_cost_activity(
    agent_id: str,
    tree_cost_cents: int,
    own_cost_cents: float = 0,
) -> Optional[int]:
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

        client = get_http_client()
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
        # The stored tree cost: the backend adds the resume spend under this agent (no
        # workflow's in-memory cost includes it), for the root's limit check.
        stored = ((response.json() or {}).get("agent") or {}).get("tree_cost_cents")
        return int(stored) if isinstance(stored, (int, float)) else None

    except Exception as e:
        logger.warning(
            f"Failed to update agent cost (non-fatal): {e}",
            agent_id=agent_id,
            tree_cost_cents=tree_cost_cents,
        )


@activity.defn
async def apply_resume_cost_activity(owner_agent_id: str, key: str, total_cents: float) -> dict:
    """A resume run's ABSOLUTE total spend (backend POST /:id/resume-cost).

    The backend keeps one monotonic total per run key and adds only its growth to the
    owner's and ancestors' tree cost, so a resend or an older total changes nothing.
    Returns ``{"limit_reached": bool}`` for the owner's root.
    """
    config = load_config()
    client = get_http_client()
    response = await client.post(
        f"{config.backend.api_url}/api/agents/{owner_agent_id}/resume-cost",
        json={"key": key, "total_cents": total_cents},
        headers={
            "X-API-Key": config.backend.api_key,
            "Content-Type": "application/json",
            **workflow_generation_headers(),
        },
        timeout=15.0,
    )
    response.raise_for_status()
    return response.json()
