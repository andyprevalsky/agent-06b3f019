"""AriaTree tool - Get the accessibility (ARIA) tree from the current page."""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


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
    start_time = time.time()
    
    try:
        logger.info(f"Agent calling tool: ariaTree", category="agent")
        
        # Extract page text using stagehand.page.extract()
        extraction_result = await stagehand.page.extract()
        page_text = extraction_result.get("page_text", "")
        page_url = stagehand.page.url
        
        # Truncate if too long
        estimated_tokens = len(page_text) // 4
        was_truncated = False
        if estimated_tokens > MAX_CHARACTERS:
            max_chars = MAX_CHARACTERS * 4
            content = page_text[:max_chars] + "\n\n[CONTENT TRUNCATED: Exceeded 70,000 token limit]"
            was_truncated = True
        else:
            content = page_text
        
        elapsed = time.time() - start_time
        
        # Summarize for result
        char_count = len(content)
        line_count = content.count('\n')
        
        return {
            "success": True,
            "content": content,
            "pageUrl": page_url,
            "message": format_tool_message(
                params=args,
                result={
                    "page_url": page_url,
                    "characters": char_count,
                    "lines": line_count,
                    "truncated": was_truncated,
                    "content_preview": content[:500] + "..." if len(content) > 500 else content
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
        
        class AriaTreeError(Exception):
            pass
        
        return {
            "success": False,
            "content": f"Error extracting ARIA tree: {error_str}",
            "pageUrl": page_url,
            "message": format_error_message(
                params=args,
                error=AriaTreeError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
