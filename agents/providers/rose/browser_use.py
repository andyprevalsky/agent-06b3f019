"""Browser-use sub-flow - message build + tool-call extraction.

Browser-use rides the same claudeAuth -> waterfall machinery as rose-1-flash
and rose-1-ultra (see `pools.py:rose-1-browser-use`). What's specific:

  - The user message bundles a full browser snapshot (URL, viewport,
    DOM tree, action history, optional screenshot).
  - Available browser actions are passed as provider tools generated from the
    Pydantic models in `BROWSER_TOOL_MODELS`, then the first native tool call
    is validated and normalized into the `UnifiedAction` shape the browser
    handler expects.
  - Legacy JSON text replies are still normalized defensively for old dumps
    and mocked streams.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from providers.rose.schema import build_anthropic_tools_from_response_model
from tools.prompts import attempt_completion_prompt
from utils.browser_auth_contract import CHALLENGE_RECOVERY_SCOPE, build_authentication_contract

# Single source of truth for verifier rules. The browser prompt embeds the
# same grading block as the main agent so attempt_completion semantics do not
# drift between agent types.
from utils.prompts import VERIFICATION_RULES

logger = structlog.get_logger()



def recover_from_challenge_enabled() -> bool:
    """Temp kill-switch for challenge recovery (bench A/B).

    Set ``BROWSER_DISABLE_RECOVER_FROM_CHALLENGE=1`` to hide and refuse the tool
    so the browser agent must navigate around blockers like the manual CDP path.
    """
    raw = (os.environ.get("BROWSER_DISABLE_RECOVER_FROM_CHALLENGE") or "").strip().lower()
    return raw not in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Rich tool-description metadata retained under the historical public name.
# Argument schemas are not read from ``params`` below: provider schemas and
# runtime validation both come from browser_tools.schemas.BROWSER_TOOL_MODELS.
# The legacy params remain temporarily for callers that inspect this catalog.
# ---------------------------------------------------------------------------

BROWSER_USE_TOOLS: Dict[str, Dict[str, Any]] = {
    "phone": {"description": "Use the dedicated cloud iPhone through Rose. mode=operation ensures/reuses a lease, status observes without allocating, release relinquishes it. mode=setup records defer/block or requests backend verification using actual observation IDs. Setup uses the current task; honor its user constraints. Observe screen.text, act once, verify. UNKNOWN input must never be replayed. Private password refs require verified app/account binding."},
    "read_browser_state": {
        "description": (
            "Read the current browser page state (URL, viewport, scroll, tabs, page stats, indexed DOM tree). "
            "Call before interacting when you need element [index] values or after navigation/actions that may "
            "have changed the page. Example output begins with '# Current Browser State' and includes lines like "
            "'Current URL: https://example.com/checkout - Checkout' and 'Interactive elements:' followed by "
            "'[7]<button>Pay now</button>'."
        ),
        "params": {},
    },
    "goto": {
        "description": "Navigate to a URL",
        "params": {"url": {"type": "string", "description": "URL to navigate to", "required": True}},
    },
    "navback": {"description": "Go back to the previous page in browser history", "params": {}},
    "wait": {
        "description": "Wait for a bounded number of milliseconds; use sparingly.",
        "params": {"time_ms": {"type": "integer", "description": "Milliseconds to wait (maximum 60000)"}},
    },
    "click": {
        "description": "Click element by index",
        "params": {"index": {"type": "integer", "description": "Element index from browser_state", "required": True}},
    },
    "click_coordinates": {
        "description": (
            "Fallback only: click at specific coordinates when the target has no numeric DOM index. "
            "Do not use when the current browser state lists a relevant [index]."
        ),
        "params": {
            "x": {"type": "integer", "description": "X coordinate", "required": True},
            "y": {"type": "integer", "description": "Y coordinate", "required": True},
        },
    },
    "drag": {
        "description": (
            "Drag from a start point to an end point with a real mouse press → move → release "
            "(CDP Input.dispatchMouseEvent, same path browser-use uses for Element.drag_to). "
            "Use for sliders, CAPTCHA / 'Bot or Not' slide-to-verify widgets, scrubbers, and "
            "drag-and-drop. Prefer source_index/target_index when those nodes are indexed; "
            "otherwise use start_x/start_y and end_x/end_y from the screenshot viewport."
        ),
        "params": {
            "source_index": {
                "type": "integer",
                "description": "DOM index of the drag start element",
            },
            "target_index": {
                "type": "integer",
                "description": "DOM index of the drag end / drop target",
            },
            "start_x": {"type": "integer", "description": "Viewport X of drag start"},
            "start_y": {"type": "integer", "description": "Viewport Y of drag start"},
            "end_x": {"type": "integer", "description": "Viewport X of drag end"},
            "end_y": {"type": "integer", "description": "Viewport Y of drag end"},
            "steps": {
                "type": "integer",
                "description": "Intermediate move samples while held (default 24)",
            },
        },
    },
    "input_text": {
        "description": "Input text into element by index",
        "params": {
            "index": {"type": "integer", "description": "Element index from browser_state", "required": True},
            "text": {"type": "string", "description": "Text to input", "required": True},
            "clear": {"type": "boolean", "description": "Clear field before typing (default: true)"},
        },
    },
    "press_key": {
        "description": "Send keyboard keys or shortcuts",
        "params": {
            "keys": {
                "type": "string",
                "description": "Keys (Escape, Enter, PageDown) or shortcuts (Control+o)",
                "required": True,
            },
        },
    },
    "scroll": {
        "description": (
            "Scroll up or down by a pixel amount. Use index for a specific scroll container. "
            "About 600 pixels is roughly one page; deeply long pages may require multiple calls."
        ),
        "params": {
            "direction": {
                "type": "string",
                "description": "Direction to scroll: up or down",
                "required": True,
            },
            "amount": {
                "type": "integer",
                "description": "Number of pixels to scroll (default: 300)",
            },
            "index": {
                "type": "integer",
                "description": "Optional scroll-container index from browser_state; omit or use 0 for viewport scroll",
            },
        },
    },
    "find_text": {
        "description": "Scroll to specific text on the page",
        "params": {"text": {"type": "string", "description": "Text to find and scroll to", "required": True}},
    },
    "dropdown_options": {
        "description": "Get all options from a native dropdown or ARIA menu",
        "params": {"index": {"type": "integer", "description": "Element index of the dropdown", "required": True}},
    },
    "select_dropdown": {
        "description": (
            "Set the option of a NATIVE HTML <select> element only. Does NOT work for ARIA/custom dropdowns "
            "(role=listbox, combobox, or any non-native widget). For custom dropdowns, click to open and "
            "click the desired option, or use `evaluate` to drive the underlying state."
        ),
        "params": {
            "index": {"type": "integer", "description": "Element index of the native <select>", "required": True},
            "text": {"type": "string", "description": "Exact text of the <option> to select", "required": True},
        },
    },
    "evaluate": {
        "description": (
            "Execute JavaScript in the live browser page context. Use for ACTIONS or LIVE DOM STATE QUERIES "
            "that page markdown cannot answer: hover, drag, custom selectors, shadow DOM traversal, reading "
            "computed styles, dispatching events, querying iframe contents, or reading visible product/cart "
            "facts before navigating away. Wrap in IIFE with try-catch. Prefer evaluate over inventing "
            "page content."
        ),
        "params": {"code": {"type": "string", "description": "JavaScript code to execute", "required": True}},
    },
    "switch_tab": {
        "description": "Switch to another open tab by tab_id (last 4 chars of target_id shown in browser state)",
        "params": {"tab_id": {"type": "string", "description": "4-char tab ID", "required": True}},
    },
    "close_tab": {
        "description": "Close a tab by tab_id. Closes current tab if omitted.",
        "params": {"tab_id": {"type": "string", "description": "4-char tab ID (optional, closes current if omitted)"}},
    },
    "open_new_tab": {
        "description": "Open a new browser tab, optionally navigating to a URL",
        "params": {"url": {"type": "string", "description": "URL to open in new tab (defaults to about:blank)"}},
    },
    "upload_file": {
        "description": (
            "Upload a file to a file input element. The file must be available in the session's available_files "
            "list. Find an <input type='file'> element in the DOM tree and pass its index along with the filename."
        ),
        "params": {
            "index": {"type": "integer", "description": "Element index of the <input type='file'>", "required": True},
            "filename": {
                "type": "string",
                "description": "Filename to upload (must match available_files)",
                "required": True,
            },
        },
    },
    "attempt_completion": {
        "description": attempt_completion_prompt.strip(),
        "params": {},
    },
    "request_user_assistance_for_authentication": {
        "description": (
            "Waterfall step 8: request user help signing in only after steps 1-7 are exhausted or unavailable. "
            "Before calling, you must have tried every saved password, email OTP if available, SMS OTP if "
            "available, the minted agent account when it has an email, and guest/anonymous completion when the "
            "page offers it (for example Continue as guest, Checkout as guest, or I'll reserve). Cookie and "
            "Steel-session auth are applied automatically before you start. "
            "Before calling, leave the auth step you are blocked on open and visible, so the user can "
            "complete it without navigating. "
            "Never use this for CAPTCHA, bot challenges, 'Bot or Not' walls, access-denied interstitials, or "
            "unusual-traffic pages - those are not authentication blockers. Use recover_from_challenge for "
            "those instead of trying to solve them yourself. "
            f"{CHALLENGE_RECOVERY_SCOPE}"
        ),
        "params": {},
    },
    "recover_from_challenge": {
        "description": (
            f"{CHALLENGE_RECOVERY_SCOPE} "
            "Relatively expensive recovery to forcefully open a page or service blocked by a CAPTCHA, bot "
            "challenge, access-denied interstitial, unusual-traffic page, or repeated 429. Do not use when "
            "an alternate path can complete the goal without clearing this blocker. Do not drag sliders, "
            "click verify buttons, or otherwise try to solve the widget yourself. Never use for bad "
            "credentials, a 404, out-of-stock, form validation, or an ordinary load failure. When invoked, "
            "the tool waits for Kernel or Steel's native automatic CAPTCHA solver, then tests isolated "
            "copies of browser state: known challenge cookies, all target-site cookies, then parallel "
            "cookie-group reductions. Set auth_cookies_are_preserved=true when the current session is logged "
            "in and the replacement machine must keep that authenticated state. Set "
            "auth_cookies_are_preserved=false to explore machines with a fresh cookie state (may lose auth, "
            "but can clear a poisoned cookie that forces anti-bot on every session). If no safe cookie fix "
            "is proven, it searches permission-compatible Kernel residential, Kernel mobile, Kernel ISP, "
            "and Steel managed/fixed-IP browsers in parallel, selects a configuration that passes repeated "
            "stability probes, and caches that configuration as this user's default for future browser "
            "sessions. Provider CAPTCHA solving remains enabled throughout. Successful recovery returns to "
            "the current URL with cookies, localStorage, and IndexedDB preserved."
        ),
        "params": {
            "reason": {
                "type": "string",
                "description": (
                    "One line of concrete evidence that this page or service must be force-opened and no "
                    "alternate goal path exists (e.g. 'Bot or Not interstitial blocks only path to search', "
                    "'captcha wall blocks checkout with no other route', 'repeated 429s on required API')."
                ),
                "required": True,
            },
            "auth_cookies_are_preserved": {
                "type": "boolean",
                "description": (
                    "True when the current browser session is logged in and the new machine must "
                    "maintain the current authenticated state to pass the goal/task. False when you "
                    "want to explore machines that have a fresh cookie state (and thus potentially "
                    "lose auth status, but potentially fix a bad cookie which is poisoning every "
                    "session with a forced anti-bot). Defaults to true."
                ),
                "required": False,
            },
        },
    },
    "request_payment_card": {
        "description": (
            "Request a one-time virtual payment card for the current checkout only if checkout requires you to "
            "enter new card details. If a valid saved payment method is already selected and no card entry is "
            "required, do not call this tool; continue with that saved method. Before typing any new card details, "
            "first read the full itemized receipt off "
            "the page and visit each product page as needed. Every item MUST include its canonical product-detail "
            "URL (never the cart or checkout URL), numeric rating, and numeric review count, plus its name, image "
            "URL if visible, unit price in cents, quantity, and line total in cents. Include every fee, the "
            "subtotal, and the final total. After the user approves, the card is "
            "minted on demand and the one-time card refs are returned for you to type into the payment fields. "
            "Never ask the user to enter a card and never type stored card details."
        ),
        "params": {
            "merchant": {
                "type": "string",
                "description": "Merchant or site name for the purchase",
                "required": True,
            },
            "currency": {"type": "string", "description": "Purchase currency (currently only USD)"},
            "line_items": {
                "type": "array",
                "description": (
                    "Full itemized receipt. Reviews and canonical product links are required for every item."
                ),
                "required": True,
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": (
                                "Item name shown on the checkout page. When the purchase is tied to a "
                                "specific date, such as an event or movie ticket, a reservation, a flight, "
                                "a hotel night, an appointment, or a delivery window, include that date "
                                "(and the time when the booking is time-specific) in this name, for "
                                "example 'Spider-Man: Brand New Day - Fri Jul 31, 2026, 7:15pm, Seat A7'. "
                                "A person approving the charge must be able to see which day they are "
                                "paying for without opening the merchant page."
                            ),
                        },
                        "image_url": {"type": "string", "description": "Product image URL, when visible"},
                        "product_url": {
                            "type": "string",
                            "description": (
                                "Canonical product-detail URL. Never use a cart, basket, checkout, payment, "
                                "or order-confirmation URL."
                            ),
                        },
                        "rating": {
                            "type": "string",
                            "description": (
                                "Numeric rating shown on the product page, such as '4.8 stars'. "
                                "If the page genuinely shows no rating (e.g. a service, ticket, or "
                                "event booking), pass '0 stars', never 'N/A', 'none', 'unknown', or a "
                                "made-up number."
                            ),
                        },
                        "review_count": {
                            "type": "string",
                            "description": (
                                "Numeric review count shown on the product page, such as '312 reviews'. "
                                "If the page genuinely shows no reviews (e.g. a service, ticket, or "
                                "event booking), pass '0 reviews', never 'N/A', 'none', 'unknown', or a "
                                "made-up number."
                            ),
                        },
                        "unit_price_cents": {"type": "integer", "description": "Unit price in cents"},
                        "quantity": {"type": "integer", "description": "Quantity"},
                        "line_total_cents": {"type": "integer", "description": "Line total in cents"},
                    },
                    "required": [
                        "name",
                        "product_url",
                        "rating",
                        "review_count",
                        "unit_price_cents",
                        "quantity",
                        "line_total_cents",
                    ],
                    "additionalProperties": False,
                },
            },
            "fees": {
                "type": "array",
                "description": "Taxes, shipping, service fees, discounts, etc. One object each: {label, amount_cents}.",
            },
            "subtotal_cents": {"type": "integer", "description": "Subtotal before fees, in cents", "required": True},
            "total_cents": {"type": "integer", "description": "Final checkout total, in cents", "required": True},
        },
    },
    "generate_write_lock_notification": {
        "description": (
            "Internal approval-metadata tool. Never call this tool during normal task execution. "
            "Only call it when the latest user message contains WRITE_LOCK_NOTIFICATION_FORK_REQUEST. "
            "When called, describe the real-world action the user is approving, not the clicked button "
            "or DOM mechanic that triggered the write lock. Do not execute, approve, reject, browse, "
            "or continue the task."
        ),
        "anyOf": [
            {"properties": {"trigger_type": {"enum": ["purchase"]}}, "required": ["purchase"]},
            {"properties": {"trigger_type": {"enum": ["payment"]}}, "required": ["payment"]},
            {"properties": {"trigger_type": {"enum": ["message"]}}, "required": ["message"]},
            {"properties": {"trigger_type": {"enum": ["social_post"]}}, "required": ["social_post"]},
            {"properties": {"trigger_type": {"enum": ["generic_write"]}}, "required": ["generic_write"]},
        ],
        "params": {
            "trigger_type": {
                "type": "string",
                "description": "One of: purchase, payment, message, social_post, generic_write",
                "required": True,
            },
            "action": {
                "type": "string",
                "description": "User-level action, such as buy items, send email, or enter payment details",
                "required": True,
            },
            "service": {
                "type": "object",
                "description": "Service metadata: name, domain, and current URL",
                "required": True,
            },
            "media": {
                "type": "array",
                "description": (
                    "Renderer media. For purchase approvals, provide exactly one image whenever any product, "
                    "checkout, or page image is visible; use a stitched/rendered summary if multiple items are involved."
                ),
            },
            "purchase": {
                "type": "object",
                "description": (
                    "Required when trigger_type is purchase. Every item MUST include a real numeric rating, "
                    "numeric review count, and canonical product-detail URL. Never use the current cart or checkout URL."
                ),
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {
                                    "type": "string",
                                    "description": (
                                        "Visible item title. When the purchase is tied to a specific date, such as an "
                                        "event or movie ticket, a reservation, a flight, a hotel night, an "
                                        "appointment, or a delivery window, include that date, and the time when "
                                        "the booking is time-specific, in the title or the description, for "
                                        "example 'Spider-Man: Brand New Day - Fri Jul 31, 2026, 7:15pm'. "
                                        "Someone approving the charge must be able to see which day they are "
                                        "paying for without opening the merchant page."
                                    ),
                                },
                                "price": {"type": "string", "description": "Visible item price"},
                                "quantity": {"type": "string", "description": "Visible quantity"},
                                "description": {
                                    "type": "string",
                                    "description": (
                                        "Visible variant details, including the booked date and time for any "
                                        "date-specific purchase when they are not already in the title."
                                    ),
                                },
                                "rating": {"type": "string", "description": "Required numeric rating"},
                                "review_count": {
                                    "type": "string",
                                    "description": (
                                        "Required numeric review count followed by 'reviews' or 'ratings', "
                                        "for example '312 reviews'"
                                    ),
                                },
                                "image_url": {"type": "string", "description": "Best visible product image URL"},
                                "product_url": {
                                    "type": "string",
                                    "description": "Required canonical product-detail URL; never cart or checkout",
                                },
                                "seller": {"type": "string", "description": "Visible seller"},
                                "shipping": {"type": "string", "description": "Visible delivery details"},
                            },
                            "required": ["title", "rating", "review_count", "product_url"],
                            "additionalProperties": False,
                        },
                    },
                    "totals": {"type": "object", "description": "Visible subtotal, shipping, tax, and total"},
                    "payment_method": {"type": "string", "description": "Visible redacted payment method"},
                    "delivery_address": {"type": "string", "description": "Visible delivery address"},
                },
                "required": ["items"],
            },
            "payment": {"type": "object", "description": "Payment details when trigger_type is payment"},
            "message": {"type": "object", "description": "Outbound message details when trigger_type is message"},
            "social_post": {"type": "object", "description": "Social post details when trigger_type is social_post"},
            "generic_write": {
                "type": "object",
                "description": "Generic write details when trigger_type is generic_write",
            },
        },
    },
    "screenshot": {
        "description": (
            "Take a screenshot of the visible page viewport. Coordinates in this image match click_coordinates. "
            "The screenshot is saved and returned to the orchestrating agent. "
            "Use this for visual confirmation of the current visible page state. "
            "IMPORTANT: if you are attempting to interact with the DOM but progress is not being made "
            "(repeated clicks/waits with no state change), take a screenshot to view components that may be "
            "hidden from the DOM, e.g. a CAPTCHA, Cloudflare 'verify you are human' challenge, or other "
            "content rendered inside a cross-origin iframe that the DOM tree cannot see. "
            f"{CHALLENGE_RECOVERY_SCOPE} "
            "For CAPTCHA / bot-challenge / 'Bot or Not' pages, the DOM is often a misleading shell "
            "(#app-captcha-pwa with only div/a/span indexes) while the real widget is visual-only. "
            "Use a screenshot only if you need to confirm the challenge type. Do not drag sliders, click "
            "verify buttons, or otherwise try to solve the widget yourself."
        ),
        "params": {},
    },
    "read_logs": {
        "description": (
            "Read merged browser logs from console errors/warnings AND network traffic "
            "(like DevTools Console + Network together). Use this to detect soft-blocks "
            "(403, 429, Cloudflare, Apollo GraphQL errors), discover which API a page "
            "called, or debug a failed form submission.\n"
            "Each row is newest-first with {source, level, text, url, status, ...}. "
            "Console rows include JavaScript exceptions and 'Failed to load resource' lines. "
            "Network rows include HTTP method, URL, status code, and resource type.\n"
            "Pass 'pattern' with any regex to filter lines (e.g. '429', "
            "'ApolloError|graphql', 'botOrNot'). Omit pattern to return recent logs.\n"
            "Optional filters: 'sources' (['console','network']), 'level' (console only), "
            "'status'/'url_pattern'/'method' (network only), 'limit' (default 100).\n"
            "Set 'include_bodies'/'include_headers'/'include_query' when you need full "
            "network payloads. Use 'clear' to isolate traffic caused by your next action.\n"
            "Prefer this over screenshots when the DOM is ambiguous but the failure is "
            "likely HTTP/rate-limit/bot-detection related."
        ),
        "params": {
            "pattern": {
                "type": "string",
                "description": "Optional regex filter applied to each log line.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of log lines to return (default 100).",
            },
            "clear": {
                "type": "boolean",
                "description": "When true, clear captured logs after reading.",
            },
            "sources": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional subset: 'console', 'network'. Default both.",
            },
            "level": {
                "type": "string",
                "description": "Optional console level filter (error, warning, log, ...).",
            },
            "status": {
                "type": "string",
                "description": "Optional network status filter: '403', '4xx', 'error', or 'ok'.",
            },
            "url_pattern": {
                "type": "string",
                "description": "Optional substring filter for network URLs.",
            },
            "method": {
                "type": "string",
                "description": "Optional HTTP method filter for network rows.",
            },
            "resource_type": {
                "type": "string",
                "description": "Optional network resource-type filter.",
            },
            "include_query": {
                "type": "boolean",
                "description": "When true, return full network URLs including query strings.",
            },
            "include_headers": {
                "type": "boolean",
                "description": "When true, include network headers (credentials masked).",
            },
            "include_bodies": {
                "type": "boolean",
                "description": "When true, include captured network bodies.",
            },
            "max_body_chars": {
                "type": "integer",
                "description": "Per-body character cap when include_bodies is set.",
            },
        },
    },
    "read_network_requests": {
        "description": (
            "Inspect the page's network traffic, like the DevTools Network panel. Every http(s) "
            "request the page makes is captured (XHR, Fetch, documents, scripts, cross-origin), "
            "along with its headers, redirect chain, timing, and response body when the body is "
            "text (JSON/HTML/text/XML).\n"
            "Use it to (a) detect a blocked or challenge response (403, 429, Cloudflare 'verify you "
            "are human') by status code when the DOM/screenshot is ambiguous, (b) discover the API "
            "a page calls and read its JSON directly instead of scraping the rendered UI, or "
            "(c) debug a form submission by reading what was actually POSTed and what came back.\n"
            "Returns newest-first rows of {id, url, method, status, resource_type, mime_type, "
            "duration_ms, size_bytes, body_available}. A row with body_available=true has a "
            "response body waiting - ask for it.\n"
            "Filters: 'url_pattern' (URL substring, e.g. '/api/'), 'method' (e.g. 'POST'), 'status' "
            "('403', '4xx', 'error', 'ok'), 'resource_type' ('XHR', 'Fetch', 'Document', ...), "
            "'limit' (default 100).\n"
            "Detail flags (off by default to keep listings small - turn them on once you have "
            "narrowed with url_pattern): 'include_bodies' returns the request post data and the "
            "response body (capped by 'max_body_chars', default 4000); 'include_headers' returns "
            "request/response headers with cookie and authorization values masked; 'include_query' "
            "returns full URLs including query strings instead of scheme://host/path.\n"
            "'clear' empties the buffer after reading, so the next call shows only traffic caused by "
            "what you did in between - the reliable way to isolate the request behind one click.\n"
            "To replay an authenticated request yourself, use `evaluate` with fetch(): the session "
            "cookies ride along automatically, which is why they are masked here."
        ),
        "params": {
            "url_pattern": {
                "type": "string",
                "description": "Optional substring to filter request URLs (e.g. '/api/', 'checkout').",
            },
            "method": {
                "type": "string",
                "description": "Optional HTTP method filter (e.g. 'POST').",
            },
            "status": {
                "type": "string",
                "description": "Optional status filter: '403', '4xx', 'error' (>=400 or failed), or 'ok'.",
            },
            "resource_type": {
                "type": "string",
                "description": "Optional resource-type filter (e.g. 'XHR', 'Fetch', 'Document', 'Script').",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of requests to return (default 100).",
            },
            "clear": {
                "type": "boolean",
                "description": "When true, clear the captured buffer after reading.",
            },
            "include_query": {
                "type": "boolean",
                "description": "When true, return full URLs including query strings.",
            },
            "include_headers": {
                "type": "boolean",
                "description": "When true, include request/response headers (cookie/authorization masked).",
            },
            "include_bodies": {
                "type": "boolean",
                "description": "When true, include request post data and captured response bodies.",
            },
            "max_body_chars": {
                "type": "integer",
                "description": "Per-body character cap when include_bodies is set (default 4000).",
            },
        },
    },
}


_INDEXED_DOM_TARGET_RE = re.compile(r"(?m)\[\d+\]<")


def state_has_indexed_dom_targets(browser_state: Dict[str, Any]) -> bool:
    """Return True when the browser snapshot exposes numeric DOM targets."""
    dom_tree = browser_state.get("dom_tree")
    if not isinstance(dom_tree, str) or not dom_tree:
        return False
    return bool(_INDEXED_DOM_TARGET_RE.search(dom_tree))


def filter_browser_use_actions_for_state(
    available_actions: List[str],
    browser_state: Dict[str, Any],
) -> List[str]:
    """Return the caller allowlist unchanged.

    Previously this stripped `click_coordinates` whenever the DOM tree exposed
    any `[index]` node, on the theory that pixels would loop on indexed pages.
    That broke captcha / Bot-or-Not shells: they index empty `#app-captcha-pwa`
    wrappers while the real slider has no index, so the only solve path was
    removed and the model recovered with "no interactive solve control". Prefer
    indexed click via tool description; never hide the coordinate tool.
    """
    _ = browser_state
    return list(available_actions)


def generate_tool_descriptions(available_actions: List[str]) -> str:
    """Produce the system-prompt action list filtered by `available_actions`."""
    descriptions: List[str] = []
    for tool in build_browser_use_tools(available_actions):
        action_name = tool["name"]
        param_parts: List[str] = []
        for param_name, info in tool["input_schema"]["properties"].items():
            param_type = info.get("type", "value")
            part = f"{param_name}={param_type}"
            desc = info.get("description")
            if desc:
                part += f" ({desc})"
            param_parts.append(part)
        params_str = f" ({', '.join(param_parts)})" if param_parts else ""
        descriptions.append(f"- {action_name}: {tool['description']}{params_str}")
    return "\n".join(descriptions)


def _collapse_nullable_schema(value: Any) -> Any:
    """Remove Pydantic's null unions from optional provider-tool fields.

    Optional tool arguments are represented by omission. Sending
    ``anyOf: [T, null]`` needlessly enlarges provider grammars and historically
    broke the write-lock schema. Runtime Pydantic validation remains the
    authoritative semantic boundary.
    """
    if isinstance(value, list):
        return [_collapse_nullable_schema(item) for item in value]
    if not isinstance(value, dict):
        return value

    transformed = {key: _collapse_nullable_schema(item) for key, item in value.items()}
    any_of = transformed.get("anyOf")
    if isinstance(any_of, list):
        non_null = [item for item in any_of if not (isinstance(item, dict) and item.get("type") == "null")]
        if len(non_null) == 1 and len(non_null) != len(any_of):
            replacement = dict(non_null[0])
            for key, item in transformed.items():
                if key not in {"anyOf", "default"}:
                    replacement.setdefault(key, item)
            return replacement
    return transformed


def build_browser_use_tools(available_actions: List[str]) -> List[Dict[str, Any]]:
    """Build provider tools from the same Pydantic models used at runtime."""
    # Lazy import avoids providers.rose -> browser_tools.__init__ -> helpers ->
    # providers.rose during worker startup.
    from browser_tools.schemas import BROWSER_TOOL_MODELS, create_browser_agent_action_model

    if not recover_from_challenge_enabled():
        available_actions = [name for name in available_actions if name != "recover_from_challenge"]

    known_actions = [name for name in available_actions if name in BROWSER_TOOL_MODELS]
    if not known_actions:
        return []

    action_model = create_browser_agent_action_model(known_actions)
    generated = build_anthropic_tools_from_response_model(action_model) or []
    by_name = {tool["name"]: tool for tool in generated}

    tools: List[Dict[str, Any]] = []
    for action_name in known_actions:
        generated_tool = by_name[action_name]
        prompt_metadata = BROWSER_USE_TOOLS.get(action_name) or {}
        description = prompt_metadata.get("description") or generated_tool["description"]
        if action_name == "request_user_assistance_for_authentication" and not recover_from_challenge_enabled():
            description = (
                "Waterfall step 8: request user help signing in only after steps 1-7 are "
                "exhausted or unavailable. Before calling, you must have tried every saved "
                "password, email OTP if available, SMS OTP if available, the minted agent "
                "account when it has an email, and guest/anonymous completion when the page "
                "offers it (for example Continue as guest, Checkout as guest, or I'll reserve). "
                "Cookie and Steel-session auth are applied automatically before you start. "
                "Before calling, leave the auth step you are blocked on open and visible, so the user "
                "can complete it without navigating. "
                "Never use this for CAPTCHA, bot challenges, 'Bot or Not' walls, "
                "access-denied interstitials, or unusual-traffic pages - those are not "
                "authentication blockers. Wait briefly or try an alternate URL/path instead "
                "of trying to solve them yourself. "
                f"{CHALLENGE_RECOVERY_SCOPE}"
            )
        input_schema = _collapse_nullable_schema(generated_tool["input_schema"])
        if action_name == "request_user_assistance_for_authentication":
            if "phone" in known_actions:
                description = (
                    "For targetKind=browser (default): " + description +
                    " For targetKind=iphone: request help only for a blocking password, "
                    "user-only verification code, device passcode, or manual_verification "
                    "requiring user presence (biometrics or trusted-device approval). "
                    "The browser authentication waterfall does not apply to this native target. "
                    "Navigate and approve accessible phone authentication autonomously. "
                    "Never request attention for queue timeouts, ordinary navigation, terms, "
                    "unsupported operations or transport errors. Do not include credentials or routing IDs."
                )
            else:
                # Each generated schema is invocation-local; never mutate the registry.
                for field in ("targetKind", "criticalReason"):
                    input_schema.get("properties", {}).pop(field, None)
        tools.append(
            {
                "name": action_name,
                "description": description,
                "input_schema": input_schema,
            }
        )
    return tools


def build_browser_authentication_contract(available_actions: List[str]) -> str:
    recover_enabled = recover_from_challenge_enabled() and "recover_from_challenge" in set(available_actions or [])
    contract = build_authentication_contract(recover_enabled=recover_enabled)
    if "phone" not in available_actions:
        return contract
    return (
        "This authentication ladder applies to targetKind=browser. For targetKind=iphone, "
        "follow the Cloud iPhone skill's authentication rules instead.\n"
        + contract
    )


def build_browser_use_system_prompt(available_actions: List[str]) -> str:
    """Canonical browser-automation system prompt.

    Static across calls (no time, no URL, no per-step state, no tool list).
    The v3 spawner delegates to this builder so the Rose pool prompt and the
    v3 prompt share one source of truth; per-spawn extras (goal,
    custom_instructions, available_files) are appended below the
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY by the caller when dynamic context is
    present. Provider transforms strip the marker before sending the request.
    """
    _ = available_actions
    authentication_contract = build_browser_authentication_contract(available_actions)
    return f"""# Role

