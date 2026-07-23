"""Activities for completing a generation-fenced workflow replacement."""

from typing import Any, Dict

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.update_status import _update_agent_status_impl
from helpers.workflow_generation import workflow_generation_headers

logger = structlog.get_logger()


async def _acknowledge_workflow_replacement_bootstrap(agent_id: str) -> Dict[str, Any]:
    generation_headers = workflow_generation_headers()
    if "X-Agent-Workflow-Generation" not in generation_headers:
        raise RuntimeError("Workflow replacement acknowledgement requires a Temporal workflow generation")

    config = load_config()
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{config.backend.api_url}/api/agents/{agent_id}/workflow-replacement/bootstrap-ack",
            headers={
                "X-API-Key": config.backend.api_key,
                "Content-Type": "application/json",
                **generation_headers,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("acknowledged") is not True:
            raise RuntimeError("Backend did not acknowledge workflow replacement bootstrap")

    logger.info(
        "workflow_replacement.bootstrap_acknowledged",
        agent_id=agent_id,
        workflow_generation=generation_headers["X-Agent-Workflow-Generation"],
        already_acknowledged=result.get("already_acknowledged") is True,
    )
    return result


@activity.defn
async def acknowledge_workflow_replacement_bootstrap(agent_id: str) -> Dict[str, Any]:
    """Consume a current replacement claim idempotently."""
    return await _acknowledge_workflow_replacement_bootstrap(agent_id)


@activity.defn
async def finalize_workflow_replacement_bootstrap(
    agent_id: str,
    status: str,
    progress: float,
    status_message: str,
    token_count: int,
    context_size: int,
    message_count: int,
    tokens_in: int,
    tokens_out: int,
    iteration_offset: int,
) -> Dict[str, Any]:
    """Persist restored state before consuming the claim used by deploy canaries."""
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
        iteration_offset=iteration_offset,
    )
    return await _acknowledge_workflow_replacement_bootstrap(agent_id)
