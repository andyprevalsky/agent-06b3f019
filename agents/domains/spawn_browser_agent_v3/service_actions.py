"""Action execution services for spawn-browser-agent-v3 domain.

Browser action execution, write lock checking, and element interaction.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import time as time_module
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
STEEL_VIEWPORT_CROP_X = 4
STEEL_VIEWPORT_CROP_Y = 87
STEEL_VIEWPORT_CROP_WIDTH = 1283
STEEL_VIEWPORT_CROP_HEIGHT = 800


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
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return ""


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

    async def _wait_for_content(deadline: float) -> Dict[str, Any]:
        last_state: Dict[str, Any] = {}
        while time_module.monotonic() < deadline:
            try:
                wait_for_load_state = getattr(page, "wait_for_load_state", None)
                if wait_for_load_state:
                    try:
                        wait_result = wait_for_load_state("domcontentloaded", timeout=1500)
                        if inspect.isawaitable(wait_result):
                            await wait_result
                    except Exception:
                        pass

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
                    try:
                        state = json.loads(state)
                    except Exception:
                        pass
                last_state = state if isinstance(state, dict) else {"raw": state}
                if last_state.get("appRootReady") or last_state.get("plainPageReady"):
                    return {"ready": True, "state": last_state}
            except Exception as exc:
                last_state = {"error": str(exc)}
            await asyncio.sleep(0.25)
        return {"ready": False, "state": last_state}

    first = await _wait_for_content(time_module.monotonic() + timeout_seconds)
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

    second = await _wait_for_content(time_module.monotonic() + timeout_seconds)
    if not second.get("ready"):
        logger.warning("Page still lacked usable content after reload", url=url, state=second.get("state"))
    return second


def _get_base_domain(domain: str) -> str:
    """Get base domain (e.g., 'amazon.com' from 'auth.amazon.com')."""
    parts = domain.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return domain


def is_approval_valid(approvals: Optional[Dict], approval_type: str, current_url: str) -> bool:
    """Check if an existing approval is still valid for the current domain."""
    if not approvals:
        return False

    approval = approvals.get(approval_type, {})
    if not approval.get("domain") or not approval.get("approved_at"):
        return False

    current_domain = get_domain_from_url(current_url)
    approved_domain = approval["domain"]
    approved_at = approval["approved_at"]

    if current_domain != approved_domain:
        return False

    return not time_module.time() - approved_at > WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS


# ========================================
# ACTION EXECUTION
# ========================================


async def execute_action(  # noqa: C901
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
) -> Dict[str, Any]:
    """Execute a browser action using browser-use events.

    Returns:
        Result dict with success, message, and any additional data.
        May return {"status": "needs_write_approval", ...} if write lock triggered.
    """
    from browser_use.browser.events import (
        GetDropdownOptionsEvent,
        GoBackEvent,
        NavigateToUrlEvent,
        ScrollEvent,
        SelectDropdownOptionEvent,
        SendKeysEvent,
        WaitEvent,
    )

    session = dom_service.session
    if not session:
        return {"success": False, "error": "Browser not connected"}

    action_name = action.get("action", "")
    index = action.get("index")
    params = action.get("params", {})
    thinking = action.get("thinking")
    coords = action.get("coordinates")

    try:
        element = None
        if index is not None:
            element = dom_service.selector_map.get(index)
            if not element:
                return {"success": False, "error": f"Element with index {index} not found"}

        if action_name == "click":
            return await _execute_click(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                element=element,
                index=index,
                coords=coords,
                thinking=thinking,
                humanizer=humanizer,
                write_lock_enabled=write_lock_enabled,
                write_lock_approvals=write_lock_approvals,
                current_url=current_url,
                system_name=system_name,
            )

        elif action_name == "input_text":
            return await _execute_input_text(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                element=element,
                index=index,
                coords=coords,
                params=params,
                thinking=thinking,
                humanizer=humanizer,
                secret_refs=secret_refs,
                password_origins=password_origins,
                credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                current_url=current_url,
                write_lock_enabled=write_lock_enabled,
                write_lock_approvals=write_lock_approvals,
                system_name=system_name,
            )

        elif action_name == "request_payment_card":
            if has_payment_card_secret_refs(secret_refs):
                return {
                    "success": False,
                    "error": (
                        "Payment approval is already complete. Do not call request_payment_card again. "
                        "Type the existing secret refs card_number, card_name, card_expiry, and card_cvv "
                        "into the payment fields, then submit the checkout form."
                    ),
                }
            try:
                payment_request = RequestPaymentCardBrowserTool.model_validate({"tool": action_name, **params})
                for item in payment_request.line_items:
                    validate_product_url_for_pages(
                        item.product_url,
                        [*(trusted_page_urls or []), current_url],
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
                return {
                    "success": False,
                    "error": f"request_payment_card receipt is incomplete: {error}.{hint}",
                }
            return {
                "status": "awaiting_payment_card_approval",
                "payment_request": params,
                "current_url": current_url,
            }

        elif action_name == "read_network_requests":
            if browser_network_recorder is None:
                return {
                    "success": False,
                    "error": (
                        "Network capture is not attached to this browser session, so there is "
                        "nothing to read. Rely on the DOM tree and screenshots instead."
                    ),
                }
            include_bodies = bool(params.get("include_bodies"))
            requests = browser_network_recorder.query_requests(
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
                # The single most common failure mode is the model concluding
                # "this tool doesn't return response bodies" from a summary row.
                # Say so on the row itself instead of letting it guess.
                message += (
                    f" {with_bodies} have a captured response body - re-run with include_bodies=true"
                    " (optionally narrowed by url_pattern) to read them."
                )
            await action_history.record_action(
                dom_service=dom_service,
                action="read_network_requests",
                thinking=thinking,
                params={
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
                },
                result={"success": True, "count": len(requests)},
            )
            return {
                "success": True,
                "message": message,
                "requests": requests,
            }

        elif action_name == "press_key":
            key = params.get("key", "")
            if humanizer:
                await humanizer.press_key(key)
            else:
                logger.warning(
                    "\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use SendKeysEvent"
                )
                event = session.event_bus.dispatch(SendKeysEvent(keys=key))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="press_key",
                thinking=thinking,
                params={"key": key},
                result={"success": True},
            )
            return {"success": True, "message": ""}

        elif action_name == "scroll":
            direction = params.get("direction", "down")
            amount = params.get("amount", 300)
            delta_y = amount if direction == "down" else -amount

            if humanizer:
                await humanizer.scroll(delta_y)
            else:
                logger.warning(
                    "\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use ScrollEvent"
                )
                event = session.event_bus.dispatch(
                    ScrollEvent(direction=direction, amount=amount, node=element if index is not None else None)
                )
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="scroll",
                thinking=thinking,
                index=index,
                params={"direction": direction, "amount": amount},
                result={"success": True},
            )
            return {"success": True, "message": ""}

        elif action_name == "goto":
            return await _execute_goto(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                params=params,
                thinking=thinking,
                session_id=session_id,
                config=config,
                current_auth_realm=current_auth_realm,
                prepare_credentials_for_url=prepare_credentials_for_url,
            )

        elif action_name == "navback":
            event = session.event_bus.dispatch(GoBackEvent())
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service, action="navback", thinking=thinking, result={"success": True}
            )
            return {"success": True, "message": ""}

        elif action_name == "wait":
            try:
                time_ms = normalize_browser_wait_ms(params.get("time_ms"), default=1000)
            except ValueError as exc:
                return {"success": False, "error": str(exc)}
            seconds = time_ms / 1000.0
            event = session.event_bus.dispatch(WaitEvent(seconds=seconds))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="wait",
                thinking=thinking,
                params={"time_ms": time_ms},
                result={"success": True},
            )
            return {"success": True, "message": ""}

        elif action_name == "dropdown_options":
            if not element:
                return {"success": False, "error": "Dropdown requires an element index"}
            event = session.event_bus.dispatch(GetDropdownOptionsEvent(node=element))
            await event
            options = await event.event_result(raise_if_any=True, raise_if_none=False)
            return {"success": True, "message": f"Dropdown options: {options}", "options": options}

        elif action_name == "select_dropdown":
            if not element:
                return {"success": False, "error": "Dropdown requires an element index"}
            value = params.get("value", "")
            event = session.event_bus.dispatch(SelectDropdownOptionEvent(node=element, text=value))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="select_dropdown",
                thinking=thinking,
                index=index,
                params={"value": value},
                result={"success": True},
            )
            return {"success": True, "message": ""}

        elif action_name == "evaluate":
            code = params.get("code", "")
            cdp_session = await session.get_or_create_cdp_session(focus=True)
            result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": code, "returnByValue": True}, session_id=cdp_session.session_id
            )
            value = result.get("result", {}).get("value")

            await action_history.record_action(
                dom_service=dom_service,
                action="evaluate",
                thinking=thinking,
                params={"code": code},
                result={"success": True, "value": value},
            )
            return {"success": True, "message": f"Executed JS, result: {value}", "value": value}

        elif action_name == "extract":
            return {
                "success": False,
                "error": "extract is disabled. Use evaluate to read DOM/page content directly.",
            }

        elif action_name == "done":
            text = params.get("text", "")
            await action_history.record_action(
                dom_service=dom_service,
                action="done",
                thinking=thinking,
                params={"text": text},
                result={"success": True},
            )
            return {"success": True, "done": True, "message": text}

        elif action_name == "attempt_completion":
            await action_history.record_action(
                dom_service=dom_service,
                action="attempt_completion",
                thinking=thinking,
                params={},
                result={"success": True},
            )
            return {"success": True, "attempt_completion": True}

        elif action_name == "send_message_to_user":
            message = params.get("message", "")
            reason = params.get("reason", "other")
            await action_history.record_action(
                dom_service=dom_service,
                action="send_message_to_user",
                thinking=thinking,
                params={"message": message, "reason": reason},
                result={"success": True},
            )
            return {"success": True, "message_to_user": True, "message": message, "reason": reason}

        elif action_name == "upload_file":
            return await _execute_upload_file(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                element=element,
                index=index,
                params=params,
                thinking=thinking,
                humanizer=humanizer,
                available_file_paths=available_file_paths,
            )

        elif action_name == "switch_tab":
            return await _execute_switch_tab(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                params=params,
                thinking=thinking,
            )

        elif action_name == "close_tab":
            return await _execute_close_tab(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                params=params,
                thinking=thinking,
            )

        elif action_name == "open_new_tab":
            url = params.get("url") or "about:blank"
            event = session.event_bus.dispatch(NavigateToUrlEvent(url=url, new_tab=True))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            focused = session.get_focused_target()
            new_tab_id = focused.target_id[-4:] if focused else None

            await action_history.record_action(
                dom_service=dom_service,
                action="open_new_tab",
                thinking=thinking,
                params={"url": url},
                result={"success": True, "new_tab_id": new_tab_id},
            )
            logger.info(f"\u2795 Opened new tab {new_tab_id} with URL: {url}")
            return {"success": True, "message": "", "new_tab_id": new_tab_id, "url": url}

        elif action_name == "screenshot":
            return await _execute_screenshot(
                session=session,
                dom_service=dom_service,
                action_history=action_history,
                thinking=thinking,
                session_id=session_id,
                config=config,
            )

        elif action_name == "generate_write_lock_notification":
            return {
                "success": False,
                "error": (
                    "Tool call error: generate_write_lock_notification is only for write-lock "
                    "notification forks. Do not call this tool unless the latest user message "
                    'explicitly contains the keyword "WRITE_LOCK_NOTIFICATION_FORK_REQUEST". '
                    "Continue the browser task with a normal browser action."
                ),
            }

        else:
            return {"success": False, "error": f"Unknown action: {action_name}"}

    except Exception as e:
        logger.error(f"Action {action_name} failed: {e}")
        await action_history.record_action(
            dom_service=dom_service,
            action=action_name,
            thinking=thinking,
            index=index,
            coordinates=coords,
            params=params,
            result={"success": False, "error": str(e)},
        )
        return {"success": False, "error": str(e)}


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

    coords = getattr(dom_service, "get_element_coordinates", None)
    if not callable(coords):
        return None

    return await _maybe_await(coords(index))


async def _resolve_payment_ref_coordinates(session: Any, ref_name: str) -> Optional[tuple[int, int]]:
    """Resolve coordinates for a visible payment input by semantic card ref."""
    if not session or ref_name not in PAYMENT_CARD_SECRET_REFS:
        return None

    get_page = getattr(session, "get_page", None) or getattr(session, "get_current_page", None)
    if not callable(get_page):
        return None

    try:
        page = await _maybe_await(get_page())
    except Exception:
        return None
    if not page or not hasattr(page, "evaluate"):
        return None

    try:
        result = await _maybe_await(
            page.evaluate(
                """
                (refName) => {
                    const selectorsByRef = {
                        card_number: [
                            'input[autocomplete="cc-number"]',
                            'input#card-number',
                            'input[name="card-number"]',
                            'input[name="card_number"]',
                            'input[id*="card"][id*="number"]',
                            'input[name*="card"][name*="number"]'
                        ],
                        card_name: [
                            'input[autocomplete="cc-name"]',
                            'input#card-name',
                            'input[name="card-name"]',
                            'input[name="card_name"]',
                            'input[id*="card"][id*="name"]',
                            'input[name*="card"][name*="name"]'
                        ],
                        card_expiry: [
                            'input[autocomplete="cc-exp"]',
                            'input#card-expiry',
                            'input[name="card-expiry"]',
                            'input[name="card_expiry"]',
                            'input[id*="expir"]',
                            'input[name*="expir"]',
                            'input[placeholder*="MM/YY"]'
                        ],
                        card_cvv: [
                            'input[autocomplete="cc-csc"]',
                            'input#card-cvv',
                            'input#card-cvc',
                            'input[name="card-cvv"]',
                            'input[name="card_cvv"]',
                            'input[name="cvc"]',
                            'input[name="cvv"]',
                            'input[id*="cvv"]',
                            'input[id*="cvc"]',
                            'input[id*="security"]',
                            'input[name*="security"]'
                        ],
                    };
                    const selectors = selectorsByRef[refName] || [];
                    const isVisible = (el) => {
                        if (!el || el.disabled || el.readOnly) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0
                            && style.visibility !== 'hidden'
                            && style.display !== 'none';
                    };
                    for (const selector of selectors) {
                        for (const el of document.querySelectorAll(selector)) {
                            if (!isVisible(el)) continue;
                            el.scrollIntoView({ block: 'center', inline: 'nearest' });
                            const rect = el.getBoundingClientRect();
                            return {
                                x: Math.round(rect.left + rect.width / 2),
                                y: Math.round(rect.top + rect.height / 2),
                                selector,
                            };
                        }
                    }
                    const patternsByRef = {
                        card_number: ['cc-number', 'card number', 'card-number', 'card_number', 'cardnumber'],
                        card_name: ['cc-name', 'cardholder', 'card holder', 'name on card', 'card name', 'card-name', 'card_name'],
                        card_expiry: ['cc-exp', 'expiration', 'expiry', 'exp date', 'mm/yy', 'mm / yy'],
                        card_cvv: ['cc-csc', 'cvv', 'cvc', 'security code', 'security-code', 'security_code'],
                    };
                    const addText = (parts, value) => {
                        if (typeof value !== 'string') return;
                        const trimmed = value.trim();
                        if (trimmed) parts.push(trimmed);
                    };
                    const textSignalFor = (el) => {
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
                        // Deliberately excludes sibling/ancestor text: shared form
                        // text makes every card input score identically, so ties
                        // collapse all refs onto the first field.
                        return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
                    };
                    const patterns = patternsByRef[refName] || [];
                    let best = null;
                    for (const el of document.querySelectorAll('input, textarea')) {
                        if (!isVisible(el)) continue;
                        const signal = textSignalFor(el);
                        let score = 0;
                        for (const pattern of patterns) {
                            if (signal.includes(pattern)) score += pattern.length;
                        }
                        if (refName === 'card_name' && signal.includes('name') && signal.includes('card')) {
                            score += 12;
                        }
                        if (refName === 'card_number' && signal.includes('card') && signal.includes('number')) {
                            score += 12;
                        }
                        if (refName === 'card_expiry' && signal.includes('exp')) {
                            score += 8;
                        }
                        if (refName === 'card_cvv' && (signal.includes('security') || signal.includes('cvv') || signal.includes('cvc'))) {
                            score += 8;
                        }
                        if (!best || score > best.score) {
                            best = { el, score, signal };
                        }
                    }
                    if (best && best.score > 0) {
                        best.el.scrollIntoView({ block: 'center', inline: 'nearest' });
                        const rect = best.el.getBoundingClientRect();
                        return {
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2),
                            selector: 'semantic-payment-field',
                            score: best.score,
                            signal: best.signal.slice(0, 120),
                        };
                    }
                    return null;
                }
                """,
                ref_name,
            )
        )
    except Exception as exc:
        logger.debug("Payment ref selector coordinate lookup failed", ref_name=ref_name, error=str(exc))
        return None

    if not isinstance(result, dict) or not isinstance(result.get("x"), (int, float)):
        return None
    return int(result["x"]), int(result["y"])


async def _fill_payment_ref_directly(session: Any, ref_name: str, value: str) -> Optional[Dict[str, Any]]:
    """Fill an approved one-time payment-card ref into its semantic field atomically."""
    if not session or ref_name not in PAYMENT_CARD_SECRET_REFS:
        return None

    payload = {"refName": ref_name, "value": value}
    fill_script = """
        ({ refName, value }) => {
            const selectorsByRef = {
                card_number: [
                    'input[autocomplete="cc-number"]',
                    'input#card-number',
                    'input[name="card-number"]',
                    'input[name="card_number"]',
                    'input[id*="card"][id*="number"]',
                    'input[name*="card"][name*="number"]'
                ],
                card_name: [
                    'input[autocomplete="cc-name"]',
                    'input#card-name',
                    'input[name="card-name"]',
                    'input[name="card_name"]',
                    'input[id*="card"][id*="name"]',
                    'input[name*="card"][name*="name"]'
                ],
                card_expiry: [
                    'input[autocomplete="cc-exp"]',
                    'input#card-expiry',
                    'input[name="card-expiry"]',
                    'input[name="card_expiry"]',
                    'input[id*="expir"]',
                    'input[name*="expir"]',
                    'input[placeholder*="MM/YY"]'
                ],
                card_cvv: [
                    'input[autocomplete="cc-csc"]',
                    'input#card-cvv',
                    'input#card-cvc',
                    'input[name="card-cvv"]',
                    'input[name="card_cvv"]',
                    'input[name="cvc"]',
                    'input[name="cvv"]',
                    'input[id*="cvv"]',
                    'input[id*="cvc"]',
                    'input[id*="security"]',
                    'input[name*="security"]'
                ],
            };
            const isVisible = (el) => {
                if (!el || el.disabled || el.readOnly) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0
                    && style.visibility !== 'hidden'
                    && style.display !== 'none';
            };
            const addText = (parts, text) => {
                if (typeof text !== 'string') return;
                const trimmed = text.trim();
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
                // Deliberately excludes sibling/ancestor text: shared form text
                // makes every card input score identically, so ties collapse all
                // refs onto the first field.
                return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
            };
            const findField = () => {
                for (const selector of selectorsByRef[refName] || []) {
                    for (const el of document.querySelectorAll(selector)) {
                        if (isVisible(el)) return { el, selector, score: 100 };
                    }
                }

                const patternsByRef = {
                    card_number: ['cc-number', 'card number', 'card-number', 'card_number', 'cardnumber'],
                    card_name: ['cc-name', 'cardholder', 'card holder', 'name on card', 'card name', 'card-name', 'card_name'],
                    card_expiry: ['cc-exp', 'expiration', 'expiry', 'exp date', 'mm/yy', 'mm / yy'],
                    card_cvv: ['cc-csc', 'cvv', 'cvc', 'security code', 'security-code', 'security_code'],
                };
                let best = null;
                for (const el of document.querySelectorAll('input, textarea')) {
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

            const match = findField();
            if (!match) return { filled: false, reason: 'field_not_found' };

            const el = match.el;
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            el.focus();
            const prototype = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
            el.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertReplacementText',
                data: value,
            }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            const rect = el.getBoundingClientRect();
            return {
                filled: true,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                selector: match.selector,
                score: match.score,
                valueLength: String(value || '').length,
            };
        }
    """

    result: Any = None
    try:
        get_page = getattr(session, "get_page", None) or getattr(session, "get_current_page", None)
        if callable(get_page):
            page = await _maybe_await(get_page())
            if page and hasattr(page, "evaluate"):
                result = await _maybe_await(page.evaluate(fill_script, payload))
    except Exception as exc:
        logger.debug("Payment ref direct fill via page failed", ref_name=ref_name, error=str(exc))

    if not isinstance(result, dict):
        try:
            get_cdp = getattr(session, "get_or_create_cdp_session", None)
            if callable(get_cdp):
                cdp_session = await _maybe_await(get_cdp(focus=True))
                expression = f"({fill_script})({json.dumps(payload)})"
                cdp_result = await cdp_session.cdp_client.send.Runtime.evaluate(
                    params={"expression": expression, "returnByValue": True},
                    session_id=cdp_session.session_id,
                )
                result = cdp_result.get("result", {}).get("value")
        except Exception as exc:
            logger.debug("Payment ref direct fill via CDP failed", ref_name=ref_name, error=str(exc))

    if not isinstance(result, dict) or result.get("filled") is not True:
        logger.debug("Payment ref direct fill did not find a target", ref_name=ref_name, result=result)
        return None
    return result


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


async def _execute_click(  # noqa: C901
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
) -> Dict[str, Any]:
    """Execute a click action with write lock checks."""
    from browser_use.browser.events import ClickCoordinateEvent, ClickElementEvent

    from browser_tools.write_lock import (
        get_write_lock_approval_question,
        is_email_send_button,
        is_purchase_button,
        is_social_domain,
        is_submit_button,
    )

    element_coords = None
    if element:
        coord_tuple = await _maybe_await(dom_service.get_element_coordinates(index))
        if not coord_tuple:
            coord_tuple = await _refresh_element_coordinates(dom_service, index)
        element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None

    # Write lock checks for index-based clicks
    if write_lock_enabled and element:
        element_text = "\n".join(
            part
            for part in (
                _element_write_lock_signal(element),
                await _browser_click_write_lock_signal(session, element_coords),
            )
            if part
        )
        logger.info(
            "Write lock click check",
            element_text=element_text[:100] if element_text else "(empty)",
            index=index,
            url=current_url[:80] if current_url else None,
        )

        if is_social_domain(current_url) and is_submit_button(element_text):
            if not is_approval_valid(write_lock_approvals, "social_post", current_url):
                logger.info(
                    "Write lock triggered: social posting detected", url=current_url, element_text=element_text[:50]
                )
                return {
                    "status": "needs_write_approval",
                    "approval_type": "social_post",
                    "question": get_write_lock_approval_question(
                        action_type="social_post",
                        url=current_url,
                        element_text=element_text[:100],
                        system_name=system_name,
                    ),
                    "element_text": element_text[:100],
                    "url": current_url,
                }
            else:
                logger.info(
                    "Write lock bypassed: existing approval valid", approval_type="social_post", url=current_url
                )

        if is_email_send_button(element_text):
            if not is_approval_valid(write_lock_approvals, "email_send", current_url):
                logger.info(
                    "Write lock triggered: email send detected",
                    url=current_url,
                    element_text=element_text[:50],
                )
                return {
                    "status": "needs_write_approval",
                    "approval_type": "email_send",
                    "question": get_write_lock_approval_question(
                        action_type="email_send",
                        url=current_url,
                        element_text=element_text[:100],
                        system_name=system_name,
                    ),
                    "element_text": element_text[:100],
                    "url": current_url,
                }
            else:
                logger.info(
                    "Write lock bypassed: existing approval valid",
                    approval_type="email_send",
                    url=current_url,
                )

        if is_purchase_button(element_text):
            if not is_approval_valid(write_lock_approvals, "purchase", current_url):
                logger.info(
                    "Write lock triggered: purchase button detected", url=current_url, element_text=element_text[:50]
                )
                return {
                    "status": "needs_write_approval",
                    "approval_type": "purchase",
                    "question": get_write_lock_approval_question(
                        action_type="purchase",
                        url=current_url,
                        element_text=element_text[:100],
                        system_name=system_name,
                    ),
                    "element_text": element_text[:100],
                    "url": current_url,
                }
            else:
                logger.info("Write lock bypassed: existing approval valid", approval_type="purchase", url=current_url)

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
        # Write lock check for coordinate-based clicks
        if write_lock_enabled:
            coord_element_text = "\n".join(
                part
                for part in (
                    await _maybe_await(dom_service.get_text_at_coordinates(int(coords["x"]), int(coords["y"]))),
                    await _browser_click_write_lock_signal(session, coords),
                )
                if part
            )
            logger.info(
                "Write lock coord click check",
                element_text=coord_element_text[:100] if coord_element_text else "(empty)",
                coords=coords,
                url=current_url[:80] if current_url else None,
            )

            from browser_tools.write_lock import (
                get_write_lock_approval_question,
                is_email_send_button,
                is_purchase_button,
                is_social_domain,
                is_submit_button,
            )

            if is_social_domain(current_url) and is_submit_button(coord_element_text):
                if not is_approval_valid(write_lock_approvals, "social_post", current_url):
                    logger.info(
                        "Write lock triggered: social posting detected (coordinate click)",
                        url=current_url,
                        element_text=coord_element_text[:50],
                        coords=coords,
                    )
                    return {
                        "status": "needs_write_approval",
                        "approval_type": "social_post",
                        "question": get_write_lock_approval_question(
                            action_type="social_post",
                            url=current_url,
                            element_text=coord_element_text[:100],
                            system_name=system_name,
                        ),
                        "element_text": coord_element_text[:100],
                        "url": current_url,
                    }
                else:
                    logger.info(
                        "Write lock bypassed: existing approval valid (coordinate click)",
                        approval_type="social_post",
                        url=current_url,
                    )

            if is_email_send_button(coord_element_text):
                if not is_approval_valid(write_lock_approvals, "email_send", current_url):
                    logger.info(
                        "Write lock triggered: email send detected (coordinate click)",
                        url=current_url,
                        element_text=coord_element_text[:50],
                        coords=coords,
                    )
                    return {
                        "status": "needs_write_approval",
                        "approval_type": "email_send",
                        "question": get_write_lock_approval_question(
                            action_type="email_send",
                            url=current_url,
                            element_text=coord_element_text[:100],
                            system_name=system_name,
                        ),
                        "element_text": coord_element_text[:100],
                        "url": current_url,
                    }
                else:
                    logger.info(
                        "Write lock bypassed: existing approval valid (coordinate click)",
                        approval_type="email_send",
                        url=current_url,
                    )

            if is_purchase_button(coord_element_text):
                if not is_approval_valid(write_lock_approvals, "purchase", current_url):
                    logger.info(
                        "Write lock triggered: purchase button detected (coordinate click)",
                        url=current_url,
                        element_text=coord_element_text[:50],
                        coords=coords,
                    )
                    return {
                        "status": "needs_write_approval",
                        "approval_type": "purchase",
                        "question": get_write_lock_approval_question(
                            action_type="purchase",
                            url=current_url,
                            element_text=coord_element_text[:100],
                            system_name=system_name,
                        ),
                        "element_text": coord_element_text[:100],
                        "url": current_url,
                    }
                else:
                    logger.info(
                        "Write lock bypassed: existing approval valid (coordinate click)",
                        approval_type="purchase",
                        url=current_url,
                    )

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


async def _execute_input_text(  # noqa: C901
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
    from browser_use.browser.events import ClickCoordinateEvent, SendKeysEvent, TypeTextEvent

    from browser_tools.write_lock import is_payment_field

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

    # Write lock check for payment fields
    if write_lock_enabled and element and index is not None and await is_payment_field(session, element, index):
        if is_payment_card_secret_ref and has_payment_card_secret_refs(secret_refs):
            logger.info(
                "Write lock bypassed: approved payment card secret ref",
                ref_name=secret_ref_name,
                url=current_url,
            )
        elif not is_approval_valid(write_lock_approvals, "payment", current_url):
            element_text = getattr(element, "text_content", "") or ""
            tag_name = getattr(element, "tag_name", "") or getattr(element, "node_name", "input")
            field_desc = f"{tag_name} field"
            if element_text:
                field_desc = f"{tag_name}: {element_text[:50]}"

            logger.info("Write lock triggered: payment field detected", url=current_url, field_desc=field_desc)
            return {
                "success": False,
                "error": (
                    "Payment fields require a one-time virtual card. Extract the full itemized receipt "
                    "from the checkout page, call request_payment_card, then type the returned refs "
                    "card_number, card_name, card_expiry, and card_cvv."
                ),
                "field_description": field_desc,
                "url": current_url,
            }
        else:
            logger.info("Write lock bypassed: existing approval valid", approval_type="payment", url=current_url)

    if is_payment_card_secret_ref and has_payment_card_secret_refs(secret_refs):
        fill_result = await _fill_payment_ref_directly(session, secret_ref_name or "", text)
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
            fill_result = await _fill_payment_ref_directly(session, secret_ref_name or "", text)
        if fill_result:
            filled_refs = [secret_ref_name] if secret_ref_name else []
            for other_ref in PAYMENT_CARD_SECRET_REFS:
                if other_ref == secret_ref_name:
                    continue
                other_value = (secret_refs or {}).get(other_ref)
                if not other_value:
                    continue
                other_result = await _fill_payment_ref_directly(session, other_ref, other_value)
                if other_result:
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
            result = {
                "success": True,
                "message": "",
                "typed_text": display_text,
                "payment_ref_direct_fill": True,
                "payment_refs_filled": filled_refs,
            }
            if credential_ref:
                result["credential_ref"] = credential_ref
            return result

    if element:
        coord_tuple = await dom_service.get_element_coordinates(index)
        if humanizer and not coord_tuple:
            coord_tuple = await _refresh_element_coordinates(dom_service, index)
        if humanizer and not coord_tuple and is_payment_card_secret_ref:
            coord_tuple = await _resolve_payment_ref_coordinates(session, secret_ref_name or "")
        element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None

        asyncio.create_task(session.highlight_interaction_element(element))

        if humanizer and element_coords:
            await humanizer.click_at_coords(element_coords["x"], element_coords["y"])
            if clear_before_typing:
                await humanizer.press_key("Control+a")
                await humanizer.press_key("Backspace")
            await humanizer.type_text(text)
        else:
            if humanizer:
                logger.error(
                    "HUMANIZATION BLOCKED: indexed input_text has no coordinates; refusing TypeTextEvent fallback",
                    index=index,
                )
                return {
                    "success": False,
                    "error": f"Cannot humanize input_text for element index {index}: no coordinates available",
                }
            if not humanizer:
                logger.warning(
                    "\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use TypeTextEvent"
                )
            if clear_before_typing:
                clear_event = session.event_bus.dispatch(SendKeysEvent(keys="Control+a"))
                await clear_event
                await clear_event.event_result(raise_if_any=True, raise_if_none=False)
                delete_event = session.event_bus.dispatch(SendKeysEvent(keys="Backspace"))
                await delete_event
                await delete_event.event_result(raise_if_any=True, raise_if_none=False)
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
        result = {"success": True, "message": "", "typed_text": display_text}
        if credential_ref:
            result["credential_ref"] = credential_ref
        return result

    elif coords:
        asyncio.create_task(session.highlight_coordinate_click(int(coords["x"]), int(coords["y"])))

        if humanizer:
            await humanizer.click_at_coords(int(coords["x"]), int(coords["y"]))
            if clear_before_typing:
                await humanizer.press_key("Control+a")
                await humanizer.press_key("Backspace")
            await humanizer.type_text(text)
        else:
            logger.warning("\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use events")
            click_event = session.event_bus.dispatch(
                ClickCoordinateEvent(coordinate_x=int(coords["x"]), coordinate_y=int(coords["y"]))
            )
            await click_event
            await click_event.event_result(raise_if_any=True, raise_if_none=False)
            await asyncio.sleep(0.1)
            if clear_before_typing:
                clear_event = session.event_bus.dispatch(SendKeysEvent(keys="Control+a"))
                await clear_event
                await clear_event.event_result(raise_if_any=True, raise_if_none=False)
                delete_event = session.event_bus.dispatch(SendKeysEvent(keys="Backspace"))
                await delete_event
                await delete_event.event_result(raise_if_any=True, raise_if_none=False)
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
        result = {"success": True, "message": "", "typed_text": display_text}
        if credential_ref:
            result["credential_ref"] = credential_ref
        return result

    else:
        if humanizer:
            if clear_before_typing:
                await humanizer.press_key("Control+a")
                await humanizer.press_key("Backspace")
            await humanizer.type_text(text)
        else:
            logger.warning(
                "\u26a0\ufe0f HUMANIZATION FALLBACK: No humanizer available, using browser-use SendKeysEvent"
            )
            if clear_before_typing:
                clear_event = session.event_bus.dispatch(SendKeysEvent(keys="Control+a"))
                await clear_event
                await clear_event.event_result(raise_if_any=True, raise_if_none=False)
                delete_event = session.event_bus.dispatch(SendKeysEvent(keys="Backspace"))
                await delete_event
                await delete_event.event_result(raise_if_any=True, raise_if_none=False)
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
        result = {"success": True, "message": "", "typed_text": display_text}
        if credential_ref:
            result["credential_ref"] = credential_ref
        return result


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

    event = session.event_bus.dispatch(NavigateToUrlEvent(url=url))
    await event
    await event.event_result(raise_if_any=True, raise_if_none=False)

    navigation_waiter = wait_for_navigation or wait_for_navigation_ready
    await navigation_waiter(dom_service, url=url)

    result: Dict[str, Any] = {"success": True, "message": "", "current_url": url}
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
