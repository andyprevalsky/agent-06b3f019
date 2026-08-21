"""Action execution services for spawn-browser-agent-v3 domain.

Browser action execution, write lock checking, and element interaction.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import re
import time as time_module
from contextlib import suppress
from dataclasses import dataclass
from io import BytesIO
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import urlparse

import structlog
from PIL import Image

from browser_tools.schemas import RequestPaymentCardBrowserTool, normalize_browser_wait_ms
from domains.spawn_browser_agent_v3.config import WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS
from domains.spawn_browser_agent_v3.service_crypto import (
    PAYMENT_CARD_SECRET_REFS,
    auth_realm_from_url,
    auth_realm_matches_url,
    has_payment_card_secret_refs,
)
from utils.error_utils import extract_error_message
from utils.purchase_approval import validate_product_url_for_pages

if TYPE_CHECKING:
    from browser_tools.dom_service import ActionHistory, DOMService
    from browser_tools.humanizer import BrowserHumanizer

logger = structlog.get_logger()

STEEL_COMPUTER_SCREENSHOT_WIDTH = 1288
STEEL_COMPUTER_SCREENSHOT_HEIGHT = 891
# Actions after which a page can start a WebAuthn ceremony: focusing or typing
# into an account field triggers conditional UI, clicking activates a
# "sign in with a passkey" control, and a navigation can land straight on a
# sign-in page that invokes WebAuthn on load.
_CEREMONY_CAPABLE_ACTIONS = frozenset(
    {"click", "input_text", "press_key", "goto", "navback", "switch_tab", "open_new_tab"}
)

STEEL_VIEWPORT_CROP_X = 4
STEEL_VIEWPORT_CROP_Y = 87
STEEL_VIEWPORT_CROP_WIDTH = 1283
STEEL_VIEWPORT_CROP_HEIGHT = 800

# Host labels that almost always serve machine/API surfaces, not HTML documents
# the agent should browse. Shape-only (no vendor/product host names).
_API_SURFACE_HOST_LABELS = frozenset(
    {
        "api",
        "js",
        "graphql",
        "ws",
        "wss",
    }
)
_API_SURFACE_PATHS = frozenset(
    {
        "/health",
        "/healthz",
        "/healthcheck",
        "/ready",
        "/readyz",
        "/livez",
        "/status",
        "/ping",
    }
)


def url_looks_like_api_surface(url: str) -> bool:
    """True when a URL is a machine/API surface, not a browsable document.

    Network-log hosts (api.*, /v1/*, /healthcheck) are not pages — navigating
    there after reading traffic strands the agent. Shape-only heuristic.
    """
    parsed = urlparse(url or "")
    host = (parsed.hostname or "").lower()
    path = (parsed.path or "/").lower().rstrip("/") or "/"
    if host:
        label = host.split(".", 1)[0]
        if label in _API_SURFACE_HOST_LABELS:
            return True
    if path in _API_SURFACE_PATHS:
        return True
    if path.startswith(("/v1/", "/v2/", "/v3/", "/v4/")):
        return True
    if path in {"/v1", "/v2", "/v3", "/v4"}:
        return True
    return False


def effective_navigation_pin_host(
    *,
    current_url: str,
    recovery_pin_host: Optional[str],
    origin_base_domain: Optional[str],
) -> Optional[str]:
    """Resolve the host the agent must stay on.

    Cross-origin handoff (live registrable domain ≠ session origin): pin to the
    live host so Place-order / OAuth / 3DS redirects stick without path or
    product-name allowlists. Otherwise keep an explicit post-recovery pin.
    """
    current_host = (urlparse(current_url or "").hostname or "").lower()
    origin = (origin_base_domain or "").lower().strip(".")
    if current_host and origin:
        current_base = _get_base_domain(current_host)
        if current_base and current_base != origin:
            return current_host
    pin = (recovery_pin_host or "").lower().strip(".")
    return pin or None


def evaluate_code_looks_like_navigation(code: str) -> bool:
    """True when JS evaluate would navigate / open windows (bypass for goto guards)."""
    lowered = (code or "").lower()
    markers = (
        "location.href",
        "location.assign",
        "location.replace",
        "location.reload",
        "document.location",
        "window.location",
        "history.pushstate",
        "history.replacestate",
        "history.back",
        "history.go",
        "window.open",
        "window.navigate",
    )
    return any(marker in lowered for marker in markers)


def press_key_looks_like_leave_page(key: str) -> bool:
    """True for history-back / close-tab chords that abandon a pinned page."""
    normalized = (key or "").replace(" ", "").lower().replace("ctrl+", "control+")
    leave_chords = {
        "alt+left",
        "alt+arrowleft",
        "alt+right",
        "alt+arrowright",
        "meta+left",
        "meta+[",
        "control+[",
        "control+w",
        "control+shift+w",
        "meta+w",
        "meta+shift+w",
        "browserback",
        "browserforward",
    }
    return normalized in leave_chords


def _kernel_computer_key(key: str) -> str:
    """Translate Playwright-style key names to Kernel/xdotool key symbols."""
    aliases = {
        "control": "Ctrl",
        "ctrl": "Ctrl",
        "meta": "Super",
        "command": "Super",
        "cmd": "Super",
        "enter": "Return",
        "arrowup": "Up",
        "arrowdown": "Down",
        "arrowleft": "Left",
        "arrowright": "Right",
        "escape": "Escape",
        "esc": "Escape",
    }
    return "+".join(aliases.get(part.strip().lower(), part.strip()) for part in key.split("+"))


def click_href_leaves_pinned_base(element: Any, pin_host: Optional[str]) -> Optional[str]:
    """Return absolute href when a click target leaves the pinned registrable domain."""
    pin = (pin_host or "").lower().strip(".")
    if not pin or element is None:
        return None
    attrs = getattr(element, "attributes", None) or {}
    if not isinstance(attrs, dict):
        return None
    href = str(attrs.get("href") or attrs.get("xlink:href") or "").strip()
    if not href.startswith(("http://", "https://")):
        return None
    target_host = (urlparse(href).hostname or "").lower()
    if not target_host:
        return None
    if _get_base_domain(target_host) != _get_base_domain(pin):
        return href
    return None


def navigation_leaves_pinned_host(
    *,
    current_url: str,
    target_url: Optional[str],
    pin_host: Optional[str],
    action: str,
) -> bool:
    """True when a nav action would leave the pinned browse host."""
    pin = (pin_host or "").lower().strip(".")
    if not pin:
        return False
    current_host = (urlparse(current_url or "").hostname or "").lower()
    if not current_host:
        return False
    on_pin = current_host == pin or current_host.endswith(f".{pin}")
    if not on_pin:
        # Clicks may have already moved us off the pin — do not trap elsewhere.
        return False
    # Closing/switching tabs abandons the handoff surface the same way navback does.
    if action in {"navback", "close_tab", "switch_tab"}:
        return True
    if action in {"goto", "open_new_tab"}:
        target_host = (urlparse(target_url or "").hostname or "").lower()
        if not target_host:
            return True
        if target_host == pin or target_host.endswith(f".{pin}"):
            return False
        return True
    return False


# ========================================
# ELEMENT DESCRIPTION
# ========================================


def get_element_description(element: Any, max_length: int = 40) -> str:
    """Get a human-readable description of a DOM element."""
    if not element:
        return "unknown"

    tag = element.tag_name.lower() if element.tag_name else "element"
    attrs = element.attributes or {}

    identifier = ""

    # 1. Text content
    try:
        text = element.get_all_children_text()
        if text and len(text.strip()) > 0:
            text = text.strip()[:30]
            identifier = f'"{text}"'
    except Exception:
        pass

    # 2. Placeholder
    if not identifier and attrs.get("placeholder"):
        identifier = f'placeholder="{attrs["placeholder"][:20]}"'

    # 3. aria-label
    if not identifier and attrs.get("aria-label"):
        identifier = f'"{attrs["aria-label"][:20]}"'

    # 4. name attribute
    if not identifier and attrs.get("name"):
        identifier = f'name="{attrs["name"][:15]}"'

    # 5. id attribute
    if not identifier and attrs.get("id"):
        identifier = f"#{attrs['id'][:15]}"

    # 6. type for inputs
    if not identifier and tag == "input" and attrs.get("type"):
        identifier = f'type="{attrs["type"]}"'

    desc = f"<{tag} {identifier}>" if identifier else f"<{tag}>"
    return desc[:max_length]


# ========================================
# VISUAL CURSOR
# ========================================


async def move_visual_cursor(dom_service: DOMService, x: int, y: int) -> None:
    """Move the injected visual cursor to coordinates."""
    try:
        session = dom_service.session
        if not session:
            return
        cdp_session = await session.get_or_create_cdp_session(focus=True)
        await cdp_session.cdp_client.send.Runtime.evaluate(
            params={
                "expression": f"if (window.__moveRoseCursor) window.__moveRoseCursor({x}, {y});",
                "returnByValue": True,
            },
            session_id=cdp_session.session_id,
        )
    except Exception:
        pass  # Visual cursor is optional


# ========================================
# URL / DOMAIN HELPERS
# ========================================


def get_domain_from_url(url: str) -> str:
    """Extract domain from URL for approval tracking."""
    try:
        parsed = urlparse(url.lower())
        domain = parsed.netloc
        if not domain and "://" not in url:
            # Bare host / domain strings from notification payloads (e.g. "roselabs.ai").
            # Require a dot so junk like "not-a-url" stays empty.
            candidate = url.strip().lower()
            if (
                candidate
                and "." in candidate
                and " " not in candidate
                and "/" not in candidate
            ):
                domain = candidate
        if "@" in domain:
            domain = domain.rsplit("@", 1)[-1]
        if domain.startswith("["):
            # Leave IPv6 literals alone; strip optional zone only.
            end = domain.find("]")
            domain = domain[: end + 1] if end != -1 else domain
        elif ":" in domain:
            domain = domain.split(":", 1)[0]
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return ""


async def _wait_for_navigation_content(page: Any, deadline: float) -> Dict[str, Any]:
    last_state: Dict[str, Any] = {}
    while time_module.monotonic() < deadline:
        try:
            wait_for_load_state = getattr(page, "wait_for_load_state", None)
            if wait_for_load_state:
                with suppress(Exception):
                    wait_result = wait_for_load_state("domcontentloaded", timeout=1500)
                    if inspect.isawaitable(wait_result):
                        await wait_result

            evaluate = getattr(page, "evaluate", None)
            if not evaluate:
                return {"ready": False, "reason": "no_page_evaluate", "state": last_state}
            evaluate_result = evaluate(
                """() => {
                    const body = document.body;
                    const roots = Array.from(document.querySelectorAll('#root, #__next, [data-reactroot]'));
                    const rootStats = roots.map((root) => ({
                        children: root.children ? root.children.length : 0,
                        textLength: ((root.innerText || root.textContent || '').trim()).length,
                        controls: root.querySelectorAll
                          ? root.querySelectorAll('button, input, select, textarea, a[href], [role="button"]').length
                          : 0,
                    }));
                    const rootChildren = rootStats.reduce((sum, item) => sum + item.children, 0);
                    const rootTextLength = rootStats.reduce((sum, item) => sum + item.textLength, 0);
                    const rootControls = rootStats.reduce((sum, item) => sum + item.controls, 0);
                    const bodyTextLength = body ? ((body.innerText || '').trim()).length : 0;
                    const bodyChildren = body && body.children ? body.children.length : 0;
                    const bodyControls = body && body.querySelectorAll
                      ? body.querySelectorAll('button, input, select, textarea, a[href], [role="button"]').length
                      : 0;
                    const hasAppRoot = roots.length > 0;
                    const appRootReady = hasAppRoot && (rootChildren > 0 || rootTextLength > 0 || rootControls > 0);
                    const plainPageReady = !hasAppRoot && (bodyTextLength > 0 || bodyControls > 0);
                    return {
                        readyState: document.readyState,
                        href: location.href,
                        title: document.title,
                        hasAppRoot,
                        appRootReady,
                        plainPageReady,
                        bodyTextLength,
                        bodyChildren,
                        bodyControls,
                        rootChildren,
                        rootTextLength,
                        rootControls,
                        blankSpaShell: hasAppRoot && !appRootReady,
                    };
                }"""
            )
            if not inspect.isawaitable(evaluate_result):
                return {"ready": False, "reason": "page_evaluate_not_awaitable", "state": last_state}
            state = await evaluate_result
            if isinstance(state, str):
                with suppress(Exception):
                    state = json.loads(state)
            last_state = state if isinstance(state, dict) else {"raw": state}
            if last_state.get("appRootReady") or last_state.get("plainPageReady"):
                return {"ready": True, "state": last_state}
        except Exception as error:
            last_state = {"error": str(error)}
        await asyncio.sleep(0.25)
    return {"ready": False, "state": last_state}


async def wait_for_navigation_ready(
    dom_service: DOMService,
    *,
    url: str,
    timeout_seconds: float = 5.0,
    reload_blank_spa_once: bool = True,
) -> Dict[str, Any]:
    """Wait for a navigated page to have usable content; reload one empty SPA shell."""
    session = getattr(dom_service, "session", None)
    get_current_page = getattr(session, "get_current_page", None)
    if not get_current_page:
        return {"ready": False, "reason": "no_current_page"}

    try:
        page_result = get_current_page()
        page = await page_result if inspect.isawaitable(page_result) else page_result
    except Exception as exc:
        logger.warning("Navigation readiness could not get current page", url=url, error=str(exc))
        return {"ready": False, "reason": "get_current_page_failed", "error": str(exc)}

    first = await _wait_for_navigation_content(page, time_module.monotonic() + timeout_seconds)
    if first.get("ready") or not reload_blank_spa_once:
        if not first.get("ready"):
            logger.warning("Navigation finished without usable page content", url=url, state=first.get("state"))
        return first

    state = first.get("state") if isinstance(first.get("state"), dict) else {}
    stuck_loading_shell = (
        state.get("readyState") == "loading"
        and not state.get("hasAppRoot")
        and not state.get("bodyChildren")
        and not state.get("bodyTextLength")
    )
    if not state.get("blankSpaShell") and not stuck_loading_shell:
        logger.warning("Navigation finished before page content became ready", url=url, state=state)
        return first

    if stuck_loading_shell:
        logger.warning("Navigation stayed on an empty loading document; reloading once", url=url, state=state)
    else:
        logger.warning("Navigation produced blank SPA shell; reloading once", url=url, state=state)
    try:
        goto = getattr(page, "goto", None)
        reload_page = getattr(page, "reload", None)
        if stuck_loading_shell and goto:
            await goto(url, wait_until="domcontentloaded", timeout=10000)
        elif reload_page:
            await reload_page()
        elif goto:
            await goto(url, wait_until="domcontentloaded", timeout=10000)
        else:
            return first
    except Exception as exc:
        logger.warning("Blank SPA shell reload failed", url=url, error=str(exc))
        return {"ready": False, "reason": "reload_failed", "state": state, "error": str(exc)}

    second = await _wait_for_navigation_content(page, time_module.monotonic() + timeout_seconds)
    if not second.get("ready"):
        logger.warning("Page still lacked usable content after reload", url=url, state=second.get("state"))
    return second


def _get_base_domain(domain: str) -> str:
    """Get base domain (e.g., 'amazon.com' from 'auth.amazon.com')."""
    parts = domain.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return domain


# Ephemeral site-wide unlock after payment-card approval for this browser-agent
# session only. Never copied into a newly spawned browser agent.
SITE_WRITE_LOCK_APPROVAL_KEY = "site"

# Browser live-view / provider hosts must not become the site-unlock domain —
# Place order is checked against the real merchant page (e.g. roselabs.ai).
# Kernel exposes both *.onkernel.com and *.kernel.sh live-view hosts.
_BROWSER_PROVIDER_DOMAIN_SUFFIXES = (
    "onkernel.com",
    "kernel.sh",
    "steel.dev",
    "browserbase.com",
    "hyperbrowser.ai",
)


def _is_browser_provider_domain(domain: str) -> bool:
    if not domain:
        return True
    lowered = domain.lower()
    return any(lowered == suffix or lowered.endswith("." + suffix) for suffix in _BROWSER_PROVIDER_DOMAIN_SUFFIXES)


def resolve_site_write_lock_grant_url(result: Optional[Dict]) -> str:
    """Pick the merchant checkout URL for a payment-card site unlock.

    Prefer payment-request product URLs / write-lock notification service URL /
    spawn ``start_url`` / visited merchant URLs over ``current_url``, which on
    Kernel can be the live-view proxy host (``*.onkernel.com`` / ``*.kernel.sh``).
    Unlocking the proxy domain would leave Place order on the real merchant site
    locked.
    """
    payload = result if isinstance(result, dict) else {}
    candidates: list[str] = []

    payment = payload.get("payment_request") or {}
    if isinstance(payment, dict):
        line_items = payment.get("line_items") or payment.get("lineItems") or []
        if isinstance(line_items, list):
            for item in line_items:
                if not isinstance(item, dict):
                    continue
                product_url = item.get("product_url") or item.get("productUrl")
                if product_url:
                    candidates.append(str(product_url))

    notification = payload.get("write_lock_notification") or {}
    if isinstance(notification, dict):
        service = notification.get("service") or {}
        if isinstance(service, dict):
            if service.get("url"):
                candidates.append(str(service["url"]))
            domain = service.get("domain")
            if domain:
                candidates.append(f"https://{domain}/")

    start_url = payload.get("start_url")
    if start_url:
        candidates.append(str(start_url))

    visited = payload.get("visited_urls") or []
    if isinstance(visited, list):
        for url in visited:
            if url:
                candidates.append(str(url))

    current_url = payload.get("current_url")
    if current_url:
        candidates.append(str(current_url))

    for url in candidates:
        domain = get_domain_from_url(url)
        if domain and not _is_browser_provider_domain(domain):
            return url
    return ""


def _approval_entry_still_valid(
    approval: Optional[Dict],
    current_domain: str,
    *,
    enforce_timeout: bool = True,
    match_base_domain: bool = False,
) -> bool:
    if not approval or not approval.get("domain") or not approval.get("approved_at"):
        return False
    if not current_domain:
        return False
    approved_domain = approval["domain"]
    if match_base_domain:
        # Payment-card site unlock: same registrable domain + any subdomain /
        # path / query (e.g. unlock on www.roselabs.ai covers checkout.roselabs.ai).
        # Never widen browser-provider proxy hosts into a site unlock.
        if _is_browser_provider_domain(current_domain) or _is_browser_provider_domain(approved_domain):
            return False
        if _get_base_domain(approved_domain) != _get_base_domain(current_domain):
            return False
    elif current_domain != approved_domain:
        return False
    # Payment-card site unlock is session-scoped (no wall-clock expiry). One-off
    # typed write-lock approvals still expire after WRITE_LOCK_APPROVAL_TIMEOUT.
    if not enforce_timeout or approval.get("persistent"):
        return True
    return not time_module.time() - approval["approved_at"] > WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS


def is_approval_valid(approvals: Optional[Dict], approval_type: str, current_url: str) -> bool:
    """Check if an existing approval is still valid for the current domain.

    A payment-card approval grants a site-wide unlock (``SITE_WRITE_LOCK_APPROVAL_KEY``)
    for the merchant's registrable domain and all of its subdomains / paths / queries
    for the rest of THIS browser activity. That unlock lives only in this browser
    activity's ``write_lock_approvals`` / resume state — a newly spawned browser
    agent starts empty and does not inherit it.
    """
    if not approvals:
        return False

    current_domain = get_domain_from_url(current_url)
    # Site unlock from payment-card approval: base-domain wildcard, no 120s timeout.
    if _approval_entry_still_valid(
        approvals.get(SITE_WRITE_LOCK_APPROVAL_KEY),
        current_domain,
        enforce_timeout=False,
        match_base_domain=True,
    ):
        return True

    return _approval_entry_still_valid(approvals.get(approval_type), current_domain)


def grant_site_write_lock_approvals(
    approvals: Optional[Dict],
    current_url: str,
    approved_at: float,
) -> Dict[str, Dict]:
    """Record payment-card approval as a site unlock for this browser session.

    Stores the registrable base domain (not a full URL path/query) so any host
    under that domain — apex, www, checkout.*, etc. — shares the unlock. Also
    sets the legacy ``payment`` entry for payment-field bypass. Persistent for
    this browser activity (not the 120s one-off timeout).
    """
    granted = dict(approvals or {})
    domain = get_domain_from_url(current_url)
    if not domain or _is_browser_provider_domain(domain):
        return granted
    base_domain = _get_base_domain(domain)
    if not base_domain:
        return granted
    entry = {
        "domain": base_domain,
        "approved_at": approved_at,
        "persistent": True,
    }
    granted["payment"] = entry
    granted[SITE_WRITE_LOCK_APPROVAL_KEY] = entry
    return granted


# ========================================
# ACTION EXECUTION
# ========================================


@dataclass
class _ActionContext:
    dom_service: DOMService
    action_history: ActionHistory
    session: Any
    action_name: str
    index: Any
    params: Dict[str, Any]
    thinking: Any
    coords: Any
    element: Any
    available_file_paths: Optional[Dict[str, str]]
    session_id: Optional[str]
    user_id: str
    config: Any
    humanizer: Optional[BrowserHumanizer]
    secret_refs: Optional[Dict[str, str]]
    password_origins: Optional[Dict[str, str]]
    credential_refs_by_secret_ref: Optional[Dict[str, Dict[str, str]]]
    current_url: str
    trusted_page_urls: Optional[List[str]]
    write_lock_enabled: bool
    write_lock_approvals: Optional[Dict[str, Dict]]
    system_name: str
    browser_network_recorder: Optional[Any]
    current_auth_realm: str
    prepare_credentials_for_url: Optional[Callable[[str], Awaitable[Optional[Dict[str, Any]]]]]
    navigation_pin_host: Optional[str] = None
    navigation_origin_base_domain: Optional[str] = None


async def _refuse_navigation(
    context: _ActionContext,
    *,
    action: str,
    error: str,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    result = {"success": False, "error": error, "current_url": context.current_url}
    await context.action_history.record_action(
        dom_service=context.dom_service,
        action=action,
        thinking=context.thinking,
        params=params,
        result=result,
    )
    return result


def _navigation_guard_error(
    context: _ActionContext,
    *,
    action: str,
    target_url: Optional[str] = None,
) -> Optional[str]:
    if target_url and url_looks_like_api_surface(target_url):
        return (
            f"Refusing navigation to API/non-document URL {target_url!r}. "
            "Network request hosts are not pages — stay on the current document "
            f"({context.current_url or 'current page'}) and continue the task there."
        )
    pin_host = effective_navigation_pin_host(
        current_url=context.current_url,
        recovery_pin_host=context.navigation_pin_host,
        origin_base_domain=context.navigation_origin_base_domain,
    )
    if navigation_leaves_pinned_host(
        current_url=context.current_url,
        target_url=target_url,
        pin_host=pin_host,
        action=action,
    ):
        return (
            f"Refusing to leave pinned page host {pin_host!r}. "
            f"Current page URL: {context.current_url}. Continue the task on this page "
            "(do not go back, close/switch tabs, or navigate to another host until "
            "this page is done)."
        )
    return None


def _pinned_evaluate_guard_error(context: _ActionContext, code: str) -> Optional[str]:
    """Refuse navigation-shaped evaluate while a host pin is active."""
    pin_host = effective_navigation_pin_host(
        current_url=context.current_url,
        recovery_pin_host=context.navigation_pin_host,
        origin_base_domain=context.navigation_origin_base_domain,
    )
    if not pin_host:
        return None
    current_host = (urlparse(context.current_url or "").hostname or "").lower()
    on_pin = bool(current_host) and (
        current_host == pin_host or current_host.endswith(f".{pin_host}")
    )
    if not on_pin:
        return None
    if evaluate_code_looks_like_navigation(code):
        return (
            f"Refusing evaluate that would navigate away from pinned host {pin_host!r}. "
            f"Current page URL: {context.current_url}. Use input_text/click on this page "
            "instead of location/history/window.open scripts."
        )
    return None


def _active_pin_host(context: _ActionContext) -> Optional[str]:
    pin_host = effective_navigation_pin_host(
        current_url=context.current_url,
        recovery_pin_host=context.navigation_pin_host,
        origin_base_domain=context.navigation_origin_base_domain,
    )
    if not pin_host:
        return None
    current_host = (urlparse(context.current_url or "").hostname or "").lower()
    if not current_host:
        return None
    if current_host == pin_host or current_host.endswith(f".{pin_host}"):
        return pin_host
    return None


_INTERACTION_ACTIONS = {
    "click",
    "input_text",
    "press_key",
    "scroll",
    "dropdown_options",
    "select_dropdown",
    "upload_file",
}
_NAVIGATION_ACTIONS = {"goto", "navback", "wait", "switch_tab", "close_tab", "open_new_tab"}
_INSPECTION_ACTIONS = {"read_network_requests", "evaluate", "extract", "screenshot"}
_TERMINAL_ACTIONS = {
    "request_payment_card",
    "done",
    "attempt_completion",
    "send_message_to_user",
    "generate_write_lock_notification",
}


async def _execute_request_payment_card_action(context: _ActionContext) -> Dict[str, Any]:
    if has_payment_card_secret_refs(context.secret_refs):
        return {
            "success": False,
            "error": (
                "Payment approval is already complete. Do not call request_payment_card again. "
                "Type the existing secret refs card_number, card_name, card_expiry, and card_cvv "
                "into the payment fields, then submit the checkout form."
            ),
        }
    try:
        payment_request = RequestPaymentCardBrowserTool.model_validate(
            {"tool": context.action_name, **context.params}
        )
        for item in payment_request.line_items:
            validate_product_url_for_pages(
                item.product_url,
                [*(context.trusted_page_urls or []), context.current_url],
            )
    except ValueError as error:
        hint = ""
        if any(term in str(error).lower() for term in ("rating", "review")):
            hint = (
                " If this page genuinely has no rating/reviews (e.g. a service, ticket, "
                "or event booking), pass rating '0 stars' and review_count '0 reviews', "
                "do not use 'N/A', 'none', or a made-up number, and do not keep searching "
                "for a rating that is not shown."
            )
        return {"success": False, "error": f"request_payment_card receipt is incomplete: {error}.{hint}"}
    return {
        "status": "awaiting_payment_card_approval",
        "payment_request": context.params,
        "current_url": context.current_url,
    }


async def _execute_read_network_requests_action(context: _ActionContext) -> Dict[str, Any]:
    recorder = context.browser_network_recorder
    if recorder is None:
        return {
            "success": False,
            "error": (
                "Network capture is not attached to this browser session, so there is "
                "nothing to read. Rely on the DOM tree and screenshots instead."
            ),
        }
    params = context.params
    include_bodies = bool(params.get("include_bodies"))
    requests = recorder.query_requests(
        url_pattern=str(params.get("url_pattern") or ""),
        method=str(params.get("method") or ""),
        status=str(params.get("status") or ""),
        resource_type=str(params.get("resource_type") or ""),
        limit=int(params.get("limit") or 100),
        clear=bool(params.get("clear")),
        include_query=bool(params.get("include_query")),
        include_headers=bool(params.get("include_headers")),
        include_bodies=include_bodies,
        max_body_chars=int(params.get("max_body_chars") or 4000),
    )
    with_bodies = sum(1 for row in requests if row.get("body_available"))
    message = f"Captured {len(requests)} network request(s)."
    if requests and not include_bodies and with_bodies:
        message += (
            f" {with_bodies} have a captured response body - re-run with include_bodies=true"
            " (optionally narrowed by url_pattern) to read them."
        )
    recorded_params = {
        key: params[key]
        for key in (
            "url_pattern",
            "method",
            "status",
            "resource_type",
            "limit",
            "clear",
            "include_query",
            "include_headers",
            "include_bodies",
            "max_body_chars",
        )
        if key in params
    }
    await context.action_history.record_action(
        dom_service=context.dom_service,
        action="read_network_requests",
        thinking=context.thinking,
        params=recorded_params,
        result={"success": True, "count": len(requests)},
    )
    return {"success": True, "message": message, "requests": requests}


async def _execute_interaction_action(context: _ActionContext) -> Dict[str, Any]:
    from browser_use.browser.events import (
        GetDropdownOptionsEvent,
        ScrollEvent,
        SelectDropdownOptionEvent,
        SendKeysEvent,
    )

    if context.action_name == "click":
        pin_host = _active_pin_host(context)
        leave_href = click_href_leaves_pinned_base(context.element, pin_host)
        if leave_href:
            return await _refuse_navigation(
                context,
                action="click",
                error=(
                    f"Refusing click that navigates off pinned host {pin_host!r} "
                    f"via {leave_href!r}. Current page URL: {context.current_url}. "
                    "Fill and submit the fields on this page instead."
                ),
                params={"index": context.index, "href": leave_href},
            )
        return await _execute_click(
            session=context.session,
            dom_service=context.dom_service,
            action_history=context.action_history,
            element=context.element,
            index=context.index,
            coords=context.coords,
            thinking=context.thinking,
            humanizer=context.humanizer,
            write_lock_enabled=context.write_lock_enabled,
            write_lock_approvals=context.write_lock_approvals,
            current_url=context.current_url,
            system_name=context.system_name,
            secret_refs=context.secret_refs,
        )
    if context.action_name == "input_text":
        return await _execute_input_text(
            session=context.session,
            dom_service=context.dom_service,
            action_history=context.action_history,
            element=context.element,
            index=context.index,
            coords=context.coords,
            params=context.params,
            thinking=context.thinking,
            humanizer=context.humanizer,
            secret_refs=context.secret_refs,
            password_origins=context.password_origins,
            credential_refs_by_secret_ref=context.credential_refs_by_secret_ref,
            current_url=context.current_url,
            write_lock_enabled=context.write_lock_enabled,
            write_lock_approvals=context.write_lock_approvals,
            system_name=context.system_name,
        )
    if context.action_name == "press_key":
        key = context.params.get("key", "")
        pin_host = _active_pin_host(context)
        if pin_host and press_key_looks_like_leave_page(str(key)):
            return await _refuse_navigation(
                context,
                action="press_key",
                error=(
                    f"Refusing key chord {key!r} that would leave pinned host {pin_host!r}. "
                    f"Current page URL: {context.current_url}. Continue on this page with "
                    "input_text/click instead of back/close-tab shortcuts."
                ),
                params={"key": key},
            )
        provider_pressed = False
        if context.config is not None and context.session_id:
            from domains.spawn_browser_agent_v3.repo import press_browser_computer_key

            # Only an explicit provider "unsupported" response may fall back to
            # renderer-level input. A timeout or lost response is ambiguous: the
            # browser-process key may already have executed, and replaying a
            # state-changing key such as Enter through CDP could submit twice.
            provider_pressed = await press_browser_computer_key(
                context.config,
                context.session_id,
                context.user_id,
                _kernel_computer_key(str(key)),
            )
        if provider_pressed:
            logger.info("Pressed key through provider computer input", key=key)
        elif context.humanizer:
            await context.humanizer.press_key(key)
        else:
            logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use SendKeysEvent")
            event = context.session.event_bus.dispatch(SendKeysEvent(keys=key))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="press_key",
            thinking=context.thinking,
            params={"key": key},
            result={"success": True},
        )
        return {"success": True, "message": ""}
    if context.action_name == "scroll":
        direction = context.params.get("direction", "down")
        amount = context.params.get("amount", 300)
        delta_y = amount if direction == "down" else -amount
        if context.humanizer:
            await context.humanizer.scroll(delta_y)
        else:
            logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use ScrollEvent")
            event = context.session.event_bus.dispatch(
                ScrollEvent(
                    direction=direction,
                    amount=amount,
                    node=context.element if context.index is not None else None,
                )
            )
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="scroll",
            thinking=context.thinking,
            index=context.index,
            params={"direction": direction, "amount": amount},
            result={"success": True},
        )
        return {"success": True, "message": ""}
    if context.action_name == "dropdown_options":
        if not context.element:
            return {"success": False, "error": "Dropdown requires an element index"}
        event = context.session.event_bus.dispatch(GetDropdownOptionsEvent(node=context.element))
        await event
        options = await event.event_result(raise_if_any=True, raise_if_none=False)
        return {"success": True, "message": f"Dropdown options: {options}", "options": options}
    if context.action_name == "select_dropdown":
        if not context.element:
            return {"success": False, "error": "Dropdown requires an element index"}
        value = context.params.get("value", "")
        event = context.session.event_bus.dispatch(
            SelectDropdownOptionEvent(node=context.element, text=value)
        )
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="select_dropdown",
            thinking=context.thinking,
            index=context.index,
            params={"value": value},
            result={"success": True},
        )
        return {"success": True, "message": ""}
    return await _execute_upload_file(
        session=context.session,
        dom_service=context.dom_service,
        action_history=context.action_history,
        element=context.element,
        index=context.index,
        params=context.params,
        thinking=context.thinking,
        humanizer=context.humanizer,
        available_file_paths=context.available_file_paths,
    )


async def _execute_navigation_action(context: _ActionContext) -> Dict[str, Any]:
    from browser_use.browser.events import GoBackEvent, NavigateToUrlEvent, WaitEvent

    if context.action_name == "goto":
        guard = _navigation_guard_error(
            context,
            action="goto",
            target_url=context.params.get("url") or "",
        )
        if guard:
            return await _refuse_navigation(
                context,
                action="goto",
                error=guard,
                params={"url": context.params.get("url")},
            )
        return await _execute_goto(
            session=context.session,
            dom_service=context.dom_service,
            action_history=context.action_history,
            params=context.params,
            thinking=context.thinking,
            session_id=context.session_id,
            config=context.config,
            current_auth_realm=context.current_auth_realm,
            prepare_credentials_for_url=context.prepare_credentials_for_url,
        )
    if context.action_name == "navback":
        guard = _navigation_guard_error(context, action="navback")
        if guard:
            return await _refuse_navigation(context, action="navback", error=guard)
        event = context.session.event_bus.dispatch(GoBackEvent())
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="navback",
            thinking=context.thinking,
            result={"success": True},
        )
        return {"success": True, "message": ""}
    if context.action_name == "wait":
        try:
            time_ms = normalize_browser_wait_ms(context.params.get("time_ms"), default=1000)
        except ValueError as error:
            return {"success": False, "error": str(error)}
        event = context.session.event_bus.dispatch(WaitEvent(seconds=time_ms / 1000.0))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="wait",
            thinking=context.thinking,
            params={"time_ms": time_ms},
            result={"success": True},
        )
        return {"success": True, "message": ""}
    if context.action_name == "switch_tab":
        guard = _navigation_guard_error(context, action="switch_tab")
        if guard:
            return await _refuse_navigation(
                context,
                action="switch_tab",
                error=guard,
                params={"tab_id": context.params.get("tab_id")},
            )
        return await _execute_switch_tab(
            session=context.session,
            dom_service=context.dom_service,
            action_history=context.action_history,
            params=context.params,
            thinking=context.thinking,
        )
    if context.action_name == "close_tab":
        guard = _navigation_guard_error(context, action="close_tab")
        if guard:
            return await _refuse_navigation(
                context,
                action="close_tab",
                error=guard,
                params={"tab_id": context.params.get("tab_id")},
            )
        return await _execute_close_tab(
            session=context.session,
            dom_service=context.dom_service,
            action_history=context.action_history,
            params=context.params,
            thinking=context.thinking,
        )

    url = context.params.get("url") or "about:blank"
    if context.action_name == "open_new_tab":
        guard = _navigation_guard_error(context, action="open_new_tab", target_url=url)
        if guard:
            return await _refuse_navigation(
                context,
                action="open_new_tab",
                error=guard,
                params={"url": url},
            )
    event = context.session.event_bus.dispatch(NavigateToUrlEvent(url=url, new_tab=True))
    await event
    await event.event_result(raise_if_any=True, raise_if_none=False)
    focused = context.session.get_focused_target()
    new_tab_id = focused.target_id[-4:] if focused else None
    await context.action_history.record_action(
        dom_service=context.dom_service,
        action="open_new_tab",
        thinking=context.thinking,
        params={"url": url},
        result={"success": True, "new_tab_id": new_tab_id},
    )
    logger.info(f"➕ Opened new tab {new_tab_id} with URL: {url}")
    return {"success": True, "message": "", "new_tab_id": new_tab_id, "url": url}


async def _execute_inspection_action(context: _ActionContext) -> Dict[str, Any]:
    if context.action_name == "read_network_requests":
        return await _execute_read_network_requests_action(context)
    if context.action_name == "evaluate":
        code = context.params.get("code", "")
        guard = _pinned_evaluate_guard_error(context, code)
        if guard:
            return await _refuse_navigation(
                context,
                action="evaluate",
                error=guard,
                params={"code": code[:500]},
            )
        cdp_session = await context.session.get_or_create_cdp_session(focus=True)
        result = await cdp_session.cdp_client.send.Runtime.evaluate(
            params={"expression": code, "returnByValue": True, "awaitPromise": True},
            session_id=cdp_session.session_id,
        )
        value = result.get("result", {}).get("value")
        # CDP returns exceptionDetails when the expression throws; surface that
        # instead of a silent null/empty value (async fetch failures used to look
        # like successful empty objects).
        exception = result.get("exceptionDetails")
        if exception:
            error_text = (
                exception.get("text")
                or (exception.get("exception") or {}).get("description")
                or "evaluate raised"
            )
            await context.action_history.record_action(
                dom_service=context.dom_service,
                action="evaluate",
                thinking=context.thinking,
                params={"code": code},
                result={"success": False, "error": error_text},
            )
            return {"success": False, "error": error_text, "value": value}
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="evaluate",
            thinking=context.thinking,
            params={"code": code},
            result={"success": True, "value": value},
        )
        return {"success": True, "message": f"Executed JS, result: {value}", "value": value}
    if context.action_name == "extract":
        return {"success": False, "error": "extract is disabled. Use evaluate to read DOM/page content directly."}
    return await _execute_screenshot(
        session=context.session,
        dom_service=context.dom_service,
        action_history=context.action_history,
        thinking=context.thinking,
        session_id=context.session_id,
        config=context.config,
    )


async def _execute_terminal_action(context: _ActionContext) -> Dict[str, Any]:
    if context.action_name == "request_payment_card":
        return await _execute_request_payment_card_action(context)
    if context.action_name == "done":
        text = context.params.get("text", "")
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="done",
            thinking=context.thinking,
            params={"text": text},
            result={"success": True},
        )
        return {"success": True, "done": True, "message": text}
    if context.action_name == "attempt_completion":
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="attempt_completion",
            thinking=context.thinking,
            params={},
            result={"success": True},
        )
        return {"success": True, "attempt_completion": True}
    if context.action_name == "send_message_to_user":
        message = context.params.get("message", "")
        reason = context.params.get("reason", "other")
        await context.action_history.record_action(
            dom_service=context.dom_service,
            action="send_message_to_user",
            thinking=context.thinking,
            params={"message": message, "reason": reason},
            result={"success": True},
        )
        return {"success": True, "message_to_user": True, "message": message, "reason": reason}
    return {
        "success": False,
        "error": (
            "Tool call error: generate_write_lock_notification is only for write-lock "
            "notification forks. Do not call this tool unless the latest user message "
            'explicitly contains the keyword "WRITE_LOCK_NOTIFICATION_FORK_REQUEST". '
            "Continue the browser task with a normal browser action."
        ),
    }


async def execute_action(
    dom_service: DOMService,
    action_history: ActionHistory,
    action: Dict[str, Any],
    available_file_paths: Optional[Dict[str, str]] = None,
    session_id: Optional[str] = None,
    config: Any = None,
    humanizer: Optional[BrowserHumanizer] = None,
    secret_refs: Optional[Dict[str, str]] = None,
    password_origins: Optional[Dict[str, str]] = None,
    credential_refs_by_secret_ref: Optional[Dict[str, Dict[str, str]]] = None,
    user_id: str = "",
    current_url: str = "",
    trusted_page_urls: Optional[List[str]] = None,
    write_lock_enabled: bool = True,
    write_lock_approvals: Optional[Dict[str, Dict]] = None,
    system_name: str = "Rose",
    browser_network_recorder: Optional[Any] = None,
    current_auth_realm: str = "",
    prepare_credentials_for_url: Optional[
        Callable[[str], Awaitable[Optional[Dict[str, Any]]]]
    ] = None,
    navigation_pin_host: Optional[str] = None,
    navigation_origin_base_domain: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a browser action using browser-use events.

    Returns:
        Result dict with success, message, and any additional data.
        May return {"status": "needs_write_approval", ...} if write lock triggered.
    """
    session = dom_service.session
    if not session:
        return {"success": False, "error": "Browser not connected"}

    action_name = action.get("action", "")
    index = action.get("index")
    params = action.get("params", {})
    thinking = action.get("thinking")
    coords = action.get("coordinates")

    # Anything that can make a relying party call navigator.credentials.get must
    # run against a target whose native WebAuthn UI is suppressed and whose
    # virtual authenticator holds our passkeys. Chrome scopes both per target, so
    # arming at connect (or at step start) strands them the moment the agent
    # follows a link into a new tab — which is how a real run ended up wedged
    # behind Chrome's own "No passkeys available" modal, a surface no CDP input
    # can reach. Arming here is idempotent and costs one round trip.
    if action_name in _CEREMONY_CAPABLE_ACTIONS:
        await dom_service.ensure_browser_overlays_suppressed()

    try:
        element = None
        if index is not None:
            element = dom_service.selector_map.get(index)
            if not element:
                return {"success": False, "error": f"Element with index {index} not found"}

        context = _ActionContext(
            dom_service=dom_service,
            action_history=action_history,
            session=session,
            action_name=action_name,
            index=index,
            params=params,
            thinking=thinking,
            coords=coords,
            element=element,
            available_file_paths=available_file_paths,
            session_id=session_id,
            user_id=user_id,
            config=config,
            humanizer=humanizer,
            secret_refs=secret_refs,
            password_origins=password_origins,
            credential_refs_by_secret_ref=credential_refs_by_secret_ref,
            current_url=current_url,
            trusted_page_urls=trusted_page_urls,
            write_lock_enabled=write_lock_enabled,
            write_lock_approvals=write_lock_approvals,
            system_name=system_name,
            browser_network_recorder=browser_network_recorder,
            current_auth_realm=current_auth_realm,
            prepare_credentials_for_url=prepare_credentials_for_url,
            navigation_pin_host=navigation_pin_host,
            navigation_origin_base_domain=navigation_origin_base_domain,
        )
        if action_name in _INTERACTION_ACTIONS:
            return await _execute_interaction_action(context)
        if action_name in _NAVIGATION_ACTIONS:
            return await _execute_navigation_action(context)
        if action_name in _INSPECTION_ACTIONS:
            return await _execute_inspection_action(context)
        if action_name in _TERMINAL_ACTIONS:
            return await _execute_terminal_action(context)
        return {"success": False, "error": f"Unknown action: {action_name}"}
    except Exception as error:
        logger.error(f"Action {action_name} failed: {error}")
        await action_history.record_action(
            dom_service=dom_service,
            action=action_name,
            thinking=thinking,
            index=index,
            coordinates=coords,
            params=params,
            result={"success": False, "error": str(error)},
        )
        return {"success": False, "error": str(error)}


# ========================================
# PRIVATE ACTION HELPERS
# ========================================


def _element_write_lock_signal(element: Any) -> str:
    """Collect a DOM target's action signal, including its nearest bounded ancestor label."""
    if not element:
        return ""

    parts: list[str] = []

    def node_text(node: Any) -> str:
        try:
            if hasattr(node, "get_all_children_text"):
                return str(node.get_all_children_text() or "").strip()
        except Exception:
            pass
        return ""

    local_text = node_text(element)
    if local_text:
        parts.append(local_text)

    attrs = getattr(element, "attributes", None) or {}
    if not isinstance(attrs, dict):
        attrs = {}

    for attr_name in ("value", "aria-label", "title", "alt", "name", "id", "role", "type"):
        value = attrs.get(attr_name)
        if value:
            parts.append(str(value))

    # Browser controls implemented inside shadow DOM commonly expose a textless
    # input while rendering the accessible action label as a sibling. The DOM
    # tree preserves that relationship through parent_node, so take only the
    # first short ancestor label instead of absorbing a whole checkout page.
    has_local_label = bool(local_text) or any(
        attrs.get(attr_name) for attr_name in ("value", "aria-label", "title", "alt")
    )
    if not has_local_label:
        current = getattr(element, "parent_node", None)
        depth = 1
        while current is not None and depth < 4:
            node_name = str(getattr(current, "node_name", "") or "").lower()
            if node_name in {"html", "body", "main"}:
                break

            ancestor_text = node_text(current)
            if ancestor_text and len(ancestor_text) <= 500:
                parts.append(ancestor_text)
                break

            current = getattr(current, "parent_node", None)
            depth += 1

    return "\n".join(part for part in parts if part)[:20000]


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _refresh_element_coordinates(
    dom_service: Any,
    index: Any,
    *,
    for_click: bool = False,
) -> Optional[tuple[int, int]]:
    """Refresh DOM state once and retry coordinate resolution for stale selector entries."""
    if index is None:
        return None

    refresh = getattr(dom_service, "get_browser_state", None)
    if callable(refresh):
        try:
            await _maybe_await(refresh(include_screenshot=False))
        except TypeError:
            await _maybe_await(refresh(False))
        except Exception as exc:
            logger.debug("DOM refresh before coordinate retry failed", index=index, error=str(exc))

    coordinate_method = "get_click_coordinates" if for_click else "get_element_coordinates"
    coords = getattr(dom_service, coordinate_method, None)
    if not callable(coords):
        return None

    return await _maybe_await(coords(index))


def _normalize_js_evaluate_result(result: Any) -> Optional[Dict[str, Any]]:
    """Normalize page/frame/CDP evaluate payloads to a dict (or None)."""
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        text = result.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


# Shared semantic payment-field finder used by coordinate lookup + direct fill.
# Intentionally host/path agnostic: autocomplete / name / aria / placeholder only.
# Pierces open shadow roots (hosted payment widgets nest inputs there).
_PAYMENT_FIELD_FINDER_JS = """
(() => {
    const selectorsByRef = {
        card_number: [
            'input[data-elements-stable-field-name="cardNumber"]',
            'input[data-elements-stable-field-name="number"]',
            'input[autocomplete="cc-number"]',
            'input[autocomplete~="cc-number"]',
            'input#card-number',
            'input[name="card-number"]',
            'input[name="card_number"]',
            'input[name="number"]',
            'input[name="cardnumber"]',
            'input[id*="card"][id*="number"]',
            'input[name*="card"][name*="number"]',
            'input[placeholder*="Card number" i]',
            'input[aria-label*="Card number" i]'
        ],
        card_name: [
            'input[data-elements-stable-field-name="cardName"]',
            'input[data-elements-stable-field-name="name"]',
            'input[autocomplete="cc-name"]',
            'input[autocomplete~="cc-name"]',
            'input#card-name',
            'input[name="card-name"]',
            'input[name="card_name"]',
            'input[name="name"]',
            'input[id*="card"][id*="name"]',
            'input[name*="card"][name*="name"]',
            'input[placeholder*="Name on card" i]',
            'input[aria-label*="Name on card" i]'
        ],
        card_expiry: [
            'input[data-elements-stable-field-name="cardExpiry"]',
            'input[data-elements-stable-field-name="expiry"]',
            'input[autocomplete="cc-exp"]',
            'input[autocomplete~="cc-exp"]',
            'input#card-expiry',
            'input[name="card-expiry"]',
            'input[name="card_expiry"]',
            'input[name="exp-date"]',
            'input[name="expiry"]',
            'input[id*="expir"]',
            'input[name*="expir"]',
            'input[placeholder*="MM/YY"]',
            'input[placeholder*="MM / YY"]',
            'input[aria-label*="Expir" i]'
        ],
        card_cvv: [
            'input[data-elements-stable-field-name="cardCvc"]',
            'input[data-elements-stable-field-name="cvc"]',
            'input[autocomplete="cc-csc"]',
            'input[autocomplete~="cc-csc"]',
            'input#card-cvv',
            'input#card-cvc',
            'input[name="card-cvv"]',
            'input[name="card_cvv"]',
            'input[name="cvc"]',
            'input[name="cvv"]',
            'input[id*="cvv"]',
            'input[id*="cvc"]',
            'input[id*="security"]',
            'input[name*="security"]',
            'input[aria-label*="CVC" i]',
            'input[aria-label*="CVV" i]',
            'input[aria-label*="Security code" i]'
        ],
    };
    const patternsByRef = {
        card_number: ['cc-number', 'card number', 'card-number', 'card_number', 'cardnumber'],
        card_name: ['cc-name', 'cardholder', 'card holder', 'name on card', 'card name', 'card-name', 'card_name'],
        card_expiry: ['cc-exp', 'expiration', 'expiry', 'exp date', 'mm/yy', 'mm / yy'],
        card_cvv: ['cc-csc', 'cvv', 'cvc', 'security code', 'security-code', 'security_code'],
    };
    // High-confidence selectors may mount readOnly / zero-size until focused
    // (hosted payment widgets). Still reject disabled + display:none.
    const isHighConfidenceSelector = (selector) =>
        typeof selector === 'string' && (
            selector.includes('autocomplete')
            || selector.includes('data-elements-stable-field-name')
        );
    const isVisible = (el, { allowCollapsed = false } = {}) => {
        if (!el || el.disabled) return false;
        if (el.readOnly && !allowCollapsed) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        const rect = el.getBoundingClientRect();
        if (allowCollapsed) return true;
        return rect.width > 0 && rect.height > 0;
    };
    const queryDeep = (root, selector) => {
        const out = [];
        const visit = (node) => {
            if (!node || !node.querySelectorAll) return;
            try {
                node.querySelectorAll(selector).forEach((el) => out.push(el));
            } catch (_) {}
            try {
                node.querySelectorAll('*').forEach((el) => {
                    if (el.shadowRoot) visit(el.shadowRoot);
                });
            } catch (_) {}
        };
        visit(root);
        return out;
    };
    const addText = (parts, value) => {
        if (typeof value !== 'string') return;
        const trimmed = value.trim();
        if (trimmed) parts.push(trimmed);
    };
    const signalFor = (el) => {
        const parts = [];
        for (const attr of ['autocomplete', 'name', 'id', 'placeholder', 'aria-label', 'title']) {
            addText(parts, el.getAttribute(attr));
        }
        const id = el.getAttribute('id');
        if (id) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) addText(parts, label.innerText || label.textContent);
        }
        const wrappingLabel = el.closest('label');
        if (wrappingLabel) addText(parts, wrappingLabel.innerText || wrappingLabel.textContent);
        return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    };
    const findField = (refName) => {
        for (const selector of selectorsByRef[refName] || []) {
            const allowCollapsed = isHighConfidenceSelector(selector);
            for (const el of queryDeep(document, selector)) {
                if (isVisible(el, { allowCollapsed })) {
                    return { el, selector, score: 100 };
                }
            }
        }
        let best = null;
        for (const el of queryDeep(document, 'input, textarea')) {
            if (!isVisible(el)) continue;
            const signal = signalFor(el);
            let score = 0;
            for (const pattern of patternsByRef[refName] || []) {
                if (signal.includes(pattern)) score += pattern.length;
            }
            if (refName === 'card_name' && signal.includes('name') && signal.includes('card')) score += 12;
            if (refName === 'card_number' && signal.includes('card') && signal.includes('number')) score += 12;
            if (refName === 'card_expiry' && signal.includes('exp')) score += 8;
            if (refName === 'card_cvv' && (signal.includes('security') || signal.includes('cvv') || signal.includes('cvc'))) score += 8;
            if (!best || score > best.score) best = { el, selector: 'semantic-payment-field', score, signal };
        }
        return best && best.score > 0 ? best : null;
    };
    return { findField, isVisible };
})()
"""

# Playwright locator selectors — pierces open shadow DOM in frames.
_PAYMENT_REF_PLAYWRIGHT_SELECTORS: Dict[str, tuple[str, ...]] = {
    "card_number": (
        'input[data-elements-stable-field-name="cardNumber"]',
        'input[data-elements-stable-field-name="number"]',
        'input[autocomplete="cc-number"]',
        'input[autocomplete~="cc-number"]',
        'input[name="number"]',
        'input[name="cardnumber"]',
        'input[name="card-number"]',
        'input[name="card_number"]',
        "#card-number",
        'input[placeholder*="Card number" i]',
        'input[aria-label*="Card number" i]',
    ),
    "card_name": (
        'input[data-elements-stable-field-name="cardName"]',
        'input[data-elements-stable-field-name="name"]',
        'input[autocomplete="cc-name"]',
        'input[autocomplete~="cc-name"]',
        'input[name="name"]',
        'input[name="card-name"]',
        'input[name="card_name"]',
        "#card-name",
        'input[placeholder*="Name on card" i]',
        'input[aria-label*="Name on card" i]',
    ),
    "card_expiry": (
        'input[data-elements-stable-field-name="cardExpiry"]',
        'input[data-elements-stable-field-name="expiry"]',
        'input[autocomplete="cc-exp"]',
        'input[autocomplete~="cc-exp"]',
        'input[name="exp-date"]',
        'input[name="expiry"]',
        'input[name="card-expiry"]',
        'input[placeholder*="MM" i]',
        'input[aria-label*="Expir" i]',
    ),
    "card_cvv": (
        'input[data-elements-stable-field-name="cardCvc"]',
        'input[data-elements-stable-field-name="cvc"]',
        'input[autocomplete="cc-csc"]',
        'input[autocomplete~="cc-csc"]',
        'input[name="cvc"]',
        'input[name="cvv"]',
        "#card-cvc",
        "#card-cvv",
        'input[aria-label*="CVC" i]',
        'input[aria-label*="CVV" i]',
        'input[aria-label*="Security code" i]',
    ),
}

# Accessible-name / placeholder patterns for Playwright get_by_* (host-agnostic).
_PAYMENT_REF_PLAYWRIGHT_LABELS: Dict[str, tuple[str, ...]] = {
    "card_number": (r"card number", r"card num", r"nummer", r"número"),
    "card_name": (r"name on card", r"cardholder", r"card holder", r"nombre"),
    "card_expiry": (r"expir", r"mm\s*/?\s*yy", r"mm\s*/?\s*aaaa"),
    "card_cvv": (r"cvc", r"cvv", r"security code", r"código"),
}

