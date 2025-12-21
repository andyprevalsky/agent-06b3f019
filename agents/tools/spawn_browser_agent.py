"""Browser automation tool using Stagehand + Browserbase with Rose agent."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time
import asyncio
import base64
import json
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageType, UsageItem
from browser_tools import get_browser_tool_definitions, get_system_prompt, execute_browser_tool
from browser_tools.message_processing import transform_tool_result, compress_messages
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.llm import call_rose_streaming

with workflow.unsafe.imports_passed_through():
    from config import load_config

logger = structlog.get_logger()


# ========================================
# PAYMENT DECRYPTION UTILITIES
# ========================================

def decrypt_payment_info(encrypted_data: str, decryption_key_b64: str) -> Optional[Dict[str, Any]]:
    """
    Decrypt payment information using hybrid RSA+AES decryption.
    
    Args:
        encrypted_data: Base64-encoded encrypted payment envelope
        decryption_key_b64: Base64-encoded RSA private key (PEM format)
        
    Returns:
        Decrypted payment data dict, or None if decryption fails
    """
    try:
        # 1. Decode the envelope
        envelope_json = base64.b64decode(encrypted_data).decode('utf-8')
        envelope = json.loads(envelope_json)
        
        if envelope.get("version") != 1:
            logger.warning("Unknown payment envelope version", version=envelope.get("version"))
            return None
        
        # 2. Decode the RSA private key
        private_key_pem = base64.b64decode(decryption_key_b64)
        private_key = serialization.load_pem_private_key(private_key_pem, password=None)
        
        # 3. Decrypt the AES key using RSA-OAEP
        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )
        
        # 4. Decrypt the payment data using AES-256-GCM
        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        
        # AES-GCM: last 16 bytes are the auth tag
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]
        
        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag))
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()
        
        # 5. Parse JSON payment data
        payment_data = json.loads(plaintext.decode('utf-8'))
        
        logger.info("Successfully decrypted payment info", 
                   card_last_four=payment_data.get("card_number", "")[-4:] if payment_data.get("card_number") else "N/A")
        
        return payment_data
        
    except Exception as e:
        logger.error("Failed to decrypt payment info", error=str(e))
        return None


def build_autopay_prompt_section(payment_data: Dict[str, Any]) -> str:
    """
    Build the autopay section for the browser agent system prompt.
    
    Args:
        payment_data: Decrypted payment data dict
        
    Returns:
        Formatted autopay instructions string for the system prompt
    """
    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
    autopay_limit_dollars = autopay_limit_cents / 100
    
    # Format card number with spaces
    card_number = payment_data.get("card_number", "")
    card_number_formatted = " ".join([card_number[i:i+4] for i in range(0, len(card_number), 4)])
    
    # Build billing address
    billing_lines = [
        payment_data.get("billing_street_address", ""),
        payment_data.get("billing_address_line2", ""),
        f"{payment_data.get('billing_city', '')}, {payment_data.get('billing_state', '')} {payment_data.get('billing_zipcode', '')}",
        payment_data.get("billing_country", "")
    ]
    billing_address = "\n".join(line for line in billing_lines if line.strip())
    
    # Build contact info if available
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


class SpawnBrowserAgentManager(ToolManager):
    """Manager for spawning autonomous browser agents via Stagehand/Browserbase."""
    
    tool_name = "spawn_browser_agent"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Spawn an autonomous browser agent with a high-level goal.
        
        Loops until task is complete, requesting user help when needed.
        
        Yields:
            - Initial message (main context)
            - Browser sub-actions (one ToolEvent per action)
            - User attention requests (when agent needs help)
            - Usage tracking
            - Completion message (main context)
        """
        original_goal = tool_call.get("goal", "")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        # State for resume flow
        task_id = None  # Stable ID for grouping browser actions (set after first iteration)
        session_id = None  # BrowserBase session ID (may change on resume)
        current_goal = original_goal  # Goal may be updated with context on resume
        iteration = 0

        logger.info("Browser agent starting", goal=original_goal, user_id=user_id, agent_id=agent_id)
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Starting up a browser",
            message='',
            status=MessageStatus.IN_PROGRESS
        )
        try:
            # Loop until task is complete
            while True:
                iteration += 1
                logger.info(f"🔄 WHILE LOOP ITERATION {iteration} STARTING", 
                           goal=current_goal[:100] if current_goal else None, 
                           session_id=session_id,
                           has_session=session_id is not None,
                           is_resume=iteration > 1)

                # 2. Execute activity (browser sub-actions saved directly to DB in real-time)
                is_resume = iteration > 1  # True if this is a resumed iteration after user help
                result = await workflow.execute_activity(
                    spawn_browser_agent_activity,
                    args=[user_id, agent_id, current_goal, tool_call_id, task_id, session_id, is_resume],
                    start_to_close_timeout=timedelta(minutes=15),
                    heartbeat_timeout=timedelta(minutes=15),
                    retry_policy=RetryPolicy(
                        maximum_attempts=2,
                        initial_interval=timedelta(seconds=5),
                        maximum_interval=timedelta(seconds=30)
                    )
                )
                
                # 3. Report usage for this iteration
                if result.get("usage_items"):
                    yield ToolEvent(
                        type=EventType.USAGE,
                        tool_name="spawn_browser_agent",
                        usage_items=result["usage_items"]
                    )
                
                # 4. Check if agent needs user help
                if result.get("status") == "NEEDS_USER_HELP":
                    # Agent needs help - pause and wait for user action
                    task_id = result["task_id"]  # Persist stable task ID
                    session_id = result["session_id"]  # Persist session for next iteration
                    browser_url = result["browser_url"]
                    agent_message = result["message"]

                    logger.info("🔴 NEEDS_USER_HELP detected", 
                               session_id=session_id, 
                               iteration=iteration)

                    # Use request_user_approval_direct
                    from tools.request_user_approval import request_user_approval_direct

                    logger.info("🔴 About to call request_user_approval_direct")
                    attention_result = await request_user_approval_direct(
                        workflow_instance,
                        question=f"🌐 **Browser Agent Needs Help**\n\n{agent_message}\n\n_Please complete the required action in the browser, then click Continue below._",
                        image_url=None
                    )
                    logger.info("🟢 request_user_approval_direct returned", attention_result=attention_result)

                    # Notify user that browser session is resuming
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Browser Session Resumed",
                        message="",
                        status=MessageStatus.FINISHED,
                        metadata={
                            "task_id": task_id,
                            "browser_url": browser_url,
                            "action_type": "system"
                        }
                    )

                    user_action = attention_result.get("response", "Continued")

                    # Build enhanced goal with context for resume
                    current_goal = build_resume_goal(original_goal, user_action)

                    logger.info("🟢 User completed browser action, about to continue loop", 
                               user_action=user_action[:100] if user_action else "",
                               new_goal=current_goal[:200],
                               session_id=session_id[:20] if session_id else None,
                               next_iteration=iteration + 1)

                    # Continue loop with updated goal and new session
                    logger.info("🔵 Executing continue statement - should loop back to iteration " + str(iteration + 1))
                    continue

                else:
                    # Task complete!
                    logger.info("Browser agent task complete", iterations=iteration)
                    break

            # 5. Final completion message (goes to agent context)
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

