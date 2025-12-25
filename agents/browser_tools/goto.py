"""Goto tool - Navigate to a specific URL."""

from typing import Any, Dict


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
    url = args.get("url", "")
    
    # Validate URL
    if not url or not url.strip():
        return {
            "success": False,
            "error": "No URL provided. Please specify a valid URL to navigate to.",
            "message": "No URL provided. Please specify a valid URL to navigate to."
        }
    
    url = url.strip()
    
    # Add https:// if no protocol specified
    if not url.startswith(("http://", "https://", "file://")):
        url = f"https://{url}"
    
    try:
        logger.info(f"Agent calling tool: goto", category="agent", auxiliary={
            "arguments": {"value": url, "type": "string"}
        })
        
        await stagehand.page.goto(url, wait_until="load")
        return {"success": True, "url": url}
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to navigate to {url}: {str(e)}",
            "message": f"Failed to navigate to {url}: {str(e)}"
        }

