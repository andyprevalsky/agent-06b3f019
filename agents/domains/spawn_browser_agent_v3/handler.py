"""Handler for spawn-browser-agent-v3 domain.

Thin entry point: Temporal activity function and ToolManager.
Parses input, delegates to service layer, formats output.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import time
import uuid as uuid_module
from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError

from browser_tools.schemas import AVAILABLE_ACTIONS
from config import load_config
from helpers.attachments import extract_attachments_from_context, upload_to_storage
from helpers.file_resolution import resolve_file_pointers_from_extracted, transform_schema_for_remote_session
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.tracing import span, traced
from loop.activity_helper import call_temporal_activity_from_activity
from providers.rose import ClaudeAuthContext, GptAuthContext, RoseClient
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent, ToolManager
from utils.error_utils import extract_error_message
from utils.prompts import build_verifier_prompt

from .config import (
    ACTION_LOOP_DELAY_SECONDS,
    ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES,
    HEARTBEAT_TIMEOUT_SECONDS,
    MAX_ACTIVITY_RETRIES,
    MAX_CLAUDE_TOKEN_ROTATIONS,
    MAX_CONSECUTIVE_API_FAILURES,
    MAX_ITERATIONS,
    SESSION_MAX_WAIT_SECONDS,
    SESSION_RETRY_INTERVAL_SECONDS,
    VERIFIER_ULTRA_MODEL,
    VERIFIER_ULTRA_TIMEOUT_SECONDS,
)
from .repo import (
    close_browser_session,
    fetch_claude_token,
    fetch_session_info,
    init_browser_session,
    inject_local_storage,
    list_session_files,
    report_claude_token_rate_limited,
    save_browser_action_message,
    save_browser_assistant_message,
    upload_file_to_session,
)
from .service import (
    build_action_titles,
    build_context_summary,
    build_state_line,
    build_usage_items,
    extract_session_files,
    get_browser_system_prompt,
    safe_time,
)
from .service_actions import (
    execute_action,
    get_domain_from_url,
    get_element_description,
)
from .service_crypto import (
    build_autopay_prompt_section,
    build_passwords_prompt_section,
    decrypt_payment_info,
    extract_rate_limited_until,
    fetch_recent_otps,
)
from .types import ClaudeTokenState

logger = structlog.get_logger()


async def _stop_playwright_resources(
    playwright_browser: Optional[Any],
    playwright_instance: Optional[Any],
    agent_id: str,
) -> None:
    """Disconnect Playwright's CDP client and stop its local driver process."""
    if playwright_browser:
        try:
            await playwright_browser.close()
            logger.info("Playwright browser CDP connection closed", agent_id=agent_id)
        except Exception as e:
            logger.warning("Failed to close Playwright browser CDP connection", agent_id=agent_id, error=str(e))

    if playwright_instance:
        try:
            await playwright_instance.stop()
            logger.info("Playwright instance stopped", agent_id=agent_id)
        except Exception as e:
            logger.warning("Failed to stop Playwright instance", agent_id=agent_id, error=str(e))


async def _call_browser_use_with_rotation(  # noqa: C901
    *,
    rose_client: RoseClient,
    task: str,
    browser_state: Dict[str, Any],
    action_entries: List[Dict[str, Any]],
    config: Any,
    user_id: str,
    agent_id: str,
    iteration: int,
    token_state: ClaudeTokenState,
    gpt_token: Optional[str],
    gpt_account_id: Optional[str],
    gpt_token_source: Optional[str],
    gpt_token_pool_id: Optional[str],
    browser_use_mode: Optional[str],
) -> Dict[str, Any]:
    """Call rose-1-browser-use with in-activity claudeAuth rotation.

    The workflow normally owns claude-token rotation, but browser-use is the
    loop (no per-iteration workflow boundary), so the activity drives rotation
    here. On `auth_error` / `rate_limit`, mark the offending token, fetch a
    replacement, and retry up to MAX_CLAUDE_TOKEN_ROTATIONS. If all rotations
    exhaust (or there's no token to start), fall through to the waterfall.
    """
    rose_kwargs = dict(
        task=task,
        browser_state=browser_state,
        action_history=action_entries,
        available_actions=AVAILABLE_ACTIONS,
        agent_id=agent_id,
        call_site=f"browser_use_step_{iteration}",
    )

    from helpers.observability import dump_llm_context

    dump_llm_context(
        call_site=f"browser_use_step_{iteration}",
        # Browser-use builds its own messages inside the Rose client; surface
        # the inputs that would have formed the user turn so the dump is
        # actionable without reconstructing from the Rose side.
        messages=[{"role": "user", "content": task}],
        agent_id=agent_id,
        model="rose-1-browser-use",
        extra={
            "browser_state": browser_state,
            "action_history": action_entries,
            "available_actions": AVAILABLE_ACTIONS,
            "iteration": iteration,
            "browser_use_mode": browser_use_mode,
        },
    )

    use_claude = browser_use_mode == "claude" and bool(token_state.access_token)
    use_gpt = browser_use_mode == "gpt" and bool(gpt_token)
    claude_auth = (
        ClaudeAuthContext(
            token=token_state.access_token or "",
            source=token_state.source or "user",  # type: ignore[arg-type]
            user_id=user_id,
            pool_token_id=token_state.pool_token_id,
            max_rotations=0,  # activity drives rotation; client does one attempt
        )
        if use_claude
        else None
    )
    gpt_auth = (
        GptAuthContext(
            token=gpt_token or "",
            source=gpt_token_source or "user",  # type: ignore[arg-type]
            user_id=user_id,
            account_id=gpt_account_id,
            pool_token_id=gpt_token_pool_id,
            max_rotations=0,
        )
        if use_gpt
        else None
    )

    llm_result = await rose_client.complete_browser_use(claude_auth=claude_auth, gpt_auth=gpt_auth, **rose_kwargs)

    if not use_claude:
        return llm_result

    rotations = 0
    while (
        llm_result.get("claude_token_error") in ("auth_error", "rate_limit")
        and rotations < MAX_CLAUDE_TOKEN_ROTATIONS
    ):
        rotations += 1
        current_source = token_state.source
        current_pool_id = token_state.pool_token_id

        # Preserve the provider cooldown window (Retry-After header, anthropic
        # ratelimit reset, or ISO hint) so the pooled token stays out of
        # circulation for the correct duration instead of being requeued
        # immediately on the next activity.
        rate_limited_until = extract_rate_limited_until(llm_result)

        await report_claude_token_rate_limited(
            config,
            user_id=user_id,
            source=current_source,
            pool_token_id=current_pool_id,
            rate_limited_until=rate_limited_until,
        )

        token_state.access_token = None
        if current_pool_id:
            token_state.excluded_pool_ids.append(current_pool_id)
            token_state.pool_token_id = None

        new_token = await fetch_claude_token(
            config,
            user_id,
            force_pool=True,
            exclude_pool_ids=token_state.excluded_pool_ids or None,
        )
        if not new_token:
            logger.warning(
                "[ClaudeAuth] No replacement token available after rate-limit",
                rotations=rotations,
                source=current_source,
            )
            break

        token_state.access_token = new_token.get("accessToken")
        token_state.source = new_token.get("source")
        token_state.pool_token_id = new_token.get("poolTokenId")
        logger.info(
            "[ClaudeAuth] Retrying browser-use with rotated token",
            source=token_state.source,
            pool_token_id=token_state.pool_token_id,
            rotations=rotations,
        )

        activity.heartbeat(f"Step {iteration} - retrying Rose API (rotation {rotations})")
        rotated_auth = ClaudeAuthContext(
            token=token_state.access_token or "",
            source=token_state.source or "user",  # type: ignore[arg-type]
            user_id=user_id,
            pool_token_id=token_state.pool_token_id,
            max_rotations=0,
        )
        llm_result = await rose_client.complete_browser_use(claude_auth=rotated_auth, **rose_kwargs)

    return llm_result


# ========================================
# TEMPORAL ACTIVITY (V3 - browser-use)
# ========================================