You are a browser automation agent. You take in a user goal and complete the goal by interacting with a browser you are exposed to via tools.

# Input

Page state is NOT injected automatically. Call `read_browser_state` whenever you need:
1. Current URL, viewport size, and scroll position
2. Page stats and open tabs
3. DOM tree with interactive elements indexed for actions (format: [index]<type>text</type>)

Use `screenshot` when you need a viewport image. Re-read state after navigation, scrolling, or actions that may change the page.

# Browser Rules

- Your browser is in full screen mode. No search bar or navigation bar.
- Control+L will NOT focus the address bar - use the goto action to navigate to URLs.
- Browser cookies have been injected - assume the user is logged in until proven otherwise.
- Avoid login flows unless the site forces you to login to complete your directed goal.
- Only interact with elements that have a numeric [index] assigned
- Only use indexes that are explicitly provided in the current state
- Use `click_coordinates` only when the target has no numeric [index] in the current state.
  If a relevant [index] exists, call `click` or `input_text` with that index.
- If expected elements are missing, try scrolling or waiting
- By default, only elements in the visible viewport are listed; use scroll if content is offscreen
- Scroll with direction and a pixel amount; about 600 pixels is roughly one page
- If you fill an input field and the action is interrupted, suggestions may have appeared

- When the goal requires choosing among ordered options (earliest/latest showtime,
  cheapest rate, first available slot, etc.), capture the full filtered option set
  in the trajectory before selecting. Enumerate every option in display order.
  For scrollable or virtualized lists, scroll through every position and record
  each option, or evaluate all matching DOM nodes when they are available.
  Do not select until the complete set and the selected option are recorded.

