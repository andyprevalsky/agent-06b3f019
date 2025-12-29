"""Browser automation tool using run_agent loop + Stagehand/Browserbase.

This is the refactored version that uses the unified run_agent loop
instead of a custom browser-specific loop.
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta, datetime, timezone
import structlog
import httpx
import time
import asyncio
import json
import uuid as uuid_module
import litellm

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageType, UsageItem
from browser_tools import get_system_prompt, execute_browser_tool
from browser_tools.message_processing import transform_tool_result, compress_messages
from browser_tools.schemas import create_browser_agent_action_model, BROWSER_TOOL_MODELS
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.prompts import build_verifier_prompt
from loop.activity_helper import call_temporal_activity_from_activity
from config import load_config

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


# ========================================
# MESSAGE HELPERS (from original)
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
        logger.error("Failed to save browser action message", error=str(e))


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
        logger.error("Failed to save browser assistant message", error=str(e))


# ========================================
# CONTEXT SUMMARY BUILDER (from original)
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
# PAYMENT/AUTOPAY HELPERS (from original)
# ========================================

def decrypt_payment_info(encrypted_data: str, decryption_key_b64: str) -> Optional[Dict[str, Any]]:
    """Decrypt payment information using hybrid RSA+AES decryption."""
    import base64
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
        logger.error("Failed to decrypt payment info", error=str(e))
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
# TEMPORAL ACTIVITY (REFACTORED)
# ========================================

@activity.defn
async def spawn_browser_agent_activity_v2(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    is_resume: bool = False
) -> Dict[str, Any]:
    """
    Browser agent activity using unified run_agent loop.
    
    This replaces the custom browser loop with run_agent + callbacks.
    """
    from stagehand import Stagehand, StagehandConfig
    from loop.run_agent import run_agent
    from helpers.llm import check_progress
    from tools.knowledge_base import query_blueprints_activity
    
    stagehand = None
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
            
            # Init message
            await save_browser_action_message(
                agent_id=agent_id, title="Browser Ready", task_id=task_id,
                message="", status=MessageStatus.FINISHED, browser_url=browser_url,
                action_type="browser", tool_call_id=tool_call_id, is_init_message=True
            )
            await save_browser_action_message(
                agent_id=agent_id, title="Task Started", task_id=task_id,
                message=goal, status=MessageStatus.IN_PROGRESS, browser_url=browser_url,
                action_type="task_started"
            )
        
        # ===== STAGEHAND INITIALIZATION =====
        activity.heartbeat(f"Stagehand init with session {session_id}")
        
        litellm.headers = {
            "Authorization": f"Bearer {config.rose.supabase_anon_key}",
            "x-api-key": config.rose.api_key,
        }
        
        stagehand_config = StagehandConfig(
            env="BROWSERBASE",
            api_key=config.browserbase.api_key,
            project_id=config.browserbase.project_id,
            browserbase_session_id=session_id,
            model_name="openai/rose-1-ultra",
            model_api_key="unused",
            model_client_options={
                "baseURL": config.rose.api_url.replace("/completions", ""),
            },
            use_api=False,
            verbose=2,
            use_rich_logging=False,
            browserbase_session_create_params={
                "keepAlive": True,
                "timeout": 7200,
            }
        )
        
        stagehand = Stagehand(stagehand_config)
        await stagehand.init()
        
        # Inject visual cursor
        try:
            await stagehand.page.evaluate("""
                (() => {
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
            """)
        except:
            pass
        
        # Capture initial URL
        try:
            initial_url = stagehand.page.url
            if initial_url:
                visited_urls.append(initial_url)
        except:
            pass
        
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
        
        # ===== BUILD SYSTEM PROMPT =====
        custom_instructions = (
            "Your browser is in full screen mode. No search bar or navigation bar. "
            "Browser cookies have been injected - assume the user is logged in until proven otherwise."
            + shipping_section + autopay_section +
            "\n\nUse send_message_to_user when you need human help (login, CAPTCHA, payments over limit). "
            "Use attempt_completion tool when the task is done."
        )
        
        current_url = stagehand.page.url if stagehand.page else ""
        system_prompt = get_system_prompt(goal, current_url, custom_instructions)
        
        # Verifier prompt
        verifier_prompt = build_verifier_prompt("EXECUTE", f"Goal: {goal}\n\nVerify browser task completion.")
        
        # Model pricing
        model_pricing = await get_model_pricing_with_fallback("rose-1-ultra")
        
        # ===== BLUEPRINT QUERY (first run only) =====
        if not is_resume:
            try:
                goal_context = [{"role": "USER", "text": goal[:500]}]
                blueprints = await call_temporal_activity_from_activity(
                    query_blueprints_activity,
                    args=[goal_context, user_id, 2],
                    timeout_seconds=30,
                )
                if blueprints:
                    blueprint_text = "\n\n### REFERENCE EXAMPLES:\n"
                    for idx, bp in enumerate(blueprints, 1):
                        blueprint_text += f"\n**Example {idx}:** {bp.get('title', 'N/A')}\n{bp.get('blueprint', '')[:500]}...\n"
                    system_prompt += blueprint_text
                    logger.info(f"Added {len(blueprints)} blueprints to browser agent context")
            except Exception as bp_error:
                logger.warning(f"Blueprint query failed: {bp_error}")
        
        # ===== CREATE CALLBACKS FOR run_agent =====
        
        # Browser response model (all browser tools)
        BrowserAgentAction = create_browser_agent_action_model()
        
        # Check paused callback
        async def check_paused_callback() -> bool:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        f"{config.backend.api_url}/api/agents/{agent_id}/status",
                        headers={"x-api-key": config.backend.api_key or ""}
                    )
                    if resp.status_code == 200:
                        return resp.json().get("status") == "PAUSED"
            except:
                pass
            return False
        
        # Post message callback (routes to browser panel)
        async def post_message_callback(message: str, role: str, metadata: Optional[Dict]):
            if role == "ASSISTANT":
                await save_browser_assistant_message(agent_id, message, task_id)
            else:
                title = metadata.get("title", "") if metadata else ""
                status_str = metadata.get("toolStatus", "FINISHED") if metadata else "FINISHED"
                status = MessageStatus.ERROR if status_str == "ERROR" else MessageStatus.IN_PROGRESS if status_str == "IN_PROGRESS" else MessageStatus.FINISHED
                action_type = metadata.get("action_type", "default") if metadata else "default"
                tcid = metadata.get("toolCallId") if metadata else None
                
                await save_browser_action_message(
                    agent_id=agent_id, title=title, task_id=task_id,
                    message=message, status=status, browser_url=browser_url,
                    action_type=action_type, tool_call_id=tcid
                )
        
        # Build messages callback (uses compress_messages for multimodal)
        def build_messages_callback(context: list, sys_prompt: str) -> list:
            messages = [{"role": "system", "content": sys_prompt}]
            for msg in context:
                role = msg.get("role", "").lower()
                text = msg.get("text", "")
                if role == "user":
                    messages.append({"role": "user", "content": text})
                elif role == "assistant":
                    messages.append({"role": "assistant", "content": text})
                elif role in ("tool", "system"):
                    messages.append({"role": "user", "content": f"[{role.upper()}]: {text}"})
            return compress_messages(messages)
        
        # Execute tool callback - the main browser tool executor
        async def execute_tool_callback(tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
            nonlocal total_input_tokens, total_output_tokens
            
            # Track action
            action_summary.append(f"{tool_name}: {str(tool_args)[:100]}")
            if len(action_summary) > 20:
                action_summary[:] = action_summary[-20:]
            
            # === SEND_MESSAGE_TO_USER ===
            if tool_name == "send_message_to_user":
                reason = tool_args.get("reason", "")
                attention_message = tool_args.get("message", "")
                
                logger.info("Browser agent requested user attention", reason=reason)
                
                # Get current URL
                try:
                    current_page_url = stagehand.page.url
                except:
                    current_page_url = None
                
                # Close Stagehand (session pauses)
                await stagehand.close()
                
                # Pause session
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.post(
                            f"{config.backend.api_url}/api/browser-session/close",
                            headers={"x-api-key": config.backend.api_key or ""},
                            json={"session_id": session_id, "pause": True, "current_url": current_page_url}
                        )
                except Exception as e:
                    logger.warning(f"Failed to pause session: {e}")
                
                await save_browser_action_message(
                    agent_id=agent_id, title="Browser Session Paused", task_id=task_id,
                    message=attention_message, status=MessageStatus.FINISHED,
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
                        "provider": "Rose 1 Ultra",
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
                    "status": "needs_user_help",  # Special status for run_agent
                    "message": attention_message,
                    "reason": reason,
                    "task_id": task_id,
                    "session_id": session_id,
                    "browser_url": browser_url,
                    "original_goal": goal,
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items
                }
            
            # === ATTEMPT_COMPLETION / CLOSE ===
            if tool_name in ("attempt_completion", "close"):
                close_reasoning = tool_args.get("reasoning", "")
                
                await save_browser_action_message(
                    agent_id=agent_id, title="✓ Attempting Completion", task_id=task_id,
                    message=close_reasoning, status=MessageStatus.FINISHED,
                    browser_url=browser_url, action_type="task_complete"
                )
                
                # Run verifier
                verifier_call_id = str(uuid_module.uuid4())
                try:
                    await save_browser_action_message(
                        agent_id=agent_id, title="⚖️ Verifying completion", task_id=task_id,
                        message="", status=MessageStatus.IN_PROGRESS,
                        browser_url=browser_url, action_type="system", tool_call_id=verifier_call_id
                    )
                    
                    # Build verifier context from action_summary
                    verifier_context = [
                        {"role": "USER", "text": f"Goal: {goal}"},
                        {"role": "SYSTEM", "text": f"Actions taken: {'; '.join(action_summary[-10:])}"},
                        {"role": "ASSISTANT", "text": f"Completion reasoning: {close_reasoning}"}
                    ]
                    
                    progress_result = await call_temporal_activity_from_activity(
                        check_progress,
                        args=[verifier_context, verifier_prompt, "rose-labs/rose-1-ultra", "EXECUTE"],
                        timeout_seconds=60,
                        heartbeat_callback=lambda msg: activity.heartbeat(msg)
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
                        # Task complete - return special status
                        execution_time_ms = (_safe_time() - start_time) * 1000
                        
                        # Close Stagehand and session
                        await stagehand.close()
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
                        
                        usage_items = [
                            {
                                "type": "llm",
                                "cost_cents": round(
                                    (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] + 
                                    (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                                    4
                                ),
                                "provider": "Rose 1 Ultra",
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
                            "status": "completed",  # Special status for run_agent
                            "success": True,
                            "message": context_message,
                            "browser_url": browser_url,
                            "usage_items": usage_items,
                            "execution_time_ms": execution_time_ms
                        }
                    else:
                        # Not complete - continue
                        return {
                            "message": f"Verifier: {score * 100:.0f}% complete. {v_reasoning}",
                            "error": False
                        }
                        
                except Exception as verifier_error:
                    logger.error(f"Verifier failed: {verifier_error}")
                    return {
                        "message": f"Verifier failed: {str(verifier_error)}. Please continue working.",
                        "error": False
                    }
            
            # === BROWSER TOOLS ===
            action_type_map = {
                "observe": "observation", "ariaTree": "observation", "screenshot": "observation",
                "extract": "extraction", "click": "action", "fill": "action", "type": "action",
                "pressKey": "action", "clickAtCoordinates": "action", "goto": "navigation",
                "navback": "navigation", "scroll": "scroll", "wait": "action",
            }
            action_type = action_type_map.get(tool_name, "action")
            
            # Build action title
            if tool_name == "observe":
                title_progress = f"Finding: {tool_args.get('instruction', '')}"
                title_done = f"Found: {tool_args.get('instruction', '')}"
            elif tool_name == "click":
                title_progress = f"Clicking: {tool_args.get('selector', '')}"
                title_done = f"Clicked: {tool_args.get('selector', '')}"
            elif tool_name == "goto":
                title_progress = f"Navigating → {tool_args.get('url', '')}"
                title_done = f"Navigated → {tool_args.get('url', '')}"
            else:
                title_progress = f"{tool_name}..."
                title_done = tool_name
            
            # Post IN_PROGRESS
            await save_browser_action_message(
                agent_id=agent_id, title=title_progress, task_id=task_id,
                message="", status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url, action_type=action_type, tool_call_id=tool_call_id
            )
            
            # Execute browser tool
            try:
                result = await execute_browser_tool(
                    tool_name, tool_args, stagehand, logger,
                    execution_model="rose-1-ultra"
                )
                
                # Track URL changes
                if tool_name in ["goto", "navback"]:
                    try:
                        new_url = stagehand.page.url
                        if new_url and (not visited_urls or new_url != visited_urls[-1]):
                            visited_urls.append(new_url)
                    except:
                        pass
                
                # Post FINISHED
                if result.get("success", True):
                    await save_browser_action_message(
                        agent_id=agent_id, title=title_done, task_id=task_id,
                        message=result.get("message", ""), status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type=action_type, tool_call_id=tool_call_id
                    )
                else:
                    await save_browser_action_message(
                        agent_id=agent_id, title=title_done, task_id=task_id,
                        message=result.get("error", "Failed"), status=MessageStatus.ERROR,
                        browser_url=browser_url, action_type="error", tool_call_id=tool_call_id
                    )
                
                # Transform result for context
                content = transform_tool_result(tool_name, result)
                return {"message": content if isinstance(content, str) else json.dumps(content), "error": not result.get("success", True)}
                
            except Exception as tool_error:
                await save_browser_action_message(
                    agent_id=agent_id, title=title_done, task_id=task_id,
                    message=str(tool_error), status=MessageStatus.ERROR,
                    browser_url=browser_url, action_type="error", tool_call_id=tool_call_id
                )
                return {"message": f"Tool failed: {str(tool_error)}", "error": True}
        
        # ===== CALL run_agent =====
        activity.heartbeat("Starting run_agent loop")
        
        initial_context = [{"role": "USER", "text": goal, "timestamp": datetime.now(timezone.utc).isoformat()}]
        if is_resume:
            initial_context.append({
                "role": "USER",
                "text": "You previously requested user assistance. The user has completed the action. Review the current browser state and continue.",
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
        
        result = await run_agent(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=system_prompt,
            verifier_prompt=verifier_prompt,
            model="rose-labs/rose-1-ultra",
            tools=list(BROWSER_TOOL_MODELS.keys()),  # Tool names for logging
            initial_context=initial_context,
            task_id=task_id,
            is_inside_temporal_activity=True,
            check_paused=check_paused_callback,
            post_message=post_message_callback,
            execute_tool=execute_tool_callback,
            response_model=BrowserAgentAction,
            build_messages=build_messages_callback,
            max_iterations=200,
            reasoning_max_tokens=256,
            skip_blueprint_query=True,  # We already queried above
            skip_verification=False,
        )
        
        # Update token tracking from result
        total_input_tokens += result.get("tokens_in", 0)
        total_output_tokens += result.get("tokens_out", 0)
        
        # Handle result
        status = result.get("status", "")
        
        if status == "needs_user_help":
            # Already handled in execute_tool_callback
            return result
        
        if status == "completed":
            # Already handled in execute_tool_callback
            return result
        
        # Other statuses (max_iterations, paused, etc.)
        execution_time_ms = (_safe_time() - start_time) * 1000
        
        # Close Stagehand
        if stagehand:
            await stagehand.close()
        
        # Close session
        if session_id:
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
            close_reasoning=result.get("message", status),
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary
        )
        
        usage_items = [
            {
                "type": "llm",
                "cost_cents": round(
                    (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] + 
                    (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                    4
                ),
                "provider": "Rose 1 Ultra",
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
            "status": "COMPLETED" if status == "completed" else status.upper(),
            "success": status == "completed",
            "message": context_message,
            "browser_url": browser_url,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms
        }
        
    except Exception as e:
        logger.error("Browser automation failed", error=str(e))
        
        # Cleanup
        if stagehand:
            try:
                await stagehand.close()
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
            close_reasoning=str(e),
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
# WORKFLOW HELPER & MANAGER (keep original interface)
# ========================================

class SpawnBrowserAgentManagerV2(ToolManager):
    """Manager using refactored run_agent-based activity."""
    
    tool_name = "spawn_browser_agent"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn browser agent with refactored loop."""
        original_goal = tool_call.get("goal", "")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id
        
        task_id = None
        session_id = None
        current_goal = original_goal
        iteration = 0
        
        logger.info("Browser agent starting (v2)", goal=original_goal)
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting up a browser",
            message='',
            status=MessageStatus.IN_PROGRESS
        )
        
        try:
            while True:
                iteration += 1
                is_resume = iteration > 1
                
                result = await workflow.execute_activity(
                    spawn_browser_agent_activity_v2,
                    args=[user_id, agent_id, current_goal, tool_call_id, task_id, session_id, is_resume],
                    start_to_close_timeout=timedelta(minutes=15),
                    heartbeat_timeout=timedelta(minutes=15),
                    retry_policy=RetryPolicy(maximum_attempts=2, initial_interval=timedelta(seconds=5))
                )
                
                # Report usage
                if result.get("usage_items"):
                    yield ToolEvent(
                        type=EventType.USAGE,
                        tool_name="spawn_browser_agent",
                        usage_items=result["usage_items"]
                    )
                
                if result.get("status") == "needs_user_help":
                    task_id = result["task_id"]
                    session_id = result["session_id"]
                    
                    from tools.request_user_approval import request_user_approval_direct
                    attention_result = await request_user_approval_direct(
                        workflow_instance,
                        question=f"🌐 **Browser Agent Needs Help**\n\n{result['message']}\n\n_Please complete the required action, then click Continue._",
                        image_url=None
                    )
                    
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Browser Session Resumed",
                        message="",
                        status=MessageStatus.FINISHED,
                        metadata={"task_id": task_id, "browser_url": result.get("browser_url"), "action_type": "system"}
                    )
                    
                    user_action = attention_result.get("response", "Continued")
                    current_goal = f"CONTEXT: User completed action. Original goal: {original_goal}. User action: {user_action}. Continue from where you left off."
                    continue
                else:
                    break
            
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation complete",
                message=result.get("message", ""),
                status=MessageStatus.FINISHED
            )
            
        except Exception as e:
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

_manager: Optional[SpawnBrowserAgentManagerV2] = None


def get_manager() -> SpawnBrowserAgentManagerV2:
    """Get or create spawn_browser_agent manager singleton."""
    global _manager
    if _manager is None:
        _manager = SpawnBrowserAgentManagerV2()
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
