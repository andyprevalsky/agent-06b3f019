"""Act tool - Perform an action on the page (click, type)."""

from typing import Any, Dict


# Supported Playwright actions (from TypeScript implementation)
SUPPORTED_PLAYWRIGHT_ACTIONS = [
    "click", "fill", "select_option", "hover", "check", "uncheck",
    "focus", "clear", "press", "type", "scroll_into_view"
]


def build_act_observe_prompt(action: str, supported_actions: list) -> str:
    """Build the prompt for observe when acting."""
    return f"{action}. Supported actions: {', '.join(supported_actions)}"


async def act_tool(stagehand: Any, args: Dict[str, Any], logger: Any, execution_model: str = None) -> Dict[str, Any]:
    """
    Perform an action on the page (click, type).
    
    Internally calls observe() to find the element, then act() to execute.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'action' key
        logger: Logger instance
        execution_model: Optional model to use for observe
        
    Returns:
        Result dictionary with success status and action details
    """
    action = args.get("action", "")
    
    try:
        logger.info(f"Agent calling tool: act", category="agent", auxiliary={
            "arguments": {"value": action, "type": "string"}
        })
        
        # Build prompt for observe
        built_prompt = build_act_observe_prompt(action, SUPPORTED_PLAYWRIGHT_ACTIONS)
        
        # Call observe to find the element
        observe_options = {
            "instruction": built_prompt
        }
        if execution_model:
            observe_options["modelName"] = execution_model
            
        observe_results = await stagehand.page.observe(observe_options)
        
        if not observe_results or len(observe_results) == 0:
            return {
                "success": False,
                "error": "No observable actions found for the given instruction",
                "isIframe": False
            }
        
        observe_result = observe_results[0]
        
        # Check if it's an iframe action
        is_iframe_action = observe_result.description == "an iframe"
        
        if is_iframe_action:
            # Handle iframe case
            iframe_observe_options = {
                "instruction": built_prompt,
                "iframes": True
            }
            if execution_model:
                iframe_observe_options["modelName"] = execution_model
                
            iframe_observe_results = await stagehand.page.observe(iframe_observe_options)
            
            if not iframe_observe_results or len(iframe_observe_results) == 0:
                return {
                    "success": False,
                    "error": "No observable actions found within iframe context",
                    "isIframe": True
                }
            
            iframe_observe_result = iframe_observe_results[0]
            fallback = await stagehand.page.act(iframe_observe_result)
            
            return {
                "success": fallback.success,
                "action": fallback.action,
                "isIframe": True,
                "playwrightArguments": {
                    "description": iframe_observe_result.description,
                    "method": iframe_observe_result.method,
                    "arguments": iframe_observe_result.arguments,
                    "selector": iframe_observe_result.selector
                }
            }
        
        # Execute the action
        result = await stagehand.page.act(observe_result)
        
        playwright_arguments = {
            "description": observe_result.description,
            "method": observe_result.method,
            "arguments": observe_result.arguments,
            "selector": observe_result.selector
        }
        
        return {
            "success": result.success,
            "action": result.action,
            "isIframe": False,
            "playwrightArguments": playwright_arguments
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

