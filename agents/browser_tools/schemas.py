"""Browser agent tool schemas for structured outputs.

These Pydantic models define the tools available to the browser agent.
Uses index-based element selection (matching browser-use action model).

INDEX-BASED APPROACH: Elements are referenced by their index in the DOM tree.
The DOM tree is serialized with indices like [1] button "Submit", [2] input[type=text], etc.
"""

import math
from typing import Any, Dict, List, Literal, Optional, Type

from pydantic import AliasChoices, BaseModel, Field, ValidationError, ValidationInfo, field_validator, model_validator

from utils.purchase_approval import (
    validate_product_detail_url,
    validate_product_rating,
    validate_product_review_count,
    validate_product_url_for_page,
    validate_product_url_for_pages,
)

MAX_BROWSER_WAIT_MS = 60_000

# Runtime.evaluate can hang forever on a frozen renderer (Momence Konva waiver).
# Bound every evaluate; the LLM may raise the bound up to this cap.
EVALUATE_TIMEOUT_SECONDS_DEFAULT = 15.0
EVALUATE_TIMEOUT_SECONDS_MAX = 60.0


def normalize_browser_wait_ms(value: Any, *, default: int = 1000) -> int:
    """Normalize raw LLM tool arguments before they reach any wait executor."""
    candidate = default if value is None else value
    try:
        return min(MAX_BROWSER_WAIT_MS, max(0, int(float(candidate))))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("wait time_ms must be numeric") from exc


def normalize_evaluate_timeout_seconds(
    value: Any, *, default: float = EVALUATE_TIMEOUT_SECONDS_DEFAULT
) -> float:
    """Normalize evaluate timeout seconds; omit → default, never above max."""
    candidate = default if value is None else value
    try:
        timeout = float(candidate)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("evaluate timeout must be numeric") from exc
    if not math.isfinite(timeout) or timeout <= 0:
        return float(default)
    return min(EVALUATE_TIMEOUT_SECONDS_MAX, timeout)


# ============================================================================
# OBSERVATION TOOLS
# ============================================================================


_READ_BROWSER_STATE_EXAMPLE = """# Current Browser State

Timestamp: 2026-08-22T20:31:00Z
<page_stats>12 links, 8 interactive, 0 iframes, 1 scroll containers, 42 total elements</page_stats>
Current URL: https://example.com/checkout - Checkout
Viewport: 1280x800
Scroll: (0, 0) | 0.0 pages above, 1.2 pages below
Interactive elements:
[Start of page]
[3]<input>Email</input>
[7]<button>Pay now</button>
[End of page]"""


_READ_BROWSER_STATE_TOOL_DESCRIPTION = (
    "Read the current browser page state: URL, viewport, scroll position, tabs, page stats, "
    "and indexed interactive DOM tree. Call before click/input_text/scroll when you need "
    "element [index] values or to see what changed after navigation. Returns formatted text "
    "beginning with '# Current Browser State' (same shape as the old per-turn snapshot).\n\n"
    "Example output:\n"
    "```\n"
    f"{_READ_BROWSER_STATE_EXAMPLE}\n"
    "```"
)


class ReadBrowserStateTool(BaseModel):
    tool: Literal["read_browser_state"]


ReadBrowserStateTool.__doc__ = _READ_BROWSER_STATE_TOOL_DESCRIPTION


class ScreenshotTool(BaseModel):
    """Take a screenshot of the current page."""

    tool: Literal["screenshot"]


class ExtractTool(BaseModel):
    """Extract structured data from the current page using LLM analysis."""

    tool: Literal["extract"]
    instruction: str = Field(description="Clear instruction describing what data to extract from the page")


class ReadLogsBrowserTool(BaseModel):
    """Read merged browser console + network logs with regex filtering."""

    tool: Literal["read_logs"]
    pattern: Optional[str] = Field(
        default=None,
        description="Optional regex matched against each log line (console text, network summary, URL, status).",
    )
    limit: Optional[int] = Field(default=None, description="Maximum number of log lines to return (default 100).")
    clear: Optional[bool] = Field(default=None, description="When true, clear captured logs after reading.")
    sources: Optional[List[str]] = Field(
        default=None,
        description="Optional subset of log sources: 'console', 'network'. Defaults to both.",
    )
    level: Optional[str] = Field(
        default=None,
        description="Optional console level filter (e.g. 'error', 'warning', 'log').",
    )
    status: Optional[str] = Field(
        default=None,
        description="Optional network status filter when network source is included: '403', '4xx', 'error', 'ok'.",
    )
    url_pattern: Optional[str] = Field(
        default=None,
        description="Optional substring filter for network request URLs.",
    )
    method: Optional[str] = Field(default=None, description="Optional HTTP method filter for network rows.")
    resource_type: Optional[str] = Field(
        default=None,
        description="Optional network resource-type filter (e.g. 'Fetch', 'XHR').",
    )
    include_query: Optional[bool] = Field(
        default=None,
        description="When true, return full network URLs including query strings.",
    )
    include_headers: Optional[bool] = Field(
        default=None,
        description="When true, include network request/response headers (credentials masked).",
    )
    include_bodies: Optional[bool] = Field(
        default=None,
        description="When true, include captured network request/response bodies.",
    )
    max_body_chars: Optional[int] = Field(
        default=None,
        description="Per-body character cap when include_bodies is set (default 4000).",
    )


