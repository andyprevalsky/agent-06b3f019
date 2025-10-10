"""Tool for fetching agent's available tools from backend."""

from typing import List, Dict
from temporalio import activity
import structlog
import httpx

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def fetch_agent_tools(agent_id: str) -> List[Dict[str, str]]:
    """
    Fetch the list of tools assigned to an agent from the backend.
    
    Args:
        agent_id: The agent ID
        
    Returns:
        List of dicts with 'name' and 'description' for each tool
    """
    try:
        activity.heartbeat(f"Fetching tools for agent {agent_id}")
        
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
            agent = data.get("agent", {})
            tools = agent.get("tools", [])
            
            # Extract name and description
            tool_list = [
                {
                    "name": tool.get("name"),
                    "description": tool.get("description", "No description available")
                }
                for tool in tools
            ]
            
            logger.info(
                "Agent tools fetched",
                agent_id=agent_id,
                tool_count=len(tool_list)
            )
            
            return tool_list
            
    except Exception as e:
        logger.error(
            "Failed to fetch agent tools",
            agent_id=agent_id,
            error=str(e)
        )
        # Return empty list on error
        return []

