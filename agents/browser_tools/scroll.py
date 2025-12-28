"""Scroll tool - Scroll the page."""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


async def scroll_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Scroll the page up or down.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'pixels' and 'direction' keys
        logger: Logger instance
        
    Returns:
        Result dictionary with success status and pixels scrolled
    """
    start_time = time.time()
    pixels = args.get("pixels", 0)
    direction = args.get("direction", "down")
    
    try:
        logger.info(
            f"Agent calling tool: scroll",
            category="agent",
            auxiliary={
                "pixels": {"value": str(pixels), "type": "number"},
                "direction": {"value": direction, "type": "string"}
            }
        )
        
        # Use mouse.wheel to scroll
        delta_y = -pixels if direction == "up" else pixels
        await stagehand.page.mouse.wheel(0, delta_y)
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "pixels": pixels,
            "direction": direction,
            "message": format_tool_message(
                params=args,
                result={"scrolled": f"{direction} {pixels}px", "status": "success"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        class ScrollError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=ScrollError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
