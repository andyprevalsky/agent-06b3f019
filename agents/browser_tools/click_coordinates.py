"""Click at coordinates tool - Click at specific X,Y coordinates on the page.

FALLBACK TOOL: Use this when selector-based click fails or when you have
exact coordinates from a screenshot but can't identify the element with observe().
"""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


async def click_coordinates_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any
) -> Dict[str, Any]:
    """
    Click at specific X,Y coordinates on the page.
    
    Uses Playwright's mouse API to click at exact pixel coordinates.
    Also moves the visual cursor (if injected) to show the click location.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'x', 'y', and optional 'button' keys
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    start_time = time.time()
    x = args.get("x")
    y = args.get("y")
    button = args.get("button", "left")
    
    if x is None or y is None:
        elapsed = time.time() - start_time
        return {
            "success": False,
            "error": "Both x and y coordinates are required",
            "message": format_tool_message(
                params=args,
                result={"error": "Both x and y coordinates are required"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    try:
        logger.info(
            f"Agent calling tool: clickAtCoordinates",
            category="agent",
            auxiliary={
                "x": {"value": str(x), "type": "number"},
                "y": {"value": str(y), "type": "number"},
                "button": {"value": button, "type": "string"}
            }
        )
        
        # Move visual cursor to click location (if injected)
        try:
            await stagehand.page.evaluate(f"""
                if (window.__moveRoseCursor) {{
                    window.__moveRoseCursor({x}, {y});
                }}
            """)
        except:
            pass  # Visual cursor is optional
        
        # Perform the click using Playwright's mouse API
        await stagehand.page.mouse.click(x, y, button=button)
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "message": format_tool_message(
                params=args,
                result={"clicked_at": f"({x}, {y})", "button": button, "status": "success"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        class ClickCoordinatesError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=ClickCoordinatesError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
