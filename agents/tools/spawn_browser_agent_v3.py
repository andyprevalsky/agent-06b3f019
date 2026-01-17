"""Browser automation tool using run_agent loop + browser-use BrowserSession.

This is the v3 version that uses:
- browser-use BrowserSession for DOM extraction and CDP actions
- Rose API's rose-1-browser-use for LLM decisions
- Always captures screenshots after each action (no screenshot tool)
- Index-based element selection
"""

from typing import Dict, Any, Optional, AsyncGenerator, List
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta, datetime, timezone
import structlog
import httpx
import time
import asyncio
import json
import uuid as uuid_module
import base64

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageType, UsageItem
from temporalio.exceptions import ActivityError, CancelledError as TemporalCancelledError
from browser_tools.schemas import BROWSER_TOOL_MODELS, AVAILABLE_ACTIONS
from browser_tools.dom_service import DOMService, ActionHistory
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.prompts import build_verifier_prompt
from helpers.file_resolution import resolve_file_pointers_from_extracted, transform_schema_for_remote_session
from helpers.attachments import extract_attachments_from_context
from loop.activity_helper import call_temporal_activity_from_activity
from config import load_config
from helpers.error_utils import extract_error_message

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


# ========================================
# MESSAGE HELPERS
# ========================================

async def save_browser_action_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    browser_url: str = "",
    action_type: str = "default",
    auxiliary: dict = None,
    tool_call_id: str = None,
    is_init_message: bool = False,
    output_schema: dict = None,
):
    """Save browser sub-action message directly to DB."""
    try:
        config = load_config()
        unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

        metadata = {
            "toolCallId": unique_tool_call_id,
            "toolName": "spawn_browser_agent",
            "toolStatus": status.value,
            "title": title,
            "task_id": task_id,
            "browser_url": browser_url,
            "action_type": action_type,
            "auxiliary": auxiliary or {}
        }

        # Include output schema in init message for FE display
        if output_schema:
            metadata["output_schema"] = output_schema

        if not is_init_message:
            metadata["subAgentId"] = task_id
        
        if status == MessageStatus.ERROR:
            metadata["error"] = True
        
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save browser action message", error=extract_error_message(e))


async def save_browser_assistant_message(
    agent_id: str,
    message: str,
    task_id: str,
):
    """Save browser ASSISTANT message directly to DB."""
    try:
        config = load_config()
        metadata = {"subAgentId": task_id}
        
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "ASSISTANT",
                    "metadata": metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save browser assistant message", error=extract_error_message(e))


# ========================================
# CONTEXT SUMMARY BUILDER
# ========================================