# Hosted checkout widgets often isolate each field in a titled iframe
# ("Secure card number input frame"). Title text is semantic — not a host allowlist.
_PAYMENT_REF_IFRAME_TITLE_PATTERNS: Dict[str, tuple[str, ...]] = {
    "card_number": ("card number", "cardnumber", "cc-number"),
    "card_name": ("name on card", "cardholder", "card name", "name input"),
    "card_expiry": ("expir", "exp date", "mm / yy", "mm/yy"),
    "card_cvv": ("cvc", "cvv", "security code", "securitycode"),
}

_PAYMENT_REF_LOCATE_JS = f"""
(refName) => {{
    const {{ findField }} = {_PAYMENT_FIELD_FINDER_JS};
    const match = findField(refName);
    if (!match) return null;
    match.el.scrollIntoView({{ block: 'center', inline: 'nearest' }});
    const rect = match.el.getBoundingClientRect();
    return {{
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        selector: match.selector,
        score: match.score,
        signal: (match.signal || '').slice(0, 120),
    }};
}}
"""

_PAYMENT_REF_FOCUS_JS = f"""
(refName) => {{
    const {{ findField }} = {_PAYMENT_FIELD_FINDER_JS};
    const match = findField(refName);
    if (!match) return {{ focused: false, reason: 'field_not_found' }};
    const el = match.el;
    el.scrollIntoView({{ block: 'center', inline: 'nearest' }});
    el.focus();
    const rect = el.getBoundingClientRect();
    return {{
        focused: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        selector: match.selector,
        score: match.score,
    }};
}}
"""

