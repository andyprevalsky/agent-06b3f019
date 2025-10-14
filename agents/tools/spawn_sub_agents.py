"""Spawn sub-agents to handle parallel subtasks."""

import asyncio
from typing import List, Dict, Any, Optional
from temporalio import activity
import httpx
import structlog

from config import load_config

logger = structlog.get_logger()


class SubAgentSpawner:
    """Manager for spawning and monitoring sub-agents."""
    
    def __init__(self):
        config = load_config()
        self.backend_url = config.backend.api_url.rstrip('/')
        self.api_key = config.backend.api_key
        
        if not self.api_key:
            raise ValueError("BACKEND_API_KEY not configured - required for spawning sub-agents")
    
    async def spawn_agents(
        self,
        user_id: str,
        sub_agents: List[Dict[str, Any]],
        parent_agent_id: str,
        parent_workflow_id: str,
        depth: int,
        parent_is_paused: bool
    ) -> List[Dict[str, Any]]:
        """
        Spawn multiple sub-agents by calling backend API.
        
        Args:
            user_id: User ID (for creating agents on their behalf)
            sub_agents: List of agent configs, each with:
                - goal (str): The subtask goal
                - model (str, optional): LLM model to use
                - reasoning_effort (str, optional): "off", "low", "medium", "high"
                - tool_ids (list, optional): Tool UUIDs the sub-agent can use
                - verifier (dict): {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "..."}
            parent_agent_id: Parent agent ID (for hierarchy)
            parent_workflow_id: Parent workflow ID (for signaling)
            depth: Nesting depth for children
            parent_is_paused: Whether parent is currently paused (children inherit this state)
            
        Returns:
            List of spawned agent info with agent_id and temporal_workflow_id
        """
        try:
            activity.heartbeat(f"Spawning {len(sub_agents)} sub-agents")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Spawn all agents concurrently using internal API key
                tasks = []
                for agent in sub_agents:
                    # Build payload, filtering out None values
                    payload = {
                        "user_id": user_id,  # For internal auth
                        "goal": agent["goal"],
                        "tool_ids": agent.get("tool_ids", []),
                        "verifier": agent["verifier"],
                        "parent_agent_id": parent_agent_id,
                        "parent_workflow_id": parent_workflow_id,
                        "depth": depth,
                        "pause_state": parent_is_paused  # Inherit parent's pause state
                    }
                    
                    # Only include model and reasoning_effort if they're not None
                    model = agent.get("model")
                    if model is not None:
                        payload["model"] = model
                    
                    reasoning_effort = agent.get("reasoning_effort")
                    if reasoning_effort is not None:
                        payload["reasoning_effort"] = reasoning_effort
                    
                    logger.info("Spawning sub-agent", payload=payload)
                    tasks.append(
                        client.post(
                            f"{self.backend_url}/api/agents",
                            headers={
                                "X-API-Key": self.api_key,
                                "Content-Type": "application/json"
                            },
                            json=payload
                        )
                    )
                
                responses = await asyncio.gather(*tasks, return_exceptions=True)
                
                # Parse results
                spawned = []
                for i, response in enumerate(responses):
                    if isinstance(response, Exception):
                        logger.error(
                            "Failed to spawn sub-agent",
                            index=i,
                            goal=sub_agents[i]["goal"],
                            error=str(response)
                        )
                        spawned.append({
                            "error": str(response),
                            "goal": sub_agents[i]["goal"],
                            "status": "FAILED"
                        })
                    else:
                        try:
                            response.raise_for_status()
                            data = response.json()
                        except Exception as e:
                            # Log the full error response
                            error_detail = {
                                "status_code": response.status_code,
                                "response_text": response.text,
                                "error": str(e)
                            }
                            logger.error(
                                "Failed to spawn sub-agent - bad response",
                                index=i,
                                goal=sub_agents[i]["goal"],
                                **error_detail
                            )
                            raise
                        spawned.append({
                            "agent_id": data["agent_id"],
                            "temporal_workflow_id": data["temporal_workflow_id"],
                            "goal": data["goal"],
                            "model": data["model"],
                            "status": data["status"]
                        })
                        
                        logger.info(
                            "Sub-agent spawned",
                            agent_id=data["agent_id"],
                            workflow_id=data["temporal_workflow_id"],
                            goal=data["goal"]
                        )
                
                return spawned
                
        except Exception as e:
            logger.error("Failed to spawn sub-agents", error=str(e))
            raise


# Singleton instance
_spawner: Optional[SubAgentSpawner] = None


def get_spawner() -> SubAgentSpawner:
    """Get or create sub-agent spawner singleton."""
    global _spawner
    if _spawner is None:
        _spawner = SubAgentSpawner()
    return _spawner


@activity.defn
async def spawn_sub_agents(
    user_id: str,
    sub_agents: List[Dict[str, Any]],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool
) -> List[Dict[str, Any]]:
    """
    Activity: Spawn multiple sub-agents to work on parallel subtasks.
    
    Args:
        user_id: User ID (agents will be created for this user)
        sub_agents: List of agent configs (see SubAgentSpawner.spawn_agents)
        parent_agent_id: Parent agent ID (for hierarchy)
        parent_workflow_id: Parent workflow ID (for signaling)
        depth: Nesting depth for children
        parent_is_paused: Whether parent is currently paused (children inherit this state)
        
    Returns:
        List of spawned agent info with workflow IDs
    """
    spawner = get_spawner()
    return await spawner.spawn_agents(user_id, sub_agents, parent_agent_id, parent_workflow_id, depth, parent_is_paused)

