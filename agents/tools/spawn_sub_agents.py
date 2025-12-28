"""Event-driven spawn_sub_agents tool implementation."""

import asyncio
from typing import List, Dict, Any, AsyncGenerator
from datetime import timedelta
from temporalio import activity, workflow
import httpx
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from config import load_config

with workflow.unsafe.imports_passed_through():
    pass

logger = structlog.get_logger()


class SpawnSubAgentsManager(ToolManager):
    """Manager for spawn_sub_agents tool using event-driven architecture."""
    
    @property
    def tool_name(self) -> str:
        return "spawn_sub_agents"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute spawn_sub_agents tool with event-driven architecture.
        
        Args:
            workflow_instance: The workflow instance
            tool_call: Dict with "sub_agents" field
            tool_call_id: Unique ID for this tool call
            
        Yields:
            - Pre-execution status
            - Post-execution status with result
        """
        sub_agents = tool_call.get("sub_agents", [])
        
        if not sub_agents:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🚀 Spawning sub-agents",
                message="No sub-agents specified",
                status=MessageStatus.ERROR
            )
            return
        
        # Build list of subtasks for display
        subtasks = []
        for i, agent in enumerate(sub_agents, 1):
            goal = agent.get("goal", "Unknown goal")
            subtasks.append(f"{i}. {goal}")
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"🚀 Spawning {len(sub_agents)} sub-agent{'s' if len(sub_agents) != 1 else ''}",
            message="Delegating subtasks (watch progress below):\n" + "\n".join(subtasks),
            status=MessageStatus.IN_PROGRESS
        )
        
        try:
            # Get workflow info
            info = workflow.info()
            user_id = workflow_instance.user_id
            # user_phone removed - fetched from user context in workflow
            parent_agent_id = workflow_instance.agent_id
            parent_workflow_id = info.workflow_id
            depth = getattr(workflow_instance, 'depth', 0) + 1
            parent_is_paused = getattr(workflow_instance, 'is_paused', False)
            
            # Check depth limit
            MAX_DEPTH = 1  # Sub-agents can't create sub-agents
            if workflow_instance.depth >= MAX_DEPTH:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agents failed",
                    message=f"Cannot spawn sub-agents: maximum nesting depth ({MAX_DEPTH}) reached. Sub-agents cannot create their own sub-agents.",
                    status=MessageStatus.ERROR
                )
                return
            
            # 2. Execute spawn activity (inherit model from parent)
            parent_model = getattr(workflow_instance, 'model', 'rose-labs/rose-1-lite')
            result = await workflow.execute_activity(
                spawn_sub_agents_activity,
                args=[user_id, sub_agents, parent_agent_id, parent_workflow_id, depth, parent_is_paused, parent_model],
                start_to_close_timeout=timedelta(seconds=60),
            )
            
            # 3. Set up child tracking and post initial messages
            agents_list = result.get("agents", [])
            
            logger.info(f"✅ Spawned {len(agents_list)} sub-agents, setting up tracking...")
            
            for child_info in agents_list:
                if "error" not in child_info:
                    # Generate unique tool call ID for this sub-agent
                    child_tool_id = workflow.uuid4()
                    child_agent_id = child_info["agent_id"]
                    
                    # Store mapping: agent_id -> tool_call_id
                    # Signal handlers will use this to update the right message
                    workflow_instance.child_tool_ids[child_agent_id] = child_tool_id
                    workflow_instance.pending_children.add(child_agent_id)
                    
                    # Post initial IN_PROGRESS message with subAgentId
                    # This creates the message that signals will update
                    await workflow_instance._post_message(
                        child_info['goal'],
                        "TOOL",
                        metadata={
                            "toolCallId": child_tool_id,
                            "toolName": "spawn_sub_agents",
                            "toolStatus": "IN_PROGRESS",
                            "title": "Sub-agent starting",
                            "subAgentId": child_agent_id,
                            "progress": 0.0
                        }
                    )
            
            # 4. Post summary message (agents spawned successfully)
            spawned_count = len(agents_list)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"⭐ Spawned {spawned_count} sub-agent{'s' if spawned_count != 1 else ''}",
                message="",
                status=MessageStatus.FINISHED
            )
            
            # 5. Wait for all children to complete (via signals)
            # The workflow's signal handlers (child_progress, child_completed) will:
            # - Update messages with progress
            # - Remove children from pending_children when done
            logger.info(f"⏳ Waiting for {len(workflow_instance.pending_children)} sub-agents to complete...")
            
            await workflow.wait_condition(
                lambda: len(workflow_instance.pending_children) == 0
                # No timeout - can wait indefinitely
            )
            
            logger.info(f"🎉 All {spawned_count} sub-agents completed!")
            
            # Note: Individual completion messages already posted by child_completed signal
            # No need for final summary event - child results are in context
                
        except Exception as e:
            logger.error("Failed to spawn sub-agents", error=str(e))
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Sub-agents failed",
                message=f"Error spawning sub-agents: {str(e)}",
                status=MessageStatus.ERROR
            )


# Singleton instance
_manager_instance = None


def get_manager() -> SpawnSubAgentsManager:
    """Get or create manager singleton."""
    global _manager_instance
    if _manager_instance is None:
        _manager_instance = SpawnSubAgentsManager()
    return _manager_instance


# ============================================================================
# TEMPORAL ACTIVITY
# ============================================================================

@activity.defn
async def spawn_sub_agents_activity(
    user_id: str,
    sub_agents: List[Dict[str, Any]],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool,
    parent_model: str = "rose-labs/rose-1-lite"
) -> Dict[str, Any]:
    """
    Activity: Spawn multiple sub-agents to work on parallel subtasks.
    
    Args:
        user_id: User ID (agents will be created for this user)
        sub_agents: List of agent configs, each with:
            - goal (str): The subtask goal
            - verifier (dict): {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "..."}
        parent_agent_id: Parent agent ID (for hierarchy)
        parent_workflow_id: Parent workflow ID (for signaling)
        depth: Nesting depth for children
        parent_is_paused: Whether parent is currently paused (children inherit this state)
        parent_model: Model from parent agent (inherited by all sub-agents)
        
    Returns:
        Dict with summary: {"spawned": int, "completed": int, "failed": int, "agents": [...]}
    """
    try:
        activity.heartbeat(f"Spawning {len(sub_agents)} sub-agents")
        
        # Get config
        config = load_config()
        backend_url = config.backend.api_url.rstrip('/')
        api_key = config.backend.api_key
        
        if not api_key:
            raise ValueError("BACKEND_API_KEY not configured - required for spawning sub-agents")
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Spawn all agents concurrently using internal API key
            tasks = []
            for agent in sub_agents:
                # Build payload - tool_ids intentionally omitted, backend selects tools automatically
                # user_phone removed - fetched from user context in workflow
                payload = {
                    "user_id": user_id,  # For internal auth
                    "goal": agent["goal"],
                    "verifier": agent["verifier"],
                    "parent_agent_id": parent_agent_id,
                    "parent_workflow_id": parent_workflow_id,
                    "depth": depth,
                    "pause_state": parent_is_paused  # Inherit parent's pause state
                }
                
                # Always inherit model from parent
                payload["model"] = parent_model
                # Note: reasoning_max_tokens not passed - sub-agents use backend default (256)
                
                logger.info("Spawning sub-agent", payload=payload)
                tasks.append(
                    client.post(
                        f"{backend_url}/api/agents",
                        headers={
                            "X-API-Key": api_key,
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
            
            # Count results
            completed = sum(1 for s in spawned if s.get("status") != "FAILED")
            failed = sum(1 for s in spawned if s.get("status") == "FAILED")
            
            return {
                "spawned": len(spawned),
                "completed": completed,
                "failed": failed,
                "agents": spawned
            }
            
    except Exception as e:
        logger.error("Failed to spawn sub-agents", error=str(e))
        raise


# ============================================================================
# WORKFLOW HELPER
# ============================================================================

async def spawn_sub_agents(workflow_instance, tool_call: Dict, tool_call_id: str):
    """
    Workflow helper for spawn_sub_agents tool.
    
    This function is called from the workflow's _execute_tool method for
    event-driven tools.
    """
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_sub_agents")

