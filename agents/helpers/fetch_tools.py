"""Tool for fetching agent's available tools from backend.

Uses _fetch_agent_data_impl from fetch_config.py (single source for GET /api/agents/{agent_id}).
"""

from typing import List, Dict
from temporalio import activity
import structlog

from helpers.fetch_config import _fetch_agent_data_impl

logger = structlog.get_logger()


@activity.defn
async def fetch_agent_tools(agent_id: str) -> List[Dict[str, str]]:
    """
    Fetch the list of tools assigned to an agent from the backend.
    
    Args:
        agent_id: The agent ID
        
    Returns:
        List of dicts with 'id', 'name' and 'description' for each tool
    """
    try:
        activity.heartbeat(f"Fetching tools for agent {agent_id}")
        
        # Use the single fetch_agent_data implementation
        data = await _fetch_agent_data_impl(agent_id)
        agent = data.get("agent", {})
        tools = agent.get("tools", [])
        
        # Extract id, name, and description
        tool_list = [
            {
                "id": tool.get("id"),
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