def build_context_summary(
    success: bool,
    close_reasoning: str,
    visited_urls: list,
    reasoning_messages: list,
    action_summary: list,
    error_context: str = None
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts = []
    
    status = "✅ SUCCESS" if success else "❌ FAILED"
    summary_parts.append(f"**Status**: {status}")
    
    if close_reasoning:
        summary_parts.append(f"\n**Outcome**: {close_reasoning}")
    
    if error_context:
        summary_parts.append(f"\n**Error**: {error_context}")
    
    if visited_urls:
        last_urls = visited_urls[-5:]
        summary_parts.append(f"\n**URLs Visited** ({len(visited_urls)} total, showing last {len(last_urls)}):")
        for i, url in enumerate(last_urls, 1):
            summary_parts.append(f"  {i}. {url}")
    
    if reasoning_messages:
        last_reasoning = reasoning_messages[-3:]
        summary_parts.append(f"\n**Agent Reasoning** (last {len(last_reasoning)}):")
        for i, reasoning in enumerate(last_reasoning, 1):
            summary_parts.append(f"  {i}. {reasoning}")
    
    if action_summary:
        last_actions = action_summary[-10:]
        summary_parts.append(f"\n**Actions Taken** ({len(action_summary)} total, showing last {len(last_actions)}):")
        for action in last_actions:
            summary_parts.append(f"  • {action}")
    
    return "\n".join(summary_parts)


# ========================================
# PAYMENT/AUTOPAY HELPERS
# ========================================

def decrypt_payment_info(encrypted_data: str, decryption_key_b64: str) -> Optional[Dict[str, Any]]:
    """Decrypt payment information using hybrid RSA+AES decryption."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    
    try:
        envelope_json = base64.b64decode(encrypted_data).decode('utf-8')
        envelope = json.loads(envelope_json)
        
        if envelope.get("version") != 1:
            return None
        
        private_key_pem = base64.b64decode(decryption_key_b64)
        private_key = serialization.load_pem_private_key(private_key_pem, password=None)
        
        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )
        
        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]
        
        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag))
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()
        
        return json.loads(plaintext.decode('utf-8'))
    except Exception as e:
        logger.error("Failed to decrypt payment info", error=extract_error_message(e))
        return None


def build_autopay_prompt_section(payment_data: Dict[str, Any]) -> str:
    """Build the autopay section for the browser agent system prompt."""
    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
    autopay_limit_dollars = autopay_limit_cents / 100
    
    card_number = payment_data.get("card_number", "")
    card_number_formatted = " ".join([card_number[i:i+4] for i in range(0, len(card_number), 4)])
    
    billing_lines = [
        payment_data.get("billing_street_address", ""),
        payment_data.get("billing_address_line2", ""),
        f"{payment_data.get('billing_city', '')}, {payment_data.get('billing_state', '')} {payment_data.get('billing_zipcode', '')}",
        payment_data.get("billing_country", "")
    ]
    billing_address = "\n".join(line for line in billing_lines if line.strip())
    
    contact_info = ""
    if payment_data.get("billing_phone"):
        contact_info += f"\nPhone: {payment_data['billing_phone']}"
    if payment_data.get("billing_email"):
        contact_info += f"\nEmail: {payment_data['billing_email']}"
    
    return f"""

AUTOPAY ENABLED (limit: ${autopay_limit_dollars:.2f}):
When you reach a checkout/payment page, use this card information:

Card Number: {card_number_formatted}
Cardholder Name: {payment_data.get('cardholder_name', '')}
Expiry: {payment_data.get('card_expiry', '')}
CVV: {payment_data.get('card_cvv', '')}

Billing Address:
{billing_address}{contact_info}

PAYMENT RULES:
- If order total <= ${autopay_limit_dollars:.2f}: Complete payment using card above
- If order total > ${autopay_limit_dollars:.2f}: Use send_message_to_user with is_question=true to request approval before paying
- Always verify the total before entering card details
- Double-check the billing address matches before submitting"""


# ========================================
# EXTRACT LLM CALL (gpt-4.1-mini)
# ========================================

async def _call_extract_llm(
    instruction: str,
    page_content: str,
    current_url: str,
) -> str:
    """Call gpt-4.1-mini via OpenRouter to extract structured data from page.
    
    Args:
        instruction: User's extraction instruction
        page_content: DOM tree or page text content
        current_url: Current page URL for context
        
    Returns:
        Extracted content as string
    """
    config = load_config()
    
    # Truncate page content if too long (gpt-4.1-mini has ~128k context)
    max_content_len = 50000
    truncated_content = page_content[:max_content_len]
    if len(page_content) > max_content_len:
        truncated_content += f"\n\n... [truncated {len(page_content) - max_content_len} chars]"
    
    system_prompt = """You are a data extraction assistant. Extract information from the provided web page content according to the user's instruction.

Be precise and only extract what is asked for. If the requested information is not found, say so clearly.

Return the extracted data in a clear, structured format."""

    user_prompt = f"""URL: {current_url}

PAGE CONTENT:
{truncated_content}

EXTRACTION INSTRUCTION:
{instruction}

Extract the requested information from the page content above."""

    try:
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
                    "model": "openai/gpt-4.1-mini",
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
                return f"Extraction failed: HTTP {response.status_code}"
            
            result = response.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            return content or "No content extracted"
            
    except Exception as e:
        logger.error(f"Extract LLM call failed: {e}")
        return f"Extraction failed: {str(e)}"


# ========================================
# ROSE API BROWSER-USE CALL
# ========================================

async def call_rose_browser_use(
    task: str,
    browser_state: Dict[str, Any],
    action_history: list,
    config: Any,
) -> Dict[str, Any]:
    """Call Rose API rose-1-browser-use endpoint.
    
    Args:
        task: The browser automation task/goal
        browser_state: Current browser state (url, dom_tree, screenshot, viewport, scroll_position)
        action_history: List of previous action entries
        config: App config with Rose API credentials
        
    Returns:
        Dict with 'action' (UnifiedAction) and metadata
    """
    request_body = {
        "model": "rose-labs/rose-1-browser-use",
        "task": task,
        "browser_state": browser_state,
        "action_history": action_history,
        "available_actions": AVAILABLE_ACTIONS,
    }

    # Log full request for debugging (truncate screenshot to avoid huge logs)
    log_body = {
        **request_body,
        "browser_state": {
            **browser_state,
            "screenshot": f"<base64 {len(browser_state.get('screenshot', ''))} chars>" if browser_state.get('screenshot') else None,
            "dom_tree": f"<{len(browser_state.get('dom_tree', ''))} chars>" if browser_state.get('dom_tree') else None,
        }
    }
    logger.info("📤 Rose browser-use request", request=json.dumps(log_body, indent=2, default=str))

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            config.rose.api_url,
            headers={
                "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                "x-api-key": config.rose.api_key,
                "Content-Type": "application/json"
            },
            json=request_body
        )
        
        if response.status_code != 200:
            error_text = response.text
            logger.error(f"Rose API error: {response.status_code} - {error_text}")
            raise RuntimeError(f"Rose API error: {response.status_code}")

        result = response.json()
        logger.info("📥 Rose browser-use response", response=json.dumps(result, indent=2, default=str))
        return result


# ========================================
# BROWSER ACTION EXECUTION
# ========================================

def get_element_description(element, max_length: int = 40) -> str:
    """Get a human-readable description of a DOM element.
    
    Args:
        element: EnhancedDOMTreeNode from browser-use
        max_length: Max length of the description
        
    Returns:
        Human-readable string like '<button>Submit' or '<input placeholder="Search">'
    """
    if not element:
        return "unknown"
    
    tag = element.tag_name.lower() if element.tag_name else "element"
    attrs = element.attributes or {}
    
    # Try to get meaningful identifier in order of preference
    identifier = ""
    
    # 1. Text content (for buttons, links, etc.)
    try:
        text = element.get_all_children_text()
        if text and len(text.strip()) > 0:
            text = text.strip()[:30]
            identifier = f'"{text}"'
    except:
        pass
    
    # 2. Placeholder (for inputs)
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
        identifier = f'#{attrs["id"][:15]}'
    
    # 6. type for inputs
    if not identifier and tag == "input" and attrs.get("type"):
        identifier = f'type="{attrs["type"]}"'
    
    # Build description
    if identifier:
        desc = f"<{tag} {identifier}>"
    else:
        desc = f"<{tag}>"
    
    return desc[:max_length]


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
                "returnByValue": True
            },
            session_id=cdp_session.session_id
        )
    except:
        pass  # Visual cursor is optional


async def execute_action(
    dom_service: DOMService,
    action_history: ActionHistory,
    action: Dict[str, Any],
    available_file_paths: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Execute a browser action using browser-use events.

    Args:
        dom_service: DOMService wrapping browser-use BrowserSession
        action_history: ActionHistory for recording actions
        action: UnifiedAction dict with action, index, coordinates, params, thinking
        available_file_paths: Dict mapping filename -> remote path for file uploads

    Returns:
        Result dict with success, message, and any additional data
    """
    from browser_use.browser.events import (
        ClickElementEvent,
        ClickCoordinateEvent,
        TypeTextEvent,
        SendKeysEvent,
        ScrollEvent,
        NavigateToUrlEvent,
        GoBackEvent,
        WaitEvent,
        GetDropdownOptionsEvent,
        SelectDropdownOptionEvent,
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
        # Get element from selector map if index provided
        element = None
        if index is not None:
            element = dom_service.selector_map.get(index)
            if not element:
                return {"success": False, "error": f"Element with index {index} not found"}
        
        # Execute action based on type
        if action_name == "click":
            if element:
                # Index-based click (DOM models)
                # Get coordinates first to move visual cursor
                coord_tuple = await dom_service.get_element_coordinates(index)
                element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
                if element_coords:
                    await move_visual_cursor(dom_service, element_coords["x"], element_coords["y"])
                
                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_interaction_element(element))
                
                event = session.event_bus.dispatch(ClickElementEvent(node=element))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)
                await action_history.record_action(
                    dom_service=dom_service,
                    action="click",
                    thinking=thinking,
                    index=index,
                    coordinates=element_coords,
                    result={"success": True}
                )
                return {"success": True, "message": ""}
            elif coords:
                # Coordinate-based click (vision models like Yutori)
                # Move visual cursor first
                await move_visual_cursor(dom_service, int(coords["x"]), int(coords["y"]))
                
                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_coordinate_click(int(coords["x"]), int(coords["y"])))
                
                event = session.event_bus.dispatch(ClickCoordinateEvent(
                    coordinate_x=int(coords["x"]),
                    coordinate_y=int(coords["y"])
                ))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)
                
                await action_history.record_action(
                    dom_service=dom_service,
                    action="click",
                    thinking=thinking,
                    coordinates=coords,
                    result={"success": True}
                )
                return {"success": True, "message": ""}
            else:
                return {"success": False, "error": "Click requires either element index or coordinates"}
        
        elif action_name == "input_text":
            text = params.get("text", "")
            if element:
                # Index-based input (DOM models)
                # Get coordinates first to move visual cursor
                coord_tuple = await dom_service.get_element_coordinates(index)
                element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
                if element_coords:
                    await move_visual_cursor(dom_service, element_coords["x"], element_coords["y"])
                
                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_interaction_element(element))
                
                event = session.event_bus.dispatch(TypeTextEvent(node=element, text=text))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)
                await action_history.record_action(
                    dom_service=dom_service,
                    action="input_text",
                    thinking=thinking,
                    index=index,
                    coordinates=element_coords,
                    params={"text": text},
                    result={"success": True}
                )
                return {"success": True, "message": ""}
            elif coords:
                # Coordinate-based input (vision models like Yutori)
                # Move visual cursor first
                await move_visual_cursor(dom_service, int(coords["x"]), int(coords["y"]))
                
                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_coordinate_click(int(coords["x"]), int(coords["y"])))
                
                # First click to focus the element
                click_event = session.event_bus.dispatch(ClickCoordinateEvent(
                    coordinate_x=int(coords["x"]),
                    coordinate_y=int(coords["y"])
                ))
                await click_event
                await click_event.event_result(raise_if_any=True, raise_if_none=False)
                
                # Small delay to ensure focus
                await asyncio.sleep(0.1)
                
                # Then type using SendKeysEvent (types to focused element)
                type_event = session.event_bus.dispatch(SendKeysEvent(keys=text))
                await type_event
                await type_event.event_result(raise_if_any=True, raise_if_none=False)
                
                await action_history.record_action(
                    dom_service=dom_service,
                    action="input_text",
                    thinking=thinking,
                    coordinates=coords,
                    params={"text": text},
                    result={"success": True}
                )
                return {"success": True, "message": ""}
            else:
                # Fallback: no index or coords - type to currently focused element
                type_event = session.event_bus.dispatch(SendKeysEvent(keys=text))
                await type_event
                await type_event.event_result(raise_if_any=True, raise_if_none=False)
                
                await action_history.record_action(
                    dom_service=dom_service,
                    action="input_text",
                    thinking=thinking,
                    params={"text": text},
                    result={"success": True}
                )
                return {"success": True, "message": ""}
        
        elif action_name == "press_key":
            key = params.get("key", "")
            event = session.event_bus.dispatch(SendKeysEvent(keys=key))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="press_key",
                thinking=thinking,
                params={"key": key},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "scroll":
            direction = params.get("direction", "down")
            amount = params.get("amount", 300)
            
            # ScrollEvent uses direction (up/down/left/right), amount (pixels), and node (optional)
            event = session.event_bus.dispatch(ScrollEvent(
                direction=direction,
                amount=amount,
                node=element if index is not None else None
            ))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="scroll",
                thinking=thinking,
                index=index,
                params={"direction": direction, "amount": amount},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "goto":
            url = params.get("url", "")
            event = session.event_bus.dispatch(NavigateToUrlEvent(url=url))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="goto",
                thinking=thinking,
                params={"url": url},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "navback":
            event = session.event_bus.dispatch(GoBackEvent())
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="navback",
                thinking=thinking,
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "wait":
            time_ms = params.get("time_ms", 1000)
            seconds = time_ms / 1000.0
            # WaitEvent uses seconds (float), not timeout_ms
            event = session.event_bus.dispatch(WaitEvent(seconds=seconds))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="wait",
                thinking=thinking,
                params={"time_ms": time_ms},
                result={"success": True}
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
            # SelectDropdownOptionEvent uses 'text' param, not 'value'
            event = session.event_bus.dispatch(SelectDropdownOptionEvent(node=element, text=value))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="select_dropdown",
                thinking=thinking,
                index=index,
                params={"value": value},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "evaluate":
            code = params.get("code", "")
            cdp_session = await session.get_or_create_cdp_session(focus=True)
            result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": code, "returnByValue": True},
                session_id=cdp_session.session_id
            )
            value = result.get("result", {}).get("value")
            
            await action_history.record_action(
                dom_service=dom_service,
                action="evaluate",
                thinking=thinking,
                params={"code": code},
                result={"success": True, "value": value}
            )
            return {"success": True, "message": f"Executed JS, result: {value}", "value": value}
        
        elif action_name == "extract":
            instruction = params.get("instruction", "")
            extract_links = params.get("extract_links", False)
            
            # Use browser-use's native markdown extraction
            from browser_use.dom.markdown_extractor import extract_clean_markdown
            
            try:
                # Extract clean markdown (filters ads, noise)
                content, content_stats = await extract_clean_markdown(
                    browser_session=session,
                    extract_links=extract_links
                )
                current_url = await session.get_current_page_url()
                
                # Call gpt-4.1-mini for extraction
                extracted_content = await _call_extract_llm(
                    instruction=instruction,
                    page_content=content,
                    current_url=current_url,
                )
                
                await action_history.record_action(
                    dom_service=dom_service,
                    action="extract",
                    thinking=thinking,
                    params={"instruction": instruction},
                    result={"success": True, "content": extracted_content}
                )
                return {"success": True, "message": extracted_content, "content": extracted_content}
            except Exception as e:
                logger.error(f"Extract failed: {e}")
                return {"success": False, "error": str(e)}
        
        elif action_name == "done":
            text = params.get("text", "")
            await action_history.record_action(
                dom_service=dom_service,
                action="done",
                thinking=thinking,
                params={"text": text},
                result={"success": True}
            )
            return {"success": True, "done": True, "message": text}
        
        elif action_name == "attempt_completion":
            await action_history.record_action(
                dom_service=dom_service,
                action="attempt_completion",
                thinking=thinking,
                params={},
                result={"success": True}
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
                result={"success": True}
            )
            return {"success": True, "message_to_user": True, "message": message, "reason": reason}

        elif action_name == "upload_file":
            from browser_use.browser.events import UploadFileEvent

            filename = params.get("filename", "")
            if not filename:
                return {"success": False, "error": "Missing 'filename' parameter"}

            # Validate file is available
            if not available_file_paths or filename not in available_file_paths:
                available_files = list(available_file_paths.keys()) if available_file_paths else []
                return {
                    "success": False,
                    "error": f"File '{filename}' not available. Available files: {available_files}"
                }

            if not element:
                return {"success": False, "error": "upload_file requires an element index for the file input"}

            # Check if it's a file input
            if not session.is_file_input(element):
                return {"success": False, "error": f"Element {index} is not a file input (<input type='file'>)"}

            remote_path = available_file_paths[filename]

            # Get coordinates for visual cursor
            coord_tuple = await dom_service.get_element_coordinates(index)
            element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
            if element_coords:
                await move_visual_cursor(dom_service, element_coords["x"], element_coords["y"])

            # Dispatch UploadFileEvent with the remote path
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
                result={"success": True}
            )

            logger.info(f"📎 Uploaded file '{filename}' to element {index}")
            return {
                "success": True,
                "message": "",
                "uploaded": filename,
                "to_index": index
            }

        else:
            return {"success": False, "error": f"Unknown action: {action_name}"}
            
    except Exception as e:
        logger.error(f"Action {action_name} failed: {e}")
        # Record failed action (preserve coordinates for debugging)
        await action_history.record_action(
            dom_service=dom_service,
            action=action_name,
            thinking=thinking,
            index=index,
            coordinates=coords,
            params=params,
            result={"success": False, "error": str(e)}
        )
        return {"success": False, "error": str(e)}


