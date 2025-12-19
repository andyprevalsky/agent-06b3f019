"""FillForm tool - Fill multiple form fields at once."""

import json
from typing import Any, Dict, List


async def fill_form_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any,
    execution_model: str = None
) -> Dict[str, Any]:
    """
    Fill multiple form fields at once.
    
    This is optimized for forms with 2+ input fields and is 4-6x faster than
    individual typing actions.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'fields' key (list of {action, value} objects)
        logger: Logger instance
        execution_model: Optional model to use for observe
        
    Returns:
        Result dictionary with success status and completed actions
    """
    fields = args.get("fields", [])
    
    try:
        logger.info(
            f"Agent calling tool: fillForm",
            category="agent",
            auxiliary={
                "arguments": {
                    "value": json.dumps(fields),
                    "type": "object"
                }
            }
        )
        
        # Build instruction for observe
        field_actions = [field.get("action", "") for field in fields]
        instruction = f"Return observation results for the following actions: {', '.join(field_actions)}"
        
        # Call observe to find all fields
        observe_options = {"instruction": instruction}
        if execution_model:
            observe_options["modelName"] = execution_model
            
        observe_results = await stagehand.page.observe(observe_options)
        
        # Execute act on each observed result
        completed_actions = []
        for result in observe_results:
            action = await stagehand.page.act(result)
            completed_actions.append({
                "success": action.success,
                "action": action.action
            })
        
        return {
            "success": True,
            "actions": completed_actions
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "actions": []
        }

