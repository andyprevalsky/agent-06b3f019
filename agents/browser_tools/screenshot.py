"""Screenshot tool - Take a screenshot of the current page."""

import base64
import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


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
    start_time = time.time()
    
    try:
        logger.info(f"Agent calling tool: screenshot", category="agent")
        
        # Take screenshot (JPEG for compression)
        screenshot_bytes = await stagehand.page.screenshot(
            full_page=False,
            type="jpeg"
        )
        
        page_url = stagehand.page.url
        size_kb = len(screenshot_bytes) / 1024
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "base64": base64.b64encode(screenshot_bytes).decode("utf-8"),
            "timestamp": int(time.time() * 1000),
            "pageUrl": page_url,
            "message": format_tool_message(
                params=args,
                result={
                    "screenshot_taken": True,
                    "size_kb": round(size_kb, 1),
                    "page_url": page_url
                },
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        page_url = ""
        try:
            page_url = stagehand.page.url
        except:
            pass
        
        class ScreenshotError(Exception):
            pass
        
        return {
            "success": False,
            "base64": "",
            "timestamp": int(time.time() * 1000),
            "pageUrl": page_url,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=ScreenshotError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
