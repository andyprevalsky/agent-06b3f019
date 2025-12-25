"""Browser agent tool schemas for structured outputs.

These Pydantic models mirror the OpenAI function definitions for browser tools,
allowing the browser agent to use call_llm_structured_streaming like the main agent.
"""

from typing import List, Literal, Optional, Union, Type
from pydantic import BaseModel, Field, create_model


# ============================================================================
# Individual Browser Tool Pydantic Models
# ============================================================================


class ActTool(BaseModel):
    """Perform an action on the page (click, type, fill)."""
    
    tool: Literal["act"]
    action: str = Field(
        description='Describe the click, type, fill, scroll action in a short, specific phrase. '
                    'Examples: "click the Login button", "type \'John\' into the first name input", '
                    '"fill the email field with test@example.com"'
    )


class AriaTreeTool(BaseModel):
    """Get the accessibility (ARIA) tree from the current page."""
    
    tool: Literal["ariaTree"]


class CloseTool(BaseModel):
    """Complete the task and close the browser session."""
    
    tool: Literal["close"]
    reasoning: str = Field(description="Summary of what was accomplished")
    success: bool = Field(description="Whether the full goal of the task was achieved")


class ExtractTool(BaseModel):
    """Extract structured data from the current page."""
    
    tool: Literal["extract"]
    instruction: str = Field(description="Clear instruction describing what data to extract")
    schema: str = Field(description='Zod schema as a string (e.g., "z.object({ price: z.number() })")')


class FillFormField(BaseModel):
    """A single field in a form fill operation."""
    
    action: str = Field(description='Description of the typing action, e.g. "type foo into the bar field"')
    value: str = Field(description="Text to type into the target field")


class FillFormTool(BaseModel):
    """Fill multiple form fields efficiently."""
    
    tool: Literal["fillForm"]
    fields: List[FillFormField] = Field(
        min_length=1,
        description="List of fields to fill, each with action description and value"
    )


class GotoTool(BaseModel):
    """Navigate to a specific URL."""
    
    tool: Literal["goto"]
    url: str = Field(description="The URL to navigate to")


class NavbackTool(BaseModel):
    """Navigate back to the previous page."""
    
    tool: Literal["navback"]
    reasoning: str = Field(description="Why you're going back")


class ScreenshotTool(BaseModel):
    """Take a screenshot of the current page."""
    
    tool: Literal["screenshot"]


class ScrollTool(BaseModel):
    """Scroll the page."""
    
    tool: Literal["scroll"]
    pixels: int = Field(description="Number of pixels to scroll")
    direction: Literal["up", "down"] = Field(description="Direction to scroll")


class WaitTool(BaseModel):
    """Wait for a specified time."""
    
    tool: Literal["wait"]
    timeMs: int = Field(description="Time to wait in milliseconds")


class SendMessageToUserBrowserTool(BaseModel):
    """Request the user to complete an action (login, payment, CAPTCHA, etc.)."""
    
    tool: Literal["send_message_to_user"]
    message: str = Field(description="Explain what the user needs to do and why you cannot do it")
    reason: str = Field(description="Category: login, payment, captcha, verification, blocked, other")


# Map browser tool names to their Pydantic models
BROWSER_TOOL_MODELS = {
    "act": ActTool,
    "ariaTree": AriaTreeTool,
    "close": CloseTool,
    "extract": ExtractTool,
    "fillForm": FillFormTool,
    "goto": GotoTool,
    "navback": NavbackTool,
    "screenshot": ScreenshotTool,
    "scroll": ScrollTool,
    "wait": WaitTool,
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
    
    This mirrors the main agent's create_agent_action_model but for browser tools.
    
    Args:
        available_tool_names: List of tool names (defaults to all browser tools)
        
    Returns:
        Pydantic model class for BrowserAgentAction with proper tool union
    """
    # Default to all browser tools
    if available_tool_names is None:
        available_tool_names = list(BROWSER_TOOL_MODELS.keys())
    
    # Build list of tool models
    tool_types = []
    for name in available_tool_names:
        if name in BROWSER_TOOL_MODELS:
            tool_types.append(BROWSER_TOOL_MODELS[name])
    
    # Create union type for tool calls
    if len(tool_types) == 1:
        ToolCallUnion = tool_types[0]
    else:
        ToolCallUnion = Union[tuple(tool_types)]
    
    tool_calls_field = (
        List[ToolCallUnion],
        Field(default_factory=list, description="List of browser tools to call in sequence")
    )
    
    # Create the BrowserAgentAction model
    BrowserAgentAction = create_model(
        "BrowserAgentAction",
        response=(
            str,
            Field(
                description="Thinking/reasoning about what to do next. Explain your observations "
                           "and strategy. This is shown to the user as 'Thinking...' text."
            ),
        ),
        tool_calls=tool_calls_field,
        __base__=BaseModel,
    )
    
    return BrowserAgentAction


__all__ = [
    "ActTool",
    "AriaTreeTool", 
    "CloseTool",
    "ExtractTool",
    "FillFormTool",
    "FillFormField",
    "GotoTool",
    "NavbackTool",
    "ScreenshotTool",
    "ScrollTool",
    "WaitTool",
    "SendMessageToUserBrowserTool",
    "BROWSER_TOOL_MODELS",
    "create_browser_agent_action_model",
]

