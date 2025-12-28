"""Fill tool - Fill a form field by CSS or XPath selector.

This tool provides direct Playwright fill functionality with explicit selectors.
fill() clears the existing value before typing, unlike type().
Use observe() first to find elements and get their selectors.
"""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


async def fill_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any
) -> Dict[str, Any]:
    """
    Fill a form field by selector. Clears existing value first.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'selector' and 'value' keys
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    start_time = time.time()
    selector = args.get("selector", "")
    value = args.get("value", "")
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
    
    if value is None:
        value = ""  # Allow empty string to clear field
    
    try:
        logger.info(
            f"Agent calling tool: fill",
            category="agent",
            auxiliary={
                "selector": {"value": selector, "type": "string"},
                "value": {"value": value, "type": "string"}
            }
        )
        
        # Use Playwright's locator API
        locator = stagehand.page.locator(selector)
        
        # Wait for element to be visible
        await locator.wait_for(state="visible", timeout=timeout)
        
        # Fill clears existing content and types the new value
        await locator.fill(value)
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "message": format_tool_message(
                params=args,
                result={"filled": selector, "value": value, "status": "success"},
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
        elif "not an input" in error_str.lower() or "editable" in error_str.lower():
            error_msg = f"Element is not an input or editable field: {selector}"
        else:
            error_msg = f"Fill failed on {selector}: {error_str}"
        
        logger.error(
            f"Fill failed: {error_msg}",
            category="agent",
            auxiliary={"error": {"value": error_str, "type": "string"}}
        )
        
        class FillError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_msg,
            "message": format_error_message(
                params=args,
                error=FillError(error_msg),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
