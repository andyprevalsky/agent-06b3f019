"""Browser agent tool schemas for structured outputs.

These Pydantic models define the tools available to the browser agent.
Uses index-based element selection (matching browser-use action model).

INDEX-BASED APPROACH: Elements are referenced by their index in the DOM tree.
The DOM tree is serialized with indices like [1] button "Submit", [2] input[type=text], etc.
"""

from typing import List, Literal, Optional, Type

from pydantic import BaseModel, Field

# ============================================================================
# OBSERVATION TOOLS
# ============================================================================


class ScreenshotTool(BaseModel):
    """Take a screenshot of the current page."""
    
    tool: Literal["screenshot"]


class ExtractTool(BaseModel):
    """Extract structured data from the current page using LLM analysis."""
    
    tool: Literal["extract"]
    instruction: str = Field(
        description="Clear instruction describing what data to extract from the page"
    )


# ============================================================================
# ACTION TOOLS (Index-Based - Matching browser-use format)
# ============================================================================


class ClickTool(BaseModel):
    """Click an element by its index in the DOM tree."""
    
    tool: Literal["click"]
    index: int = Field(
        description="Element index from the DOM tree (e.g., 4 for '[4] button \"Submit\"')"
    )


class InputTextTool(BaseModel):
    """Type text into an input element. Use for forms, search boxes, etc. This clears any existing content in the field before typing the new text."""

    tool: Literal["input_text"]
    index: int = Field(
        description="Element index of the input field from the DOM tree"
    )
    text: str = Field(
        description="Text to type into the field. Replaces any existing content in the field."
    )


class PressKeyTool(BaseModel):
    """Press a keyboard key."""
    
    tool: Literal["press_key"]
    key: str = Field(
        description="Key to press (e.g., 'Enter', 'Tab', 'Escape', 'Control+a', 'Backspace')"
    )


class ClickAtCoordinatesTool(BaseModel):
    """Fallback: Click at specific X,Y pixel coordinates (for vision models)."""
    
    tool: Literal["click_coordinates"]
    x: int = Field(description="X coordinate in pixels from left edge of viewport")
    y: int = Field(description="Y coordinate in pixels from top edge of viewport")
    button: Literal["left", "right", "middle"] = Field(
        default="left", 
        description="Mouse button to click"
    )


# ============================================================================
# DROPDOWN TOOLS (browser-use additions)
# ============================================================================


class DropdownOptionsTool(BaseModel):
    """Get available options from a dropdown/select element."""
    
    tool: Literal["dropdown_options"]
    index: int = Field(
        description="Element index of the dropdown/select element"
    )


class SelectDropdownTool(BaseModel):
    """Select an option from a dropdown by its value or text."""
    
    tool: Literal["select_dropdown"]
    index: int = Field(
        description="Element index of the dropdown/select element"
    )
    value: str = Field(
        description="Value or visible text of the option to select"
    )


# ============================================================================
# EVALUATE TOOL (Execute JavaScript)
# ============================================================================


class EvaluateTool(BaseModel):
    """Execute JavaScript code in the browser console."""
    
    tool: Literal["evaluate"]
    code: str = Field(
        description="JavaScript code to execute. Returns the result of the expression."
    )


# ============================================================================
# NAVIGATION TOOLS
# ============================================================================


class GotoTool(BaseModel):
    """Navigate to a specific URL."""
    
    tool: Literal["goto"]
    url: str = Field(description="The URL to navigate to")


class NavbackTool(BaseModel):
    """Navigate back to the previous page in browser history."""
    
    tool: Literal["navback"]


class ScrollTool(BaseModel):
    """Scroll the page or a specific scrollable element."""
    
    tool: Literal["scroll"]
    direction: Literal["up", "down"] = Field(description="Direction to scroll")
    amount: int = Field(
        default=300, 
        description="Number of pixels to scroll (default: 300)"
    )
    index: Optional[int] = Field(
        default=None,
        description="Optional: element index to scroll within (for scrollable containers)"
    )


class WaitTool(BaseModel):
    """Wait for a specified time in milliseconds."""
    
    tool: Literal["wait"]
    time_ms: int = Field(description="Time to wait in milliseconds")


# ============================================================================
# TAB MANAGEMENT TOOLS
# ============================================================================


class SwitchTabTool(BaseModel):
    """Switch to a different browser tab by tab ID."""
    
    tool: Literal["switch_tab"]
    tab_id: str = Field(
        description="Tab ID to switch to (4-char suffix shown in tabs list, e.g., '1a2b')"
    )


class CloseTabTool(BaseModel):
    """Close a browser tab by tab ID."""
    
    tool: Literal["close_tab"]
    tab_id: Optional[str] = Field(
        default=None,
        description="Tab ID to close. If None, closes the current tab."
    )


class OpenNewTabTool(BaseModel):
    """Open a new tab and optionally navigate to a URL."""

    tool: Literal["open_new_tab"]
    url: Optional[str] = Field(
        default=None,
        description="URL to open in new tab (defaults to about:blank)"
    )


# ============================================================================
# FILE UPLOAD TOOLS
# ============================================================================


class UploadFileTool(BaseModel):
    """Upload a file to a file input element.

    Use this tool to upload files (like resumes, documents, images) to file input
    elements on web forms. The file must be available in the session's available_files.
    """

    tool: Literal["upload_file"]
    index: int = Field(
        description="Element index of the file input (<input type='file'>) from the DOM tree"
    )
    filename: str = Field(
        description="Filename to upload (must match a filename from the available_files list in the system state)"
    )


# ============================================================================
# COMPLETION & USER INTERACTION TOOLS
# ============================================================================


class DoneTool(BaseModel):
    """Signal that the browser task is complete."""
    
    tool: Literal["done"]
    text: str = Field(
        description="Summary of what was accomplished or the final result"
    )