_manager: Optional[SpawnBrowserAgentManager] = None


def get_manager() -> SpawnBrowserAgentManager:
    """Get or create spawn_browser_agent manager singleton."""
    global _manager
    if _manager is None:
        _manager = SpawnBrowserAgentManager()
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


# ========================================
# HELPER FUNCTIONS
# ========================================

def needs_user_help(success: bool, message: str) -> bool:
    """
    Detect if agent needs user help based on close() call.

    Args:
        success: Agent's reported success status
        message: Agent's reasoning message

    Returns:
        True if agent needs user help, False if task complete
    """
    # Keywords that indicate agent needs help (CHECK FIRST!)
    help_keywords = [
        "login", "log in", "sign in", "signin",
        "authenticate", "authentication", "auth",
        "captcha", "verification", "verify",
        "payment", "card", "credit card", "billing",
        "credential", "password", "username",
        "manually", "unable to", "cannot", "can't",
        "need you to", "need user", "user input",
        "blocked", "access denied",
        "account", "create an account"
    ]

    message_lower = message.lower()

    # Check keywords FIRST - if agent mentions these, it needs help
    # (Even if success=True, agent might think task was to "get to login page")
    if any(keyword in message_lower for keyword in help_keywords):
        return True

    # If no help keywords but success=False, still assume needs help
    if not success:
        return True

    return False


def build_resume_goal(original_goal: str, user_action: str) -> str:
    """
    Build enhanced goal with context for agent resume.

    Args:
        original_goal: The original task goal
        user_action: What the user just completed

    Returns:
        Enhanced goal with full context
    """
    return f"""CONTEXT: You previously attempted this task and requested user assistance.

ORIGINAL GOAL: {original_goal}

USER ACTION: {user_action}

CURRENT STATE: The user has completed the action you requested. The browser session is still open with the same context (cookies, login state, etc.).

TASK: Review the current browser state and continue from where you left off to complete the original goal: {original_goal}
"""




# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def spawn_browser_agent_activity(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str] = None,      # Stable ID for grouping browser actions
    session_id: Optional[str] = None,   # BrowserBase session ID (for Stagehand reconnect)
    is_resume: bool = False             # True if resuming after user attention
) -> Dict[str, Any]:
    """
    Activity: Spawn an autonomous browser agent to complete a high-level goal.
    
    The browser agent will autonomously navigate, interact, and complete
    complex multi-step workflows using AI-powered automation via Stagehand.
    
    Args:
        user_id: User's Supabase ID
        agent_id: Current agent ID
        goal: High-level goal for the browser agent to accomplish (e.g., 
              "Order a Chipotle bowl with white rice, steak, and veggies from Uber Eats")
        tool_call_id: Unique ID for this tool call (for metadata)
        
    Returns:
        Dict with:
        - success: bool
        - message: str
        - browser_url: str (debug URL for iframe)
        - usage_items: List[Dict] (cost tracking)
        - execution_time_ms: float
    """
    from stagehand import Stagehand, StagehandConfig
    
    stagehand = None
    browser_url = None
    # Don't reset session_id - it's a parameter!
    
    try:
        config = load_config()
        
        # If resuming after user attention, fetch current session info from backend
        # (Frontend's "Take Control" button created new session via /resume endpoint)
        if is_resume and task_id:
            logger.info("🔍 Fetching current session info for resumed task", task_id=task_id)
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.get(
                        f"{config.backend.api_url}/api/browser-session/task/{task_id}",
                        headers={"x-api-key": config.backend.api_key or ""}
                    )
                    
                    if response.status_code == 200:
                        session_info = response.json()
                        session_id = session_info.get("session_id")
                        browser_url = session_info.get("debug_url")
                        logger.info("✅ Retrieved updated session info",
                                   task_id=task_id,
                                   new_session_id=session_id[:20] if session_id else None,
                                   has_debug_url=bool(browser_url))
                    else:
                        logger.error("❌ Failed to get session info", 
                                   status_code=response.status_code,
                                   response_text=response.text)
                        raise RuntimeError(f"Failed to fetch session info: HTTP {response.status_code}")
            except Exception as e:
                logger.error("❌ Error fetching session info", error=str(e))
                raise
        
        is_resume_session = session_id is not None

        if is_resume_session:
            # RESUME: Using fresh session info fetched above
            logger.info("Resuming browser agent with existing session", 
                       task_id=task_id, 
                       session_id=session_id[:20] if session_id else None,
                       agent_id=agent_id)
            activity.heartbeat(f"Resuming task {task_id}")
        else:
            # FIRST RUN: Create new session and get task_id
            activity.heartbeat("Initializing browser session")
            # Note: Can't save with task_id yet - we don't have it!
            # This initial message won't appear in browser panel (no task_id)
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{config.backend.api_url}/api/browser-session/init",
                    headers={
                        "x-api-key": config.backend.api_key or "",
                        "Content-Type": "application/json"
                    },
                    json={
                        "user_id": user_id,
                        "agent_id": agent_id
                    }
                )
                
                if response.status_code not in [200, 201]:
                    raise Exception(f"Failed to init session: {response.text}")
                
                session_data = response.json()
                task_id = session_data["task_id"]  # Get stable task ID
                session_id = session_data["session_id"]
                browser_url = session_data["debug_url"]
            
            # Browser ready message (now we have task_id!)
            await save_browser_action_message(
                agent_id=agent_id,
                title="Browser Ready",
                task_id=task_id,
                message="Browser session active",
                status=MessageStatus.FINISHED,
                browser_url=browser_url,
                action_type="system"
            )
            
            # Task started message
            await save_browser_action_message(
                agent_id=agent_id,
                title="Task Started",
                task_id=task_id,
                message=goal,
                status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url,
                action_type="task_started"
            )
        
        # 4. Initialize Stagehand with custom logger for real-time action emitting
        activity.heartbeat(f"Stagehand init with session {session_id}")
        
        # Track seen messages to prevent duplicates (Stagehand emits some messages multiple times)
        seen_messages = set()

        # Track consecutive screenshots for bundling
        last_screenshot_tool_call_id = None
        screenshot_count = 0

        # Flag to stop processing logs during cleanup
        is_closing = False

        # Capture close() call details (agent may need help!)
        close_success = None
        close_reasoning = None
        
        # Track execution context for main agent
        visited_urls = []  # List of URLs navigated to
        reasoning_messages = []  # Last N reasoning messages (keep last 5)
        action_summary = []  # High-level action descriptions (keep last 10)
        
        # Custom logger callback that emits actions in real-time
        async def custom_logger_callback(log_data: Dict):
            """
            Called by Stagehand as actions happen (REAL-TIME!).
            
            Log data structure from Stagehand (logging.py lines 453-460):
            {
                "message": {"message": "...", "level": 0|1|2},
                "timestamp": "...",
                "category": "...",    # ← Top level!
                "auxiliary": {...}    # ← Top level!
            }
            
            NOTE: Since we're using the custom agent loop and manually emitting messages,
            this callback is DISABLED to prevent duplicate messages in the browser panel.
            We keep it defined to maintain compatibility with Stagehand's internal mechanisms.
            """
            # DISABLED: We're manually emitting messages in the custom agent loop
            # to prevent duplicate actions in the browser panel
            return
            logger.info(
                "🎬 Setting up Stagehand with custom logger callback",
                session_id=session_id,
                verbose_level=2,
                callback_set=custom_logger_callback is not None
            )
        
        # Configure Stagehand with Rose for internal observe/extract calls
        stagehand_config = StagehandConfig(
            env="BROWSERBASE",
            api_key=config.browserbase.api_key,
            project_id=config.browserbase.project_id,
            browserbase_session_id=session_id,
            model_name="rose-1-ultra",  # Rose for internal Stagehand calls
            model_api_key=config.rose.api_key,
            model_base_url=config.rose.api_url.replace("/completions", ""),  # Rose endpoint
            verbose=2,  # Debug level for detailed action logging
            logger=custom_logger_callback,
            use_rich_logging=False,  # We handle formatting ourselves
            browserbase_session_create_params={
                "keepAlive": True,  # Prevent premature session closure
                "timeout": 7200,  # 2 hour timeout instead of default 1 hour
            }
        )
        
        stagehand = Stagehand(stagehand_config)
        await stagehand.init()
        
        activity.heartbeat("Stagehand initialized - Setting up Rose agent")
        
        # 5. ROSE AGENT LOOP: Use browser tools with Rose
        # This gives us full control over execution and token usage tracking
        
        # Capture initial URL
        try:
            initial_url = stagehand.page.url
            if initial_url:
                visited_urls.append(initial_url)
                logger.info(f"📍 Initial URL: {initial_url}")
        except:
            pass

        # Helper function to normalize URL (strip query params for comparison)
        def normalize_url(url: str) -> str:
            """Strip query params and fragments from URL for comparison."""
            if not url:
                return ""
            try:
                from urllib.parse import urlparse
                parsed = urlparse(url)
                return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip('/')
            except:
                return url.split('?')[0].split('#')[0].rstrip('/')
        
        # Helper to track URL changes
        def track_url_change():
            """Check if URL changed and track it."""
            try:
                current_url = stagehand.page.url
                if current_url:
                    normalized_current = normalize_url(current_url)
                    last_normalized = normalize_url(visited_urls[-1]) if visited_urls else ""
                    
                    if normalized_current != last_normalized:
                        visited_urls.append(current_url)
                        logger.info(f"📍 URL changed to: {current_url}")
            except:
                pass

        # === FETCH USER PROFILE ===
        user_profile = {}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{config.backend.api_url}/api/user-settings",
                    headers={"X-API-Key": config.backend.api_key, "x-user-id": user_id}
                )
                if resp.status_code == 200:
                    user_profile = resp.json()
        except Exception as e:
            logger.warning("Failed to fetch user profile", error=str(e))

        # Build shipping section if address available
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
            shipping_section = f"""

USER SHIPPING ADDRESS:
{shipping_address}

IMPORTANT: During any checkout process, verify that the shipping address shown matches the address above. If it does not match, update the shipping address to match before completing the purchase."""

        # Build autopay section if payment info is available
        autopay_section = ""
        encrypted_payment = user_profile.get("encryptedPaymentInformation")
        if encrypted_payment and config.payment.decryption_key:
            payment_data = decrypt_payment_info(encrypted_payment, config.payment.decryption_key)
            if payment_data:
                autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
                if autopay_limit_cents > 0:
                    # Autopay enabled with a limit
                    autopay_section = build_autopay_prompt_section(payment_data)
                else:
                    # Autopay limit is $0 - all payments require approval
                    autopay_section = """

PAYMENT AUTHORIZATION:
You have the user's payment method on file, but autopay is DISABLED (limit set to $0).
For ALL purchases, you MUST use send_message_to_user to get explicit approval before entering any payment details."""
            else:
                logger.warning("Failed to decrypt payment info - payment features disabled for this session")

        # === BUILD SYSTEM PROMPT AND TOOLS ===
        custom_instructions = """Your browser is in full screen mode. There is no search bar, navigation bar, or shortcut to control it. You can use browser actions to complete tasks.

Browser cookies have been injected - assume the user is logged in until proven otherwise.""" + shipping_section + autopay_section + """

Use send_message_to_user when you need human help (login, CAPTCHA, or payments over your autopay limit). Use close tool with success=true when the task is done."""

        current_url = stagehand.page.url if stagehand.page else ""
        system_prompt = get_system_prompt(goal, current_url, custom_instructions)
        browser_tools = get_browser_tool_definitions(current_url)
        
        # Add send_message_to_user custom tool
        custom_tools = [
            {
                "type": "function",
                "function": {
                    "name": "send_message_to_user",
                    "description": "Request the user to complete an action that the agent cannot do (login, payment, CAPTCHA, etc.). Always used for blocking clarifications—host will wait for the user's response.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "message": {
                                "type": "string",
                                "description": "Explain what the user needs to do and why you cannot do it"
                            },
                            "reason": {
                                "type": "string",
                                "description": "Category: login, payment, captcha, verification, blocked, other"
                            }
                        },
                        "required": ["message", "reason"],
                        "additionalProperties": False
                    }
                }
            }
        ]
        
        all_tools = browser_tools + custom_tools
        
        # === INITIALIZE CONVERSATION ===
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": goal}
        ]
        
        # Add resume context if resuming after user attention
        if is_resume:
            logger.info("🔄 Resuming after user attention - adding context message")
            messages.append({
                "role": "user",
                "content": "You previously requested user assistance. The user has completed the action. Review the current browser state and continue."
            })

        # Token tracking
        total_input_tokens = 0
        total_output_tokens = 0

        # Execution state
        start_time = time.time()
        max_steps = 200
        is_closing = False
        close_success = False
        close_reasoning = ""
        
        # Retry tracking for API failures
        max_retries = 3
        retry_delay_base = 2  # Base delay in seconds

        activity.heartbeat(f"Starting Rose agent loop: {goal}")
        
        # Fetch dynamic model pricing from Supabase cache
        model_pricing = await get_model_pricing_with_fallback("rose-1-ultra")
        logger.info(
            "📊 Model pricing loaded",
            input_cents_per_1k=model_pricing["input_cents_per_1k"],
            output_cents_per_1k=model_pricing["output_cents_per_1k"]
        )

        # ============================================
        # MAIN AGENT LOOP (Using Rose + Browser Tools)
        # ============================================
        # 
        # NEW ACTION TYPES for frontend (toolIcons.tsx):
        # - "observation": ariaTree, screenshot (agent observing page state)
        # - "extraction": extract (pulling structured data)
        # - "action": act, wait, fillForm (generic actions)
        # - "navigation": goto, navback
        # - "scroll": scroll
        # - "thinking": agent reasoning
        # - "task_complete": close tool
        # - "session_paused": send_message_to_user
        # - "error": failed actions
        # - "system": system messages
        #
        for step in range(max_steps):
            try:
                activity.heartbeat(f"Executing step {step + 1}/{max_steps}")
                logger.info(f"🔄 Step {step + 1}/{max_steps}")

                # ===== CALL ROSE API WITH RETRY LOGIC =====
                response_data = None
                for retry_attempt in range(max_retries + 1):
                    try:
                        if retry_attempt > 0:
                            logger.info(f"🔄 Retry attempt {retry_attempt}/{max_retries}")
                        
                        logger.info("🌹 Calling Rose API via unified streaming function...")
                        
                        # Compress old screenshots and aria trees to save tokens
                        compressed_messages = compress_messages(messages)
                        
                        # Call unified Rose streaming function
                        response_data = await call_rose_streaming(
                            messages=compressed_messages,
                            model="rose-1-ultra",
                            temperature=1.0,
                            max_tokens=4096,
                            tools=all_tools,
                            tool_choice="auto",
                            reasoning_max_tokens=256,
                            heartbeat_fn=activity.heartbeat,
                        )

                        # Track token usage
                        usage = response_data.get("usage", {})
                        total_input_tokens += usage.get("prompt_tokens", 0)
                        total_output_tokens += usage.get("completion_tokens", 0)
                        logger.info(f"📊 Tokens: {total_input_tokens} in, {total_output_tokens} out")
                        
                        # Success
                        break
                        
                    except httpx.HTTPStatusError as api_error:
                        # Try to get response body for better error details
                        error_body = ""
                        try:
                            error_body = api_error.response.text
                        except:
                            pass
                        
                        logger.error(f"❌ Rose API call failed (attempt {retry_attempt + 1}/{max_retries + 1})", 
                                    error=str(api_error), 
                                    status_code=api_error.response.status_code,
                                    response_body=error_body[:500] if error_body else "")
                        
                        if retry_attempt >= max_retries:
                            raise
                        
                        retry_delay = retry_delay_base ** (retry_attempt + 1)
                        logger.info(f"⏳ Retrying in {retry_delay} seconds...")
                        await asyncio.sleep(retry_delay)
                        
                    except Exception as api_error:
                        logger.error(f"❌ Rose API call failed (attempt {retry_attempt + 1}/{max_retries + 1})", error=str(api_error))
                        
                        if retry_attempt >= max_retries:
                            raise
                        
                        retry_delay = retry_delay_base ** (retry_attempt + 1)
                        logger.info(f"⏳ Retrying in {retry_delay} seconds...")
                        await asyncio.sleep(retry_delay)

                # If we broke out of retry loop due to failure, exit main loop
                if close_reasoning:
                    break

                # ===== EXTRACT RESPONSE DATA =====
                # Response from call_rose_streaming is already flat (content, tool_calls, reasoning_details)
                content = response_data.get("content", "") or ""
                tool_calls = response_data.get("tool_calls") or []
                
                # Extract reasoning_details for preservation in subsequent API calls
                reasoning_details = response_data.get("reasoning_details")
                if reasoning_details:
                    logger.debug(f"📝 Extracted reasoning_details from Rose response", count=len(reasoning_details))
                
                # Sanitize and log tool_call IDs
                if tool_calls:
                    import re
                    import uuid
                    for tc in tool_calls:
                        original_id = tc.get("id", "")
                        tool_name = tc.get("function", {}).get("name", "")
                        
                        # Sanitize tool_call ID to match Anthropic's pattern: ^[a-zA-Z0-9_-]+$
                        if original_id:
                            sanitized_id = re.sub(r'[^a-zA-Z0-9_-]', '_', original_id)
                            # Ensure it's not empty after sanitization
                            if not sanitized_id:
                                sanitized_id = f"tool_{uuid.uuid4().hex[:16]}"
                        else:
                            sanitized_id = f"tool_{uuid.uuid4().hex[:16]}"
                        
                        # Update the ID if it was changed
                        if sanitized_id != original_id:
                            logger.warning(
                                f"⚠️ Sanitized tool_call_id",
                                tool_name=tool_name,
                                original_id=original_id,
                                sanitized_id=sanitized_id
                            )
                            tc["id"] = sanitized_id
                        else:
                            logger.info(
                                f"📋 Received tool_call from LLM",
                                tool_name=tool_name,
                                tool_call_id=sanitized_id
                            )
                
                # Add assistant message to conversation history
                assistant_message = {"role": "assistant", "content": content}
                if tool_calls:
                    assistant_message["tool_calls"] = tool_calls
                # Include reasoning_details for preservation in subsequent API calls
                if reasoning_details:
                    assistant_message["reasoning_details"] = reasoning_details
                messages.append(assistant_message)
                
                # ===== LOG REASONING (if any content) =====
                reasoning_text = content.strip()
                if reasoning_text:
                    reasoning_messages.append(reasoning_text)
                    if len(reasoning_messages) > 5:
                        reasoning_messages = reasoning_messages[-5:]
                    
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Thinking",
                        message=reasoning_text,
                        status=MessageStatus.FINISHED,
                        task_id=task_id,
                        browser_url=browser_url,
                        action_type="thinking"
                    )
                
                # ===== EXECUTE TOOL CALLS =====
                if not tool_calls:
                    continue  # No tools - loop continues
                
                tool_responses = []
                for tool_call in tool_calls:
                    # Safely extract tool call data
                    function_data = tool_call.get("function", {})
                    tool_name = function_data.get("name", "")
                    tool_id = tool_call.get("id", "")
                    
                    if not tool_name:
                        logger.warning(f"⚠️ Skipping tool call with missing name", tool_call=tool_call)
                        continue
                    
                    # Safely get arguments
                    arguments_str = function_data.get("arguments", "{}")
                    try:
                        tool_args = json.loads(arguments_str) if arguments_str else {}
                    except json.JSONDecodeError as decode_error:
                        logger.error(
                            f"❌ Failed to parse tool arguments JSON for {tool_name}",
                            tool_id=tool_id,
                            arguments_str=arguments_str[:200] if arguments_str else "",
                            error=str(decode_error)
                        )
                        tool_args = {}
                    except (TypeError, ValueError) as parse_error:
                        logger.error(
                            f"❌ Invalid arguments format for {tool_name}",
                            tool_id=tool_id,
                            arguments_type=type(arguments_str).__name__,
                            error=str(parse_error)
                        )
                        tool_args = {}
                    
                    logger.info(f"🔧 Executing tool: {tool_name}", args=tool_args)
                    
                    # === CUSTOM TOOL: send_message_to_user ===
                    if tool_name == "send_message_to_user":
                        reason = tool_args.get("reason", "")
                        attention_message = tool_args.get("message", "")
                        
                        # Track action
                        action_summary.append(f"send_message_to_user: {reason or 'user help needed'}")
                        if len(action_summary) > 10:
                            action_summary = action_summary[-10:]
                        
                        logger.info("Agent requested user attention", reason=reason, message=attention_message[:100])
                        is_closing = True
                        
                        # Get current URL
                        try:
                            current_page_url = stagehand.page.url
                            logger.info(f"📍 Captured current URL: {current_page_url}")
                        except Exception as url_error:
                            logger.error(f"⚠️ Failed to get current URL: {url_error}")
                            current_page_url = None
                        
                        # Close Stagehand
                        await stagehand.close()
                        
                        # Pause browser session
                        try:
                            logger.info(f"Pausing browser session {session_id} (user attention needed)")
                            async with httpx.AsyncClient(timeout=10.0) as client:
                                response_pause = await client.post(
                                    f"{config.backend.api_url}/api/browser-session/close",
                                    headers={"x-api-key": config.backend.api_key or ""},
                                    json={"session_id": session_id, "pause": True, "current_url": current_page_url}
                                )
                                logger.info(f"Pause response status: {response_pause.status_code}")
                            
                            await save_browser_action_message(
                                agent_id=agent_id,
                                title="Browser Session Paused",
                                message=attention_message,
                                status=MessageStatus.FINISHED,
                                task_id=task_id,
                                browser_url=browser_url,
                                action_type="session_paused"
                            )
                            
                            logger.info("✅ Browser session paused successfully")
                        except Exception as pause_error:
                            logger.error(f"⚠️ Failed to pause browser session: {pause_error}")
                        
                        # Calculate usage and return
                        execution_time_ms = (time.time() - start_time) * 1000
                        
                        # Use dynamic pricing from Supabase cache
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
                            "status": "NEEDS_USER_HELP",
                            "message": attention_message,
                            "reason": reason,
                            "task_id": task_id,
                            "session_id": session_id,
                            "browser_url": browser_url,
                            "original_goal": goal,
                            "execution_time_ms": execution_time_ms,
                            "usage_items": usage_items
                        }
                    
                    # === BROWSER TOOL: close ===
                    elif tool_name == "close":
                        close_success = tool_args.get("success", True)
                        close_reasoning = tool_args.get("reasoning", "")
                        is_closing = True
                        
                        # Track action
                        status_str = "success" if close_success else "failure"
                        action_summary.append(f"close: {status_str}")
                        if len(action_summary) > 10:
                            action_summary = action_summary[-10:]
                        
                        logger.info("Agent called close", success=close_success, reasoning=close_reasoning[:100])
                        
                        await save_browser_action_message(
                            agent_id=agent_id,
                            title="Task Complete" if close_success else "Task Failed",
                            message=close_reasoning,
                            status=MessageStatus.FINISHED if close_success else MessageStatus.ERROR,
                            task_id=task_id,
                            browser_url=browser_url,
                            action_type="task_complete"
                        )
                        
                        tool_responses.append({
                            "role": "tool",
                            "tool_call_id": tool_id,
                            "content": json.dumps({"success": True, "acknowledged": True})
                        })
                        break  # Exit tool loop
                    
                    # === BROWSER TOOLS ===
                    else:
                        # Map tool names to frontend action types
                        # NEW action types: "observation" and "extraction"
                        action_type_map = {
                            "act": "action",           # Generic action (click, type, etc.)
                            "ariaTree": "observation", # NEW: Observing page state
                            "screenshot": "observation",  # NEW: Visual observation
                            "extract": "extraction",   # NEW: Extracting structured data
                            "goto": "navigation",
                            "navback": "navigation",
                            "scroll": "scroll",
                            "wait": "action",
                            "fillForm": "action"
                        }
                        action_type = action_type_map.get(tool_name, "action")
                        
                        # Build action title for logging
                        if tool_name == "act":
                            action_title = f"Action: {tool_args.get('action', '')[:50]}"
                        elif tool_name == "goto":
                            action_title = f"Navigate → {tool_args.get('url', '')[:50]}"
                        elif tool_name == "fillForm":
                            field_count = len(tool_args.get('fields', []))
                            action_title = f"Fill Form ({field_count} fields)"
                        elif tool_name == "scroll":
                            direction = tool_args.get('direction', 'down')
                            pixels = tool_args.get('pixels', 0)
                            action_title = f"Scroll {direction} {pixels}px"
                        elif tool_name == "ariaTree":
                            action_title = "Reading Page Content"
                        elif tool_name == "screenshot":
                            action_title = "Taking Screenshot"
                        elif tool_name == "extract":
                            action_title = f"Extracting: {tool_args.get('instruction', '')[:30]}"
                        elif tool_name == "navback":
                            action_title = "Navigate Back"
                        elif tool_name == "wait":
                            time_ms = tool_args.get('timeMs', 0)
                            action_title = f"Wait ({time_ms}ms)"
                        else:
                            action_title = tool_name
                        
                        # Log action start (IN_PROGRESS)
                        await save_browser_action_message(
                            agent_id=agent_id,
                            title=action_title,
                            message="",
                            status=MessageStatus.IN_PROGRESS,
                            task_id=task_id,
                            browser_url=browser_url,
                            action_type=action_type
                        )
                        
                        # Execute the tool
                        try:
                            result = await execute_browser_tool(
                                tool_name,
                                tool_args,
                                stagehand,
                                logger,
                                execution_model="rose-1-ultra"
                            )
                            
                            logger.info(f"✅ Tool {tool_name} executed", success=result.get("success", True))
                            
                            # Update to FINISHED after completion
                            await save_browser_action_message(
                                agent_id=agent_id,
                                title=action_title,
                                message=result.get("message", "") or "Completed successfully",
                                status=MessageStatus.FINISHED,
                                task_id=task_id,
                                browser_url=browser_url,
                                action_type=action_type
                            )
                            
                            # Track URL changes for navigation tools
                            if tool_name in ["goto", "act", "navback"]:
                                track_url_change()
                            
                            # Track action for context summary
                            action_summary.append(f"{tool_name}: {str(tool_args)[:50]}")
                            if len(action_summary) > 10:
                                action_summary = action_summary[-10:]
                            
                            # Transform tool result to correct format (multimodal for screenshots)
                            content = transform_tool_result(tool_name, result)
                            tool_responses.append({
                                "role": "tool",
                                "tool_call_id": tool_id,
                                "content": content
                            })
                            
                        except Exception as tool_error:
                            logger.error(f"❌ Tool {tool_name} failed", error=str(tool_error))
                            
                            # Log error to browser panel
                            await save_browser_action_message(
                                agent_id=agent_id,
                                title=action_title,
                                message=str(tool_error),
                                status=MessageStatus.ERROR,
                                task_id=task_id,
                                browser_url=browser_url,
                                action_type="error"
                            )
                            
                            tool_responses.append({
                                "role": "tool",
                                "tool_call_id": tool_id,
                                "content": json.dumps({"success": False, "error": str(tool_error)})
                            })
                
                # Check if we're closing (from close or send_message_to_user)
                if is_closing:
                    break
                
                # Add tool responses to conversation history
                messages.extend(tool_responses)

            except Exception as e:
                error_str = str(e)
                logger.error(f"Agent loop error at step {step + 1}", error=error_str)

                # Check if it's a retryable error
                is_503_error = "503" in error_str or "overloaded" in error_str.lower()

                if is_503_error and step < max_steps - 5:
                    # Retry with backoff
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Model Overloaded - Retrying",
                        message="Rose API overloaded. Waiting 10s before retry.",
                        status=MessageStatus.IN_PROGRESS,
                        task_id=task_id,
                        browser_url=browser_url,
                        action_type="system"
                    )
                    await asyncio.sleep(10)
                    continue
                else:
                    # Fatal error
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Error",
                        message=f"Task failed: {error_str}",
                        status=MessageStatus.ERROR,
                        task_id=task_id,
                        browser_url=browser_url,
                        action_type="error"
                    )
                    raise


        execution_time_ms = (time.time() - start_time) * 1000

        # Set closing flag to stop logger callback
        is_closing = True

        # Close Stagehand
        await stagehand.close()

        # Close browser session when task completes
        if session_id:
            try:
                logger.info(f"Closing browser session {session_id} (task complete)")
                async with httpx.AsyncClient(timeout=10.0) as client:
                    close_response = await client.post(
                        f"{config.backend.api_url}/api/browser-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"session_id": session_id, "pause": False}
                    )
                    logger.info(f"Session closed", session_id=session_id, status=close_response.status_code)
            except Exception as close_error:
                # Ignore double-close errors, log others
                error_msg = str(close_error)
                if "not currently active" in error_msg or "already closed" in error_msg.lower():
                    logger.info(f"Session already closed: {session_id}")
                else:
                    logger.warning(f"Failed to close session: {close_error}")

        # Calculate usage with dynamic pricing from Supabase cache
        usage_items = []
        
        input_cost_cents = (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"]
        output_cost_cents = (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"]
        total_llm_cost_cents = input_cost_cents + output_cost_cents
        
        usage_items.append({
            "type": "llm",
            "cost_cents": round(total_llm_cost_cents, 4),
            "provider": "Rose 1 Ultra",
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens
        })
        
        logger.info(
            "Token usage tracked",
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            cost_cents=round(total_llm_cost_cents, 4)
        )
        
        # Browserbase session cost (estimate: $0.01 per minute)
        session_minutes = max(1, int(execution_time_ms / 60000))
        browserbase_cost_cents = session_minutes * 1
        
        usage_items.append({
            "type": "service",
            "cost_cents": browserbase_cost_cents,
            "provider": "Browserbase Session"
        })
        
        logger.info(
            "Browser automation completed",
            user_id=user_id,
            agent_id=agent_id,
            success=close_success,
            execution_time_ms=execution_time_ms
        )
        
        # Task complete - build rich context summary for main agent
        context_message = build_context_summary(
            success=close_success,
            close_reasoning=close_reasoning or "Task completed",
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary
        )
        
        return {
            "status": "COMPLETED",
            "success": close_success,
            "message": context_message,
            "browser_url": browser_url,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms
        }
        
    except Exception as e:
        logger.error("Browser automation failed", error=str(e), user_id=user_id)

        # Set flag to stop processing cleanup-related errors
        is_closing = True
        
        # Build error context
        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        
        # Build rich error summary
        error_message = build_context_summary(
            success=False,
            close_reasoning=str(e),
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            error_context=error_context
        )
        
        # Save task failed message to browser panel if we have task_id
        if task_id:
            try:
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Task Failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                    task_id=task_id,
                    browser_url=browser_url or "",
                    action_type="task_complete"
                )
            except:
                pass  # Don't let message save failure prevent cleanup
        
        # Close session on error
        if session_id:
            try:
                config = load_config()
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/browser-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"session_id": session_id}
                    )
            except Exception as close_error:
                # Ignore double-close errors silently in exception handler
                error_msg = str(close_error)
                if "not currently active" not in error_msg and "already closed" not in error_msg.lower():
                    logger.warning(f"Failed to close session during error cleanup: {close_error}")
        
        # Close Stagehand
        if stagehand:
            try:
                await stagehand.close()
            except:
                pass
        
        raise


