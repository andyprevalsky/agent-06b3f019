"""Action execution services for spawn-browser-agent-v3 domain.

Browser action execution, write lock checking, and element interaction.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import time as time_module
from io import BytesIO
from typing import TYPE_CHECKING, Any, Dict, Optional
from urllib.parse import urlparse

import structlog
from PIL import Image

from domains.spawn_browser_agent_v3.config import WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS
from domains.spawn_browser_agent_v3.service_crypto import has_payment_card_secret_refs

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
    write_lock_enabled: bool = True,
    write_lock_approvals: Optional[Dict[str, Dict]] = None,
    system_name: str = "Rose",
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
            missing_fields = [
                field for field in ("merchant", "line_items", "subtotal_cents", "total_cents") if not params.get(field)
            ]
            if missing_fields:
                return {
                    "success": False,
                    "error": (
                        "request_payment_card requires merchant, line_items, subtotal_cents, "
                        f"and total_cents before approval. Missing: {', '.join(missing_fields)}"
                    ),
                }
            return {
                "status": "awaiting_payment_card_approval",
                "payment_request": params,
                "current_url": current_url,
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
            time_ms = params.get("time_ms", 1000)
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
    """Collect local DOM-node text and action-bearing attributes."""
    if not element:
        return ""

    parts = []
    try:
        if hasattr(element, "get_all_children_text"):
            parts.append(element.get_all_children_text() or "")
    except Exception:
        pass

    attrs = getattr(element, "attributes", None) or {}
    if not isinstance(attrs, dict):
        attrs = {}

    for attr_name in ("value", "aria-label", "title", "alt", "name", "id", "role", "type"):
        value = attrs.get(attr_name)
        if value:
            parts.append(str(value))

    return "\n".join(part for part in parts if part)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


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
                            if (!el || seen.has(el)) return;
                            seen.add(el);

                            if (includeText && !isPageContainer(el)) {
                                addText(el.innerText);
                                if (el.textContent !== el.innerText) addText(el.textContent);
                            }

                            for (const attrName of attrNames) {
                                if (el.getAttribute) add(el.getAttribute(attrName));
                            }

                            if (el.labels) {
                                for (const label of el.labels) {
                                    add(label.innerText);
                                    add(label.textContent);
                                }
                            }
                        };

                        const walkAncestors = (start, includeStartText) => {
                            let current = start;
                            let depth = 0;
                            while (current && depth < maxDepth) {
                                addElement(current, depth === 0 && includeStartText);
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

    # Check if this is a password or card reference that needs decryption
    if secret_refs and text in secret_refs:
        display_text = "[encrypted_data]"

        if password_origins and text in password_origins:
            expected_origin = password_origins[text]
            current_domain = urlparse(current_url).netloc.lower() if current_url else ""
            expected_domain = urlparse(expected_origin).netloc.lower() if expected_origin else ""

            if _get_base_domain(current_domain) != _get_base_domain(expected_domain):
                logger.warning("\U0001f510 Password origin mismatch", expected=expected_domain, got=current_domain)
                return {
                    "success": False,
                    "error": f"Password origin mismatch: expected {expected_domain}, got {current_domain}",
                }

        text = secret_refs[text]
        logger.info("\U0001f510 Typing encrypted credential (password/card)", redacted=True)

    # Write lock check for payment fields
    if write_lock_enabled and element and index is not None and await is_payment_field(session, element, index):
        if not is_approval_valid(write_lock_approvals, "payment", current_url):
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

    if element:
        coord_tuple = await dom_service.get_element_coordinates(index)
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
) -> Dict[str, Any]:
    """Execute a goto (navigation) action."""
    from browser_use.browser.events import NavigateToUrlEvent

    from domains.spawn_browser_agent_v3.repo import inject_local_storage

    url = params.get("url", "")
    if url and not url.startswith(("http://", "https://", "about:", "file:")):
        url = f"https://{url}"
        logger.info(f"\U0001f517 Auto-added https:// to URL: {url}")
    event = session.event_bus.dispatch(NavigateToUrlEvent(url=url))
    await event
    await event.event_result(raise_if_any=True, raise_if_none=False)

    if session_id and config:
        try:
            parsed = urlparse(url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            result_data = await inject_local_storage(config, session_id, origin)
            if result_data and result_data.get("injected"):
                logger.info(f"\U0001f4be Injected {result_data.get('count', 0)} localStorage entries for {origin}")
        except Exception as e:
            logger.warning(f"Failed to inject localStorage for {url}: {e}")

    await action_history.record_action(
        dom_service=dom_service,
        action="goto",
        thinking=thinking,
        params={"url": url},
        result={"success": True, "current_url": url},
    )
    return {"success": True, "message": "", "current_url": url}


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
