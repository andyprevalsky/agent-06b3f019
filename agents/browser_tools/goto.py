"""Goto tool - Navigate to a specific URL."""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


async def goto_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Navigate to a specific URL.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'url' key
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    start_time = time.time()
    url = args.get("url", "")
    
    # Validate URL
    if not url or not url.strip():
        elapsed = time.time() - start_time
        return {
            "success": False,
            "error": "No URL provided. Please specify a FULL URL including https://",
            "message": format_tool_message(
                params=args,
                result={"error": "No URL provided"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    url = url.strip()
    
    # Add https:// if no protocol specified
    if not url.startswith(("http://", "https://", "file://")):
        url = f"https://{url}"
    
    try:
        logger.info(f"Agent calling tool: goto", category="agent", auxiliary={
            "url": {"value": url, "type": "string"}
        })
        
        await stagehand.page.goto(url, wait_until="load")
        
        # Get current page title for better feedback
        title = ""
        try:
            title = await stagehand.page.title()
        except:
            pass
        
        elapsed = time.time() - start_time
        
        result_data = {
            "navigated_to": url,
            "status": "success"
        }
        if title:
            result_data["page_title"] = title
        
        return {
            "success": True,
            "url": url,
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
        
        class GotoError(Exception):
            pass
        
        return {
            "success": False,
            "error": f"Failed to navigate to {url}: {error_str}",
            "message": format_error_message(
                params=args,
                error=GotoError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