def build_context_summary(
    success: bool,
    close_reasoning: str,
    visited_urls: list,
    reasoning_messages: list,
    action_summary: list,
    error_context: str = None
) -> str:
    """
    Build detailed execution context summary for main agent.
    
    Returns formatted markdown summary with:
    - Status (success/failure)
    - Agent's final message
    - URLs visited (last 5)
    - Recent reasoning (last 3)
    - Actions taken (last 10)
    - Error context (if any)
    """
    summary_parts = []
    
    # Status
    status = "✅ SUCCESS" if success else "❌ FAILED"
    summary_parts.append(f"**Status**: {status}")
    
    # Agent's final message
    if close_reasoning:
        summary_parts.append(f"\n**Outcome**: {close_reasoning}")
    
    # Error context
    if error_context:
        summary_parts.append(f"\n**Error**: {error_context}")
    
    # URLs visited
    if visited_urls:
        last_urls = visited_urls[-5:]  # Last 5 URLs
        summary_parts.append(f"\n**URLs Visited** ({len(visited_urls)} total, showing last {len(last_urls)}):")
        for i, url in enumerate(last_urls, 1):
            summary_parts.append(f"  {i}. {url}")
    
    # Recent reasoning
    if reasoning_messages:
        last_reasoning = reasoning_messages[-3:]  # Last 3 reasoning messages
        summary_parts.append(f"\n**Agent Reasoning** (last {len(last_reasoning)}):")
        for i, reasoning in enumerate(last_reasoning, 1):
            # Truncate long reasoning
            truncated = reasoning[:150] + "..." if len(reasoning) > 150 else reasoning
            summary_parts.append(f"  {i}. {truncated}")
    
    # Actions taken
    if action_summary:
        last_actions = action_summary[-10:]  # Last 10 actions
        summary_parts.append(f"\n**Actions Taken** ({len(action_summary)} total, showing last {len(last_actions)}):")
        for action in last_actions:
            summary_parts.append(f"  • {action}")
    
    return "\n".join(summary_parts)