class ReadNetworkRequestsBrowserTool(BaseModel):
    """Read the HTTP network requests made by the current page, with optional headers and bodies."""

    tool: Literal["read_network_requests"]
    url_pattern: Optional[str] = Field(
        default=None, description="Optional substring to filter request URLs (e.g. '/api/')."
    )
    method: Optional[str] = Field(default=None, description="Optional HTTP method filter (e.g. 'POST').")
    status: Optional[str] = Field(
        default=None,
        description="Optional status filter: exact ('403'), class ('4xx'), 'error' (>=400 or failed), or 'ok'.",
    )
    resource_type: Optional[str] = Field(
        default=None,
        description="Optional resource-type filter (e.g. 'XHR', 'Fetch', 'Document', 'Script').",
    )
    limit: Optional[int] = Field(default=None, description="Maximum number of requests to return (default 100).")
    clear: Optional[bool] = Field(default=None, description="When true, clear the captured buffer after reading.")
    include_query: Optional[bool] = Field(
        default=None,
        description="When true, return full URLs including query strings instead of scheme://host/path only.",
    )
    include_headers: Optional[bool] = Field(
        default=None,
        description="When true, include request and response headers (cookie/authorization values are masked).",
    )
    include_bodies: Optional[bool] = Field(
        default=None,
        description="When true, include request post data and captured response bodies.",
    )
    max_body_chars: Optional[int] = Field(
        default=None,
        description="Per-body character cap when include_bodies is set (default 4000).",
    )


# ============================================================================
# ACTION TOOLS (Index-Based - Matching browser-use format)
# ============================================================================


class ClickTool(BaseModel):
    """Click an element by its index in the DOM tree."""

    tool: Literal["click"]
    index: int = Field(description="Element index from the DOM tree (e.g., 4 for '[4] button \"Submit\"')")


class InputTextTool(BaseModel):
    """Type text into an input element. Use for forms, search boxes, etc. This clears any existing content in the field before typing the new text."""

    tool: Literal["input_text"]
    index: int = Field(description="Element index of the input field from the DOM tree")
    text: str = Field(description="Text to type into the field. Replaces any existing content in the field.")
    clear: bool = Field(default=True, description="Clear the field before typing (default: true)")


class PressKeyTool(BaseModel):
    """Press a keyboard key."""

    tool: Literal["press_key"]
    key: str = Field(description="Key to press (e.g., 'Enter', 'Tab', 'Escape', 'Control+a', 'Backspace')")


class ClickAtCoordinatesTool(BaseModel):
    """Fallback: Click at specific X,Y pixel coordinates (for vision models)."""

    tool: Literal["click_coordinates"]
    x: int = Field(description="X coordinate in pixels from left edge of viewport")
    y: int = Field(description="Y coordinate in pixels from top edge of viewport")
    button: Literal["left", "right", "middle"] = Field(default="left", description="Mouse button to click")


class DragTool(BaseModel):
    """Drag from a start point to an end point via CDP mouse press/move/release.

    Prefer indexed elements when both ends appear in the DOM tree. Use viewport
    coordinates (matching screenshot pixels) when the control is visual-only
    (CAPTCHA / Bot or Not slider, canvas, etc.).
    """

    tool: Literal["drag"]
    source_index: Optional[int] = Field(
        default=None,
        description="DOM index of the drag start element (e.g. slider thumb)",
    )
    target_index: Optional[int] = Field(
        default=None,
        description="DOM index of the drag end / drop target element",
    )
    start_x: Optional[int] = Field(
        default=None,
        description="Viewport X of drag start (pixels from left; matches screenshot)",
    )
    start_y: Optional[int] = Field(
        default=None,
        description="Viewport Y of drag start (pixels from top; matches screenshot)",
    )
    end_x: Optional[int] = Field(
        default=None,
        description="Viewport X of drag end (pixels from left; matches screenshot)",
    )
    end_y: Optional[int] = Field(
        default=None,
        description="Viewport Y of drag end (pixels from top; matches screenshot)",
    )
    steps: int = Field(
        default=24,
        ge=2,
        le=120,
        description="Number of intermediate mouse-move samples while the button is held (default 24)",
    )

    @model_validator(mode="after")
    def require_start_and_end(self) -> "DragTool":
        has_start = self.source_index is not None or (
            self.start_x is not None and self.start_y is not None
        )
        has_end = self.target_index is not None or (self.end_x is not None and self.end_y is not None)
        if not has_start:
            raise ValueError(
                "drag requires source_index or both start_x and start_y"
            )
        if not has_end:
            raise ValueError(
                "drag requires target_index or both end_x and end_y"
            )
        if (self.start_x is None) ^ (self.start_y is None):
            raise ValueError("drag start_x and start_y must be provided together")
        if (self.end_x is None) ^ (self.end_y is None):
            raise ValueError("drag end_x and end_y must be provided together")
        return self


