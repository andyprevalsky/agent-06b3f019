"""Click tool - Click an element by CSS or XPath selector.

This tool provides direct Playwright click functionality with explicit selectors.
Use observe() first to find elements and get their selectors.
"""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


async def click_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any
) -> Dict[str, Any]:
    """
    Click an element by CSS or XPath selector.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'selector' key and optional 'timeout'
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    start_time = time.time()
    selector = args.get("selector", "")
    timeout = args.get("timeout", 5000)
    
    if not selector:
        elapsed = time.time() - start_time
        return {
            "success": False,
            "error": "Selector is required. Use observe() to find elements first.",
            "message": format_tool_message(
                params=args,
                result={"error": "No selector provided"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    try:
        logger.info(
            f"Agent calling tool: click",
            category="agent",
            auxiliary={
                "selector": {"value": selector, "type": "string"}
            }
        )
        
        # Use Playwright's locator API for robust element finding
        locator = stagehand.page.locator(selector)
        
        # Wait for element to be visible and clickable
        await locator.wait_for(state="visible", timeout=timeout)
        await locator.click()
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "message": format_tool_message(
                params=args,
                result={"clicked": selector, "status": "success"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        # Provide helpful error messages
        if "timeout" in error_str.lower():
            error_msg = f"Element not found or not visible within {timeout}ms: {selector}"
        elif "strict mode" in error_str.lower():
            error_msg = f"Multiple elements matched selector. Use a more specific selector: {selector}"
        else:
            error_msg = f"Click failed on {selector}: {error_str}"
        
        logger.error(
            f"Click failed: {error_msg}",
            category="agent",
            auxiliary={"error": {"value": error_str, "type": "string"}}
        )
        
        class ClickError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_msg,
            "message": format_error_message(
                params=args,
                error=ClickError(error_msg),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