# ========================================
# BROWSER SYSTEM PROMPT
# ========================================

def get_browser_system_prompt(
    goal: str,
    current_url: str,
    custom_instructions: str = "",
    available_files: Optional[List[str]] = None
) -> str:
    """Build browser agent system prompt.

    Args:
        goal: The task goal
        current_url: Current browser URL
        custom_instructions: Additional instructions
        available_files: List of filenames available for upload
    """
    current_time = datetime.now().strftime("%B %d, %Y at %I:%M %p")

    # Build available files section if files are present
    files_section = ""
    if available_files:
        files_section = f"""
AVAILABLE FILES FOR UPLOAD:
The following files are available to upload using the upload_file action.
To upload a file, find a file input element (<input type="file">) and use upload_file with the filename.
Files: {', '.join(available_files)}
"""

    return f"""You are a browser automation agent. Your goal is to accomplish tasks by interacting with web pages.

Current time: {current_time}

CURRENT GOAL: {goal}
CURRENT URL: {current_url}
{files_section}
You will receive:
1. The current DOM tree with indexed elements like [1] button "Submit", [2] input[type=text], etc.
2. A screenshot of the current page
3. History of your previous actions and their results

To interact with elements, use their index number from the DOM tree.

AVAILABLE ACTIONS:
- click: Click an element by index
- input_text: Type text into an input element
- press_key: Press keyboard keys (Enter, Tab, Escape, etc.)
- scroll: Scroll the page up or down
- goto: Navigate to a URL
- navback: Go back in browser history
- wait: Wait for a specified time
- dropdown_options: Get options from a dropdown
- select_dropdown: Select an option from a dropdown
- evaluate: Execute JavaScript
- extract: Extract structured data from the page
- upload_file: Upload a file to a file input element (requires filename from available_files)
- attempt_completion: Signal you believe the task is complete
- send_message_to_user: Request user assistance

{custom_instructions}

Think step-by-step about what action to take next. Always prefer using element indices from the DOM tree for precise interactions."""


# ========================================
# TEMPORAL ACTIVITY (V3 - browser-use)
# ========================================

