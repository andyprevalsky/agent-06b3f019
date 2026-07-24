"""Wait tool - Wait for a specified time."""

import asyncio
import time
from typing import Any, Dict

from browser_tools.schemas import normalize_browser_wait_ms
from tools.base import format_tool_message, format_error_message


async def wait_tool(stagehand: Any, args: Dict[str, Any], logger: Any) -> Dict[str, Any]:
    """
    Wait for a specified time.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'timeMs' key (time in milliseconds)
        logger: Logger instance
        
    Returns:
        Result dictionary with success status and time waited
    """
    start_time = time.time()
    try:
        time_ms = normalize_browser_wait_ms(args.get("timeMs"), default=0)
        logger.info(
            f"Agent calling tool: wait",
            category="agent",
            auxiliary={
                "timeMs": {"value": str(time_ms), "type": "number"}
            }
        )
        
        await asyncio.sleep(time_ms / 1000.0)
        
        elapsed = time.time() - start_time
        
        return {
            "success": True,
            "waited": time_ms,
            "message": format_tool_message(
                params=args,
                result={"waited_ms": time_ms, "status": "success"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        
        class WaitError(Exception):
            pass
        
        return {
            "success": False,
            "error": error_str,
            "message": format_error_message(
                params=args,
                error=WaitError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