_PAYMENT_REF_FILL_JS = f"""
({{ refName, value }}) => {{
    const {{ findField }} = {_PAYMENT_FIELD_FINDER_JS};
    const match = findField(refName);
    if (!match) return {{ filled: false, reason: 'field_not_found' }};
    const el = match.el;
    el.scrollIntoView({{ block: 'center', inline: 'nearest' }});
    el.focus();
    const prototype = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {{
        descriptor.set.call(el, value);
    }} else {{
        el.value = value;
    }}
    el.dispatchEvent(new InputEvent('input', {{
        bubbles: true,
        inputType: 'insertReplacementText',
        data: value,
    }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    const rect = el.getBoundingClientRect();
    return {{
        filled: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        selector: match.selector,
        score: match.score,
        valueLength: String(el.value || '').length,
    }};
}}
"""



def _explicit_session_callable(session: Any, *names: str) -> Optional[Callable[..., Any]]:
    """Return a callable explicitly present on the session (skip MagicMock auto-attrs)."""
    if session is None:
        return None
    instance_dict = getattr(session, "__dict__", {}) or {}
    for name in names:
        if name in instance_dict and callable(instance_dict[name]):
            return instance_dict[name]
    session_type = type(session)
    for name in names:
        if name in getattr(session_type, "__dict__", {}):
            attr = getattr(session, name, None)
            if callable(attr):
                return attr
    return None