# ============================================================================
# DROPDOWN TOOLS (browser-use additions)
# ============================================================================


class DropdownOptionsTool(BaseModel):
    """Get available options from a dropdown/select element."""

    tool: Literal["dropdown_options"]
    index: int = Field(description="Element index of the dropdown/select element")


class SelectDropdownTool(BaseModel):
    """Select an option from a dropdown by its value or text."""

    tool: Literal["select_dropdown"]
    index: int = Field(description="Element index of the dropdown/select element")
    value: str = Field(description="Value or visible text of the option to select")


# ============================================================================
# EVALUATE TOOL (Execute JavaScript)
# ============================================================================


class EvaluateTool(BaseModel):
    """Execute JavaScript in the page."""

    tool: Literal["evaluate"]
    code: str = Field(
        description=(
            "JavaScript code to execute. Returns the result of the expression."
        )
    )
    timeout: Optional[float] = Field(
        default=None,
        ge=0.1,
        le=EVALUATE_TIMEOUT_SECONDS_MAX,
        description=(
            "Max seconds to wait for the expression (including awaited promises). "
            f"Omit for the default ({EVALUATE_TIMEOUT_SECONDS_DEFAULT:g}s). "
            f"Hard cap is {EVALUATE_TIMEOUT_SECONDS_MAX:g}s — do not set higher."
        ),
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
    amount: int = Field(default=300, description="Number of pixels to scroll (default: 300)")
    index: Optional[int] = Field(
        default=None,
        description="Optional scroll-container index; omit or use 0 for viewport scroll",
    )


class WaitTool(BaseModel):
    """Wait for a specified time in milliseconds."""

    tool: Literal["wait"]
    time_ms: int = Field(
        description="Time to wait in milliseconds",
        ge=0,
        le=MAX_BROWSER_WAIT_MS,
    )


# ============================================================================
# TAB MANAGEMENT TOOLS
# ============================================================================


class SwitchTabTool(BaseModel):
    """Switch to a different browser tab by tab ID."""

    tool: Literal["switch_tab"]
    tab_id: str = Field(description="Tab ID to switch to (4-char suffix shown in tabs list, e.g., '1a2b')")


class CloseTabTool(BaseModel):
    """Close a browser tab by tab ID."""

    tool: Literal["close_tab"]
    tab_id: Optional[str] = Field(default=None, description="Tab ID to close. If None, closes the current tab.")


class OpenNewTabTool(BaseModel):
    """Open a new tab and optionally navigate to a URL."""

    tool: Literal["open_new_tab"]
    url: Optional[str] = Field(default=None, description="URL to open in new tab (defaults to about:blank)")


# ============================================================================
# FILE UPLOAD TOOLS
# ============================================================================


class UploadFileTool(BaseModel):
    """Upload a file to a file input element.

    Use this tool to upload files (like resumes, documents, images) to file input
    elements on web forms. The file must be available in the session's available_files.
    """

    tool: Literal["upload_file"]
    index: int = Field(description="Element index of the file input (<input type='file'>) from the DOM tree")
    filename: str = Field(
        description="Filename to upload (must match a filename from the available_files list in the system state)"
    )


# ============================================================================
# COMPLETION & USER INTERACTION TOOLS
# ============================================================================


class DoneTool(BaseModel):
    """Signal that the browser task is complete."""

    tool: Literal["done"]
    text: str = Field(description="Summary of what was accomplished or the final result")


class AttemptCompletionBrowserTool(BaseModel):
    """
    Use this tool when you are finished with your task and are ready for the grader to review your work.
    """

    tool: Literal["attempt_completion"]


class PhoneBrowserTool(BaseModel):
    """Operate the account's dedicated cloud iPhone through Rose."""
    model_config = {"extra": "forbid"}
    tool: Literal["phone"]
    mode: Literal["operation", "status", "release", "setup"]
    operation: Optional[str] = None
    args: Dict[str, Any] = Field(default_factory=dict)
    action: Optional[Literal["defer", "block", "verify"]] = None
    reasonCode: Optional[Literal["user_constraint", "unsupported", "configuration_unavailable", "observed_signed_out"]] = None
    evidenceOperationIds: Optional[List[str]] = Field(default=None, description="Use only for mode=setup and action=verify: 1..8 current observation IDs. Omit or null for block, defer, and all other modes.")
    verificationTarget: Optional[Literal["apple_account", "icloud_messages", "icloud_keychain", "icloud_contacts", "imessage", "receive_address", "portrait_lock", "device_passcode", "gmail", "google_passcode_exception", "runtime"]] = Field(default=None, description="Use only for mode=setup and action=verify. Omit or null for block, defer, and all other modes.")

    @model_validator(mode="after")
    def validate_mode(self):
        if self.verificationTarget is not None and (self.mode != "setup" or self.action != "verify"):
            raise ValueError("verificationTarget requires setup verify")
        if self.mode == "operation" and not (self.operation or "").strip():
            raise ValueError("operation mode requires an operation")
        if self.mode != "operation" and (self.operation is not None or self.args):
            raise ValueError("Non-operation mode does not accept commands")
        if self.mode == "setup":
            if self.action is None:
                raise ValueError("setup mode requires an action")
            if self.action == "verify":
                evidence = self.evidenceOperationIds or []
                if self.reasonCode is not None or not 1 <= len(evidence) <= 8 or len(set(evidence)) != len(evidence) or any(not value.strip() for value in evidence):
                    raise ValueError("verify requires 1..8 unique observation IDs and no reasonCode")
            elif self.evidenceOperationIds is not None or (
                self.action == "defer" and self.reasonCode != "user_constraint"
            ) or (self.action == "block" and self.reasonCode not in {"unsupported", "configuration_unavailable", "observed_signed_out"}):
                raise ValueError("setup action requires its matching reasonCode and no evidence")
        elif self.action is not None or self.reasonCode is not None or self.evidenceOperationIds is not None:
            raise ValueError("Setup fields require setup mode")
        return self


class RequestUserAssistanceForAuthenticationBrowserTool(BaseModel):
    """Request browser sign-in help or critical native phone authentication."""

    model_config = {"extra": "forbid"}
    tool: Literal["request_user_assistance_for_authentication"]
    targetKind: Literal["browser", "iphone"] = "browser"
    criticalReason: Optional[Literal["password", "verification_code", "device_passcode", "manual_verification"]] = None

    @model_validator(mode="after")
    def validate_target(self):
        if self.targetKind == "iphone" and self.criticalReason is None:
            raise ValueError("iPhone assistance requires a criticalReason")
        if self.targetKind == "browser" and self.criticalReason is not None:
            raise ValueError("criticalReason is only used for iPhone assistance")
        return self


class RecoverFromChallengeBrowserTool(BaseModel):
    """Relatively expensive staged recovery to force-open a blocked page or service.

    It can move the browser to a different browser/IP configuration (network exit).
    """

    tool: Literal["recover_from_challenge"]
    reason: str = Field(
        description=(
            "One line of concrete evidence that this page or service must be force-opened and no "
            "alternate goal path exists"
        )
    )
    auth_cookies_are_preserved: bool = Field(
        default=True,
        description=(
            "True when the current browser session is logged in and the new machine must "
            "maintain the current authenticated state to pass the goal/task. False when you "
            "want to explore machines that have a fresh cookie state (and thus potentially "
            "lose auth status, but potentially fix a bad cookie which is poisoning every "
            "session with a forced anti-bot)."
        ),
    )


class PaymentLineItem(BaseModel):
    """A checkout line item extracted from the merchant page."""

    name: str = Field(
        description=(
            "Item name shown on the checkout page. When the purchase is tied to a specific "
            "date, such as an event or movie ticket, a reservation, a flight, a hotel night, an "
            "appointment, or a delivery window, include that date (and the time when the "
            "booking is time-specific) in this name, for example "
            "'Spider-Man: Brand New Day - Fri Jul 31, 2026, 7:15pm, Seat A7'. A person "
            "approving the charge must be able to see which day they are paying for without "
            "opening the merchant page."
        )
    )
    image_url: Optional[str] = Field(
        default=None,
        description="Product image URL if visible",
        validation_alias=AliasChoices("image_url", "imageUrl"),
    )
    product_url: str = Field(
        description=(
            "Canonical product-detail page URL for this item. This must link to the product itself, "
            "never a cart, basket, checkout, payment, or order-confirmation page."
        ),
        validation_alias=AliasChoices("product_url", "productUrl"),
    )
    rating: str = Field(
        description=(
            "Product rating shown on the product page, such as '4.8 stars'. If the page "
            "genuinely shows no rating (e.g. a service, ticket, or event booking), pass "
            "'0 stars', never 'N/A', 'none', 'unknown', or a made-up number."
        )
    )
    review_count: str = Field(
        description=(
            "Product review count shown on the product page, preserving visible formatting. "
            "If the page genuinely shows no reviews (e.g. a service, ticket, or event "
            "booking), pass '0 reviews', never 'N/A', 'none', 'unknown', or a made-up number."
        ),
        validation_alias=AliasChoices("review_count", "reviewCount"),
    )
    unit_price_cents: int = Field(
        description="Unit price in cents",
        ge=1,
        validation_alias=AliasChoices("unit_price_cents", "unitPriceCents"),
    )
    quantity: int = Field(description="Quantity", ge=1)
    line_total_cents: int = Field(
        description="Line total in cents",
        ge=1,
        validation_alias=AliasChoices("line_total_cents", "lineTotalCents"),
    )

    @field_validator("product_url")
    @classmethod
    def require_product_detail_url(cls, value: str) -> str:
        return validate_product_detail_url(value)

    @field_validator("rating")
    @classmethod
    def require_product_rating(cls, value: str) -> str:
        return validate_product_rating(value)

    @field_validator("review_count")
    @classmethod
    def require_product_review_count(cls, value: str) -> str:
        return validate_product_review_count(value)


class PaymentFee(BaseModel):
    """A tax, shipping, service, or other checkout fee."""

    label: str = Field(description="Fee label shown on the checkout page")
    amount_cents: int = Field(
        description="Fee amount in cents",
        validation_alias=AliasChoices("amount_cents", "amountCents"),
    )


class RequestPaymentCardBrowserTool(BaseModel):
    """Request a one-time virtual payment card for the current checkout after extracting the full receipt."""

    tool: Literal["request_payment_card"]
    merchant: str = Field(description="Merchant or site name for the purchase")
    currency: Literal["USD"] = Field(default="USD", description="Purchase currency; currently only USD")
    line_items: List[PaymentLineItem] = Field(
        description=(
            "Full itemized receipt. Every item must include its canonical product-detail URL, rating, "
            "review count, image URL if visible, quantity, unit price, and line total."
        ),
        min_length=1,
        validation_alias=AliasChoices("line_items", "lineItems"),
    )
    fees: List[PaymentFee] = Field(default_factory=list, description="Taxes, shipping, service fees, discounts, etc.")
    subtotal_cents: int = Field(
        description="Subtotal before fees in cents",
        ge=1,
        validation_alias=AliasChoices("subtotal_cents", "subtotalCents"),
    )
    total_cents: int = Field(
        description="Final checkout total in cents",
        ge=1,
        validation_alias=AliasChoices("total_cents", "totalCents"),
    )

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value: Any) -> Any:
        return str(value).upper() if value is not None else value


