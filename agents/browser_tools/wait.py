"""Wait tool - Wait for a specified time."""

import asyncio
from typing import Any, Dict


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
    time_ms = args.get("timeMs", 0)
    
    try:
        await asyncio.sleep(time_ms / 1000.0)
        return {"success": True, "waited": time_ms}
        
    except Exception as e:
        return {"success": False, "error": str(e)}

