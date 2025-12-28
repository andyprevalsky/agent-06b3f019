"""Type text tool - Type text using keyboard input."""

import time
from typing import Any, Dict

from tools.base import format_tool_message, format_error_message


async def type_text_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any
) -> Dict[str, Any]:
    """
    Type text using keyboard input.
    
    Uses Playwright's keyboard API to type text character by character.
    The target element must already be focused.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'text' and optional 'delay' keys
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    start_time = time.time()
    text = args.get("text", "")
    delay = args.get("delay", 50)
    
    if not text:
        elapsed = time.time() - start_time
        return {
            "success": False,
            "error": "Text is required",
            "message": format_tool_message(
                params=args,
                result={"error": "No text provided to type"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    try:
        logger.info(
            f"Agent calling tool: typeText",
            category="agent",
            auxiliary={
                "text": {"value": text, "type": "string"},
                "delay": {"value": str(delay), "type": "number"}
            }
        )
        
        # Type the text using Playwright's keyboard API
        await stagehand.page.keyboard.type(text, delay=delay)
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "action": f"typed {len(text)} characters",
            "message": format_tool_message(
                params=args,
                result={"typed": text, "characters": len(text), "status": "success"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        class TypeTextError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=TypeTextError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }


async def press_key_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any
) -> Dict[str, Any]:
    """
    Press a keyboard key.
    
    Uses Playwright's keyboard API to press special keys or key combinations.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'key' key
        logger: Logger instance
        
    Returns:
        Result dictionary with success status
    """
    start_time = time.time()
    key = args.get("key", "")
    
    if not key:
        elapsed = time.time() - start_time
        return {
            "success": False,
            "error": "Key is required",
            "message": format_tool_message(
                params=args,
                result={"error": "No key provided to press"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    try:
        logger.info(
            f"Agent calling tool: pressKey",
            category="agent",
            auxiliary={
                "key": {"value": key, "type": "string"}
            }
        )
        
        # Press the key using Playwright's keyboard API
        await stagehand.page.keyboard.press(key)
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "action": f"pressed {key}",
            "message": format_tool_message(
                params=args,
                result={"pressed": key, "status": "success"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        class PressKeyError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=PressKeyError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
