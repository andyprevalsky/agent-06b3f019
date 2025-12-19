"""Scroll tool - Scroll the page."""

import json
from typing import Any, Dict


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
    pixels = args.get("pixels", 0)
    direction = args.get("direction", "down")
    
    try:
        logger.info(
            f"Agent calling tool: scroll",
            category="agent",
            auxiliary={
                "arguments": {
                    "value": json.dumps({"pixels": pixels, "direction": direction}),
                    "type": "object"
                }
            }
        )
        
        # Use mouse.wheel to scroll
        delta_y = -pixels if direction == "up" else pixels
        await stagehand.page.mouse.wheel(0, delta_y)
        
        return {"success": True, "pixels": pixels}
        
    except Exception as e:
        return {"success": False, "error": str(e)}