def _playwright_frames(input_page: Any) -> List[Any]:
    if input_page is None:
        return []
    frames = getattr(input_page, "frames", None)
    if callable(frames):
        try:
            frames = frames()
        except Exception:
            frames = None
    # Playwright exposes .frames as a list. MagicMock.frames is another MagicMock —
    # never treat that as a document root or we steal evaluate calls from real pages.
    if isinstance(frames, list):
        return list(frames)
    return []


def _humanizer_input_page(humanizer: Optional[BrowserHumanizer]) -> Any:
    if humanizer is None:
        return None
    if "input_page" not in getattr(humanizer, "__dict__", {}):
        return None
    return getattr(humanizer, "input_page", None)


async def _iter_payment_fill_targets(
    session: Any,
    input_page: Any = None,
) -> List[tuple[str, Any]]:
    """Yield (label, target) pairs for every reachable document (main + iframes).

    Prefer Playwright frames (trusted keyboard focus path), then the browser-use
    page, then CDP iframe/page targets. No host/path filters.
    """
    targets: List[tuple[str, Any]] = []
    seen_cdp_targets: set[str] = set()

    for index, frame in enumerate(_playwright_frames(input_page)):
        targets.append((f"playwright:{index}", frame))

    get_page = _explicit_session_callable(session, "get_page", "get_current_page")
    if get_page is not None:
        try:
            page = await _maybe_await(get_page())
        except Exception:
            page = None
        if page is not None and hasattr(page, "evaluate"):
            targets.append(("browser_use:page", page))

    get_all_frames = _explicit_session_callable(session, "get_all_frames")
    get_cdp = _explicit_session_callable(session, "get_or_create_cdp_session")
    if get_all_frames is not None and get_cdp is not None:
        all_frames: Dict[str, Any] = {}
        try:
            frames_result = await _maybe_await(get_all_frames())
            if isinstance(frames_result, tuple) and frames_result and isinstance(frames_result[0], dict):
                all_frames = frames_result[0]
            elif isinstance(frames_result, dict):
                all_frames = frames_result
        except Exception as exc:
            logger.debug("Payment fill get_all_frames failed", error=str(exc))
            all_frames = {}
        for _frame_id, info in all_frames.items():
            if not isinstance(info, dict):
                continue
            target_id = info.get("frameTargetId")
            if not target_id or str(target_id) in seen_cdp_targets:
                continue
            seen_cdp_targets.add(str(target_id))
            try:
                cdp_session = await _maybe_await(get_cdp(target_id, focus=False))
            except TypeError:
                try:
                    cdp_session = await _maybe_await(get_cdp(target_id))
                except Exception:
                    continue
            except Exception:
                continue
            if cdp_session is not None and hasattr(cdp_session, "cdp_client"):
                targets.append((f"cdp:{str(target_id)[:12]}", ("cdp", cdp_session)))

    if get_cdp is not None and not targets:
        try:
            cdp_session = await _maybe_await(get_cdp(focus=True))
        except Exception:
            cdp_session = None
        if cdp_session is not None and hasattr(cdp_session, "cdp_client"):
            targets.append(("cdp:focus", ("cdp", cdp_session)))

    return targets


