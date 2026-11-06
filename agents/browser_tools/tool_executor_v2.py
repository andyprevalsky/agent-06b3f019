"""Index-based tool executor for browser automation.

Uses browser-use's BrowserSession for DOM-based element selection and actions.
This replaces the Stagehand/selector-based approach with index-based execution.

browser-use uses an event_bus pattern for actions:
    event = session.event_bus.dispatch(ClickElementEvent(node=element))
    await event

VERIFIED EVENT NAMES (from browser_use/browser/events.py):
- ClickElementEvent(node) - click element
- TypeTextEvent(node, text, clear=True) - type into element
- SendKeysEvent(keys) - keyboard shortcuts like "Tab Tab Enter"
- ClickCoordinateEvent(coordinate_x, coordinate_y) - click at coords
- NavigateToUrlEvent(url, new_tab=False) - navigate
- GoBackEvent() - go back
- ScrollEvent(direction='up'/'down', amount=pixels, node=None) - scroll
- GetDropdownOptionsEvent(node) - get dropdown options
- SelectDropdownOptionEvent(node, text) - select dropdown by text
- ScreenshotEvent(full_page=False) - take screenshot
- WaitEvent(seconds) - wait
- SwitchTabEvent(target_id) - switch to tab by target ID
"""

import asyncio
import contextlib
import logging
from typing import Any, Dict, Optional

from browser_tools.dom_service import DOMService, ActionHistory
from browser_tools.schemas import normalize_browser_wait_ms

logger = logging.getLogger(__name__)