@activity.defn
@traced("spawn_browser_agent_activity_v3")
async def spawn_browser_agent_activity_v3(  # noqa: C901
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    cdp_url: Optional[str] = None,
    is_resume: bool = False,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    write_lock_enabled: bool = True,
    start_url: str = "",
    write_lock_resume_state: Optional[Dict[str, Any]] = None,
    system_name: str = "Rose",
    use_claude_mode: bool = True,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Browser agent activity using browser-use BrowserSession + Rose API."""
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from browser_tools.dom_service import ActionHistory, DOMService
    from browser_tools.humanizer import BrowserHumanizer
    from helpers.llm import check_progress

    dom_service = None
    playwright_browser = None
    playwright_instance = None
    action_history = ActionHistory()
    browser_url = None
    current_url = ""
    config = load_config()
    start_time = safe_time()

    browser_use_mode = "gpt" if gpt_token else ("claude" if use_claude_mode else None)

    # Claude auth token state
    token_state = ClaudeTokenState()
    if browser_use_mode == "claude":
        token_data = await fetch_claude_token(config, user_id)
        if token_data:
            token_state.access_token = token_data.get("accessToken")
            token_state.source = token_data.get("source")
            token_state.pool_token_id = token_data.get("poolTokenId")
            logger.info(f"[ClaudeAuth] Got token (source={token_state.source})", user_id=user_id)
        else:
            logger.info("[ClaudeAuth] No token available, falling back to waterfall", user_id=user_id)
            browser_use_mode = None

    total_input_tokens = 0
    total_output_tokens = 0
    visited_urls: List[str] = []
    reasoning_messages: List[str] = []
    action_summary: List[str] = []
    write_lock_approvals: Dict[str, Dict] = {}

    pending_write_lock_action: Optional[Dict[str, Any]] = None
    resume_step_count: int = 0
    if write_lock_resume_state:
        pending_write_lock_action = write_lock_resume_state.get("pending_action")
        write_lock_approvals = write_lock_resume_state.get("write_lock_approvals", {})
        resume_step_count = write_lock_resume_state.get("step_count", 0)
        session_id = write_lock_resume_state.get("session_id") or session_id
        cdp_url = write_lock_resume_state.get("cdp_url") or cdp_url
        logger.info(
            "Resuming from write lock approval",
            has_pending_action=pending_write_lock_action is not None,
            approval_type=write_lock_resume_state.get("approval_type"),
            step_count=resume_step_count,
        )

    response_schema = output_schema
    if not response_schema:
        raise ValueError(
            "output_schema is required for browser agent - parent agent must provide structured output schema in tool call"
        )
    logger.info("Using response schema from tool call", fields=len(response_schema.get("fields", [])))

    session_passwords: List[Dict[str, Any]] = []

    try:
        # ===== SETUP TIMING TRACKER =====
        setup_origin = time.monotonic()
        timing_events: list[tuple[str, float, float]] = []

        def _record_timing(name: str, start: float, end: Optional[float] = None):
            if end is None:
                end = time.monotonic()
            timing_events.append((name, (start - setup_origin) * 1000, (end - setup_origin) * 1000))

        # ===== PHASE 1: SESSION INIT =====
        t_session = time.monotonic()
        fingerprint_injection = None
        user_profile = {}
        logger.info(
            "Session init check",
            is_resume=is_resume,
            task_id=task_id,
            has_write_lock_resume_state=write_lock_resume_state is not None,
        )
        if is_resume and task_id:
            logger.info("\U0001f50d Fetching session info for resumed task", task_id=task_id)
            session_info = await fetch_session_info(config, task_id)
            session_id = session_info.get("session_id")
            browser_url = session_info.get("debug_url")
            cdp_url = session_info.get("ws_url")
            fingerprint_injection = session_info.get("fingerprint_injection")
            session_passwords = session_info.get("passwords", [])
            activity.heartbeat(f"Resuming task {task_id}")
        else:
            activity.heartbeat("Initializing browser session")
            _session_wait_start = time.monotonic()
            _waiting_msg_sent = False

            while True:
                session_data = await init_browser_session(config, user_id, agent_id, start_url)

                if not session_data.get("rate_limited"):
                    break

                _elapsed = time.monotonic() - _session_wait_start
                if _elapsed > SESSION_MAX_WAIT_SECONDS:
                    raise Exception(f"Browser session unavailable after {int(_elapsed)}s (rate limited by Steel)")

                if not _waiting_msg_sent:
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Waiting for browser availability",
                        task_id=tool_call_id,
                        message="All browser slots are in use. Waiting for one to free up...",
                        status=MessageStatus.IN_PROGRESS,
                        tool_call_id=tool_call_id,
                        is_init_message=True,
                    )
                    _waiting_msg_sent = True

                logger.info(
                    "Steel rate limited, waiting for browser slot",
                    elapsed_s=int(_elapsed),
                    retry_in=SESSION_RETRY_INTERVAL_SECONDS,
                )
                activity.heartbeat(f"Waiting for browser availability ({int(_elapsed)}s)")
                await asyncio.sleep(SESSION_RETRY_INTERVAL_SECONDS)

            task_id = session_data["task_id"]
            session_id = session_data["session_id"]
            browser_url = session_data["debug_url"]
            cdp_url = session_data.get("ws_url")
            fingerprint_injection = session_data.get("fingerprint_injection")
            session_passwords = session_data.get("passwords", [])
            user_profile = session_data.get("user_settings") or {}
        _record_timing("session_init", t_session)

        if not cdp_url:
            raise RuntimeError("No CDP URL provided - backend must return ws_url from Steel")

        activity.heartbeat(f"Connecting via CDP: {cdp_url[:50]}...")

        # ===== PHASE 2: PARALLEL SETUP =====
        t_parallel = time.monotonic()

        async def _setup_browser():
            """Connect DOMService + Playwright, apply fingerprint, init humanizer."""
            t = time.monotonic()
            _dom_service = DOMService(cdp_url=cdp_url)
            await _dom_service.connect()
            _record_timing("parallel.browser.dom_connect", t)
            logger.info("\U0001f310 Connected to browser via CDP")

            _dom_page = await _dom_service.session.get_current_page()

            t = time.monotonic()
            from playwright.async_api import async_playwright

            _playwright_instance = await async_playwright().start()
            _playwright_browser = await _playwright_instance.chromium.connect_over_cdp(cdp_url)
            _playwright_context = _playwright_browser.contexts[0]
            _input_page = _playwright_context.pages[0]
            _record_timing("parallel.browser.playwright_connect", t)

            t = time.monotonic()
            if fingerprint_injection:
                from helpers.fingerprint_injection import apply_fingerprint_injection

                injection_success = await apply_fingerprint_injection(_input_page, fingerprint_injection)
                if injection_success:
                    logger.info("\U0001f510 Applied fingerprint injection via CDP (Sec-CH-UA-Platform, init scripts)")
                else:
                    logger.warning(
                        "\u26a0\ufe0f Failed to apply fingerprint injection - browser may leak real fingerprint"
                    )
            else:
                logger.info("\U0001f510 No fingerprint injection data provided - using Steel defaults")
            _record_timing("parallel.browser.fingerprint", t)

            t = time.monotonic()
            _humanizer = BrowserHumanizer(dom_page=_dom_page, input_page=_input_page, fast=False)
            await _humanizer.initialize_cursor(start_pos=(640, 400))
            logger.info("\U0001f916 BrowserHumanizer initialized (browser-use for DOM, Playwright for input)")
            _record_timing("parallel.browser.humanizer", t)

            return _dom_service, _dom_page, _input_page, _humanizer, _playwright_browser, _playwright_instance

        async def _process_data():
            """Save init messages + process user data (no browser needed)."""
            from .service_crypto import decrypt_password_with_key

            if not is_resume:
                t = time.monotonic()
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser Ready",
                    task_id=task_id,
                    message="",
                    status=MessageStatus.IN_PROGRESS,
                    browser_url=browser_url,
                    action_type="browser",
                    tool_call_id=tool_call_id,
                    is_init_message=True,
                    output_schema=response_schema,
                )
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Task Started",
                    task_id=task_id,
                    message=goal,
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url,
                    action_type="task_started",
                )
                _record_timing("parallel.data.init_messages", t)

            t = time.monotonic()
            _shipping_section = ""
            if user_profile.get("addressLine1"):
                addr_lines = [
                    user_profile.get("name", ""),
                    user_profile["addressLine1"],
                    user_profile.get("addressLine2", ""),
                    f"{user_profile.get('city', '')}, {user_profile.get('state', '')} {user_profile.get('postalCode', '')}",
                    user_profile.get("country", "United States"),
                ]
                shipping_address = "\n".join(line for line in addr_lines if line)
                _shipping_section = f"\n\nUSER DELIVERY ADDRESS:\n{shipping_address}\n\nIMPORTANT: During checkout, verify delivery address matches."

            _autopay_section = ""
            _card_refs: Dict[str, str] = {}
            encrypted_payment = user_profile.get("encryptedPaymentInformation")
            if encrypted_payment and config.payment.decryption_key:
                payment_data = decrypt_payment_info(encrypted_payment, config.payment.decryption_key)
                if payment_data:
                    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
                    if autopay_limit_cents > 0:
                        _autopay_section = build_autopay_prompt_section(payment_data, encrypted_payment)
                        _card_refs = {
                            "card_number": payment_data.get("card_number", ""),
                            "card_name": payment_data.get("cardholder_name", ""),
                            "card_expiry": payment_data.get("card_expiry", ""),
                            "card_cvv": payment_data.get("card_cvv", ""),
                        }
                    else:
                        _autopay_section = "\n\nPAYMENT AUTHORIZATION:\nAutopay DISABLED. For ALL purchases, use send_message_to_user to get explicit approval."
            _record_timing("parallel.data.user_profile", t)

            t = time.monotonic()
            _passwords_section = ""
            _ref_to_encrypted: Dict[str, str] = {}
            _password_lookup: Dict[str, Dict[str, str]] = {}
            if session_passwords:
                _passwords_section, _ref_to_encrypted = build_passwords_prompt_section(session_passwords)
                for pwd in session_passwords:
                    encrypted = pwd.get("encryptedPassword", "")
                    if encrypted:
                        _password_lookup[encrypted] = {
                            "origin": pwd.get("origin", ""),
                            "username": pwd.get("username", ""),
                        }
                logger.info(f"Loaded {len(session_passwords)} passwords from session response")

            _secret_refs: Dict[str, str] = {}
            _password_origins: Dict[str, str] = {}

            for ref, value in _card_refs.items():
                if value:
                    _secret_refs[ref] = value

            if config.payment.decryption_key and _ref_to_encrypted:
                from cryptography.hazmat.backends import default_backend
                from cryptography.hazmat.primitives import serialization

                private_key_pem = base64.b64decode(config.payment.decryption_key)
                private_key = serialization.load_pem_private_key(
                    private_key_pem, password=None, backend=default_backend()
                )
                logger.info(f"Pre-loaded RSA key, decrypting {len(_ref_to_encrypted)} passwords in parallel...")

                async def decrypt_one(short_ref: str, encrypted: str) -> tuple[str, Optional[str]]:
                    decrypted = await asyncio.to_thread(decrypt_password_with_key, encrypted, private_key)
                    return (short_ref, decrypted)

                decrypt_tasks = [
                    decrypt_one(short_ref, encrypted) for short_ref, encrypted in _ref_to_encrypted.items()
                ]
                decrypt_results = await asyncio.gather(*decrypt_tasks)

                for short_ref, decrypted in decrypt_results:
                    if decrypted:
                        _secret_refs[short_ref] = decrypted
                        encrypted = _ref_to_encrypted[short_ref]
                        info = _password_lookup.get(encrypted, {})
                        _password_origins[short_ref] = info.get("origin", "")

            logger.info(
                "Built secret refs for type interception",
                card_refs_count=len(_card_refs),
                password_refs_count=len([k for k in _secret_refs if k not in _card_refs]),
            )
            _record_timing("parallel.data.passwords", t)

            t = time.monotonic()
            _base_custom_instructions = (
                "Your browser is in full screen mode. No search bar or navigation bar. "
                "Control+L will NOT focus the address bar - use the goto action to navigate to URLs. "
                "Browser cookies have been injected - assume the user is logged in until proven otherwise. "
                "Avoid login flows unless the site forces you to login to complete your directed goal."
                + _shipping_section
                + _autopay_section
                + _passwords_section
                + "\n\nWhen a site offers OTP delivery options, ALWAYS prefer EMAIL over SMS. "
                "SMS OTPs require the user's Mac to be active; email is more reliable."
                "\n\nUse send_message_to_user when you need human help (login, CAPTCHA, payments over limit). "
                "Use attempt_completion tool when the task is done."
            )
            _model_pricing = await get_model_pricing_with_fallback("rose-1-browser-use")
            _record_timing("parallel.data.instructions", t)

            return (
                _shipping_section,
                _autopay_section,
                _card_refs,
                _passwords_section,
                _ref_to_encrypted,
                _password_lookup,
                _secret_refs,
                _password_origins,
                _base_custom_instructions,
                _model_pricing,
            )

        browser_result, data_result = await asyncio.gather(
            _setup_browser(),
            _process_data(),
        )
        _record_timing("parallel_setup_total", t_parallel)

        dom_service, dom_page, input_page, humanizer, playwright_browser, playwright_instance = browser_result

        (
            shipping_section,
            autopay_section,
            card_refs,
            passwords_section,
            ref_to_encrypted,
            password_lookup,
            secret_refs,
            password_origins,
            base_custom_instructions,
            model_pricing,
        ) = data_result

        # ===== PHASE 3: POST-SETUP =====
        t_post = time.monotonic()

        # Upload attachments
        available_file_paths: Dict[str, str] = {}
        if attachments:
            t = time.monotonic()
            logger.info(f"\U0001f4ce Uploading {len(attachments)} attachments to Steel session")
            from helpers.attachments import download_from_storage

            for fp in attachments:
                try:
                    filename = fp.get("original_filename", "")
                    storage_path = fp.get("storage_path", "")
                    if not filename or not storage_path:
                        logger.warning(f"Skipping invalid attachment: {fp}")
                        continue

                    activity.heartbeat(f"Downloading {filename}...")
                    file_content = await download_from_storage(storage_path)

                    activity.heartbeat(f"Uploading {filename} to browser session...")
                    upload_result = await upload_file_to_session(
                        config, session_id, filename, file_content, fp.get("mime_type", "application/octet-stream")
                    )
                    if upload_result:
                        remote_path = upload_result.get("path", f"/tmp/{filename}")
                        available_file_paths[filename] = remote_path
                        logger.info(f"\U0001f4ce Uploaded {filename} -> {remote_path}")
                except Exception as e:
                    logger.error(f"Failed to upload attachment {fp.get('original_filename', '?')}: {e}")

            if available_file_paths:
                logger.info(f"\U0001f4ce Available files for browser: {list(available_file_paths.keys())}")
            _record_timing("post_setup.attachments", t)

        # Logo hijack
        t = time.monotonic()
        try:
            logo_hijack_script = """
                (() => {
                    const ROSE_LOGO_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIxIDYyIDIyMCAyMjIiIHdpZHRoPSIyMjAiIGhlaWdodD0iMjIyIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDMwMykgc2NhbGUoMC4xLC0wLjEpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0xMjc2IDIzNzggYy0xNDUgLTE5MiAtMjMxIC00NDIgLTIxMSAtNjE2IDggLTY4IDQxIC0yMDIgNjEgLTI1MSA4IC0xOSAxMyAtMzUgMTEgLTM3IC0yIC0yIC0zMCA3IC02MiAyMSAtMjQ5IDEwMCAtNTM3IDU0IC03ODQgLTEyNCAtMzYgLTI1IC02OSAtNDkgLTc1IC01MyAtMTcgLTExIDIyIC00NiAxMTkgLTEwNSAxNjMgLTEwMSAzMDAgLTE0NCA0NjAgLTE0NCA5MiAtMSAyMjYgMjQgMzAxIDU2IDIwIDggMzggMTUgMzkgMTUgMiAwIC0xMCAtMzkgLTI1IC04NyAtNjkgLTIxMyAtNTggLTM5NSAzNiAtNjAwIDMxIC02OSAxMzYgLTIzNyAxNTQgLTI0OCAxMCAtNiAxMTQgMTQ0IDE1MiAyMjAgMzcgNzMgNzUgMTk5IDg4IDI5MyAxNCAxMDEgMSAyMDYgLTQwIDMzMCAtMTUgNDggLTI3IDg4IC0yNiA4OSAxIDIgMjYgLTcgNTUgLTE4IDE5NSAtNzQgNDIzIC02NiA2MTEgMjIgOTggNDYgMjE3IDExOCAyNDUgMTQ5IDE4IDIwIDE4IDIxIC0xIDM1IC0xNzcgMTM5IC0zOTYgMjI1IC01NzAgMjI1IC03OSAwIC0xOTUgLTIzIC0yODIgLTU2IC00NCAtMTYgLTYzIC0yMCAtNTkgLTExIDI3IDcyIDYwIDE5NiA2OCAyNjAgMTcgMTMyIC0xNyAzMDAgLTg5IDQ0MiAtMzYgNzIgLTEyNCAyMDkgLTE0MSAyMTkgLTUgNCAtMjEgLTggLTM1IC0yNnogbTQwIC05MzUgYzcgLTQ2IDUwIC05MiAxMDkgLTExOSAyNyAtMTMgNDEgLTIzIDMxIC0yMyAtMTEgLTEgLTM4IC0xMiAtNjIgLTI2IC00OSAtMjkgLTgzIC05MCAtODUgLTE1MSAtMSAtMzcgLTIgLTM2IC05IDEzIC00IDI5IC0xNyA2NyAtMjggODUgLTIyIDM1IC04NiA3NyAtMTE4IDc5IC0xMSAwIDEgOSAyNiAyMCA3OSAzNSAxMTggOTAgMTIxIDE2OCAxIDI1IDMgMjggNiAxMSAyIC0xNCA2IC0zOSA5IC01N3oiLz4KICA8L2c+Cjwvc3ZnPg==';

                    if (window.__roseSrcHijacked) return;
                    window.__roseSrcHijacked = true;

                    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

                    Object.defineProperty(HTMLImageElement.prototype, 'src', {
                        get: function() {
                            return originalDescriptor.get.call(this);
                        },
                        set: function(value) {
                            if (value && typeof value === 'string' && value.includes('browser-use.com')) {
                                value = ROSE_LOGO_URL;
                                this.alt = 'Rose';
                            }
                            return originalDescriptor.set.call(this, value);
                        },
                        enumerable: originalDescriptor.enumerable,
                        configurable: originalDescriptor.configurable
                    });

                    const originalSetAttribute = Element.prototype.setAttribute;
                    Element.prototype.setAttribute = function(name, value) {
                        if (this instanceof HTMLImageElement && name === 'src' &&
                            value && typeof value === 'string' && value.includes('browser-use.com')) {
                            value = ROSE_LOGO_URL;
                            this.alt = 'Rose';
                        }
                        return originalSetAttribute.call(this, name, value);
                    };
                })();
            """
            logo_cdp_session = await dom_service._session.get_or_create_cdp_session(focus=True)
            await logo_cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": logo_hijack_script, "runImmediately": True}, session_id=logo_cdp_session.session_id
            )

            immediate_replace_script = """
                (() => {
                    const ROSE_LOGO_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIxIDYyIDIyMCAyMjIiIHdpZHRoPSIyMjAiIGhlaWdodD0iMjIyIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDMwMykgc2NhbGUoMC4xLC0wLjEpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0xMjc2IDIzNzggYy0xNDUgLTE5MiAtMjMxIC00NDIgLTIxMSAtNjE2IDggLTY4IDQxIC0yMDIgNjEgLTI1MSA4IC0xOSAxMyAtMzUgMTEgLTM3IC0yIC0yIC0zMCA3IC02MiAyMSAtMjQ5IDEwMCAtNTM3IDU0IC03ODQgLTEyNCAtMzYgLTI1IC02OSAtNDkgLTc1IC01MyAtMTcgLTExIDIyIC00NiAxMTkgLTEwNSAxNjMgLTEwMSAzMDAgLTE0NCA0NjAgLTE0NCA5MiAtMSAyMjYgMjQgMzAxIDU2IDIwIDggMzggMTUgMzkgMTUgMiAwIC0xMCAtMzkgLTI1IC04NyAtNjkgLTIxMyAtNTggLTM5NSAzNiAtNjAwIDMxIC02OSAxMzYgLTIzNyAxNTQgLTI0OCAxMCAtNiAxMTQgMTQ0IDE1MiAyMjAgMzcgNzMgNzUgMTk5IDg4IDI5MyAxNCAxMDEgMSAyMDYgLTQwIDMzMCAtMTUgNDggLTI3IDg4IC0yNiA4OSAxIDIgMjYgLTcgNTUgLTE4IDE5NSAtNzQgNDIzIC02NiA2MTEgMjIgOTggNDYgMjE3IDExOCAyNDUgMTQ5IDE4IDIwIDE4IDIxIC0xIDM1IC0xNzcgMTM5IC0zOTYgMjI1IC01NzAgMjI1IC03OSAwIC0xOTUgLTIzIC0yODIgLTU2IC00NCAtMTYgLTYzIC0yMCAtNTkgLTExIDI3IDcyIDYwIDE5NiA2OCAyNjAgMTcgMTMyIC0xNyAzMDAgLTg5IDQ0MiAtMzYgNzIgLTEyNCAyMDkgLTE0MSAyMTkgLTUgNCAtMjEgLTggLTM1IC0yNnogbTQwIC05MzUgYzcgLTQ2IDUwIC05MiAxMDkgLTExOSAyNyAtMTMgNDEgLTIzIDMxIC0yMyAtMTEgLTEgLTM4IC0xMiAtNjIgLTI2IC00OSAtMjkgLTgzIC05MCAtODUgLTE1MSAtMSAtMzcgLTIgLTM2IC05IDEzIC00IDI5IC0xNyA2NyAtMjggODUgLTIyIDM1IC04NiA3NyAtMTE4IDc5IC0xMSAwIDEgOSAyNiAyMCA3OSAzNSAxMTggOTAgMTIxIDE2OCAxIDI1IDMgMjggNiAxMSAyIC0xNCA2IC0zOSA5IC01N3oiLz4KICA8L2c+Cjwvc3ZnPg==';

                    document.querySelectorAll('img').forEach(img => {
                        if (img.src && img.src.includes('browser-use.com')) {
                            img.src = ROSE_LOGO_URL;
                            img.alt = 'Rose';
                        }
                    });
                })();
            """
            try:
                page_targets = await dom_service._session._cdp_get_all_pages()
                for target in page_targets:
                    try:
                        target_id = target.get("targetId")
                        if target_id:
                            temp_session = await dom_service._session.get_or_create_cdp_session(target_id, focus=False)
                            await temp_session.cdp_client.send.Runtime.evaluate(
                                params={"expression": immediate_replace_script}, session_id=temp_session.session_id
                            )
                    except Exception:
                        pass
            except Exception as e:
                logger.debug(f"Could not replace logos on existing pages: {e}")

            logger.info("\U0001f3a8 Hijacked img.src to replace browser-use logo with Rose logo")
        except Exception as e:
            logger.warning(f"Failed to replace logo: {e}")
        _record_timing("post_setup.logo_hijack", t)
        _record_timing("post_setup_total", t_post)

        # ===== PHASE 4: NAVIGATION =====
        t_nav = time.monotonic()
        if not write_lock_resume_state:
            from browser_use.browser.events import NavigateToUrlEvent

            nav_url = start_url
            if not nav_url.startswith(("http://", "https://", "about:", "file:")):
                nav_url = f"https://{nav_url}"
                logger.info(f"\U0001f517 Auto-added https:// to start URL: {nav_url}")

            await save_browser_action_message(
                agent_id=agent_id,
                title=f"Navigating \u2192 {nav_url[:50]}",
                task_id=task_id,
                message="",
                status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url,
                action_type="goto",
                tool_call_id=tool_call_id,
                steps_taken=0,
                total_steps=MAX_ITERATIONS,
            )

            t = time.monotonic()
            event = dom_service.session.event_bus.dispatch(NavigateToUrlEvent(url=nav_url))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            _record_timing("navigation.navigate", t)

            t = time.monotonic()
            try:
                from urllib.parse import urlparse

                parsed = urlparse(nav_url)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                result_data = await inject_local_storage(config, session_id, origin)
                if result_data and result_data.get("injected"):
                    logger.info(f"\U0001f4be Injected {result_data.get('count', 0)} localStorage entries for {origin}")
            except Exception as e:
                logger.warning(f"Failed to inject localStorage for {nav_url}: {e}")
            _record_timing("navigation.inject_localStorage", t)

            await save_browser_action_message(
                agent_id=agent_id,
                title=f"Navigated \u2192 {nav_url[:50]}",
                task_id=task_id,
                message="",
                status=MessageStatus.FINISHED,
                browser_url=browser_url,
                action_type="goto",
                tool_call_id=tool_call_id,
                steps_taken=0,
                total_steps=MAX_ITERATIONS,
            )

            logger.info(f"\U0001f310 Auto-navigated to start URL: {nav_url}")
        else:
            logger.info("\U0001f504 Resuming from write lock approval - skipping start URL navigation")
        _record_timing("navigation_total", t_nav)

        # ===== LOG SETUP TIMING SUMMARY =====
        total_ms = (time.monotonic() - setup_origin) * 1000
        timing_events_sorted = sorted(timing_events, key=lambda x: x[1])
        timing_lines = ["[TIMING] Browser agent setup timeline:"]
        for name, start_ms, end_ms in timing_events_sorted:
            duration = end_ms - start_ms
            indent = "  \u2502 " if "." in name else "  "
            display_name = name.split(".")[-1] if "parallel." in name else name
            timing_lines.append(
                f"{indent}{display_name:<25} {start_ms:>8.0f}ms \u2192 {end_ms:>8.0f}ms  ({duration:>7.1f}ms)"
            )
        timing_lines.append(
            f"  {'TOTAL':<25} {'0':>8}ms \u2192 {total_ms:>8.0f}ms  ({total_ms:>7.1f}ms / {total_ms / 1000:.1f}s)"
        )
        logger.info("\n".join(timing_lines))

        # ===== MAIN AGENT LOOP =====
        rose_client = RoseClient()
        iteration = resume_step_count
        consecutive_api_failures = 0

        while iteration < MAX_ITERATIONS:
            iteration += 1
            activity.heartbeat(f"Step {iteration}")

            # Handle pending write lock action
            if pending_write_lock_action:
                logger.info("Executing pending write lock action after approval")
                unified_action = pending_write_lock_action
                pending_write_lock_action = None

                activity.heartbeat(f"Step {iteration} - executing pending write lock action")
                result = await execute_action(
                    dom_service,
                    action_history,
                    unified_action,
                    available_file_paths,
                    session_id=session_id,
                    config=config,
                    humanizer=humanizer,
                    secret_refs=secret_refs,
                    password_origins=password_origins,
                    current_url=current_url,
                    write_lock_enabled=write_lock_enabled,
                    write_lock_approvals=write_lock_approvals,
                    system_name=system_name,
                )

                action_name = unified_action.get("action", "unknown")
                logger.info(f"Pending write lock action executed: {action_name}", result=result)

                activity.heartbeat(f"Step {iteration} - fetching browser state")
                browser_state = await dom_service.get_browser_state(include_screenshot=True)
                current_url = browser_state.get("url", "")

                await action_history.record_action(
                    dom_service=dom_service,
                    action=action_name,
                    thinking=f"Executed after write lock approval: {action_name}",
                    index=unified_action.get("params", {}).get("index"),
                    coordinates=unified_action.get("params", {}).get("coordinates"),
                    params=unified_action.get("params", {}),
                    result=result,
                )

                continue

            # 0. Fetch recent OTPs
            otp_section = ""
            try:
                otp_section = await fetch_recent_otps(user_id, config.backend.api_url, config.backend.api_key)
            except Exception as e:
                logger.warning("Failed to fetch OTPs", error=str(e))

            # 1. Get current browser state
            activity.heartbeat(f"Step {iteration} - fetching browser state")
            browser_state = await dom_service.get_browser_state(include_screenshot=True)
            current_url = browser_state.get("url", "")

            # 1b. Composite cursor
            prev_entries = action_history.get_entries()
            if prev_entries and browser_state.get("screenshot"):
                last_coords = prev_entries[-1].get("coordinates")
                if last_coords:
                    from browser_tools.cursor_overlay import composite_cursor_on_screenshot

                    browser_state["screenshot"] = composite_cursor_on_screenshot(
                        browser_state["screenshot"], last_coords["x"], last_coords["y"]
                    )

            if current_url and (not visited_urls or current_url != visited_urls[-1]):
                visited_urls.append(current_url)

            # 2. Build custom instructions with OTP
            custom_instructions = base_custom_instructions
            if otp_section:
                custom_instructions += f"\n\n{otp_section}"

            # 3. Build enriched task
            #    The static prompt body (goal/instructions/files/safety rules)
            #    is byte-identical across iterations from the same spawn — this
            #    is the cache window. The dynamic per-step state (time + URL)
            #    is emitted as a separate trailing [STATE: ...] line so it does
            #    not contaminate the cacheable prefix.
            static_prompt = get_browser_system_prompt(
                goal,
                custom_instructions,
                available_files=list(available_file_paths.keys()) if available_file_paths else None,
            )
            state_line = build_state_line(current_url=current_url)
            enriched_task = f"{static_prompt}\n\n{state_line}"

            # 4. Call Rose API
            try:
                action_entries = action_history.get_entries()
                if action_entries:
                    last = action_entries[-1]
                    logger.info(
                        "\U0001f50d [TRACE] Last action before Rose API",
                        action=last.get("action"),
                        has_thinking=bool(last.get("thinking")),
                        has_screenshot=bool(last.get("screenshot")),
                        thinking_preview=last.get("thinking", "")[:100] if last.get("thinking") else "NONE",
                    )

                activity.heartbeat(f"Step {iteration} - calling Rose API")
                llm_result = await _call_browser_use_with_rotation(
                    rose_client=rose_client,
                    task=enriched_task,
                    browser_state=browser_state,
                    action_entries=action_entries,
                    config=config,
                    user_id=user_id,
                    agent_id=agent_id,
                    iteration=iteration,
                    token_state=token_state,
                    gpt_token=gpt_token,
                    gpt_account_id=gpt_account_id,
                    gpt_token_source=gpt_token_source,
                    gpt_token_pool_id=gpt_token_pool_id,
                    browser_use_mode=browser_use_mode,
                )
                # Track waterfall fall-through so subsequent iterations skip claudeAuth.
                if llm_result.get("mode") != "claude" and browser_use_mode == "claude":
                    browser_use_mode = None
                    token_state.fallen_back_to_waterfall = True
                if llm_result.get("mode") != "gpt" and browser_use_mode == "gpt":
                    browser_use_mode = None

                usage = llm_result.get("usage", {})
                response_mode = llm_result.get("mode", "")
                if response_mode not in ("claude", "gpt"):
                    total_input_tokens += usage.get("prompt_tokens", 0)
                    total_output_tokens += usage.get("completion_tokens", 0)

            except Exception as e:
                consecutive_api_failures += 1
                logger.error(
                    f"Rose API call failed ({consecutive_api_failures}/{MAX_CONSECUTIVE_API_FAILURES}): {type(e).__name__}: {e}",
                    iteration=iteration,
                )
                if consecutive_api_failures >= MAX_CONSECUTIVE_API_FAILURES:
                    logger.error(
                        f"Aborting: {MAX_CONSECUTIVE_API_FAILURES} consecutive Rose API failures",
                        last_error=str(e),
                    )
                    break
                await asyncio.sleep(2)
                continue

            # Reset consecutive failure counter on success
            consecutive_api_failures = 0

            _rose_request_id = llm_result.get("request_id", "unknown")

            # 4. Extract action from response
            unified_action = llm_result.get("action", {})
            action_name = unified_action.get("action", "")
            thinking = unified_action.get("thinking", "")

            if thinking:
                reasoning_messages.append(thinking)
                await save_browser_assistant_message(agent_id, thinking, task_id)

            action_summary.append(f"{action_name}: {str(unified_action)[:500]}")
            if len(action_summary) > 20:
                action_summary[:] = action_summary[-20:]

            # 5. Handle special actions
            if action_name == "send_message_to_user":
                message = unified_action.get("params", {}).get("message", "")
                reason = unified_action.get("params", {}).get("reason", "other")

                logger.info("Browser agent requested user attention", reason=reason)
                await dom_service.disconnect()

                await close_browser_session(config, session_id, pause=True, current_url=current_url)

                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser Session Paused",
                    task_id=task_id,
                    message=message,
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url,
                    action_type="session_paused",
                )

                execution_time_ms = (safe_time() - start_time) * 1000
                usage_items = build_usage_items(
                    total_input_tokens, total_output_tokens, model_pricing, execution_time_ms
                )

                return {
                    "status": "needs_user_help",
                    "message": message,
                    "reason": reason,
                    "task_id": task_id,
                    "session_id": session_id,
                    "browser_url": browser_url,
                    "original_goal": goal,
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items,
                }

            if action_name in ("attempt_completion", "done"):
                close_reasoning = unified_action.get("params", {}).get("reasoning", "") or unified_action.get(
                    "params", {}
                ).get("text", "")

                verifier_call_id = str(uuid_module.uuid4())
                try:
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="\u2696\ufe0f Verifying completion",
                        task_id=task_id,
                        message="",
                        status=MessageStatus.IN_PROGRESS,
                        browser_url=browser_url,
                        action_type="system",
                        tool_call_id=verifier_call_id,
                    )

                    action_entries = action_history.get_entries()[-30:]
                    action_details_lines = []
                    for entry in action_entries:
                        step = entry.get("step", "?")
                        ea = entry.get("action", "unknown")
                        er = entry.get("result", {})
                        esuccess = er.get("success", False)
                        estatus = "\u2705 Success" if esuccess else f"\u274c Failed: {er.get('error', 'unknown')}"

                        line = f"Step {step}: {ea} - {estatus}"
                        if ea == "screenshot" and esuccess:
                            line += " (full-page capture \u2014 entire scrollable page, not just viewport)"
                        eparams = entry.get("params", {})
                        if eparams:
                            display_params = {k: v for k, v in eparams.items() if k not in ["screenshot", "dom_tree"]}
                            if display_params:
                                line += f"\n  Params: {display_params}"
                        display_result = {
                            k: v for k, v in er.items() if k not in ["success", "error", "screenshot", "dom_tree"]
                        }
                        if display_result:
                            line += f"\n  Result: {display_result}"
                        action_details_lines.append(line)

                    actions_text = "\n\n".join(action_details_lines)

                    page_stats = browser_state.get("page_stats", {})
                    scroll_pos = browser_state.get("scroll_position", {})
                    pages_above = scroll_pos.get("pages_above", 0)
                    total_pages = scroll_pos.get("total_pages", 1)

                    # C10: Browser verifier infers from action_history + final-state
                    # ground truth. Multi-step browser tasks would balloon if we
                    # stuffed every step's DOM into the verifier prompt; instead
                    # we pass the action history (which logs URL transitions and
                    # tool inputs/outputs), the final-state DOM, and the final-state
                    # screenshot reference. The verifier reconstructs the journey
                    # from action_history and grounds the answer in the FINAL state.
                    #
                    # Browser-sourced ground truth lives in the user prompt, not
                    # a TOOL message. LLM-generated tool results (e.g. `extract`)
                    # are reward-hackable; the DOM tree comes straight from
                    # DOMService and is the only safe substrate for verifying a
                    # claimed answer.
                    dom_tree = browser_state.get("dom_tree", "") or ""
                    final_screenshot_b64 = browser_state.get("screenshot")
                    session_files = await list_session_files(session_id)
                    files_text = "Downloaded Files in Session:\n"
                    if session_files:
                        for f in session_files:
                            files_text += f"  - {f.get('path', 'unknown')} ({f.get('size', 0)} bytes)\n"
                    else:
                        files_text += "  (no files downloaded)\n"

                    user_prompt = (
                        f"Goal: {goal}\n\n"
                        "## Browser Ground Truth (FINAL STATE)\n"
                        "Read the DOM independently and decide whether the goal is satisfied. "
                        "Do NOT rely on what the agent reported — only on what the page actually shows. "
                        "The action_history below shows the URL transitions taken to reach this final state.\n\n"
                        f"URL: {current_url}\n"
                        f"Title: {browser_state.get('title', 'Unknown')}\n"
                        f"Interactive Elements: {page_stats.get('interactive', 0)}\n"
                        f"Scroll Position: Page {pages_above + 1} of {total_pages}\n\n"
                        "### DOM Tree (browser-extracted final-state page content)\n"
                        f"{dom_tree}"
                    )

                    # C11: the final-state screenshot rides through to the
                    # verifier as a multimodal image content block. The DOM
                    # tree (in user_prompt above) remains the source of truth;
                    # the image is supplementary. Wiring lives in
                    # helpers/llm.py:build_verifier_context_messages — when
                    # `metadata.screenshot_b64` is present on a TOOL message,
                    # it's flushed as `{type: image, source: {type: base64,
                    # media_type, data}}` instead of being inlined as text.
                    verifier_context = [
                        {"role": "USER", "text": user_prompt},
                        {
                            "role": "TOOL",
                            "text": f"Browser Agent Execution Log ({len(action_entries)} actions shown — URL transitions, tool inputs/outputs):\n\n{actions_text}",
                            "metadata": {"toolName": "action_history", "toolStatus": "FINISHED"},
                        },
                        {
                            "role": "TOOL",
                            "text": files_text,
                            "metadata": {"toolName": "session_files", "toolStatus": "FINISHED"},
                        },
                        # Final-state screenshot — emitted as a multimodal
                        # image block by build_verifier_context_messages when
                        # screenshot_b64 is set in metadata. Body text stays
                        # short (no b64 inlining).
                        {
                            "role": "TOOL",
                            "text": (
                                "Final-state screenshot attached (b64-encoded PNG of "
                                "the entire scrollable page). Treat the DOM tree above as "
                                "ground truth; the screenshot is supplementary."
                                if final_screenshot_b64
                                else "No final-state screenshot included; DOM tree is the verifier ground truth."
                            ),
                            "metadata": {
                                "toolName": "final_screenshot",
                                "toolStatus": "FINISHED",
                                "screenshot_b64": final_screenshot_b64 or "",
                            },
                        },
                    ]

                    verifier_prompt = build_verifier_prompt(
                        response_schema=transform_schema_for_remote_session(response_schema)
                    )

                    remote_session_schema = transform_schema_for_remote_session(response_schema)

                    # B2: `check_progress` now forces rose-1-ultra + claude_token
                    # internally. One call site, no LITE fallback — the model arg
                    # is forced inside the activity, but we still pass it so the
                    # call signature stays explicit at the call site.
                    # C7: dead `phase` positional arg has been removed from
                    # check_progress; callers no longer pass it. C14:
                    # `verifier_context` is built locally from this browser
                    # session's action history + DOM + final-state screenshot —
                    # nothing from parent agents reaches it.
                    progress_result = await call_temporal_activity_from_activity(
                        check_progress,
                        args=[
                            verifier_context,
                            verifier_prompt,
                            VERIFIER_ULTRA_MODEL,
                            remote_session_schema,
                            token_state.access_token,
                            "verifier_browser",
                            agent_id,
                            None,
                            None,
                            user_id,
                            gpt_token,
                            gpt_account_id,
                            gpt_token_source,
                            gpt_token_pool_id,
                            user_id,
                        ],
                        start_to_close_timeout=timedelta(seconds=VERIFIER_ULTRA_TIMEOUT_SECONDS),
                    )

                    v_usage = progress_result.get("usage", {})
                    verifier_actual_model = v_usage.get("actual_model", "")
                    if not (str(verifier_actual_model).endswith("-claude") or str(verifier_actual_model).endswith("-gpt")):
                        total_input_tokens += v_usage.get("prompt_tokens", 0)
                        total_output_tokens += v_usage.get("completion_tokens", 0)

                    score = progress_result.get("score", 0.0)
                    v_reasoning = progress_result.get("reasoning", "")

                    await save_browser_action_message(
                        agent_id=agent_id,
                        title=f"\u2696\ufe0f Progress: {score * 100:.0f}%",
                        task_id=task_id,
                        message=v_reasoning,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="system",
                        tool_call_id=verifier_call_id,
                    )

                    if score >= 1.0:
                        execution_time_ms = (safe_time() - start_time) * 1000
                        structured_response = progress_result.get("structured_response")

                        uploaded_paths = list(available_file_paths.values()) if available_file_paths else []
                        output_files = await extract_session_files(
                            session_id, user_id, config, exclude_paths=uploaded_paths
                        )

                        last_screenshot_b64 = browser_state.get("screenshot")
                        if last_screenshot_b64:
                            try:
                                screenshot_bytes = base64.b64decode(last_screenshot_b64)
                                screenshot_fp = await upload_to_storage(
                                    user_id=user_id,
                                    file_content=screenshot_bytes,
                                    filename="screenshot_final.png",
                                    mime_type="image/png",
                                )
                                output_files.append(screenshot_fp)
                                logger.info(
                                    "[BrowserAgent] Uploaded final screenshot",
                                    agent_id=agent_id,
                                    size_bytes=screenshot_fp["size_bytes"],
                                )
                            except Exception as e:
                                logger.warning(
                                    "[BrowserAgent] Failed to upload final screenshot",
                                    agent_id=agent_id,
                                    error=extract_error_message(e),
                                )

                        if structured_response and output_files:
                            structured_response = resolve_file_pointers_from_extracted(
                                structured_response=structured_response,
                                output_schema=response_schema,
                                extracted_files=output_files,
                            )
                            logger.info(
                                "Resolved file pointers in browser agent response",
                                agent_id=agent_id,
                                file_count=len(output_files),
                            )

                        await dom_service.disconnect()
                        await close_browser_session(config, session_id, pause=False)

                        context_message = build_context_summary(
                            success=True,
                            close_reasoning=close_reasoning,
                            visited_urls=visited_urls,
                            reasoning_messages=reasoning_messages,
                            action_summary=action_summary,
                        )

                        await save_browser_action_message(
                            agent_id=agent_id,
                            title="\u2713 Task Completed",
                            task_id=task_id,
                            message=context_message,
                            status=MessageStatus.FINISHED,
                            browser_url=browser_url,
                            action_type="task_complete",
                            tool_call_id=tool_call_id,
                            is_completion_message=True,
                        )

                        usage_items = build_usage_items(
                            total_input_tokens, total_output_tokens, model_pricing, execution_time_ms
                        )

                        return {
                            "status": "completed",
                            "success": True,
                            "message": context_message,
                            "browser_url": browser_url,
                            "usage_items": usage_items,
                            "execution_time_ms": execution_time_ms,
                            "structured_response": structured_response,
                            "output_files": output_files,
                        }

                    verifier_feedback_thinking = f"""I just checked in with verifier for the task and it said:
<verifier_response>
Score: {score:.0%}
Reasoning: {v_reasoning}
</verifier_response>

Based on this feedback, I need to continue working on the task and address the issues mentioned."""

                    await save_browser_assistant_message(agent_id, verifier_feedback_thinking, task_id)

                    # C5: When the verifier rejects (score < 1.0), surface the
                    # feedback as the natural TOOL result of the agent's
                    # `attempt_completion` call — that way the agent sees the
                    # rejection where it expects to (the result of the tool it
                    # just called), not as a stray system message.
                    continuing_tool_call_id = str(uuid_module.uuid4())
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title=f"⚖️ Verifier rejected ({score:.0%}) — continue task",
                        task_id=task_id,
                        message=(
                            f"Verifier score: {score:.0%}\n\n"
                            f"Reasoning: {v_reasoning}\n\n"
                            "Take a NEW action that produces fresh tool evidence "
                            "matching the goal, then call attempt_completion again."
                        ),
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="system",
                        tool_call_id=continuing_tool_call_id,
                        tool_name_override="attempt_completion",
                        extra_metadata={"verifierMessage": True},
                    )

                    current_state = await dom_service.get_browser_state(include_screenshot=True)
                    current_screenshot = current_state.get("screenshot")

                    await action_history.record_action(
                        dom_service=dom_service,
                        action="wait",
                        thinking=verifier_feedback_thinking,
                        result={"success": True, "message": "Verifier feedback processed"},
                        screenshot=current_screenshot,
                    )

                    logger.info(
                        "\U0001f50d [TRACE] Recorded verifier feedback action",
                        step=len(action_history),
                        has_screenshot=bool(current_screenshot),
                        thinking_preview=verifier_feedback_thinking[:200],
                    )

                except Exception as verifier_error:
                    logger.error(f"Verifier failed: {verifier_error}")
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="\u26a0\ufe0f Verification failed",
                        task_id=task_id,
                        message=f"Error: {str(verifier_error)[:200]}",
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="error",
                        tool_call_id=verifier_call_id,
                    )

                continue

            # 6. Execute regular action
            tool_call_id_action = str(uuid_module.uuid4())

            idx = unified_action.get("index")
            coords = unified_action.get("coordinates")
            element_desc = None
            if idx is not None:
                element = dom_service.selector_map.get(idx)
                if element:
                    element_desc = get_element_description(element)

            title_progress, title_done, action_name = build_action_titles(
                action_name, unified_action, element_desc, coords, secret_refs
            )

            coords_for_cursor = coords
            if not coords_for_cursor and idx is not None:
                coord_tuple = await dom_service.get_element_coordinates(idx)
                if coord_tuple:
                    coords_for_cursor = {"x": coord_tuple[0], "y": coord_tuple[1]}

            await save_browser_action_message(
                agent_id=agent_id,
                title=title_progress,
                task_id=task_id,
                message="",
                status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url,
                action_type=action_name,
                tool_call_id=tool_call_id_action,
                steps_taken=iteration,
                total_steps=MAX_ITERATIONS,
                auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None,
            )

            activity.heartbeat(f"Step {iteration} - executing {action_name}")
            result = await execute_action(
                dom_service,
                action_history,
                unified_action,
                available_file_paths,
                session_id=session_id,
                config=config,
                humanizer=humanizer,
                secret_refs=secret_refs,
                password_origins=password_origins,
                current_url=current_url,
                write_lock_enabled=write_lock_enabled,
                write_lock_approvals=write_lock_approvals,
                system_name=system_name,
            )

            if result.get("status") == "needs_write_approval":
                approval_type = result.get("approval_type", "unknown")
                question = result.get("question", f"{system_name} wants to perform a write action. Approve?")

                logger.info(
                    "Write lock approval required - returning to workflow", approval_type=approval_type, url=current_url
                )

                if dom_service:
                    try:
                        await dom_service.disconnect()
                    except Exception as e:
                        logger.warning(f"Failed to disconnect browser before write lock return: {e}")

                logger.info(
                    "Returning to workflow for write lock approval",
                    task_id=task_id,
                    session_id=session_id,
                    cdp_url=cdp_url[:50] if cdp_url else None,
                )
                return {
                    "status": "awaiting_write_approval",
                    "approval_type": approval_type,
                    "question": question,
                    "current_url": current_url,
                    "pending_action": unified_action,
                    "write_lock_approvals": write_lock_approvals,
                    "step_count": iteration,
                    "session_id": session_id,
                    "cdp_url": cdp_url,
                    "task_id": task_id,
                }

            if result.get("success", True):
                logger.info(f"Action {action_name} successful", agent_id=agent_id, title=title_done, task_id=task_id)
                await save_browser_action_message(
                    agent_id=agent_id,
                    title=title_done,
                    task_id=task_id,
                    message=result.get("message", ""),
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url,
                    action_type=action_name,
                    tool_call_id=tool_call_id_action,
                    steps_taken=iteration,
                    total_steps=MAX_ITERATIONS,
                    auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None,
                )
            else:
                logger.error(
                    f"Action {action_name} failed",
                    agent_id=agent_id,
                    title=title_done,
                    task_id=task_id,
                    message=result.get("error", "Failed"),
                    status=MessageStatus.ERROR,
                    browser_url=browser_url,
                    action_type="error",
                    tool_call_id=tool_call_id_action,
                )
                await save_browser_action_message(
                    agent_id=agent_id,
                    title=title_done,
                    task_id=task_id,
                    message=result.get("error", "Failed"),
                    status=MessageStatus.ERROR,
                    browser_url=browser_url,
                    action_type="error",
                    tool_call_id=tool_call_id_action,
                    steps_taken=iteration,
                    total_steps=MAX_ITERATIONS,
                    auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None,
                )

            await asyncio.sleep(ACTION_LOOP_DELAY_SECONDS)

        # Max iterations reached
        logger.warning(f"Max iterations reached: {MAX_ITERATIONS}")

        await dom_service.disconnect()
        await close_browser_session(config, session_id, pause=False)

        context_message = build_context_summary(
            success=False,
            close_reasoning=f"Max iterations ({MAX_ITERATIONS}) reached",
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
        )

        await save_browser_action_message(
            agent_id=agent_id,
            title="Task Incomplete - Max Steps Reached",
            task_id=task_id,
            message=context_message,
            status=MessageStatus.FINISHED,
            browser_url=browser_url,
            action_type="task_complete",
            tool_call_id=tool_call_id,
            is_completion_message=True,
        )

        execution_time_ms = (safe_time() - start_time) * 1000
        usage_items = build_usage_items(total_input_tokens, total_output_tokens, model_pricing, execution_time_ms)

        return {
            "status": "max_iterations",
            "success": False,
            "message": context_message,
            "browser_url": browser_url,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms,
        }

    except asyncio.CancelledError:
        logger.info("\U0001f534 Browser agent activity cancelled (paused)")

        if dom_service:
            with contextlib.suppress(Exception):
                await dom_service.disconnect()

        if session_id:
            await close_browser_session(config, session_id, pause=True, current_url=current_url)

        if task_id:
            with contextlib.suppress(Exception):
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser Session Cancelled",
                    task_id=task_id,
                    message="Agent paused by user",
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url or "",
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                    is_completion_message=True,
                )

        return {
            "status": "cancelled",
            "task_id": task_id,
            "session_id": session_id,
            "browser_url": browser_url,
            "message": "Browser agent cancelled by user",
        }

    except Exception as e:
        logger.error("Browser automation failed", error=extract_error_message(e))

        if dom_service:
            with contextlib.suppress(Exception):
                await dom_service.disconnect()

        if session_id:
            await close_browser_session(config, session_id, pause=False)

        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        error_message = build_context_summary(
            success=False,
            close_reasoning=extract_error_message(e),
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            error_context=error_context,
        )

        if task_id:
            with contextlib.suppress(Exception):
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Task Failed",
                    task_id=task_id,
                    message=error_message,
                    status=MessageStatus.ERROR,
                    browser_url=browser_url or "",
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                    is_completion_message=True,
                )

        raise
    finally:
        await _stop_playwright_resources(playwright_browser, playwright_instance, agent_id)


# ========================================
# WORKFLOW HELPER & MANAGER
# ========================================


class SpawnBrowserAgentManagerV3(ToolManager):
    """Manager using browser-use BrowserSession + Rose API."""

    tool_name = "spawn_browser_agent"

    async def execute_tool(  # noqa: C901
        self, workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn browser agent with browser-use + Rose API."""
        start_url = tool_call.get("start_url", "")
        goal = tool_call.get("goal", "")
        output_schema = tool_call.get("output_schema")
        requested_attachments = tool_call.get("attachments")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        attachments: List[Dict[str, Any]] = []
        if requested_attachments and hasattr(workflow_instance, "context"):
            context_attachments = extract_attachments_from_context(workflow_instance.context)
            filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

            for filename in requested_attachments:
                if filename in filename_to_pointer:
                    fp = filename_to_pointer[filename]
                    attachments.append(
                        {
                            "id": fp.id,
                            "storage_path": fp.storage_path,
                            "original_filename": fp.original_filename,
                            "mime_type": fp.mime_type,
                            "size_bytes": fp.size_bytes,
                            "created_at": fp.created_at,
                        }
                    )
                else:
                    logger.warning(
                        "[BrowserAgent] Attachment not found in context",
                        agent_id=agent_id,
                        filename=filename,
                        available_files=list(filename_to_pointer.keys()),
                    )

        logger.info(
            "Browser agent starting (v3)",
            goal=goal,
            has_output_schema=output_schema is not None,
            num_attachments=len(attachments),
        )

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting up a browser",
            message="",
            status=MessageStatus.IN_PROGRESS,
            metadata={"toolName": "spawn_browser_agent"},
        )

        try:
            write_lock_enabled = getattr(workflow_instance, "write_lock_enabled", True)
            system_name = getattr(workflow_instance, "system_name", "Rose")
            active_claude_token = (
                workflow_instance._active_claude_token()
                if hasattr(workflow_instance, "_active_claude_token")
                else getattr(workflow_instance, "claude_max_token", None)
            )
            active_gpt_token = (
                workflow_instance._active_gpt_token()
                if hasattr(workflow_instance, "_active_gpt_token")
                else getattr(workflow_instance, "gpt_code_token", None)
            )
            active_gpt_account_id = (
                workflow_instance._active_gpt_account_id()
                if hasattr(workflow_instance, "_active_gpt_account_id")
                else getattr(workflow_instance, "gpt_code_account_id", None)
            )
            active_gpt_source = (
                workflow_instance._active_gpt_source()
                if hasattr(workflow_instance, "_active_gpt_source")
                else getattr(workflow_instance, "gpt_code_token_source", None)
            )
            active_gpt_pool_id = (
                workflow_instance._active_gpt_pool_id()
                if hasattr(workflow_instance, "_active_gpt_pool_id")
                else getattr(workflow_instance, "gpt_code_token_pool_id", None)
            )

            write_lock_resume_state = None
            result = None

            while True:
                async with span(
                    "browser_activity_wait",
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="spawn_browser_agent",
                    is_resume=write_lock_resume_state is not None,
                ):
                    activity_handle = workflow.start_activity(
                        spawn_browser_agent_activity_v3,
                        args=[
                            user_id,
                            agent_id,
                            goal,
                            tool_call_id,
                            write_lock_resume_state.get("task_id") if write_lock_resume_state else None,
                            write_lock_resume_state.get("session_id") if write_lock_resume_state else None,
                            write_lock_resume_state.get("cdp_url") if write_lock_resume_state else None,
                            write_lock_resume_state is not None,
                            output_schema,
                            attachments if attachments else None,
                            write_lock_enabled,
                            start_url,
                            write_lock_resume_state,
                            system_name,
                            bool(active_claude_token) and not bool(active_gpt_token),
                            active_gpt_token,
                            active_gpt_account_id,
                            active_gpt_source,
                            active_gpt_pool_id,
                        ],
                        start_to_close_timeout=timedelta(minutes=ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES),
                        heartbeat_timeout=timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS),
                        cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                        retry_policy=RetryPolicy(maximum_attempts=MAX_ACTIVITY_RETRIES),
                    )

                    was_cancelled = False
                    await workflow.wait_condition(lambda: activity_handle.done() or workflow_instance.is_paused)  # noqa: B023
                    if workflow_instance.is_paused and not activity_handle.done():
                        logger.info("\U0001f534 Cancelling browser agent due to pause")
                        activity_handle.cancel()
                        was_cancelled = True

                    try:
                        result = await activity_handle
                    except (asyncio.CancelledError, ActivityError) as e:
                        if isinstance(e, ActivityError) and not isinstance(
                            e.cause, (asyncio.CancelledError, TemporalCancelledError)
                        ):
                            raise
                        was_cancelled = True
                        result = {"status": "cancelled", "message": "Browser agent cancelled by user"}

                if was_cancelled or (result and result.get("status") == "cancelled"):
                    logger.info("\U0001f534 Browser agent cancelled")
                    pause_metadata = {
                        "toolName": "spawn_browser_agent",
                        "action_type": "session_paused",
                    }
                    if result:
                        if result.get("task_id"):
                            pause_metadata["task_id"] = result["task_id"]
                        if result.get("browser_url"):
                            pause_metadata["browser_url"] = result["browser_url"]
                        if result.get("session_id"):
                            pause_metadata["session_id"] = result["session_id"]
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Browser Session Paused",
                        message="User paused the browser agent",
                        status=MessageStatus.ERROR,
                        metadata=pause_metadata,
                    )
                    return

                if result and result.get("status") == "awaiting_write_approval":
                    logger.info(
                        "Browser agent needs write lock approval",
                        approval_type=result.get("approval_type"),
                        url=result.get("current_url"),
                    )

                    from tools.request_user_approval import UserRejectedError, request_user_approval_direct

                    try:
                        approval_response = await request_user_approval_direct(
                            workflow_instance,
                            question=result["question"],
                            metadata={
                                "toolApproval": True,
                                "writePermission": True,
                                "url": result.get("current_url", ""),
                            },
                        )

                        approval_type = result.get("approval_type", "unknown")
                        current_approvals = result.get("write_lock_approvals", {})

                        current_approvals[approval_type] = {
                            "domain": get_domain_from_url(result.get("current_url", "")),
                            "approved_at": workflow.now().timestamp(),
                        }

                        write_lock_resume_state = {
                            "pending_action": result.get("pending_action"),
                            "write_lock_approvals": current_approvals,
                            "approval_type": approval_type,
                            "step_count": result.get("step_count", 0),
                            "session_id": result.get("session_id"),
                            "cdp_url": result.get("cdp_url"),
                            "task_id": result.get("task_id"),
                        }

                        logger.info(
                            "Write lock approval granted, resuming browser activity",
                            approval_type=approval_type,
                            task_id=write_lock_resume_state.get("task_id"),
                            session_id=write_lock_resume_state.get("session_id"),
                        )

                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="\u2713 Write permission granted",
                            message="",
                            status=MessageStatus.FINISHED,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "task_id": write_lock_resume_state.get("task_id"),
                                "requestUserApproval": {
                                    "writePermission": True,
                                    "attentionRequestId": approval_response.get("attention_request_id"),
                                },
                            },
                        )

                        continue

                    except UserRejectedError as e:
                        rejection_feedback = e.rejection_message
                        logger.info(
                            "Write lock approval rejected by user",
                            rejection_feedback=rejection_feedback[:100] if rejection_feedback else "",
                        )
                        error_msg = f"User denied permission for {result.get('approval_type', 'action')}"
                        if rejection_feedback:
                            error_msg = f'User rejected with feedback: "{rejection_feedback}"\n\n{error_msg}'
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="Action blocked by user",
                            message=error_msg,
                            status=MessageStatus.FINISHED,
                            metadata={"toolName": "spawn_browser_agent", "action_type": "write_lock_rejected"},
                        )
                        return

                break

            tool_usage: Dict[str, list] = {"llm": [], "service": []}
            if result.get("usage_items"):
                for item in result["usage_items"]:
                    if item.get("type") == "llm":
                        tool_usage["llm"].append(
                            {
                                "tokens_in": item.get("input_tokens", 0),
                                "tokens_out": item.get("output_tokens", 0),
                                "model": item.get("model"),
                                "provider": item.get("provider", ""),
                            }
                        )
                    else:
                        tool_usage["service"].append(
                            {
                                "cost_cents": item.get("cost_cents", 0),
                                "provider": item.get("provider", ""),
                            }
                        )

            output_files = result.get("output_files", [])
            if output_files:
                logger.info(
                    "[BrowserAgent] Posting output files as ASSISTANT messages",
                    agent_id=agent_id,
                    file_count=len(output_files),
                )
                for fp in output_files:
                    yield AssistantEvent(
                        message="",
                        file_pointer=fp,
                    )

            final_status = MessageStatus.FINISHED if result.get("success", True) else MessageStatus.ERROR
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation complete",
                message=result.get("message", ""),
                status=final_status,
                metadata={"toolName": "spawn_browser_agent"},
                data={"usage": tool_usage},
            )

        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                raise

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation failed",
                message=extract_error_message(e),
                status=MessageStatus.ERROR,
                metadata={"toolName": "spawn_browser_agent"},
            )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SpawnBrowserAgentManagerV3] = None


def get_manager() -> SpawnBrowserAgentManagerV3:
    """Get or create spawn_browser_agent manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = SpawnBrowserAgentManagerV3()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================


async def spawn_browser_agent(workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str):
    """Workflow helper for spawn_browser_agent."""
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_browser_agent")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(
                event.data["usage"], tool_name="spawn_browser_agent", call_site="browser_agent"
            )

    return last_status