# Output Format

You must call exactly one available browser action tool. Do not write a JSON
action envelope in text; use the provided tool call.

{VERIFICATION_RULES.strip()}

# Evidence Retention

- Completion verification retains action results, the final DOM, and bounded pre-write DOM checkpoints, not arbitrary historical DOM.

# Safety Rules

- NEVER delete or close any user account
- NEVER sign legal agreements on the user's behalf (accepting Terms of Service checkboxes is acceptable)
- Write lock: clicking a final commit control (Place order, Pay, Buy now, Send, Post, Confirm return) does not run it right away. The runtime intercepts the click, shows the user what the action will do, and asks for approval. If the user approves, the click runs; if they reject, the browser session ends. If approval was already granted earlier in this session, the click runs immediately. Clicking the commit control is how approval is requested; no tool requests it.
- When the goal asks for approval before a purchase, send, or post (including wording like "do not place the order without approval"), finish every earlier step, then click the commit control. Do not stop before it, and do not call attempt_completion, request_payment_card, or generate_write_lock_notification to ask for approval.
- Once a requested purchase is visibly placed or an order confirmation is shown, do not open cancellation, return, edit, or modification flows. The pre-write checkout state and prior actions are retained for verification; call attempt_completion promptly from the confirmation or order-details page instead of reopening product or checkout pages solely to reconstruct evidence.