async def execute_browser_tool(
    tool_name: str,
    tool_args: Dict[str, Any],
    dom_service: DOMService,
    action_history: ActionHistory,
    extract_model: str = "openai/gpt-4.1-mini",
    available_file_paths: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Execute a browser automation tool using index-based selection.

    Args:
        tool_name: Name of the tool to execute
        tool_args: Arguments for the tool
        dom_service: DOM service for element interaction
        action_history: Action history for recording actions
        extract_model: Model to use for extract tool
        available_file_paths: Dict mapping filename -> remote path for file uploads
    """
    session = dom_service.session
    if not session:
        return {"success": False, "error": "Browser not connected"}

    try:
        if tool_name == "click":
            return await _execute_click(dom_service, action_history, tool_args)
        elif tool_name == "input_text":
            return await _execute_input_text(dom_service, action_history, tool_args)
        elif tool_name == "press_key":
            return await _execute_press_key(dom_service, tool_args)
        elif tool_name == "click_coordinates":
            return await _execute_click_coordinates(dom_service, action_history, tool_args)
        elif tool_name == "drag":
            return await _execute_drag(dom_service, action_history, tool_args)
        elif tool_name == "dropdown_options":
            return await _execute_dropdown_options(dom_service, tool_args)
        elif tool_name == "select_dropdown":
            return await _execute_select_dropdown(dom_service, action_history, tool_args)
        elif tool_name == "evaluate":
            return await _execute_evaluate(dom_service, tool_args)
        elif tool_name == "extract":
            return {
                "success": False,
                "error": "extract is disabled. Use evaluate to read DOM/page content directly.",
            }
        elif tool_name == "goto":
            return await _execute_goto(dom_service, tool_args)
        elif tool_name == "navback":
            return await _execute_navback(dom_service)
        elif tool_name == "scroll":
            return await _execute_scroll(dom_service, tool_args)
        elif tool_name == "wait":
            return await _execute_wait(tool_args)
        elif tool_name == "done":
            return {"success": True, "done": True, "text": tool_args.get("text", "")}
        elif tool_name == "attempt_completion":
            return {"success": True, "attempt_completion": True}
        # Tab management
        elif tool_name == "switch_tab":
            return await _execute_switch_tab(dom_service, tool_args)
        elif tool_name == "close_tab":
            return await _execute_close_tab(dom_service, tool_args)
        elif tool_name == "open_new_tab":
            return await _execute_open_new_tab(dom_service, tool_args)
        # File upload
        elif tool_name == "upload_file":
            return await _execute_upload_file(dom_service, action_history, tool_args, available_file_paths)
        else:
            return {"success": False, "error": f"Unknown tool: {tool_name}"}
            
    except Exception as e:
        logger.error(f"Error executing tool {tool_name}: {e}")
        return {"success": False, "error": str(e)}


# ============================================================================
# Index-Based Action Implementations
# ============================================================================

async def _execute_click(
    dom_service: DOMService, 
    action_history: ActionHistory,
    args: Dict[str, Any]
) -> Dict[str, Any]:
    """Click element by index using ClickElementEvent."""
    from browser_use.browser.events import ClickElementEvent
    
    index = args.get("index")
    if index is None:
        return {"success": False, "error": "Missing 'index' parameter"}
    
    session = dom_service.session
    element = await dom_service.get_element_by_index(index)
    if not element:
        return {"success": False, "error": f"Element with index {index} not found"}
    
    try:
        event = session.event_bus.dispatch(ClickElementEvent(node=element))
        await event
        try:
            await event.event_result(raise_if_any=True, raise_if_none=False)
        except Exception as e:
            logger.warning(f"Click event result: {e}")
        
        coord_tuple = await dom_service.get_element_coordinates(index)
        coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
        await action_history.record_action(
            dom_service=dom_service,
            action="click",
            index=index,
            coordinates=coords,
            result={"success": True}
        )
        return {"success": True, "clicked_index": index}
    except Exception as e:
        await action_history.record_action(
            dom_service=dom_service,
            action="click",
            index=index,
            result={"success": False, "error": str(e)}
        )
        return {"success": False, "error": str(e)}


async def _execute_input_text(
    dom_service: DOMService,
    action_history: ActionHistory,
    args: Dict[str, Any]
) -> Dict[str, Any]:
    """Type text into element using TypeTextEvent (not InputTextEvent!)."""
    from browser_use.browser.events import TypeTextEvent
    
    index = args.get("index")
    text = args.get("text", "")
    clear = args.get("clear", True)  # TypeTextEvent supports clear param
    
    if index is None:
        return {"success": False, "error": "Missing 'index' parameter"}
    
    session = dom_service.session
    element = await dom_service.get_element_by_index(index)
    if not element:
        return {"success": False, "error": f"Element with index {index} not found"}
    
    try:
        event = session.event_bus.dispatch(TypeTextEvent(node=element, text=text, clear=clear))
        await event
        try:
            await event.event_result(raise_if_any=True, raise_if_none=False)
        except Exception as e:
            logger.warning(f"Type text event result: {e}")
        
        coord_tuple = await dom_service.get_element_coordinates(index)
        coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
        await action_history.record_action(
            dom_service=dom_service,
            action="input_text",
            index=index,
            coordinates=coords,
            params={"text": text},
            result={"success": True}
        )
        return {"success": True, "typed_text": text, "into_index": index}
    except Exception as e:
        await action_history.record_action(
            dom_service=dom_service,
            action="input_text",
            index=index,
            params={"text": text},
            result={"success": False, "error": str(e)}
        )
        return {"success": False, "error": str(e)}


async def _execute_press_key(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Press keyboard keys using SendKeysEvent (not KeyboardEvent!)."""
    from browser_use.browser.events import SendKeysEvent
    
    key = args.get("key", "")
    if not key:
        return {"success": False, "error": "Missing 'key' parameter"}
    
    session = dom_service.session
    
    try:
        # SendKeysEvent uses 'keys' param (string like "Tab Tab Enter" or "ctrl+a")
        event = session.event_bus.dispatch(SendKeysEvent(keys=key))
        await event
        return {"success": True, "pressed_key": key}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _execute_click_coordinates(
    dom_service: DOMService,
    action_history: ActionHistory,
    args: Dict[str, Any]
) -> Dict[str, Any]:
    """Click at coordinates using ClickCoordinateEvent (not ClickAtCoordinatesEvent!)."""
    from browser_use.browser.events import ClickCoordinateEvent
    
    x = args.get("x")
    y = args.get("y")
    
    if x is None or y is None:
        return {"success": False, "error": "Missing 'x' or 'y' parameter"}
    
    session = dom_service.session
    
    try:
        # ClickCoordinateEvent uses coordinate_x and coordinate_y (not x, y)
        event = session.event_bus.dispatch(ClickCoordinateEvent(coordinate_x=x, coordinate_y=y))
        await event
        
        await action_history.record_action(
            dom_service=dom_service,
            action="click_coordinates",
            coordinates=(x, y),
            result={"success": True}
        )
        return {"success": True, "clicked_at": {"x": x, "y": y}}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _execute_drag(
    dom_service: DOMService,
    action_history: ActionHistory,
    args: Dict[str, Any],
    *,
    humanizer: Any = None,
) -> Dict[str, Any]:
    """Drag via CDP mousePressed → mouseMoved → mouseReleased (browser-use Element.drag_to).

    With a humanizer the pointer first travels to the start point along a human
    trajectory; the raw CDP path presses at a pointer that jumped there, which
    FCaptcha scores as "Click injected with no pointer trajectory (teleport clicks)".
    """
    session = dom_service.session
    if not session:
        return {"success": False, "error": "Browser not connected"}

    async def _point(index_key: str, x_key: str, y_key: str, label: str) -> Any:
        x = args.get(x_key)
        y = args.get(y_key)
        if x is not None and y is not None:
            return int(x), int(y)
        index = args.get(index_key)
        if index is None:
            return None
        coords = await dom_service.get_click_coordinates(int(index))
        if not coords:
            coords = await dom_service.get_element_coordinates(int(index))
        if not coords:
            raise ValueError(f"drag {label}: no coordinates for index {index}")
        return int(coords[0]), int(coords[1])

    try:
        start = await _point("source_index", "start_x", "start_y", "start")
        end = await _point("target_index", "end_x", "end_y", "end")
        if start is None:
            return {"success": False, "error": "drag requires source_index or start_x/start_y"}
        if end is None:
            return {"success": False, "error": "drag requires target_index or end_x/end_y"}
        start_x, start_y = start
        end_x, end_y = end
        steps = max(2, min(120, int(args.get("steps") or 24)))
        result = {
            "success": True,
            "start": {"x": start_x, "y": start_y},
            "end": {"x": end_x, "y": end_y},
            "steps": steps,
        }

        if humanizer is not None:
            await humanizer.drag_between(start_x, start_y, end_x, end_y, steps=steps)
            await action_history.record_action(
                dom_service=dom_service,
                action="drag",
                coordinates=(start_x, start_y),
                params={"end": {"x": end_x, "y": end_y}, "steps": steps},
                result={"success": True},
            )
            return result

        cdp_session = await session.get_or_create_cdp_session()
        session_id = cdp_session.session_id
        send = cdp_session.cdp_client.send.Input.dispatchMouseEvent
        pressed = False
        try:
            await send(params={"type": "mouseMoved", "x": start_x, "y": start_y}, session_id=session_id)
            await asyncio.sleep(0.05)
            await send(
                params={
                    "type": "mousePressed",
                    "x": start_x,
                    "y": start_y,
                    "button": "left",
                    "buttons": 1,
                    "clickCount": 1,
                },
                session_id=session_id,
            )
            pressed = True
            for i in range(1, steps + 1):
                t = i / steps
                await send(
                    params={
                        "type": "mouseMoved",
                        "x": start_x + (end_x - start_x) * t,
                        "y": start_y + (end_y - start_y) * t,
                        "button": "left",
                        "buttons": 1,
                    },
                    session_id=session_id,
                )
                await asyncio.sleep(0.01)
            await send(
                params={
                    "type": "mouseReleased",
                    "x": end_x,
                    "y": end_y,
                    "button": "left",
                    "buttons": 0,
                    "clickCount": 1,
                },
                session_id=session_id,
            )
            pressed = False
            await action_history.record_action(
                dom_service=dom_service,
                action="drag",
                coordinates=(start_x, start_y),
                params={"end": {"x": end_x, "y": end_y}, "steps": steps},
                result={"success": True},
            )
            return result
        finally:
            if pressed:
                with contextlib.suppress(Exception):
                    await send(
                        params={
                            "type": "mouseReleased",
                            "x": end_x,
                            "y": end_y,
                            "button": "left",
                            "buttons": 0,
                            "clickCount": 1,
                        },
                        session_id=session_id,
                    )
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Dropdown Tool Implementations
# ============================================================================

async def _execute_dropdown_options(
    dom_service: DOMService,
    args: Dict[str, Any]
) -> Dict[str, Any]:
    """Get options from dropdown using GetDropdownOptionsEvent."""
    from browser_use.browser.events import GetDropdownOptionsEvent
    
    index = args.get("index")
    if index is None:
        return {"success": False, "error": "Missing 'index' parameter"}
    
    session = dom_service.session
    element = await dom_service.get_element_by_index(index)
    
    if not element:
        return {"success": False, "error": f"Element with index {index} not found"}
    
    try:
        event = session.event_bus.dispatch(GetDropdownOptionsEvent(node=element))
        await event
        result = await event.event_result(raise_if_any=True, raise_if_none=False)
        options = result if result else {}
        return {"success": True, "options": options}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _execute_select_dropdown(
    dom_service: DOMService,
    action_history: ActionHistory,
    args: Dict[str, Any]
) -> Dict[str, Any]:
    """Select dropdown option using SelectDropdownOptionEvent (uses 'text' not 'value')."""
    from browser_use.browser.events import SelectDropdownOptionEvent
    
    index = args.get("index")
    value = args.get("value")  # User passes 'value', we map to 'text'
    
    if index is None:
        return {"success": False, "error": "Missing 'index' parameter"}
    if value is None:
        return {"success": False, "error": "Missing 'value' parameter"}
    
    session = dom_service.session
    element = await dom_service.get_element_by_index(index)
    
    if not element:
        return {"success": False, "error": f"Element with index {index} not found"}
    
    try:
        # SelectDropdownOptionEvent uses 'text' param, not 'value'
        event = session.event_bus.dispatch(SelectDropdownOptionEvent(node=element, text=value))
        await event
        
        await action_history.record_action(
            dom_service=dom_service,
            action="select_dropdown",
            index=index,
            params={"value": value},
            result={"success": True}
        )
        return {"success": True, "selected": value, "from_index": index}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# JavaScript Execution
# ============================================================================

async def _execute_evaluate(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute JavaScript using direct CDP (no event exists for this)."""
    code = args.get("code", "")
    if not code:
        return {"success": False, "error": "Missing 'code' parameter"}
    
    session = dom_service.session
    
    try:
        # No EvaluateJavaScriptEvent exists - use CDP directly
        # Get the CDP client from session
        page = await session.get_current_page()
        result = await page.evaluate(code)
        return {"success": True, "result": result}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Observation Tool Implementations
# ============================================================================

async def _execute_extract(
    dom_service: DOMService,
    args: Dict[str, Any],
    model: str
) -> Dict[str, Any]:
    """Extract data from page using browser-use's markdown extraction + LLM.
    
    Uses browser-use's extract_clean_markdown for content extraction,
    then calls gpt-4.1-mini for structured extraction.
    """
    import httpx
    from config import load_config
    
    instruction = args.get("instruction", "")
    extract_links = args.get("extract_links", False)
    start_from_char = args.get("start_from_char", 0)
    
    if not instruction:
        return {"success": False, "error": "Missing 'instruction' parameter"}
    
    try:
        # Use browser-use's native markdown extraction
        from browser_use.dom.markdown_extractor import extract_clean_markdown
        
        session = dom_service.session
        if not session:
            return {"success": False, "error": "Browser not connected"}
        
        # Extract clean markdown (filters ads, noise, normalizes content)
        content, content_stats = await extract_clean_markdown(
            browser_session=session,
            extract_links=extract_links
        )
        
        current_url = await session.get_current_page_url()
        
        # Handle start_from_char for pagination
        if start_from_char > 0:
            if start_from_char >= len(content):
                return {
                    "success": False,
                    "error": f"start_from_char ({start_from_char}) exceeds content length ({len(content)})"
                }
            content = content[start_from_char:]
        
        # Smart truncation with natural break points
        MAX_CHAR_LIMIT = 30000
        truncated = False
        next_start = None
        
        if len(content) > MAX_CHAR_LIMIT:
            truncate_at = MAX_CHAR_LIMIT
            
            # Try to truncate at paragraph break
            paragraph_break = content.rfind('\n\n', MAX_CHAR_LIMIT - 500, MAX_CHAR_LIMIT)
            if paragraph_break > 0:
                truncate_at = paragraph_break
            else:
                # Try sentence break
                sentence_break = content.rfind('.', MAX_CHAR_LIMIT - 200, MAX_CHAR_LIMIT)
                if sentence_break > 0:
                    truncate_at = sentence_break + 1
            
            content = content[:truncate_at]
            truncated = True
            next_start = (start_from_char or 0) + truncate_at
        
        # Build stats summary
        stats_summary = f"Content: {content_stats.get('original_html_chars', 0):,} HTML → {content_stats.get('final_filtered_chars', len(content)):,} chars"
        if truncated:
            stats_summary += f" (truncated, use start_from_char={next_start} to continue)"
        
        # Call LLM for extraction
        config = load_config()
        
        system_prompt = """You are an expert at extracting data from the markdown of a webpage.

<instructions>
1. Extract ONLY the specific information requested by the user
2. Be precise and thorough - include all relevant details
3. If the requested information is not found, clearly state that
4. Format the output clearly and consistently
5. If extracting multiple items, use a consistent structure
</instructions>"""

        user_prompt = f"""URL: {current_url}
{stats_summary}

<page_content>
{content}
</page_content>

<query>
{instruction}
</query>

Extract the requested information from the page content."""

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                config.openrouter.base_url + "/chat/completions",
                headers={
                    "Authorization": f"Bearer {config.openrouter.api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://roselabs.ai",
                    "X-Title": "Rose Browser Agent Extract"
                },
                json={
                    "model": model,  # "openai/gpt-4.1-mini" by default
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    "max_tokens": 4096,
                    "temperature": 0.1
                }
            )
            
            if response.status_code != 200:
                logger.error(f"Extract LLM error: {response.status_code} - {response.text[:500]}")
                return {"success": False, "error": f"Extract LLM HTTP {response.status_code}"}
            
            result = response.json()
            extracted = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            
            response_data = {
                "success": True, 
                "instruction": instruction,
                "content": extracted or "No content extracted",
                "stats": stats_summary
            }
            
            if truncated:
                response_data["truncated"] = True
                response_data["next_start_char"] = next_start
            
            return response_data
            
    except ImportError:
        logger.warning("browser-use markdown_extractor not available, falling back to DOM")
        # Fallback to DOM-based extraction
        state = await dom_service.get_browser_state(include_screenshot=False)
        return {
            "success": True,
            "instruction": instruction,
            "content": state.get("dom_tree", "")[:5000],
            "fallback": True
        }
    except Exception as e:
        logger.error(f"Extract failed: {e}")
        return {"success": False, "error": str(e)}


# ============================================================================
# Navigation Tool Implementations
# ============================================================================

async def _execute_goto(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Navigate to URL using NavigateToUrlEvent."""
    from browser_use.browser.events import NavigateToUrlEvent
    
    url = args.get("url", "")
    if not url:
        return {"success": False, "error": "Missing 'url' parameter"}
    
    session = dom_service.session
    
    try:
        event = session.event_bus.dispatch(NavigateToUrlEvent(url=url))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        return {"success": True, "navigated_to": url}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _execute_navback(dom_service: DOMService) -> Dict[str, Any]:
    """Navigate back using GoBackEvent."""
    from browser_use.browser.events import GoBackEvent
    
    session = dom_service.session
    
    try:
        event = session.event_bus.dispatch(GoBackEvent())
        await event
        return {"success": True, "navigated": "back"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _execute_scroll(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Scroll using ScrollEvent(direction, amount, node)."""
    from browser_use.browser.events import ScrollEvent
    
    direction = args.get("direction", "down")
    amount = args.get("amount", 300)
    index = args.get("index")  # Optional: scroll within element
    if index == 0:
        index = None
    
    session = dom_service.session
    
    try:
        element = None
        if index is not None:
            element = await dom_service.get_element_by_index(index)
        
        # ScrollEvent uses direction ('up'/'down'/'left'/'right') and amount (pixels)
        event = session.event_bus.dispatch(ScrollEvent(
            direction=direction,
            amount=amount,
            node=element
        ))
        await event
        return {"success": True, "scrolled": direction, "amount": amount}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _execute_wait(args: Dict[str, Any]) -> Dict[str, Any]:
    """Wait for specified time. Could use WaitEvent but simpler to just sleep."""
    time_ms = normalize_browser_wait_ms(args.get("time_ms"), default=1000)
    await asyncio.sleep(time_ms / 1000)
    return {"success": True, "waited_ms": time_ms}


# ============================================================================
# Tab Management Tool Implementations
# ============================================================================

async def _execute_switch_tab(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Switch to a different tab by tab_id using SwitchTabEvent."""
    from browser_use.browser.events import SwitchTabEvent
    
    tab_id = args.get("tab_id")
    if not tab_id:
        return {"success": False, "error": "Missing 'tab_id' parameter"}
    
    session = dom_service.session
    
    try:
        # browser-use SwitchTabEvent uses target_id
        # The tab_id from our schema is a 4-char suffix, we need to find the full target_id
        all_targets = session.session_manager.get_all_page_targets()
        target_id = None
        
        for target in all_targets:
            if target.target_id.endswith(tab_id) or target.target_id == tab_id:
                target_id = target.target_id
                break
        
        if not target_id:
            return {"success": False, "error": f"Tab with ID ending in '{tab_id}' not found"}
        
        event = session.event_bus.dispatch(SwitchTabEvent(target_id=target_id))
        await event
        return {"success": True, "switched_to": tab_id, "full_target_id": target_id}
    except Exception as e:
        logger.error(f"Switch tab error: {e}")
        return {"success": False, "error": str(e)}


async def _execute_close_tab(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Close a browser tab by tab_id. Closes current tab if tab_id is None."""
    tab_id = args.get("tab_id")
    session = dom_service.session
    
    try:
        if tab_id:
            # Find the full target_id from the 4-char suffix
            all_targets = session.session_manager.get_all_page_targets()
            target_id = None
            
            for target in all_targets:
                if target.target_id.endswith(tab_id) or target.target_id == tab_id:
                    target_id = target.target_id
                    break
            
            if not target_id:
                return {"success": False, "error": f"Tab with ID ending in '{tab_id}' not found"}
        else:
            # Close current tab
            target_id = session.agent_focus_target_id
            if not target_id:
                return {"success": False, "error": "No current tab to close"}
        
        # Use CDP to close the page
        await session._cdp_close_page(target_id)
        return {"success": True, "closed_tab": tab_id or "current", "target_id": target_id}
    except Exception as e:
        logger.error(f"Close tab error: {e}")
        return {"success": False, "error": str(e)}


async def _execute_open_new_tab(dom_service: DOMService, args: Dict[str, Any]) -> Dict[str, Any]:
    """Open a new tab and optionally navigate to a URL."""
    from browser_use.browser.events import NavigateToUrlEvent

    url = args.get("url", "about:blank")
    session = dom_service.session

    try:
        # NavigateToUrlEvent with new_tab=True creates a new tab
        event = session.event_bus.dispatch(NavigateToUrlEvent(url=url, new_tab=True))
        await event

        # Get the new tab's target_id
        new_target_id = session.agent_focus_target_id

        return {
            "success": True,
            "opened_url": url,
            "new_tab_id": new_target_id[-4:] if new_target_id else None
        }
    except Exception as e:
        logger.error(f"Open new tab error: {e}")
        return {"success": False, "error": str(e)}


# ============================================================================
# File Upload Tool Implementation
# ============================================================================


async def _execute_upload_file(
    dom_service: DOMService,
    action_history: ActionHistory,
    args: Dict[str, Any],
    available_file_paths: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """Upload a file to a file input element using UploadFileEvent.

    Args:
        dom_service: DOM service for element interaction
        action_history: Action history for recording actions
        args: Tool arguments with 'index' and 'filename'
        available_file_paths: Dict mapping filename -> remote file path in Steel session
    """
    from browser_use.browser.events import UploadFileEvent

    index = args.get("index")
    filename = args.get("filename")

    if index is None:
        return {"success": False, "error": "Missing 'index' parameter"}
    if not filename:
        return {"success": False, "error": "Missing 'filename' parameter"}

    # Validate file is available
    if not available_file_paths or filename not in available_file_paths:
        available_files = list(available_file_paths.keys()) if available_file_paths else []
        return {
            "success": False,
            "error": f"File '{filename}' not available. Available files: {available_files}"
        }

    remote_path = available_file_paths[filename]

    session = dom_service.session
    element = await dom_service.get_element_by_index(index)

    if not element:
        return {"success": False, "error": f"Element with index {index} not found"}

    # Check if it's a file input
    if not session.is_file_input(element):
        return {"success": False, "error": f"Element {index} is not a file input (<input type='file'>)"}

    try:
        # Dispatch UploadFileEvent with the remote path
        event = session.event_bus.dispatch(UploadFileEvent(node=element, file_path=remote_path))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)

        # Record the action
        coord_tuple = await dom_service.get_element_coordinates(index)
        coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
        await action_history.record_action(
            dom_service=dom_service,
            action="upload_file",
            index=index,
            coordinates=coords,
            params={"filename": filename},
            result={"success": True}
        )

        logger.info(f"📎 Uploaded file '{filename}' to element {index}")
        return {
            "success": True,
            "uploaded": filename,
            "to_index": index,
            "message": ""
        }
    except Exception as e:
        await action_history.record_action(
            dom_service=dom_service,
            action="upload_file",
            index=index,
            params={"filename": filename},
            result={"success": False, "error": str(e)}
        )
        logger.error(f"Upload file error: {e}")
        return {"success": False, "error": str(e)}
