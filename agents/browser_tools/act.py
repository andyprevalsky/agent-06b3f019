"""Act tool - Perform an action on the page (click, type).

This tool wraps Stagehand's act() method which internally:
1. Calls observe() with the proper prompt and supported methods
2. Finds the matching element
3. Executes the Playwright action

IMPORTANT: We call stagehand.page.act(action_string) directly instead of manually
calling observe() then act(observe_result). The reason is that Stagehand's act()
uses its own internal prompt builder (build_act_observe_prompt) that includes the
correct list of supported methods from method_handler_map. If we call observe()
ourselves with a different list of methods, the LLM may return method='not-supported'
because it can't find a matching method.
"""

from typing import Any, Dict


async def act_tool(stagehand: Any, args: Dict[str, Any], logger: Any, execution_model: str = None) -> Dict[str, Any]:
    """
    Perform an action on the page (click, type).
    
    Calls stagehand.page.act(action) directly, which handles observe internally.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'action' key
        logger: Logger instance
        execution_model: Optional model to use for the action (currently not supported by act string mode)
        
    Returns:
        Result dictionary with success status and action details
    """
    action = args.get("action", "")
    
    if not action:
        return {
            "success": False,
            "error": "No action provided. Please specify what action to perform.",
            "message": "No action provided. Please specify what action to perform."
        }
    
    try:
        logger.info(f"Agent calling tool: act", category="agent", auxiliary={
            "arguments": {"value": action, "type": "string"}
        })
        
        # Call Stagehand's act() directly with the action string.
        # Stagehand will internally:
        # 1. Build the proper observe prompt with correct supported methods
        # 2. Call observe() to find the element
        # 3. Execute the Playwright action
        result = await stagehand.page.act(action)
        
        response = {
            "success": result.success,
            "action": result.action,
            "isIframe": False
        }
        
        # Include error message if action failed - no message for success (title is sufficient)
        if not result.success:
            error_msg = getattr(result, 'message', None) or getattr(result, 'error', None)
            if not error_msg:
                error_msg = f"Action failed: {action}. The element may not exist, may not be interactable, or the action may not be supported."
            response["error"] = error_msg
            response["message"] = error_msg
        
        return response
        
    except Exception as e:
        error_str = str(e)
        return {
            "success": False,
            "error": error_str,
            "message": error_str
        }

