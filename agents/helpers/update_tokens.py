"""
Atomic token update activity.

Updates Agent.tokensIn, tokensOut, tokenCount in the database.
Called by handle_tool_event for USAGE events with UsageType.LLM.
"""

from temporalio import activity
import structlog
import httpx

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def update_agent_tokens_activity(
    agent_id: str,
    tokens_in: int,
    tokens_out: int,
) -> None:
    """
    Atomically increment Agent token counts in the database.
    
    This activity calls PATCH /api/agents/{agent_id}/tokens to increment
    the tokensIn, tokensOut, and tokenCount fields.
    
    Args:
        agent_id: Agent ID
        tokens_in: Number of input tokens to add
        tokens_out: Number of output tokens to add
    """
    try:
        activity.heartbeat(f"Updating tokens for agent {agent_id}")
        
        config = load_config()
        
        # Calculate total
        total_tokens = tokens_in + tokens_out
        
        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}/tokens",
                json={
                    "tokensIn": tokens_in,
                    "tokensOut": tokens_out,
                    "tokenCount": total_tokens,
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=15.0
            )
            
            if response.status_code == 404:
                # Endpoint doesn't exist yet - fall back to status update
                logger.warning(
                    "Token update endpoint not found, using status update fallback",
                    agent_id=agent_id
                )
                # For now, just log - the endpoint needs to be created
                return
            
            response.raise_for_status()
            
            logger.debug(
                "Agent tokens updated",
                agent_id=agent_id,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                total=total_tokens
            )

    except Exception as e:
        # Non-fatal - just log and continue
        logger.warning(
            f"Failed to update agent tokens (non-fatal): {e}",
            agent_id=agent_id,
            tokens_in=tokens_in,
            tokens_out=tokens_out
        )


@activity.defn
async def update_agent_tree_cost_activity(
    agent_id: str,
    tree_cost_cents: int,
) -> None:
    """
    Update Agent.treeCostCents in the database (for price limit feature).

    Called by root agents to persist the accumulated tree cost for frontend display.

    Args:
        agent_id: Agent ID
        tree_cost_cents: Total tree cost in cents
    """
    try:
        activity.heartbeat(f"Updating tree cost for agent {agent_id}")

        config = load_config()

        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}",
                json={
                    "tree_cost_cents": tree_cost_cents,
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=15.0
            )

            response.raise_for_status()

            logger.debug(
                "Agent tree cost updated",
                agent_id=agent_id,
                tree_cost_cents=tree_cost_cents
            )

    except Exception as e:
        # Non-fatal - just log and continue
        logger.warning(
            f"Failed to update agent tree cost (non-fatal): {e}",
            agent_id=agent_id,
            tree_cost_cents=tree_cost_cents
        )






