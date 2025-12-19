"""Navback tool - Navigate back to the previous page."""

from typing import Any, Dict


async def navback_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Navigate back to the previous page.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'reasoning' key
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    reasoning = args.get("reasoning", "")
    
    try:
        logger.info(f"Agent calling tool: navback", category="agent")
        
        await stagehand.page.go_back()
        return {"success": True}
        
    except Exception as e:
        return {"success": False, "error": str(e)}

