"""Tool for fetching agent data from database.

This is the SINGLE helper for GET /api/agents/{agent_id}.
Other helpers should import and use _fetch_agent_data_impl directly.
"""

from temporalio import activity
import structlog
import httpx
from typing import Dict, List, Any

from config import load_config

logger = structlog.get_logger()


async def _fetch_agent_data_impl(agent_id: str) -> Dict[str, Any]:
    """
    Core implementation for fetching agent data.
    
    This is the SINGLE function that calls GET /api/agents/{agent_id}.
    Can be called directly from other activities or via activity wrappers.
    
    Args:
        agent_id: The agent ID
        
    Returns:
        Full response dict with 'agent' and 'messages' keys
    """
    config = load_config()
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{config.backend.api_url}/api/agents/{agent_id}",
            headers={
                "X-API-Key": config.backend.api_key,
                "Content-Type": "application/json"
            },
            timeout=30.0
        )
        response.raise_for_status()
        return response.json()


@activity.defn
async def fetch_agent_config(agent_id: str) -> Dict:
    """
    Activity: Fetch agent configuration from database.
    
    Returns:
        dict with: model, status, tool_ids, verifier_prompt
    """
    try:
        activity.heartbeat(f"Fetching agent config")
        
        data = await _fetch_agent_data_impl(agent_id)
        agent = data["agent"]
        
        result = {
            "model": agent["model"],
            "reasoning_max_tokens": agent.get("reasoning_max_tokens", 256),
            "status": agent["status"],
            "tool_ids": [tool["id"] for tool in agent["tools"]],
            "verifier_prompt": agent["verifier"]["llm_judge_prompt"] if agent.get("verifier") else None,
            "parent_agent_id": agent.get("parentAgentId"),  # None if top-level agent
            "response_schema": agent.get("response_schema"),  # Structured output schema
            "token_in_price_microdollars": agent.get("token_in_price_microdollars"),  # For cost calculation
            "token_out_price_microdollars": agent.get("token_out_price_microdollars"),  # For cost calculation
        }
        
        logger.info(
            "Agent config fetched",
            agent_id=agent_id,
            model=result["model"],
            reasoning_max_tokens=result["reasoning_max_tokens"],
            status=result["status"]
        )
        
        return result
        
    except Exception as e:
        logger.error(
            "Failed to fetch agent config",
            agent_id=agent_id,
            error=str(e)
        )
        raise

