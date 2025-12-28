"""Close tool - Complete the task and close."""

import time
from typing import Any, Dict

from tools.base import format_tool_message


async def close_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Complete the task and close.
    
    This signals that the agent is done with its task.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'reasoning' and 'success' keys
        logger: Logger instance
        
    Returns:
        Result dictionary with success status and reasoning
    """
    start_time = time.time()
    reasoning = args.get("reasoning", "")
    success = args.get("success", False)
    
    logger.info(
        f"Agent calling tool: close",
        category="agent",
        auxiliary={
            "success": {"value": str(success), "type": "boolean"},
            "reasoning": {"value": reasoning, "type": "string"}
        }
    )
    
    elapsed = time.time() - start_time
    
    status_text = "Task completed successfully" if success else "Task incomplete"
    
    return {
        "success": success,
        "reasoning": reasoning,
        "message": format_tool_message(
            params=args,
            result={"status": status_text, "reasoning": reasoning},
            time_elapsed=elapsed,
            cost_cents=0
        )
    }