class AttemptCompletionBrowserTool(BaseModel):
    """
    Use this tool when you are finished with your task and are ready for the grader to review your work.
    """

    tool: Literal["attempt_completion"]


class SendMessageToUserBrowserTool(BaseModel):
    """Request the user to complete an action (login, payment, CAPTCHA, etc.)."""
    
    tool: Literal["send_message_to_user"]
    message: str = Field(
        description="Explain what the user needs to do and why you cannot do it"
    )
    reason: Literal["login", "payment", "captcha", "verification", "blocked", "other"] = Field(
        description="Category of the user action needed"
    )


class RequestUserAssistanceForAuthenticationBrowserTool(BaseModel):
    """Ask the user to sign in after all automated auth paths are exhausted."""

    tool: Literal["request_user_assistance_for_authentication"]


class PaymentLineItem(BaseModel):
    """A checkout line item extracted from the merchant page."""

    name: str = Field(description="Item name shown on the checkout page")
    image_url: Optional[str] = Field(default=None, description="Product image URL if visible")
    unit_price_cents: int = Field(description="Unit price in cents")
    quantity: int = Field(description="Quantity")
    line_total_cents: int = Field(description="Line total in cents")


class PaymentFee(BaseModel):
    """A tax, shipping, service, or other checkout fee."""

    label: str = Field(description="Fee label shown on the checkout page")
    amount_cents: int = Field(description="Fee amount in cents")


class RequestPaymentCardBrowserTool(BaseModel):
    """Request a one-time virtual payment card for the current checkout after extracting the full receipt."""

    tool: Literal["request_payment_card"]
    merchant: str = Field(description="Merchant or site name for the purchase")
    currency: Literal["USD"] = Field(default="USD", description="Purchase currency; currently only USD")
    line_items: List[PaymentLineItem] = Field(
        description="Full itemized receipt: products/services, image URLs if visible, quantity, unit price, line total"
    )
    fees: List[PaymentFee] = Field(default_factory=list, description="Taxes, shipping, service fees, discounts, etc.")
    subtotal_cents: int = Field(description="Subtotal before fees in cents")
    total_cents: int = Field(description="Final checkout total in cents")


# ============================================================================
# Tool Registry (Index-Based)
# ============================================================================


# Map browser tool names to their Pydantic models
# Uses browser-use action model naming conventions
BROWSER_TOOL_MODELS = {
    # Observation
    "screenshot": ScreenshotTool,
    # Index-based actions
    "click": ClickTool,
    "input_text": InputTextTool,
    "press_key": PressKeyTool,
    # Coordinate-based fallback (for vision models)
    "click_coordinates": ClickAtCoordinatesTool,
    # Dropdown handling
    "dropdown_options": DropdownOptionsTool,
    "select_dropdown": SelectDropdownTool,
    # JavaScript execution
    "evaluate": EvaluateTool,
    # Navigation
    "goto": GotoTool,
    "navback": NavbackTool,
    "scroll": ScrollTool,
    "wait": WaitTool,
    # Tab management
    "switch_tab": SwitchTabTool,
    "close_tab": CloseTabTool,
    "open_new_tab": OpenNewTabTool,
    # File upload
    "upload_file": UploadFileTool,
    # Completion
    # "done": DoneTool,  # Use attempt_completion instead - browser-use 'done' maps to attempt_completion
    "attempt_completion": AttemptCompletionBrowserTool,
    # "send_message_to_user": SendMessageToUserBrowserTool,
    "request_user_assistance_for_authentication": RequestUserAssistanceForAuthenticationBrowserTool,
    "request_payment_card": RequestPaymentCardBrowserTool,
}


# List of available actions for Rose API request
AVAILABLE_ACTIONS = list(BROWSER_TOOL_MODELS.keys())


# ============================================================================
# Dynamic BrowserAgentAction Model Generation
# ============================================================================


def create_browser_agent_action_model(
    available_tool_names: Optional[List[str]] = None,
) -> Type[BaseModel]:
    """
    Dynamically create a BrowserAgentAction Pydantic model.
    
    Uses the unified create_agent_action_model from utils.tool_schemas with
    the BROWSER_TOOL_MODELS registry.
    
    Args:
        available_tool_names: List of tool names (defaults to all browser tools)
        
    Returns:
        Pydantic model class for BrowserAgentAction with proper tool union
    """
    from utils.tool_schemas import create_agent_action_model
    
    # Default to all browser tools
    if available_tool_names is None:
        available_tool_names = list(BROWSER_TOOL_MODELS.keys())
    
    return create_agent_action_model(available_tool_names, tool_registry=BROWSER_TOOL_MODELS)


__all__ = [
    # Observation
    "ScreenshotTool",
    "ExtractTool",
    # Index-based actions
    "ClickTool",
    "InputTextTool",
    "PressKeyTool",
    # Coordinate-based
    "ClickAtCoordinatesTool",
    # Dropdown
    "DropdownOptionsTool",
    "SelectDropdownTool",
    # JavaScript
    "EvaluateTool",
    # Navigation
    "GotoTool",
    "NavbackTool",
    "ScrollTool",
    "WaitTool",
    # Tab management
    "SwitchTabTool",
    "CloseTabTool",
    "OpenNewTabTool",
    # File upload
    "UploadFileTool",
    # Completion
    "DoneTool",
    "AttemptCompletionBrowserTool",
    "SendMessageToUserBrowserTool",
    "RequestUserAssistanceForAuthenticationBrowserTool",
    "RequestPaymentCardBrowserTool",
    # Registry & Factory
    "BROWSER_TOOL_MODELS",
    "AVAILABLE_ACTIONS",
    "create_browser_agent_action_model",
]
