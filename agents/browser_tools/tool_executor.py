"""Tool executor for browser automation tools."""

from typing import Any, Dict

from browser_tools.act import act_tool
from browser_tools.aria_tree import aria_tree_tool
from browser_tools.screenshot import screenshot_tool
from browser_tools.extract import extract_tool
from browser_tools.goto import goto_tool
from browser_tools.navback import navback_tool
from browser_tools.scroll import scroll_tool
from browser_tools.wait import wait_tool
from browser_tools.fill_form import fill_form_tool
from browser_tools.close import close_tool


async def execute_browser_tool(
    tool_name: str,
    tool_args: Dict[str, Any],
    stagehand: Any,
    logger: Any,
    execution_model: str = None
) -> Dict[str, Any]:
    """
    Execute a browser automation tool.
    
    Args:
        tool_name: Name of the tool to execute
        tool_args: Arguments for the tool
        stagehand: Stagehand instance
        logger: Logger instance
        execution_model: Optional model to use for observe/extract operations
        
    Returns:
        Result dictionary from the tool
    """
    # Map tool names to implementations
    tool_map = {
        "act": lambda: act_tool(stagehand, tool_args, logger, execution_model),
        "ariaTree": lambda: aria_tree_tool(stagehand, tool_args, logger),
        "screenshot": lambda: screenshot_tool(stagehand, tool_args, logger),
        "extract": lambda: extract_tool(stagehand, tool_args, logger, execution_model),
        "goto": lambda: goto_tool(stagehand, tool_args, logger),
        "navback": lambda: navback_tool(stagehand, tool_args, logger),
        "scroll": lambda: scroll_tool(stagehand, tool_args, logger),
        "wait": lambda: wait_tool(stagehand, tool_args, logger),
        "fillForm": lambda: fill_form_tool(stagehand, tool_args, logger, execution_model),
        "close": lambda: close_tool(stagehand, tool_args, logger)
    }
    
    if tool_name not in tool_map:
        return {
            "success": False,
            "error": f"Unknown tool: {tool_name}"
        }
    
    try:
        return await tool_map[tool_name]()
    except Exception as e:
        logger.error(
            f"Error executing tool {tool_name}: {str(e)}",
            category="agent",
            auxiliary={"error": {"value": str(e), "type": "string"}}
        )
        return {
            "success": False,
            "error": str(e)
        }

