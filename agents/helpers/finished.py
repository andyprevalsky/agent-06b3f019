"""Finished tool for marking agent task completion."""

from datetime import datetime
from typing import Dict, List, Optional

import structlog
from temporalio import activity

from utils.utils import extract_goal_from_context

logger = structlog.get_logger()


@activity.defn
async def mark_finished(
    agent_id: str,
    steps_taken: List[Dict],
    token_count: int = 0,
    context_size: int = 0,
    message_count: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    summary: str = "",
    structured_response: Optional[Dict] = None,
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
        structured_response: Extracted structured output from the agent (if schema was defined)

    Returns:
        Dict with completion details including summary
    """
    try:
        activity.heartbeat("Marking task as finished")

        # Extract goal from first USER message
        goal = extract_goal_from_context(steps_taken)

        # Use the single update_agent_status helper (no activity wrapper - call directly)
        from helpers.update_status import _update_agent_status_impl

        await _update_agent_status_impl(
            agent_id=agent_id,
            status="COMPLETED",
            progress=1.0,
            status_message=f"Successfully completed: {goal}",
            token_count=token_count,
            context_size=context_size,
            message_count=message_count,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            structured_response=structured_response,
        )

        logger.info("Agent status updated to COMPLETED", agent_id=agent_id)

        result = {
            "agent_id": agent_id,
            "goal": goal,
            "steps_count": len(steps_taken),
            "completed_at": datetime.utcnow().isoformat(),
            "summary": summary,  # Include summary for parent signaling
        }

        logger.info("Task marked as finished", agent_id=agent_id, goal=goal[:50], has_summary=bool(summary))

        return result

    except Exception as e:
        logger.error("Failed to mark task as finished", agent_id=agent_id, error=str(e))
        raise
