"""Browser agent tool schemas for structured outputs.

These Pydantic models mirror the OpenAI function definitions for browser tools,
allowing the browser agent to use call_llm_structured_streaming like the main agent.

HYBRID APPROACH: We use Stagehand's observe() for element finding but give the agent
direct Playwright tools (click, fill, type) with explicit selectors.
"""

from typing import List, Literal, Optional, Union, Type
from pydantic import BaseModel, Field, create_model


# ============================================================================
# OBSERVATION TOOLS
# ============================================================================


class ObserveTool(BaseModel):
    """Find actionable elements on the page and get their selectors."""
    
    tool: Literal["observe"]
    instruction: str = Field(
        description="Describe what element(s) you're looking for"
    )
    iframes: Optional[bool] = Field(
        default=None,
        description="Set to true to search inside iframes as well"
    )


class AriaTreeTool(BaseModel):
    """Get the accessibility (ARIA) tree from the current page."""
    
    tool: Literal["ariaTree"]


class ScreenshotTool(BaseModel):
    """Take a screenshot of the current page."""
    
    tool: Literal["screenshot"]


class ExtractTool(BaseModel):
    """Extract structured data from the current page."""
    
    tool: Literal["extract"]
    instruction: str = Field(description="Clear instruction describing what data to extract")
    schema: str = Field(description='Zod schema as a string (e.g., "z.object({ price: z.number() })")')


# ============================================================================
# ACTION TOOLS (Direct Playwright with Selectors)
# ============================================================================


class ClickTool(BaseModel):
    """Click an element by CSS or XPath selector."""
    
    tool: Literal["click"]
    selector: str = Field(
        description="CSS selector or XPath (prefix with //) to identify the element"
    )


class FillTool(BaseModel):
    """Fill a form field by selector. Clears existing value first."""
    
    tool: Literal["fill"]
    selector: str = Field(description="CSS selector or XPath for the input element")
    value: str = Field(description="Text to fill into the field")


class TypeTool(BaseModel):
    """Type text into an element (does not clear existing value)."""
    
    tool: Literal["type"]
    selector: str = Field(description="CSS selector or XPath for the element")
    text: str = Field(description="Text to type")
    delay: int = Field(default=50, description="Delay between keystrokes in ms")


class PressKeyTool(BaseModel):
    """Press a keyboard key."""
    
    tool: Literal["pressKey"]
    key: str = Field(description="Key to press (e.g., 'Enter', 'Tab', 'Escape', 'Control+a')")


class ClickAtCoordinatesTool(BaseModel):
    """Fallback: Click at specific X,Y pixel coordinates."""
    
    tool: Literal["clickAtCoordinates"]
    x: int = Field(description="X coordinate in pixels from left edge of viewport")
    y: int = Field(description="Y coordinate in pixels from top edge of viewport")
    button: Literal["left", "right", "middle"] = Field(default="left", description="Mouse button to click")


# ============================================================================
# NAVIGATION TOOLS
# ============================================================================


class GotoTool(BaseModel):
    """Navigate to a specific URL."""
    
    tool: Literal["goto"]
    url: str = Field(description="The URL to navigate to")


class NavbackTool(BaseModel):
    """Navigate back to the previous page."""
    
    tool: Literal["navback"]
    reasoning: str = Field(description="Why you're going back")


class ScrollTool(BaseModel):
    """Scroll the page."""
    
    tool: Literal["scroll"]
    pixels: int = Field(description="Number of pixels to scroll")
    direction: Literal["up", "down"] = Field(description="Direction to scroll")


class WaitTool(BaseModel):
    """Wait for a specified time."""
    
    tool: Literal["wait"]
    timeMs: int = Field(description="Time to wait in milliseconds")


# ============================================================================
# COMPLETION & USER INTERACTION TOOLS
# ============================================================================


class AttemptCompletionBrowserTool(BaseModel):
    """
    Signal that the browser task is complete and ready for verification.
    
    Call this when you believe the goal has been accomplished.
    A verifier will run to confirm - if verification passes, the session closes.
    If not, you'll receive feedback and can continue working.
    """
    
    tool: Literal["attempt_completion"]
    reasoning: str = Field(description="Summary of what was accomplished and why you believe the task is complete")


# DEPRECATED: Use attempt_completion instead
class CloseTool(BaseModel):
    """DEPRECATED - Use attempt_completion instead. Complete the task and close the browser session."""
    
    tool: Literal["close"]
    reasoning: str = Field(description="Summary of what was accomplished")
    success: bool = Field(description="Whether the full goal of the task was achieved")


class SendMessageToUserBrowserTool(BaseModel):
    """Request the user to complete an action (login, payment, CAPTCHA, etc.)."""
    
    tool: Literal["send_message_to_user"]
    message: str = Field(description="Explain what the user needs to do and why you cannot do it")
    reason: str = Field(description="Category: login, payment, captcha, verification, blocked, other")


# ============================================================================
# Tool Registry
# ============================================================================


# Map browser tool names to their Pydantic models
BROWSER_TOOL_MODELS = {
    # Observation
    "observe": ObserveTool,
    "ariaTree": AriaTreeTool,
    "screenshot": ScreenshotTool,
    "extract": ExtractTool,
    # Actions
    "click": ClickTool,
    "fill": FillTool,
    "type": TypeTool,
    "pressKey": PressKeyTool,
    "clickAtCoordinates": ClickAtCoordinatesTool,
    # Navigation
    "goto": GotoTool,
    "navback": NavbackTool,
    "scroll": ScrollTool,
    "wait": WaitTool,
    # Completion (attempt_completion is the standard, close is deprecated)
    "attempt_completion": AttemptCompletionBrowserTool,
    "close": CloseTool,  # Kept for backward compatibility
    "send_message_to_user": SendMessageToUserBrowserTool,
}


# ============================================================================
# Dynamic BrowserAgentAction Model Generation
# ============================================================================


def create_browser_agent_action_model(
    available_tool_names: Optional[List[str]] = None,
) -> Type[BaseModel]:
    """
    Dynamically create a BrowserAgentAction Pydantic model.
    
    Uses the unified create_agent_action_model from helpers.tool_schemas with
    the BROWSER_TOOL_MODELS registry.
    
    Args:
        available_tool_names: List of tool names (defaults to all browser tools)
        
    Returns:
        Pydantic model class for BrowserAgentAction with proper tool union
    """
    from helpers.tool_schemas import create_agent_action_model
    
    # Default to all browser tools
    if available_tool_names is None:
        available_tool_names = list(BROWSER_TOOL_MODELS.keys())
    
    return create_agent_action_model(available_tool_names, tool_registry=BROWSER_TOOL_MODELS)


__all__ = [
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
    "CloseTool",  # Deprecated - kept for backward compatibility
    "SendMessageToUserBrowserTool",
    # Registry & Factory
    "BROWSER_TOOL_MODELS",
    "create_browser_agent_action_model",
]