@activity.defn
async def spawn_browser_agent_activity_v3(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    cdp_url: Optional[str] = None,
    is_resume: bool = False,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Browser agent activity using browser-use BrowserSession + Rose API.

    Key changes from v2:
    - Uses browser-use BrowserSession instead of Stagehand
    - Calls Rose API rose-1-browser-use for LLM decisions
    - Always takes screenshots after actions (no screenshot tool)
    - Index-based element selection

    Args:
        output_schema: Response schema from parent agent's tool call (required for sub-agents)
        attachments: List of FilePointer dicts for files to upload to the browser session
    """
    from helpers.llm import check_progress
    from tools.knowledge_base import query_blueprints_activity

    dom_service = None
    action_history = ActionHistory()
    browser_url = None
    config = load_config()
    start_time = _safe_time()

    # Token tracking for usage
    total_input_tokens = 0
    total_output_tokens = 0

    # Execution tracking
    visited_urls = []
    reasoning_messages = []
    action_summary = []

    # Use response schema from parent agent's tool call (required)
    response_schema = output_schema
    if not response_schema:
        raise ValueError("output_schema is required for browser agent - parent agent must provide structured output schema in tool call")
    logger.info("Using response schema from tool call", fields=len(response_schema.get("fields", [])))
    
    try:
        # ===== SESSION INITIALIZATION =====
        if is_resume and task_id:
            logger.info("🔍 Fetching session info for resumed task", task_id=task_id)
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{config.backend.api_url}/api/browser-session/task/{task_id}",
                    headers={"x-api-key": config.backend.api_key or ""}
                )
                if response.status_code == 200:
                    session_info = response.json()
                    session_id = session_info.get("session_id")
                    browser_url = session_info.get("debug_url")
                    cdp_url = session_info.get("ws_url")  # CDP WebSocket URL
                else:
                    raise RuntimeError(f"Failed to fetch session info: HTTP {response.status_code}")
            activity.heartbeat(f"Resuming task {task_id}")
        else:
            activity.heartbeat("Initializing browser session")
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{config.backend.api_url}/api/browser-session/init",
                    headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                    json={"user_id": user_id, "agent_id": agent_id}
                )
                if response.status_code not in [200, 201]:
                    raise Exception(f"Failed to init session: {response.text}")
                
                session_data = response.json()
                task_id = session_data["task_id"]
                session_id = session_data["session_id"]
                browser_url = session_data["debug_url"]
                cdp_url = session_data.get("ws_url")  # CDP WebSocket URL from Browserbase
            
            # Init message - include output_schema for FE display
            await save_browser_action_message(
                agent_id=agent_id, title="Browser Ready", task_id=task_id,
                message="", status=MessageStatus.FINISHED, browser_url=browser_url,
                action_type="browser", tool_call_id=tool_call_id, is_init_message=True,
                output_schema=response_schema
            )
            await save_browser_action_message(
                agent_id=agent_id, title="Task Started", task_id=task_id,
                message=goal, status=MessageStatus.FINISHED, browser_url=browser_url,
                action_type="task_started"
            )
        
        # ===== BROWSER-USE SESSION INITIALIZATION =====
        if not cdp_url:
            raise RuntimeError("No CDP URL provided - backend must return ws_url from Browserbase")
        
        activity.heartbeat(f"Connecting via CDP: {cdp_url[:50]}...")
        
        dom_service = DOMService(cdp_url=cdp_url)
        await dom_service.connect()
        
        logger.info(f"🌐 Connected to browser via CDP")

        # ===== UPLOAD ATTACHMENTS TO STEEL SESSION =====
        available_file_paths: Dict[str, str] = {}  # filename -> remote path
        if attachments:
            logger.info(f"📎 Uploading {len(attachments)} attachments to Steel session")
            from helpers.attachments import download_from_storage

            for fp in attachments:
                try:
                    filename = fp.get("original_filename", "")
                    storage_path = fp.get("storage_path", "")
                    if not filename or not storage_path:
                        logger.warning(f"Skipping invalid attachment: {fp}")
                        continue

                    # Download file from Supabase Storage
                    activity.heartbeat(f"Downloading {filename}...")
                    file_content = await download_from_storage(storage_path)

                    # Upload to Steel session via backend API
                    activity.heartbeat(f"Uploading {filename} to browser session...")
                    async with httpx.AsyncClient(timeout=60.0) as client:
                        response = await client.post(
                            f"{config.backend.api_url}/api/browser-session/{session_id}/files",
                            headers={"x-api-key": config.backend.api_key or ""},
                            files={"file": (filename, file_content, fp.get("mime_type", "application/octet-stream"))}
                        )
                        if response.status_code in [200, 201]:
                            upload_result = response.json()
                            remote_path = upload_result.get("path", f"/tmp/{filename}")
                            available_file_paths[filename] = remote_path
                            logger.info(f"📎 Uploaded {filename} -> {remote_path}")
                        else:
                            logger.error(f"Failed to upload {filename}: HTTP {response.status_code} - {response.text[:200]}")

                except Exception as e:
                    logger.error(f"Failed to upload attachment {fp.get('original_filename', '?')}: {e}")

            if available_file_paths:
                logger.info(f"📎 Available files for browser: {list(available_file_paths.keys())}")

        # ===== INJECT VISUAL CURSOR (persists across navigations) =====
        try:
            session = dom_service.session
            cdp_session = await session.get_or_create_cdp_session(focus=True)
            # Use addScriptToEvaluateOnNewDocument so cursor persists across navigations
            cursor_script = """
                (() => {
                    if (window.__roseCursorInjected) return;
                    window.__roseCursorInjected = true;
                    const existing = document.getElementById('rose-agent-cursor');
                    if (existing) existing.remove();
                    const cursor = document.createElement('div');
                    cursor.id = 'rose-agent-cursor';
                    cursor.style.cssText = `
                        position: fixed; width: 20px; height: 20px;
                        background: radial-gradient(circle, rgba(239,68,68,0.9) 0%, rgba(239,68,68,0.4) 50%, transparent 70%);
                        border-radius: 50%; pointer-events: none; z-index: 999999;
                        transform: translate(-50%, -50%); transition: left 0.15s ease-out, top 0.15s ease-out;
                        box-shadow: 0 0 10px rgba(239,68,68,0.5); display: none;
                    `;
                    document.body.appendChild(cursor);
                    window.__moveRoseCursor = (x, y) => { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; cursor.style.display = 'block'; };
                    window.__hideRoseCursor = () => { cursor.style.display = 'none'; };
                })();
            """
            # Register script to run on every new document (survives navigation)
            await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": cursor_script, "runImmediately": True},
                session_id=cdp_session.session_id
            )
            logger.info("🎯 Injected visual cursor (persistent)")
        except Exception as e:
            logger.warning(f"Failed to inject visual cursor: {e}")
        
        # ===== REPLACE BROWSER-USE LOGO WITH ROSE LOGO =====
        try:
            logo_replace_script = """
                (() => {
                    const ROSE_LOGO_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIxIDYyIDIyMCAyMjIiIHdpZHRoPSIyMjAiIGhlaWdodD0iMjIyIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDMwMykgc2NhbGUoMC4xLC0wLjEpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0xMjc2IDIzNzggYy0xNDUgLTE5MiAtMjMxIC00NDIgLTIxMSAtNjE2IDggLTY4IDQxIC0yMDIgNjEgLTI1MSA4IC0xOSAxMyAtMzUgMTEgLTM3IC0yIC0yIC0zMCA3IC02MiAyMSAtMjQ5IDEwMCAtNTM3IDU0IC03ODQgLTEyNCAtMzYgLTI1IC02OSAtNDkgLTc1IC01MyAtMTcgLTExIDIyIC00NiAxMTkgLTEwNSAxNjMgLTEwMSAzMDAgLTE0NCA0NjAgLTE0NCA5MiAtMSAyMjYgMjQgMzAxIDU2IDIwIDggMzggMTUgMzkgMTUgMiAwIC0xMCAtMzkgLTI1IC04NyAtNjkgLTIxMyAtNTggLTM5NSAzNiAtNjAwIDMxIC02OSAxMzYgLTIzNyAxNTQgLTI0OCAxMCAtNiAxMTQgMTQ0IDE1MiAyMjAgMzcgNzMgNzUgMTk5IDg4IDI5MyAxNCAxMDEgMSAyMDYgLTQwIDMzMCAtMTUgNDggLTI3IDg4IC0yNiA4OSAxIDIgMjYgLTcgNTUgLTE4IDE5NSAtNzQgNDIzIC02NiA2MTEgMjIgOTggNDYgMjE3IDExOCAyNDUgMTQ5IDE4IDIwIDE4IDIxIC0xIDM1IC0xNzcgMTM5IC0zOTYgMjI1IC01NzAgMjI1IC03OSAwIC0xOTUgLTIzIC0yODIgLTU2IC00NCAtMTYgLTYzIC0yMCAtNTkgLTExIDI3IDcyIDYwIDE5NiA2OCAyNjAgMTcgMTMyIC0xNyAzMDAgLTg5IDQ0MiAtMzYgNzIgLTEyNCAyMDkgLTE0MSAyMTkgLTUgNCAtMjEgLTggLTM1IC0yNnogbTQwIC05MzUgYzcgLTQ2IDUwIC05MiAxMDkgLTExOSAyNyAtMTMgNDEgLTIzIDMxIC0yMyAtMTEgLTEgLTM4IC0xMiAtNjIgLTI2IC00OSAtMjkgLTgzIC05MCAtODUgLTE1MSAtMSAtMzcgLTIgLTM2IC05IDEzIC00IDI5IC0xNyA2NyAtMjggODUgLTIyIDM1IC04NiA3NyAtMTE4IDc5IC0xMSAwIDEgOSAyNiAyMCA3OSAzNSAxMTggOTAgMTIxIDE2OCAxIDI1IDMgMjggNiAxMSAyIC0xNCA2IC0zOSA5IC01N3oiLz4KICA8L2c+Cjwvc3ZnPg==';
                    
                    function replaceLogo() {
                        const img = document.querySelector('#pretty-loading-animation img');
                        if (img && img.src.includes('browser-use.com')) {
                            img.src = ROSE_LOGO_URL;
                            img.alt = 'Rose';
                        }
                    }
                    
                    replaceLogo();
                    const observer = new MutationObserver(replaceLogo);
                    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
                    setTimeout(() => observer.disconnect(), 10000);
                })();
            """
            await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": logo_replace_script, "runImmediately": True},
                session_id=cdp_session.session_id
            )
            logger.info("🎨 Replaced browser-use logo with Rose logo")
        except Exception as e:
            logger.warning(f"Failed to replace logo: {e}")
        
        # ===== FETCH USER PROFILE =====
        user_profile = {}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{config.backend.api_url}/api/user-settings",
                    headers={"X-API-Key": config.backend.api_key, "x-user-id": user_id}
                )
                if resp.status_code == 200:
                    user_profile = resp.json()
        except:
            pass
        
        # Build shipping section
        shipping_section = ""
        if user_profile.get("addressLine1"):
            addr_lines = [
                user_profile.get("name", ""),
                user_profile["addressLine1"],
                user_profile.get("addressLine2", ""),
                f"{user_profile.get('city', '')}, {user_profile.get('state', '')} {user_profile.get('postalCode', '')}",
                user_profile.get("country", "United States")
            ]
            shipping_address = "\n".join(line for line in addr_lines if line)
            shipping_section = f"\n\nUSER SHIPPING ADDRESS:\n{shipping_address}\n\nIMPORTANT: During checkout, verify shipping address matches."
        
        # Build autopay section
        autopay_section = ""
        encrypted_payment = user_profile.get("encryptedPaymentInformation")
        if encrypted_payment and config.payment.decryption_key:
            payment_data = decrypt_payment_info(encrypted_payment, config.payment.decryption_key)
            if payment_data:
                autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
                if autopay_limit_cents > 0:
                    autopay_section = build_autopay_prompt_section(payment_data)
                else:
                    autopay_section = "\n\nPAYMENT AUTHORIZATION:\nAutopay DISABLED. For ALL purchases, use send_message_to_user to get explicit approval."
        
        custom_instructions = (
            "Your browser is in full screen mode. No search bar or navigation bar. "
            "Browser cookies have been injected - assume the user is logged in until proven otherwise."
            + shipping_section + autopay_section +
            "\n\nUse send_message_to_user when you need human help (login, CAPTCHA, payments over limit). "
            "Use attempt_completion tool when the task is done."
        )
        
        # Model pricing
        model_pricing = await get_model_pricing_with_fallback("rose-1-browser-use")
        
        # ===== MAIN AGENT LOOP =====
        max_iterations = 25
        iteration = 0
        
        while iteration < max_iterations:
            iteration += 1
            activity.heartbeat(f"Step {iteration}")
            
            # 1. Get current browser state (always includes screenshot)
            browser_state = await dom_service.get_browser_state(include_screenshot=True)
            current_url = browser_state.get("url", "")
            
            # Track URL changes
            if current_url and (not visited_urls or current_url != visited_urls[-1]):
                visited_urls.append(current_url)
            
            # 2. Build system prompt
            system_prompt = get_browser_system_prompt(
                goal, current_url, custom_instructions,
                available_files=list(available_file_paths.keys()) if available_file_paths else None
            )
            
            # 3. Build enriched task with user context
            enriched_task = goal
            if shipping_section:
                enriched_task += f"\n\n{shipping_section.strip()}"
            if autopay_section:
                enriched_task += f"\n\n{autopay_section.strip()}"
            # Add available files section if files were uploaded to Steel
            if available_file_paths:
                files_list = ', '.join(available_file_paths.keys())
                enriched_task += f"""

AVAILABLE FILES FOR UPLOAD:
The following files have been uploaded and are ready to use with the upload_file action.
To upload a file to a file input element, use: upload_file(index=<file_input_index>, filename="<filename>")
Files: {files_list}"""

            enriched_task += """

BROWSER CONTEXT:
- Browser is in full screen mode (no URL bar visible)
- User may already be logged in via stored cookies
- Use send_message_to_user when you need human help (login, CAPTCHA, payments over limit)
- Use attempt_completion when the task is complete"""
            
            # 4. Call Rose API for next action
            try:
                # Tracing: log last action before Rose API call
                action_entries = action_history.get_entries()
                if action_entries:
                    last = action_entries[-1]
                    logger.info(
                        "🔍 [TRACE] Last action before Rose API",
                        action=last.get("action"),
                        has_thinking=bool(last.get("thinking")),
                        has_screenshot=bool(last.get("screenshot")),
                        thinking_preview=last.get("thinking", "")[:100] if last.get("thinking") else "NONE"
                    )

                llm_result = await call_rose_browser_use(
                    task=enriched_task,
                    browser_state=browser_state,
                    action_history=action_entries,
                    config=config,
                )
                
                # Track usage (estimated - Rose API may return actual in future)
                total_input_tokens += 1000  # Estimate
                total_output_tokens += 100   # Estimate
                
            except Exception as e:
                logger.error(f"Rose API call failed: {e}")
                await asyncio.sleep(2)
                continue
            
            # 4. Extract action from response
            unified_action = llm_result.get("action", {})
            action_name = unified_action.get("action", "")
            thinking = unified_action.get("thinking", "")
            actual_model = llm_result.get("actual_model", "unknown")
            model_short = actual_model.split('/')[-1] if '/' in actual_model else actual_model
            
            if thinking:
                reasoning_messages.append(thinking)
                # Post thinking as assistant message
                await save_browser_assistant_message(agent_id, thinking, task_id)
            
            # Track action (full detail for error debugging)
            action_summary.append(f"{action_name}: {str(unified_action)[:500]}")
            if len(action_summary) > 20:
                action_summary[:] = action_summary[-20:]
            
            # 5. Handle special actions
            if action_name == "send_message_to_user":
                message = unified_action.get("params", {}).get("message", "")
                reason = unified_action.get("params", {}).get("reason", "other")
                
                logger.info("Browser agent requested user attention", reason=reason)
                
                # Disconnect from browser (session stays alive)
                await dom_service.disconnect()
                
                # Pause session
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.post(
                            f"{config.backend.api_url}/api/browser-session/close",
                            headers={"x-api-key": config.backend.api_key or ""},
                            json={"session_id": session_id, "pause": True, "current_url": current_url}
                        )
                except Exception as e:
                    logger.warning(f"Failed to pause session: {e}")
                
                await save_browser_action_message(
                    agent_id=agent_id, title="Browser Session Paused", task_id=task_id,
                    message=message, status=MessageStatus.FINISHED,
                    browser_url=browser_url, action_type="session_paused"
                )
                
                # Calculate usage
                execution_time_ms = (_safe_time() - start_time) * 1000
                usage_items = [
                    {
                        "type": "llm",
                        "cost_cents": round(
                            (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] + 
                            (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                            4
                        ),
                        "provider": "Rose 1 Browser Use",
                        "input_tokens": total_input_tokens,
                        "output_tokens": total_output_tokens
                    },
                    {
                        "type": "service",
                        "cost_cents": max(1, int(execution_time_ms / 60000)),
                        "provider": "Browserbase Session"
                    }
                ]
                
                return {
                    "status": "needs_user_help",
                    "message": message,
                    "reason": reason,
                    "task_id": task_id,
                    "session_id": session_id,
                    "browser_url": browser_url,
                    "original_goal": goal,
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items
                }
            
            if action_name in ("attempt_completion", "done"):
                close_reasoning = unified_action.get("params", {}).get("reasoning", "") or unified_action.get("params", {}).get("text", "")
                
                # Don't send task_complete yet - wait for verifier to confirm
                # Run verifier
                verifier_call_id = str(uuid_module.uuid4())
                try:
                    await save_browser_action_message(
                        agent_id=agent_id, title="⚖️ Verifying completion", task_id=task_id,
                        message="", status=MessageStatus.IN_PROGRESS,
                        browser_url=browser_url, action_type="system", tool_call_id=verifier_call_id
                    )
                    
                    # Build verifier context with rich action details
                    # Get last 30 actions with full details
                    action_entries = action_history.get_entries()[-30:]
                    action_details_lines = []
                    for entry in action_entries:
                        step = entry.get("step", "?")
                        action = entry.get("action", "unknown")
                        result = entry.get("result", {})
                        success = result.get("success", False)
                        status = "✅ Success" if success else f"❌ Failed: {result.get('error', 'unknown')}"

                        line = f"Step {step}: {action} - {status}"
                        # NOTE: Intentionally excluding entry["thinking"] - prone to reward hacking
                        params = entry.get("params", {})
                        if params:
                            # Remove verbose data like screenshots
                            display_params = {k: v for k, v in params.items() if k not in ["screenshot", "dom_tree"]}
                            if display_params:
                                line += f"\n  Params: {display_params}"
                        action_details_lines.append(line)
                    
                    actions_text = "\n\n".join(action_details_lines)
                    
                    # Build current page state
                    page_stats = browser_state.get("page_stats", {})
                    scroll_pos = browser_state.get("scroll_position", {})
                    pages_above = scroll_pos.get("pages_above", 0)
                    total_pages = scroll_pos.get("total_pages", 1)
                    
                    page_state = f"""Current Page State:
- URL: {current_url}
- Title: {browser_state.get('title', 'Unknown')}
- Interactive Elements: {page_stats.get('interactive', 0)}
- Scroll Position: Page {pages_above + 1} of {total_pages}"""
                    
                    # Only expose tool results to verifier, not assistant reasoning
                    # (assistant messages are prone to reward hacking)
                    verifier_context = [
                        # Message 1: USER - Goal
                        {"role": "USER", "text": f"Goal: {goal}"},
                        # Message 2: TOOL - Current page state
                        {"role": "TOOL", "text": page_state, "metadata": {"toolName": "browser_state", "toolStatus": "FINISHED"}},
                        # Message 3: TOOL - Action execution log (last 30)
                        {"role": "TOOL", "text": f"Browser Agent Execution Log ({len(action_entries)} actions shown):\n\n{actions_text}", "metadata": {"toolName": "action_history", "toolStatus": "FINISHED"}}
                    ]
                    
                    verifier_prompt = build_verifier_prompt("EXECUTE", f"Goal: {goal}\n\nVerify browser task completion.")

                    # Transform output_schema for remote session: file_pointer -> session_file_pointer
                    # This ensures the verifier only extracts the file path, not full FilePointer metadata
                    remote_session_schema = transform_schema_for_remote_session(response_schema)

                    # Try ultra first with 7s timeout, fallback to lite on timeout
                    try:
                        progress_result = await call_temporal_activity_from_activity(
                            check_progress,
                            args=[verifier_context, verifier_prompt, "rose-labs/rose-1-ultra", "EXECUTE", remote_session_schema],
                            start_to_close_timeout=timedelta(seconds=7),
                        )
                    except TimeoutError:
                        logger.warning("Verifier ultra timeout, falling back to lite")
                        progress_result = await call_temporal_activity_from_activity(
                            check_progress,
                            args=[verifier_context, verifier_prompt, "rose-labs/rose-1-lite", "EXECUTE", remote_session_schema],
                            start_to_close_timeout=timedelta(seconds=15),
                        )
                    
                    v_usage = progress_result.get("usage", {})
                    total_input_tokens += v_usage.get("prompt_tokens", 0)
                    total_output_tokens += v_usage.get("completion_tokens", 0)
                    
                    score = progress_result.get("score", 0.0)
                    v_reasoning = progress_result.get("reasoning", "")
                    
                    await save_browser_action_message(
                        agent_id=agent_id, title=f"⚖️ Progress: {score * 100:.0f}%", task_id=task_id,
                        message=v_reasoning, status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="system", tool_call_id=verifier_call_id
                    )
                    
                    if score >= 1.0:
                        # Task complete
                        execution_time_ms = (_safe_time() - start_time) * 1000
                        structured_response = progress_result.get("structured_response")

                        # TODO: Add file extraction for file_pointer support
                        # When browser session close endpoint supports file extraction:
                        # 1. Get output_files from close response
                        # 2. Resolve file pointers: structured_response = resolve_file_pointers_from_extracted(
                        #        structured_response, output_schema, output_files)
                        # 3. Emit output files as assistant events

                        # Disconnect and close session
                        await dom_service.disconnect()
                        try:
                            async with httpx.AsyncClient(timeout=10.0) as client:
                                await client.post(
                                    f"{config.backend.api_url}/api/browser-session/close",
                                    headers={"x-api-key": config.backend.api_key or ""},
                                    json={"session_id": session_id, "pause": False}
                                )
                        except:
                            pass

                        # Build context summary
                        context_message = build_context_summary(
                            success=True,
                            close_reasoning=close_reasoning,
                            visited_urls=visited_urls,
                            reasoning_messages=reasoning_messages,
                            action_summary=action_summary
                        )

                        # Send task_complete message so FE shows completion card
                        await save_browser_action_message(
                            agent_id=agent_id,
                            title="✓ Task Completed",
                            task_id=task_id,
                            message=context_message,
                            status=MessageStatus.FINISHED,
                            browser_url=browser_url,
                            action_type="task_complete"
                        )

                        usage_items = [
                            {
                                "type": "llm",
                                "cost_cents": round(
                                    (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] +
                                    (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                                    4
                                ),
                                "provider": "Rose 1 Browser Use",
                                "input_tokens": total_input_tokens,
                                "output_tokens": total_output_tokens
                            },
                            {
                                "type": "service",
                                "cost_cents": max(1, int(execution_time_ms / 60000)),
                                "provider": "Browserbase Session"
                            }
                        ]

                        return {
                            "status": "completed",
                            "success": True,
                            "message": context_message,
                            "browser_url": browser_url,
                            "usage_items": usage_items,
                            "execution_time_ms": execution_time_ms,
                            "structured_response": structured_response
                        }
                    
                    # Not complete - record verifier feedback as thinking for next iteration
                    # This shows up naturally in all model contexts as assistant thinking
                    verifier_feedback_thinking = f"""I just checked in with verifier for the task and it said:
<verifier_response>
Score: {score:.0%}
Reasoning: {v_reasoning}
</verifier_response>

Based on this feedback, I need to continue working on the task and address the issues mentioned."""

                    # Emit thinking to FE so user can see verifier feedback
                    await save_browser_assistant_message(agent_id, verifier_feedback_thinking, task_id)
                    
                    # Emit "Continuing" action to FE
                    continuing_tool_call_id = str(uuid_module.uuid4())
                    await save_browser_action_message(
                        agent_id=agent_id, title="Continuing task...", task_id=task_id,
                        message=f"Verifier score: {score:.0%} - continuing to work on task",
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="system", tool_call_id=continuing_tool_call_id
                    )

                    # Get current screenshot for the feedback action (Yutori needs observation/assistant pairs)
                    current_state = await dom_service.get_browser_state(include_screenshot=True)
                    current_screenshot = current_state.get("screenshot")

                    await action_history.record_action(
                        dom_service=dom_service,
                        action="wait",  # Neutral action - processing feedback
                        thinking=verifier_feedback_thinking,
                        result={"success": True, "message": "Verifier feedback processed"},
                        screenshot=current_screenshot  # Include screenshot for Yutori observation/assistant pairs
                    )

                    logger.info(
                        "🔍 [TRACE] Recorded verifier feedback action",
                        step=len(action_history),
                        has_screenshot=bool(current_screenshot),
                        thinking_preview=verifier_feedback_thinking[:200]
                    )
                    
                except Exception as verifier_error:
                    logger.error(f"Verifier failed: {verifier_error}")
                    await save_browser_action_message(
                        agent_id=agent_id, title="⚠️ Verification failed", task_id=task_id,
                        message=f"Error: {str(verifier_error)[:200]}", 
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="error", tool_call_id=verifier_call_id
                    )
                
                continue
            
            # 6. Execute regular action
            tool_call_id_action = str(uuid_module.uuid4())
            
            # Build title with human-readable element descriptions
            title_progress = f"{action_name}..."
            title_done = action_name
            
            # Get element description if we have an index
            idx = unified_action.get("index")
            coords = unified_action.get("coordinates")
            element_desc = None
            if idx is not None:
                element = dom_service.selector_map.get(idx)
                if element:
                    element_desc = get_element_description(element)
            
            if action_name == "click":
                if element_desc:
                    title_progress = f"Clicking {element_desc}"
                    title_done = f"Clicked {element_desc}"
                elif coords:
                    title_progress = f"Clicking at ({coords.get('x', '?')}, {coords.get('y', '?')})"
                    title_done = f"Clicked at ({coords.get('x', '?')}, {coords.get('y', '?')})"
                else:
                    title_progress = "Clicking..."
                    title_done = "Clicked"
            elif action_name == "input_text":
                text = unified_action.get("params", {}).get("text", "")[:25]
                if element_desc:
                    title_progress = f"Typing into {element_desc}"
                    title_done = f"Typed '{text}' into {element_desc}"
                elif coords:
                    title_progress = f"Typing at ({coords.get('x', '?')}, {coords.get('y', '?')})"
                    title_done = f"Typed '{text}' at ({coords.get('x', '?')}, {coords.get('y', '?')})"
                else:
                    title_progress = "Typing..."
                    title_done = f"Typed '{text}'"
            elif action_name == "goto":
                url = unified_action.get("params", {}).get("url", "")[:50]
                title_progress = f"Navigating → {url}"
                title_done = f"Navigated → {url}"
            elif action_name == "scroll":
                direction = unified_action.get("params", {}).get("direction", "down")
                amount = unified_action.get("params", {}).get("amount", 300)
                title_progress = f"Scrolling {direction} {amount}px..."
                title_done = f"Scrolled {direction} {amount}px"
                # Override action_name with direction-specific type for correct icon
                action_name = f"scroll_{direction}"
            elif action_name == "press_key":
                key = unified_action.get("params", {}).get("key", "?")
                title_progress = f"Pressing {key}..."
                title_done = f"Pressed {key}"
            elif action_name == "extract":
                title_progress = "Extracting data..."
                title_done = "Extracted data"
            elif action_name == "wait":
                time_ms = unified_action.get("params", {}).get("time_ms", 1000)
                title_progress = f"Waiting {time_ms}ms..."
                title_done = f"Waited {time_ms}ms"
            elif action_name == "select_dropdown":
                value = unified_action.get("params", {}).get("value", "?")
                if element_desc:
                    title_progress = f"Selecting '{value}' from {element_desc}"
                    title_done = f"Selected '{value}' from {element_desc}"
                else:
                    title_progress = f"Selecting '{value}'..."
                    title_done = f"Selected '{value}'"
            elif action_name == "upload_file":
                filename = unified_action.get("params", {}).get("filename", "file")
                if element_desc:
                    title_progress = f"Uploading {filename} to {element_desc}"
                    title_done = f"Uploaded {filename} to {element_desc}"
                else:
                    title_progress = f"Uploading {filename}..."
                    title_done = f"Uploaded {filename}"

            # Prepend model name to title_done for visibility (dev only)
            # if config.environment != "production":
            #     title_done = f"[{model_short}] {title_done}"
            
            
            # Post IN_PROGRESS - use action_name for icon mapping
            await save_browser_action_message(
                agent_id=agent_id, title=title_progress, task_id=task_id,
                message="", status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url, action_type=action_name, tool_call_id=tool_call_id_action
            )
            
            # Execute action
            result = await execute_action(dom_service, action_history, unified_action, available_file_paths)
            
            # Post FINISHED - use action_name for icon mapping
            if result.get("success", True):
                logger.info(f"Action {action_name} successful", agent_id=agent_id, title=title_done, task_id=task_id)
                await save_browser_action_message(
                    agent_id=agent_id, title=title_done, task_id=task_id,
                    message=result.get("message", ""), status=MessageStatus.FINISHED,
                    browser_url=browser_url, action_type=action_name, tool_call_id=tool_call_id_action
                )
            else:
                logger.error(f"Action {action_name} failed",  agent_id=agent_id, title=title_done, task_id=task_id,
                    message=result.get("error", "Failed"), status=MessageStatus.ERROR,
                    browser_url=browser_url, action_type="error", tool_call_id=tool_call_id_action
                )
                await save_browser_action_message(
                    agent_id=agent_id, title=title_done, task_id=task_id,
                    message=result.get("error", "Failed"), status=MessageStatus.ERROR,
                    browser_url=browser_url, action_type="error", tool_call_id=tool_call_id_action
                )
            
            # Small delay between iterations
            await asyncio.sleep(0.5)
        
        # Max iterations reached
        logger.warning(f"Max iterations reached: {max_iterations}")
        
        await dom_service.disconnect()
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"{config.backend.api_url}/api/browser-session/close",
                    headers={"x-api-key": config.backend.api_key or ""},
                    json={"session_id": session_id, "pause": False}
                )
        except:
            pass
        
        context_message = build_context_summary(
            success=False,
            close_reasoning=f"Max iterations ({max_iterations}) reached",
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary
        )
        
        # Send task_complete message so FE shows completion card
        await save_browser_action_message(
            agent_id=agent_id,
            title="Task Incomplete - Max Steps Reached",
            task_id=task_id,
            message=context_message,
            status=MessageStatus.FINISHED,
            browser_url=browser_url,
            action_type="task_complete"
        )
        
        execution_time_ms = (_safe_time() - start_time) * 1000
        usage_items = [
            {
                "type": "llm",
                "cost_cents": round(
                    (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] + 
                    (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                    4
                ),
                "provider": "Rose 1 Browser Use",
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens
            },
            {
                "type": "service",
                "cost_cents": max(1, int(execution_time_ms / 60000)),
                "provider": "Browserbase Session"
            }
        ]
        
        return {
            "status": "max_iterations",
            "success": False,
            "message": context_message,
            "browser_url": browser_url,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms
        }
        
    except asyncio.CancelledError:
        # Activity was cancelled (user paused the agent)
        logger.info("🔴 Browser agent activity cancelled (paused)")

        # Cleanup - disconnect from browser but keep session alive
        if dom_service:
            try:
                await dom_service.disconnect()
            except:
                pass

        # Pause the session (not close) so it can be resumed
        if session_id:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/browser-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"session_id": session_id, "pause": True, "current_url": current_url}
                    )
            except Exception as e:
                logger.warning(f"Failed to pause session on cancel: {e}")

        # Send task_complete message so FE hides the browser chip
        if task_id:
            try:
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser Session Cancelled",
                    task_id=task_id,
                    message="Agent paused by user",
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url or "",
                    action_type="task_complete"
                )
            except:
                pass

        # Return cancelled status
        return {
            "status": "cancelled",
            "task_id": task_id,
            "session_id": session_id,
            "browser_url": browser_url,
            "message": "Browser agent cancelled by user"
        }

    except Exception as e:
        logger.error("Browser automation failed", error=extract_error_message(e))

        # Cleanup
        if dom_service:
            try:
                await dom_service.disconnect()
            except:
                pass

        if session_id:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/browser-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"session_id": session_id}
                    )
            except:
                pass

        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        error_message = build_context_summary(
            success=False,
            close_reasoning=extract_error_message(e),
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            error_context=error_context
        )

        if task_id:
            try:
                await save_browser_action_message(
                    agent_id=agent_id, title="Task Failed", task_id=task_id,
                    message=error_message, status=MessageStatus.ERROR,
                    browser_url=browser_url or "", action_type="task_complete"
                )
            except:
                pass

        raise


# ========================================
# WORKFLOW HELPER & MANAGER
# ========================================

class SpawnBrowserAgentManagerV3(ToolManager):
    """Manager using browser-use BrowserSession + Rose API."""
    
    tool_name = "spawn_browser_agent"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn browser agent with browser-use + Rose API."""
        goal = tool_call.get("goal", "")
        output_schema = tool_call.get("output_schema")  # Response schema from parent's tool call
        requested_attachments = tool_call.get("attachments")  # List of filenames from tool call
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        # Resolve requested attachments from workflow context
        # TODO: Browser agent attachment support - files need to be made accessible via URL
        attachments = []
        if requested_attachments and hasattr(workflow_instance, 'context'):
            context_attachments = extract_attachments_from_context(workflow_instance.context)
            filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

            for filename in requested_attachments:
                if filename in filename_to_pointer:
                    fp = filename_to_pointer[filename]
                    attachments.append({
                        "id": fp.id,
                        "storage_path": fp.storage_path,
                        "original_filename": fp.original_filename,
                        "mime_type": fp.mime_type,
                        "size_bytes": fp.size_bytes,
                        "created_at": fp.created_at,
                    })
                else:
                    logger.warning(
                        "[BrowserAgent] Attachment not found in context",
                        agent_id=agent_id,
                        filename=filename,
                        available_files=list(filename_to_pointer.keys())
                    )

        logger.info("Browser agent starting (v3)", goal=goal, has_output_schema=output_schema is not None, num_attachments=len(attachments))

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting up a browser",
            message='',
            status=MessageStatus.IN_PROGRESS
        )

        try:
            # Start activity with limited retries (expensive/long-running)
            # Args: user_id, agent_id, goal, tool_call_id, task_id, session_id, cdp_url, is_resume, output_schema, attachments
            activity_handle = workflow.start_activity(
                spawn_browser_agent_activity_v3,
                args=[user_id, agent_id, goal, tool_call_id, None, None, None, False, output_schema, attachments if attachments else None],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=30),
                cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Poll for pause while activity runs
            was_cancelled = False
            while not activity_handle.done():
                if workflow_instance.is_paused:
                    logger.info("🔴 Cancelling browser agent due to pause")
                    activity_handle.cancel()
                    was_cancelled = True
                    break
                await workflow.sleep(1)  # Use workflow.sleep for determinism

            # Get result
            result = None
            try:
                result = await activity_handle
            except (asyncio.CancelledError, ActivityError) as e:
                # Check if it's a cancellation (either direct or wrapped by Temporal)
                if isinstance(e, ActivityError):
                    if not isinstance(e.cause, (asyncio.CancelledError, TemporalCancelledError)):
                        raise  # Re-raise non-cancellation errors
                was_cancelled = True
                result = {"status": "cancelled", "message": "Browser agent cancelled by user"}

            # Handle cancelled
            if was_cancelled or (result and result.get("status") == "cancelled"):
                logger.info("🔴 Browser agent cancelled")
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Browser Session Paused",
                    message="User paused the browser agent",
                    status=MessageStatus.FINISHED,
                    metadata={"action_type": "session_paused"}
                )
                return

            # Report usage
            if result.get("usage_items"):
                usage_items = []
                for item in result["usage_items"]:
                    item_type = UsageType.LLM if item.get("type") == "llm" else UsageType.SERVICE
                    usage_items.append(UsageItem(
                        type=item_type,
                        cost_cents=item.get("cost_cents", 0),
                        provider=item.get("provider", ""),
                        tokens_in=item.get("input_tokens"),
                        tokens_out=item.get("output_tokens"),
                    ))
                yield ToolEvent(
                    type=EventType.USAGE,
                    tool_name="spawn_browser_agent",
                    usage_items=usage_items
                )

            # Yield final result
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation complete",
                message=result.get("message", ""),
                status=MessageStatus.FINISHED
            )

        except Exception as e:
            # Let CancelledError propagate - workflow handles it
            if isinstance(e, asyncio.CancelledError):
                raise

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation failed",
                message=str(e),
                status=MessageStatus.ERROR
            )
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SpawnBrowserAgentManagerV3] = None


def get_manager() -> SpawnBrowserAgentManagerV3:
    """Get or create spawn_browser_agent manager singleton."""
    global _manager
    if _manager is None:
        _manager = SpawnBrowserAgentManagerV3()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def spawn_browser_agent(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for spawn_browser_agent.
    
    Spawns an autonomous browser agent with a high-level goal.
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'goal'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_browser_agent")

