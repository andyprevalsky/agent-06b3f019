"""
Message processing utilities for browser agent.

Handles tool result transformation and message compression to match
Stagehand's internal optimizations.
"""

import json
from typing import Any, List, Dict


def transform_tool_result(tool_name: str, result: dict) -> str:
    """
    Transform tool result to correct format for OpenAI API.
    
    NOTE: Tool result content MUST be a string. However, we include base64
    screenshot data in the JSON so the Rose API can transform it to multimodal
    format for models that support vision.
    
    - Screenshots: Return as JSON with base64 data (Rose API will transform to multimodal)
    - AriaTree: Format with "Accessibility Tree:" prefix
    - Others: JSON stringify
    
    Args:
        tool_name: Name of the tool that produced the result
        result: Raw result dictionary from the tool
        
    Returns:
        Formatted content as string
    """
    if tool_name == "screenshot":
        # Include base64 data so Rose API can transform to multimodal format
        # The Rose function will detect __screenshot_base64__ and inject as image_url
        return json.dumps({
            "success": True,
            "screenshot_taken": True,
            "__screenshot_base64__": result.get("base64", ""),  # Rose API transforms this
            "timestamp": result.get("timestamp"),
            "pageUrl": result.get("pageUrl"),
        })
    elif tool_name == "ariaTree":
        content = result.get("content", "")
        page_url = result.get("pageUrl", "")
        return f"Accessibility Tree (Page: {page_url}):\n{content}"
    else:
        return json.dumps(result)


def compress_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Compress old screenshots and aria trees to save tokens.
    
    Matches Stagehand's processMessages() behavior:
    - Screenshots: Keep 2 most recent, replace others with "screenshot taken"
    - AriaTrees: Keep 1 most recent, replace others with summary text
    
    Args:
        messages: List of conversation messages
        
    Returns:
        Compressed messages list (new list, doesn't mutate original)
    """
    # Find indices of tool messages with screenshots and aria trees
    screenshot_indices = []
    aria_tree_indices = []
    
    for i, msg in enumerate(messages):
        if msg.get("role") != "tool":
            continue
            
        content = msg.get("content", "")
        
        # Content is always a string for tool results
        if not isinstance(content, str):
            continue
        
        # Check for screenshot (contains screenshot_taken or __screenshot_base64__ indicator)
        if "screenshot_taken" in content or '"screenshot_taken": true' in content.lower() or "__screenshot_base64__" in content:
            screenshot_indices.append(i)
        
        # Check for aria tree (text starting with "Accessibility Tree")
        elif content.startswith("Accessibility Tree"):
            aria_tree_indices.append(i)
    
    # Determine which to compress
    # Screenshots: keep 2 most recent
    screenshots_to_compress = set()
    if len(screenshot_indices) > 2:
        sorted_ss = sorted(screenshot_indices, reverse=True)
        screenshots_to_compress = set(sorted_ss[2:])  # All except 2 most recent
    
    # Aria trees: keep 1 most recent
    aria_trees_to_compress = set()
    if len(aria_tree_indices) > 1:
        sorted_at = sorted(aria_tree_indices, reverse=True)
        aria_trees_to_compress = set(sorted_at[1:])  # All except most recent
    
    # Build compressed messages list
    compressed = []
    for i, msg in enumerate(messages):
        if i in screenshots_to_compress:
            # Replace screenshot with placeholder text (strip base64 data)
            content = msg.get("content", "")
            # Try to preserve pageUrl if available
            page_url = ""
            try:
                parsed = json.loads(content)
                page_url = parsed.get("pageUrl", "")
            except:
                pass
            compressed.append({
                **msg,
                "content": json.dumps({
                    "success": True,
                    "screenshot_taken": True,
                    "pageUrl": page_url,
                    "note": "[Old screenshot compressed to save tokens]"
                })
            })
        elif i in aria_trees_to_compress:
            # Replace aria tree with summary
            compressed.append({
                **msg,
                "content": "ARIA tree extracted for context of page elements"
            })
        else:
            # Keep original message
            compressed.append(msg)
    
    return compressed

