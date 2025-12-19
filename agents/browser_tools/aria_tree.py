"""AriaTree tool - Get the accessibility (ARIA) tree from the current page."""

from typing import Any, Dict


# Maximum characters for the ARIA tree (70k tokens = ~280k characters)
MAX_CHARACTERS = 70000


async def aria_tree_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Get the accessibility (ARIA) tree from the current page.
    
    This provides full context of what is on the page.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary (no parameters needed)
        logger: Logger instance
        
    Returns:
        Result dictionary with content and pageUrl
    """
    try:
        logger.info(f"Agent calling tool: ariaTree", category="agent")
        
        # Extract page text using stagehand.page.extract()
        extraction_result = await stagehand.page.extract()
        page_text = extraction_result.get("page_text", "")
        page_url = stagehand.page.url
        
        # Truncate if too long
        estimated_tokens = len(page_text) // 4
        if estimated_tokens > MAX_CHARACTERS:
            max_chars = MAX_CHARACTERS * 4
            content = page_text[:max_chars] + "\n\n[CONTENT TRUNCATED: Exceeded 70,000 token limit]"
        else:
            content = page_text
        
        return {
            "content": content,
            "pageUrl": page_url
        }
        
    except Exception as e:
        return {
            "content": f"Error extracting ARIA tree: {str(e)}",
            "pageUrl": stagehand.page.url
        }

