"""Navback tool - Navigate back to the previous page."""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


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
    start_time = time.time()
    reasoning = args.get("reasoning", "")
    
    try:
        logger.info(
            f"Agent calling tool: navback",
            category="agent",
            auxiliary={
                "reasoning": {"value": reasoning, "type": "string"} if reasoning else None
            }
        )
        
        await stagehand.page.go_back()
        
        # Get current URL after going back
        current_url = ""
        try:
            current_url = stagehand.page.url
        except:
            pass
        
        elapsed = time.time() - start_time
        
        result_data = {"status": "success"}
        if current_url:
            result_data["current_url"] = current_url
        
        return {
            "success": True,
            "message": format_tool_message(
                params=args,
                result=result_data,
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        class NavbackError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=NavbackError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