async def save_browser_action_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,  # Stable task ID for grouping
    browser_url: str = "",  # Current debug URL (may change on resume)
    action_type: str = "default",
    auxiliary: dict = None,
):
    """
    Save browser sub-action message directly to DB for real-time display.
    
    These messages have task_id metadata which:
    1. Groups them into browser panels on frontend (stable across resume)
    2. FILTERS them from agent context (so LLM doesn't see them)
    
    Args:
        task_id: Stable task ID for grouping (BrowserSession.id)
        browser_url: Current debug URL (for iframe display)
        action_type: Type of action for frontend icon rendering
            - task_started, progress, navigation, click, type, thinking, screenshot
        auxiliary: Extra data (e.g., step counts for progress bar)
    """
    import uuid
    
    try:
        config = load_config()
        
        # Each browser action gets a unique ID (important for frontend deduplication)
        unique_tool_call_id = str(uuid.uuid4())
        
        metadata = {
            "toolCallId": unique_tool_call_id,
            "toolName": "spawn_browser_agent",
            "toolStatus": status.value,
            "title": title,
            "task_id": task_id,  # Key for grouping (stable across resume)
            "browser_url": browser_url,  # For iframe display (may change)
            "action_type": action_type,  # Frontend uses this for icon selection
            "auxiliary": auxiliary or {}  # Extra data like step counts
        }
        
        # Set error flag for frontend icon display
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

