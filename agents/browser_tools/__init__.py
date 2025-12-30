"""Browser automation tools.

V3 ARCHITECTURE: Uses browser-use BrowserSession for DOM extraction and CDP actions.
- Index-based element selection (from DOM tree)
- Rose API rose-1-browser-use for LLM decisions
- Always captures screenshots (no screenshot tool)

For V2 (Stagehand-based), use tool_executor.py
For V3 (browser-use based), use tool_executor_v2.py
"""

from .tool_definitions import get_browser_tool_definitions, get_system_prompt
from .tool_executor import execute_browser_tool
from .message_processing import transform_tool_result, compress_messages
from .schemas import (
    BROWSER_TOOL_MODELS,
    AVAILABLE_ACTIONS,
    create_browser_agent_action_model,
    # Observation
    ScreenshotTool,
    ExtractTool,
    # Index-based actions
    ClickTool,
    InputTextTool,
    PressKeyTool,
    ClickAtCoordinatesTool,
    # Dropdown tools
    DropdownOptionsTool,
    SelectDropdownTool,
    # JavaScript
    EvaluateTool,
    # Navigation
    GotoTool,
    NavbackTool,
    ScrollTool,
    WaitTool,
    # Completion
    DoneTool,
    AttemptCompletionBrowserTool,
    SendMessageToUserBrowserTool,
)

# V3 components (browser-use based)
from .dom_service import DOMService, ActionHistory, ActionHistoryEntry

__all__ = [
    # Legacy tool definitions (for V2)
    "get_browser_tool_definitions",
    "get_system_prompt",
    "execute_browser_tool",
    "transform_tool_result",
    "compress_messages",
    # Schemas for structured outputs
    "BROWSER_TOOL_MODELS",
    "AVAILABLE_ACTIONS",
    "create_browser_agent_action_model",
    # Observation
    "ScreenshotTool",
    "ExtractTool",
    # Index-based actions
    "ClickTool",
    "InputTextTool",
    "PressKeyTool",
    "ClickAtCoordinatesTool",
    # Dropdown tools
    "DropdownOptionsTool",
    "SelectDropdownTool",
    # JavaScript
    "EvaluateTool",
    # Navigation
    "GotoTool",
    "NavbackTool",
    "ScrollTool",
    "WaitTool",
    # Completion
    "DoneTool",
    "AttemptCompletionBrowserTool",
    "SendMessageToUserBrowserTool",
    # V3 components
    "DOMService",
    "ActionHistory",
    "ActionHistoryEntry",
]
