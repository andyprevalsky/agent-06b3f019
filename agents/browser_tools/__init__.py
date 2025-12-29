"""Browser automation tools for Stagehand agent.

HYBRID APPROACH: We use Stagehand's observe() for element finding
(handles shadow DOM, iframes) but direct Playwright for actions.
"""

from .tool_definitions import get_browser_tool_definitions, get_system_prompt
from .tool_executor import execute_browser_tool
from .message_processing import transform_tool_result, compress_messages
from .schemas import (
    BROWSER_TOOL_MODELS,
    create_browser_agent_action_model,
    # Observation
    ObserveTool,
    AriaTreeTool,
    ScreenshotTool,
    ExtractTool,
    # Actions
    ClickTool,
    FillTool,
    TypeTool,
    PressKeyTool,
    ClickAtCoordinatesTool,
    # Navigation
    GotoTool,
    NavbackTool,
    ScrollTool,
    WaitTool,
    # Completion
    AttemptCompletionBrowserTool,
    CloseTool,  # Deprecated
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
    # Observation
    "ObserveTool",
    "AriaTreeTool",
    "ScreenshotTool",
    "ExtractTool",
    # Actions
    "ClickTool",
    "FillTool",
    "TypeTool",
    "PressKeyTool",
    "ClickAtCoordinatesTool",
    # Navigation
    "GotoTool",
    "NavbackTool",
    "ScrollTool",
    "WaitTool",
    # Completion
    "AttemptCompletionBrowserTool",
    "CloseTool",  # Deprecated
    "SendMessageToUserBrowserTool",
]