# ============================================================================
# INTERNAL WRITE-LOCK APPROVAL TOOL
# ============================================================================


def _format_write_lock_usd(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return f"${value:.2f}"
    text = str(value).strip()
    if not text:
        return None
    if text.startswith("$"):
        return text
    try:
        return f"${float(text):.2f}"
    except ValueError:
        return text


class WriteLockService(BaseModel):
    """The website or service where the write-locked action would happen."""

    name: Optional[str] = Field(default=None, description="Human-readable service name, such as Amazon or Gmail.")
    domain: str = Field(description="Domain from the current page URL, such as amazon.com.")
    url: str = Field(
        description="Current page URL where the write lock was triggered.",
        validation_alias=AliasChoices("url", "current_url"),
    )


class WriteLockMedia(BaseModel):
    """A media asset useful for rendering an approval notification."""

    url: str = Field(description="Publicly accessible image, attachment, page preview, or rendered summary URL.")
    alt: Optional[str] = Field(default=None, description="Short accessible description of this media.")
    kind: Literal["product", "attachment", "page_preview", "rendered_summary"] = Field(
        default="product",
        description="How this media should be used by the approval renderer.",
        validation_alias=AliasChoices("kind", "type"),
    )

    @field_validator("kind", mode="before")
    @classmethod
    def normalize_kind(cls, value: Any) -> Any:
        if value == "image":
            return "product"
        return value


class WriteLockPurchaseItem(BaseModel):
    """One item included in a purchase approval."""

    title: str = Field(
        description="Visible item title.",
        validation_alias=AliasChoices("title", "name"),
    )
    price: Optional[str] = Field(
        default=None,
        description="Visible item price, preserving currency and formatting.",
        validation_alias=AliasChoices("price", "unit_price", "price_usd"),
    )
    quantity: Optional[str] = Field(default=None, description="Visible quantity.")
    description: Optional[str] = Field(
        default=None,
        description="Short visible item description or variant details. Keep under 80 characters.",
    )
    rating: str = Field(description="Required numeric product rating, such as '4.6 stars'.")
    review_count: str = Field(
        description=(
            "Required numeric review count followed by 'reviews' or 'ratings', "
            "for example '312 reviews'."
        ),
        validation_alias=AliasChoices("review_count", "reviewCount", "reviews"),
    )
    image_url: Optional[str] = Field(default=None, description="Best image URL for this item.")
    product_url: str = Field(
        description="Required canonical product-detail URL; never use a cart, checkout, payment, or order URL.",
        validation_alias=AliasChoices("product_url", "productUrl"),
    )
    seller: Optional[str] = Field(default=None, description="Visible seller or merchant for this item.")
    shipping: Optional[str] = Field(default=None, description="Visible item shipping or delivery details.")

    @model_validator(mode="before")
    @classmethod
    def normalize_provider_item_fields(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        value = dict(value)
        if "price" not in value and "price_usd" in value:
            value["price"] = _format_write_lock_usd(value.get("price_usd"))
        return value

    @field_validator("price", "quantity", "rating", "review_count", mode="before")
    @classmethod
    def stringify_visible_value(cls, value: Any) -> Any:
        if value is None:
            return None
        return str(value)

    @field_validator("rating")
    @classmethod
    def require_product_rating(cls, value: str) -> str:
        return validate_product_rating(value)

    @field_validator("review_count")
    @classmethod
    def require_product_review_count(cls, value: str) -> str:
        return validate_product_review_count(value)

    @field_validator("product_url")
    @classmethod
    def require_product_detail_url(cls, value: str) -> str:
        return validate_product_detail_url(value)


class WriteLockPurchaseTotals(BaseModel):
    """Visible purchase totals."""

    subtotal: Optional[str] = Field(default=None, description="Visible subtotal.")
    shipping: Optional[str] = Field(default=None, description="Visible shipping cost or label.")
    tax: Optional[str] = Field(default=None, description="Visible tax.")
    total: Optional[str] = Field(default=None, description="Visible order total.")

    @model_validator(mode="before")
    @classmethod
    def normalize_usd_totals(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        value = dict(value)
        alias_map = {
            "subtotal": ("items", "cart_subtotal"),
            "shipping": ("shipping_and_handling",),
            "tax": ("estimated_tax",),
            "total": ("order_total",),
        }
        for field_name, aliases in alias_map.items():
            if field_name not in value:
                for alias in aliases:
                    if value.get(alias) is not None:
                        value[field_name] = value.get(alias)
                        break
        for field_name in ("subtotal", "shipping", "tax", "total"):
            usd_key = f"{field_name}_usd"
            if field_name not in value and usd_key in value:
                value[field_name] = _format_write_lock_usd(value.get(usd_key))
        return value


class WriteLockPurchaseDetails(BaseModel):
    """Purchase details for one or more items."""

    items: List[WriteLockPurchaseItem] = Field(
        min_length=1,
        description="Every visible item being purchased, not just the clicked button's nearest item.",
    )
    totals: Optional[WriteLockPurchaseTotals] = Field(default=None, description="Visible order totals.")
    payment_method: Optional[str] = Field(default=None, description="Visible payment method, without secrets.")
    delivery_address: Optional[str] = Field(default=None, description="Visible delivery address or recipient.")

    @model_validator(mode="before")
    @classmethod
    def normalize_flat_totals(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        if isinstance(value.get("totals"), dict):
            return value
        totals = {
            "subtotal": (
                value.get("subtotal") or value.get("cart_subtotal") or _format_write_lock_usd(value.get("subtotal_usd"))
            ),
            "shipping": value.get("shipping") or _format_write_lock_usd(value.get("shipping_usd")),
            "tax": (
                value.get("tax")
                or value.get("estimated_tax")
                or _format_write_lock_usd(value.get("tax_usd"))
                or _format_write_lock_usd(value.get("estimated_tax_usd"))
            ),
            "total": value.get("total") or value.get("order_total") or _format_write_lock_usd(value.get("total_usd")),
        }
        if any(totals.values()):
            value = dict(value)
            value["totals"] = totals
        return value


class WriteLockMessageAttachment(BaseModel):
    """Attachment included with an outbound message."""

    name: Optional[str] = Field(default=None, description="Attachment filename or label.")
    url: Optional[str] = Field(default=None, description="Attachment URL or preview URL when visible.")
    description: Optional[str] = Field(default=None, description="Short visible attachment description.")


class WriteLockMessageDetails(BaseModel):
    """Outbound message details."""

    to: List[str] = Field(default_factory=list, description="Visible recipients.")
    cc: List[str] = Field(default_factory=list, description="Visible CC recipients.")
    bcc: List[str] = Field(default_factory=list, description="Visible BCC recipients.")
    subject: Optional[str] = Field(default=None, description="Visible subject line.")
    body: Optional[str] = Field(default=None, description="Visible message body.")
    attachments: List[WriteLockMessageAttachment] = Field(
        default_factory=list,
        description="Visible outbound attachments.",
    )


class WriteLockSocialPostAttachment(BaseModel):
    """Attachment included with a social post."""

    url: Optional[str] = Field(default=None, description="Attachment or preview URL when visible.")
    description: Optional[str] = Field(default=None, description="Short visible attachment description.")


class WriteLockSocialPostDetails(BaseModel):
    """Social post details."""

    destination: Optional[str] = Field(
        default=None,
        description="Visible destination, such as profile, subreddit, or channel.",
    )
    audience: Optional[str] = Field(default=None, description="Visible audience, such as Public or followers.")
    body: Optional[str] = Field(default=None, description="Visible post body.")
    attachments: List[WriteLockSocialPostAttachment] = Field(
        default_factory=list,
        description="Visible post attachments.",
    )


class WriteLockPaymentDetails(BaseModel):
    """Payment entry details without secrets."""

    merchant: Optional[str] = Field(default=None, description="Visible merchant or payee.")
    amount: Optional[str] = Field(default=None, description="Visible payment amount.")
    purpose: Optional[str] = Field(default=None, description="Visible reason for payment.")
    fields: List[str] = Field(
        default_factory=list,
        description=(
            "Payment fields being entered, such as card number, expiration date, CVV, "
            "or billing ZIP. Never include actual secrets."
        ),
    )


class WriteLockGenericOperationDetails(BaseModel):
    """Fallback write operation details."""

    label: str = Field(description="Human-level operation label.")
    target: Optional[str] = Field(default=None, description="Visible target of the operation.")
    payload_summary: Optional[str] = Field(
        default=None,
        description="Concise summary of the data or setting being changed.",
    )


class GenerateWriteLockNotificationTool(BaseModel):
    """Internal approval-metadata tool.

    Never call this tool during normal task execution. Only call it when the
    latest user message contains WRITE_LOCK_NOTIFICATION_FORK_REQUEST. Describe
    the real-world action the user is approving, not the clicked button or DOM
    mechanic that triggered the write lock. Do not execute, approve, reject,
    browse, or continue the task.
    """

    tool: Literal["generate_write_lock_notification"]
    trigger_type: Literal["purchase", "payment", "message", "social_post", "generic_write"] = Field(
        description="Category of write lock that triggered approval."
    )
    action: str = Field(
        description="User-level action, such as 'buy items', 'send email', 'post publicly', or 'enter payment details'."
    )
    service: WriteLockService = Field(description="Website or service where the action would happen.")
    media: List[WriteLockMedia] = Field(
        default_factory=list,
        description=(
            "Media for the renderer. For purchase approvals, provide exactly one image whenever any "
            "product, checkout, or page image is visible. For multiple purchase items, this should be "
            "a single rendered_summary image stitched from the item photos when available."
        ),
    )
    purchase: Optional[WriteLockPurchaseDetails] = Field(
        default=None,
        description="Required when trigger_type is purchase; otherwise null.",
    )
    payment: Optional[WriteLockPaymentDetails] = Field(
        default=None,
        description="Required when trigger_type is payment; otherwise null. Never include secrets.",
    )
    message: Optional[WriteLockMessageDetails] = Field(
        default=None,
        description="Required when trigger_type is message; otherwise null.",
    )
    social_post: Optional[WriteLockSocialPostDetails] = Field(
        default=None,
        description="Required when trigger_type is social_post; otherwise null.",
    )
    generic_write: Optional[WriteLockGenericOperationDetails] = Field(
        default=None,
        description="Required when trigger_type is generic_write; otherwise null.",
    )

    @model_validator(mode="after")
    def require_trigger_details(self, info: ValidationInfo) -> "GenerateWriteLockNotificationTool":
        if getattr(self, self.trigger_type) is None:
            raise ValueError(f"{self.trigger_type} details are required for a {self.trigger_type} approval")
        if self.trigger_type == "purchase" and self.purchase is not None:
            trusted_page_urls = (info.context or {}).get("trusted_page_urls")
            for item in self.purchase.items:
                if trusted_page_urls:
                    validate_product_url_for_pages(item.product_url, trusted_page_urls)
                else:
                    validate_product_url_for_page(item.product_url, self.service.url)
        return self


# ============================================================================
# Tool Registry (Index-Based)
# ============================================================================


# Map browser tool names to their Pydantic models
# Uses browser-use action model naming conventions
BROWSER_TOOL_MODELS = {
    "phone": PhoneBrowserTool,
    # Observation
    "read_browser_state": ReadBrowserStateTool,
    "screenshot": ScreenshotTool,
    "read_logs": ReadLogsBrowserTool,
    "read_network_requests": ReadNetworkRequestsBrowserTool,
    # Index-based actions
    "click": ClickTool,
    "input_text": InputTextTool,
    "press_key": PressKeyTool,
    # Coordinate-based fallback (for vision models)
    "click_coordinates": ClickAtCoordinatesTool,
    "drag": DragTool,
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
    "request_user_assistance_for_authentication": RequestUserAssistanceForAuthenticationBrowserTool,
    "recover_from_challenge": RecoverFromChallengeBrowserTool,
    "request_payment_card": RequestPaymentCardBrowserTool,
    # Internal write-lock approval metadata. Kept in the stable tool surface
    # so a forked request can append only a user message and preserve cache reads.
    "generate_write_lock_notification": GenerateWriteLockNotificationTool,
}


class BrowserToolArgsValidationError(ValueError):
    """The model produced browser tool-call arguments that fail schema validation.

    This is a MODEL-OUTPUT error, not a Rose transport/infra failure: the model chose
    a real tool but supplied arguments the tool's schema rejects (e.g. a checkout URL
    where a product-detail URL is required). It must be fed back to the model as a
    normal tool-result observation so it can self-correct, exactly like an execution
    error — never swallowed, hidden from the trajectory, or counted toward the
    consecutive-API-failure abort budget.

    Subclasses ``ValueError`` (as pydantic's own ``ValidationError`` does) so existing
    ``except ValueError`` callers keep catching invalid tool args; the browser loop
    still routes it via its earlier, more specific ``except`` clause.
    """

    def __init__(self, tool_name: str, tool_args: Dict[str, Any], validation_error: ValidationError):
        self.tool_name = tool_name
        self.tool_args = tool_args
        self.validation_error = validation_error
        self.thinking: Optional[str] = None
        self.detail = _format_tool_validation_detail(validation_error)
        super().__init__(f"{tool_name} arguments rejected: {self.detail}")


def _format_tool_validation_detail(error: ValidationError) -> str:
    """Render a Pydantic ValidationError as concise, model-readable feedback lines."""
    lines: List[str] = []
    for err in error.errors():
        loc = ".".join(str(part) for part in err.get("loc", ()) if part != "tool")
        message = err.get("msg", "invalid value")
        lines.append(f"- {loc}: {message}" if loc else f"- {message}")
    return "\n".join(lines) if lines else str(error)


def validate_browser_tool_args(
    tool_name: str,
    tool_args: Dict[str, Any],
    *,
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Validate and normalize one browser tool call through its Pydantic model.

    This mirrors the main-agent boundary: model output is parsed into the
    registered tool model and execution receives ``model_dump()`` rather than
    the original untyped dictionary.

    A schema rejection is raised as :class:`BrowserToolArgsValidationError` (a
    model-output error the loop feeds back to the model), never as a bare
    ``ValidationError`` that the loop's infra-failure handler would swallow.
    """
    model = BROWSER_TOOL_MODELS.get(tool_name)
    if model is None:
        raise ValueError(f"Unknown browser tool: {tool_name}")
    try:
        parsed = model.model_validate(
            {"tool": tool_name, **tool_args},
            context=context,
        )
    except ValidationError as exc:
        raise BrowserToolArgsValidationError(tool_name, tool_args, exc) from exc
    return parsed.model_dump(exclude={"tool"}, exclude_none=True)


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
    "DragTool",
    # Dropdown
    "DropdownOptionsTool",
    "SelectDropdownTool",
    # JavaScript
    "EvaluateTool",
    "EVALUATE_TIMEOUT_SECONDS_DEFAULT",
    "EVALUATE_TIMEOUT_SECONDS_MAX",
    "normalize_evaluate_timeout_seconds",
    "normalize_browser_wait_ms",
    "MAX_BROWSER_WAIT_MS",
    # Navigation
    "GotoTool",
    "NavbackTool",
    "ScrollTool",
    "WaitTool",
    "validate_browser_tool_args",
    "BrowserToolArgsValidationError",
    # Tab management
    "SwitchTabTool",
    "CloseTabTool",
    "OpenNewTabTool",
    # File upload
    "UploadFileTool",
    # Completion
    "DoneTool",
    "AttemptCompletionBrowserTool",
    "RequestUserAssistanceForAuthenticationBrowserTool",
    "RequestPaymentCardBrowserTool",
    "WriteLockService",
    "WriteLockMedia",
    "WriteLockPurchaseItem",
    "WriteLockPurchaseTotals",
    "WriteLockPurchaseDetails",
    "WriteLockMessageAttachment",
    "WriteLockMessageDetails",
    "WriteLockSocialPostAttachment",
    "WriteLockSocialPostDetails",
    "WriteLockPaymentDetails",
    "WriteLockGenericOperationDetails",
    "GenerateWriteLockNotificationTool",
    # Registry & Factory
    "BROWSER_TOOL_MODELS",
    "AVAILABLE_ACTIONS",
    "create_browser_agent_action_model",
]
