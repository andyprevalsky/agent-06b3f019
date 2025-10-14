"""Finished tool for marking agent task completion."""

from typing import Dict, List
from datetime import datetime
from temporalio import activity
import structlog
import httpx

from config import load_config

logger = structlog.get_logger()


def extract_goal_from_context(steps_taken: List[Dict]) -> str:
    """
    Extract the goal from the first USER message in context.
    
    Args:
        steps_taken: Message history
        
    Returns:
        The goal text, or a default message if not found
    """
    for msg in steps_taken:
        if msg.get('role') == 'USER':
            return msg.get('text', 'No goal specified')
    
    return 'No goal specified'


@activity.defn
async def mark_finished(
    agent_id: str,
    steps_taken: List[Dict],
    token_count: int = 0,
    context_size: int = 0,
    message_count: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    summary: str = ""
) -> Dict:
    """
    Activity: Mark an agent task as finished.
    
    This updates the agent status to COMPLETED in the database.
    
    Args:
        agent_id: Agent ID
        steps_taken: Detailed steps taken (first USER message is the goal)
        token_count: Total tokens used
        context_size: Context size in tokens
        message_count: Total messages
        tokens_in: Input tokens (prompt)
        tokens_out: Output tokens (completion)
        summary: Summary of work completed (for sub-agents to return to parent)
        
    Returns:
        Dict with completion details including summary
    """
    try:
        activity.heartbeat("Marking task as finished")
        
        # Extract goal from first USER message
        goal = extract_goal_from_context(steps_taken)
        
        config = load_config()
        
        # Update agent status to COMPLETED
        async with httpx.AsyncClient() as client:
            # Update status
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}/status",
                json={
                    "status": "COMPLETED",
                    "statusMessage": f"Successfully completed: {goal}",
                    "progress": 1.0,
                    "tokenCount": token_count,
                    "tokensIn": tokens_in,
                    "tokensOut": tokens_out,
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
            
            logger.info("Agent status updated to COMPLETED", agent_id=agent_id)
        
        result = {
            "agent_id": agent_id,
            "goal": goal,
            "steps_count": len(steps_taken),
            "completed_at": datetime.utcnow().isoformat(),
            "summary": summary  # Include summary for parent signaling
        }
        
        logger.info("Task marked as finished", agent_id=agent_id, goal=goal[:50], has_summary=bool(summary))
        
        return result
        
    except Exception as e:
        logger.error(
            "Failed to mark task as finished",
            agent_id=agent_id,
            error=str(e)
        )
        raise