async def _evaluate_on_payment_fill_target(
    target: Any,
    script: str,
    arg: Any,
) -> Optional[Dict[str, Any]]:
    """Run JS against a Playwright frame/page or a CDP session target."""
    try:
        if isinstance(target, tuple) and len(target) == 2 and target[0] == "cdp":
            cdp_session = target[1]
            expression = f"({script})({json.dumps(arg)})"
            cdp_result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": expression, "returnByValue": True, "awaitPromise": True},
                session_id=cdp_session.session_id,
            )
            return _normalize_js_evaluate_result((cdp_result or {}).get("result", {}).get("value"))

        evaluate = getattr(target, "evaluate", None)
        if not callable(evaluate):
            return None
        raw = await _maybe_await(evaluate(script, arg))
        return _normalize_js_evaluate_result(raw)
    except Exception as exc:
        logger.debug("Payment fill target evaluate failed", error=str(exc)[:200])
        return None


async def _payment_ref_iframe_title_present(input_page: Any, ref_name: str) -> bool:
    """True when a semantically titled payment iframe has an attached input."""
    if input_page is None or ref_name not in _PAYMENT_REF_IFRAME_TITLE_PATTERNS:
        return False
    if not hasattr(input_page, "frame_locator"):
        return False
    for pattern in _PAYMENT_REF_IFRAME_TITLE_PATTERNS[ref_name]:
        try:
            frame = input_page.frame_locator(f'iframe[title*="{pattern}" i]')
            locator = frame.locator("input, textarea").first
            count = await _maybe_await(locator.count())
            if isinstance(count, int) and not isinstance(count, bool) and count >= 1:
                return True
        except Exception:
            continue
    return False


async def _resolve_payment_ref_via_iframe_title(
    input_page: Any,
    ref_name: str,
) -> Optional[tuple[int, int]]:
    """Locate a payment input inside a semantically titled iframe (host-agnostic)."""
    if input_page is None or ref_name not in _PAYMENT_REF_IFRAME_TITLE_PATTERNS:
        return None
    if not hasattr(input_page, "frame_locator"):
        return None
    for pattern in _PAYMENT_REF_IFRAME_TITLE_PATTERNS[ref_name]:
        try:
            frame = input_page.frame_locator(f'iframe[title*="{pattern}" i]')
            locator = frame.locator("input, textarea").first
            count = await _maybe_await(locator.count())
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                continue
            box = await _maybe_await(locator.bounding_box())
            if not isinstance(box, dict) or box.get("x") is None:
                continue
            return (
                int(box["x"] + (box.get("width") or 0) / 2),
                int(box["y"] + (box.get("height") or 0) / 2),
            )
        except Exception as exc:
            logger.debug(
                "Payment ref iframe-title locate miss",
                ref_name=ref_name,
                pattern=pattern,
                error=str(exc)[:160],
            )
    return None


async def _resolve_payment_ref_coordinates(
    session: Any,
    ref_name: str,
    *,
    input_page: Any = None,
) -> Optional[tuple[int, int]]:
    """Resolve coordinates for a visible payment input by semantic card ref."""
    if not session or ref_name not in PAYMENT_CARD_SECRET_REFS:
        return None

    iframe_coords = await _resolve_payment_ref_via_iframe_title(input_page, ref_name)
    if iframe_coords is not None:
        logger.debug(
            "Resolved payment ref coordinates via iframe title",
            ref_name=ref_name,
            coords=iframe_coords,
        )
        return iframe_coords

    for label, target in await _iter_payment_fill_targets(session, input_page):
        result = await _evaluate_on_payment_fill_target(target, _PAYMENT_REF_LOCATE_JS, ref_name)
        if not result:
            continue
        if isinstance(result.get("x"), (int, float)) and isinstance(result.get("y"), (int, float)):
            logger.debug(
                "Resolved payment ref coordinates",
                ref_name=ref_name,
                target=label,
                selector=result.get("selector"),
            )
            return int(result["x"]), int(result["y"])
    return None


_PAYMENT_METHOD_EXPAND_JS = """
(_unused) => {
    const pattern = /\\b(card|credit|debit|pay with card|card information|payment method)\\b/i;
    const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], [role="radio"], [role="tab"], label, a, [role="option"]'
    ));
    for (const el of candidates) {
        const signal = [
            el.getAttribute('aria-label') || '',
            el.getAttribute('title') || '',
            el.innerText || '',
            el.textContent || '',
        ].join(' ').replace(/\\s+/g, ' ').trim();
        if (!pattern.test(signal)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        el.click();
        return { clicked: true, signal: signal.slice(0, 120) };
    }
    return { clicked: false };
}
"""


async def _nudge_payment_method_expand(
    session: Any,
    *,
    input_page: Any = None,
) -> bool:
    """Click a generic Card/Credit/Debit control if payment inputs are hidden behind it."""
    for label, target in await _iter_payment_fill_targets(session, input_page):
        result = await _evaluate_on_payment_fill_target(target, _PAYMENT_METHOD_EXPAND_JS, None)
        if result and result.get("clicked") is True:
            logger.info(
                "Expanded payment method control before fill",
                target=label,
                signal=result.get("signal"),
            )
            return True
    return False


async def wait_for_payment_ref_fields(
    session: Any,
    *,
    ref_names: Optional[List[str]] = None,
    input_page: Any = None,
    timeout_seconds: float = 15.0,
    poll_interval_seconds: float = 0.5,
) -> bool:
    """Poll every reachable frame until semantic payment inputs appear.

    Main-document navigation readiness is not enough — hosted payment widgets
    mount card inputs in child frames several seconds later.
    """
    names = list(ref_names or ["card_number"])
    targets = await _iter_payment_fill_targets(session, input_page)
    # Titled payment iframes may exist even when evaluate targets are empty.
    if not targets and input_page is None:
        return False
    deadline = time_module.monotonic() + max(0.5, float(timeout_seconds))
    nudged = False
    while True:
        for name in names:
            if await _payment_ref_iframe_title_present(input_page, name):
                return True
            if await _resolve_payment_ref_coordinates(session, name, input_page=input_page):
                return True
        if not nudged and time_module.monotonic() + 2.0 < deadline:
            nudged = True
            await _nudge_payment_method_expand(session, input_page=input_page)
        if time_module.monotonic() >= deadline:
            return False
        await asyncio.sleep(poll_interval_seconds)


