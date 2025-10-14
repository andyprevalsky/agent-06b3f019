"""Tool for fetching agent configuration from database."""

from temporalio import activity
import structlog
import httpx
from typing import Dict, List

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def fetch_agent_config(agent_id: str) -> Dict:
    """
    Fetch agent configuration from database.
    
    Returns:
        dict with: model, status, tool_ids, verifier_prompt
    """
    try:
        activity.heartbeat(f"Fetching agent config")
        
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
            
            data = response.json()
            agent = data["agent"]
            
            result = {
                "model": agent["model"],
                "reasoning_effort": agent.get("reasoning_effort", "low"),
                "status": agent["status"],
                "tool_ids": [tool["id"] for tool in agent["tools"]],
                "verifier_prompt": agent["verifier"]["llm_judge_prompt"] if agent.get("verifier") else None,
                "parent_agent_id": agent.get("parentAgentId"),  # None if top-level agent
            }
            
            logger.info(
                "Agent config fetched",
                agent_id=agent_id,
                model=result["model"],
                reasoning_effort=result["reasoning_effort"],
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