# Returns

- When the goal excludes groceries (or food), treat food, beverages, snacks, protein bars, candy, water, soft drinks, and grocery-marketplace packs as groceries even if Amazon shows a Return items button for a packaged SKU. Prefer the most recently delivered eligible non-excluded physical item.
- If Amazon shows that a return request needs to be reviewed or to contact customer service, that item's self-service return path is blocked. Do not open Contact Us. Leave that item, pick the next eligible non-excluded item, or report the exact visible blocker if none remain.

{authentication_contract}"""


# ---------------------------------------------------------------------------
# Message build (mirrors transformToBrowserUseFormat)
# ---------------------------------------------------------------------------


def _format_action_history(action_history: List[Dict[str, Any]]) -> str:
    if not action_history:
        return ""
    parts: List[str] = ["\n\nPrevious Actions:\n"]
    for entry in action_history:
        line = f"Step {entry.get('step')}: "
        if entry.get("thinking"):
            line += f"[Thinking: {entry['thinking']}] "
        line += str(entry.get("action", ""))
        if entry.get("index") is not None:
            line += f" (index: {entry['index']})"
        result = entry.get("result", {}) or {}
        if result.get("success"):
            line += " ✓"
        else:
            line += f" ✗ Error: {result.get('error') or 'Unknown error'}"
        parts.append(line + "\n")
    return "".join(parts)


def format_browser_state_for_tool(browser_state: Dict[str, Any]) -> str:
    """Format browser state exactly as read_browser_state returns it to the model."""
    return _format_browser_state_text("", browser_state)


def _format_browser_state_text(task: str, browser_state: Dict[str, Any]) -> str:
    from browser_tools.write_lock import detect_amazon_return_self_service_block

    bs = browser_state
    timestamp = bs.get("timestamp") or bs.get("current_timestamp") or bs.get("current_time")
    if not timestamp:
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    stats_text = ""
    page_stats = bs.get("page_stats")
    if page_stats:
        stats_text = (
            f"<page_stats>{page_stats.get('links', 0)} links, "
            f"{page_stats.get('interactive', 0)} interactive, "
            f"{page_stats.get('iframes', 0)} iframes, "
            f"{page_stats.get('scroll_containers', 0)} scroll containers"
        )
        if page_stats.get("images", 0) > 0:
            stats_text += f", {page_stats['images']} images"
        stats_text += f", {page_stats.get('total_elements', 0)} total elements</page_stats>\n"

    scroll = bs.get("scroll_position") or {}
    scroll_text = f"Scroll: ({scroll.get('x', 0)}, {scroll.get('y', 0)})"
    if "pages_above" in scroll:
        scroll_text += f" | {scroll.get('pages_above')} pages above, {scroll.get('pages_below')} pages below"

    tabs_text = ""
    tabs = bs.get("tabs") or []
    if tabs:
        tabs_text = "\nOpen Tabs:\n"
        for tab in tabs:
            tabs_text += f"  Tab {tab.get('id')}: {tab.get('url')} - {tab.get('title')}\n"

    events = bs.get("recent_events") or []
    events_text = f"\nRecent Events: {', '.join(events)}\n" if events else ""

    popups = bs.get("closed_popups") or []
    popups_text = ""
    if popups:
        popups_text = "\nAuto-closed dialogs:\n"
        for popup in popups:
            popups_text += f"  - {popup}\n"

    downloads = bs.get("downloaded_files") or []
    downloads_text = ""
    if downloads:
        # File names come from the site: quote them so a name stays one inert line.
        downloads_text = "\nDownloaded files (this browser session):\n"
        for item in downloads:
            size = item.get("size")
            name = json.dumps(str(item.get("name") or "")[:200])
            downloads_text += f"  - {name}" + (f" ({size} bytes)" if isinstance(size, int) else "") + "\n"

    viewport = bs.get("viewport") or {}
    title_part = f" - {bs['title']}" if bs.get("title") else ""
    url = str(bs.get("url") or "")
    dom_tree = str(bs.get("dom_tree") or "")
    block_note = detect_amazon_return_self_service_block(url, f"{bs.get('title') or ''}\n{dom_tree}")
    block_text = f"\nPage Signal: {block_note}\n" if block_note else ""

    return (
        f"# Current Browser State\n\n"
        f"Timestamp: {timestamp}\n"
        f"{stats_text}Current URL: {url}{title_part}\n"
        f"Viewport: {viewport.get('width', 0)}x{viewport.get('height', 0)}\n"
        f"{scroll_text}{tabs_text}{events_text}{popups_text}{downloads_text}{block_text}"
        f"Interactive elements:\n{dom_tree}"
    )


def build_browser_state_message_content(
    *,
    task: str,
    browser_state: Dict[str, Any],
    include_screenshot: bool = True,
    include_task: bool = False,
) -> Any:
    """Build the per-turn browser-state user message content."""
    text_content = _format_browser_state_text(task, browser_state)
    display_text = f"Task: {task}\n\n{text_content}" if include_task else text_content

    screenshot = browser_state.get("screenshot")
    if screenshot and include_screenshot:
        image_url = screenshot if screenshot.startswith("http") else f"data:image/png;base64,{screenshot}"
        return [
            {"type": "text", "text": display_text},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
    return display_text


def _tool_status(message: Dict[str, Any]) -> Optional[str]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    status = metadata.get("toolStatus") or metadata.get("tool_status")
    if isinstance(status, str):
        return status
    content = message.get("content")
    if isinstance(content, str) and content.strip().startswith("{"):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            parsed_status = parsed.get("toolStatus") or parsed.get("tool_status") or parsed.get("status")
            if isinstance(parsed_status, str):
                return parsed_status
    return None


def filter_browser_turn_messages(turn_messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop in-progress tool rows and keep the latest tool result per call id."""
    latest_tool_index_by_id: Dict[str, int] = {}
    skipped_indexes: set[int] = set()

    for index, message in enumerate(turn_messages):
        if message.get("role") != "tool":
            continue
        status = (_tool_status(message) or "").upper()
        if status == "IN_PROGRESS":
            skipped_indexes.add(index)
            continue
        tool_call_id = message.get("tool_call_id")
        if not tool_call_id:
            continue
        tool_call_id = str(tool_call_id)
        previous = latest_tool_index_by_id.get(tool_call_id)
        if previous is not None:
            skipped_indexes.add(previous)
        latest_tool_index_by_id[tool_call_id] = index

    if not skipped_indexes:
        return list(turn_messages)
    return [message for index, message in enumerate(turn_messages) if index not in skipped_indexes]


