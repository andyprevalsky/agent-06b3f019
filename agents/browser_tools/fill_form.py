"""FillForm tool - Fill multiple form fields at once.

This tool fills multiple form fields by calling stagehand.page.act(action_string)
for each field. Each field specifies an action description that Stagehand will
use to find and interact with the element.

IMPORTANT: We call stagehand.page.act(action_string) directly instead of manually
calling observe() then act(observe_result). The reason is that Stagehand's act()
uses its own internal prompt builder with the correct list of supported methods.
"""

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
    
    For each field, calls stagehand.page.act(action) which handles observe internally.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'fields' key (list of {action, value} objects)
        logger: Logger instance
        execution_model: Optional model to use (currently not supported by act string mode)
        
    Returns:
        Result dictionary with success status and completed actions
    """
    fields = args.get("fields", [])
    
    if not fields:
        return {
            "success": False,
            "error": "No fields provided. Please specify at least one field to fill.",
            "message": "No fields provided. Please specify at least one field to fill.",
            "actions": []
        }
    
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
        
        completed_actions = []
        failed_actions = []
        
        # Execute act for each field directly using action string
        for i, field in enumerate(fields):
            action_desc = field.get("action", "")
            value = field.get("value", "")
            
            # Build the full action instruction
            # If action already includes the value, use as-is; otherwise append value
            if value and value not in action_desc:
                full_action = f"{action_desc} with value '{value}'"
            else:
                full_action = action_desc
            
            field_name = action_desc if action_desc else f"field_{i}"
            
            try:
                # Call Stagehand's act() directly with the action string
                result = await stagehand.page.act(full_action)
                
                action_result = {
                    "success": result.success,
                    "action": result.action,
                    "field": field_name
                }
                
                if not result.success:
                    error_msg = getattr(result, 'message', None) or getattr(result, 'error', None)
                    if not error_msg:
                        error_msg = f"Failed to fill field: {field_name}"
                    action_result["error"] = error_msg
                    failed_actions.append(action_result)
                else:
                    action_result["message"] = result.message if hasattr(result, 'message') and result.message else f"Filled: {field_name}"
                
                completed_actions.append(action_result)
                
            except Exception as field_error:
                action_result = {
                    "success": False,
                    "action": None,
                    "field": field_name,
                    "error": str(field_error)
                }
                failed_actions.append(action_result)
                completed_actions.append(action_result)
        
        # Overall success only if all actions succeeded
        all_success = len(failed_actions) == 0
        
        response = {
            "success": all_success,
            "actions": completed_actions
        }
        
        if not all_success:
            error_summary = f"{len(failed_actions)} of {len(completed_actions)} field(s) failed to fill: " + \
                           "; ".join([f"{a['field']}: {a.get('error', 'unknown error')}" for a in failed_actions])
            response["error"] = error_summary
            response["message"] = error_summary
        
        return response
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": str(e),
            "actions": []
        }

