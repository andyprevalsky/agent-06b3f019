"""Tool executor for browser automation tools.

HYBRID APPROACH: We use Stagehand's observe() for element finding
(handles shadow DOM, iframes) but direct Playwright for actions.
"""

from typing import Any, Dict

# Observation tools
from browser_tools.observe import observe_tool
from browser_tools.aria_tree import aria_tree_tool
from browser_tools.screenshot import screenshot_tool

# Action tools (direct Playwright with selectors)
from browser_tools.click import click_tool
from browser_tools.fill import fill_tool
from browser_tools.type_selector import type_selector_tool
from browser_tools.type_text import press_key_tool
from browser_tools.click_coordinates import click_coordinates_tool

# Navigation tools
from browser_tools.goto import goto_tool
from browser_tools.navback import navback_tool
from browser_tools.scroll import scroll_tool
from browser_tools.wait import wait_tool

# Completion tools
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
        # Observation tools
        "observe": lambda: observe_tool(stagehand, tool_args, logger, execution_model),
        "ariaTree": lambda: aria_tree_tool(stagehand, tool_args, logger),
        "screenshot": lambda: screenshot_tool(stagehand, tool_args, logger),
        "extract": lambda: {"success": False, "error": "extract is disabled. Use evaluate instead."},
        
        # Action tools (direct Playwright)
        "click": lambda: click_tool(stagehand, tool_args, logger),
        "fill": lambda: fill_tool(stagehand, tool_args, logger),
        "type": lambda: type_selector_tool(stagehand, tool_args, logger),
        "pressKey": lambda: press_key_tool(stagehand, tool_args, logger),
        "clickAtCoordinates": lambda: click_coordinates_tool(stagehand, tool_args, logger),
        
        # Navigation tools
        "goto": lambda: goto_tool(stagehand, tool_args, logger),
        "navback": lambda: navback_tool(stagehand, tool_args, logger),
        "scroll": lambda: scroll_tool(stagehand, tool_args, logger),
        "wait": lambda: wait_tool(stagehand, tool_args, logger),
        
        # Completion tools
        "close": lambda: close_tool(stagehand, tool_args, logger),
    }
    
    if tool_name not in tool_map:
        return {
            "success": False,
            "error": f"Unknown tool: {tool_name}. Available tools: {', '.join(tool_map.keys())}"
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
