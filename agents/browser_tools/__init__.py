"""Browser automation tools for Stagehand agent."""

from .tool_definitions import get_browser_tool_definitions, get_system_prompt
from .tool_executor import execute_browser_tool
from .message_processing import transform_tool_result, compress_messages
from .schemas import (
    BROWSER_TOOL_MODELS,
    create_browser_agent_action_model,
    ActTool,
    AriaTreeTool,
    CloseTool,
    ExtractTool,
    FillFormTool,
    GotoTool,
    NavbackTool,
    ScreenshotTool,
    ScrollTool,
    WaitTool,
    SendMessageToUserBrowserTool,
)

__all__ = [
    "get_browser_tool_definitions",
    "get_system_prompt",
    "execute_browser_tool",
    "transform_tool_result",
    "compress_messages",
    # Schemas for structured outputs
    "BROWSER_TOOL_MODELS",
    "create_browser_agent_action_model",
    "ActTool",
    "AriaTreeTool",
    "CloseTool",
    "ExtractTool",
    "FillFormTool",
    "GotoTool",
    "NavbackTool",
    "ScreenshotTool",
    "ScrollTool",
    "WaitTool",
    "SendMessageToUserBrowserTool",
]