async def _fill_payment_ref_via_playwright_locator(
    *,
    input_page: Any,
    ref_name: str,
    value: str,
    humanizer: Optional[BrowserHumanizer],
) -> Optional[Dict[str, Any]]:
    """Fill via Playwright locators (pierces open shadow DOM across frames)."""
    if not value or input_page is None or ref_name not in _PAYMENT_REF_PLAYWRIGHT_SELECTORS:
        return None
    roots: List[Any] = list(_playwright_frames(input_page))
    if not roots and hasattr(input_page, "locator"):
        roots = [input_page]

    async def _try_locator(root: Any, root_index: int, locator: Any, selector: str) -> Optional[Dict[str, Any]]:
        try:
            count = await _maybe_await(locator.count())
            # MagicMock.__int__ returns 1 — require a real int from Playwright.
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                return None
            first = locator.first if hasattr(locator, "first") else locator
            await _maybe_await(first.scroll_into_view_if_needed())
            await _maybe_await(first.click(timeout=2500))
            if humanizer is not None:
                await humanizer.press_key("Control+a")
                await humanizer.press_key("Backspace")
                await humanizer.type_text(value)
            else:
                fill = getattr(first, "fill", None)
                if not callable(fill):
                    return None
                await _maybe_await(fill(""))
                press_seq = getattr(first, "press_sequentially", None)
                if callable(press_seq):
                    await _maybe_await(press_seq(value, delay=35))
                else:
                    await _maybe_await(fill(value))
            box = None
            with suppress(Exception):
                box = await _maybe_await(first.bounding_box())
            logger.info(
                "Filled payment card secret ref via Playwright locator",
                ref_name=ref_name,
                selector=selector,
                root=f"playwright:{root_index}",
            )
            result: Dict[str, Any] = {
                "filled": True,
                "selector": selector,
                "score": 100,
                "method": "playwright_locator",
                "target": f"playwright:{root_index}",
                "valueLength": len(value),
            }
            if isinstance(box, dict) and box.get("x") is not None:
                result["x"] = int(box["x"] + (box.get("width") or 0) / 2)
                result["y"] = int(box["y"] + (box.get("height") or 0) / 2)
            return result
        except Exception as exc:
            logger.debug(
                "Payment ref Playwright locator miss",
                ref_name=ref_name,
                selector=selector,
                error=str(exc)[:160],
            )
            return None

    # Prefer semantically titled payment iframes (hosted field isolation).
    if hasattr(input_page, "frame_locator"):
        for pattern in _PAYMENT_REF_IFRAME_TITLE_PATTERNS.get(ref_name, ()):
            frame = input_page.frame_locator(f'iframe[title*="{pattern}" i]')
            hit = await _try_locator(
                input_page,
                0,
                frame.locator("input, textarea"),
                f'iframe[title*="{pattern}" i] >> input',
            )
            if hit:
                hit["method"] = "playwright_iframe_title"
                return hit

    for root_index, root in enumerate(roots):
        if not hasattr(root, "locator"):
            continue
        for selector in _PAYMENT_REF_PLAYWRIGHT_SELECTORS[ref_name]:
            hit = await _try_locator(root, root_index, root.locator(selector), selector)
            if hit:
                return hit
        # Accessible name / placeholder — hosted widgets often omit autocomplete
        # until the user focuses a labeled control.
        for pattern in _PAYMENT_REF_PLAYWRIGHT_LABELS.get(ref_name, ()):
            for getter_name in ("get_by_label", "get_by_placeholder"):
                getter = getattr(root, getter_name, None)
                if not callable(getter):
                    continue
                try:
                    locator = getter(re.compile(pattern, re.I))
                except Exception:
                    continue
                hit = await _try_locator(
                    root,
                    root_index,
                    locator,
                    f"{getter_name}(/{pattern}/i)",
                )
                if hit:
                    return hit
    return None


async def _fill_payment_ref_via_keyboard(
    *,
    session: Any,
    ref_name: str,
    value: str,
    input_page: Any,
    humanizer: Optional[BrowserHumanizer],
) -> Optional[Dict[str, Any]]:
    """Focus a semantic payment field (any frame) and type with real key events.

    Hosted payment widgets often ignore programmatic value-sets; keyboard events
    after focus work across same- and cross-origin frames without vendor logic.
    """
    if not value or (humanizer is None and input_page is None):
        return None

    # Focus may land in a CDP-only OOPIF; type through page keyboard/humanizer
    # so controlled inputs that reject JS value-set still receive real key events.
    for label, target in await _iter_payment_fill_targets(session, input_page):
        located = await _evaluate_on_payment_fill_target(target, _PAYMENT_REF_FOCUS_JS, ref_name)
        if not located or located.get("focused") is not True:
            continue
        try:
            if humanizer is not None:
                await humanizer.press_key("Control+a")
                await humanizer.press_key("Backspace")
                await humanizer.type_text(value)
            else:
                keyboard = getattr(input_page, "keyboard", None)
                if keyboard is None:
                    continue
                await _maybe_await(keyboard.press("Control+a"))
                await _maybe_await(keyboard.press("Backspace"))
                type_fn = getattr(keyboard, "type", None)
                if not callable(type_fn):
                    continue
                await _maybe_await(type_fn(value, delay=40))
        except Exception as exc:
            logger.debug(
                "Payment ref keyboard fill failed",
                ref_name=ref_name,
                target=label,
                error=str(exc)[:200],
            )
            continue
        logger.info(
            "Filled payment card secret ref via keyboard",
            ref_name=ref_name,
            target=label,
            selector=located.get("selector"),
        )
        return {
            "filled": True,
            "x": located.get("x"),
            "y": located.get("y"),
            "selector": located.get("selector"),
            "score": located.get("score"),
            "method": "keyboard",
            "target": label,
            "valueLength": len(value),
        }
    return None


async def _fill_payment_ref_directly(
    session: Any,
    ref_name: str,
    value: str,
    *,
    input_page: Any = None,
    humanizer: Optional[BrowserHumanizer] = None,
) -> Optional[Dict[str, Any]]:
    """Fill an approved one-time payment-card ref into its semantic field.

    Searches every reachable frame/document (Playwright frames + CDP iframe
    targets). Order: Playwright locator (shadow-DOM capable) → JS value-set →
    focus+keyboard. No merchant/CDN host or path allowlists.
    """
    if not session or ref_name not in PAYMENT_CARD_SECRET_REFS:
        return None

    payload = {"refName": ref_name, "value": value}
    if input_page is None:
        input_page = _humanizer_input_page(humanizer)

    locator_result = await _fill_payment_ref_via_playwright_locator(
        input_page=input_page,
        ref_name=ref_name,
        value=value,
        humanizer=humanizer,
    )
    if locator_result:
        return locator_result

    expected_len = len(str(value or ""))
    saw_empty_js_value = False
    saw_any_target = False
    for label, target in await _iter_payment_fill_targets(session, input_page):
        saw_any_target = True
        result = await _evaluate_on_payment_fill_target(target, _PAYMENT_REF_FILL_JS, payload)
        if not result or result.get("filled") is not True:
            continue
        # Controlled/secure inputs often report empty value after a fake set —
        # only then fall through to keyboard (do not keyboard-probe after plain
        # field_not_found; that steals later evaluate side-effects in tests and
        # burns focus on documents without payment fields).
        if "valueLength" in result and expected_len > 0 and int(result.get("valueLength") or 0) == 0:
            saw_empty_js_value = True
            logger.debug(
                "Payment ref JS fill left empty value; trying keyboard",
                ref_name=ref_name,
                target=label,
            )
            continue
        result = dict(result)
        result["method"] = "js"
        result["target"] = label
        logger.info(
            "Filled payment card secret ref via JS",
            ref_name=ref_name,
            target=label,
            selector=result.get("selector"),
        )
        return result

    # Prefer keyboard when JS left an empty controlled input, or when Playwright
    # frames / documents are available (hosted widgets often reject value-set).
    if saw_empty_js_value or _playwright_frames(input_page) or (input_page is not None and saw_any_target):
        keyboard_result = await _fill_payment_ref_via_keyboard(
            session=session,
            ref_name=ref_name,
            value=value,
            input_page=input_page,
            humanizer=humanizer,
        )
        if keyboard_result:
            return keyboard_result

    logger.debug("Payment ref direct fill did not find a target", ref_name=ref_name)
    return None


async def _browser_click_write_lock_signal(session: Any, coords: Optional[Dict[str, Any]]) -> str:
    """Collect text/attributes from the element hit by a click and its composed ancestor path."""
    if not session or not coords:
        return ""

    try:
        get_page = getattr(session, "get_page", None)
        if not callable(get_page):
            return ""

        page = await _maybe_await(get_page())
        if not page or not hasattr(page, "evaluate"):
            return ""

        signal = await _maybe_await(
            page.evaluate(
                """
                    ({ x, y }) => {
                        const parts = [];
                        const seen = new Set();
                        const maxDepth = 4;
                        const maxTextLength = 500;
                        const attrNames = [
                            'value',
                            'aria-label',
                            'title',
                            'alt',
                            'name',
                            'id',
                            'role',
                            'type',
                        ];

                        const add = (value) => {
                            if (typeof value !== 'string') return;
                            const trimmed = value.trim();
                            if (trimmed) parts.push(trimmed);
                        };

                        const addText = (value) => {
                            if (typeof value !== 'string') return;
                            const trimmed = value.trim();
                            if (!trimmed || trimmed.length > maxTextLength) return;
                            parts.push(trimmed);
                        };

                        const isPageContainer = (el) => {
                            if (!el || !el.tagName) return false;
                            const tag = el.tagName.toLowerCase();
                            return tag === 'html' || tag === 'body' || tag === 'main';
                        };

                        const addElement = (el, includeText) => {
                            if (!el || seen.has(el)) return false;
                            seen.add(el);
                            let addedText = false;

                            if (includeText && !isPageContainer(el)) {
                                const before = parts.length;
                                addText(el.innerText);
                                if (el.textContent !== el.innerText) addText(el.textContent);
                                addedText = parts.length > before;
                            }

                            for (const attrName of attrNames) {
                                if (el.getAttribute) add(el.getAttribute(attrName));
                            }

                            if (el.labels) {
                                for (const label of el.labels) {
                                    const before = parts.length;
                                    add(label.innerText);
                                    add(label.textContent);
                                    addedText = addedText || parts.length > before;
                                }
                            }
                            return addedText;
                        };

                        const walkAncestors = (start, includeStartText) => {
                            let current = start;
                            let depth = 0;
                            let seekNearestText = includeStartText;
                            while (current && depth < maxDepth) {
                                const addedText = addElement(current, seekNearestText);
                                if (addedText) seekNearestText = false;
                                if (isPageContainer(current)) break;
                                if (current.assignedSlot) {
                                    current = current.assignedSlot;
                                } else if (current.parentElement) {
                                    current = current.parentElement;
                                } else {
                                    const root = current.getRootNode && current.getRootNode();
                                    current = root && root.host ? root.host : null;
                                }
                                depth += 1;
                            }
                        };

                        const hit = document.elementFromPoint(Number(x), Number(y));
                        const interactive = hit && hit.closest && hit.closest(
                            'button,input,select,textarea,a,[role="button"],[role="link"],[onclick]'
                        );
                        walkAncestors(interactive || hit, true);
                        if (hit && hit !== interactive) {
                            addElement(hit, true);
                        }

                        return parts.join('\\n').slice(0, 20000);
                    }
                """,
                {"x": int(coords["x"]), "y": int(coords["y"])},
            )
        )
        return signal if isinstance(signal, str) else ""
    except Exception as e:
        logger.debug("Unable to collect browser click write-lock signal", error=str(e))
        return ""


async def _click_write_lock_result(
    *,
    session: Any,
    dom_service: DOMService,
    element: Any,
    index: Any,
    coords: Any,
    write_lock_approvals: Optional[Dict],
    current_url: str,
    system_name: str,
    secret_refs: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, Any]]:
    from browser_tools.write_lock import (
        get_write_lock_approval_question,
        is_email_send_button,
        is_purchase_button,
        is_social_domain,
        is_submit_button,
    )

    coordinate_click = element is None
    if coordinate_click:
        element_text = "\n".join(
            part
            for part in (
                await _maybe_await(dom_service.get_text_at_coordinates(int(coords["x"]), int(coords["y"]))),
                await _browser_click_write_lock_signal(session, coords),
            )
            if part
        )
        logger.info(
            "Write lock coord click check",
            element_text=element_text[:100] if element_text else "(empty)",
            coords=coords,
            url=current_url[:80] if current_url else None,
        )
    else:
        element_text = "\n".join(
            part
            for part in (
                _element_write_lock_signal(element),
                await _browser_click_write_lock_signal(session, coords),
            )
            if part
        )
        logger.info(
            "Write lock click check",
            element_text=element_text[:100] if element_text else "(empty)",
            index=index,
            url=current_url[:80] if current_url else None,
        )

    checks = (
        ("social_post", is_social_domain(current_url) and is_submit_button(element_text), "social posting"),
        ("email_send", is_email_send_button(element_text), "email send"),
        ("purchase", is_purchase_button(element_text), "purchase button"),
    )
    suffix = " (coordinate click)" if coordinate_click else ""
    minted_card_unlocks_purchase = has_payment_card_secret_refs(secret_refs)
    for approval_type, detected, description in checks:
        if not detected:
            continue
        if is_approval_valid(write_lock_approvals, approval_type, current_url):
            logger.info(
                f"Write lock bypassed: existing approval valid{suffix}",
                approval_type=approval_type,
                url=current_url,
            )
            continue
        # H-06: a minted one-time card in THIS browser activity unlocks Place
        # order / purchase write locks (same ephemeral scope as site unlock).
        # Payment-field typing already bypasses via secret refs; purchase must
        # too or Place order re-prompts after Payment card ready.
        if approval_type == "purchase" and minted_card_unlocks_purchase:
            logger.info(
                f"Write lock bypassed: minted payment card unlocks purchase{suffix}",
                url=current_url,
            )
            continue
        logger.info(
            f"Write lock triggered: {description} detected{suffix}",
            url=current_url,
            element_text=element_text[:50],
            **({"coords": coords} if coordinate_click else {}),
        )
        return {
            "status": "needs_write_approval",
            "approval_type": approval_type,
            "question": get_write_lock_approval_question(
                action_type=approval_type,
                url=current_url,
                element_text=element_text[:100],
                system_name=system_name,
            ),
            "element_text": element_text[:100],
            "url": current_url,
        }
    return None


