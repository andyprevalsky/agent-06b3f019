"""Close tool - Complete the task and close."""

from typing import Any, Dict


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
    reasoning = args.get("reasoning", "")
    success = args.get("success", False)
    
    return {
        "success": success,
        "reasoning": reasoning
    }

