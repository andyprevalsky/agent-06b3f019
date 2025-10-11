"""Tool for updating agent status in real-time."""

from temporalio import activity
import structlog
import httpx
from typing import Optional

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def update_agent_status(
    agent_id: str,
    status: str,
    progress: float,
    status_message: str,
    token_count: int,
    context_size: int,
    message_count: int
) -> None:
    """
    Update agent status and metrics in the database.
    
    Args:
        agent_id: Agent ID
        status: Status value (STARTING_UP, ACTIVE, PAUSED, COMPLETED, FAILED)
        progress: Progress as 0.0-1.0
        status_message: Status message
        token_count: Cumulative tokens used
        context_size: Current context window usage in tokens
        message_count: Total messages in context
    """
    try:
        activity.heartbeat(f"Updating agent status: {status}")
        
        config = load_config()
        
        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}/status",
                json={
                    "status": status,
                    "progress": progress,
                    "statusMessage": status_message,
                    "tokenCount": token_count,
                    "contextSize": context_size,
                    "messageCount": message_count
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=30.0
            )
            response.raise_for_status()
            
            logger.info(
                "Agent status updated",
                agent_id=agent_id,
                status=status,
                progress=progress,
                tokens=token_count,
                context_size=context_size,
                messages=message_count
            )
            
    except Exception as e:
        logger.error(
            "Failed to update agent status",
            agent_id=agent_id,
            error=str(e)
        )
        # Non-fatal - just log and continue

