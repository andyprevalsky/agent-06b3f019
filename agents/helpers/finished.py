"""Finished tool for marking agent task completion."""

from typing import Dict, List
from datetime import datetime
from temporalio import activity
import structlog
import httpx

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def mark_finished(
    agent_id: str,
    goal: str,
    steps_taken: List[Dict]
) -> Dict:
    """
    Activity: Mark an agent task as finished.
    
    This updates the agent status to COMPLETED in the database.
    
    Args:
        agent_id: Agent ID
        goal: The goal that was being pursued
        steps_taken: Detailed steps taken
        
    Returns:
        Dict with completion details
    """
    try:
        activity.heartbeat("Marking task as finished")
        
        config = load_config()
        
        # Update agent status to COMPLETED
        async with httpx.AsyncClient() as client:
            # Update status
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}/status",
                json={
                    "status": "COMPLETED",
                    "statusMessage": f"Successfully completed: {goal}",
                    "progress": 1.0
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=30.0
            )
            response.raise_for_status()
            
            logger.info("Agent status updated to COMPLETED", agent_id=agent_id)
            
            # Post completion message
            completion_message = f"""Task completed successfully!

Goal: {goal}
Steps taken: {len(steps_taken)}"""
            
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                json={
                    "message": completion_message,
                    "role": "ASSISTANT"
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=30.0
            )
            response.raise_for_status()
            
            message = response.json()
            
            logger.info(
                "Completion message posted",
                agent_id=agent_id,
                message_id=message.get("message_id")
            )
        
        result = {
            "agent_id": agent_id,
            "goal": goal,
            "steps_count": len(steps_taken),
            "completed_at": datetime.utcnow().isoformat()
        }
        
        logger.info("Task marked as finished", **result)
        
        return result
        
    except Exception as e:
        logger.error(
            "Failed to mark task as finished",
            agent_id=agent_id,
            error=str(e)
        )
        raise