async def _execute_click(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    element: Any,
    index: Any,
    coords: Any,
    thinking: Any,
    humanizer: Optional[BrowserHumanizer],
    write_lock_enabled: bool,
    write_lock_approvals: Optional[Dict],
    current_url: str,
    system_name: str,
    secret_refs: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Execute a click action with write lock checks."""
    from browser_use.browser.events import ClickCoordinateEvent, ClickElementEvent

    element_coords = None
    if element:
        coord_tuple = await _maybe_await(dom_service.get_click_coordinates(index))
        if not coord_tuple:
            coord_tuple = await _refresh_element_coordinates(dom_service, index, for_click=True)
        element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None

    if write_lock_enabled and (element or coords):
        write_lock_result = await _click_write_lock_result(
            session=session,
            dom_service=dom_service,
            element=element,
            index=index,
            coords=element_coords if element else coords,
            write_lock_approvals=write_lock_approvals,
            current_url=current_url,
            system_name=system_name,
            secret_refs=secret_refs,
        )
        if write_lock_result:
            return write_lock_result

    if element:
        asyncio.create_task(session.highlight_interaction_element(element))

        if humanizer and element_coords:
            await humanizer.click_at_coords(element_coords["x"], element_coords["y"])
        else:
            if humanizer:
                logger.error(
                    "HUMANIZATION BLOCKED: index click has no coordinates; refusing browser-use click fallback",
                    index=index,
                )
                return {
                    "success": False,
                    "error": f"Cannot humanize click for element index {index}: no coordinates available",
                }
            if not humanizer:
                logger.warning(
                    "\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use ClickElementEvent"
                )
            event = session.event_bus.dispatch(ClickElementEvent(node=element))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

        await action_history.record_action(
            dom_service=dom_service,
            action="click",
            thinking=thinking,
            index=index,
            coordinates=element_coords,
            result={"success": True},
        )
        return {"success": True, "message": ""}

    elif coords:
        asyncio.create_task(session.highlight_coordinate_click(int(coords["x"]), int(coords["y"])))

        if humanizer:
            await humanizer.click_at_coords(int(coords["x"]), int(coords["y"]))
        else:
            logger.warning(
                "\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use ClickCoordinateEvent"
            )
            event = session.event_bus.dispatch(
                ClickCoordinateEvent(coordinate_x=int(coords["x"]), coordinate_y=int(coords["y"]))
            )
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

        await action_history.record_action(
            dom_service=dom_service,
            action="click",
            thinking=thinking,
            coordinates=coords,
            result={"success": True},
        )
        return {"success": True, "message": ""}

    else:
        return {"success": False, "error": "Click requires either element index or coordinates"}


def _input_success_result(display_text: str, credential_ref: Optional[Dict[str, str]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {"success": True, "message": "", "typed_text": display_text}
    if credential_ref:
        result["credential_ref"] = credential_ref
    return result


async def _payment_input_write_lock_error(
    *,
    session: Any,
    element: Any,
    index: Any,
    write_lock_enabled: bool,
    is_payment_card_secret_ref: bool,
    secret_refs: Optional[Dict[str, str]],
    secret_ref_name: Optional[str],
    write_lock_approvals: Optional[Dict],
    current_url: str,
) -> Optional[Dict[str, Any]]:
    from browser_tools.write_lock import is_payment_field

    if not write_lock_enabled or not element or index is None:
        return None
    if not await is_payment_field(session, element, index):
        return None
    if is_payment_card_secret_ref and has_payment_card_secret_refs(secret_refs):
        logger.info(
            "Write lock bypassed: approved payment card secret ref",
            ref_name=secret_ref_name,
            url=current_url,
        )
        return None
    if is_approval_valid(write_lock_approvals, "payment", current_url):
        logger.info("Write lock bypassed: existing approval valid", approval_type="payment", url=current_url)
        return None

    element_text = getattr(element, "text_content", "") or ""
    tag_name = getattr(element, "tag_name", "") or getattr(element, "node_name", "input")
    field_description = f"{tag_name}: {element_text[:50]}" if element_text else f"{tag_name} field"
    logger.info("Write lock triggered: payment field detected", url=current_url, field_desc=field_description)
    return {
        "success": False,
        "error": (
            "Payment fields require a one-time virtual card. Extract the full itemized receipt "
            "from the checkout page, call request_payment_card, then type the returned refs "
            "card_number, card_name, card_expiry, and card_cvv."
        ),
        "field_description": field_description,
        "url": current_url,
    }


async def _try_direct_payment_ref_fill(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    index: Any,
    thinking: Any,
    clear_before_typing: bool,
    secret_refs: Dict[str, str],
    secret_ref_name: str,
    text: str,
    display_text: str,
    credential_ref: Optional[Dict[str, str]],
    current_url: str,
    humanizer: Optional[BrowserHumanizer] = None,
) -> Optional[Dict[str, Any]]:
    input_page = _humanizer_input_page(humanizer)
    # Hosted widgets mount payment inputs in child frames after the document URL
    # settles — wait for a semantic field before the first fill attempt.
    await wait_for_payment_ref_fields(
        session,
        ref_names=["card_number", secret_ref_name],
        input_page=input_page,
        timeout_seconds=12.0,
    )
    fill_result = await _fill_payment_ref_directly(
        session,
        secret_ref_name,
        text,
        input_page=input_page,
        humanizer=humanizer,
    )
    if not fill_result:
        readiness = await wait_for_navigation_ready(
            dom_service,
            url=current_url,
            timeout_seconds=3.0,
            reload_blank_spa_once=True,
        )
        logger.debug(
            "Retried approved payment card direct fill after page readiness",
            ref_name=secret_ref_name,
            readiness=readiness,
        )
        await wait_for_payment_ref_fields(
            session,
            ref_names=["card_number", secret_ref_name],
            input_page=input_page,
            timeout_seconds=8.0,
        )
        fill_result = await _fill_payment_ref_directly(
            session,
            secret_ref_name,
            text,
            input_page=input_page,
            humanizer=humanizer,
        )
    if not fill_result:
        return None

    filled_refs = [secret_ref_name]
    for other_ref in PAYMENT_CARD_SECRET_REFS:
        other_value = secret_refs.get(other_ref)
        if other_ref == secret_ref_name or not other_value:
            continue
        if await _fill_payment_ref_directly(
            session,
            other_ref,
            other_value,
            input_page=input_page,
            humanizer=humanizer,
        ):
            filled_refs.append(other_ref)

    element_coords = None
    if isinstance(fill_result.get("x"), (int, float)) and isinstance(fill_result.get("y"), (int, float)):
        element_coords = {"x": int(fill_result["x"]), "y": int(fill_result["y"])}
    await action_history.record_action(
        dom_service=dom_service,
        action="input_text",
        thinking=thinking,
        index=index,
        coordinates=element_coords,
        params={"text": display_text, "clear": clear_before_typing},
        result={
            "success": True,
            "payment_ref_direct_fill": True,
            "payment_refs_filled": filled_refs,
            "selector": fill_result.get("selector"),
        },
    )
    logger.info(
        "Filled approved payment card secret ref directly",
        ref_name=secret_ref_name,
        filled_refs=filled_refs,
        selector=fill_result.get("selector"),
    )
    result = _input_success_result(display_text, credential_ref)
    result.update({"payment_ref_direct_fill": True, "payment_refs_filled": filled_refs})
    return result


async def _clear_input_with_events(session: Any) -> None:
    from browser_use.browser.events import SendKeysEvent

    for keys in ("Control+a", "Backspace"):
        event = session.event_bus.dispatch(SendKeysEvent(keys=keys))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)


async def _execute_indexed_input_text(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    element: Any,
    index: Any,
    thinking: Any,
    humanizer: Optional[BrowserHumanizer],
    text: str,
    display_text: str,
    clear_before_typing: bool,
    is_payment_card_secret_ref: bool,
    secret_ref_name: Optional[str],
    credential_ref: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    from browser_use.browser.events import TypeTextEvent

    coord_tuple = await dom_service.get_element_coordinates(index)
    if humanizer and not coord_tuple:
        coord_tuple = await _refresh_element_coordinates(dom_service, index)
    if humanizer and not coord_tuple and is_payment_card_secret_ref:
        coord_tuple = await _resolve_payment_ref_coordinates(
            session,
            secret_ref_name or "",
            input_page=_humanizer_input_page(humanizer),
        )
    element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
    asyncio.create_task(session.highlight_interaction_element(element))

    if humanizer and not element_coords:
        logger.error(
            "HUMANIZATION BLOCKED: indexed input_text has no coordinates; refusing TypeTextEvent fallback",
            index=index,
        )
        return {
            "success": False,
            "error": f"Cannot humanize input_text for element index {index}: no coordinates available",
        }
    if humanizer:
        await humanizer.click_at_coords(element_coords["x"], element_coords["y"])
        if clear_before_typing:
            await humanizer.press_key("Control+a")
            await humanizer.press_key("Backspace")
        await humanizer.type_text(text)
    else:
        logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use TypeTextEvent")
        if clear_before_typing:
            await _clear_input_with_events(session)
        event = session.event_bus.dispatch(TypeTextEvent(node=element, text=text, clear=clear_before_typing))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)

    await action_history.record_action(
        dom_service=dom_service,
        action="input_text",
        thinking=thinking,
        index=index,
        coordinates=element_coords,
        params={"text": display_text, "clear": clear_before_typing},
        result={"success": True},
    )
    return _input_success_result(display_text, credential_ref)


async def _execute_coordinate_input_text(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    coords: Dict[str, Any],
    thinking: Any,
    humanizer: Optional[BrowserHumanizer],
    text: str,
    display_text: str,
    clear_before_typing: bool,
    credential_ref: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    from browser_use.browser.events import ClickCoordinateEvent, SendKeysEvent

    x, y = int(coords["x"]), int(coords["y"])
    asyncio.create_task(session.highlight_coordinate_click(x, y))
    if humanizer:
        await humanizer.click_at_coords(x, y)
        if clear_before_typing:
            await humanizer.press_key("Control+a")
            await humanizer.press_key("Backspace")
        await humanizer.type_text(text)
    else:
        logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use events")
        click_event = session.event_bus.dispatch(ClickCoordinateEvent(coordinate_x=x, coordinate_y=y))
        await click_event
        await click_event.event_result(raise_if_any=True, raise_if_none=False)
        await asyncio.sleep(0.1)
        if clear_before_typing:
            await _clear_input_with_events(session)
        type_event = session.event_bus.dispatch(SendKeysEvent(keys=text))
        await type_event
        await type_event.event_result(raise_if_any=True, raise_if_none=False)

    await action_history.record_action(
        dom_service=dom_service,
        action="input_text",
        thinking=thinking,
        coordinates=coords,
        params={"text": display_text, "clear": clear_before_typing},
        result={"success": True},
    )
    return _input_success_result(display_text, credential_ref)


async def _execute_focused_input_text(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    thinking: Any,
    humanizer: Optional[BrowserHumanizer],
    text: str,
    display_text: str,
    clear_before_typing: bool,
    credential_ref: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    from browser_use.browser.events import SendKeysEvent

    if humanizer:
        if clear_before_typing:
            await humanizer.press_key("Control+a")
            await humanizer.press_key("Backspace")
        await humanizer.type_text(text)
    else:
        logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use SendKeysEvent")
        if clear_before_typing:
            await _clear_input_with_events(session)
        type_event = session.event_bus.dispatch(SendKeysEvent(keys=text))
        await type_event
        await type_event.event_result(raise_if_any=True, raise_if_none=False)

    await action_history.record_action(
        dom_service=dom_service,
        action="input_text",
        thinking=thinking,
        params={"text": display_text, "clear": clear_before_typing},
        result={"success": True},
    )
    return _input_success_result(display_text, credential_ref)


async def _execute_input_text(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    element: Any,
    index: Any,
    coords: Any,
    params: Dict,
    thinking: Any,
    humanizer: Optional[BrowserHumanizer],
    secret_refs: Optional[Dict[str, str]],
    password_origins: Optional[Dict[str, str]],
    credential_refs_by_secret_ref: Optional[Dict[str, Dict[str, str]]] = None,
    current_url: str,
    write_lock_enabled: bool,
    write_lock_approvals: Optional[Dict],
    system_name: str,
) -> Dict[str, Any]:
    """Execute an input_text action with secret decryption and write lock checks."""
    text = params.get("text", "")
    clear_before_typing = params.get("clear", True) is not False
    display_text = text
    credential_ref = (credential_refs_by_secret_ref or {}).get(text)
    secret_ref_name = text if secret_refs and text in secret_refs else None
    is_payment_card_secret_ref = secret_ref_name in PAYMENT_CARD_SECRET_REFS

    # Check if this is a password or card reference that needs decryption
    if secret_ref_name:
        display_text = "[encrypted_data]"

        if password_origins and secret_ref_name in password_origins:
            expected_origin = password_origins[secret_ref_name]
            current_domain = urlparse(current_url).netloc.lower() if current_url else ""
            expected_domain = urlparse(expected_origin).netloc.lower() if expected_origin else ""

            if _get_base_domain(current_domain) != _get_base_domain(expected_domain):
                logger.warning("\U0001f510 Password origin mismatch", expected=expected_domain, got=current_domain)
                return {
                    "success": False,
                    "error": f"Password origin mismatch: expected {expected_domain}, got {current_domain}",
                }

        text = secret_refs[secret_ref_name]
        logger.info("\U0001f510 Typing encrypted credential (password/card)", redacted=True)

    write_lock_error = await _payment_input_write_lock_error(
        session=session,
        element=element,
        index=index,
        write_lock_enabled=write_lock_enabled,
        is_payment_card_secret_ref=is_payment_card_secret_ref,
        secret_refs=secret_refs,
        secret_ref_name=secret_ref_name,
        write_lock_approvals=write_lock_approvals,
        current_url=current_url,
    )
    if write_lock_error:
        return write_lock_error

    if is_payment_card_secret_ref and has_payment_card_secret_refs(secret_refs):
        direct_fill_result = await _try_direct_payment_ref_fill(
            session=session,
            dom_service=dom_service,
            action_history=action_history,
            index=index,
            thinking=thinking,
            clear_before_typing=clear_before_typing,
            secret_refs=secret_refs or {},
            secret_ref_name=secret_ref_name or "",
            text=text,
            display_text=display_text,
            credential_ref=credential_ref,
            current_url=current_url,
            humanizer=humanizer,
        )
        if direct_fill_result:
            return direct_fill_result
        # Auto-fill / secret-ref typing without an element index must not fall
        # through to "type into whatever is focused" — that reports success
        # without payment_refs_filled and hides the real field_not_found miss.
        if not element and not coords:
            return {
                "success": False,
                "error": "field_not_found",
                "payment_refs_filled": [],
            }

    if element:
        return await _execute_indexed_input_text(
            session=session,
            dom_service=dom_service,
            action_history=action_history,
            element=element,
            index=index,
            thinking=thinking,
            humanizer=humanizer,
            text=text,
            display_text=display_text,
            clear_before_typing=clear_before_typing,
            is_payment_card_secret_ref=is_payment_card_secret_ref,
            secret_ref_name=secret_ref_name,
            credential_ref=credential_ref,
        )

    if coords:
        return await _execute_coordinate_input_text(
            session=session,
            dom_service=dom_service,
            action_history=action_history,
            coords=coords,
            thinking=thinking,
            humanizer=humanizer,
            text=text,
            display_text=display_text,
            clear_before_typing=clear_before_typing,
            credential_ref=credential_ref,
        )
    return await _execute_focused_input_text(
        session=session,
        dom_service=dom_service,
        action_history=action_history,
        thinking=thinking,
        humanizer=humanizer,
        text=text,
        display_text=display_text,
        clear_before_typing=clear_before_typing,
        credential_ref=credential_ref,
    )


async def _execute_goto(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    params: Dict,
    thinking: Any,
    session_id: Optional[str],
    config: Any,
    current_auth_realm: str = "",
    prepare_credentials_for_url: Optional[
        Callable[[str], Awaitable[Optional[Dict[str, Any]]]]
    ] = None,
    wait_for_navigation: Optional[Callable[..., Awaitable[None]]] = None,
) -> Dict[str, Any]:
    """Prepare a target realm's credentials, then execute navigation."""
    from browser_use.browser.events import NavigateToUrlEvent

    url = params.get("url", "")
    if url and not url.startswith(("http://", "https://", "about:", "file:")):
        url = f"https://{url}"
        logger.info(f"\U0001f517 Auto-added https:// to URL: {url}")
    credential_summary = None
    target_auth_realm = auth_realm_from_url(url)
    if (
        prepare_credentials_for_url is not None
        and target_auth_realm
        and not auth_realm_matches_url(current_auth_realm, url)
    ):
        try:
            prepared = await prepare_credentials_for_url(url)
        except Exception as prep_error:
            logger.warning(
                "Optional goto credential preparation failed; continuing guest navigation",
                auth_realm=target_auth_realm,
                target_url=url,
                error=f"{type(prep_error).__name__}:{extract_error_message(prep_error)[:160]}",
            )
            prepared = None
        if prepared is not None:
            credential_summary = {
                key: prepared[key]
                for key in (
                    "auth_realm",
                    "cookies_injected",
                    "cookie_count",
                    "password_count",
                    "passkey_count",
                    "passkeys_newly_injected",
                )
                if key in prepared
            }

    try:
        event = session.event_bus.dispatch(NavigateToUrlEvent(url=url))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)

        navigation_waiter = wait_for_navigation or wait_for_navigation_ready
        await navigation_waiter(dom_service, url=url)
    except Exception as nav_error:
        error_text = extract_error_message(nav_error)
        if (
            session_id
            and config is not None
            and url.startswith(("http://", "https://"))
            and "ERR_ABORTED" in error_text
        ):
            try:
                from domains.spawn_browser_agent_v3.download_persist import (
                    persist_navigation_download_via_page_fetch,
                )

                download = await persist_navigation_download_via_page_fetch(
                    session=session,
                    url=url,
                    session_id=session_id,
                    config=config,
                )
            except Exception as persist_error:
                logger.warning(
                    "ERR_ABORTED download persist failed",
                    url=url[:200],
                    error=f"{type(persist_error).__name__}:{extract_error_message(persist_error)[:160]}",
                )
                download = None
            if download:
                result = {
                    "success": True,
                    "message": (
                        f"Navigation aborted into a file download; saved to session "
                        f"as {download.get('path')} ({download.get('size')} bytes)"
                    ),
                    "current_url": url,
                    "download": download,
                }
                await action_history.record_action(
                    dom_service=dom_service,
                    action="goto",
                    thinking=thinking,
                    params={"url": url},
                    result=result,
                )
                return result
        raise

    result = {"success": True, "message": "", "current_url": url}
    if credential_summary is not None:
        # The preparation callback consumes encrypted credential material
        # internally. Only its deliberately non-sensitive summary may enter
        # action history or the model-visible tool result.
        result["credentials_prepared"] = credential_summary
        result["auth_realm"] = str(
            credential_summary.get("auth_realm") or target_auth_realm
        )
    await action_history.record_action(
        dom_service=dom_service,
        action="goto",
        thinking=thinking,
        params={"url": url},
        result=result,
    )
    return result


