"""Tool for updating agent status in real-time.

This is the SINGLE helper for PATCH /api/agents/{agent_id}/status.
Other helpers should import and use _update_agent_status_impl directly.
"""

from typing import Dict, Optional

import structlog
from temporalio import activity

from config import load_config
from helpers.http_client import get_http_client
from helpers.workflow_generation import workflow_generation_headers

logger = structlog.get_logger()


async def _update_agent_status_impl(
    agent_id: str,
    status: str,
    progress: float,
    status_message: str,
    token_count: int,
    context_size: int,
    message_count: int,
    tokens_in: int = 0,
    tokens_out: int = 0,
    structured_response: Optional[Dict] = None,
    iteration_offset: Optional[int] = None,
) -> None:
    """
    Core implementation for updating agent status.

    This is the SINGLE function that calls PATCH /api/agents/{agent_id}/status.
    Can be called directly from other activities or via the activity wrapper.

    Args:
        agent_id: Agent ID
        status: Status value (STARTING_UP, ACTIVE, PAUSED, COMPLETED, FAILED)
        progress: Progress as 0.0-1.0
        status_message: Status message
        token_count: Cumulative tokens used (total)
        context_size: Current context window usage in tokens
        message_count: Total messages in context
        tokens_in: Input tokens (prompt)
        tokens_out: Output tokens (completion)
        structured_response: Extracted structured output (when completing with schema)
    """
    config = load_config()

    client = get_http_client()
    payload = {
        "status": status,
        "progress": progress,
        "statusMessage": status_message,
        "tokenCount": token_count,
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "contextSize": context_size,
        "messageCount": message_count,
    }
    if structured_response is not None:
        payload["structuredResponse"] = structured_response
    if iteration_offset is not None:
        payload["iterationOffset"] = iteration_offset

    response = await client.patch(
        f"{config.backend.api_url}/api/agents/{agent_id}/status",
        json=payload,
        headers={
            "X-API-Key": config.backend.api_key,
            "Content-Type": "application/json",
            **workflow_generation_headers(),
        },
        timeout=30.0,
    )
    response.raise_for_status()

    logger.info(
        "Agent status updated",
        agent_id=agent_id,
        status=status,
        progress=progress,
        tokens=token_count,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        context_size=context_size,
        messages=message_count,
    )


@activity.defn
async def update_agent_status(
    agent_id: str,
    status: str,
    progress: float,
    status_message: str,
    token_count: int,
    context_size: int,
    message_count: int,
    tokens_in: int = 0,
    tokens_out: int = 0,
    structured_response: Optional[Dict] = None,
    iteration_offset: Optional[int] = None,
) -> None:
    """
    Activity wrapper for updating agent status and metrics in the database.
    """
    try:
        activity.heartbeat(f"Updating agent status: {status}")
        await _update_agent_status_impl(
            agent_id=agent_id,
            status=status,
            progress=progress,
            status_message=status_message,
            token_count=token_count,
            context_size=context_size,
            message_count=message_count,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            structured_response=structured_response,
            iteration_offset=iteration_offset,
        )
    except Exception as e:
        logger.error("Failed to update agent status", agent_id=agent_id, error=str(e))
        # Non-fatal - just log and continue


async def publish_progress_estimate(agent_id: str, estimate: Dict) -> None:
    """Estimate-only PATCH; backend fences terminal state, generation and sequence."""
    config = load_config()
    response = await get_http_client().patch(
        f"{config.backend.api_url}/api/agents/{agent_id}/progress-estimate",
        json={"progressEstimate": estimate},
        headers={"X-API-Key": config.backend.api_key, **workflow_generation_headers()},
        timeout=5.0,
    )
    response.raise_for_status()