def build_browser_use_messages(
    *,
    task: str,
    browser_state: Dict[str, Any],
    action_history: List[Dict[str, Any]],
    available_actions: List[str],
    include_screenshot: bool = True,
    extra_user_messages: Optional[List[Any]] = None,
    dynamic_system_context: Optional[str] = None,
    turn_messages: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Build the OpenAI-style messages array for one browser-use step.

    When `turn_messages` is provided, returns a full browser-task transcript:
    `[system, optional dynamic-system, initial user goal, prior turns]`.
    Page state is only present when the model previously called `read_browser_state`
    and that tool result is in `turn_messages`. Legacy callers without `turn_messages`
    get `[system, user goal (+ optional action history)]`.
    """
    system_content = build_browser_use_system_prompt(available_actions)
    if dynamic_system_context:
        from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

        system_content = system_content + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamic_system_context

    messages = [{"role": "system", "content": system_content}]

    if turn_messages is not None:
        messages.append({"role": "user", "content": task})
        messages.extend(filter_browser_turn_messages(turn_messages))
    else:
        user_content = task
        history_suffix = _format_action_history(action_history)
        if history_suffix:
            user_content = user_content + history_suffix
        messages.append({"role": "user", "content": user_content})

    # Actual server observation, not a fabricated recovery tool/user instruction.
    phone_state = browser_state.get("phone")
    if isinstance(phone_state, dict) and phone_state.get("enabled") is True and "phone" in available_actions:
        messages.append({"role": "user", "content": "<observed_phone_state>" + json.dumps(phone_state, ensure_ascii=True) + "</observed_phone_state>"})

    state_extra_user_messages = (
        browser_state.get("_extra_user_messages") or browser_state.get("extra_user_messages") or []
    )
    merged_extra_user_messages = list(extra_user_messages or []) + list(state_extra_user_messages or [])
    for extra in merged_extra_user_messages:
        if isinstance(extra, dict):
            role = extra.get("role", "user")
            content = extra.get("content", extra.get("text", ""))
            messages.append({"role": role, "content": content})
        else:
            messages.append({"role": "user", "content": str(extra)})
    return messages


# ---------------------------------------------------------------------------
# Response normalization (mirrors normalizeBrowserUseResponse)
# ---------------------------------------------------------------------------


_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```")
_OBJECT_RE = re.compile(r"\{[\s\S]*\}")
_ARRAY_RE = re.compile(r"\[[\s\S]*\]")


def extract_json(content: str) -> Any:
    """Extract a JSON value from possibly markdown-wrapped text. Returns None."""
    if not isinstance(content, str) or not content:
        return None
    trimmed = content.strip()
    for raw in (
        trimmed,
        _match(_FENCED_JSON_RE, trimmed, group=1),
        _match(_OBJECT_RE, trimmed),
        _match(_ARRAY_RE, trimmed),
    ):
        if raw is None:
            continue
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _match(regex: re.Pattern[str], text: str, group: int = 0) -> Optional[str]:
    m = regex.search(text)
    if not m:
        return None
    return m.group(group).strip()


def normalize_browser_use_tool_call(
    tool_call: Dict[str, Any],
    *,
    thinking: Optional[str] = None,
    validation_context: Optional[Dict[str, Any]] = None,
    available_actions: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Validate one provider-native tool call and return UnifiedAction."""
    name = tool_call.get("name")
    function = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
    if not isinstance(name, str) or not name:
        name = function.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError(f"normalize_browser_use_tool_call: missing tool name in {tool_call}")

    raw_args: Any = tool_call.get("arguments") if "arguments" in tool_call else tool_call.get("input")
    if raw_args is None and function:
        raw_args = function.get("arguments")
    if raw_args in (None, ""):
        args: Dict[str, Any] = {}
    elif isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"normalize_browser_use_tool_call: invalid JSON arguments for {name}: {raw_args[:200]}"
            ) from exc
        if not isinstance(parsed, dict):
            raise ValueError(f"normalize_browser_use_tool_call: arguments for {name} must decode to an object")
        args = parsed
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        raise ValueError(
            f"normalize_browser_use_tool_call: unsupported arguments type for {name}: {type(raw_args).__name__}"
        )

    normalized_name = _ACTION_NAME_MAP.get(name, name)
    if available_actions is not None and normalized_name not in available_actions:
        raise ValueError("Browser action is not available in this request.")
    # Keep the same lazy-import boundary as build_browser_use_tools; importing
    # browser_tools at providers.rose module load time creates a package cycle.
    from browser_tools.schemas import (
        BROWSER_TOOL_MODELS,
        BrowserToolArgsValidationError,
        validate_browser_tool_args,
    )

    if normalized_name in BROWSER_TOOL_MODELS:
        try:
            args = validate_browser_tool_args(
                normalized_name,
                args,
                context=validation_context,
            )
        except BrowserToolArgsValidationError as validation_error:
            # Carry the model's reasoning so the browser loop can render the
            # rejected turn accurately when it feeds the error back to the model.
            validation_error.thinking = thinking
            raise

    return normalize_browser_use_response(
        {
            "thinking": thinking,
            "action": [{normalized_name: args}],
        }
    )


