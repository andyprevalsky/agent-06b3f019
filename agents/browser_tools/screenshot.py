"""Screenshot tool - Take a screenshot of the current page."""

import base64
import time
from typing import Any, Dict


async def screenshot_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Take a screenshot of the current page.
    
    Use this tool to learn where you are on the page, or to get context of elements.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary (no parameters needed)
        logger: Logger instance
        
    Returns:
        Result dictionary with base64 screenshot, timestamp, and pageUrl
    """
    try:
        logger.info(f"Agent calling tool: screenshot", category="agent")
        
        # Take screenshot (JPEG for compression)
        screenshot_bytes = await stagehand.page.screenshot(
            full_page=False,
            type="jpeg"
        )
        
        page_url = stagehand.page.url
        
        return {
            "base64": base64.b64encode(screenshot_bytes).decode("utf-8"),
            "timestamp": int(time.time() * 1000),  # milliseconds
            "pageUrl": page_url
        }
        
    except Exception as e:
        return {
            "base64": "",
            "timestamp": int(time.time() * 1000),
            "pageUrl": stagehand.page.url,
            "error": str(e)
        }