async def _execute_extract(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    params: Dict,
    thinking: Any,
) -> Dict[str, Any]:
    """Disabled legacy LLM-backed extraction action."""
    return {
        "success": False,
        "error": "extract is disabled. Use evaluate to read DOM/page content directly.",
    }


async def _execute_upload_file(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    element: Any,
    index: Any,
    params: Dict,
    thinking: Any,
    humanizer: Optional[BrowserHumanizer],
    available_file_paths: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    """Execute a file upload action."""
    from browser_use.browser.events import UploadFileEvent

    filename = params.get("filename", "")
    if not filename:
        return {"success": False, "error": "Missing 'filename' parameter"}

    if not available_file_paths or filename not in available_file_paths:
        available_files = list(available_file_paths.keys()) if available_file_paths else []
        return {"success": False, "error": f"File '{filename}' not available. Available files: {available_files}"}

    if not element:
        return {"success": False, "error": "upload_file requires an element index for the file input"}

    if not session.is_file_input(element):
        return {"success": False, "error": f"Element {index} is not a file input (<input type='file'>)"}

    remote_path = available_file_paths[filename]

    coord_tuple = await dom_service.get_element_coordinates(index)
    element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
    if humanizer and element_coords:
        await humanizer.click_at_coords(element_coords["x"], element_coords["y"])

    event = session.event_bus.dispatch(UploadFileEvent(node=element, file_path=remote_path))
    await event
    await event.event_result(raise_if_any=True, raise_if_none=False)

    await action_history.record_action(
        dom_service=dom_service,
        action="upload_file",
        thinking=thinking,
        index=index,
        coordinates=element_coords,
        params={"filename": filename},
        result={"success": True},
    )

    logger.info(f"\U0001f4ce Uploaded file '{filename}' to element {index}")
    return {"success": True, "message": "", "uploaded": filename, "to_index": index}


async def _execute_switch_tab(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    params: Dict,
    thinking: Any,
) -> Dict[str, Any]:
    """Execute a tab switch action."""
    from browser_use.browser.events import SwitchTabEvent

    tab_id = params.get("tab_id")
    if not tab_id:
        return {"success": False, "error": "Missing 'tab_id' parameter"}

    tabs = await session.get_tabs()
    target = next((t for t in tabs if t.target_id.endswith(tab_id)), None)
    if not target:
        available_tabs = [f"{t.target_id[-4:]} ({t.title or t.url})" for t in tabs]
        return {"success": False, "error": f"Tab '{tab_id}' not found. Available: {available_tabs}"}

    event = session.event_bus.dispatch(SwitchTabEvent(target_id=target.target_id))
    await event

    await action_history.record_action(
        dom_service=dom_service,
        action="switch_tab",
        thinking=thinking,
        params={"tab_id": tab_id},
        result={"success": True, "switched_to": target.target_id[-4:]},
    )
    logger.info(f"\U0001f500 Switched to tab {tab_id} ({target.title or target.url})")
    return {"success": True, "message": "", "switched_to": tab_id}


async def _execute_close_tab(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    params: Dict,
    thinking: Any,
) -> Dict[str, Any]:
    """Execute a tab close action."""
    from browser_use.browser.events import CloseTabEvent

    tab_id = params.get("tab_id")

    if tab_id:
        tabs = await session.get_tabs()
        target = next((t for t in tabs if t.target_id.endswith(tab_id)), None)
        if not target:
            available_tabs = [f"{t.target_id[-4:]} ({t.title or t.url})" for t in tabs]
            return {"success": False, "error": f"Tab '{tab_id}' not found. Available: {available_tabs}"}
        target_id = target.target_id
    else:
        focused = session.get_focused_target()
        if not focused:
            return {"success": False, "error": "No current tab to close"}
        target_id = focused.target_id
        tab_id = target_id[-4:]

    event = session.event_bus.dispatch(CloseTabEvent(target_id=target_id))
    await event

    await action_history.record_action(
        dom_service=dom_service,
        action="close_tab",
        thinking=thinking,
        params={"tab_id": tab_id},
        result={"success": True, "closed": tab_id},
    )
    logger.info(f"\u274c Closed tab {tab_id}")
    return {"success": True, "message": "", "closed_tab": tab_id}


async def _execute_screenshot(
    *,
    session: Any,
    dom_service: DOMService,
    action_history: ActionHistory,
    thinking: Any,
    session_id: Optional[str],
    config: Any,
) -> Dict[str, Any]:
    """Execute a screenshot action using the active provider's browser-window capture."""
    from domains.spawn_browser_agent_v3.repo import (
        take_browser_computer_screenshot,
        upload_file_to_session,
    )

    if not session_id:
        raise RuntimeError("Browser session id is required for screenshot capture")

    screenshot_result = await take_browser_computer_screenshot(config, session_id)
    full_screenshot_b64 = screenshot_result["base64_image"]
    full_screenshot_bytes = base64.b64decode(full_screenshot_b64)
    screenshot_bytes = (
        _crop_steel_computer_screenshot_to_viewport(full_screenshot_bytes)
        if screenshot_result.get("provider") == "steel"
        else full_screenshot_bytes
    )
    screenshot_b64 = base64.b64encode(screenshot_bytes).decode("utf-8")

    saved_path = None
    if config:
        upload_result = await upload_file_to_session(
            config, session_id, "screenshot.png", screenshot_bytes, "image/png"
        )
        if upload_result:
            saved_path = upload_result.get("path", "/tmp/screenshot.png")
            logger.info(f"\U0001f4f8 Screenshot saved to browser session: {saved_path} ({len(screenshot_bytes)} bytes)")

    await action_history.record_action(
        dom_service=dom_service,
        action="screenshot",
        thinking=thinking,
        params={},
        result={"success": True, "file_path": saved_path or "screenshot.png"},
    )

    return {
        "success": True,
        "message": f"Screenshot captured from browser viewport ({len(screenshot_bytes)} bytes)",
        "screenshot": screenshot_b64,
        "file_path": saved_path or "screenshot.png",
    }


def _crop_steel_computer_screenshot_to_viewport(screenshot_bytes: bytes) -> bytes:
    """Crop Steel's full browser-window screenshot to the viewport coordinate space."""
    with Image.open(BytesIO(screenshot_bytes)) as img:
        if img.size != (STEEL_COMPUTER_SCREENSHOT_WIDTH, STEEL_COMPUTER_SCREENSHOT_HEIGHT):
            logger.warning(
                "Steel computer screenshot dimensions differ from expected fixed window size",
                actual_width=img.width,
                actual_height=img.height,
                expected_width=STEEL_COMPUTER_SCREENSHOT_WIDTH,
                expected_height=STEEL_COMPUTER_SCREENSHOT_HEIGHT,
            )

        crop_box = (
            STEEL_VIEWPORT_CROP_X,
            STEEL_VIEWPORT_CROP_Y,
            STEEL_VIEWPORT_CROP_X + STEEL_VIEWPORT_CROP_WIDTH,
            STEEL_VIEWPORT_CROP_Y + STEEL_VIEWPORT_CROP_HEIGHT,
        )
        cropped = img.crop(crop_box)
        if cropped.size != (STEEL_VIEWPORT_CROP_WIDTH, STEEL_VIEWPORT_CROP_HEIGHT):
            logger.warning(
                "Steel viewport screenshot crop dimensions differ from expected viewport size",
                actual_width=cropped.width,
                actual_height=cropped.height,
                expected_width=STEEL_VIEWPORT_CROP_WIDTH,
                expected_height=STEEL_VIEWPORT_CROP_HEIGHT,
            )

        output = BytesIO()
        cropped.save(output, format="PNG")
        return output.getvalue()