def normalize_browser_use_tool_calls(
    tool_calls: List[Dict[str, Any]],
    *,
    thinking: Optional[str] = None,
    validation_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Normalize one provider turn without discarding a printable key batch.

    Browser execution consumes one unified action per turn. Providers can still
    emit several native calls in one response, though. A sequence made entirely
    of single printable ``press_key`` calls is one text-entry operation against
    the already-focused element, so preserve it as focused ``input_text``. Mixed
    or stateful batches retain the historical first-call-only behavior.
    """
    if not tool_calls:
        raise ValueError("normalize_browser_use_tool_calls: no tool calls")

    if len(tool_calls) > 1:
        try:
            normalized_calls = [
                normalize_browser_use_tool_call(
                    tool_call,
                    thinking=thinking,
                    validation_context=validation_context,
                )
                for tool_call in tool_calls
            ]
        except ValueError:
            normalized_calls = []

        keys = [call.get("params", {}).get("key") for call in normalized_calls]
        if normalized_calls and all(
            call.get("action") == "press_key" and isinstance(key, str) and len(key) == 1 and key.isprintable()
            for call, key in zip(normalized_calls, keys)
        ):
            return {
                "action": "input_text",
                "thinking": thinking,
                "index": None,
                "coordinates": None,
                "element_description": None,
                "params": {"text": "".join(keys), "clear": False},
            }

        texts = [call.get("params", {}).get("text") for call in normalized_calls]
        indexes = [call.get("index") for call in normalized_calls]
        if (
            normalized_calls
            and len(set(indexes)) == 1
            and all(
                call.get("action") == "input_text" and isinstance(text, str) and len(text) == 1 and text.isprintable()
                for call, text in zip(normalized_calls, texts)
            )
        ):
            first_clear = normalized_calls[0].get("params", {}).get("clear")
            return {
                "action": "input_text",
                "thinking": thinking,
                "index": indexes[0],
                "coordinates": None,
                "element_description": None,
                "params": {
                    "text": "".join(str(text) for text in texts),
                    "clear": first_clear is not False,
                },
            }

    return normalize_browser_use_tool_call(
        tool_calls[0],
        thinking=thinking,
        validation_context=validation_context,
    )


_ACTION_NAME_MAP: Dict[str, str] = {
    "navigate": "goto",
    "go_back": "navback",
    "input": "input_text",
    "send_keys": "press_key",
    "switch": "switch_tab",
    "close": "close_tab",
    "done": "attempt_completion",
}

_VALID_ACTIONS = frozenset(
    {
        "phone",
        "click",
        "click_coordinates",
        "drag",
        "scroll",
        "wait",
        "extract",
        "evaluate",
        "dropdown_options",
        "select_dropdown",
        "screenshot",
        "find_text",
        "upload_file",
        "search",
        "goto",
        "navback",
        "input_text",
        "press_key",
        "switch_tab",
        "close_tab",
        "open_new_tab",
        "attempt_completion",
        "request_user_assistance_for_authentication",
        "request_payment_card",
        "generate_write_lock_notification",
        # recover_from_challenge is advertised in BROWSER_USE_TOOLS; keep it in the
        # allowlist or normalize_browser_use_response() rejects the model's call and
        # the browser step aborts before the handler can run staged recovery.
        "recover_from_challenge",
        "read_browser_state",
        "read_logs",
        "read_network_requests",
    }
)


def normalize_browser_use_response(
    completion: Any, *, available_actions: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Convert a model completion into the agent's UnifiedAction shape.

    Mirrors `normalizeBrowserUseResponse` in
    `research/domains/completions/service/generic.ts`. Handles three
    action shapes:
      1. `{"action_name": "click", "index": 5}` (flat)
      2. `{"click": {"index": 5}}` (nested, browser-use native)
      3. `{"action_name": {...params}}` (semi-nested)

    Raises `ValueError` for unparseable text, empty action arrays,
    unknown action names, or click-without-index.
    """
    if isinstance(completion, str):
        parsed = extract_json(completion)
        if parsed is None:
            raise ValueError(
                f"normalize_browser_use_response: Could not extract JSON from completion: {completion[:200]}"
            )
        return normalize_browser_use_response(parsed, available_actions=available_actions)

    if not isinstance(completion, dict):
        raise ValueError(
            f"normalize_browser_use_response: completion must be a dict or string, got {type(completion).__name__}"
        )

    actions = completion.get("action")
    if not actions:
        raise ValueError("normalize_browser_use_response: No actions returned in completion")

    first_action = actions[0]
    if not isinstance(first_action, dict):
        raise ValueError(
            f"normalize_browser_use_response: first action must be an object, got {type(first_action).__name__}"
        )

    if "action_name" in first_action:
        action_name = first_action["action_name"]
        params: Dict[str, Any] = {k: v for k, v in first_action.items() if k != "action_name"}
        index = first_action.get("index")
    else:
        keys = list(first_action.keys())
        if not keys:
            raise ValueError("normalize_browser_use_response: empty action object")
        action_name = keys[0]
        params = first_action.get(action_name) or {}
        if not isinstance(params, dict):
            params = {}
        index = params.get("index")

    normalized_action = _ACTION_NAME_MAP.get(action_name, action_name)
    if available_actions is not None and normalized_action not in available_actions:
        raise ValueError("Browser action is not available in this request.")
    if normalized_action not in _VALID_ACTIONS:
        raise ValueError(
            f'normalize_browser_use_response: Unknown action "{normalized_action}" '
            f'(raw: "{action_name}") - add to _ACTION_NAME_MAP or _VALID_ACTIONS'
        )

    # `thinking` is the canonical field. `next_goal` is a defensive fallback for
    # older runs / pre-shrunken-envelope models that still emit it; relaxed to
    # optional and only consulted when `thinking` is absent.
    thinking = completion.get("thinking") or completion.get("next_goal")

    if normalized_action == "click_coordinates":
        x = params.get("x", params.get("coordinate_x"))
        y = params.get("y", params.get("coordinate_y"))
        if x is None or y is None:
            raise ValueError(f"normalize_browser_use_response: click_coordinates requires x and y, got: {params}")
        return {
            "action": "click",
            "thinking": thinking,
            "coordinates": {"x": x, "y": y},
            "params": {},
        }

    if normalized_action == "drag":
        drag_params: Dict[str, Any] = {}
        for key in ("source_index", "target_index", "start_x", "start_y", "end_x", "end_y", "steps"):
            if params.get(key) is not None:
                drag_params[key] = params[key]
            elif first_action.get(key) is not None:
                drag_params[key] = first_action[key]
        return {
            "action": "drag",
            "thinking": thinking,
            "index": drag_params.get("source_index"),
            "coordinates": None,
            "params": drag_params,
        }

    if normalized_action == "click" and index is None:
        raise ValueError(
            f"normalize_browser_use_response: click action requires element index, got none. Raw action: {first_action}"
        )

    normalized_params = _normalize_action_params(action_name, normalized_action, params, first_action, index)

    coordinates: Optional[Dict[str, Any]] = None
    if params.get("coordinate_x") is not None:
        coordinates = {"x": params.get("coordinate_x"), "y": params.get("coordinate_y")}

    return {
        "action": normalized_action,
        "thinking": thinking,
        "index": index,
        "coordinates": coordinates,
        "element_description": params.get("element_description"),
        "params": normalized_params,
    }


def _normalize_action_params(
    raw_action_name: str,
    normalized_action: str,
    params: Dict[str, Any],
    first_action: Dict[str, Any],
    index: Any,
) -> Dict[str, Any]:
    if normalized_action == "request_user_assistance_for_authentication":
        from browser_tools.schemas import validate_browser_tool_args
        normalized = validate_browser_tool_args(normalized_action, params)
        if normalized.get("targetKind") == "browser":
            normalized.pop("targetKind")
        return normalized
    if normalized_action == "phone":
        from browser_tools.schemas import validate_browser_tool_args
        return validate_browser_tool_args("phone", params)
    if normalized_action == "generate_write_lock_notification":
        return dict(params)

    if normalized_action == "read_logs":
        log_params: Dict[str, Any] = {}
        for key in (
            "pattern",
            "regex",
            "limit",
            "level",
            "status",
            "url_pattern",
            "method",
            "resource_type",
            "max_body_chars",
        ):
            if params.get(key) is not None:
                log_params[key] = params[key]
        if params.get("sources") is not None:
            log_params["sources"] = params["sources"]
        for key in ("clear", "include_query", "include_headers", "include_bodies"):
            if params.get(key) is not None:
                log_params[key] = bool(params[key])
        return log_params

    if normalized_action == "read_network_requests":
        network_params: Dict[str, Any] = {}
        for key in ("url_pattern", "method", "status", "resource_type"):
            if params.get(key) is not None:
                network_params[key] = str(params[key])
        for key in ("limit", "max_body_chars"):
            if params.get(key) is not None:
                network_params[key] = params[key]
        for key in ("clear", "include_query", "include_headers", "include_bodies"):
            if params.get(key) is not None:
                network_params[key] = bool(params[key])
        return network_params

    out: Dict[str, Any] = {}

    if params.get("url"):
        out["url"] = params["url"]
    if params.get("text"):
        out["text"] = params["text"]
    if params.get("typing_text"):  # Yutori format
        out["text"] = params["typing_text"]
    if normalized_action == "input_text" and params.get("clear") is not None:
        out["clear"] = bool(params["clear"])

    if first_action.get("filename"):
        out["filename"] = first_action["filename"]
    elif params.get("filename"):
        out["filename"] = params["filename"]
    if first_action.get("file_path"):
        out["file_path"] = first_action["file_path"]
    elif params.get("file_path"):
        out["file_path"] = params["file_path"]

    if params.get("key"):
        out["key"] = params["key"]
    if params.get("keys"):
        out["key"] = params["keys"]

    if params.get("instruction"):
        out["instruction"] = params["instruction"]
    if params.get("query"):
        out["instruction"] = params["query"]
    if params.get("extract_links") is not None:
        out["extract_links"] = params["extract_links"]

    if params.get("code"):
        out["code"] = params["code"]

    if normalized_action == "select_dropdown" and params.get("text"):
        out["value"] = params["text"]
    elif params.get("value"):
        out["value"] = params["value"]

    if normalized_action == "request_payment_card":

        def _maybe_json_list(value: Any) -> Any:
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except json.JSONDecodeError:
                    return value
                return parsed if isinstance(parsed, list) else value
            return value

        def _maybe_int(value: Any) -> Any:
            if isinstance(value, str) and value.strip().isdigit():
                return int(value.strip())
            return value

        for key in (
            "merchant",
            "currency",
            "line_items",
            "lineItems",
            "fees",
            "subtotal_cents",
            "subtotalCents",
            "total_cents",
            "totalCents",
        ):
            if params.get(key) is not None:
                value = params[key]
                if key in {"line_items", "lineItems", "fees"}:
                    value = _maybe_json_list(value)
                if key in {"subtotal_cents", "subtotalCents", "total_cents", "totalCents"}:
                    value = _maybe_int(value)
                out[key] = value

    if params.get("tab_id"):
        out["tab_id"] = params["tab_id"]
    if params.get("message"):
        out["message"] = params["message"]
    cookie_bundle_id = (
        params.get("cookie_bundle_id") or params.get("cookieBundleId") or first_action.get("cookie_bundle_id")
    )
    if cookie_bundle_id:
        out["cookie_bundle_id"] = cookie_bundle_id
    label = params.get("label") or first_action.get("label")
    if label:
        out["label"] = label
    if params.get("reason"):
        out["reason"] = params["reason"]
    if normalized_action == "recover_from_challenge":
        raw_preserve = params.get("auth_cookies_are_preserved")
        if raw_preserve is None:
            raw_preserve = first_action.get("auth_cookies_are_preserved")
        if raw_preserve is not None:
            if isinstance(raw_preserve, str):
                out["auth_cookies_are_preserved"] = raw_preserve.strip().lower() in (
                    "1",
                    "true",
                    "yes",
                    "y",
                )
            else:
                out["auth_cookies_are_preserved"] = bool(raw_preserve)

    if params.get("seconds") is not None:
        out["time_ms"] = params["seconds"] * 1000
    if params.get("timeout") is not None:
        out["time_ms"] = params["timeout"]
    if params.get("time_ms") is not None:
        out["time_ms"] = params["time_ms"]

    if raw_action_name == "scroll_up":
        out["direction"] = "up"
        out["amount"] = 300
    elif raw_action_name == "scroll_down":
        out["direction"] = "down"
        out["amount"] = 300
    elif params.get("down") is not None:
        out["direction"] = "down" if params["down"] else "up"
        pages = params.get("pages", 1.0)
        out["amount"] = round(pages * 600)
    elif params.get("direction"):
        out["direction"] = params["direction"]
        out["amount"] = params.get("amount", 300)

    if index is not None:
        out["index"] = index

    return out
