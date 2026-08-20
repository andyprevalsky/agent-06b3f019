"""Handler for spawn-browser-agent-v3 domain.

Thin entry point: Temporal activity function and ToolManager.
Parses input, delegates to service layer, formats output.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import gc
import html as html_module
import importlib
import inspect
import json
import math
import os
import random
import re
import time
import traceback
import uuid as uuid_module
from datetime import timedelta
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List, Optional, Tuple

import structlog
import structlog.contextvars
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError

from browser_tools.schemas import AVAILABLE_ACTIONS, BrowserToolArgsValidationError
from config import load_config
from utils.payment_card import (
    MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS,
    build_payment_question,
    normalize_payment_payload,
)
from helpers.attachments import extract_attachments_from_context, upload_to_storage
from helpers.file_resolution import (
    resolve_file_pointers_from_extracted,
    transform_schema_for_remote_session,
)
from helpers.messages import stream_browser_cursor
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.tracing import span, traced
from helpers.user_profile import build_user_profile_sections
from helpers.world_model_runtime import WorldModelToolExecutionAdapter
from loop.activity_helper import call_temporal_activity_from_activity
from providers.fast_cache.browser_use_cache import cached_browser_decision
from providers.fast_cache.context import write_through_enabled_for_user
from providers.rose import ClaudeAuthContext, GptAuthContext, RoseClient
from providers.rose.browser_use import build_browser_state_message_content
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent, ToolManager
from utils.error_utils import extract_error_message
from utils.prompts import build_verifier_prompt

from .cdp_urls import steel_cdp_connection_url
from .challenge_recovery import (
    commit_cookie_removals,
    live_tab_looks_challenged,
    page_looks_challenged,
    probe_storage_state,
    recover_from_challenge,
    verify_live_blocked_resources,
    verify_live_page_cleared_challenge,
)
from .config import (
    ACTION_LOOP_DELAY_SECONDS,
    ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES,
    BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS,
    BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS,
    BROWSER_SUPERVISOR_MAX_RECOVERIES,
    BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
    BROWSER_USE_PRICING_POOL,
    BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS,
    HEARTBEAT_KEEPALIVE_SECONDS,
    HEARTBEAT_TIMEOUT_SECONDS,
    MAX_ACTIVITY_ATTEMPTS,
    MAX_CLAUDE_TOKEN_ROTATIONS,
    MAX_CONSECUTIVE_API_FAILURES,
    MAX_ITERATIONS,
    SESSION_INIT_TRANSIENT_MAX_ATTEMPTS,
    SESSION_INIT_TRANSIENT_RETRY_SECONDS,
    SESSION_MAX_WAIT_SECONDS,
    SESSION_RETRY_INTERVAL_SECONDS,
    VERIFIER_ULTRA_MODEL,
    VERIFIER_ULTRA_TIMEOUT_SECONDS,
)
from .credential_runtime import build_realm_credential_state
from .recording import (
    BrowserAgentRecorder,
    BrowserNetworkRecorder,
    SimulatedBrowserRecorder,
    blocked_resource_url_for_recovery,
    blocked_resource_requires_payment_cdn,
    browser_recording_output_dir,
    normalize_simulated_browser_frame,
)
from .repo import (
    acknowledge_browser_user_control,
    close_browser_session,
    create_user_auth_assistance_request,
    fetch_auth_options,
    fetch_browser_captcha_telemetry,
    fetch_browser_control_state,
    fetch_claude_token,
    fetch_session_info,
    init_browser_session,
    mark_steel_session_auth_failed,
    prepare_browser_auth,
    propagate_browser_run_credentials,
    recover_browser_challenge,
    report_claude_token_rate_limited,
    resume_browser_session,
    save_browser_action_message,
    save_browser_assistant_message,
    save_browser_credential_ref_message,
    upload_file_to_session,
)
from .service import (
    AuthRuntimeState,
    accumulate_model_usage,
    append_completion_evidence,
    browser_usage_items_to_tool_usage,
    build_action_titles,
    build_auth_assistance_resume_user_message,
    build_best_effort_response,
    build_browser_dynamic_system_context,
    build_browser_llm_usage_items,
    build_browser_task_prompt,
    build_browser_verifier_context,
    build_context_summary,
    build_usage_items,
    extract_session_files,
    safe_time,
    select_auth_assistance_current_url,
)
from .service_actions import (
    SITE_WRITE_LOCK_APPROVAL_KEY,
    _get_base_domain,
    execute_action,
    get_domain_from_url,
    get_element_description,
    grant_site_write_lock_approvals,
    resolve_site_write_lock_grant_url,
    wait_for_navigation_ready,
)
from .service_crypto import (
    PAYMENT_CARD_ENTRY_RULE,
    ExtractedOTP,
    auth_realm_from_url,
    auth_realm_matches_url,
    build_autopay_prompt_section,
    build_payment_card_resume_prompt_section,
    decrypt_payment_info,
    extract_rate_limited_until,
    fetch_recent_otps,
    format_otp_user_message,
    has_payment_card_secret_refs,
    is_usable_email_otp,
)
from .streaming import BrowserStreamingRoseClient, BrowserThinkingStream
from .types import ClaudeTokenState

logger = structlog.get_logger()
BROWSER_PROGRESS_TITLE = "Browser Agent In Progress"
_background_browser_cleanup_tasks: set[asyncio.Task] = set()


def build_browser_user_profile_sections(user_profile: Dict[str, Any]) -> List[str]:
    """Build the identity and delivery context supplied to a browser agent."""
    return build_user_profile_sections(user_profile)


async def prepare_optional_realm_credentials(
    *,
    target_url: str,
    current_auth_realm: str,
    failed_realms: Dict[str, str],
    prepare_credentials: Callable[[str], Awaitable[Optional[Dict[str, Any]]]],
) -> Optional[Dict[str, Any]]:
    """Run one optional cross-realm preparation and quarantine every failure stage."""
    target_realm = auth_realm_from_url(target_url)
    if (
        not target_realm
        or auth_realm_matches_url(current_auth_realm, target_url)
        or target_realm in failed_realms
    ):
        return None
    try:
        return await prepare_credentials(target_url)
    except Exception as prep_error:
        error_signature = (
            f"{type(prep_error).__name__}:{extract_error_message(prep_error)[:160]}"
        )
        failed_realms[target_realm] = error_signature
        logger.warning(
            "Optional realm credential preparation failed once; continuing without saved credentials",
            auth_realm=target_realm,
            target_url=target_url,
            error=error_signature,
        )
        return None


def _normalize_payment_card_last4(value: Any) -> Optional[str]:
    if isinstance(value, str) and re.fullmatch(r"\d{4}", value):
        return value
    return None


def _normalize_funding_retry_seconds(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 5.0
    try:
        retry_seconds = float(value)
    except OverflowError:
        return 5.0
    if not math.isfinite(retry_seconds) or retry_seconds <= 0:
        return 5.0
    return min(max(retry_seconds, 1.0), 60.0)


def _build_payment_card_verifier_evidence(last4: Any) -> Optional[Dict[str, Any]]:
    safe_last4 = _normalize_payment_card_last4(last4)
    if safe_last4 is None:
        return None
    return {
        "role": "TOOL",
        "text": f"Approved one-time payment card last four: {safe_last4}",
        "metadata": {
            "toolName": "payment_card_ready",
            "toolStatus": "FINISHED",
            "paymentCardLast4": safe_last4,
        },
    }


async def _lookup_payment_purchase(
    user_id: str,
    payment_payload: Dict[str, Any],
    world_model_mode: Optional[str] = None,
) -> tuple[Dict[str, Any], str]:
    """Look up the canonical key and retain a matched pre-canonicalization key for mint."""
    fingerprint = str(payment_payload.get("fingerprint") or "")
    activity_args = [user_id, fingerprint]
    if world_model_mode not in {None, "real"}:
        activity_args.append(world_model_mode)
    result = await workflow.execute_activity(
        "lookup_purchase_activity",
        args=activity_args,
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )
    purchase = result.get("purchase")
    matched = purchase.get("fingerprint") if isinstance(purchase, dict) else None
    return result, str(matched or fingerprint)


async def record_used_passkey_credentials(
    *,
    dom_service: Any,
    passkey_ref_by_credential_id: Dict[str, Dict[str, str]],
    recorded_credential_ids: set[str],
    agent_id: str,
    task_id: Optional[str],
    browser_url: str = "",
) -> int:
    """Persist references for passkeys whose authenticator counter advanced.

    This is intentionally safe to call after every browser observation. Amazon
    can invoke WebAuthn automatically, and approval-style tasks may return to
    the workflow before the browser agent reaches its completion branch.
    """
    if not task_id or not passkey_ref_by_credential_id:
        return 0

    try:
        used_credential_ids = await dom_service.get_used_passkey_credential_ids()
    except Exception as exc:
        logger.warning("Failed to read passkey usage", error=extract_error_message(exc))
        return 0

    recorded_count = 0
    for credential_id in used_credential_ids:
        if credential_id in recorded_credential_ids:
            continue
        credential_ref = passkey_ref_by_credential_id.get(credential_id)
        if not credential_ref:
            continue
        saved = await save_browser_credential_ref_message(
            agent_id=agent_id,
            task_id=task_id,
            message="Passkey used for authentication.",
            role="TOOL",
            tool_name="browser_session_auth",
            credential_ref=credential_ref,
            browser_url=browser_url,
        )
        if not saved:
            continue
        recorded_credential_ids.add(credential_id)
        recorded_count += 1

    return recorded_count


async def disconnect_browser_after_passkey_capture(
    dom_service: Any,
    capture_passkey_usage: Any,
) -> None:
    """Capture credential evidence before a terminal browser disconnect."""
    try:
        await capture_passkey_usage()
    finally:
        await dom_service.disconnect()


def _patch_cdp_use_websocket_proxy_default() -> None:
    """Force cdp-use CDP sockets to connect directly under websockets>=15.

    websockets 15 defaults client proxy discovery to proxy=True. cdp-use 1.4.5
    does not pass a proxy argument, so Steel CDP sockets can be misrouted
    through system proxy discovery and fail before browser-use can attach.
    Playwright validation uses a separate client and is unaffected.
    """
    try:
        import cdp_use.client as cdp_client
    except Exception as exc:
        logger.warning("Unable to patch cdp-use websocket proxy default", error=extract_error_message(exc))
        return

    connect = cdp_client.websockets.connect
    if getattr(connect, "_rose_direct_cdp_patch", False):
        return

    try:
        parameters = inspect.signature(connect).parameters
    except (TypeError, ValueError):
        parameters = {}

    supports_proxy = "proxy" in parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()
    )
    if not supports_proxy:
        return

    def connect_direct(*args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("proxy", None)
        return connect(*args, **kwargs)

    connect_direct._rose_direct_cdp_patch = True
    cdp_client.websockets.connect = connect_direct


_FALSE_ENV_VALUES = {"0", "false", "no", "off", "disabled"}
_BROWSER_REPLAY_TARGET_ATTRS = (
    "id",
    "name",
    "type",
    "role",
    "aria-label",
    "placeholder",
    "title",
    "href",
    "value",
)

_GENERIC_DISMISS_BUTTON_RE = re.compile(
    r"^\s*(accept only essential|allow essential|reject all|reject|decline|deny|"
    r"opt out( of all)?|close( banner)?|dismiss|got it|ok|okay|continue|"
    r"no thanks|not now|skip|x|×)\s*$",
    re.IGNORECASE,
)


def _env_enabled(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in _FALSE_ENV_VALUES


def _botsigged_diagnostics_enabled(start_url: str) -> bool:
    if not _env_enabled("BROWSER_AGENT_BOTSIGGED_DIAGNOSTICS", False):
        return False
    return "botsigged.com" in (start_url or "").lower()


_SENSITIVE_LOG_PARAM_KEY_RE = re.compile(
    r"(card|pan|cvv|cvc|password|passcode|otp|token|secret|auth|cookie|text)",
    re.IGNORECASE,
)


def _redact_browser_log_value(key: str, value: Any) -> Any:
    if _SENSITIVE_LOG_PARAM_KEY_RE.search(str(key)):
        return "<redacted>"
    if isinstance(value, (str, int, float, bool)) or value is None:
        text = str(value)
        return text[:180] + ("..." if len(text) > 180 else "")
    if isinstance(value, list):
        return f"<list len={len(value)}>"
    if isinstance(value, dict):
        return f"<dict keys={sorted(str(k) for k in value)[:20]}>"
    return f"<{type(value).__name__}>"


def _summarize_payment_request_for_log(payment_request: Any) -> Dict[str, Any]:
    if not isinstance(payment_request, dict):
        return {"payload_type": type(payment_request).__name__}

    line_items = payment_request.get("line_items")
    summary: Dict[str, Any] = {
        "merchant": _redact_browser_log_value("merchant", payment_request.get("merchant")),
        "subtotal_cents": payment_request.get("subtotal_cents"),
        "total_cents": payment_request.get("total_cents"),
        "currency": payment_request.get("currency"),
    }
    if isinstance(line_items, list):
        summary["line_items_count"] = len(line_items)
    elif line_items is not None:
        summary["line_items_type"] = type(line_items).__name__

    fingerprint = payment_request.get("fingerprint")
    if fingerprint:
        summary["fingerprint"] = _redact_browser_log_value("fingerprint", fingerprint)

    return {key: value for key, value in summary.items() if value is not None}


def _summarize_browser_action_for_log(action: Any) -> Dict[str, Any]:
    if not isinstance(action, dict):
        return {"payload_type": type(action).__name__}

    params = action.get("params")
    summary: Dict[str, Any] = {
        "action": action.get("action"),
        "has_index": action.get("index") is not None,
        "has_coordinates": action.get("coordinates") is not None,
    }
    if isinstance(params, dict):
        summary["param_keys"] = sorted(str(key) for key in params)
        summary["params"] = {
            str(key): _redact_browser_log_value(str(key), value)
            for key, value in params.items()
            if key in {"merchant", "subtotal_cents", "total_cents", "currency", "fingerprint"}
        }
        if "line_items" in params:
            line_items = params.get("line_items")
            summary["line_items_count"] = len(line_items) if isinstance(line_items, list) else None
            summary["line_items_type"] = type(line_items).__name__
    elif params is not None:
        summary["params_type"] = type(params).__name__

    return {key: value for key, value in summary.items() if value not in (None, {}, [])}


def _summarize_browser_action_history_entry(action_name: str, action: Any) -> str:
    return f"{action_name}: {json.dumps(_summarize_browser_action_for_log(action), sort_keys=True, default=str)[:500]}"


def _stable_target_text(value: Any, *, max_length: int = 500) -> str:
    return " ".join(str(value or "").split())[:max_length]


def _browser_element_signature(element: Any, *, index: Any = None) -> Dict[str, Any]:
    if not element:
        return {}
    attrs = getattr(element, "attributes", None) or {}
    if not isinstance(attrs, dict):
        attrs = {}
    tag = (getattr(element, "tag_name", None) or getattr(element, "node_name", "") or "").lower()
    text = ""
    try:
        text = element.get_all_children_text() or ""
    except Exception:
        text = getattr(element, "text_content", "") or ""
    signature: Dict[str, Any] = {
        "index": index,
        "tag": tag,
        "text": _stable_target_text(text),
        "description": get_element_description(element, max_length=120),
        "attrs": {
            key: _stable_target_text(attrs.get(key), max_length=240)
            for key in _BROWSER_REPLAY_TARGET_ATTRS
            if attrs.get(key) not in (None, "")
        },
    }
    return {key: value for key, value in signature.items() if value not in (None, "", {})}


def _browser_target_score(expected: Dict[str, Any], candidate: Dict[str, Any]) -> int:
    if not expected or not candidate:
        return 0
    score = 0
    if expected.get("tag") and candidate.get("tag"):
        score += 6 if expected["tag"] == candidate["tag"] else -8
    expected_attrs = expected.get("attrs") if isinstance(expected.get("attrs"), dict) else {}
    candidate_attrs = candidate.get("attrs") if isinstance(candidate.get("attrs"), dict) else {}
    for key, expected_value in expected_attrs.items():
        candidate_value = candidate_attrs.get(key)
        if not candidate_value:
            continue
        if candidate_value == expected_value:
            score += 80 if key in {"id", "name", "aria-label"} else 45
        elif expected_value in candidate_value or candidate_value in expected_value:
            score += 25
    expected_text = expected.get("text") or ""
    candidate_text = candidate.get("text") or ""
    if expected_text and candidate_text:
        if expected_text == candidate_text:
            score += 70
        elif expected_text in candidate_text or candidate_text in expected_text:
            score += 40
        else:
            expected_tokens = set(expected_text.lower().split())
            candidate_tokens = set(candidate_text.lower().split())
            if expected_tokens and candidate_tokens:
                overlap = len(expected_tokens & candidate_tokens) / max(len(expected_tokens), len(candidate_tokens))
                score += int(overlap * 35)
    if expected.get("description") and expected.get("description") == candidate.get("description"):
        score += 20
    return score


def _attach_browser_replay_target(llm_result: Dict[str, Any], dom_service: Any) -> Dict[str, Any]:
    action = llm_result.get("action") if isinstance(llm_result, dict) else None
    if not isinstance(action, dict):
        return llm_result
    index = action.get("index")
    if index is None:
        return llm_result
    element = getattr(dom_service, "selector_map", {}).get(index)
    if not element:
        return llm_result
    target = _browser_element_signature(element, index=index)
    if not target:
        return llm_result
    enriched = dict(llm_result)
    enriched["_fast_cache_browser_target"] = target
    return enriched


def _remap_cached_browser_action_target(
    unified_action: Dict[str, Any],
    *,
    cached_target: Optional[Dict[str, Any]],
    dom_service: Any,
) -> Dict[str, Any]:
    if not isinstance(unified_action, dict) or not cached_target:
        return unified_action
    action_index = unified_action.get("index")
    selector_map = getattr(dom_service, "selector_map", {}) or {}
    if action_index is not None and action_index in selector_map:
        current_signature = _browser_element_signature(selector_map[action_index], index=action_index)
        if _browser_target_score(cached_target, current_signature) >= 35:
            return unified_action

    best_index = None
    best_score = 0
    for candidate_index, element in selector_map.items():
        score = _browser_target_score(cached_target, _browser_element_signature(element, index=candidate_index))
        if score > best_score:
            best_index = candidate_index
            best_score = score

    if best_index is None or best_score < 35 or best_index == action_index:
        return unified_action

    remapped = dict(unified_action)
    remapped["index"] = best_index
    params = dict(remapped.get("params") or {})
    if "index" in params:
        params["index"] = best_index
        remapped["params"] = params
    logger.info(
        "fast_cache.browser_use_replay_target_remapped",
        old_index=action_index,
        new_index=best_index,
        score=best_score,
        target=cached_target.get("description") or cached_target.get("text"),
    )
    return remapped


async def _prepare_pending_write_lock_action(
    dom_service: Any,
    pending_action: Dict[str, Any],
    *,
    target_signature: Optional[Dict[str, Any]] = None,
) -> tuple[Dict[str, Any], Dict[str, Any], str]:
    """Rehydrate browser state before replaying the exact action a user approved."""
    browser_state = await dom_service.get_browser_state(include_screenshot=False)
    current_url = str(browser_state.get("url") or "")
    if not current_url:
        raise RuntimeError("Cannot execute an approved browser action without a resumed page URL")
    action = _remap_cached_browser_action_target(
        pending_action,
        cached_target=target_signature,
        dom_service=dom_service,
    )
    return action, browser_state, current_url


def _browser_ground_truth_checkpoint(
    browser_state: Dict[str, Any],
    current_url: str,
    *,
    kind: str = "pre_write",
) -> Optional[Dict[str, str]]:
    """Keep a browser-extracted DOM snapshot across an approval activity boundary."""
    dom_tree = str(browser_state.get("dom_tree") or "")
    if not dom_tree:
        return None
    return {
        "url": str(browser_state.get("url") or current_url or ""),
        "title": str(browser_state.get("title") or ""),
        "dom_tree": dom_tree,
        "kind": kind,
    }


def _append_bounded_verifier_checkpoint(
    verifier_checkpoints: List[Dict[str, Any]],
    checkpoint: Optional[Dict[str, Any]],
) -> bool:
    """Append distinct browser ground truth while enforcing the verifier payload cap."""
    if not checkpoint:
        return False
    appended = not verifier_checkpoints or checkpoint != verifier_checkpoints[-1]
    if appended:
        verifier_checkpoints.append(checkpoint)
    verifier_checkpoints[:] = verifier_checkpoints[-3:]
    return appended



def _browser_resume_continuity_state(
    *,
    action_history: Any,
    visited_urls: List[str],
    verifier_checkpoints: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Serialize compact, browser-sourced continuity for a resumed activity."""
    return {
        "action_history": action_history.get_entries()[-30:],
        "visited_urls": list(visited_urls[-30:]),
        "verifier_checkpoints": list(verifier_checkpoints[-3:]),
    }


def _resume_context_from_session_info(
    session_info: Dict[str, Any], current_auth_realm: str
) -> tuple[Dict[str, Any], str]:
    user_profile = session_info.get("user_settings") or {}
    if session_info.get("auth_realm"):
        return user_profile, session_info["auth_realm"]
    return user_profile, current_auth_realm or auth_realm_from_url(
        session_info.get("current_url") or session_info.get("saved_url") or session_info.get("start_url") or ""
    )


async def _install_botsigged_diagnostics(page: Any, *, agent_id: str, task_id: str) -> None:
    """Capture BotSigged SDK score events for benchmark attribution."""
    script = """
    () => {
      window.__roseBotSiggedScores = [];
      window.addEventListener("botsigged:score", (event) => {
        window.__roseBotSiggedScores.push({
          t: Math.round(performance.now()),
          detail: event.detail,
        });
      });
    }
    """
    await page.add_init_script(script)
    logger.info(
        "BotSigged diagnostics init script installed",
        agent_id=agent_id,
        task_id=task_id,
    )


async def _capture_botsigged_diagnostics(
    page: Any,
    *,
    agent_id: str,
    task_id: Optional[str],
    checkpoint: str = "final",
) -> Optional[Dict[str, Any]]:
    if not task_id:
        return None
    diagnostics = await page.evaluate(
        """
        (checkpoint) => {
          const instance = window.BotSiggedInstance || window.botSiggedInstance || null;
          const safeCall = (name) => {
            try {
              if (instance && typeof instance[name] === "function") return instance[name]();
            } catch (error) {
              return { error: String(error && error.message ? error.message : error) };
            }
            return null;
          };
          const currentSignals = safeCall("getCurrentSignals");
          const count = (items) => Array.isArray(items) ? items.length : 0;
          return {
            checkpoint,
            url: location.href,
            title: document.title,
            capturedScoreEvents: (window.__roseBotSiggedScores || []).slice(-50),
            lastScore: safeCall("getLastScore"),
            currentSignals,
            bufferSizes: safeCall("getBufferSizes"),
            signalCounts: currentSignals ? {
              mouseEvents: count(currentSignals.mouse && currentSignals.mouse.events),
              scrollEvents: count(currentSignals.scroll && currentSignals.scroll.events),
              formKeys: count(currentSignals.form && currentSignals.form.keys),
              formInputs: count(currentSignals.form && currentSignals.form.inputs),
              formSubmits: currentSignals.form && currentSignals.form.submits || 0,
            } : null,
            visibleTextSample: (document.body && document.body.innerText || "").slice(0, 4000),
          };
        }
        """,
        checkpoint,
    )
    output_dir = browser_recording_output_dir(agent_id, task_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    diagnostics_path = output_dir / "botsigged-diagnostics.json"
    diagnostics_path.write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
    last_score = diagnostics.get("lastScore") or {}
    logger.info(
        "BotSigged diagnostics captured",
        agent_id=agent_id,
        task_id=task_id,
        diagnostics_path=str(diagnostics_path),
        bot_score=last_score.get("bot_score"),
        classification=last_score.get("classification"),
        triggered_rules=last_score.get("triggered_rules"),
        signal_counts=diagnostics.get("signalCounts"),
    )
    return {"path": str(diagnostics_path), "diagnostics": diagnostics}


class BrowserCursorRealtimeStreamer:
    """Throttled fire-and-forget cursor mirror for the live React overlay."""

    def __init__(self, *, agent_id: str, task_id: str, fps: float = 30.0) -> None:
        self.agent_id = agent_id
        self.task_id = task_id
        self.min_interval_s = 1.0 / fps
        self.latest: Optional[tuple[int, int, int]] = None
        self.sequence = 0
        self.last_sent_at = 0.0
        self.flush_task: Optional[asyncio.Task[None]] = None
        self.closed = False

    def set_cursor(self, x: int, y: int) -> None:
        if self.closed:
            return
        self.latest = (int(x), int(y), int(time.time() * 1000))
        if self.flush_task is None or self.flush_task.done():
            self.flush_task = asyncio.create_task(self._flush_loop())

    async def close(self) -> None:
        self.closed = True
        if self.flush_task is not None and not self.flush_task.done():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.flush_task, timeout=1.0)

    async def _flush_loop(self) -> None:
        while not self.closed:
            wait_s = self.last_sent_at + self.min_interval_s - time.monotonic()
            if wait_s > 0:
                await asyncio.sleep(wait_s)

            sample = self.latest
            self.latest = None
            if sample is None:
                return

            x, y, timestamp_ms = sample
            self.sequence += 1
            await stream_browser_cursor(
                agent_id=self.agent_id,
                task_id=self.task_id,
                x=x,
                y=y,
                sequence=self.sequence,
                timestamp_ms=timestamp_ms,
            )
            self.last_sent_at = time.monotonic()

            if self.latest is None:
                return


async def _propagate_browser_credentials_with_progress(
    *,
    config: Any,
    agent_id: str,
    task_id: Optional[str],
    browser_url: str,
    status: str,
    success: bool,
    message: str,
) -> Optional[Dict[str, Any]]:
    if not task_id:
        return None

    is_auth_assistance_pause = status == "awaiting_auth_assistance"
    progress_message = (
        "Updating saved credential state before waiting for user authentication assistance."
        if is_auth_assistance_pause
        else "Classifying browser authentication outcome and applying credential updates."
    )
    tool_call_id = str(uuid_module.uuid4())
    await save_browser_action_message(
        agent_id=agent_id,
        title="Updating credential state",
        task_id=task_id,
        message=progress_message,
        status=MessageStatus.IN_PROGRESS,
        browser_url=browser_url,
        action_type="credential_propagation",
        tool_call_id=tool_call_id,
    )

    try:
        result = await propagate_browser_run_credentials(
            config,
            agent_id=agent_id,
            task_id=task_id,
            status=status,
            success=success,
            message=message,
        )
    except Exception as e:
        error_message = extract_error_message(e)
        await save_browser_action_message(
            agent_id=agent_id,
            title="Credential state update failed",
            task_id=task_id,
            message=error_message,
            status=MessageStatus.ERROR,
            browser_url=browser_url,
            action_type="credential_propagation",
            tool_call_id=tool_call_id,
        )
        raise

    outcome = result.get("outcome", "unknown")
    refs = result.get("refs", 0)
    applied = result.get("applied", 0)
    await save_browser_action_message(
        agent_id=agent_id,
        title="Credential state updated",
        task_id=task_id,
        message=f"Outcome: {outcome}. Credential refs: {refs}. Updates applied: {applied}.",
        status=MessageStatus.FINISHED,
        browser_url=browser_url,
        action_type="credential_propagation",
        tool_call_id=tool_call_id,
        extra_metadata={
            "credentialPropagationOutcome": outcome,
            "credentialRefs": refs,
            "credentialUpdatesApplied": applied,
        },
    )
    return result


_ROSE_LOGO_DATA_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIxIDYyIDIyMCAyMjIiIHdpZHRoPSIyMjAiIGhlaWdodD0iMjIyIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDMwMykgc2NhbGUoMC4xLC0wLjEpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0xMjc2IDIzNzggYy0xNDUgLTE5MiAtMjMxIC00NDIgLTIxMSAtNjE2IDggLTY4IDQxIC0yMDIgNjEgLTI1MSA4IC0xOSAxMyAtMzUgMTEgLTM3IC0yIC0yIC0zMCA3IC02MiAyMSAtMjQ5IDEwMCAtNTM3IDU0IC03ODQgLTEyNCAtMzYgLTI1IC02OSAtNDkgLTc1IC01MyAtMTcgLTExIDIyIC00NiAxMTkgLTEwNSAxNjMgLTEwMSAzMDAgLTE0NCA0NjAgLTE0NCA5MiAtMSAyMjYgMjQgMzAxIDU2IDIwIDggMzggMTUgMzkgMTUgMiAwIC0xMCAtMzkgLTI1IC04NyAtNjkgLTIxMyAtNTggLTM5NSAzNiAtNjAwIDMxIC02OSAxMzYgLTIzNyAxNTQgLTI0OCAxMCAtNiAxMTQgMTQ0IDE1MiAyMjAgMzcgNzMgNzUgMTk5IDg4IDI5MyAxNCAxMDEgMSAyMDYgLTQwIDMzMCAtMTUgNDggLTI3IDg4IC0yNiA4OSAxIDIgMjYgLTcgNTUgLTE4IDE5NSAtNzQgNDIzIC02NiA2MTEgMjIgOTggNDYgMjE3IDExOCAyNDUgMTQ5IDE4IDIwIDE4IDIxIC0xIDM1IC0xNzcgMTM5IC0zOTYgMjI1IC01NzAgMjI1IC03OSAwIC0xOTUgLTIzIC0yODIgLTU2IC00NCAtMTYgLTYzIC0yMCAtNTkgLTExIDI3IDcyIDYwIDE5NiA2OCAyNjAgMTcgMTMyIC0xNyAzMDAgLTg5IDQ0MiAtMzYgNzIgLTEyNCAyMDkgLTE0MSAyMTkgLTUgNCAtMjEgLTggLTM1IC0yNnogbTQwIC05MzUgYzcgLTQ2IDUwIC05MiAxMDkgLTExOSAyNyAtMTMgNDEgLTIzIDMxIC0yMyAtMTEgLTEgLTM4IC0xMiAtNjIgLTI2IC00OSAtMjkgLTgzIC05MCAtODUgLTE1MSAtMSAtMzcgLTIgLTM2IC05IDEzIC00IDI5IC0xNyA2NyAtMjggODUgLTIyIDM1IC04NiA3NyAtMTE4IDc5IC0xMSAwIDEgOSAyNiAyMCA3OSAzNSAxMTggOTAgMTIxIDE2OCAxIDI1IDMgMjggNiAxMSAyIC0xNCA2IC0zOSA5IC01N3oiLz4KICA8L2c+Cjwvc3ZnPg=="


async def _apply_logo_hijack(dom_service: Any) -> None:
    """Replace browser-use logos with the Rose logo on new documents + existing pages."""
    try:
        logo_hijack_script = f"""
            (() => {{
                const ROSE_LOGO_URL = '{_ROSE_LOGO_DATA_URL}';

                if (window.__roseSrcHijacked) return;
                window.__roseSrcHijacked = true;

                const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

                Object.defineProperty(HTMLImageElement.prototype, 'src', {{
                    get: function() {{
                        return originalDescriptor.get.call(this);
                    }},
                    set: function(value) {{
                        if (value && typeof value === 'string' && value.includes('browser-use.com')) {{
                            value = ROSE_LOGO_URL;
                            this.alt = 'Rose';
                        }}
                        return originalDescriptor.set.call(this, value);
                    }},
                    enumerable: originalDescriptor.enumerable,
                    configurable: originalDescriptor.configurable
                }});

                const originalSetAttribute = Element.prototype.setAttribute;
                Element.prototype.setAttribute = function(name, value) {{
                    if (this instanceof HTMLImageElement && name === 'src' &&
                        value && typeof value === 'string' && value.includes('browser-use.com')) {{
                        value = ROSE_LOGO_URL;
                        this.alt = 'Rose';
                    }}
                    return originalSetAttribute.call(this, name, value);
                }};
            }})();
        """
        logo_cdp_session = await dom_service._session.get_or_create_cdp_session(focus=True)
        await logo_cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
            params={"source": logo_hijack_script, "runImmediately": True},
            session_id=logo_cdp_session.session_id,
        )

        immediate_replace_script = f"""
            (() => {{
                const ROSE_LOGO_URL = '{_ROSE_LOGO_DATA_URL}';

                document.querySelectorAll('img').forEach(img => {{
                    if (img.src && img.src.includes('browser-use.com')) {{
                        img.src = ROSE_LOGO_URL;
                        img.alt = 'Rose';
                    }}
                }});
            }})();
        """
        try:
            page_targets = await dom_service._session._cdp_get_all_pages()
            for target in page_targets:
                try:
                    target_id = target.get("targetId")
                    if target_id:
                        temp_session = await dom_service._session.get_or_create_cdp_session(target_id, focus=False)
                        await temp_session.cdp_client.send.Runtime.evaluate(
                            params={"expression": immediate_replace_script},
                            session_id=temp_session.session_id,
                        )
                except Exception:
                    pass
        except Exception as e:
            logger.debug(f"Could not replace logos on existing pages: {e}")

        logger.info("\U0001f3a8 Hijacked img.src to replace browser-use logo with Rose logo")
    except Exception as e:
        logger.warning(f"Failed to replace logo: {e}")


async def _wait_for_document_ready(
    dom_service: Any, *, timeout_s: float = 8.0, interactive_grace_s: float = 2.0
) -> str:
    """Poll document.readyState via CDP until the page is usable.

    browser-use's NavigateToUrlEvent readiness wait matches lifecycle events by
    loaderId, which frequently misses the real load event and burns its full
    timeout before proceeding anyway. Navigating with wait_until="commit" and
    polling readyState directly detects readiness reliably and returns as soon
    as the document is complete (or interactive after a short grace period).
    Returns the final readyState observed ("unknown" if polling itself failed).
    """
    start = time.monotonic()
    last_state = "unknown"
    while (time.monotonic() - start) < timeout_s:
        try:
            cdp_session = await dom_service._session.get_or_create_cdp_session(focus=True)
            result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": "document.readyState", "returnByValue": True},
                session_id=cdp_session.session_id,
            )
            last_state = (result.get("result") or {}).get("value") or last_state
        except Exception as poll_err:
            logger.debug(f"readyState poll failed: {poll_err}")
        if last_state == "complete":
            return last_state
        if last_state == "interactive" and (time.monotonic() - start) >= interactive_grace_s:
            return last_state
        await asyncio.sleep(0.2)
    logger.warning(
        "Document readiness poll timed out",
        timeout_s=timeout_s,
        last_state=last_state,
    )
    return last_state


async def _stop_playwright_resources(
    playwright_browser: Optional[Any],
    playwright_instance: Optional[Any],
    agent_id: str,
    close_browser: bool = True,
    driver_pid: Optional[int] = None,
) -> None:
    """Disconnect Playwright's CDP client and stop its local driver process."""
    driver_process = _playwright_driver_process(playwright_instance)
    driver_pid = driver_pid or getattr(driver_process, "pid", None)

    if playwright_browser and close_browser:
        try:
            await asyncio.wait_for(playwright_browser.close(), timeout=5.0)
            logger.info("Playwright browser CDP connection closed", agent_id=agent_id)
        except Exception as e:
            logger.warning(
                "Failed to close Playwright browser CDP connection",
                agent_id=agent_id,
                error=str(e),
            )

    if playwright_instance:
        try:
            await asyncio.wait_for(playwright_instance.stop(), timeout=5.0)
            logger.info("Playwright instance stopped", agent_id=agent_id)
        except Exception as e:
            logger.warning("Failed to stop Playwright instance", agent_id=agent_id, error=str(e))
        await _reap_playwright_driver_process(driver_process, agent_id)
    await _reap_playwright_driver_pid(driver_pid, agent_id)


def _playwright_driver_process(playwright_instance: Optional[Any]) -> Optional[Any]:
    if not playwright_instance:
        return None
    impl_obj = getattr(playwright_instance, "_impl_obj", None)
    connection = getattr(impl_obj, "_connection", None)
    transport = getattr(connection, "_transport", None)
    process = getattr(transport, "_proc", None)
    pid = getattr(process, "pid", None)
    return process if isinstance(pid, int) else None


async def _reap_playwright_driver_process(process: Optional[Any], agent_id: str) -> None:
    if not process or getattr(process, "returncode", None) is not None:
        return

    try:
        await asyncio.wait_for(process.wait(), timeout=2)
        return
    except asyncio.TimeoutError:
        pass
    except Exception as e:
        logger.debug("Failed while waiting for Playwright driver exit", agent_id=agent_id, error=str(e))

    if getattr(process, "returncode", None) is not None:
        return

    try:
        process.terminate()
        await asyncio.wait_for(process.wait(), timeout=2)
        logger.warning("Terminated lingering Playwright driver process", agent_id=agent_id, pid=process.pid)
        return
    except asyncio.TimeoutError:
        pass
    except ProcessLookupError:
        return
    except Exception as e:
        logger.warning("Failed to terminate Playwright driver process", agent_id=agent_id, error=str(e))

    if getattr(process, "returncode", None) is not None:
        return

    try:
        process.kill()
        await asyncio.wait_for(process.wait(), timeout=2)
        logger.warning("Killed lingering Playwright driver process", agent_id=agent_id, pid=process.pid)
    except ProcessLookupError:
        return
    except Exception as e:
        logger.warning("Failed to kill Playwright driver process", agent_id=agent_id, error=str(e))


class BrowserStorageCaptureTimeoutError(RuntimeError):
    """Raised when auth-preserving browser storage capture exceeds its hard bound."""


def _rotation_storage_capture_timeout_seconds(raw_timeout: Any) -> float:
    try:
        timeout_seconds = float(raw_timeout)
    except (TypeError, ValueError):
        return 15.0
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        return 15.0
    return min(timeout_seconds, 60.0)


async def _capture_rotation_storage_state(page: Optional[Any]) -> Optional[Dict[str, Any]]:
    """Capture browser auth/storage before rotate_ip replaces the remote browser.

    Kernel profile persistence handles Kernel-to-Kernel rotations, but profiles
    are provider-specific. Capturing Playwright storage here lets the later
    Kernel-to-Steel recovery retain the same cookies, localStorage, and IndexedDB.
    """
    if page is None or getattr(page, "context", None) is None:
        return None
    timeout_seconds = _rotation_storage_capture_timeout_seconds(
        os.getenv("BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS", "15")
    )
    try:
        return await asyncio.wait_for(
            page.context.storage_state(indexed_db=True),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "Timed out capturing browser storage before IP rotation",
            timeout_seconds=timeout_seconds,
            capture_scope="cookies_localstorage_indexeddb",
        )
        raise BrowserStorageCaptureTimeoutError(
            f"Browser storage capture timed out after {timeout_seconds:g}s before challenge recovery."
        )
    except Exception as exc:
        logger.warning("Failed to capture browser storage before IP rotation", error=str(exc))
        return None


def _rotation_storage_restore_script(storage_state: Dict[str, Any]) -> str:
    """Return an init script that restores origin-scoped browser storage."""
    origins_json = json.dumps(storage_state.get("origins") or [], separators=(",", ":"))
    return f"""
(() => {{
  const originStates = {origins_json};
  const completionKey = "__naviRotationStorageRestoredV1";
  let restorePromise;
  const restoreCurrentOrigin = async () => {{
    const state = originStates.find((entry) => entry.origin === location.origin);
    if (!state) return;
    try {{
      if (sessionStorage.getItem(completionKey) === "1") return;
    }} catch {{
      // Some origins disable sessionStorage. The per-document promise below
      // still prevents the init script and explicit restore from racing.
    }}
    localStorage.clear();
    for (const item of state.localStorage || []) localStorage.setItem(item.name, item.value);
    for (const database of state.indexedDB || []) {{
      await new Promise((resolve, reject) => {{
        const request = indexedDB.open(database.name, database.version);
        request.onupgradeneeded = () => {{
          const db = request.result;
          for (const store of database.stores || []) {{
            if (!db.objectStoreNames.contains(store.name)) {{
              db.createObjectStore(store.name, {{
                keyPath: store.keyPath === undefined ? null : store.keyPath,
                autoIncrement: Boolean(store.autoIncrement),
              }});
            }}
          }}
        }};
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {{
          const db = request.result;
          const storeNames = (database.stores || [])
            .map((store) => store.name)
            .filter((name) => db.objectStoreNames.contains(name));
          if (storeNames.length === 0) {{ db.close(); resolve(); return; }}
          const transaction = db.transaction(storeNames, "readwrite");
          for (const storeState of database.stores || []) {{
            if (!storeNames.includes(storeState.name)) continue;
            const store = transaction.objectStore(storeState.name);
            store.clear();
            for (const record of storeState.records || []) {{
              // IndexedDB rejects an explicit key for stores that derive it from
              // an inline keyPath. Playwright includes each record's resolved key
              // in storage_state, so only pass that key for out-of-line stores.
              if (store.keyPath === null && Object.prototype.hasOwnProperty.call(record, "key")) {{
                store.put(record.value, record.key);
              }} else {{
                store.put(record.value);
              }}
            }}
          }}
          transaction.oncomplete = () => {{ db.close(); resolve(); }};
          transaction.onerror = () => {{ db.close(); reject(transaction.error); }};
          transaction.onabort = () => {{ db.close(); reject(transaction.error); }};
        }};
      }});
    }}
    try {{ sessionStorage.setItem(completionKey, "1"); }} catch {{}}
  }};
  globalThis.__naviRestoreRotationStorage = () => {{
    restorePromise ||= restoreCurrentOrigin();
    return restorePromise;
  }};
  void globalThis.__naviRestoreRotationStorage().catch(() => undefined);
}})();
"""


async def _restore_rotation_storage_state(
    page: Optional[Any],
    storage_state: Optional[Dict[str, Any]],
    *,
    current_url: str,
    restore_cookies: bool = True,
) -> None:
    """Restore captured auth/storage into a replacement provider session.

    When ``restore_cookies`` is False (challenge-recovery preloaded winner), the
    remote default context already holds probe/solver cookies. Skip a same-host
    re-navigation that would re-trigger Cloudflare WAF on a clean candidate, and
    use the probe's 45s navigation budget when a goto is still required.
    """
    if page is None or not storage_state or getattr(page, "context", None) is None:
        return

    context = page.context
    cookies = storage_state.get("cookies") or []
    if restore_cookies and cookies:
        await context.add_cookies(cookies)

    origins = storage_state.get("origins") or []
    if origins:
        await context.add_init_script(script=_rotation_storage_restore_script(storage_state))

    should_navigate = bool(current_url)
    if should_navigate and not restore_cookies:
        try:
            from urllib.parse import urlparse

            live_host = (urlparse(str(getattr(page, "url", "") or "")).hostname or "").lower()
            target_host = (urlparse(current_url).hostname or "").lower()
            if live_host and target_host and live_host == target_host:
                should_navigate = False
        except Exception:
            should_navigate = True
    if should_navigate:
        navigation_timeout_ms = 45_000 if not restore_cookies else 15_000
        await page.goto(current_url, wait_until="domcontentloaded", timeout=navigation_timeout_ms)

    if origins:
        await page.evaluate(
            "async () => { if (globalThis.__naviRestoreRotationStorage) "
            "await globalThis.__naviRestoreRotationStorage(); }"
        )


def _updated_rotation_session_metadata(
    current: Optional[Dict[str, Any]], rotate_result: Dict[str, Any]
) -> Dict[str, Any]:
    """Merge the backend's replacement-session metadata into run state."""
    updated = dict(current or {})
    replacement = rotate_result.get("browser_session_metadata")
    if isinstance(replacement, dict):
        updated.update(replacement)
    return updated


async def _reconnect_browser_stack_after_rotation(
    *,
    new_cdp_url: str,
    old_dom_service: Any,
    old_playwright_browser: Optional[Any],
    old_playwright_instance: Optional[Any],
    old_driver_pid: Optional[int],
    fingerprint_injection: Optional[Any],
    agent_id: str,
) -> Dict[str, Any]:
    """Tear down the current CDP/Playwright stack and reattach to `new_cdp_url`.

    Backs the rotate_ip tool: the backend recreates the browser session on a fresh
    proxy (same persistent profile → cookies/login survive) and returns a new
    ws_url; the agent must drop its live connection and reconnect to it. Fingerprint
    injection is re-applied so the rotated IP does not pair with a fresh device
    fingerprint. Returns the new dom_service/pages/playwright handles + driver pid.
    """
    from browser_tools.dom_service import DOMService

    # 1. Tear down the old connection first so the previous Kernel session's CDP
    #    sockets + local Playwright driver are released before we attach anew.
    with contextlib.suppress(Exception):
        await old_dom_service.disconnect()
    await _stop_playwright_resources(
        old_playwright_browser,
        old_playwright_instance,
        agent_id,
        driver_pid=old_driver_pid,
    )

    # 2. Attach DOMService + Playwright to the rotated session.
    _disable_cdp_websocket_proxy()
    connection_cdp_url = steel_cdp_connection_url(new_cdp_url)
    dom_service = DOMService(cdp_url=connection_cdp_url)
    pw_instance = None
    pw_browser = None
    driver_pid = None
    try:
        await dom_service.connect()
        dom_page = await dom_service.session.get_current_page()

        from playwright.async_api import async_playwright

        pw_instance = await async_playwright().start()
        driver_pid = getattr(_playwright_driver_process(pw_instance), "pid", None)
        pw_browser = await pw_instance.chromium.connect_over_cdp(connection_cdp_url)
        pw_context = pw_browser.contexts[0]
        pw_page = await _synchronize_playwright_page_with_agent_focus(
            dom_service=dom_service,
            playwright_browser=pw_browser,
            current_page=pw_context.pages[0],
        )

        # 3. Re-apply the device fingerprint (anti-bot essential on the new IP).
        if fingerprint_injection and _env_enabled("BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED", True):
            from helpers.fingerprint_injection import apply_fingerprint_injection

            with contextlib.suppress(Exception):
                await apply_fingerprint_injection(pw_page, fingerprint_injection)
    except BaseException:
        # Best-effort, like the disconnect below. Unsuppressed, a failure here
        # replaces the original attach error (so the caller never learns why the
        # reconnect failed) AND skips the disconnect, leaking the CDP
        # connection. `Exception` rather than `BaseException` so cancellation
        # still propagates.
        with contextlib.suppress(Exception):
            await _stop_playwright_resources(
                pw_browser,
                pw_instance,
                agent_id,
                close_browser=False,
                driver_pid=driver_pid,
            )
        with contextlib.suppress(Exception):
            await dom_service.disconnect()
        raise

    logger.info("Reconnected browser stack after proxy rotation", agent_id=agent_id)
    return {
        "dom_service": dom_service,
        "dom_page": dom_page,
        "input_page": pw_page,
        "playwright_browser": pw_browser,
        "playwright_instance": pw_instance,
        "playwright_driver_pid": driver_pid,
    }


async def _restart_after_failed_steel_auth(
    *,
    config: Any,
    user_id: str,
    task_id: str,
    credential_ref: Dict[str, Any],
) -> Dict[str, Any]:
    """Invalidate one proven-signed-out Steel profile and recreate the task.

    Recreating the provider session is the source-isolation boundary: the new
    session is initialized after the stale marker is disabled, so normal
    credential selection can choose a CookieBundle without overlaying it onto
    the failed Steel profile.
    """
    credential_id = str(credential_ref.get("id") or "")
    if credential_ref.get("kind") != "steel_session" or not credential_id:
        raise ValueError("A concrete Steel session credential is required for auth restart")
    reason = "All automated authentication options were exhausted and the site remained signed out."
    await mark_steel_session_auth_failed(
        config,
        user_id,
        credential_id,
        reason,
        preserve_browser_session_id=task_id,
    )
    replacement = await resume_browser_session(
        config,
        task_id,
        force_fresh_profile=True,
    )
    new_cdp_url = replacement.get("ws_url")
    if not isinstance(new_cdp_url, str) or not new_cdp_url:
        raise RuntimeError("Replacement browser session did not return a CDP URL")
    replacement_ref = replacement.get("credential_ref") or replacement.get("auth_credential_ref")
    if (
        isinstance(replacement_ref, dict)
        and replacement_ref.get("kind") == "steel_session"
        and str(replacement_ref.get("id") or "") == credential_id
    ):
        raise RuntimeError("Replacement browser session reused the Steel credential proven signed out")
    return replacement


async def _discard_replacement_browser_stack(
    *,
    humanizer: Optional[Any],
    dom_service: Optional[Any],
    playwright_browser: Optional[Any],
    playwright_instance: Optional[Any],
    playwright_driver_pid: Optional[int],
    agent_id: str,
) -> None:
    """Disconnect a replacement CDP stack without closing its remote session."""
    if humanizer is not None:
        with contextlib.suppress(Exception):
            await humanizer.close()
    if dom_service is not None:
        with contextlib.suppress(Exception):
            await dom_service.disconnect()
    await _stop_playwright_resources(
        playwright_browser,
        playwright_instance,
        agent_id,
        close_browser=False,
        driver_pid=playwright_driver_pid,
    )


async def _synchronize_playwright_page_with_agent_focus(
    *,
    dom_service: Any,
    playwright_browser: Any,
    current_page: Any,
) -> Any:
    """Make Playwright input and the provider live view follow browser-use focus.

    browser-use tracks tabs by CDP target id, while Playwright was historically
    pinned to ``context.pages[0]``. After a switch_tab that split meant the DOM
    observer could see tab B while humanized input and the provider live view
    remained on tab A. Resolve the shared CDP target and explicitly foreground
    it; fall back to the current page if a provider cannot expose target info.
    """
    session = getattr(dom_service, "session", None)
    focused_target_id = getattr(session, "agent_focus_target_id", None)
    contexts = getattr(playwright_browser, "contexts", None) or []
    if not focused_target_id or not contexts:
        return current_page

    pages = getattr(contexts[0], "pages", None) or []
    for page in pages:
        cdp_session = None
        try:
            cdp_session = await contexts[0].new_cdp_session(page)
            target_info = await cdp_session.send("Target.getTargetInfo")
            target_id = target_info.get("targetInfo", {}).get("targetId")
            if target_id != focused_target_id:
                continue
            await page.bring_to_front()
            return page
        except Exception as exc:
            logger.debug(
                "Unable to compare Playwright page with browser-use focus",
                error=str(exc),
            )
        finally:
            if cdp_session is not None:
                with contextlib.suppress(Exception):
                    await cdp_session.detach()

    return current_page


async def _rebind_browser_tab_runtime(
    *,
    dom_service: Any,
    dom_page: Any,
    playwright_browser: Any,
    current_page: Any,
    humanizer: Any,
    browser_recorder: Any,
    cursor_observer: Any,
    humanizer_factory: Any = None,
) -> Tuple[Any, Any]:
    """Atomically move live view, recorder, and synthesized input to agent focus."""
    focused_page = await _synchronize_playwright_page_with_agent_focus(
        dom_service=dom_service,
        playwright_browser=playwright_browser,
        current_page=current_page,
    )
    if focused_page is current_page:
        return current_page, humanizer
    if browser_recorder is not None:
        browser_recorder.page = focused_page
    if humanizer is not None:
        await humanizer.close()
    factory = humanizer_factory
    if factory is None:
        from browser_tools.humanizer import BrowserHumanizer

        factory = BrowserHumanizer
    rebound_humanizer = factory(dom_page=dom_page, input_page=focused_page, fast=False)
    await rebound_humanizer.initialize_cursor(start_pos=(640, 400))
    rebound_humanizer.set_cursor_observer(cursor_observer)
    return focused_page, rebound_humanizer


async def _replace_browser_humanizer(
    *,
    current_humanizer: Any,
    enabled: bool,
    dom_page: Any,
    input_page: Any,
    cursor_observer: Any,
    humanizer_factory: Any,
) -> Any:
    """Rebind synthesized input after a provider handoff without leaking idle work."""
    if current_humanizer is not None:
        with contextlib.suppress(Exception):
            await current_humanizer.close()
    if not enabled:
        return None
    rebound_humanizer = humanizer_factory(dom_page=dom_page, input_page=input_page, fast=False)
    await rebound_humanizer.initialize_cursor(start_pos=(640, 400))
    rebound_humanizer.set_cursor_observer(cursor_observer)
    rebound_humanizer.start_idle_movement()
    return rebound_humanizer


async def _wait_for_browser_user_control(config: Any, task_id: str) -> bool:
    """Yield browser ownership until the user explicitly hands it back.

    Returns whether ownership changed, allowing callers to discard any DOM
    snapshot or LLM action computed before the user interaction.
    """
    try:
        state = await fetch_browser_control_state(config, task_id)
    except Exception as exc:
        logger.warning("Unable to read browser control state; keeping agent ownership", error=str(exc))
        return False
    yielded = False
    while state in {"requested", "user"}:
        if state == "requested":
            try:
                state = await acknowledge_browser_user_control(config, task_id)
            except Exception as exc:
                logger.warning("Unable to acknowledge browser user control", error=str(exc))
        if state == "user":
            yielded = True
        activity.heartbeat("Waiting for user to hand browser control back")
        await asyncio.sleep(0.5)
        try:
            state = await fetch_browser_control_state(config, task_id)
        except Exception as exc:
            logger.warning("Unable to refresh browser control state; continuing to yield", error=str(exc))
    return yielded


def _browser_action_tool_call_id(llm_result: Dict[str, Any]) -> str:
    """Return the one streamed tool-call id used for an action's full lifecycle."""
    return str(llm_result.get("tool_call_id") or uuid_module.uuid4())


async def _wait_for_provider_captcha_solver(
    config: Any,
    task_id: str,
    *,
    page: Optional[Any] = None,
) -> None:
    """Give provider-native auto-solving the first chance before recovery probes.

    Kernel telemetry sets ``isSolving`` to null (terminal outcomes only). When the
    live tab still looks challenged, keep waiting up to the 45s ceiling instead of
    treating three null polls as "solver done".
    """
    deadline = asyncio.get_running_loop().time() + 45
    saw_active_solver = False
    inactive_polls = 0
    while asyncio.get_running_loop().time() < deadline:
        activity.heartbeat("Waiting for provider CAPTCHA auto-solver")
        page_still_challenged = False
        if page is not None:
            try:
                snapshot = await asyncio.wait_for(
                    asyncio.gather(
                        page.title(),
                        page.locator("body").inner_text(timeout=2_000),
                        page.content(),
                        return_exceptions=True,
                    ),
                    timeout=15,
                )
                if asyncio.get_running_loop().time() >= deadline:
                    return
                title = snapshot[0] if isinstance(snapshot[0], str) else ""
                body_text = snapshot[1] if isinstance(snapshot[1], str) else ""
                html = snapshot[2] if isinstance(snapshot[2], str) else ""
                page_still_challenged = page_looks_challenged(
                    status=None,
                    title=title[:1_000],
                    body_text=body_text[:20_000],
                    html=html[:100_000],
                )
            except Exception:
                page_still_challenged = False
                if asyncio.get_running_loop().time() >= deadline:
                    return
        try:
            telemetry = await fetch_browser_captcha_telemetry(config, task_id)
        except Exception as exc:
            logger.warning("CAPTCHA telemetry unavailable during challenge recovery", error=str(exc))
            if page_still_challenged:
                await asyncio.sleep(2)
                continue
            await asyncio.sleep(2)
            return
        is_solving = telemetry.get("isSolving")
        if is_solving is True:
            saw_active_solver = True
            inactive_polls = 0
        elif saw_active_solver and not page_still_challenged:
            return
        elif page_still_challenged:
            # Hard WAF / Kernel-null telemetry: wait out the solver window on the
            # live challenged page instead of exiting after three idle polls.
            inactive_polls = 0
        else:
            inactive_polls += 1
            # Steel can take a moment to register a new task. When the page is not
            # challenged, three grace polls are enough for the solver-first wait.
            if inactive_polls >= 3:
                return
        await asyncio.sleep(2)


def _playwright_driver_command_matches(command: str) -> bool:
    return "playwright/driver" in command and "run-driver" in command


async def _reap_playwright_driver_pid(pid: Optional[int], agent_id: str) -> None:
    if not pid:
        return

    try:
        import psutil
    except Exception as e:
        logger.debug("psutil unavailable for Playwright driver PID reap", agent_id=agent_id, pid=pid, error=str(e))
        return

    try:
        proc = psutil.Process(pid)
        command = " ".join(proc.cmdline()) or proc.name()
        if not _playwright_driver_command_matches(command):
            logger.debug(
                "Skipping Playwright driver PID reap because command no longer matches",
                agent_id=agent_id,
                pid=pid,
                command=command[:240],
            )
            return
        if proc.status() == psutil.STATUS_ZOMBIE:
            return

        proc.terminate()
        try:
            await asyncio.to_thread(proc.wait, 2)
            logger.warning("Terminated lingering Playwright driver PID", agent_id=agent_id, pid=pid)
            return
        except psutil.TimeoutExpired:
            pass

        proc.kill()
        await asyncio.to_thread(proc.wait, 2)
        logger.warning("Killed lingering Playwright driver PID", agent_id=agent_id, pid=pid)
    except ProcessLookupError:
        return
    except psutil.NoSuchProcess:
        return
    except Exception as e:
        logger.warning("Failed to reap Playwright driver PID", agent_id=agent_id, pid=pid, error=str(e))


def _disable_cdp_websocket_proxy() -> bool:
    """Force cdp-use websocket handshakes to bypass ambient proxy config."""
    try:
        cdp_client_module = importlib.import_module("cdp_use.client")
    except Exception as exc:
        logger.debug("Could not patch cdp-use websocket proxy handling", error=str(exc))
        return False

    connect = getattr(cdp_client_module.websockets, "connect", None)
    if connect is None or getattr(connect, "_rose_proxy_disabled", False):
        return False

    try:
        supports_proxy_arg = "proxy" in inspect.signature(connect).parameters
    except (TypeError, ValueError):
        supports_proxy_arg = False
    if not supports_proxy_arg:
        return False

    def connect_without_proxy(*args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("proxy", None)
        return connect(*args, **kwargs)

    connect_without_proxy._rose_proxy_disabled = True
    cdp_client_module.websockets.connect = connect_without_proxy
    logger.info("Disabled ambient proxy use for cdp-use websocket connections")
    return True


def _clear_browser_activity_memory_buffers(
    *,
    action_history: Optional[Any] = None,
    browser_recorder: Optional[Any] = None,
    browser_network_recorder: Optional[Any] = None,
    mutable_buffers: tuple[Any, ...] = (),
) -> None:
    """Release large per-run browser buffers before smoke memory ratchet samples RSS."""
    if action_history is not None and hasattr(action_history, "clear"):
        with contextlib.suppress(Exception):
            action_history.clear()

    if browser_recorder is not None:
        for attr in ("frames", "cursor_events", "_last_metadata"):
            value = getattr(browser_recorder, attr, None)
            if hasattr(value, "clear"):
                with contextlib.suppress(Exception):
                    value.clear()
        for attr in ("page", "_cursor"):
            with contextlib.suppress(Exception):
                setattr(browser_recorder, attr, None)

    if browser_network_recorder is not None:
        for attr in (
            "entries",
            "_diagnostic_entries",
            "console_entries",
            "_tasks",
            "_bodies",
            "_body_byte_sizes",
            "_provider_exit_rejections",
            "_rejected_network_generations",
            "_ignored_request_ids",
            "_active_request_ids",
            "_active_request_meta",
        ):
            value = getattr(browser_network_recorder, attr, None)
            if hasattr(value, "clear"):
                with contextlib.suppress(Exception):
                    value.clear()
        for attr in ("browser_session", "_cdp_client"):
            with contextlib.suppress(Exception):
                setattr(browser_network_recorder, attr, None)
        with contextlib.suppress(Exception):
            browser_network_recorder._body_bytes = 0

    for value in mutable_buffers:
        if hasattr(value, "clear"):
            with contextlib.suppress(Exception):
                value.clear()

    gc.collect()


async def _append_new_otp_user_messages(
    *,
    otps: List[ExtractedOTP],
    seen_otp_codes: set[str],
    otp_user_messages: List[Dict[str, str]],
    credential_refs_by_secret_ref: Optional[Dict[str, Dict[str, str]]] = None,
    agent_id: str,
    task_id: Optional[str],
) -> int:
    """Append unseen OTPs as USER messages and log credential refs."""
    new_count = 0
    for otp in otps:
        if not is_usable_email_otp(otp):
            logger.info(
                "Skipping stale email OTP",
                agent_id=agent_id,
                source_message_id=otp.source_message_id,
                ttl_seconds=otp.ttl_seconds,
            )
            continue

        if otp.code in seen_otp_codes:
            continue

        seen_otp_codes.add(otp.code)
        message = format_otp_user_message(otp)
        otp_user_messages.append({"role": "user", "content": message})
        credential_ref = None
        if otp.credential_id:
            credential_ref = {
                "kind": otp.credential_kind,
                "id": str(otp.credential_id),
            }
        else:
            logger.warning(
                "OTP missing credential id; skipping credential-ref logging",
                agent_id=agent_id,
                source_message_id=otp.source_message_id,
            )

        if credential_ref and credential_refs_by_secret_ref is not None:
            credential_refs_by_secret_ref[otp.code] = credential_ref
        new_count += 1

        if task_id and credential_ref:
            await save_browser_credential_ref_message(
                agent_id=agent_id,
                task_id=task_id,
                message=message,
                role="USER",
                credential_ref=credential_ref,
            )

    return new_count


async def _fetch_and_append_recent_otp_user_messages(
    *,
    user_id: str,
    api_url: str,
    api_key: str,
    seen_otp_codes: set[str],
    otp_user_messages: List[Dict[str, str]],
    credential_refs_by_secret_ref: Dict[str, Dict[str, str]],
    agent_id: str,
    task_id: Optional[str],
) -> int:
    otps = await fetch_recent_otps(user_id, api_url, api_key)
    return await _append_new_otp_user_messages(
        otps=otps,
        seen_otp_codes=seen_otp_codes,
        otp_user_messages=otp_user_messages,
        credential_refs_by_secret_ref=credential_refs_by_secret_ref,
        agent_id=agent_id,
        task_id=task_id,
    )


def _browser_prompt_cache_namespace(task_id: Optional[str], call_site: str) -> Optional[str]:
    """Return one stable provider cache lane per browser task and logical call path."""
    if not task_id:
        return None
    logical_lane = re.sub(r"_(?:step|fork)_\d+$", "", call_site)
    return f"browser-task:{task_id}:{logical_lane}"


async def _call_browser_use_with_rotation(  # noqa: C901
    *,
    rose_client: RoseClient,
    task: str,
    dynamic_system_context: str,
    turn_messages: List[Dict[str, Any]],
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
    browser_task_id: Optional[str] = None,
    extra_user_messages: Optional[List[Dict[str, str]]] = None,
    call_site: Optional[str] = None,
    skip_cache_write: bool = False,
    dump_extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Call rose-1-browser-use with in-activity claudeAuth rotation.

    The workflow normally owns claude-token rotation, but browser-use is the
    loop (no per-iteration workflow boundary), so the activity drives rotation
    here. On `auth_error` / `rate_limit`, mark the offending token, fetch a
    replacement, and retry up to MAX_CLAUDE_TOKEN_ROTATIONS. If all rotations
    exhaust (or there's no token to start), fall through to the waterfall.
    """
    browser_state_for_llm = dict(browser_state)
    if extra_user_messages:
        browser_state_for_llm["_extra_user_messages"] = extra_user_messages

    effective_call_site = call_site or f"browser_use_step_{iteration}"
    rose_kwargs = dict(
        task=task,
        browser_state=browser_state_for_llm,
        action_history=action_entries,
        available_actions=AVAILABLE_ACTIONS,
        dynamic_system_context=dynamic_system_context,
        turn_messages=turn_messages,
        agent_id=agent_id,
        call_site=effective_call_site,
        cache_namespace=_browser_prompt_cache_namespace(browser_task_id, effective_call_site),
        skip_cache_write=skip_cache_write,
        dump_extra=dump_extra,
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
        llm_result.get("claude_token_error") in ("auth_error", "rate_limit") and rotations < MAX_CLAUDE_TOKEN_ROTATIONS
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


def _browser_tool_arguments(unified_action: Dict[str, Any]) -> Dict[str, Any]:
    args = dict(unified_action.get("params") or {})
    action_name = unified_action.get("action")
    if unified_action.get("index") is not None and "index" not in args:
        args["index"] = unified_action["index"]
    coords = unified_action.get("coordinates")
    if action_name == "click_coordinates" and isinstance(coords, dict):
        args.setdefault("x", coords.get("x"))
        args.setdefault("y", coords.get("y"))
    return args


def _browser_tool_result_for_history(action_name: str, result: Dict[str, Any]) -> Dict[str, Any]:
    clean: Dict[str, Any] = {}
    for key, value in (result or {}).items():
        if key in {"screenshot", "screenshot_b64", "dom_tree", "base64"}:
            continue
        clean[key] = value
    if action_name == "screenshot" and (result.get("screenshot") or result.get("screenshot_b64")):
        clean["screenshot_attached"] = True
    return clean


def _append_browser_turn_messages(
    turn_messages: List[Dict[str, Any]],
    *,
    task: str,
    browser_state: Dict[str, Any],
    include_screenshot: bool,
    unified_action: Dict[str, Any],
    result: Dict[str, Any],
    tool_call_id: str,
) -> None:
    """Append browser state, assistant tool call, and tool result to the next LLM context."""
    action_name = unified_action.get("action") or "unknown"
    thinking = unified_action.get("thinking") or ""
    args = _browser_tool_arguments(unified_action)
    turn_messages.append(
        {
            "role": "user",
            "content": build_browser_state_message_content(
                task=task,
                browser_state=browser_state,
                include_screenshot=include_screenshot,
                include_task=False,
            ),
        }
    )
    turn_messages.append(
        {
            "role": "assistant",
            "content": thinking,
            "tool_calls": [
                {
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": action_name,
                        "arguments": json_dumps_compact(args),
                    },
                }
            ],
        }
    )
    turn_messages.append(
        {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": action_name,
            "content": json_dumps_compact(_browser_tool_result_for_history(action_name, result)),
        }
    )

    screenshot_b64 = result.get("screenshot") or result.get("screenshot_b64")
    if action_name == "screenshot" and screenshot_b64:
        turn_messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Screenshot captured by the screenshot tool.",
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"},
                    },
                ],
            }
        )


async def _capture_recovery_storage_state(
    page: Any,
    emit_progress: Callable[[str, str], Awaitable[None]],
) -> Dict[str, Any]:
    """Capture auth state for challenge recovery with visible bounded progress."""
    await emit_progress(
        "capture_browser_state",
        "Capturing cookies, local storage, and IndexedDB before challenge recovery",
    )
    storage_state = await _capture_rotation_storage_state(page)
    if storage_state is None:
        raise RuntimeError("Browser state is unavailable for auth-preserving challenge recovery")
    return storage_state


async def _finalize_browser_recovery_action_result(
    *,
    action_result: Dict[str, Any],
    dom_service: Optional[Any],
    action_history: Any,
    thinking: str,
    recovery_reason: str,
    browser_turn_messages: List[Dict[str, Any]],
    task_prompt: str,
    browser_state: Dict[str, Any],
    unified_action: Dict[str, Any],
    recovery_call_id: str,
    browser_stream: Any,
) -> None:
    """Persist one recovery result and close its streamed tool lifecycle."""
    if dom_service is not None:
        await action_history.record_action(
            dom_service=dom_service,
            action="recover_from_challenge",
            thinking=thinking,
            params={"reason": recovery_reason},
            result=action_result,
        )
    _append_browser_turn_messages(
        browser_turn_messages,
        task=task_prompt,
        browser_state=browser_state,
        include_screenshot=False,
        unified_action=unified_action,
        result=action_result,
        tool_call_id=recovery_call_id,
    )
    await browser_stream.finish_tools(status="FINISHED" if action_result.get("success") else "ERROR")


async def _feed_browser_tool_validation_error_back(
    *,
    error: BrowserToolArgsValidationError,
    action_history: Any,
    browser_turn_messages: List[Dict[str, Any]],
    dom_service: Any,
    browser_state: Dict[str, Any],
    task_prompt: str,
    iteration: int,
    agent_id: str,
    task_id: str,
    browser_url: str,
) -> None:
    """Route a model tool-arg validation error through the normal tool-result path.

    A schema rejection of the model's OWN tool arguments is a model-output error, not
    a Rose transport/infra failure. Record it in action_history and append it to
    browser_turn_messages so the NEXT decision turn sees the rejection and can
    self-correct, and emit a visible ERROR trajectory row — exactly how execution
    errors are surfaced. Deliberately mirrors the auth-blocked branch; it must never
    be swallowed, hidden, or counted toward the consecutive-API-failure abort budget.
    """
    validation_message = (
        f"Your `{error.tool_name}` tool call was rejected because its arguments "
        f"failed validation:\n{error.detail}\n"
        "Fix the arguments and call the tool again, or choose a different action."
    )
    result = {"success": False, "error": validation_message}
    tool_call_id_action = str(uuid_module.uuid4())
    synthetic_action = {
        "action": error.tool_name,
        "thinking": error.thinking or "",
        "params": error.tool_args,
    }
    await action_history.record_action(
        dom_service=dom_service,
        action=error.tool_name,
        thinking=error.thinking or "",
        params=error.tool_args,
        result=result,
    )
    _append_browser_turn_messages(
        browser_turn_messages,
        task=task_prompt,
        browser_state=browser_state,
        include_screenshot=False,
        unified_action=synthetic_action,
        result=result,
        tool_call_id=tool_call_id_action,
    )
    await save_browser_action_message(
        agent_id=agent_id,
        title=f"Invalid {error.tool_name} arguments — retrying",
        task_id=task_id,
        message=validation_message,
        status=MessageStatus.FINISHED,
        browser_url=browser_url,
        action_type=error.tool_name,
        tool_call_id=tool_call_id_action,
        steps_taken=iteration,
        total_steps=MAX_ITERATIONS,
    )


def json_dumps_compact(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


async def _browser_supervisor_snapshot(
    *,
    input_page: Optional[Any],
    dom_service: Optional[Any],
    timeout_s: float = 5.0,
) -> Dict[str, Any]:
    """Best-effort lightweight page snapshot for browser stalls.

    This intentionally avoids the expensive browser-use DOM extraction path; the
    supervisor is called when that path may already be wedged.
    """

    snapshot: Dict[str, Any] = {
        "url": "",
        "title": "",
        "body_text": "",
        "buttons": [],
        "inputs": [],
        "tabs": [],
    }

    page = input_page
    if page is None and dom_service is not None:
        with contextlib.suppress(Exception):
            page = await asyncio.wait_for(dom_service.session.get_current_page(), timeout=timeout_s)

    if page is None:
        return snapshot

    async def _read_page() -> Dict[str, Any]:
        return await page.evaluate(
            """() => {
                const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
                const buttons = Array.from(document.querySelectorAll(
                    'button, [role="button"], a, input[type="button"], input[type="submit"]'
                )).slice(0, 80).map((el) => ({
                    tag: el.tagName,
                    text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 120),
                    aria: (el.getAttribute('aria-label') || '').slice(0, 120),
                    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
                })).filter((el) => el.text || el.aria);
                const inputs = Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 50).map((el) => ({
                    tag: el.tagName,
                    type: el.getAttribute('type') || '',
                    name: el.getAttribute('name') || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    aria: el.getAttribute('aria-label') || '',
                }));
                return {
                    url: location.href,
                    title: document.title || '',
                    body_text: text.slice(0, 3000),
                    buttons,
                    inputs,
                };
            }"""
        )

    with contextlib.suppress(Exception):
        page_data = await asyncio.wait_for(_read_page(), timeout=timeout_s)
        if isinstance(page_data, dict):
            snapshot.update(page_data)

    with contextlib.suppress(Exception):
        context = getattr(page, "context", None)
        pages = getattr(context, "pages", []) if context is not None else []
        tabs = []
        for idx, tab in enumerate(pages[:10]):
            tabs.append(
                {
                    "index": idx,
                    "url": getattr(tab, "url", "") or "",
                    "title": await asyncio.wait_for(tab.title(), timeout=1.5),
                }
            )
        snapshot["tabs"] = tabs

    return snapshot


def _format_browser_supervisor_message(recovery: Dict[str, Any]) -> str:
    snapshot = recovery.get("snapshot") or {}
    actions = recovery.get("actions") or []
    body_text = str(snapshot.get("body_text") or "")
    buttons = snapshot.get("buttons") or []
    button_text = ", ".join(
        str((b or {}).get("text") or (b or {}).get("aria") or "").strip()
        for b in buttons[:12]
        if str((b or {}).get("text") or (b or {}).get("aria") or "").strip()
    )
    parts = [
        "Browser supervisor detected a stalled browser step and performed generic recovery.",
        f"Reason: {recovery.get('reason', 'unknown')}",
        f"URL: {snapshot.get('url') or 'unknown'}",
    ]
    if actions:
        parts.append("Recovery actions: " + ", ".join(str(a) for a in actions))
    if button_text:
        parts.append("Visible controls before recovery: " + button_text[:600])
    if body_text:
        parts.append("Visible page text before recovery: " + body_text[:1000])
    parts.append("Continue from the current page state. Do not restart from search unless the page is unusable.")
    return "\n".join(parts)


async def _perform_generic_browser_recovery(
    *,
    input_page: Optional[Any],
    reason: str,
    reload_page: bool,
    fallback_url: str = "",
    timeout_s: float = 8.0,
) -> List[str]:
    """Try safe, site-agnostic unstick actions on the active page."""

    actions: List[str] = []
    if input_page is None:
        return actions

    with contextlib.suppress(Exception):
        await asyncio.wait_for(input_page.bring_to_front(), timeout=timeout_s)
        actions.append("bring_to_front")

    with contextlib.suppress(Exception):
        await asyncio.wait_for(input_page.keyboard.press("Escape"), timeout=timeout_s)
        actions.append("press_escape")

    async def _click_dismiss_button() -> Optional[str]:
        candidates = await input_page.locator(
            'button, [role="button"], a, input[type="button"], input[type="submit"]'
        ).all()
        for locator in candidates[:80]:
            try:
                text = await locator.evaluate(
                    """el => (
                            el.innerText || el.value || el.getAttribute('aria-label') ||
                            el.getAttribute('title') || ''
                        ).trim()"""
                )
                if not _GENERIC_DISMISS_BUTTON_RE.match(str(text or "")):
                    continue
                if not await locator.is_visible():
                    continue
                await locator.click(timeout=int(timeout_s * 1000), force=False)
                return f"click_dismiss:{str(text)[:60]}"
            except Exception:
                continue
        return None

    with contextlib.suppress(Exception):
        clicked = await asyncio.wait_for(_click_dismiss_button(), timeout=timeout_s)
        if clicked:
            actions.append(clicked)

    if reload_page:
        with contextlib.suppress(Exception):
            current_url = getattr(input_page, "url", "") or ""
            if current_url.startswith(("http://", "https://")):
                await asyncio.wait_for(
                    input_page.reload(),
                    timeout=timeout_s + 2,
                )
                actions.append("reload")
            elif fallback_url.startswith(("http://", "https://")):
                await asyncio.wait_for(
                    input_page.goto(fallback_url, wait_until="domcontentloaded", timeout=int(timeout_s * 1000)),
                    timeout=timeout_s + 2,
                )
                actions.append("goto_fallback_url")

    return actions


async def _run_browser_supervisor_recovery(
    *,
    agent_id: str,
    task_id: Optional[str],
    browser_url: Optional[str],
    tool_call_id: str,
    iteration: int,
    reason: str,
    input_page: Optional[Any],
    dom_service: Optional[Any],
    browser_turn_messages: List[Dict[str, Any]],
    reload_page: bool,
    fallback_url: str = "",
) -> Dict[str, Any]:
    snapshot = await _browser_supervisor_snapshot(input_page=input_page, dom_service=dom_service)
    if fallback_url and not snapshot.get("url"):
        snapshot["url"] = fallback_url
    actions = await _perform_generic_browser_recovery(
        input_page=input_page,
        reason=reason,
        reload_page=reload_page,
        fallback_url=fallback_url,
    )
    recovery = {
        "reason": reason,
        "actions": actions,
        "snapshot": snapshot,
    }
    browser_turn_messages.append(
        {
            "role": "user",
            "content": _format_browser_supervisor_message(recovery),
        }
    )
    if task_id:
        with contextlib.suppress(Exception):
            await save_browser_action_message(
                agent_id=agent_id,
                title="Browser supervisor recovery",
                task_id=task_id,
                message=_format_browser_supervisor_message(recovery),
                status=MessageStatus.FINISHED,
                browser_url=browser_url or snapshot.get("url") or "",
                action_type="supervisor_recovery",
                tool_call_id=str(uuid_module.uuid4()),
                steps_taken=iteration,
                total_steps=MAX_ITERATIONS,
                extra_metadata={
                    "supervisor_reason": reason,
                    "supervisor_actions": actions,
                    "supervisor_snapshot": {
                        "url": snapshot.get("url"),
                        "title": snapshot.get("title"),
                        "buttons": snapshot.get("buttons", [])[:20],
                        "inputs": snapshot.get("inputs", [])[:20],
                        "tabs": snapshot.get("tabs", [])[:10],
                    },
                    "parent_tool_call_id": tool_call_id,
                },
            )
    logger.warning(
        "Browser supervisor recovery ran",
        agent_id=agent_id,
        task_id=task_id,
        reason=reason,
        actions=actions,
        url=snapshot.get("url"),
    )
    return recovery


def _write_lock_notification_prompt(
    *,
    approval_type: str,
    current_url: str,
    pending_action: Dict[str, Any],
    write_lock_result: Dict[str, Any],
    media_candidates: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Prompt appended only to the forked write-lock notification call."""
    evidence = {
        "approval_type": approval_type,
        "current_url": current_url,
        "pending_action": pending_action,
        "write_lock_result": {key: value for key, value in write_lock_result.items() if key not in {"question"}},
    }
    if media_candidates:
        evidence["media_candidates"] = media_candidates[:12]
    return (
        "WRITE_LOCK_NOTIFICATION_FORK_REQUEST\n\n"
        "A write lock was triggered. Call generate_write_lock_notification exactly once using the "
        "current conversation, browser trajectory, latest page context, and pending action.\n\n"
        "Do not perform any browser action. Do not continue the task. Do not ask the user for "
        "approval. Generate structured approval metadata only.\n\n"
        "Describe the real-world action the user is approving, not the clicked button or DOM "
        "mechanic. For purchases, include every visible item being bought and set media to exactly one "
        "image when any product, checkout, or page image is visible; for multiple items, use one "
        "rendered_summary image if available. For each "
        "purchase item, use the item key title, not name. You MUST include its real numeric rating and "
        "review count plus its canonical product-detail URL; never substitute the current cart, checkout, "
        "payment, or order URL. Those required fields must already exist in the browser trajectory; do not "
        "invent them or perform a browser action in this fork. Also include "
        "visible price, quantity, description under 80 characters, seller, delivery details, product image URL, order totals, "
        "delivery address, and payment method when visible. If Runtime evidence includes media_candidates, use only those "
        "URLs for media and item image_url, preferring the candidate whose alt or nearby_text best "
        "matches the purchased item. For payment, never include secrets such as card numbers, CVV, "
        "passwords, tokens, or one-time codes.\n\n"
        f"Runtime evidence:\n{json_dumps_compact(evidence)}"
    )


class PurchaseApprovalContextError(RuntimeError):
    """Raised when a purchase approval cannot meet its required context contract."""


class PurchaseApprovalNotificationRetryableError(RuntimeError):
    """Raised when transient notification generation should preserve checkout state for retry."""


def _enforce_write_lock_notification_failure_policy(approval_type: str, error: Exception) -> None:
    if approval_type == "purchase":
        if isinstance(error, PurchaseApprovalContextError):
            raise error
        raise PurchaseApprovalNotificationRetryableError(
            "Purchase approval notification generation failed transiently; retry with the checkout session paused"
        ) from error


def _format_write_lock_value(label: str, value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return f"{label}: {text}"


def _sentence_case_action(action: str) -> str:
    if not action:
        return action
    if action[:2].isupper():
        return action
    return action[0].lower() + action[1:]


def _append_write_lock_values(lines: List[str], payload: Dict[str, Any], fields: tuple[tuple[str, str], ...]) -> None:
    for label, key in fields:
        formatted = _format_write_lock_value(label, payload.get(key))
        if formatted:
            lines.append(formatted)


def _append_purchase_notification(lines: List[str], purchase: Dict[str, Any]) -> None:
    items = purchase.get("items") if isinstance(purchase.get("items"), list) else []
    if items:
        lines.append("\n**Items:**")
        for idx, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                continue
            lines.append(f"{idx}. {str(item.get('title') or 'Item').strip()}")
            _append_write_lock_values(
                lines,
                item,
                (
                    ("   Price", "price"),
                    ("   Qty", "quantity"),
                    ("   Description", "description"),
                    ("   Rating", "rating"),
                    ("   Reviews", "review_count"),
                    ("   Seller", "seller"),
                    ("   Shipping", "shipping"),
                ),
            )
            product_url = str(item.get("product_url") or "").strip()
            if product_url:
                lines.append(f"   Product: [View product]({product_url})")

    totals = purchase.get("totals") if isinstance(purchase.get("totals"), dict) else {}
    total_lines: List[str] = []
    _append_write_lock_values(
        total_lines,
        totals,
        (("Subtotal", "subtotal"), ("Shipping", "shipping"), ("Tax", "tax"), ("Total", "total")),
    )
    if total_lines:
        lines.append("\n**Totals:**")
        lines.extend(total_lines)
    _append_write_lock_values(
        lines,
        purchase,
        (("Payment", "payment_method"), ("Delivery", "delivery_address")),
    )


def _append_message_notification(lines: List[str], message: Dict[str, Any]) -> None:
    for label, key in (("To", "to"), ("Cc", "cc"), ("Bcc", "bcc")):
        value = message.get(key)
        if isinstance(value, list) and value:
            lines.append(f"{label}: {', '.join(str(entry) for entry in value if entry)}")
    _append_write_lock_values(lines, message, (("Subject", "subject"),))
    body = str(message.get("body") or "").strip()
    if body:
        lines.append(f"\n**Body:**\n{body}")


def _append_social_notification(lines: List[str], post: Dict[str, Any]) -> None:
    _append_write_lock_values(
        lines,
        post,
        (("Destination", "destination"), ("Audience", "audience")),
    )
    body = str(post.get("body") or "").strip()
    if body:
        lines.append(f"\n**Post:**\n{body}")


def _append_payment_notification(lines: List[str], payment: Dict[str, Any]) -> None:
    _append_write_lock_values(
        lines,
        payment,
        (("Merchant", "merchant"), ("Amount", "amount"), ("Purpose", "purpose")),
    )
    fields = payment.get("fields")
    if isinstance(fields, list) and fields:
        lines.append(f"Fields: {', '.join(str(field) for field in fields if field)}")
    lines.append("\nPayment secrets are not included in this message.")


def _append_trigger_notification(lines: List[str], trigger_type: Any, payload: Any) -> None:
    if not isinstance(payload, dict):
        return
    if trigger_type == "purchase":
        _append_purchase_notification(lines, payload)
    elif trigger_type == "message":
        _append_message_notification(lines, payload)
    elif trigger_type == "social_post":
        _append_social_notification(lines, payload)
    elif trigger_type == "payment":
        _append_payment_notification(lines, payload)
    elif trigger_type == "generic_write":
        _append_write_lock_values(
            lines,
            payload,
            (("Action", "label"), ("Target", "target"), ("Change", "payload_summary")),
        )


def _render_write_lock_notification_question(
    notification: Dict[str, Any],
    *,
    system_name: str,
    fallback_question: str,
) -> str:
    """Render approval text from structured write-lock metadata."""
    if not isinstance(notification, dict):
        return fallback_question

    service = notification.get("service") if isinstance(notification.get("service"), dict) else {}
    service_name = service.get("name") or service.get("domain") or "the current site"
    action = _sentence_case_action(str(notification.get("action") or "perform a write action").strip())
    trigger_type = notification.get("trigger_type")

    lines = ["**Approval Needed**\n", f"{system_name} wants to {action} on **{service_name}**."]

    trigger_payload = notification.get(trigger_type) if isinstance(trigger_type, str) else None
    _append_trigger_notification(lines, trigger_type, trigger_payload)

    media = notification.get("media")
    if isinstance(media, list) and media:
        first = next((m for m in media if isinstance(m, dict) and m.get("url")), None)
        if first:
            lines.append(f"\n**Image:** {first['url']}")

    url = service.get("url")
    if url and trigger_type != "purchase":
        lines.append(f"\n**Page:** {url}")

    return "\n".join(lines)


def _notification_media_url(notification: Dict[str, Any]) -> Optional[str]:
    media = notification.get("media")
    if isinstance(media, list):
        for entry in media:
            if not isinstance(entry, dict):
                continue
            url = entry.get("url")
            if isinstance(url, str) and url.strip():
                return url.strip()
    return None


def _first_purchase_item_image_url(notification: Dict[str, Any]) -> Optional[str]:
    purchase = notification.get("purchase")
    if not isinstance(purchase, dict):
        return None
    items = purchase.get("items")
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict):
            continue
        image_url = item.get("image_url")
        if isinstance(image_url, str) and image_url.strip():
            return image_url.strip()
    return None


def _text_tokens(value: Any) -> set[str]:
    text = str(value or "").lower()
    tokens = set(re.findall(r"[a-z0-9]+", text))
    return {
        token
        for token in tokens
        if len(token) > 2
        and token
        not in {
            "the",
            "and",
            "for",
            "with",
            "one",
            "size",
            "from",
            "your",
            "item",
            "product",
        }
    }


def _media_candidate_url_score(url: str, bounds: Dict[str, Any]) -> int:
    lower = url.lower()
    width = int(bounds.get("width") or 0)
    height = int(bounds.get("height") or 0)
    area = width * height
    score = 0
    if "/images/i/" in lower:
        score += 25
    if re.search(r"\._[^/]*(?:ac|aa|sx|sy|ul|ux|uy)\d+", lower):
        score += 30
    size_match = re.search(r"\._[^/]*(?:ac|aa|sx|sy|ul|ux|uy)(\d+)", lower)
    if size_match:
        score += min(int(size_match.group(1)), 1000) // 20
    if lower.endswith((".jpg", ".jpeg", ".webp")):
        score += 25
    if lower.endswith(".png"):
        score -= 5
    if area and area < 32 * 32:
        score -= 40
    if any(marker in lower for marker in ("cardart", "logo", "sprite", "icon")):
        score -= 35
    return score


def _best_media_candidate_for_purchase(
    notification: Dict[str, Any],
    browser_state: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    candidates = browser_state.get("media_candidates")
    if not isinstance(candidates, list):
        return None
    purchase = notification.get("purchase")
    items = purchase.get("items") if isinstance(purchase, dict) else []
    item_text = " ".join(
        str(item.get("title") or item.get("description") or "") for item in items if isinstance(item, dict)
    )
    item_tokens = _text_tokens(item_text)

    best: Optional[Dict[str, Any]] = None
    best_score = -1
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        url = candidate.get("url")
        if not isinstance(url, str) or not url.strip():
            continue
        candidate_text = f"{candidate.get('alt') or ''} {candidate.get('nearby_text') or ''}"
        overlap = len(item_tokens & _text_tokens(candidate_text))
        score = overlap * 10
        if candidate.get("visible"):
            score += 3
        if "media-amazon" in url or "ssl-images-amazon" in url:
            score += 2
        bounds = candidate.get("bounds") if isinstance(candidate.get("bounds"), dict) else {}
        score += _media_candidate_url_score(url, bounds)
        score += min(int(bounds.get("width") or 0) * int(bounds.get("height") or 0), 10000) // 5000
        if score > best_score:
            best = candidate
            best_score = score

    if not best or best_score <= 0:
        return None
    return best


def _normalize_write_lock_notification_media(
    notification: Dict[str, Any],
    *,
    browser_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Ensure purchase approvals have one renderer image when visual evidence exists."""
    if notification.get("trigger_type") != "purchase":
        return notification
    if _notification_media_url(notification):
        return notification

    item_image_url = _first_purchase_item_image_url(notification)
    if item_image_url:
        notification["media"] = [
            {
                "url": item_image_url,
                "alt": "Purchase item image",
                "kind": "product",
            }
        ]
        return notification

    media_candidate = _best_media_candidate_for_purchase(notification, browser_state)
    if media_candidate:
        notification["media"] = [
            {
                "url": media_candidate["url"].strip(),
                "alt": media_candidate.get("alt") or media_candidate.get("nearby_text") or "Purchase item image",
                "kind": "product",
            }
        ]
        purchase = notification.get("purchase")
        items = purchase.get("items") if isinstance(purchase, dict) else []
        if len(items) == 1 and isinstance(items[0], dict) and not items[0].get("image_url"):
            items[0]["image_url"] = media_candidate["url"].strip()
        return notification

    screenshot = browser_state.get("screenshot")
    if isinstance(screenshot, str) and screenshot.strip():
        screenshot_url = (
            screenshot.strip()
            if screenshot.strip().startswith("http")
            else f"data:image/png;base64,{screenshot.strip()}"
        )
        notification["media"] = [
            {
                "url": screenshot_url,
                "alt": "Checkout page preview",
                "kind": "page_preview",
            }
        ]

    return notification


async def _generate_write_lock_notification(
    *,
    rose_client: RoseClient,
    task_prompt: str,
    dynamic_system_context: str,
    browser_turn_messages: List[Dict[str, Any]],
    browser_state: Dict[str, Any],
    action_entries: List[Dict[str, Any]],
    config: Any,
    user_id: str,
    agent_id: str,
    browser_task_id: Optional[str] = None,
    iteration: int,
    token_state: ClaudeTokenState,
    gpt_token: Optional[str],
    gpt_account_id: Optional[str],
    gpt_token_source: Optional[str],
    gpt_token_pool_id: Optional[str],
    browser_use_mode: Optional[str],
    approval_type: str,
    current_url: str,
    trusted_page_urls: List[str],
    pending_action: Dict[str, Any],
    write_lock_result: Dict[str, Any],
    system_name: str,
    fallback_question: str,
) -> Dict[str, Any]:
    """Fork browser-use context to generate write-lock approval metadata."""
    prompt = _write_lock_notification_prompt(
        approval_type=approval_type,
        current_url=current_url,
        pending_action=pending_action,
        write_lock_result=write_lock_result,
        media_candidates=browser_state.get("media_candidates"),
    )
    fork_result = await _call_browser_use_with_rotation(
        rose_client=rose_client,
        task=task_prompt,
        dynamic_system_context=dynamic_system_context,
        turn_messages=browser_turn_messages,
        browser_state=browser_state,
        action_entries=action_entries,
        config=config,
        user_id=user_id,
        agent_id=agent_id,
        browser_task_id=browser_task_id,
        iteration=iteration,
        token_state=token_state,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        browser_use_mode=browser_use_mode,
        extra_user_messages=[{"role": "user", "content": prompt}],
        call_site=f"write_lock_notification_fork_{iteration}",
        skip_cache_write=True,
        dump_extra={
            "write_lock_notification_fork": True,
            "approval_type": approval_type,
            "current_url": current_url,
        },
    )
    action = fork_result.get("action") or {}
    if action.get("action") != "generate_write_lock_notification":
        raise ValueError(
            f"write-lock notification fork did not call generate_write_lock_notification; got {action.get('action')!r}"
        )
    from browser_tools.schemas import GenerateWriteLockNotificationTool

    try:
        validated_notification = GenerateWriteLockNotificationTool.model_validate(
            {"tool": "generate_write_lock_notification", **dict(action.get("params") or {})},
            context={"trusted_page_urls": [*trusted_page_urls, current_url]},
        )
    except ValueError as error:
        raise PurchaseApprovalContextError(
            "Purchase approval blocked because reviews and a canonical product link could not be verified"
        ) from error
    notification = validated_notification.model_dump(exclude={"tool"}, exclude_none=True)
    notification = _normalize_write_lock_notification_media(
        notification,
        browser_state=browser_state,
    )
    question = _render_write_lock_notification_question(
        notification,
        system_name=system_name,
        fallback_question=fallback_question,
    )
    return {
        "notification": notification,
        "question": question,
        "usage": fork_result.get("usage") or {},
        "actual_model": fork_result.get("actual_model"),
        "request_id": fork_result.get("request_id"),
        "mode": fork_result.get("mode"),
    }


# ========================================
# TEMPORAL ACTIVITY (V3 - browser-use)
# ========================================


async def _install_fast_mode_network_cache(
    context: Any,
    goal: str,
    *,
    read_enabled: bool = True,
    write_enabled: bool = True,
) -> None:
    """Record/replay browser HTTPS responses for Fast Mode.

    Replay (read_enabled): install a Playwright route that fulfills cache hits.
    Write-through / record-only: attach a response listener only — do NOT install
    ``context.route("**/*")``. Routing every request (even with immediate
    ``continue_()``) breaks Stripe Elements on Eventim checkout: Billing Address
    and Payment Details stay empty shells while js.stripe.com still returns 200s
    (bench agent ``baf33041-…``, steel_managed, write-through user).

    Failures degrade to live (never break the session).
    """
    from providers.fast_cache.browser_http import BrowserHttpCache

    http_cache = BrowserHttpCache(goal, read_enabled=read_enabled, write_enabled=write_enabled)

    async def _request_body(req: Any) -> Optional[Any]:
        post_data = getattr(req, "post_data", None)
        if callable(post_data):
            post_data = post_data()
        if asyncio.iscoroutine(post_data):
            post_data = await post_data
        if post_data is not None:
            return post_data
        post_data_buffer = getattr(req, "post_data_buffer", None)
        if callable(post_data_buffer):
            post_data_buffer = post_data_buffer()
        if asyncio.iscoroutine(post_data_buffer):
            post_data_buffer = await post_data_buffer
        return post_data_buffer

    async def _route(route: Any) -> None:
        req = route.request
        try:
            hit = await http_cache.lookup(
                req.method,
                req.url,
                req.resource_type,
                dict(req.headers),
                await _request_body(req),
            )
        except Exception:
            hit = None
        if hit is not None:
            try:
                await route.fulfill(status=hit["status"], headers=hit["headers"], body=hit["body"])
                return
            except Exception:
                pass
        await route.continue_()

    async def _record(response: Any) -> None:
        try:
            req = response.request
            body = await response.body()
            await http_cache.record(
                req.method,
                req.url,
                req.resource_type,
                response.status,
                dict(response.headers),
                body,
                request_headers=dict(req.headers),
                request_body=await _request_body(req),
            )
        except Exception:  # recording is best-effort, never break the page
            pass

    if read_enabled:
        await context.route("**/*", _route)
    if write_enabled:
        context.on("response", lambda r: asyncio.ensure_future(_record(r)))


async def _finalize_kernel_replay_for_fe(
    *,
    browser_recorder: BrowserAgentRecorder,
    agent_id: str,
    task_id: str,
    user_id: Optional[str],
    browser_url: Optional[str],
    browser_session_metadata: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Stop Kernel's native replay and write the FE-visible recording message.

    System context:
    Kernel replay (one per session; rotate_ip records a fresh segment per rotation)
    -> stop -> stitch every segment into ONE continuous MP4 -> upload -> DB tool
    message -> BrowserAgentChip Recording tab. The FE plays a single stitched video
    of the exit IP changing across rotations. With only one segment (no rotation),
    or when the stitch can't run (no ffmpeg / download failure), we fall back to the
    Kernel-hosted view URL — no re-encode, no upload.
    """
    view_url = await browser_recorder.stop_kernel_replay()
    # One replay segment per session. After rotate_ip runs, there are multiple
    # segments (baseline + one per rotation); each shows a different exit IP.
    segment_urls = list(getattr(browser_recorder, "replay_view_urls", []) or [])
    if not segment_urls and view_url:
        segment_urls = [view_url]
    if not segment_urls:
        logger.warning(
            "Kernel replay finalized without a view URL; no recording message",
            agent_id=agent_id,
            task_id=task_id,
        )
        return None

    # Multiple rotation segments -> stitch into ONE continuous MP4 and upload it, so
    # the FE plays a single video player (not a playlist) of the IP changing.
    extra_metadata: Dict[str, Any] = {"browser_session_metadata": browser_session_metadata}
    stitched_pointer = None
    if len(segment_urls) > 1 and user_id:
        try:
            stitched_mp4 = await browser_recorder.stitch_segments_to_mp4()
            if stitched_mp4:
                stitched_pointer = await upload_to_storage(
                    user_id=user_id,
                    file_content=stitched_mp4,
                    filename=f"browser-recording-{task_id}.mp4",
                    mime_type="video/mp4",
                )
        except Exception as exc:  # noqa: BLE001 — stitch/upload is best-effort
            logger.warning(
                "Replay stitch/upload failed; falling back to segment URLs",
                agent_id=agent_id,
                task_id=task_id,
                error=repr(exc)[:300],
            )

    if stitched_pointer:
        # One stitched video is the entire recording; the FE plays it directly.
        extra_metadata["recording_file_pointer"] = stitched_pointer
    else:
        # Fallback: hand the FE the Kernel-hosted segment URL(s). Baseline first.
        extra_metadata["recording_view_url"] = segment_urls[0]
        if len(segment_urls) > 1:
            extra_metadata["recording_view_urls"] = segment_urls

    await save_browser_action_message(
        agent_id=agent_id,
        title="Browser recording saved",
        task_id=task_id,
        message="Browser session replay recorded (Kernel).",
        status=MessageStatus.FINISHED,
        browser_url=browser_url or "",
        action_type="recording",
        tool_call_id=str(uuid_module.uuid4()),
        extra_metadata=extra_metadata,
    )
    logger.info(
        "Kernel replay recording message saved",
        agent_id=agent_id,
        task_id=task_id,
        segment_count=len(segment_urls),
        stitched=bool(stitched_pointer),
    )
    return {
        "recording_file_pointer": stitched_pointer,
        "recording_view_urls": segment_urls,
    }


async def _finalize_browser_recording_for_fe(
    *,
    browser_recorder: BrowserAgentRecorder,
    agent_id: str,
    task_id: Optional[str],
    user_id: str,
    browser_url: Optional[str],
    browser_session_metadata: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Persist the frame replay and write the FE-visible recording message.

    System context:
    browser frames/cursor/tab URL -> inline HTML upload -> DB tool message ->
    BrowserAgentChip Recording tab. This intentionally skips the optional Steel
    HLS download because failed/timed-out runs need the already-captured frame
    replay uploaded before activity cleanup can be interrupted.
    """
    if not task_id:
        return None

    # Kernel-native replay: reuse Kernel's stored video replay + hosted view URL
    # instead of uploading a self-contained HTML player to (flaky) Supabase. The
    # FE iframes `recording_view_url` directly (see BrowserAgentChip).
    if getattr(browser_recorder, "uses_kernel_replay", False):
        return await _finalize_kernel_replay_for_fe(
            browser_recorder=browser_recorder,
            agent_id=agent_id,
            task_id=task_id,
            user_id=user_id,
            browser_url=browser_url,
            browser_session_metadata=browser_session_metadata,
        )

    cleanup_local_artifacts = False
    cleanup_delegated = False
    try:
        recording_path = await browser_recorder.close(
            include_steel_media=False,
            archive_artifacts=False,
        )
        if not recording_path:
            return None

        recording_file_pointer = None
        html_bytes: Optional[bytes] = None
        try:
            html_bytes = browser_recorder.export_inline_html_bytes()
            if html_bytes:
                recording_file_pointer = await upload_to_storage(
                    user_id=user_id,
                    file_content=html_bytes,
                    filename=f"browser-recording-{task_id}.html",
                    mime_type="text/html",
                )
                logger.info(
                    "Browser recording uploaded",
                    agent_id=agent_id,
                    task_id=task_id,
                    bytes=len(html_bytes),
                    has_pointer=bool(recording_file_pointer),
                )
        except Exception as exc:  # noqa: BLE001 — recording upload is best-effort
            logger.warning(
                "Browser recording upload failed",
                agent_id=agent_id,
                task_id=task_id,
                error=repr(exc),
                html_bytes=len(html_bytes) if isinstance(html_bytes, (bytes, bytearray)) else None,
            )

        await save_browser_action_message(
            agent_id=agent_id,
            title="Browser recording saved",
            task_id=task_id,
            message=f"Local browser recording: {recording_path}",
            status=MessageStatus.FINISHED,
            browser_url=browser_url or "",
            action_type="recording",
            tool_call_id=str(uuid_module.uuid4()),
            extra_metadata={
                "recording_path": str(recording_path),
                "recording_file_pointer": recording_file_pointer,
                "browser_session_metadata": browser_session_metadata,
            },
        )
        cleanup_local_artifacts = bool(recording_file_pointer)
        schedule_archive = getattr(
            browser_recorder,
            "archive_recording_artifacts_in_background",
            None,
        )
        if callable(schedule_archive):
            cleanup_delegated = bool(schedule_archive(cleanup_after=cleanup_local_artifacts))
        return {
            "recording_path": str(recording_path),
            "recording_file_pointer": recording_file_pointer,
            "html_bytes": len(html_bytes) if isinstance(html_bytes, (bytes, bytearray)) else None,
        }
    finally:
        cleanup = getattr(browser_recorder, "cleanup_local_artifacts", None)
        if callable(cleanup) and not cleanup_delegated:
            cleanup(persisted=cleanup_local_artifacts)


async def _finalize_browser_recording_for_fe_resilient(
    *,
    browser_recorder: BrowserAgentRecorder,
    agent_id: str,
    task_id: Optional[str],
    user_id: str,
    browser_url: Optional[str],
    browser_session_metadata: Dict[str, Any],
    timeout_seconds: int = BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS,
) -> Optional[Dict[str, Any]]:
    """Run recording finalization even when activity cleanup is being cancelled."""

    task = asyncio.create_task(
        _finalize_browser_recording_for_fe(
            browser_recorder=browser_recorder,
            agent_id=agent_id,
            task_id=task_id,
            user_id=user_id,
            browser_url=browser_url,
            browser_session_metadata=browser_session_metadata,
        )
    )
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout_seconds)
    except asyncio.CancelledError:
        logger.warning(
            "Browser recording finalization received cancellation; draining before activity exit",
            agent_id=agent_id,
            task_id=task_id,
        )
        current_task = asyncio.current_task()
        if current_task is not None and hasattr(current_task, "uncancel"):
            while current_task.cancelling():
                current_task.uncancel()
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            task.cancel()
            logger.warning(
                "Browser recording finalization timed out after cancellation",
                agent_id=agent_id,
                task_id=task_id,
                timeout_seconds=timeout_seconds,
            )
            return None
        except Exception as exc:  # noqa: BLE001 — final cleanup should not mask the activity result
            logger.warning(
                "Browser recording finalization failed after cancellation",
                agent_id=agent_id,
                task_id=task_id,
                error=repr(exc),
            )
            return None
    except asyncio.TimeoutError:
        task.cancel()
        logger.warning(
            "Browser recording finalization timed out",
            agent_id=agent_id,
            task_id=task_id,
            timeout_seconds=timeout_seconds,
        )
        return None
    except Exception as exc:  # noqa: BLE001 — final cleanup should not mask the activity result
        logger.warning(
            "Browser recording finalization failed",
            agent_id=agent_id,
            task_id=task_id,
            error=repr(exc),
        )
        return None


async def _finalize_browser_diagnostics_for_fe(
    *,
    browser_network_recorder: BrowserNetworkRecorder,
    agent_id: str,
    task_id: Optional[str],
    user_id: str,
    browser_url: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Persist redacted console/network indexes and expose durable pointers.

    The uploaded ZIP intentionally contains metadata indexes only. Raw response
    body files remain local/trace-gated and are never included in this broadly
    discoverable post-run debugging attachment.
    """
    if not task_id:
        return None

    network_index_path = await browser_network_recorder.close()
    console_index_path = getattr(browser_network_recorder, "console_index_path", None)
    if not network_index_path and not console_index_path:
        return None

    trace_archive_refs: Dict[str, str] = {}
    try:
        archive_result = await browser_network_recorder.archive_diagnostics_artifacts()
        if isinstance(archive_result, dict):
            trace_archive_refs = archive_result
    except Exception as exc:
        logger.warning(
            "Browser diagnostics trace archive failed",
            agent_id=agent_id,
            task_id=task_id,
            error=repr(exc)[:300],
        )

    diagnostics_file_pointer = None
    bundle_bytes: Optional[bytes] = None
    try:
        bundle_bytes = browser_network_recorder.export_diagnostics_bundle_bytes()
        if bundle_bytes:
            diagnostics_file_pointer = await asyncio.wait_for(
                upload_to_storage(
                    user_id=user_id,
                    file_content=bundle_bytes,
                    filename=f"browser-diagnostics-{task_id}.zip",
                    mime_type="application/zip",
                ),
                timeout=15,
            )
    except Exception as exc:
        logger.warning(
            "Browser diagnostics attachment upload failed",
            agent_id=agent_id,
            task_id=task_id,
            error=repr(exc)[:300],
        )

    metadata = {
        "browser_diagnostics_file_pointer": diagnostics_file_pointer,
        "console_log_path": str(console_index_path) if console_index_path else None,
        "network_recording_path": str(network_index_path) if network_index_path else None,
        "trace_archive_refs": trace_archive_refs,
        "diagnostics_redacted": True,
        "response_bodies_included": False,
    }
    message_saved = False
    for attempt in range(1, 4):
        message_saved = await save_browser_action_message(
            agent_id=agent_id,
            title="Browser diagnostics saved",
            task_id=task_id,
            message="Redacted browser console and network diagnostics are available for post-run inspection.",
            status=MessageStatus.FINISHED,
            browser_url=browser_url or "",
            action_type="diagnostics",
            tool_call_id=f"browser-diagnostics:{task_id}",
            extra_metadata=metadata,
        )
        if message_saved:
            break
        if attempt < 3:
            await asyncio.sleep(0.2 * attempt)
    logger.info(
        "Browser diagnostics pointers saved",
        agent_id=agent_id,
        task_id=task_id,
        bundle_bytes=len(bundle_bytes) if bundle_bytes else 0,
        has_pointer=bool(diagnostics_file_pointer),
        message_saved=message_saved,
        trace_ref_count=len(trace_archive_refs),
    )
    return metadata


def _schedule_browser_cleanup(
    *,
    agent_id: str,
    task_id: Optional[str],
    user_id: str,
    browser_url: Optional[str],
    browser_session_metadata: Dict[str, Any],
    input_page: Optional[Any],
    start_url: str,
    cursor_streamer: Optional[BrowserCursorRealtimeStreamer],
    interaction_layer_task: Optional[asyncio.Task],
    humanizer: Optional[Any],
    browser_network_recorder: Optional[BrowserNetworkRecorder],
    network_recorder_task: Optional[asyncio.Task],
    browser_recorder: Optional[BrowserAgentRecorder],
    dom_service: Optional[Any],
    playwright_browser: Optional[Any],
    playwright_instance: Optional[Any],
    playwright_driver_pid: Optional[int],
) -> asyncio.Task:
    async def _cleanup() -> None:
        logger.info("Browser cleanup started in background", agent_id=agent_id, task_id=task_id)
        resolved_network_recorder = browser_network_recorder
        try:
            if cursor_streamer:
                with contextlib.suppress(Exception):
                    await cursor_streamer.close()
            if input_page and _botsigged_diagnostics_enabled(start_url):
                with contextlib.suppress(Exception):
                    capture = await _capture_botsigged_diagnostics(
                        input_page,
                        agent_id=agent_id,
                        task_id=task_id,
                        checkpoint="final",
                    )
                    if capture and task_id:
                        await save_browser_action_message(
                            agent_id=agent_id,
                            title="BotSigged diagnostics saved",
                            task_id=task_id,
                            message=f"Local BotSigged diagnostics: {capture['path']}",
                            status=MessageStatus.FINISHED,
                            browser_url=browser_url or "",
                            action_type="diagnostics",
                            tool_call_id=str(uuid_module.uuid4()),
                            extra_metadata={
                                "botsigged_diagnostics_path": capture["path"],
                                "botsigged_last_score": capture["diagnostics"].get("lastScore"),
                                "botsigged_signal_counts": capture["diagnostics"].get("signalCounts"),
                            },
                        )
            if interaction_layer_task is not None and not interaction_layer_task.done():
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(asyncio.shield(interaction_layer_task), timeout=10)
            if humanizer:
                with contextlib.suppress(Exception):
                    await humanizer.close()
            if network_recorder_task is not None:
                with contextlib.suppress(Exception):
                    resolved_network_recorder = await asyncio.wait_for(network_recorder_task, timeout=10)
            if resolved_network_recorder:
                with contextlib.suppress(Exception):
                    await _finalize_browser_diagnostics_for_fe(
                        browser_network_recorder=resolved_network_recorder,
                        agent_id=agent_id,
                        task_id=task_id,
                        user_id=user_id,
                        browser_url=browser_url,
                    )
            if browser_recorder:
                await _finalize_browser_recording_for_fe_resilient(
                    browser_recorder=browser_recorder,
                    agent_id=agent_id,
                    task_id=task_id,
                    user_id=user_id,
                    browser_url=browser_url,
                    browser_session_metadata=browser_session_metadata,
                )
            if dom_service:
                with contextlib.suppress(Exception):
                    await dom_service.disconnect()
            await _stop_playwright_resources(
                playwright_browser,
                playwright_instance,
                agent_id,
                driver_pid=playwright_driver_pid,
            )
        except Exception as exc:  # noqa: BLE001 - background cleanup must never crash the worker loop
            logger.warning(
                "Browser cleanup failed in background",
                agent_id=agent_id,
                task_id=task_id,
                error=extract_error_message(exc),
            )
        finally:
            _clear_browser_activity_memory_buffers(
                browser_recorder=browser_recorder,
                browser_network_recorder=resolved_network_recorder,
            )
            logger.info("Browser cleanup finished in background", agent_id=agent_id, task_id=task_id)

    cleanup_task = asyncio.create_task(_cleanup())
    _background_browser_cleanup_tasks.add(cleanup_task)

    def _discard(done: asyncio.Task) -> None:
        _background_browser_cleanup_tasks.discard(done)
        with contextlib.suppress(BaseException):
            done.result()

    cleanup_task.add_done_callback(_discard)
    return cleanup_task


# A single background cleanup can run up to BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS
# (recording finalization, default 45s) plus the two bounded 10s waits for the
# interaction-layer and network-recorder tasks. Size the shutdown drain to cover that
# worst case so we don't cut teardown short and orphan browser sessions/driver PIDs.
# (On Fly this is still capped by the platform SIGTERM→SIGKILL window; the drain logs
# a warning and returns best-effort if the platform kills us first.)
_BACKGROUND_BROWSER_CLEANUP_DRAIN_TIMEOUT_SECONDS = float(BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS) + 20.0


async def drain_background_browser_cleanups(
    timeout: float = _BACKGROUND_BROWSER_CLEANUP_DRAIN_TIMEOUT_SECONDS,
) -> None:
    """Await any in-flight background browser cleanups before the worker exits.

    ``_schedule_browser_cleanup`` detaches teardown into
    ``_background_browser_cleanup_tasks`` so the activity can return without
    blocking on recording finalization. Those detached tasks are invisible to
    ``worker.shutdown()``, so on graceful shutdown we must drain them here or
    Playwright/Steel teardown gets cut short, orphaning browser sessions and
    driver PIDs. Called from the worker shutdown path (see ``worker.py``). The
    default timeout covers the worst-case single-cleanup latency; drain returns
    as soon as all tasks finish, so the cap only bites on a genuinely stuck one.
    """
    pending = [task for task in _background_browser_cleanup_tasks if not task.done()]
    if not pending:
        return
    logger.info(
        "Draining background browser cleanups before shutdown",
        count=len(pending),
        timeout=timeout,
    )
    try:
        await asyncio.wait_for(
            asyncio.shield(asyncio.gather(*pending, return_exceptions=True)),
            timeout=timeout,
        )
        logger.info("Background browser cleanups drained")
    except asyncio.TimeoutError:
        logger.warning(
            "Background browser cleanup drain timed out; some sessions may be orphaned",
            remaining=len([task for task in pending if not task.done()]),
            timeout=timeout,
        )


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
    fast_mode_cache_enabled: bool = False,
    world_model_mode: Optional[str] = None,
) -> Dict[str, Any]:
    # A browser is its own stateful environment. Do not inherit either the
    # benchmark runner's explicit session or the parent agent's module-cached
    # session. The latter uses ``agent_id`` as its cache key and can be created
    # by a provider boundary before this activity starts; sharing it makes WMH
    # answer browser actions using the parent's whole-agent output contract.
    # The tool-call namespace remains stable across write-lock resumes, whose
    # payload also restores the exact browser session id.
    world_model = WorldModelToolExecutionAdapter.from_env(
        agent_id=f"{agent_id}:browser:{tool_call_id}",
        inherit_explicit_session=False,
        mode=world_model_mode,
    )
    if world_model.should_simulate("browser_action"):
        return await _spawn_browser_agent_activity_v3_simulated(
            user_id=user_id,
            agent_id=agent_id,
            goal=goal,
            tool_call_id=tool_call_id,
            task_id=task_id,
            session_id=session_id,
            cdp_url=cdp_url,
            is_resume=is_resume,
            output_schema=output_schema,
            attachments=attachments,
            write_lock_enabled=write_lock_enabled,
            start_url=start_url,
            write_lock_resume_state=write_lock_resume_state,
            system_name=system_name,
            use_claude_mode=use_claude_mode,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            world_model=world_model,
        )
    return await _spawn_browser_agent_activity_v3_real(
        user_id=user_id,
        agent_id=agent_id,
        goal=goal,
        tool_call_id=tool_call_id,
        task_id=task_id,
        session_id=session_id,
        cdp_url=cdp_url,
        is_resume=is_resume,
        output_schema=output_schema,
        attachments=attachments,
        write_lock_enabled=write_lock_enabled,
        start_url=start_url,
        write_lock_resume_state=write_lock_resume_state,
        system_name=system_name,
        use_claude_mode=use_claude_mode,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        fast_mode_cache_enabled=fast_mode_cache_enabled,
    )


def _simulated_browser_transition_contract(
    *,
    action_name: str,
    approved: bool,
    write_lock_enabled: bool,
    retry_reason: Optional[str] = None,
) -> Dict[str, Any]:
    instructions = (
        "Apply exactly this one action to the simulated website state. The WMH response envelope "
        "requires an output string: set output to a JSON-encoded object containing browser_state "
        "with url, title, dom_tree, viewport, scroll_position, page_stats, tabs, and recent_events. "
        "Also return frame as either static HTML or a raster image data URL/URL when supported. "
        "Do not narrate actions the browser agent did not request and do not complete future steps. "
        "If this action would cause an irreversible write and approved is false, do not mutate state; "
        "return requires_approval=true, approval_type, and a grounded question. If approved is true, "
        "apply only the previously requested action. Never return a whole browser-agent outcome."
    )
    if retry_reason:
        # The prior attempt for THIS action returned a malformed transition (an LLM
        # simulator occasionally omits required fields). Re-emit the same single
        # transition, this time with the mandatory structure, instead of failing the
        # whole trajectory.
        instructions = (
            f"RETRY — your previous response for this exact action was rejected: {retry_reason}. "
            "You MUST return a JSON object containing a top-level 'browser_state' object whose "
            "'dom_tree' is present (structured accessibility tree or serialized string). Do not omit "
            "browser_state or dom_tree. Re-apply only this one action to the same prior state. " + instructions
        )
    return {
        "boundary": "browser_environment_transition",
        "action_name": action_name,
        "approved": approved,
        "write_lock_enabled": write_lock_enabled,
        "instructions": instructions,
    }


def _initial_simulated_browser_state(start_url: str) -> Dict[str, Any]:
    """Create the neutral, pre-action browser state for a new WMH session.

    Initialization is orchestration, not an environment action. Asking the LLM
    world model to simulate it can accidentally advance the goal all the way to
    completion before the browser policy takes its first action.
    """

    from urllib.parse import parse_qs, urlparse

    url = str(start_url or "about:blank")
    parsed = urlparse(url)
    host = parsed.netloc or "simulated website"
    query = parse_qs(parsed.query).get("k", [""])[0].strip()
    title = "Amazon.com" if "amazon." in host.lower() else host
    main_name = f'Search results page for "{query}"' if query else "Website start page"
    tree = {
        "role": "webarea",
        "name": title,
        "children": [
            {
                "role": "banner",
                "name": title,
                "children": [
                    {"role": "link", "name": "Home"},
                    {"role": "searchbox", "name": "Search", "value": query},
                    {"role": "link", "name": "Cart"},
                ],
            },
            {
                "role": "main",
                "name": main_name,
                "children": [
                    {
                        "role": "text",
                        "name": "Initial page loaded. Inspect or search to load grounded product results.",
                    }
                ],
            },
        ],
    }
    return {
        "url": url,
        "title": title,
        "dom_tree": json.dumps(tree, sort_keys=True, separators=(",", ":")),
        "viewport": {"width": 1440, "height": 900},
        "scroll_position": {"pages_above": 0, "pages_below": 0, "total_pages": 1},
        "page_stats": {"initialized": True},
        "tabs": [{"id": 0, "url": url, "title": title}],
        "recent_events": ["initial_page_loaded"],
    }


def _simulated_browser_state_from_result(
    result: Dict[str, Any],
    *,
    previous_state: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    observation = result.get("world_model_observation")
    metadata = observation.get("metadata") if isinstance(observation, dict) else None
    candidates = [
        result.get("browser_state"),
        result.get("state"),
        result if "dom_tree" in result else None,
        observation.get("browser_state") if isinstance(observation, dict) else None,
        observation.get("state") if isinstance(observation, dict) else None,
        observation if isinstance(observation, dict) and "dom_tree" in observation else None,
        metadata.get("browser_state") if isinstance(metadata, dict) else None,
        metadata if isinstance(metadata, dict) and "dom_tree" in metadata else None,
    ]
    state = next((dict(value) for value in candidates if isinstance(value, dict)), None)
    if state is None:
        # WMH's generic Observation contract asks the model for an ``output``
        # string.  Some real models therefore return the website observation as
        # text instead of echoing our nested browser_state extension.  That text
        # is still the authoritative environment result: expose it as the next
        # accessibility-tree observation while preserving stable browser fields.
        raw_observation_text = None
        for candidate in (
            observation.get("content") if isinstance(observation, dict) else None,
            result.get("message"),
            result.get("output"),
        ):
            if isinstance(candidate, str) and candidate.strip():
                raw_observation_text = candidate.strip()
                break
            if isinstance(candidate, (dict, list)) and candidate:
                raw_observation_text = json.dumps(candidate, sort_keys=True, separators=(",", ":"), default=str)
                break
        if not raw_observation_text:
            raise ValueError("WMH browser transition omitted browser_state")
        state = dict(previous_state or {})
        state["dom_tree"] = raw_observation_text
        prior_events = state.get("recent_events") or state.get("events") or []
        if not isinstance(prior_events, (list, tuple)):
            prior_events = [prior_events]
        state["recent_events"] = [*prior_events, raw_observation_text[:2000]]
    dom_tree = state.get("dom_tree")
    if isinstance(dom_tree, (dict, list)):
        # The production WMH emits a structured accessibility tree while older
        # traces and the browser-use prompt use the serialized tree form. Keep
        # the environment contract lossless and normalize at this boundary.
        state["dom_tree"] = json.dumps(dom_tree, sort_keys=True, separators=(",", ":"), default=str)
    elif not isinstance(dom_tree, str):
        raise ValueError("WMH browser transition browser_state omitted dom_tree")
    if not isinstance(state.get("url"), str):
        state["url"] = str((previous_state or {}).get("url") or "")
    state["title"] = str(state.get("title") or "")
    if not isinstance(state.get("viewport"), dict):
        state["viewport"] = {"width": 1440, "height": 900}
    if not isinstance(state.get("scroll_position"), dict):
        state["scroll_position"] = {"pages_above": 0, "pages_below": 0, "total_pages": 1}
    if not isinstance(state.get("page_stats"), dict):
        state["page_stats"] = {}
    raw_tabs = state.get("tabs") or []
    if not isinstance(raw_tabs, (list, tuple)):
        raw_tabs = [raw_tabs]
    state["tabs"] = [
        dict(tab) if isinstance(tab, dict) else {"id": index, "url": str(tab), "title": ""}
        for index, tab in enumerate(raw_tabs)
        if tab is not None
    ]
    raw_events = state.get("recent_events") or state.get("events") or []
    if not isinstance(raw_events, (list, tuple)):
        raw_events = [raw_events]
    state["recent_events"] = [
        event.strip()
        if isinstance(event, str)
        else json.dumps(event, sort_keys=True, separators=(",", ":"), default=str)
        for event in raw_events
        if event is not None and (not isinstance(event, str) or event.strip())
    ]
    if "screenshot" in state and not isinstance(state["screenshot"], str):
        state.pop("screenshot")
    return state


def _simulated_browser_frame_from_result(
    result: Dict[str, Any], browser_state: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    observation = result.get("world_model_observation")
    metadata = observation.get("metadata") if isinstance(observation, dict) else None
    candidates = [
        result.get("frame"),
        result.get("website_frame"),
        browser_state.get("frame"),
        observation.get("frame") if isinstance(observation, dict) else None,
        metadata.get("frame") if isinstance(metadata, dict) else None,
    ]
    for candidate in candidates:
        normalized = normalize_simulated_browser_frame(candidate)
        if normalized is not None:
            return normalized
    screenshot = browser_state.get("screenshot")
    if isinstance(screenshot, str) and screenshot.strip():
        normalized_screenshot = normalize_simulated_browser_frame(
            screenshot if screenshot.startswith("data:image/") else {"base64": screenshot}
        )
        if normalized_screenshot is not None:
            return normalized_screenshot
    return _static_simulated_browser_frame(browser_state)


def _static_simulated_browser_frame(browser_state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Render a network-free website frame from WMH's accessibility tree."""

    raw_tree = browser_state.get("dom_tree")
    if isinstance(raw_tree, str):
        try:
            tree = json.loads(raw_tree)
        except json.JSONDecodeError:
            tree = raw_tree
    else:
        tree = raw_tree
    if not tree:
        return None

    remaining_nodes = 500

    def render_node(node: Any) -> str:
        nonlocal remaining_nodes
        if remaining_nodes <= 0:
            return ""
        remaining_nodes -= 1
        if not isinstance(node, dict):
            return f'<div class="text">{html_module.escape(str(node)[:500])}</div>'
        role = str(node.get("role") or "generic").lower()
        name = html_module.escape(str(node.get("name") or "")[:500])
        children = node.get("children") if isinstance(node.get("children"), list) else []
        rendered_children = "".join(render_node(child) for child in children)
        if role == "heading":
            return f"<h2>{name}</h2>{rendered_children}"
        if role == "button":
            return f'<button type="button" disabled>{name or "Button"}</button>{rendered_children}'
        if role == "link":
            return f'<span class="link">{name or "Link"}</span>{rendered_children}'
        if role in {"combobox", "textbox", "searchbox"}:
            return f'<div class="input">{name or "Input"}</div>{rendered_children}'
        if role == "alert":
            return f'<div class="alert">{name}</div>{rendered_children}'
        tag = "header" if role == "banner" else "main" if role == "main" else "section"
        label = f'<div class="label">{name}</div>' if name and role not in {"webarea", "generic"} else ""
        return f'<{tag} class="role-{html_module.escape(role)}">{label}{rendered_children}</{tag}>'

    rendered_tree = render_node(tree)
    if not rendered_tree:
        return None
    title = html_module.escape(str(browser_state.get("title") or "Simulated website")[:300])
    url = html_module.escape(str(browser_state.get("url") or "about:blank")[:1000])
    viewport = browser_state.get("viewport") if isinstance(browser_state.get("viewport"), dict) else {}
    dimensions = {
        key: int(value)
        for key, value in (("width", viewport.get("width")), ("height", viewport.get("height")))
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
    }
    static_html = f"""<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#fff;color:#111;font:14px Arial,sans-serif}}.location{{padding:9px 14px;background:#f3f3f3;border-bottom:1px solid #ccc;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}header{{background:#131921;color:#fff;padding:14px}}main{{padding:20px;max-width:1180px;margin:auto}}section{{margin:8px 0}}h2{{font-size:22px;margin:12px 0}}button{{margin:6px;padding:9px 16px;border:1px solid #f0c14b;border-radius:18px;background:#ffd814;color:#111}}.link{{display:inline-block;margin:5px;color:#007185;font-weight:600}}.input{{display:inline-block;min-width:220px;margin:5px;padding:9px;border:1px solid #888;border-radius:4px;background:#fff;color:#555}}.alert{{margin:8px;padding:10px;border:1px solid #70a85b;background:#edf8e8}}.label{{margin:6px 0;font-weight:600}}.text{{margin:4px}}</style></head><body><div class="location">{url}</div>{rendered_tree}</body></html>"""
    return {"kind": "html", "html": static_html, **dimensions}


def _ground_simulated_browser_approval_question(
    *,
    transition: Dict[str, Any],
    browser_state: Dict[str, Any],
    system_name: str,
    approval_type: str,
) -> str:
    """Ground irreversible simulated writes in the item and amount visible in WMH state."""

    fallback = str(
        transition.get("question") or f"{system_name} wants to perform a {approval_type} action. Approve?"
    ).strip()
    dom_text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(browser_state.get("dom_tree") or ""))).strip()
    amounts = re.findall(r"\$\s*\d+(?:,\d{3})*(?:\.\d{2})?", dom_text)
    if not amounts:
        return fallback
    item_label = "the beanie" if "beanie" in dom_text.lower() else "this item"
    amount = amounts[0].replace(" ", "")
    if item_label.lower() in fallback.lower() and amount in fallback:
        return fallback
    return f"Approve purchasing {item_label} for {amount}?"


async def _execute_simulated_browser_transition(
    *,
    world_model: WorldModelToolExecutionAdapter,
    goal: str,
    action: Dict[str, Any],
    browser_state: Optional[Dict[str, Any]],
    tool_call_id: str,
    write_lock_enabled: bool,
    approved: bool = False,
    approval_type: Optional[str] = None,
    payment_card_last4: Optional[str] = None,
) -> tuple[Dict[str, Any], Dict[str, Any], Optional[Dict[str, Any]]]:
    action_name = str(action.get("action") or "unknown")

    async def forbidden_real_browser(_tool_name: str, _tool_args: Dict[str, Any], _tool_call_id: str) -> Dict[str, Any]:
        raise RuntimeError("Simulator mode forbids launching or connecting to a real browser")

    # The WMH is an LLM: it occasionally emits a transition missing browser_state/dom_tree.
    # A single malformed step must not kill the whole trajectory (that stalls the agent into
    # a wait_for death-spiral and a timeout). Retry the SAME single action with a strengthened
    # contract and a fresh tool_call_id (so a cached bad transition isn't replayed) before
    # surfacing the error. This is environment-boundary resilience, not a benchmark change.
    _MAX_TRANSITION_ATTEMPTS = 3
    last_error: Optional[ValueError] = None
    for attempt in range(1, _MAX_TRANSITION_ATTEMPTS + 1):
        attempt_tool_call_id = tool_call_id if attempt == 1 else f"{tool_call_id}:retry{attempt}"
        result = await world_model.execute(
            "browser_action",
            {
                "goal": goal,
                "action": action_name,
                "params": _browser_tool_arguments(action),
                "thinking": action.get("thinking") or "",
                "current_browser_state": {
                    key: value
                    for key, value in (browser_state or {}).items()
                    if key not in {"screenshot", "frame", "website_frame"}
                },
                "approval": {
                    "granted": approved,
                    "type": approval_type,
                    "payment_card_last4": payment_card_last4,
                },
                "simulation_contract": _simulated_browser_transition_contract(
                    action_name=action_name,
                    approved=approved,
                    write_lock_enabled=write_lock_enabled,
                    retry_reason=str(last_error) if last_error else None,
                ),
            },
            attempt_tool_call_id,
            forbidden_real_browser,
            allow_real_fallback=False,
        )
        if not result.get("world_model_simulated"):
            raise RuntimeError("Simulated browser transition omitted world_model_simulated provenance")
        result_status = str(result.get("status") or "").lower()
        repeated_approval = bool(
            result.get("requires_approval") or result.get("approval_required")
        ) or result_status in {"awaiting_write_approval", "needs_write_approval"}
        if approved and repeated_approval:
            last_error = ValueError("WMH repeated approval boundary after approval was granted")
            logger.warning(
                "simulated_browser_transition_malformed",
                action=action_name,
                attempt=attempt,
                max_attempts=_MAX_TRANSITION_ATTEMPTS,
                error=str(last_error),
            )
            continue
        try:
            next_state = _simulated_browser_state_from_result(result, previous_state=browser_state)
        except ValueError as exc:
            last_error = exc
            logger.warning(
                "simulated_browser_transition_malformed",
                action=action_name,
                attempt=attempt,
                max_attempts=_MAX_TRANSITION_ATTEMPTS,
                error=str(exc),
            )
            continue
        return result, next_state, _simulated_browser_frame_from_result(result, next_state)
    raise last_error if last_error else ValueError("WMH browser transition omitted browser_state")


def _simulated_browser_message_metadata(
    *, frame: Optional[Dict[str, Any]], world_model_session_id: str, world_model_name: Optional[str]
) -> Dict[str, Any]:
    metadata: Dict[str, Any] = {
        "world_model_simulated": True,
        "world_model_session_id": world_model_session_id,
        "world_model_name": world_model_name,
        "browser_session_metadata": {
            "provider": "wmh",
            "simulated": True,
            "world_model_name": world_model_name,
        },
    }
    if frame is not None:
        metadata["simulated_browser_frame"] = frame
    return metadata


_SIMULATED_BROWSER_RESUME_FIELDS = (
    "simulated_browser_state",
    "simulated_action_entries",
    "simulated_turn_messages",
    "simulated_visited_urls",
    "simulated_reasoning_messages",
    "simulated_action_summary",
    "simulated_recording_ref",
    "simulated_recording_frame_count",
    "simulated_action_entry_count",
    "simulated_pending_tool_call_id",
    "world_model_session_id",
    "simulated_total_input_tokens",
    "simulated_total_output_tokens",
    "simulated_usage_by_model",
)

_BROWSER_RESUME_CONTINUITY_FIELDS = (
    "action_history",
    "visited_urls",
    "verifier_checkpoints",
)


def _copy_browser_resume_continuity_fields(source: Dict[str, Any], target: Dict[str, Any]) -> None:
    for key in _BROWSER_RESUME_CONTINUITY_FIELDS:
        if key in source:
            target[key] = source[key]


def _copy_simulated_browser_resume_fields(source: Dict[str, Any], target: Dict[str, Any]) -> None:
    if not source.get("world_model_simulated"):
        return
    for key in _SIMULATED_BROWSER_RESUME_FIELDS:
        if key in source:
            target[key] = source[key]


def _simulated_browser_resume_payload(
    *,
    browser_state: Dict[str, Any],
    action_entries: List[Dict[str, Any]],
    turn_messages: List[Dict[str, Any]],
    recording_ref: Optional[str],
    frame_count: int,
    visited_urls: List[str],
    reasoning_messages: List[str],
    action_summary: List[str],
    world_model_session_id: str,
    total_input_tokens: int,
    total_output_tokens: int,
    usage_by_model: Dict[str, Dict[str, int]],
) -> Dict[str, Any]:
    compact_state = _compact_simulated_resume_value(browser_state)
    compact_actions = [_compact_simulated_resume_value(entry) for entry in action_entries[-30:]]
    compact_turns = [_compact_simulated_resume_value(message) for message in turn_messages[-24:]]
    return {
        "simulated_browser_state": compact_state,
        "simulated_action_entries": compact_actions,
        "simulated_turn_messages": compact_turns,
        "simulated_visited_urls": visited_urls[-50:],
        "simulated_reasoning_messages": reasoning_messages[-20:],
        "simulated_action_summary": action_summary[-20:],
        "simulated_recording_ref": recording_ref,
        "simulated_recording_frame_count": max(0, int(frame_count)),
        "simulated_action_entry_count": len(action_entries),
        "world_model_session_id": world_model_session_id,
        "simulated_total_input_tokens": total_input_tokens,
        "simulated_total_output_tokens": total_output_tokens,
        "simulated_usage_by_model": usage_by_model,
    }


_SIMULATED_RESUME_MEDIA_KEYS = {
    "base64",
    "data_url",
    "frame",
    "image",
    "image_url",
    "screenshot",
    "screenshot_b64",
    "simulated_browser_frame",
    "src",
    "website_frame",
}
_SIMULATED_RESUME_MAX_TEXT_CHARS = 4_000


def _compact_simulated_resume_value(value: Any) -> Any:
    """Bound Temporal resume payloads while retaining policy and verifier context."""

    if isinstance(value, dict):
        return {
            key: _compact_simulated_resume_value(nested)
            for key, nested in value.items()
            if key not in _SIMULATED_RESUME_MEDIA_KEYS
        }
    if isinstance(value, list):
        return [_compact_simulated_resume_value(item) for item in value]
    if isinstance(value, str):
        if value.lstrip().startswith("data:image/"):
            return "[image omitted from Temporal resume]"
        if len(value) > _SIMULATED_RESUME_MAX_TEXT_CHARS:
            return value[:_SIMULATED_RESUME_MAX_TEXT_CHARS] + "…[truncated for Temporal resume]"
    return value


def _simulated_browser_verifier_context(
    *,
    goal: str,
    browser_state: Dict[str, Any],
    action_entries: List[Dict[str, Any]],
    frame: Optional[Dict[str, Any]],
    payment_card_last4: Optional[str],
) -> List[Dict[str, Any]]:
    state_text = json.dumps(
        {k: v for k, v in browser_state.items() if k not in {"screenshot", "frame", "website_frame"}},
        ensure_ascii=False,
        default=str,
    )
    screenshot_b64 = ""
    if frame and frame.get("kind") == "image":
        source = str(frame.get("src") or "")
        if source.startswith("data:image/") and ";base64," in source:
            screenshot_b64 = source.split(";base64,", 1)[1]
    context: List[Dict[str, Any]] = [
        {
            "role": "USER",
            "text": (
                f"Goal: {goal}\n\n## Simulated Browser Ground Truth (FINAL STATE)\n"
                "Judge completion only from this WMH environment state and the recorded trajectory.\n\n"
                f"{state_text}"
            ),
        },
        {
            "role": "TOOL",
            "text": f"Browser Agent Execution Log ({len(action_entries)} actions):\n\n"
            + json.dumps(action_entries[-30:], ensure_ascii=False, default=str),
            "metadata": {"toolName": "action_history", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "WMH-generated final website frame attached." if screenshot_b64 else "No raster frame attached.",
            "metadata": {
                "toolName": "final_screenshot",
                "toolStatus": "FINISHED",
                "screenshot_b64": screenshot_b64,
            },
        },
    ]
    payment_evidence = _build_payment_card_verifier_evidence(payment_card_last4)
    if payment_evidence:
        context.append(payment_evidence)
    return context


async def _verify_simulated_browser_completion(
    *,
    goal: str,
    output_schema: Dict[str, Any],
    browser_state: Dict[str, Any],
    action_entries: List[Dict[str, Any]],
    frame: Optional[Dict[str, Any]],
    payment_card_last4: Optional[str],
    token_state: ClaudeTokenState,
    agent_id: str,
    user_id: str,
    gpt_token: Optional[str],
    gpt_account_id: Optional[str],
    gpt_token_source: Optional[str],
    gpt_token_pool_id: Optional[str],
) -> Dict[str, Any]:
    from helpers.llm import check_progress

    remote_schema = transform_schema_for_remote_session(output_schema)
    return await call_temporal_activity_from_activity(
        check_progress,
        args=[
            _simulated_browser_verifier_context(
                goal=goal,
                browser_state=browser_state,
                action_entries=action_entries,
                frame=frame,
                payment_card_last4=payment_card_last4,
            ),
            build_verifier_prompt(response_schema=remote_schema),
            VERIFIER_ULTRA_MODEL,
            remote_schema,
            token_state.access_token,
            "verifier_browser_simulated",
            agent_id,
            None,
            None,
            user_id,
            gpt_token,
            gpt_account_id,
            gpt_token_source,
            gpt_token_pool_id,
            user_id,
            None,
            None,
            {"browser_session_metadata": {"provider": "wmh", "simulated": True}},
        ],
        start_to_close_timeout=timedelta(seconds=VERIFIER_ULTRA_TIMEOUT_SECONDS),
    )


def _simulated_browser_usage_items(
    total_input_tokens: int,
    total_output_tokens: int,
    model_pricing: Dict[str, Any],
    usage_by_model: Optional[Dict[str, Dict[str, int]]] = None,
) -> List[Dict[str, Any]]:
    """Simulated twin of `build_usage_items`: same per-actual-model llm rows,
    a free World-Model-Harness service row instead of a paid browser row."""
    items = build_browser_llm_usage_items(
        total_input_tokens,
        total_output_tokens,
        model_pricing,
        usage_by_model,
    )
    items.append({"type": "service", "cost_cents": 0, "provider": "World Model Harness"})
    return items


async def _spawn_browser_agent_activity_v3_simulated(  # noqa: C901, PLR0915
    *,
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str],
    session_id: Optional[str],
    cdp_url: Optional[str],
    is_resume: bool,
    output_schema: Optional[Dict[str, Any]],
    attachments: Optional[List[Dict[str, Any]]],
    write_lock_enabled: bool,
    start_url: str,
    write_lock_resume_state: Optional[Dict[str, Any]],
    system_name: str,
    use_claude_mode: bool,
    gpt_token: Optional[str],
    gpt_account_id: Optional[str],
    gpt_token_source: Optional[str],
    gpt_token_pool_id: Optional[str],
    world_model: WorldModelToolExecutionAdapter,
) -> Dict[str, Any]:
    """Run the real browser-use policy against WMH state without creating a browser."""

    del session_id, cdp_url, is_resume, attachments
    if not output_schema:
        raise ValueError("output_schema is required for browser agent")
    structlog.contextvars.bind_contextvars(agent_id=agent_id)
    config = load_config()
    started_at = safe_time()
    resume = write_lock_resume_state or {}
    task_id = str(task_id or resume.get("task_id") or f"wmh-browser-{tool_call_id}")
    browser_url = "about:blank"
    browser_state = dict(resume.get("simulated_browser_state") or {})
    action_entries = list(resume.get("simulated_action_entries") or [])
    turn_messages = list(resume.get("simulated_turn_messages") or [])
    frames: List[Dict[str, Any]] = []
    visited_urls = list(resume.get("simulated_visited_urls") or [])
    reasoning_messages = list(resume.get("simulated_reasoning_messages") or [])
    action_summary = list(resume.get("simulated_action_summary") or [])
    total_input_tokens = int(resume.get("simulated_total_input_tokens") or 0)
    total_output_tokens = int(resume.get("simulated_total_output_tokens") or 0)
    usage_by_model = {
        str(model): {
            "input_tokens": int((usage or {}).get("input_tokens") or 0),
            "output_tokens": int((usage or {}).get("output_tokens") or 0),
        }
        for model, usage in (resume.get("simulated_usage_by_model") or {}).items()
        if isinstance(usage, dict)
    }
    iteration = int(resume.get("step_count") or 0)
    payment_card_last4 = _normalize_payment_card_last4(resume.get("payment_card_last4"))
    write_lock_approvals = dict(resume.get("write_lock_approvals") or {})
    latest_frame: Optional[Dict[str, Any]] = None
    restored_session = resume.get("world_model_session_id")
    if isinstance(restored_session, str) and restored_session:
        world_model.session_id = restored_session
    world_model_session_id = str(restored_session or "")

    browser_use_mode = "gpt" if gpt_token else ("claude" if use_claude_mode else None)
    token_state = ClaudeTokenState()
    if browser_use_mode == "claude":
        token_data = await fetch_claude_token(config, user_id)
        if token_data:
            token_state.access_token = token_data.get("accessToken")
            token_state.source = token_data.get("source")
            token_state.pool_token_id = token_data.get("poolTokenId")
        else:
            browser_use_mode = None

    model_pricing = await get_model_pricing_with_fallback(BROWSER_USE_PRICING_POOL)
    task_prompt = build_browser_task_prompt(goal)
    dynamic_system_context = build_browser_dynamic_system_context(
        "# Simulated Browser Runtime\n"
        "Operate the stateful simulated website one concrete action per turn. Continue until the requested "
        "outcome is actually visible in state. Do not claim actions you did not take.",
        response_schema=output_schema,
    )
    rose_client = BrowserStreamingRoseClient()
    recorder: Optional[SimulatedBrowserRecorder] = None

    def resume_payload() -> Dict[str, Any]:
        return _simulated_browser_resume_payload(
            browser_state=browser_state,
            action_entries=action_entries,
            turn_messages=turn_messages,
            recording_ref=str(recorder.checkpoint_path) if recorder else resume.get("simulated_recording_ref"),
            frame_count=len(recorder.frames) if recorder else int(resume.get("simulated_recording_frame_count") or 0),
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            world_model_session_id=world_model_session_id,
            total_input_tokens=total_input_tokens,
            total_output_tokens=total_output_tokens,
            usage_by_model=usage_by_model,
        )

    async def remember_frame(frame: Optional[Dict[str, Any]], *, step: int, label: str, action_name: str) -> None:
        nonlocal latest_frame, frames
        if frame is None:
            return
        latest_frame = frame
        if recorder:
            await recorder.record_frame(
                frame,
                iteration=step,
                label=label,
                action=action_name,
                browser_state=browser_state,
            )
            frames = recorder.frames
        else:
            frames.append({**frame, "ts_ms": step * 500, "label": label, "action": action_name})

    async def save_step(
        *,
        title: str,
        action_name: str,
        action_call_id: str,
        step: int,
        status: MessageStatus = MessageStatus.FINISHED,
        message: str = "",
    ) -> None:
        await save_browser_action_message(
            agent_id=agent_id,
            title=title,
            task_id=task_id,
            message=message,
            status=status,
            browser_url=browser_url,
            action_type=action_name,
            tool_call_id=action_call_id,
            steps_taken=step,
            total_steps=MAX_ITERATIONS,
            extra_metadata=_simulated_browser_message_metadata(
                frame=latest_frame,
                world_model_session_id=world_model_session_id,
                world_model_name=world_model.world_model_name,
            ),
        )

    async def finalize_recording() -> None:
        if recorder:
            await _finalize_browser_recording_for_fe_resilient(
                browser_recorder=recorder,  # type: ignore[arg-type]
                agent_id=agent_id,
                task_id=task_id,
                user_id=user_id,
                browser_url=browser_url,
                browser_session_metadata={"provider": "wmh", "simulated": True},
            )

    try:
        if not browser_state:
            # Seed the server-side WMH session with the same neutral start page
            # shown to the browser policy. Merely constructing this state on the
            # client leaves WMH's internal state blank, which can make its first
            # transition emit a whole terminal browser result instead of applying
            # the requested action. Initialization is orchestration, not an LLM
            # action, so no synthetic "initialize" step is sent.
            browser_state = _initial_simulated_browser_state(start_url)
            world_model_session_id = str(await world_model.ensure_session(task=goal, seed_state=browser_state))
            if not world_model_session_id:
                raise RuntimeError("WMH browser initialization omitted world_model_session_id")
            world_model.session_id = world_model_session_id
            init_frame = _static_simulated_browser_frame(browser_state)
            recorder = await SimulatedBrowserRecorder.create(
                agent_id=agent_id,
                task_id=task_id,
                session_id=world_model_session_id,
                frames=frames,
            )
            if recorder and recorder.frames:
                frames = recorder.frames
                latest_frame = normalize_simulated_browser_frame(recorder.frames[-1])
            await remember_frame(init_frame, step=0, label="Simulated website initialized", action_name="initialize")
            if browser_state.get("url"):
                visited_urls.append(str(browser_state["url"]))
            await save_browser_action_message(
                agent_id=agent_id,
                title=BROWSER_PROGRESS_TITLE,
                task_id=task_id,
                message="",
                status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url,
                action_type="browser",
                tool_call_id=tool_call_id,
                is_init_message=True,
                output_schema=output_schema,
                extra_metadata=_simulated_browser_message_metadata(
                    frame=latest_frame,
                    world_model_session_id=world_model_session_id,
                    world_model_name=world_model.world_model_name,
                ),
            )
        else:
            if not world_model_session_id:
                raise RuntimeError("Simulated browser resume omitted world_model_session_id")
            recorder = await SimulatedBrowserRecorder.create(
                agent_id=agent_id,
                task_id=task_id,
                session_id=world_model_session_id,
                frames=frames,
            )

        pending_action = resume.get("pending_action")
        if isinstance(pending_action, dict):
            pending_call_id = str(resume.get("simulated_pending_tool_call_id") or uuid_module.uuid4())
            approved_action_name = str(pending_action.get("action") or "unknown")
            approved_result, browser_state, approved_frame = await _execute_simulated_browser_transition(
                world_model=world_model,
                goal=goal,
                action=pending_action,
                browser_state=browser_state,
                tool_call_id=f"{pending_call_id}:approved",
                write_lock_enabled=write_lock_enabled,
                approved=True,
                approval_type=str(resume.get("approval_type") or "unknown"),
                payment_card_last4=payment_card_last4,
            )
            history_result = _browser_tool_result_for_history(approved_action_name, approved_result)
            if action_entries and action_entries[-1].get("step") == iteration:
                action_entries[-1].update(result=history_result, approved=True)
            current_url = str(browser_state.get("url") or "")
            if current_url and (not visited_urls or visited_urls[-1] != current_url):
                visited_urls.append(current_url)
            await remember_frame(
                approved_frame,
                step=iteration,
                label="Approved action applied",
                action_name=approved_action_name,
            )
            # The approval boundary pauses and resumes the Temporal activity. Persist
            # the resulting WMH state as its own trajectory event so evaluators,
            # recordings, and live clients can see that the approved action actually
            # executed. Without this event the policy saw the confirmation state, but
            # the durable trajectory ended at the pre-approval checkout page.
            await save_step(
                title=f"Approved {approved_action_name} applied",
                action_name=approved_action_name,
                action_call_id=f"{pending_call_id}:approved",
                step=iteration,
                message=json.dumps(
                    {
                        "action": approved_action_name,
                        "approved": True,
                        "browser_state": browser_state,
                        "success": approved_result.get("success", True),
                        "status": approved_result.get("status"),
                    },
                    ensure_ascii=False,
                    default=str,
                ),
            )

        while iteration < MAX_ITERATIONS:
            iteration += 1
            with contextlib.suppress(Exception):
                activity.heartbeat(f"Simulated browser step {iteration}")
            if recorder:
                await recorder.record_observation(
                    iteration=iteration,
                    browser_state=browser_state,
                    action_entries=action_entries,
                )
            browser_stream = BrowserThinkingStream(agent_id=agent_id, task_id=task_id, iteration=iteration)
            await browser_stream.start()
            rose_client.set_thinking_stream(browser_stream)
            try:
                llm_result = await _call_browser_use_with_rotation(
                    rose_client=rose_client,
                    task=task_prompt,
                    dynamic_system_context=dynamic_system_context,
                    turn_messages=turn_messages,
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
                    call_site=f"browser_use_simulated_step_{iteration}",
                    dump_extra={"browser_session_metadata": {"provider": "wmh", "simulated": True}},
                )
            finally:
                rose_client.set_thinking_stream(None)
                await browser_stream.finish()

            usage = llm_result.get("usage") or {}
            input_tokens = int(usage.get("prompt_tokens") or 0)
            output_tokens = int(usage.get("completion_tokens") or 0)
            total_input_tokens += input_tokens
            total_output_tokens += output_tokens
            accumulate_model_usage(
                usage_by_model,
                llm_result.get("actual_model"),
                input_tokens,
                output_tokens,
                cache_read_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
                cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
                from_fast_cache=bool(usage.get("from_fast_cache")),
            )
            action = dict(llm_result.get("action") or {})
            action_name = str(action.get("action") or "")
            thinking = str(action.get("thinking") or "")
            action_call_id = str(llm_result.get("tool_call_id") or uuid_module.uuid4())
            if not action_name:
                await browser_stream.finish_tools(status="ERROR")
                raise RuntimeError("Browser-use policy returned no action")
            if thinking:
                reasoning_messages.append(thinking)
                await save_browser_assistant_message(agent_id, thinking, task_id)
            action_summary.append(_summarize_browser_action_history_entry(action_name, action))
            action_summary[:] = action_summary[-20:]
            title_progress, title_done, resolved_name = build_action_titles(
                action_name, action, None, action.get("coordinates"), None
            )
            await save_step(
                title=title_progress,
                action_name=resolved_name,
                action_call_id=action_call_id,
                step=iteration,
                status=MessageStatus.IN_PROGRESS,
            )

            if action_name == "request_payment_card":
                from browser_tools.schemas import RequestPaymentCardBrowserTool

                params = dict(action.get("params") or {})
                RequestPaymentCardBrowserTool.model_validate({"tool": action_name, **params})
                result = {"success": True, "status": "awaiting_payment_card_approval"}
                action_entries.append(
                    {"step": iteration, "action": action_name, "thinking": thinking, "params": params, "result": result}
                )
                await save_step(
                    title=title_done,
                    action_name=action_name,
                    action_call_id=action_call_id,
                    step=iteration,
                )
                await browser_stream.finish_tools(status="FINISHED")
                return {
                    "status": "awaiting_payment_card_approval",
                    "payment_request": params,
                    "current_url": browser_state.get("url", ""),
                    "write_lock_approvals": write_lock_approvals,
                    "step_count": iteration,
                    "session_id": world_model_session_id,
                    "task_id": task_id,
                    "world_model_simulated": True,
                    **resume_payload(),
                }

            if action_name in {"attempt_completion", "done"}:
                completion_entry = {
                    "step": iteration,
                    "action": "attempt_completion",
                    "thinking": thinking,
                    "params": _browser_tool_arguments(action),
                    "result": {"success": True, "verification_requested": True},
                }
                action_entries.append(completion_entry)
                progress = await _verify_simulated_browser_completion(
                    goal=goal,
                    output_schema=output_schema,
                    browser_state=browser_state,
                    action_entries=action_entries,
                    frame=latest_frame,
                    payment_card_last4=payment_card_last4,
                    token_state=token_state,
                    agent_id=agent_id,
                    user_id=user_id,
                    gpt_token=gpt_token,
                    gpt_account_id=gpt_account_id,
                    gpt_token_source=gpt_token_source,
                    gpt_token_pool_id=gpt_token_pool_id,
                )
                structured = progress.get("structured_response")
                required = [
                    str(field.get("name"))
                    for field in output_schema.get("fields", [])
                    if isinstance(field, dict) and field.get("required") and field.get("name")
                ]
                missing = [name for name in required if not isinstance(structured, dict) or name not in structured]
                score = float(progress.get("score") or 0)
                reasoning = str(progress.get("reasoning") or "")
                if missing:
                    score = 0
                    reasoning = f"Verifier omitted required output fields: {', '.join(missing)}. {reasoning}".strip()
                if score >= 1:
                    completion_entry["result"] = {"success": True, "score": score}
                    await save_step(
                        title=title_done,
                        action_name="attempt_completion",
                        action_call_id=action_call_id,
                        step=iteration,
                        message=reasoning,
                    )
                    await browser_stream.finish_tools(status="FINISHED")
                    context_message = append_completion_evidence(
                        build_context_summary(
                            success=True,
                            close_reasoning=reasoning,
                            visited_urls=visited_urls,
                            reasoning_messages=reasoning_messages,
                            action_summary=action_summary,
                        ),
                        browser_url=str(browser_state.get("url") or ""),
                        structured_response=structured,
                    )
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="✓ Task Completed",
                        task_id=task_id,
                        message=context_message,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="task_complete",
                        tool_call_id=tool_call_id,
                        is_completion_message=True,
                        output_schema=output_schema,
                        extra_metadata={
                            **_simulated_browser_message_metadata(
                                frame=latest_frame,
                                world_model_session_id=world_model_session_id,
                                world_model_name=world_model.world_model_name,
                            ),
                            "structured_response": structured,
                            "steps_taken": iteration,
                        },
                    )
                    await finalize_recording()
                    return {
                        "status": "completed",
                        "success": True,
                        "message": context_message,
                        "browser_url": browser_url,
                        "current_url": browser_state.get("url", ""),
                        "task_id": task_id,
                        "session_id": world_model_session_id,
                        "world_model_session_id": world_model_session_id,
                        "world_model_name": world_model.world_model_name,
                        "world_model_simulated": True,
                        "simulated_browser_steps": iteration,
                        "simulated_latest_frame": latest_frame,
                        "structured_response": structured,
                        "execution_time_ms": (safe_time() - started_at) * 1000,
                        "usage_items": _simulated_browser_usage_items(
                            total_input_tokens,
                            total_output_tokens,
                            model_pricing,
                            usage_by_model,
                        ),
                    }
                rejection = {"success": False, "score": score, "reasoning": reasoning}
                completion_entry["result"] = rejection
                _append_browser_turn_messages(
                    turn_messages,
                    task=task_prompt,
                    browser_state=browser_state,
                    include_screenshot=False,
                    unified_action=action,
                    result=rejection,
                    tool_call_id=action_call_id,
                )
                await save_step(
                    title=f"⚖️ Verifier rejected ({score:.0%}) — continue task",
                    action_name="attempt_completion",
                    action_call_id=action_call_id,
                    step=iteration,
                    message=reasoning,
                )
                await browser_stream.finish_tools(status="ERROR")
                continue

            transition, next_state, next_frame = await _execute_simulated_browser_transition(
                world_model=world_model,
                goal=goal,
                action=action,
                browser_state=browser_state,
                tool_call_id=action_call_id,
                write_lock_enabled=write_lock_enabled,
                payment_card_last4=payment_card_last4,
            )
            requires_approval = bool(transition.get("requires_approval")) or str(
                transition.get("status") or ""
            ).lower() in {"awaiting_write_approval", "needs_write_approval"}
            history_result = _browser_tool_result_for_history(action_name, transition)
            action_entries.append(
                {
                    "step": iteration,
                    "action": action_name,
                    "thinking": thinking,
                    "params": _browser_tool_arguments(action),
                    "result": history_result,
                    "approval_required": requires_approval,
                }
            )
            _append_browser_turn_messages(
                turn_messages,
                task=task_prompt,
                browser_state=browser_state,
                include_screenshot=False,
                unified_action=action,
                result=history_result,
                tool_call_id=action_call_id,
            )
            browser_state = next_state
            current_url = str(browser_state.get("url") or "")
            if current_url and (not visited_urls or visited_urls[-1] != current_url):
                visited_urls.append(current_url)
            await remember_frame(next_frame, step=iteration, label=title_done, action_name=action_name)
            if requires_approval:
                approval_type = str(transition.get("approval_type") or "generic_write")
                question = _ground_simulated_browser_approval_question(
                    transition=transition,
                    browser_state=browser_state,
                    system_name=system_name,
                    approval_type=approval_type,
                )
                await save_step(
                    title=f"Approval required for {action_name}",
                    action_name=action_name,
                    action_call_id=action_call_id,
                    step=iteration,
                    message=question,
                )
                await browser_stream.finish_tools(status="FINISHED")
                return {
                    "status": "awaiting_write_approval",
                    "question": question,
                    "approval_type": approval_type,
                    "current_url": current_url,
                    "pending_action": action,
                    "simulated_pending_tool_call_id": action_call_id,
                    "write_lock_approvals": write_lock_approvals,
                    "step_count": iteration,
                    "session_id": world_model_session_id,
                    "task_id": task_id,
                    "world_model_simulated": True,
                    **resume_payload(),
                }
            await save_step(
                title=title_done,
                action_name=resolved_name,
                action_call_id=action_call_id,
                step=iteration,
                message=str(transition.get("message") or ""),
                status=MessageStatus.FINISHED if transition.get("success", True) else MessageStatus.ERROR,
            )
            await browser_stream.finish_tools(status="FINISHED" if transition.get("success", True) else "ERROR")
            if ACTION_LOOP_DELAY_SECONDS > 0:
                await asyncio.sleep(ACTION_LOOP_DELAY_SECONDS)

        await finalize_recording()
        return {
            "status": "max_iterations",
            "success": False,
            "message": f"Max iterations ({MAX_ITERATIONS}) reached",
            "task_id": task_id,
            "session_id": world_model_session_id,
            "world_model_simulated": True,
            "simulated_browser_steps": iteration,
            "simulated_latest_frame": latest_frame,
        }
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.error(
            "Simulated browser automation failed",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(exc),
            traceback=traceback.format_exc(),
        )
        with contextlib.suppress(Exception):
            await finalize_recording()
        return {
            "status": "failed",
            "success": False,
            "error": True,
            "message": f"Simulated browser automation failed: {extract_error_message(exc)}",
            "task_id": task_id,
            "session_id": world_model_session_id or None,
            "world_model_simulated": True,
            "simulated_browser_steps": iteration,
            "simulated_latest_frame": latest_frame,
        }


async def _publish_browser_session_metadata_message(
    *,
    agent_id: str,
    task_id: str,
    browser_url: str,
    browser_session_metadata: Dict[str, Any],
) -> None:
    """Persist required session provenance after CDP is operable.

    The browser-isolation evaluator and credential audit both consume this
    record, so unlike optional progress messages it must be acknowledged.
    """
    provider = browser_session_metadata.get("provider")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("Required browser session metadata must include a non-empty provider")
    max_attempts = 3
    tool_call_id = str(uuid_module.uuid4())
    for attempt in range(1, max_attempts + 1):
        accepted = await save_browser_action_message(
            agent_id=agent_id,
            title="Browser session ready",
            task_id=task_id,
            message="Browser session connected and ready.",
            status=MessageStatus.FINISHED,
            browser_url=browser_url,
            action_type="session_init",
            tool_call_id=tool_call_id,
            extra_metadata={"browser_session_metadata": dict(browser_session_metadata)},
        )
        if accepted:
            return
        if attempt < max_attempts:
            logger.warning(
                "Retrying required browser session metadata persistence",
                attempt=attempt,
                max_attempts=max_attempts,
            )
            await asyncio.sleep(0.25 * (2 ** (attempt - 1)))
    raise RuntimeError("Backend did not acknowledge required browser session metadata after 3 attempts")


async def _spawn_browser_agent_activity_v3_real(  # noqa: C901
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
    fast_mode_cache_enabled: bool = False,
) -> Dict[str, Any]:
    """Browser agent activity using browser-use BrowserSession + Rose API."""
    structlog.contextvars.bind_contextvars(agent_id=agent_id)
    if fast_mode_cache_enabled:
        logger.info(
            "Browser Fast Mode cache disabled; ignoring requested browser fast_mode_cache_enabled",
            agent_id=agent_id,
            task_id=task_id,
        )
    fast_mode_cache_enabled = False

    from browser_tools.dom_service import ActionHistory, DOMService
    from browser_tools.humanizer import BrowserHumanizer
    from helpers.llm import check_progress

    dom_service = None
    input_page = None
    playwright_browser = None
    playwright_instance = None
    playwright_driver_pid: Optional[int] = None
    humanizer = None
    browser_recorder: Optional[BrowserAgentRecorder] = None
    browser_network_recorder: Optional[BrowserNetworkRecorder] = None
    network_recorder_task: Optional[asyncio.Task] = None
    interaction_layer_task: Optional[asyncio.Task] = None
    cursor_streamer: Optional[BrowserCursorRealtimeStreamer] = None
    action_history = ActionHistory()
    browser_url = None
    current_url = ""
    latest_structured_response: Optional[Dict[str, Any]] = None
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
            logger.info(
                "[ClaudeAuth] No token available, falling back to waterfall",
                user_id=user_id,
            )
            browser_use_mode = None

    total_input_tokens = 0
    total_output_tokens = 0
    # Per-ACTUAL-model token ledger. The browser pool races several underlying
    # models at different prices, and `-claude`/`-gpt` steps ran on the user's
    # own compute token ($0). Usage rows are emitted per entry here so the
    # workflow prices each model correctly instead of collapsing everything
    # onto the pool constant.
    usage_by_model: Dict[str, Dict[str, int]] = {}
    visited_urls: List[str] = []
    reasoning_messages: List[str] = []
    action_summary: List[str] = []
    write_lock_approvals: Dict[str, Dict] = {}
    auth_realm = auth_realm_from_url(start_url)
    verifier_checkpoints: List[Dict[str, Any]] = []
    # Eventim checkaddtocart POST can keep returning 403 challenge HTML while the
    # document GET looks clean — cookie-stage recovery then false-succeeds forever.
    # After one cookies_sanitized result, escalate subsequent recoveries to config search.
    cookie_recovery_successes = 0
    # Sticky hard filter: once a critical third-party resource block triggered
    # recovery on this task, later recoveries still re-verify that URL.
    require_payment_cdn = False
    payment_cdn_verify_url = ""
    # After a successful challenge recovery, pin goto/navback to the recovered
    # host so the model cannot leave the cleared page for network-log thrash.
    navigation_pin_host: Optional[str] = None
    navigation_pin_url: Optional[str] = None
    handoff_payment_fill_attempts = 0
    handoff_payment_fill_succeeded = False
    HANDOFF_PAYMENT_FILL_MAX_ATTEMPTS = 8
    # Session origin registrable domain — when the live page leaves this domain
    # (Place order / OAuth / 3DS handoff), navigation sticks to the live host
    # without path or product-name allowlists.
    _start_domain = get_domain_from_url(start_url) if start_url else ""
    navigation_origin_base_domain: Optional[str] = (
        _get_base_domain(_start_domain) if _start_domain else None
    )

    pending_write_lock_action: Optional[Dict[str, Any]] = None
    pending_write_lock_target: Optional[Dict[str, Any]] = None
    resume_step_count: int = 0
    auth_assistance_resume_mode: Optional[str] = None
    resume_user_messages: List[Dict[str, str]] = []
    payment_card_last4: Optional[str] = None
    if write_lock_resume_state:
        pending_write_lock_action = write_lock_resume_state.get("pending_action")
        pending_write_lock_target = write_lock_resume_state.get("pending_action_target")
        write_lock_approvals = dict(write_lock_resume_state.get("write_lock_approvals") or {})
        resume_step_count = write_lock_resume_state.get("step_count", 0)
        session_id = write_lock_resume_state.get("session_id") or session_id
        cdp_url = write_lock_resume_state.get("cdp_url") or cdp_url
        auth_realm = write_lock_resume_state.get("auth_realm") or auth_realm
        payment_card_last4 = _normalize_payment_card_last4(write_lock_resume_state.get("payment_card_last4"))
        action_history.restore_entries(write_lock_resume_state.get("action_history"))
        visited_urls = [
            str(url) for url in (write_lock_resume_state.get("visited_urls") or []) if isinstance(url, str) and url
        ][-30:]
        verifier_checkpoints = [
            checkpoint
            for checkpoint in (write_lock_resume_state.get("verifier_checkpoints") or [])
            if isinstance(checkpoint, dict) and checkpoint.get("dom_tree")
        ][-3:]
        # H-06 heal: payment-card resume must unlock the merchant domain. Older
        # grants keyed Kernel live-view hosts (*.kernel.sh / *.onkernel.com);
        # re-resolve from start_url / visited merchant URLs when needed.
        if write_lock_resume_state.get("approval_type") == "payment" and (
            write_lock_resume_state.get("payment_card_refs") or payment_card_last4
        ):
            merchant_grant_url = resolve_site_write_lock_grant_url(
                {
                    "start_url": start_url,
                    "visited_urls": visited_urls,
                    "current_url": "",
                }
            )
            merchant_domain = get_domain_from_url(merchant_grant_url)
            site_entry = write_lock_approvals.get(SITE_WRITE_LOCK_APPROVAL_KEY) or {}
            if merchant_domain and site_entry.get("domain") != merchant_domain:
                write_lock_approvals = grant_site_write_lock_approvals(
                    write_lock_approvals,
                    merchant_grant_url,
                    time.time(),
                )
                logger.info(
                    "Browser payment site write-lock unlock healed on resume",
                    agent_id=agent_id,
                    task_id=task_id,
                    grant_url=merchant_grant_url,
                    unlock_domain=merchant_domain,
                    prior_domain=site_entry.get("domain"),
                )
        if write_lock_resume_state.get("approval_type") == "auth_assistance":
            resume_user_messages.append(
                build_auth_assistance_resume_user_message(
                    auth_realm=auth_realm,
                    handoff_mode=write_lock_resume_state.get("handoff_mode"),
                )
            )
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
    logger.info(
        "Using response schema from tool call",
        fields=len(response_schema.get("fields", [])),
    )

    session_passwords: List[Dict[str, Any]] = []
    session_passkeys: List[Dict[str, Any]] = []
    session_auth_options: Optional[Dict[str, Any]] = None
    session_credential_ref: Optional[Dict[str, Any]] = None
    browser_session_metadata: Dict[str, Any] = {}

    # Decouple the Temporal heartbeat from the main loop. A bot-challenge (e.g.
    # Cloudflare Turnstile proof-of-work) can CPU-freeze the page renderer — and
    # therefore every CDP call (get_browser_state, screenshots) — for 90-260s.
    # While the main loop is blocked on a hung CDP await it cannot reach
    # activity.heartbeat(), so without this the activity would hit
    # HEARTBEAT_TIMEOUT_SECONDS and Temporal would kill it mid-challenge — exactly
    # the prod failure on agent 9ec05898. This background task keeps heartbeating
    # at a fixed cadence regardless of what the main loop is blocked on.
    _hb_stop = asyncio.Event()

    async def _background_heartbeat() -> None:
        while not _hb_stop.is_set():
            with contextlib.suppress(Exception):
                activity.heartbeat("browser keepalive (renderer/CDP may be blocked by a bot-challenge)")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(_hb_stop.wait(), timeout=HEARTBEAT_KEEPALIVE_SECONDS)

    _heartbeat_task = asyncio.create_task(_background_heartbeat())
    action_entries: List[Dict[str, Any]] = []
    browser_state: Dict[str, Any] = {}
    browser_turn_messages: List[Dict[str, Any]] = []
    otp_user_messages: List[Dict[str, str]] = []
    seen_otp_codes: set[str] = set()
    available_file_paths: Dict[str, str] = {}
    passkey_ref_by_credential_id: Dict[str, Dict[str, str]] = {}
    # Every decrypted passkey we have ever seeded on the virtual authenticator,
    # keyed by credentialId. The CDP virtual authenticator is scoped to the live
    # target, so any target reset (proxy rotation / challenge recovery) hands us a
    # fresh, empty authenticator. Retaining the union of seeded credentials lets a
    # single helper re-seed the new target the same way bootstrap does — so
    # passkeys are restored on reset exactly like cookies/localStorage, instead of
    # being the one injected surface that silently vanishes.
    seeded_decrypted_passkeys_by_credential_id: Dict[str, Dict[str, Any]] = {}
    recorded_passkey_credential_ids: set[str] = {
        credential_id
        for credential_id in (write_lock_resume_state or {}).get("recorded_passkey_credential_ids", [])
        if isinstance(credential_id, str) and credential_id
    }

    async def record_passkey_usage_once() -> None:
        if dom_service is None:
            return
        # Any browser action can navigate (links, forms, redirects, history),
        # and Kernel may reset the target-scoped WebAuthn environment at that
        # boundary. Revalidate before every counter poll so the next agent
        # interaction always sees the held credentials on a live authenticator.
        await sync_passkeys_onto_target(context="before passkey usage readback")
        await record_used_passkey_credentials(
            dom_service=dom_service,
            passkey_ref_by_credential_id=passkey_ref_by_credential_id,
            recorded_credential_ids=recorded_passkey_credential_ids,
            agent_id=agent_id,
            task_id=task_id,
            browser_url=browser_url or "",
        )

    async def sync_passkeys_onto_target(
        new_passkeys: Optional[List[Dict[str, Any]]] = None,
        *,
        context: str,
    ) -> int:
        """Seed the current target's virtual authenticator with every passkey we hold.

        The single choke point for passkey injection. Called at session bootstrap
        and on each realm transition with that realm's freshly-decrypted passkeys
        (`new_passkeys`), and on target reset (proxy rotation) with no new payload
        to re-seed the union onto the fresh authenticator. `inject_passkeys` dedups
        per target instance, so re-calling with the full union is idempotent on an
        existing target and a full restore on a new one.
        """
        if dom_service is None:
            return 0
        for pk in new_passkeys or []:
            credential_id = pk.get("credentialId")
            if credential_id:
                seeded_decrypted_passkeys_by_credential_id[credential_id] = pk
        if not seeded_decrypted_passkeys_by_credential_id:
            return 0
        injected = await dom_service.inject_passkeys(list(seeded_decrypted_passkeys_by_credential_id.values()))
        logger.info(
            "Seeded cloud-custody passkeys onto browser virtual authenticator",
            count=injected,
            held=len(seeded_decrypted_passkeys_by_credential_id),
            context=context,
        )
        return injected

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
        # Current backends return auth_options from the same realm-preparation
        # boundary as cookies/passwords/passkeys. Keep the fallback below for a
        # rolling deployment where an older backend response omits it.
        auth_options_prefetch: Optional[asyncio.Task] = None
        logger.info(
            "Session init check",
            is_resume=is_resume,
            task_id=task_id,
            has_write_lock_resume_state=write_lock_resume_state is not None,
        )
        if is_resume and task_id:
            is_auth_assistance_resume = (
                write_lock_resume_state is not None
                and write_lock_resume_state.get("approval_type") == "auth_assistance"
            )
            if is_auth_assistance_resume:
                logger.info(
                    "Resuming auth-assistance browser task via existing browser session",
                    task_id=task_id,
                )
                session_info = await fetch_session_info(config, task_id, validate_live=True)
                expected_session_id = write_lock_resume_state.get("session_id") if write_lock_resume_state else None
                current_session_id = session_info.get("session_id")
                session_was_refreshed = (
                    expected_session_id is not None
                    and current_session_id is not None
                    and current_session_id != expected_session_id
                )
                # The browser task id is the stable ownership boundary. The auth
                # handoff page may refresh an expired provider session before the
                # user signs in, updating this task to a new live session while
                # the paused worker still holds the old provider session id.
                # Requiring those ephemeral ids to match would discard the
                # authenticated browser and launch a second profile writer.
                same_session_available = session_info.get("same_session_available") is True
                if same_session_available:
                    resume_mode = "backend_refreshed_session" if session_was_refreshed else "same_steel_session"
                    session_info["resume_mode"] = resume_mode
                    auth_assistance_resume_mode = resume_mode
                    logger.info(
                        "Reconnecting to live browser session after auth assistance",
                        task_id=task_id,
                        session_id=current_session_id,
                        previous_session_id=expected_session_id if session_was_refreshed else None,
                        session_was_refreshed=session_was_refreshed,
                    )
                else:
                    unavailable_reason = session_info.get("same_session_unavailable_reason")
                    logger.warning(
                        "Existing browser session unavailable after auth assistance; creating replacement session",
                        task_id=task_id,
                        session_id=current_session_id,
                        expected_session_id=expected_session_id,
                        reason=unavailable_reason,
                    )
                    _session_wait_start = time.monotonic()
                    while True:
                        session_info = await resume_browser_session(config, task_id)
                        if not session_info.get("rate_limited"):
                            break
                        _elapsed = time.monotonic() - _session_wait_start
                        if _elapsed > SESSION_MAX_WAIT_SECONDS:
                            raise Exception(f"Browser session unavailable after {int(_elapsed)}s (provider rate limit)")
                        logger.info(
                            "Browser provider rate limited during replacement auth-assistance resume",
                            elapsed_s=int(_elapsed),
                            retry_in=SESSION_RETRY_INTERVAL_SECONDS,
                        )
                        activity.heartbeat(f"Waiting to resume browser availability ({int(_elapsed)}s)")
                        await asyncio.sleep(SESSION_RETRY_INTERVAL_SECONDS)
                    session_info["resume_mode"] = "new_steel_session_after_unavailable"
                    session_info["same_session_unavailable_reason"] = unavailable_reason
                    auth_assistance_resume_mode = "new_steel_session_after_unavailable"
            else:
                logger.info("\U0001f50d Fetching session info for resumed task", task_id=task_id)
                session_info = await fetch_session_info(config, task_id, validate_live=True)
                if session_info.get("same_session_available") is not True:
                    unavailable_reason = session_info.get("same_session_unavailable_reason")
                    logger.warning(
                        "Existing Steel session unavailable for browser resume; creating replacement session",
                        task_id=task_id,
                        session_id=session_info.get("session_id"),
                        reason=unavailable_reason,
                    )
                    _session_wait_start = time.monotonic()
                    while True:
                        session_info = await resume_browser_session(config, task_id)
                        if not session_info.get("rate_limited"):
                            break
                        _elapsed = time.monotonic() - _session_wait_start
                        if _elapsed > SESSION_MAX_WAIT_SECONDS:
                            raise Exception(
                                f"Browser session unavailable after {int(_elapsed)}s (rate limited by Steel)"
                            )
                        logger.info(
                            "Steel rate limited during replacement browser resume",
                            elapsed_s=int(_elapsed),
                            retry_in=SESSION_RETRY_INTERVAL_SECONDS,
                        )
                        activity.heartbeat(f"Waiting to resume browser availability ({int(_elapsed)}s)")
                        await asyncio.sleep(SESSION_RETRY_INTERVAL_SECONDS)
                    session_info["resume_mode"] = "new_steel_session_after_unavailable"
                    session_info["same_session_unavailable_reason"] = unavailable_reason
            session_id = session_info.get("session_id")
            browser_url = session_info.get("debug_url")
            cdp_url = session_info.get("ws_url")
            fingerprint_injection = session_info.get("fingerprint_injection")
            session_passwords = session_info.get("passwords", [])
            session_passkeys = session_info.get("passkeys", [])
            session_auth_options = session_info.get("auth_options")
            session_credential_ref = session_info.get("credential_ref") or session_info.get("auth_credential_ref")
            browser_session_metadata = session_info.get("browser_session_metadata") or {}
            user_profile, auth_realm = _resume_context_from_session_info(session_info, auth_realm)
            activity.heartbeat(f"Resuming task {task_id}")
        else:
            activity.heartbeat("Initializing browser session")
            _session_wait_start = time.monotonic()
            _waiting_msg_sent = False
            _transient_init_attempts = 0

            while True:
                session_data = await init_browser_session(config, user_id, agent_id, start_url)

                # Transient provider infra failure (e.g. Kernel allocated an
                # unhealthy proxy: "400 Proxy is marked unavailable"). A fresh init
                # reallocates a different proxy, so retry a bounded number of times
                # with a short delay before giving up loudly.
                if session_data.get("transient_init_failure"):
                    _transient_init_attempts += 1
                    if _transient_init_attempts > SESSION_INIT_TRANSIENT_MAX_ATTEMPTS:
                        raise Exception(
                            "Browser session init failed after "
                            f"{_transient_init_attempts} transient-proxy retries: "
                            f"{session_data.get('detail')}"
                        )
                    logger.warning(
                        "Transient browser session init failure; retrying with a fresh proxy",
                        agent_id=agent_id,
                        attempt=_transient_init_attempts,
                        status_code=session_data.get("status_code"),
                        detail=session_data.get("detail"),
                    )
                    activity.heartbeat(
                        f"Retrying browser init after transient proxy failure ({_transient_init_attempts})"
                    )
                    await asyncio.sleep(SESSION_INIT_TRANSIENT_RETRY_SECONDS)
                    continue

                if not session_data.get("rate_limited"):
                    break

                _elapsed = time.monotonic() - _session_wait_start
                if _elapsed > SESSION_MAX_WAIT_SECONDS:
                    raise Exception(f"Browser session unavailable after {int(_elapsed)}s (provider rate limit)")

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
                    "Browser provider rate limited, waiting for browser slot",
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
            session_passkeys = session_data.get("passkeys", [])
            session_auth_options = session_data.get("auth_options")
            session_credential_ref = session_data.get("credential_ref") or session_data.get("auth_credential_ref")
            browser_session_metadata = session_data.get("browser_session_metadata") or {}
            user_profile = session_data.get("user_settings") or {}
        _record_timing("session_init", t_session)

        if not cdp_url:
            raise RuntimeError("No CDP URL provided - backend must return provider ws_url")

        t_auth = time.monotonic()
        auth_options = session_auth_options or {}
        if auth_options.get("realm"):
            auth_realm = auth_options["realm"]
        if not auth_options and auth_options_prefetch is not None:
            auth_options = await auth_options_prefetch
            auth_realm = auth_options.get("realm") or auth_realm
        elif not auth_options and auth_realm:
            auth_options = await fetch_auth_options(config, user_id, auth_realm)
            auth_realm = auth_options.get("realm") or auth_realm
        elif not auth_options:
            auth_options = {"realm": "this site"}
        if auth_options_prefetch is not None:
            if not auth_options_prefetch.done():
                auth_options_prefetch.cancel()
            elif not auth_options_prefetch.cancelled() and auth_options_prefetch.exception() is not None:
                # Retrieve the unused prefetch failure so asyncio doesn't log
                # "exception was never retrieved" (session already had auth_options).
                logger.debug(
                    "Unused auth_options prefetch failed",
                    error=extract_error_message(auth_options_prefetch.exception()),
                )
        auth_runtime_state = AuthRuntimeState.from_auth_options(auth_options)
        minted_option = auth_options.get("minted") or {}
        minted_account_label = (
            minted_option.get("email")
            or minted_option.get("agentEmail")
            or minted_option.get("agent_email")
            or minted_option.get("accountLabel")
            or minted_option.get("account_label")
        )
        minted_phone_label = (
            minted_option.get("phone") or minted_option.get("agentPhone") or minted_option.get("agent_phone")
        )
        minted_account_labels = {
            str(label).strip().lower() for label in (minted_account_label, minted_phone_label) if label
        }
        minted_primary_label = minted_account_label or minted_phone_label
        minted_credential_ref = (
            {
                "kind": "minted_account",
                "id": str(minted_option.get("id") or minted_primary_label),
            }
            if minted_option and minted_primary_label
            else None
        )
        _record_timing("auth_options", t_auth)

        activity.heartbeat(f"Connecting via CDP: {cdp_url[:50]}...")

        # ===== PHASE 2: PARALLEL SETUP =====
        t_parallel = time.monotonic()

        async def _setup_browser():
            """Connect DOMService + Playwright, apply fingerprint, init humanizer."""
            nonlocal playwright_driver_pid
            _disable_cdp_websocket_proxy()
            connection_cdp_url = steel_cdp_connection_url(cdp_url)
            _dom_service = DOMService(cdp_url=connection_cdp_url)
            _playwright_instance = None
            _playwright_browser = None

            async def _connect_dom():
                t = time.monotonic()
                await _dom_service.connect()
                _record_timing("parallel.browser.dom_connect", t)
                logger.info("\U0001f310 Connected to browser via CDP")
                return await _dom_service.session.get_current_page()

            async def _connect_playwright():
                """Connect Playwright, then apply everything that only needs the
                Playwright side (fast-mode route, botsigged diagnostics,
                fingerprint injection) while DOMService is still attaching."""
                nonlocal _playwright_browser, _playwright_instance, playwright_driver_pid
                t = time.monotonic()
                from playwright.async_api import async_playwright

                _pw_instance = await async_playwright().start()
                _playwright_instance = _pw_instance
                playwright_driver_pid = getattr(_playwright_driver_process(_pw_instance), "pid", None)
                try:
                    _pw_browser = await _pw_instance.chromium.connect_over_cdp(connection_cdp_url)
                except BaseException:
                    _driver_process = _playwright_driver_process(_pw_instance)
                    with contextlib.suppress(Exception):
                        await _pw_instance.stop()
                    await _reap_playwright_driver_process(_driver_process, agent_id)
                    _playwright_instance = None
                    raise
                _playwright_browser = _pw_browser
                _record_timing("parallel.browser.playwright_connect", t)
                _pw_context = _pw_browser.contexts[0]
                _pw_page = _pw_context.pages[0]

                # Fast Mode: replay uses a Playwright route; write-through records via a
                # response listener only (routing every request breaks Stripe Elements).
                fast_mode_write_through = write_through_enabled_for_user(user_id)
                if goal and (fast_mode_cache_enabled or fast_mode_write_through):
                    await _install_fast_mode_network_cache(
                        _pw_context,
                        goal,
                        read_enabled=fast_mode_cache_enabled,
                        write_enabled=fast_mode_cache_enabled or fast_mode_write_through,
                    )

                if _botsigged_diagnostics_enabled(start_url):
                    await _install_botsigged_diagnostics(_pw_page, agent_id=agent_id, task_id=task_id)

                t = time.monotonic()
                fingerprint_injection_enabled = _env_enabled("BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED", True)
                if fingerprint_injection and fingerprint_injection_enabled:
                    from helpers.fingerprint_injection import apply_fingerprint_injection

                    injection_success = await apply_fingerprint_injection(_pw_page, fingerprint_injection)
                    if injection_success:
                        logger.info(
                            "\U0001f510 Applied fingerprint injection via CDP (Sec-CH-UA-Platform, init scripts)"
                        )
                    else:
                        logger.warning(
                            "\u26a0\ufe0f Failed to apply fingerprint injection - browser may leak real fingerprint"
                        )
                elif fingerprint_injection and not fingerprint_injection_enabled:
                    logger.info("\U0001f510 Browser-agent fingerprint injection disabled by env")
                else:
                    logger.info("\U0001f510 No fingerprint injection data provided - using provider defaults")
                _record_timing("parallel.browser.fingerprint", t)

                return _pw_instance, _pw_browser, _pw_context, _pw_page

            try:
                if _env_enabled("BROWSER_AGENT_PARALLEL_CDP_CONNECT", False):
                    # The DOMService (browser-use) and Playwright connections
                    # are independent CDP websockets. Keep this as an opt-in
                    # fast path; default to sequential attach because Steel can
                    # reject concurrent initial CDP handshakes under load.
                    (
                        _dom_page,
                        (_playwright_instance, _playwright_browser, _playwright_context, _input_page),
                    ) = await asyncio.gather(_connect_dom(), _connect_playwright())
                else:
                    _dom_page = await _connect_dom()
                    (
                        _playwright_instance,
                        _playwright_browser,
                        _playwright_context,
                        _input_page,
                    ) = await _connect_playwright()
            except BaseException:
                with contextlib.suppress(Exception):
                    await _dom_service.disconnect()
                await _stop_playwright_resources(
                    _playwright_browser,
                    _playwright_instance,
                    agent_id,
                    driver_pid=playwright_driver_pid,
                )
                raise

            return (
                _dom_service,
                _dom_page,
                _input_page,
                _playwright_browser,
                _playwright_instance,
            )

        async def _process_data():
            """Save init messages + process user data (no browser needed)."""
            if not is_resume:
                t = time.monotonic()
                await save_browser_action_message(
                    agent_id=agent_id,
                    title=BROWSER_PROGRESS_TITLE,
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
            _user_context_sections = build_browser_user_profile_sections(user_profile)

            _autopay_section = ""
            encrypted_payment = user_profile.get("encryptedPaymentInformation")
            if encrypted_payment and config.payment.decryption_key:
                payment_data = decrypt_payment_info(encrypted_payment, config.payment.decryption_key)
                if payment_data:
                    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
                    if autopay_limit_cents > 0:
                        _autopay_section = build_autopay_prompt_section(payment_data, encrypted_payment)
                        _user_context_sections.append(_autopay_section.strip())
                    else:
                        _user_context_sections.append(
                            "## Payment Authorization\n"
                            f"Autopay DISABLED. {PAYMENT_CARD_ENTRY_RULE} "
                            "If new card details are required, include the full itemized receipt when calling it."
                        )
            else:
                _user_context_sections.append(
                    "## Payment Authorization\n"
                    f"{PAYMENT_CARD_ENTRY_RULE} If new card details are required, extract the full itemized "
                    "receipt and include it when calling request_payment_card. "
                    "Never ask the user to type a payment card into chat."
                )
            _user_context_sections.append(
                "## Purchase Approval Context\n"
                "Before triggering any Buy, Place Order, or other purchase write action, collect every item's "
                "canonical product-detail URL, numeric rating, and numeric review count. Never use a cart or "
                "checkout URL as the product link. A purchase approval is blocked if any item lacks these fields."
            )
            _record_timing("parallel.data.user_profile", t)

            t = time.monotonic()
            if session_passwords:
                logger.info(f"Loaded {len(session_passwords)} passwords from session response")
            _realm_credential_state = await build_realm_credential_state(
                {
                    "auth_realm": auth_realm,
                    "auth_options": auth_options,
                    "passwords": session_passwords,
                    "passkeys": session_passkeys,
                    "auth_credential_ref": session_credential_ref,
                },
                decryption_key=config.payment.decryption_key,
            )
            _auth_options_section = _realm_credential_state.auth_options_section
            _password_origins = _realm_credential_state.password_origins
            _credential_refs_by_secret_ref = _realm_credential_state.credential_refs_by_secret_ref

            _secret_refs: Dict[str, str] = {}
            payment_card_refs = (write_lock_resume_state or {}).get("payment_card_refs") or {}
            for ref in ("card_number", "card_name", "card_expiry", "card_cvv"):
                value = payment_card_refs.get(ref)
                if value:
                    _secret_refs[ref] = value
            _payment_card_resume_section = build_payment_card_resume_prompt_section(payment_card_refs)
            if _payment_card_resume_section:
                _user_context_sections.append(_payment_card_resume_section.strip())
            _secret_refs.update(_realm_credential_state.password_secret_refs)

            logger.info(
                "Built secret refs for type interception",
                card_refs_count=len(payment_card_refs),
                password_refs_count=len([k for k in _secret_refs if k not in payment_card_refs]),
                attemptable_password_count=len(_realm_credential_state.password_secret_refs),
            )
            _record_timing("parallel.data.passwords", t)

            t = time.monotonic()
            _user_context_section = (
                "\n\n# User Context\n\n" + "\n\n".join(_user_context_sections) if _user_context_sections else ""
            )
            _base_custom_instructions = _user_context_section + "\n\n" + _auth_options_section
            _model_pricing = await get_model_pricing_with_fallback(BROWSER_USE_PRICING_POOL)
            _record_timing("parallel.data.instructions", t)

            return (
                _user_context_section,
                _autopay_section,
                payment_card_refs,
                _auth_options_section,
                _credential_refs_by_secret_ref,
                _secret_refs,
                _password_origins,
                _base_custom_instructions,
                _model_pricing,
                _realm_credential_state,
            )

        browser_result, data_result = await asyncio.gather(
            _setup_browser(),
            _process_data(),
        )
        _record_timing("parallel_setup_total", t_parallel)

        (
            dom_service,
            dom_page,
            input_page,
            playwright_browser,
            playwright_instance,
        ) = browser_result
        # Required session provenance is emitted only after both CDP clients
        # connect, but before any credential-use evidence can be published.
        # It is intentionally independent of optional browser recording.
        await _publish_browser_session_metadata_message(
            agent_id=agent_id,
            task_id=task_id or tool_call_id,
            browser_url=browser_url or "",
            browser_session_metadata=browser_session_metadata,
        )
        if session_credential_ref and task_id:
            await save_browser_credential_ref_message(
                agent_id=agent_id,
                task_id=task_id,
                message="Browser session credential applied at session start.",
                role="TOOL",
                tool_name="browser_session_auth",
                credential_ref=session_credential_ref,
            )
        input_page = await _synchronize_playwright_page_with_agent_focus(
            dom_service=dom_service,
            playwright_browser=playwright_browser,
            current_page=input_page,
        )
        recording_output_dir = browser_recording_output_dir(agent_id, task_id) if task_id else None

        async def _create_network_recorder():
            if not recording_output_dir:
                return None
            recorder = await BrowserNetworkRecorder.create(
                browser_session=dom_service.session,
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
                output_dir=recording_output_dir,
            )
            if recorder and recorder.persists_network_log and task_id:
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser network recording started",
                    task_id=task_id,
                    message=f"Local browser network log will be saved: {recorder.network_dir / 'index.json'}",
                    status=MessageStatus.IN_PROGRESS,
                    browser_url=browser_url,
                    action_type="network_recording",
                    tool_call_id=str(uuid_module.uuid4()),
                    extra_metadata={"network_recording_path": str(recorder.network_dir / "index.json")},
                )
            return recorder

        # Dev-only network recorder: its CDP session + Network.enable round trips
        # can take seconds and nothing downstream needs it synchronously, so it
        # attaches in the background (resolved before session close).
        network_recorder_task = asyncio.create_task(_create_network_recorder())

        async def _init_humanizer():
            if not _env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True):
                logger.info("\U0001f916 BrowserHumanizer disabled by env; using browser-use input events")
                return None
            _humanizer = BrowserHumanizer(dom_page=dom_page, input_page=input_page, fast=False)
            await _humanizer.initialize_cursor(start_pos=(640, 400))
            logger.info("\U0001f916 BrowserHumanizer initialized (browser-use for DOM, Playwright for input)")
            return _humanizer

        def observe_cursor(x: int, y: int) -> None:
            if browser_recorder:
                browser_recorder.set_cursor(x, y)
            if cursor_streamer:
                cursor_streamer.set_cursor(x, y)

        async def _setup_interaction_layer():
            """Humanizer + screenshot recorder (dev-only) + logo hijack.

            Independent of each other AND of the start-URL navigation (which
            only requires fingerprint/cookies/passkeys to be in place), so this
            runs concurrently with the navigation and both are awaited before
            the warm-up scroll / agent loop.
            """
            nonlocal humanizer, browser_recorder, cursor_streamer
            t = time.monotonic()
            humanizer, browser_recorder, _ = await asyncio.gather(
                _init_humanizer(),
                BrowserAgentRecorder.create(
                    page=input_page,
                    agent_id=agent_id,
                    task_id=task_id,
                    session_id=session_id,
                    browser_url=browser_url,
                    session_metadata=browser_session_metadata,
                ),
                _apply_logo_hijack(dom_service),
            )
            _record_timing("humanizer_recorders_logo", t)
            cursor_streamer = BrowserCursorRealtimeStreamer(agent_id=agent_id, task_id=task_id)

            if humanizer:
                humanizer.set_cursor_observer(observe_cursor)
                humanizer.start_idle_movement()
            if browser_recorder and task_id:
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser recording started",
                    task_id=task_id,
                    message=f"Local browser recording will be saved: {browser_recorder.output_dir / 'index.html'}",
                    status=MessageStatus.IN_PROGRESS,
                    browser_url=browser_url,
                    action_type="recording",
                    tool_call_id=str(uuid_module.uuid4()),
                    extra_metadata={
                        "recording_path": str(browser_recorder.output_dir / "index.html"),
                        "browser_session_metadata": browser_session_metadata,
                    },
                )

        interaction_layer_task = asyncio.create_task(_setup_interaction_layer())

        (
            user_context_section,
            autopay_section,
            card_refs,
            auth_options_section,
            credential_refs_by_secret_ref,
            secret_refs,
            password_origins,
            base_custom_instructions,
            model_pricing,
            initial_realm_credential_state,
        ) = data_result

        # Use the same fail-closed worker hydration path at session start and
        # on every later realm transition.
        auth_options = initial_realm_credential_state.auth_options
        auth_runtime_state = initial_realm_credential_state.auth_runtime_state
        passkey_ref_by_credential_id.update(initial_realm_credential_state.passkey_ref_by_credential_id)
        if initial_realm_credential_state.decrypted_passkeys:
            await sync_passkeys_onto_target(
                initial_realm_credential_state.decrypted_passkeys,
                context="session start",
            )

        # ===== PHASE 3: POST-SETUP =====
        t_post = time.monotonic()

        # Upload attachments
        if attachments:
            t = time.monotonic()
            logger.info(f"\U0001f4ce Uploading {len(attachments)} attachments to browser session")
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
                        config,
                        session_id,
                        filename,
                        file_content,
                        fp.get("mime_type", "application/octet-stream"),
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

        _record_timing("post_setup_total", t_post)

        # ===== PHASE 4: NAVIGATION =====
        t_nav = time.monotonic()
        if not write_lock_resume_state:
            from browser_use.browser.events import NavigateToUrlEvent

            nav_url = start_url
            if not nav_url.startswith(("http://", "https://", "about:", "file:")):
                nav_url = f"https://{nav_url}"
                logger.info(f"\U0001f517 Auto-added https:// to start URL: {nav_url}")

            async def _navigate_to_start_url():
                t = time.monotonic()
                event = dom_service.session.event_bus.dispatch(NavigateToUrlEvent(url=nav_url, wait_until="commit"))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)
                ready_state = await _wait_for_document_ready(dom_service)
                logger.info(f"\U0001f310 Start URL readiness: {ready_state}")
                _record_timing("navigation.navigate", t)

            # The "Navigating" progress message is pure bookkeeping \u2014 write it
            # while the navigation is already underway.
            await asyncio.gather(
                _navigate_to_start_url(),
                save_browser_action_message(
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
                ),
            )

            async def _mark_navigated():
                if browser_recorder:
                    await browser_recorder.mark(f"Navigated -> {nav_url[:80]}", action="goto")

            async def _wait_for_start_url_ready():
                t = time.monotonic()
                await wait_for_navigation_ready(dom_service, url=nav_url)
                _record_timing("navigation.wait_ready", t)

            await asyncio.gather(
                _wait_for_start_url_ready(),
                save_browser_action_message(
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
                ),
                _mark_navigated(),
            )

            logger.info(f"\U0001f310 Auto-navigated to start URL: {nav_url}")

            # The provider can replace the pre-navigation target/session while
            # opening the first real page. Revalidate at that exact boundary so
            # a cached authenticator id cannot hide a lost WebAuthn environment.
            await sync_passkeys_onto_target(context="after start navigation")

            # The interaction layer (humanizer/recorder/logo) ran concurrently
            # with the navigation; both must be complete before the warm-up
            # scroll and the agent loop.
            await interaction_layer_task

            # Warm-up human activity after the page loads, before the agent's
            # first deliberate action. Clears two behavioral-biometrics tells:
            # "first interaction too soon after page load" (reading dwell) and
            # "no scroll activity during session" (a scroll down + partial up).
            try:
                if humanizer is not None:
                    await asyncio.sleep(random.uniform(1.0, 2.0))
                    await asyncio.wait_for(
                        humanizer.scroll(random.randint(120, 320)),
                        timeout=BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS,
                    )
                    await asyncio.sleep(random.uniform(0.4, 0.9))
                    await asyncio.wait_for(
                        humanizer.scroll(-random.randint(60, 160)),
                        timeout=BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS,
                    )
            except asyncio.TimeoutError:
                logger.warning(
                    "⚠️ Warm-up scroll timed out; continuing to browser loop",
                    timeout_seconds=BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS,
                )
            except Exception as warmup_err:
                logger.warning(f"⚠️ Warm-up scroll failed: {warmup_err}")
        else:
            logger.info("\U0001f504 Resuming from write lock approval - skipping start URL navigation")
            await interaction_layer_task
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
        rose_client = BrowserStreamingRoseClient()
        iteration = resume_step_count
        consecutive_api_failures = 0
        browser_turn_messages.extend(resume_user_messages)
        otp_history_count = 0
        supervisor_recovery_count = 0
        failed_steel_auth_recovery_ids: set[str] = set()
        task_prompt = build_browser_task_prompt(goal)
        dynamic_system_context = build_browser_dynamic_system_context(
            base_custom_instructions,
            available_files=(list(available_file_paths.keys()) if available_file_paths else None),
            response_schema=response_schema,
        )
        failed_credential_prep_realms: Dict[str, str] = {}

        async def _prepare_credentials_for_url_unquarantined(
            target_url: str,
        ) -> Optional[Dict[str, Any]]:
            """Atomically activate every saved credential type for a new realm."""
            nonlocal auth_realm
            nonlocal auth_options
            nonlocal auth_options_section
            nonlocal auth_runtime_state
            nonlocal base_custom_instructions
            nonlocal credential_refs_by_secret_ref
            nonlocal dynamic_system_context
            nonlocal minted_account_label
            nonlocal minted_account_labels
            nonlocal minted_credential_ref
            nonlocal minted_option
            nonlocal minted_phone_label
            nonlocal minted_primary_label
            nonlocal password_origins
            nonlocal secret_refs
            nonlocal session_passkeys
            nonlocal session_passwords
            nonlocal session_credential_ref

            target_realm = auth_realm_from_url(target_url)
            if not target_realm or auth_realm_matches_url(auth_realm, target_url):
                return None
            if target_realm in failed_credential_prep_realms:
                logger.info(
                    "Skipping a previously failed optional realm credential preparation",
                    auth_realm=target_realm,
                    error=failed_credential_prep_realms[target_realm],
                )
                return None
            if not session_id:
                raise RuntimeError(f"Cannot prepare credentials for {target_realm} without a browser session")

            activity.heartbeat(f"Preparing saved credentials for {target_realm}")
            try:
                payload = await prepare_browser_auth(
                    config,
                    user_id=user_id,
                    session_id=session_id,
                    target_url=target_url,
                )
            except Exception as prep_error:
                failed_credential_prep_realms[target_realm] = (
                    f"{type(prep_error).__name__}:{extract_error_message(prep_error)[:160]}"
                )
                raise
            realm_state = await build_realm_credential_state(
                payload,
                decryption_key=config.payment.decryption_key,
            )
            if realm_state.auth_realm != target_realm and not auth_realm_matches_url(
                realm_state.auth_realm, target_url
            ):
                raise RuntimeError(f"Credential realm mismatch: requested {target_realm}, got {realm_state.auth_realm}")

            injected_passkey_count = await sync_passkeys_onto_target(
                realm_state.decrypted_passkeys,
                context=f"realm transition to {target_realm}",
            )
            passkey_ref_by_credential_id.update(realm_state.passkey_ref_by_credential_id)

            retained_non_password_refs = {
                key: value
                for key, value in credential_refs_by_secret_ref.items()
                if value.get("kind") not in {"password", "minted", "minted_account"}
            }
            auth_realm = realm_state.auth_realm
            auth_options = realm_state.auth_options
            auth_options_section = realm_state.auth_options_section
            auth_runtime_state = realm_state.auth_runtime_state
            credential_refs_by_secret_ref = {
                **retained_non_password_refs,
                **realm_state.credential_refs_by_secret_ref,
            }
            password_origins = realm_state.password_origins
            secret_refs = {**card_refs, **realm_state.password_secret_refs}
            session_passwords = list(payload.get("passwords") or [])
            session_passkeys = list(payload.get("passkeys") or [])
            session_credential_ref = realm_state.auth_credential_ref
            base_custom_instructions = user_context_section + "\n\n" + auth_options_section
            dynamic_system_context = build_browser_dynamic_system_context(
                base_custom_instructions,
                available_files=(list(available_file_paths.keys()) if available_file_paths else None),
                response_schema=response_schema,
            )

            minted_option = auth_options.get("minted") or {}
            minted_account_label = (
                minted_option.get("email")
                or minted_option.get("agentEmail")
                or minted_option.get("agent_email")
                or minted_option.get("accountLabel")
                or minted_option.get("account_label")
            )
            minted_phone_label = (
                minted_option.get("phone") or minted_option.get("agentPhone") or minted_option.get("agent_phone")
            )
            minted_account_labels = {
                str(label).strip().lower() for label in (minted_account_label, minted_phone_label) if label
            }
            minted_primary_label = minted_account_label or minted_phone_label
            minted_credential_ref = (
                {
                    "kind": "minted_account",
                    "id": str(minted_option.get("id") or minted_primary_label),
                }
                if minted_option and minted_primary_label
                else None
            )

            if realm_state.auth_credential_ref and task_id:
                await save_browser_credential_ref_message(
                    agent_id=agent_id,
                    task_id=task_id,
                    message=f"Browser session credential applied for {auth_realm}.",
                    role="TOOL",
                    tool_name="browser_session_auth",
                    credential_ref=realm_state.auth_credential_ref,
                    browser_url=browser_url or "",
                )

            logger.info(
                "Prepared credentials for browser realm transition",
                previous_realm=current_url and auth_realm_from_url(current_url),
                auth_realm=auth_realm,
                password_count=len(realm_state.password_secret_refs),
                passkey_count=len(realm_state.decrypted_passkeys),
                passkeys_newly_injected=injected_passkey_count,
                cookie_source=payload.get("auth_source"),
                cookies_injected=payload.get("cookies_injected"),
            )
            return {
                "auth_realm": auth_realm,
                "cookies_injected": int(payload.get("cookies_injected") or 0),
                "password_count": len(realm_state.password_secret_refs),
                "passkey_count": len(realm_state.decrypted_passkeys),
                "passkeys_newly_injected": injected_passkey_count,
            }

        async def _prepare_credentials_for_url(target_url: str) -> Optional[Dict[str, Any]]:
            return await prepare_optional_realm_credentials(
                target_url=target_url,
                current_auth_realm=auth_realm,
                failed_realms=failed_credential_prep_realms,
                prepare_credentials=_prepare_credentials_for_url_unquarantined,
            )

        async def _recover_browser_step(reason: str, *, reload_page: bool) -> bool:
            nonlocal supervisor_recovery_count
            if supervisor_recovery_count >= BROWSER_SUPERVISOR_MAX_RECOVERIES:
                logger.error(
                    "Browser supervisor recovery budget exhausted",
                    reason=reason,
                    recoveries=supervisor_recovery_count,
                    max_recoveries=BROWSER_SUPERVISOR_MAX_RECOVERIES,
                )
                return False
            supervisor_recovery_count += 1
            activity.heartbeat(f"Step {iteration} - browser supervisor recovery: {reason}")
            await _run_browser_supervisor_recovery(
                agent_id=agent_id,
                task_id=task_id,
                browser_url=browser_url,
                tool_call_id=tool_call_id,
                iteration=iteration,
                reason=reason,
                input_page=input_page,
                dom_service=dom_service,
                browser_turn_messages=browser_turn_messages,
                reload_page=reload_page,
                fallback_url=current_url,
            )
            return True

        while iteration < MAX_ITERATIONS:
            iteration += 1
            activity.heartbeat(f"Step {iteration}")
            await _wait_for_browser_user_control(config, task_id)

            # TAB/INPUT/LIVE-VIEW STATE MACHINE:
            # browser-use focus changes -> resolve matching Playwright target
            # -> foreground provider tab -> rebind humanizer + recorder.
            # This runs before observation so the LLM, synthesized input, and
            # customer live view all refer to the same authoritative tab.
            input_page, humanizer = await _rebind_browser_tab_runtime(
                dom_service=dom_service,
                dom_page=dom_page,
                playwright_browser=playwright_browser,
                current_page=input_page,
                humanizer=humanizer,
                browser_recorder=browser_recorder,
                cursor_observer=observe_cursor,
            )

            # Handle pending write lock action
            if pending_write_lock_action:
                if await _wait_for_browser_user_control(config, task_id):
                    # The approved target may have changed under user control;
                    # retain it and re-resolve against a fresh DOM next step.
                    continue
                logger.info("Executing pending write lock action after approval")
                unified_action, browser_state, current_url = await _prepare_pending_write_lock_action(
                    dom_service,
                    pending_write_lock_action,
                    target_signature=pending_write_lock_target,
                )
                pending_write_lock_action = None
                pending_write_lock_target = None

                activity.heartbeat(f"Step {iteration} - executing pending write lock action")
                if (
                    browser_network_recorder is None
                    and network_recorder_task is not None
                    and network_recorder_task.done()
                ):
                    with contextlib.suppress(Exception):
                        browser_network_recorder = network_recorder_task.result()

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
                    credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                    user_id=user_id,
                    current_url=current_url,
                    trusted_page_urls=visited_urls,
                    write_lock_enabled=write_lock_enabled,
                    write_lock_approvals=write_lock_approvals,
                    system_name=system_name,
                    browser_network_recorder=browser_network_recorder,
                    current_auth_realm=auth_realm,
                    prepare_credentials_for_url=_prepare_credentials_for_url,
                    navigation_pin_host=navigation_pin_host,
                    navigation_origin_base_domain=navigation_origin_base_domain,
                )

                if result.get("status") == "needs_write_approval":
                    raise RuntimeError(
                        "The resumed page did not recognize the just-approved write action; refusing to loop"
                    )

                action_name = unified_action.get("action", "unknown")
                logger.info(f"Pending write lock action executed: {action_name}", result=result)

                activity.heartbeat(f"Step {iteration} - fetching browser state")
                browser_state = await dom_service.get_browser_state(include_screenshot=False)
                current_url = browser_state.get("url", "")
                await record_passkey_usage_once()

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

            # 0. Fetch recent OTPs and append unseen codes as USER messages.
            try:
                new_otp_count = await _fetch_and_append_recent_otp_user_messages(
                    user_id=user_id,
                    api_url=config.backend.api_url,
                    api_key=config.backend.api_key,
                    seen_otp_codes=seen_otp_codes,
                    otp_user_messages=otp_user_messages,
                    credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                    agent_id=agent_id,
                    task_id=task_id,
                )
                if new_otp_count:
                    logger.info("Appended OTP user messages", count=new_otp_count)
                if len(otp_user_messages) > otp_history_count:
                    browser_turn_messages.extend(otp_user_messages[otp_history_count:])
                    otp_history_count = len(otp_user_messages)
            except Exception as e:
                logger.warning("Failed to fetch OTPs", error=str(e))

            # 1. Get current browser state
            activity.heartbeat(f"Step {iteration} - fetching browser state")
            try:
                browser_state = await asyncio.wait_for(
                    dom_service.get_browser_state(include_screenshot=False),
                    timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                recovered = await _recover_browser_step(
                    f"browser_state_timeout_{BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS}s",
                    reload_page=True,
                )
                if recovered:
                    continue
                raise
            except Exception as state_error:
                recovered = await _recover_browser_step(
                    f"browser_state_error:{type(state_error).__name__}:{extract_error_message(state_error)[:160]}",
                    reload_page=True,
                )
                if recovered:
                    continue
                raise
            current_url = browser_state.get("url", "")
            await record_passkey_usage_once()

            # Sticky cross-origin handoff pin: once the live page leaves the
            # session origin registrable domain, remember that host/URL and
            # bounce back if clicks/evaluate sneak off it.
            from urllib.parse import urlparse as _urlparse_handoff

            _handoff_host = (_urlparse_handoff(str(current_url or "")).hostname or "").lower()
            if navigation_origin_base_domain and _handoff_host:
                _handoff_base = _get_base_domain(_handoff_host)
                if _handoff_base and _handoff_base != navigation_origin_base_domain:
                    if not navigation_pin_host:
                        navigation_pin_host = _handoff_host
                    if _handoff_host == navigation_pin_host or _handoff_host.endswith(
                        f".{navigation_pin_host}"
                    ):
                        navigation_pin_url = str(current_url)
            if (
                navigation_pin_host
                and navigation_pin_url
                and _handoff_host
                and not (
                    _handoff_host == navigation_pin_host
                    or _handoff_host.endswith(f".{navigation_pin_host}")
                )
            ):
                logger.warning(
                    "Auto-returning to pinned handoff host after leaving it",
                    pin_host=navigation_pin_host,
                    left_url=current_url,
                    pin_url=navigation_pin_url,
                    agent_id=agent_id,
                    task_id=task_id,
                )
                bounce = await execute_action(
                    dom_service,
                    action_history,
                    {"action": "goto", "params": {"url": navigation_pin_url}},
                    available_file_paths=available_file_paths,
                    session_id=session_id,
                    config=config,
                    humanizer=humanizer,
                    secret_refs=secret_refs,
                    password_origins=password_origins,
                    credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                    user_id=user_id,
                    current_url=current_url,
                    trusted_page_urls=visited_urls,
                    write_lock_enabled=write_lock_enabled,
                    write_lock_approvals=write_lock_approvals,
                    system_name=system_name,
                    browser_network_recorder=browser_network_recorder,
                    current_auth_realm=auth_realm,
                    prepare_credentials_for_url=_prepare_credentials_for_url,
                    navigation_pin_host=navigation_pin_host,
                    navigation_origin_base_domain=navigation_origin_base_domain,
                )
                browser_state = await dom_service.get_browser_state(include_screenshot=False)
                current_url = browser_state.get("url", navigation_pin_url)
                if not (isinstance(bounce, dict) and bounce.get("success")):
                    logger.warning(
                        "Pinned handoff auto-return goto failed",
                        pin_url=navigation_pin_url,
                        bounce=bounce,
                        agent_id=agent_id,
                        task_id=task_id,
                    )

            # Clicks, form submissions, and server redirects can cross an auth
            # realm without a goto tool call. Prepare that realm before the
            # model observes or interacts with it, then reload once so newly
            # injected cookies and origin state participate in the first page
            # request the agent acts on.
            observed_auth_realm = auth_realm_from_url(current_url)
            if observed_auth_realm and not auth_realm_matches_url(auth_realm, current_url):
                prepared_realm = await _prepare_credentials_for_url(current_url)
                if prepared_realm is not None:
                    from browser_use.browser.events import NavigateToUrlEvent

                    reload_event = dom_service.session.event_bus.dispatch(
                        NavigateToUrlEvent(url=current_url, wait_until="commit")
                    )
                    await reload_event
                    await reload_event.event_result(raise_if_any=True, raise_if_none=False)
                    await wait_for_navigation_ready(dom_service, url=current_url)
                    logger.info(
                        "Reloaded page after redirected realm credential preparation",
                        auth_realm=auth_realm,
                        current_url=current_url,
                    )
                    continue

            if current_url and (not visited_urls or current_url != visited_urls[-1]):
                visited_urls.append(current_url)

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
                        thinking_preview=(last.get("thinking", "")[:100] if last.get("thinking") else "NONE"),
                    )

                activity.heartbeat(f"Step {iteration} - calling Rose API")
                if (
                    navigation_pin_host
                    and navigation_pin_url
                    and has_payment_card_secret_refs(secret_refs)
                    and not handoff_payment_fill_succeeded
                    and handoff_payment_fill_attempts < HANDOFF_PAYMENT_FILL_MAX_ATTEMPTS
                ):
                    from urllib.parse import urlparse as _urlparse_nudge

                    _nudge_host = (_urlparse_nudge(str(current_url or "")).hostname or "").lower()
                    _on_pin = bool(_nudge_host) and (
                        _nudge_host == navigation_pin_host
                        or _nudge_host.endswith(f".{navigation_pin_host}")
                    )
                    if _on_pin:
                        # Hosted payment widgets mount fields in child frames
                        # after the document URL settles — poll for semantic
                        # payment inputs across frames before spending an attempt.
                        from domains.spawn_browser_agent_v3.service_actions import (
                            wait_for_payment_ref_fields,
                        )

                        _autofill_page = input_page
                        if _autofill_page is None and humanizer is not None:
                            if "input_page" in getattr(humanizer, "__dict__", {}):
                                _autofill_page = getattr(humanizer, "input_page", None)
                        # Keep the wait short: long polls burned the 900s budget
                        # before titled payment iframes mounted on the handoff page.
                        fields_ready = await wait_for_payment_ref_fields(
                            dom_service.session,
                            ref_names=["card_number"],
                            input_page=_autofill_page,
                            timeout_seconds=4.0,
                        )
                        if not fields_ready:
                            await save_browser_action_message(
                                agent_id=agent_id,
                                title="Waiting for payment fields on handoff page",
                                task_id=task_id,
                                message="Semantic payment inputs not visible yet in any frame",
                                status=MessageStatus.FINISHED,
                                browser_url=browser_url,
                                action_type="input_text",
                                tool_call_id=f"handoff-autofill-wait-{task_id}-{iteration}",
                                steps_taken=iteration,
                                total_steps=MAX_ITERATIONS,
                            )
                            logger.info(
                                "Handoff payment fields not ready; deferring auto-fill attempt",
                                pin_host=navigation_pin_host,
                                agent_id=agent_id,
                                task_id=task_id,
                                iteration=iteration,
                            )
                            # Do not burn an attempt — keep pin and retry next loop.
                        else:
                            handoff_payment_fill_attempts += 1
                            auto_fill_result: Dict[str, Any] = {}
                            auto_fill_call_id = f"handoff-autofill-{task_id}-{iteration}"
                            await save_browser_action_message(
                                agent_id=agent_id,
                                title="Auto-filling payment fields on handoff page",
                                task_id=task_id,
                                message="",
                                status=MessageStatus.IN_PROGRESS,
                                browser_url=browser_url,
                                action_type="input_text",
                                tool_call_id=auto_fill_call_id,
                                steps_taken=iteration,
                                total_steps=MAX_ITERATIONS,
                            )
                            try:
                                auto_fill_result = await asyncio.wait_for(
                                    execute_action(
                                        dom_service,
                                        action_history,
                                        {
                                            "action": "input_text",
                                            "thinking": (
                                                "Auto-fill approved payment card secret refs "
                                                "on the pinned cross-origin handoff page."
                                            ),
                                            "params": {"text": "card_number"},
                                        },
                                        available_file_paths=available_file_paths,
                                        session_id=session_id,
                                        config=config,
                                        humanizer=humanizer,
                                        secret_refs=secret_refs,
                                        password_origins=password_origins,
                                        credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                                        user_id=user_id,
                                        current_url=current_url,
                                        trusted_page_urls=visited_urls,
                                        write_lock_enabled=write_lock_enabled,
                                        write_lock_approvals=write_lock_approvals,
                                        system_name=system_name,
                                        browser_network_recorder=browser_network_recorder,
                                        current_auth_realm=auth_realm,
                                        prepare_credentials_for_url=_prepare_credentials_for_url,
                                        navigation_pin_host=navigation_pin_host,
                                        navigation_origin_base_domain=navigation_origin_base_domain,
                                    ),
                                    timeout=BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS,
                                )
                            except Exception as auto_fill_error:
                                auto_fill_result = {
                                    "success": False,
                                    "error": str(auto_fill_error)[:300],
                                }
                                logger.warning(
                                    "Handoff payment auto-fill raised",
                                    error=str(auto_fill_error)[:300],
                                    pin_host=navigation_pin_host,
                                    agent_id=agent_id,
                                    task_id=task_id,
                                    iteration=iteration,
                                    attempt=handoff_payment_fill_attempts,
                                )
                            filled_refs = auto_fill_result.get("payment_refs_filled") or []
                            if auto_fill_result.get("success") and filled_refs:
                                handoff_payment_fill_succeeded = True
                                await save_browser_action_message(
                                    agent_id=agent_id,
                                    title=(
                                        "Auto-filled payment fields "
                                        f"({', '.join(str(r) for r in filled_refs)})"
                                    ),
                                    task_id=task_id,
                                    message="",
                                    status=MessageStatus.FINISHED,
                                    browser_url=browser_url,
                                    action_type="input_text",
                                    tool_call_id=auto_fill_call_id,
                                    steps_taken=iteration,
                                    total_steps=MAX_ITERATIONS,
                                )
                                browser_turn_messages.append(
                                    {
                                        "role": "user",
                                        "content": (
                                            "Cross-origin handoff page is pinned "
                                            f"({navigation_pin_url}). Approved payment card "
                                            f"secret refs were filled automatically "
                                            f"({', '.join(str(r) for r in filled_refs)}). "
                                            "Submit the payment form on THIS page now. "
                                            "Do not navigate away, close tabs, or thrash "
                                            "network/evaluate."
                                        ),
                                    }
                                )
                                logger.info(
                                    "Auto-filled payment refs on pinned handoff page",
                                    pin_host=navigation_pin_host,
                                    filled_refs=filled_refs,
                                    agent_id=agent_id,
                                    task_id=task_id,
                                    iteration=iteration,
                                    attempt=handoff_payment_fill_attempts,
                                )
                            elif (
                                handoff_payment_fill_attempts
                                < HANDOFF_PAYMENT_FILL_MAX_ATTEMPTS
                            ):
                                await save_browser_action_message(
                                    agent_id=agent_id,
                                    title="Payment fields not ready yet — will retry auto-fill",
                                    task_id=task_id,
                                    message=str(
                                        auto_fill_result.get("error") or "field_not_found"
                                    )[:200],
                                    status=MessageStatus.FINISHED,
                                    browser_url=browser_url,
                                    action_type="input_text",
                                    tool_call_id=auto_fill_call_id,
                                    steps_taken=iteration,
                                    total_steps=MAX_ITERATIONS,
                                )
                                logger.info(
                                    "Handoff payment auto-fill miss; will retry",
                                    pin_host=navigation_pin_host,
                                    attempt=handoff_payment_fill_attempts,
                                    agent_id=agent_id,
                                    task_id=task_id,
                                    iteration=iteration,
                                )
                            else:
                                # Keep the cross-origin pin. Releasing it let the model
                                # abandon live handoff pages and restart Place order.
                                # Stop auto-fill retries and nudge the model to fill/submit.
                                await save_browser_action_message(
                                    agent_id=agent_id,
                                    title=(
                                        "Payment auto-fill exhausted — pin held; fill manually"
                                    ),
                                    task_id=task_id,
                                    message=(
                                        f"Pinned handoff {navigation_pin_url} still has no "
                                        "fillable payment fields after auto-fill retries. "
                                        "Pin stays active — type card refs on this page."
                                    ),
                                    status=MessageStatus.FINISHED,
                                    browser_url=browser_url,
                                    action_type="input_text",
                                    tool_call_id=auto_fill_call_id,
                                    steps_taken=iteration,
                                    total_steps=MAX_ITERATIONS,
                                )
                                browser_turn_messages.append(
                                    {
                                        "role": "user",
                                        "content": (
                                            "Cross-origin handoff page is still pinned "
                                            f"({navigation_pin_url}). Automatic payment-field "
                                            f"fill did not succeed after "
                                            f"{handoff_payment_fill_attempts} attempts. "
                                            "Stay on THIS page. Use input_text with "
                                            "card_number / card_name / card_expiry / card_cvv "
                                            "into the visible payment fields (including fields "
                                            "inside iframes), then submit. Do not navigate away, "
                                            "close tabs, or restart the merchant checkout."
                                        ),
                                    }
                                )
                                logger.info(
                                    "Handoff payment auto-fill exhausted; pin retained",
                                    pin_host=navigation_pin_host,
                                    pin_url=navigation_pin_url,
                                    auto_fill_error=auto_fill_result.get("error"),
                                    agent_id=agent_id,
                                    task_id=task_id,
                                    iteration=iteration,
                                )
                if browser_recorder:
                    await browser_recorder.record_observation(
                        iteration=iteration,
                        browser_state=browser_state,
                        action_entries=action_entries,
                    )

                # Fast Mode: replay the recorded decision when the browser request
                # fingerprint matches. The live browser session still executes the
                # action — only the LLM "what next" decision is cached.
                async def _live_browser_decision(
                    iteration_snapshot: int = iteration,
                    browser_state_snapshot: Dict[str, Any] = browser_state,
                    action_entries_snapshot: List[Dict[str, Any]] = action_entries,
                    browser_use_mode_snapshot: Optional[str] = browser_use_mode,
                    dom_service_snapshot: Any = dom_service,
                ) -> Dict[str, Any]:
                    live_result = await _call_browser_use_with_rotation(
                        rose_client=rose_client,
                        task=task_prompt,
                        dynamic_system_context=dynamic_system_context,
                        turn_messages=browser_turn_messages,
                        browser_state=browser_state_snapshot,
                        action_entries=action_entries_snapshot,
                        config=config,
                        user_id=user_id,
                        agent_id=agent_id,
                        browser_task_id=task_id,
                        iteration=iteration_snapshot,
                        token_state=token_state,
                        gpt_token=gpt_token,
                        gpt_account_id=gpt_account_id,
                        gpt_token_source=gpt_token_source,
                        gpt_token_pool_id=gpt_token_pool_id,
                        browser_use_mode=browser_use_mode_snapshot,
                        extra_user_messages=[],
                        dump_extra=(
                            {
                                "browser_recording_manifest_path": str(browser_recorder.output_dir / "manifest.json"),
                                "browser_recording_path": str(browser_recorder.output_dir / "index.html"),
                                "browser_recording_task_id": browser_recorder.task_id,
                                "browser_session_metadata": browser_session_metadata,
                                "iteration": iteration_snapshot,
                            }
                            if browser_recorder
                            else {"iteration": iteration_snapshot}
                        ),
                    )
                    return _attach_browser_replay_target(live_result, dom_service_snapshot)

                browser_stream = BrowserThinkingStream(
                    agent_id=agent_id,
                    task_id=task_id,
                    iteration=iteration,
                )
                await browser_stream.start()
                rose_client.set_thinking_stream(browser_stream)
                decision_succeeded = False
                try:
                    llm_result = await asyncio.wait_for(
                        cached_browser_decision(
                            enabled=False,
                            goal=goal,
                            request={
                                "task": task_prompt,
                                "dynamic_system_context": dynamic_system_context,
                                "turn_messages": browser_turn_messages,
                                "browser_state": browser_state,
                                "action_entries": action_entries,
                                "config": {
                                    "browser_use_mode": browser_use_mode,
                                },
                            },
                            call_llm=_live_browser_decision,
                            write_enabled=False,
                        ),
                        timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                    )
                    decision_succeeded = True
                finally:
                    rose_client.set_thinking_stream(None)
                    await browser_stream.finish()
                    if not decision_succeeded:
                        await browser_stream.finish_tools(status="ERROR")
                llm_result = {**llm_result, "_thinking_stream_id": browser_stream.stream_id}
                # Track waterfall fall-through so subsequent iterations skip claudeAuth.
                if llm_result.get("mode") != "claude" and browser_use_mode == "claude":
                    browser_use_mode = None
                    token_state.fallen_back_to_waterfall = True
                if llm_result.get("mode") != "gpt" and browser_use_mode == "gpt":
                    browser_use_mode = None

                usage = llm_result.get("usage", {})
                # Record EVERY step against the model that actually ran it —
                # including claudeAuth/gptAuth steps. `_track_usage` zeroes
                # `-claude`/`-gpt` rows by model name, so they no longer have
                # to be dropped here to avoid being billed as paid waterfall.
                step_input_tokens = usage.get("prompt_tokens", 0) or 0
                step_output_tokens = usage.get("completion_tokens", 0) or 0
                total_input_tokens += step_input_tokens
                total_output_tokens += step_output_tokens
                accumulate_model_usage(
                    usage_by_model,
                    llm_result.get("actual_model"),
                    step_input_tokens,
                    step_output_tokens,
                    cache_read_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
                    cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
                    from_fast_cache=bool(usage.get("from_fast_cache")),
                )

            except asyncio.TimeoutError:
                consecutive_api_failures += 1
                recovered = await _recover_browser_step(
                    f"browser_decision_timeout_{BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS}s",
                    reload_page=False,
                )
                if recovered and consecutive_api_failures < MAX_CONSECUTIVE_API_FAILURES:
                    await asyncio.sleep(1)
                    continue
                if consecutive_api_failures >= MAX_CONSECUTIVE_API_FAILURES:
                    logger.error(f"Aborting: {MAX_CONSECUTIVE_API_FAILURES} consecutive browser decision timeouts")
                    break
                raise
            except BrowserToolArgsValidationError as validation_error:
                # The model chose a real tool but supplied arguments its schema
                # rejects. This is a model-output error, NOT a Rose transport/infra
                # failure: feed it back through the normal tool-result path so the
                # next turn sees the rejection and self-corrects, keep it visible in
                # the trajectory, and do NOT count it toward the abort budget.
                logger.info(
                    f"Browser tool args rejected ({validation_error.tool_name}); feeding validation error back to model",
                    iteration=iteration,
                    detail=validation_error.detail,
                )
                consecutive_api_failures = 0
                await _feed_browser_tool_validation_error_back(
                    error=validation_error,
                    action_history=action_history,
                    browser_turn_messages=browser_turn_messages,
                    dom_service=dom_service,
                    browser_state=browser_state,
                    task_prompt=task_prompt,
                    iteration=iteration,
                    agent_id=agent_id,
                    task_id=task_id,
                    browser_url=browser_url,
                )
                continue
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

            if await _wait_for_browser_user_control(config, task_id):
                # Never execute an action planned against the pre-handoff DOM.
                await browser_stream.finish_tools(status="ERROR")
                continue

            # 4. Extract action from response
            unified_action = llm_result.get("action", {})
            unified_action = _remap_cached_browser_action_target(
                unified_action,
                cached_target=llm_result.get("_fast_cache_browser_target"),
                dom_service=dom_service,
            )
            if unified_action is not llm_result.get("action"):
                llm_result = dict(llm_result)
                llm_result["action"] = unified_action

            # Some anti-bot services return an explicit network-reputation
            # verdict even when the rendered page no longer looks challenged.
            # Reject that exit deterministically before executing the model's
            # next action. The synthetic recovery gets its own stable tool-call
            # lifecycle and takes the solver -> config-search fast path below.
            if browser_network_recorder is None and network_recorder_task is not None and network_recorder_task.done():
                with contextlib.suppress(Exception):
                    browser_network_recorder = network_recorder_task.result()
            provider_exit_rejection = (
                browser_network_recorder.pop_provider_exit_rejection() if browser_network_recorder is not None else None
            )
            if provider_exit_rejection is not None:
                # The streamed model action was superseded before execution;
                # close it accurately instead of stitching its tool id onto the
                # independently generated recovery lifecycle below.
                await browser_stream.finish_tools(status="ERROR")
                rejected_action = unified_action.get("action", "")
                recovery_tool_call_id = f"provider-exit-recovery-{uuid_module.uuid4()}"
                rejection_reason = str(
                    (provider_exit_rejection or {}).get("reason")
                    or "The current provider IP was explicitly rejected."
                )
                blocked_resource_url = blocked_resource_url_for_recovery(
                    provider_exit_rejection
                )
                unified_action = {
                    "action": "recover_from_challenge",
                    "thinking": "",
                    "params": {
                        "reason": rejection_reason,
                        "provider_exit_rejected": True,
                        # Failure-driven re-verify for critical third-party blocks
                        # only (not same-origin API-challenge URLs).
                        **(
                            {"blocked_resource_url": blocked_resource_url}
                            if blocked_resource_url
                            else {}
                        ),
                    },
                }
                llm_result = {
                    **llm_result,
                    "action": unified_action,
                    "tool_call_id": recovery_tool_call_id,
                }
                logger.warning(
                    "Replacing browser action with provider-exit recovery",
                    rejected_action=rejected_action,
                    rejection=provider_exit_rejection,
                    tool_call_id=recovery_tool_call_id,
                )
            action_name = unified_action.get("action", "")
            thinking = unified_action.get("thinking", "")

            if thinking:
                reasoning_messages.append(thinking)
                await save_browser_assistant_message(
                    agent_id,
                    thinking,
                    task_id,
                    stream_id=llm_result.get("_thinking_stream_id"),
                )

            action_summary.append(_summarize_browser_action_history_entry(action_name, unified_action))
            if len(action_summary) > 20:
                action_summary[:] = action_summary[-20:]
            if action_name == "attempt_completion":
                auth_runtime_state.mark_guest_attempted()

            # 5. Handle special actions
            if action_name == "request_user_assistance_for_authentication":
                tool_call_id_action = str(llm_result.get("tool_call_id") or uuid_module.uuid4())
                base_site = auth_realm or get_domain_from_url(current_url) or "Current Site"
                auth_snapshot = auth_runtime_state.snapshot()
                minted_otp_pending = (
                    auth_snapshot["minted"]["present"]
                    and auth_snapshot["minted"]["attempted"]
                    and not otp_user_messages
                )
                if minted_otp_pending:
                    logger.info(
                        "Delaying auth assistance while waiting for minted account email/SMS OTP",
                        base_site=base_site,
                    )
                    minted_otp_arrived = False
                    for _ in range(12):
                        await asyncio.sleep(10)
                        try:
                            new_otp_count = await _fetch_and_append_recent_otp_user_messages(
                                user_id=user_id,
                                api_url=config.backend.api_url,
                                api_key=config.backend.api_key,
                                seen_otp_codes=seen_otp_codes,
                                otp_user_messages=otp_user_messages,
                                credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                                agent_id=agent_id,
                                task_id=task_id,
                            )
                        except Exception as e:
                            logger.warning(
                                "Failed to fetch OTPs while delaying auth assistance",
                                error=str(e),
                            )
                            new_otp_count = 0
                        if new_otp_count:
                            logger.info(
                                "Blocked auth assistance because minted account OTP arrived",
                                count=new_otp_count,
                            )
                            if len(otp_user_messages) > otp_history_count:
                                browser_turn_messages.extend(otp_user_messages[otp_history_count:])
                                otp_history_count = len(otp_user_messages)
                            minted_otp_arrived = True
                            break
                    if minted_otp_arrived:
                        blocked_result = {
                            "success": False,
                            "error": "Recent email/SMS OTP arrived; use it before asking for help.",
                        }
                        await action_history.record_action(
                            dom_service=dom_service,
                            action="request_user_assistance_for_authentication",
                            thinking=thinking,
                            params={},
                            result=blocked_result,
                        )
                        _append_browser_turn_messages(
                            browser_turn_messages,
                            task=task_prompt,
                            browser_state=browser_state,
                            include_screenshot=False,
                            unified_action=unified_action,
                            result=blocked_result,
                            tool_call_id=tool_call_id_action,
                        )
                        await browser_stream.finish_tools(status="ERROR")
                        continue
                allowed, guard_reason, guard_state = auth_runtime_state.user_assistance_guard()
                if not allowed:
                    logger.info(
                        "Blocked premature user authentication assistance request",
                        base_site=base_site,
                        reason=guard_reason,
                        auth_guard_state=guard_state,
                    )
                    blocked_result = {
                        "success": False,
                        "error": guard_reason,
                        "auth_guard_state": guard_state,
                    }
                    await action_history.record_action(
                        dom_service=dom_service,
                        action="request_user_assistance_for_authentication",
                        thinking=thinking,
                        params={},
                        result=blocked_result,
                    )
                    _append_browser_turn_messages(
                        browser_turn_messages,
                        task=task_prompt,
                        browser_state=browser_state,
                        include_screenshot=False,
                        unified_action=unified_action,
                        result=blocked_result,
                        tool_call_id=tool_call_id_action,
                    )
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Authentication assistance blocked",
                        task_id=task_id,
                        message=guard_reason,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="request_user_assistance_for_authentication",
                        tool_call_id=tool_call_id_action,
                        steps_taken=iteration,
                        total_steps=MAX_ITERATIONS,
                        extra_metadata={"auth_guard_state": guard_state},
                    )
                    await browser_stream.finish_tools(status="ERROR")
                    continue
                # CAPTCHA / bot walls are not sign-in blockers. browser-hotel-booking
                # misrouted Expedia "Bot or Not?" into auth_assistance after
                # recover_from_challenge falsely skipped as clean; refuse the
                # handoff while the live document still looks challenged.
                if input_page is not None and await live_tab_looks_challenged(input_page):
                    challenge_guard_reason = (
                        "Current page is a bot challenge/CAPTCHA, not an authentication "
                        "blocker. Call recover_from_challenge instead of "
                        "request_user_assistance_for_authentication."
                    )
                    logger.info(
                        "Blocked auth assistance while challenge interstitial is visible",
                        base_site=base_site,
                        current_url=current_url,
                    )
                    blocked_result = {
                        "success": False,
                        "error": challenge_guard_reason,
                        "recovery_action": "auth_assistance_blocked_challenged_page",
                    }
                    await action_history.record_action(
                        dom_service=dom_service,
                        action="request_user_assistance_for_authentication",
                        thinking=thinking,
                        params={},
                        result=blocked_result,
                    )
                    _append_browser_turn_messages(
                        browser_turn_messages,
                        task=task_prompt,
                        browser_state=browser_state,
                        include_screenshot=False,
                        unified_action=unified_action,
                        result=blocked_result,
                        tool_call_id=tool_call_id_action,
                    )
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Authentication assistance blocked — challenge page",
                        task_id=task_id,
                        message=challenge_guard_reason,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="request_user_assistance_for_authentication",
                        tool_call_id=tool_call_id_action,
                        steps_taken=iteration,
                        total_steps=MAX_ITERATIONS,
                        extra_metadata={
                            "recovery_action": "auth_assistance_blocked_challenged_page",
                            "current_url": current_url,
                        },
                    )
                    await browser_stream.finish_tools(status="ERROR")
                    continue
                logger.info(
                    "Browser agent requested user authentication assistance",
                    base_site=base_site,
                )
                steel_credential_id = (
                    str(session_credential_ref.get("id") or "")
                    if isinstance(session_credential_ref, dict)
                    and session_credential_ref.get("kind") == "steel_session"
                    else ""
                )
                if steel_credential_id and steel_credential_id not in failed_steel_auth_recovery_ids:
                    failed_steel_auth_recovery_ids.add(steel_credential_id)
                    browser_stack_replacement_started = False
                    try:
                        replacement = await _restart_after_failed_steel_auth(
                            config=config,
                            user_id=user_id,
                            task_id=task_id,
                            credential_ref=session_credential_ref,
                        )
                        # Stage the replacement identifiers; do NOT commit them until
                        # the worker has actually attached to the new browser. If the
                        # reconnect raises, the handler below discards the stack but
                        # cannot restore these, and the auth-assistance path would then
                        # hand the user a live-view session the worker never attached
                        # to — the user signs in somewhere the agent cannot observe.
                        new_cdp_url = replacement["ws_url"]
                        pending_session_id = replacement.get("session_id", session_id)
                        pending_browser_url = replacement.get("debug_url", browser_url)
                        pending_fingerprint_injection = (
                            replacement.get("fingerprint_injection") or fingerprint_injection
                        )
                        pending_session_credential_ref = replacement.get(
                            "credential_ref"
                        ) or replacement.get("auth_credential_ref")
                        pending_auth_realm = replacement.get("auth_realm") or auth_realm
                        pending_browser_session_metadata = _updated_rotation_session_metadata(
                            browser_session_metadata,
                            dict(replacement),
                        )
                        browser_stack_replacement_started = True
                        reconnected = await _reconnect_browser_stack_after_rotation(
                            new_cdp_url=new_cdp_url,
                            old_dom_service=dom_service,
                            old_playwright_browser=playwright_browser,
                            old_playwright_instance=playwright_instance,
                            old_driver_pid=playwright_driver_pid,
                            fingerprint_injection=replacement.get("fingerprint_injection")
                            or pending_fingerprint_injection,
                            agent_id=agent_id,
                        )
                        # Reconnect succeeded: the replacement session is real and
                        # attached, so the identifiers are now safe to publish.
                        session_id = pending_session_id
                        browser_url = pending_browser_url
                        cdp_url = new_cdp_url
                        fingerprint_injection = pending_fingerprint_injection
                        session_credential_ref = pending_session_credential_ref
                        auth_realm = pending_auth_realm
                        browser_session_metadata = pending_browser_session_metadata
                        dom_service = reconnected["dom_service"]
                        dom_page = reconnected["dom_page"]
                        input_page = reconnected["input_page"]
                        playwright_browser = reconnected["playwright_browser"]
                        playwright_instance = reconnected["playwright_instance"]
                        playwright_driver_pid = reconnected["playwright_driver_pid"]
                        if browser_recorder is not None:
                            with contextlib.suppress(Exception):
                                await browser_recorder.transition_browser(
                                    page=input_page,
                                    session_id=session_id,
                                    browser_url=browser_url or "",
                                    session_metadata=browser_session_metadata,
                                )
                        if browser_network_recorder is not None:
                            with contextlib.suppress(Exception):
                                await browser_network_recorder.transition_browser(
                                    browser_session=dom_service.session,
                                    session_id=session_id,
                                )
                        humanizer = await _replace_browser_humanizer(
                            current_humanizer=humanizer,
                            enabled=_env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True),
                            dom_page=dom_page,
                            input_page=input_page,
                            cursor_observer=observe_cursor,
                            humanizer_factory=BrowserHumanizer,
                        )
                        browser_state = await dom_service.get_browser_state(include_screenshot=False)
                        current_url = browser_state.get("url", current_url)
                        recovery_result = {
                            "success": True,
                            "message": (
                                "The saved Steel session was signed out, so it was replaced with a fresh "
                                "credential-isolated browser session. Recheck the page before requesting assistance."
                            ),
                            "auth_source": replacement.get("auth_source"),
                            "cookies_injected": int(replacement.get("cookies_count") or 0),
                        }
                        await action_history.record_action(
                            dom_service=dom_service,
                            action="request_user_assistance_for_authentication",
                            thinking=thinking,
                            params={},
                            result=recovery_result,
                        )
                        _append_browser_turn_messages(
                            browser_turn_messages,
                            task=task_prompt,
                            browser_state=browser_state,
                            include_screenshot=False,
                            unified_action=unified_action,
                            result=recovery_result,
                            tool_call_id=tool_call_id_action,
                        )
                        await save_browser_action_message(
                            agent_id=agent_id,
                            title="Replaced signed-out saved browser session",
                            task_id=task_id,
                            message=recovery_result["message"],
                            status=MessageStatus.FINISHED,
                            browser_url=browser_url,
                            action_type="browser_auth_session_recovery",
                            tool_call_id=tool_call_id_action,
                            steps_taken=iteration,
                            total_steps=MAX_ITERATIONS,
                            extra_metadata={
                                "auth_source": replacement.get("auth_source"),
                                "cookies_injected": int(replacement.get("cookies_count") or 0),
                            },
                        )
                        logger.info(
                            "Replaced signed-out Steel session before user assistance",
                            auth_realm=auth_realm or base_site,
                            steel_session_auth_id=steel_credential_id,
                            replacement_auth_source=replacement.get("auth_source"),
                            replacement_credential_ref=session_credential_ref,
                        )
                        await browser_stream.finish_tools(status="FINISHED")
                        continue
                    except Exception as stale_auth_error:
                        if browser_stack_replacement_started:
                            await _discard_replacement_browser_stack(
                                humanizer=humanizer,
                                dom_service=dom_service,
                                playwright_browser=playwright_browser,
                                playwright_instance=playwright_instance,
                                playwright_driver_pid=playwright_driver_pid,
                                agent_id=agent_id,
                            )
                            humanizer = None
                            dom_service = None
                            dom_page = None
                            input_page = None
                            playwright_browser = None
                            playwright_instance = None
                            playwright_driver_pid = None
                            # The backend already swapped the provider session
                            # (browser_stack_replacement_started only becomes True
                            # after _restart_after_failed_steel_auth returns), so the
                            # OLD identifiers now point at a released session. We
                            # never attached to the replacement, but handing the user
                            # a live view for the session that actually exists beats
                            # one the backend has already torn down.
                            session_id = pending_session_id
                            browser_url = pending_browser_url
                            cdp_url = new_cdp_url
                            fingerprint_injection = pending_fingerprint_injection
                            session_credential_ref = pending_session_credential_ref
                            auth_realm = pending_auth_realm
                            browser_session_metadata = pending_browser_session_metadata
                        logger.warning(
                            "Failed to replace signed-out Steel session before user assistance",
                            auth_realm=auth_realm or base_site,
                            steel_session_auth_id=steel_credential_id,
                            error=extract_error_message(stale_auth_error),
                        )
                auth_handoff_current_url = select_auth_assistance_current_url(current_url, visited_urls)
                if auth_handoff_current_url != current_url:
                    logger.info(
                        "Using prior auth URL with query params for user assistance handoff",
                        current_url=current_url,
                        auth_handoff_current_url=auth_handoff_current_url,
                    )

                request_info = await create_user_auth_assistance_request(
                    config,
                    agent_id=agent_id,
                    user_id=user_id,
                    auth_realm=auth_realm or base_site,
                    browser_session_id=task_id,
                    steel_session_id=session_id,
                    browser_url=browser_url,
                    current_url=auth_handoff_current_url,
                    mode="live_view",
                )
                request_id = (
                    request_info.get("id")
                    or request_info.get("requestId")
                    or request_info.get("request_id")
                    or request_info.get("attentionRequestId")
                    or (request_info.get("request") or {}).get("id")
                )

                success_result = {"success": True, "request_id": request_id}
                if dom_service is not None:
                    await action_history.record_action(
                        dom_service=dom_service,
                        action="request_user_assistance_for_authentication",
                        thinking=thinking,
                        params={},
                        result=success_result,
                    )
                _append_browser_turn_messages(
                    browser_turn_messages,
                    task=task_prompt,
                    browser_state=browser_state,
                    include_screenshot=False,
                    unified_action=unified_action,
                    result=success_result,
                    tool_call_id=tool_call_id_action,
                )

                await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                dom_service = None
                await _stop_playwright_resources(
                    playwright_browser,
                    playwright_instance,
                    agent_id,
                    close_browser=False,
                    driver_pid=playwright_driver_pid,
                )
                playwright_browser = None
                playwright_instance = None

                execution_time_ms = (safe_time() - start_time) * 1000
                usage_items = build_usage_items(
                    total_input_tokens,
                    total_output_tokens,
                    model_pricing,
                    execution_time_ms,
                    usage_by_model,
                )
                await _propagate_browser_credentials_with_progress(
                    config=config,
                    agent_id=agent_id,
                    task_id=task_id,
                    browser_url=browser_url,
                    status="awaiting_auth_assistance",
                    success=False,
                    message="Automated authentication options were exhausted; requesting user assistance.",
                )
                await browser_stream.finish_tools(status="FINISHED")

                return {
                    "status": "awaiting_auth_assistance",
                    "request_id": request_id,
                    "auth_assistance_request": request_info,
                    "base_site": base_site,
                    "auth_realm": auth_realm or base_site,
                    "task_id": task_id,
                    "session_id": session_id,
                    "browser_url": browser_url,
                    "cdp_url": cdp_url,
                    "handoff_mode": "same_steel_session_live_view",
                    "step_count": iteration,
                    "recorded_passkey_credential_ids": sorted(recorded_passkey_credential_ids),
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items,
                    **_browser_resume_continuity_state(
                        action_history=action_history,
                        visited_urls=visited_urls,
                        verifier_checkpoints=verifier_checkpoints,
                    ),
                }

            if action_name == "recover_from_challenge":
                recovery_reason = unified_action.get("params", {}).get("reason", "")
                recovery_call_id = _browser_action_tool_call_id(llm_result)
                logger.info("Browser agent requested staged challenge recovery", reason=recovery_reason)

                provider_exit_rejected = bool(
                    unified_action.get("params", {}).get("provider_exit_rejected")
                )
                # If the live tab is already clean and this was not a hard
                # provider-exit rejection, skip — avoids recovery loops the model
                # invents from third-party network noise on an otherwise fine page.
                if (
                    not provider_exit_rejected
                    and input_page is not None
                    and not await live_tab_looks_challenged(input_page)
                ):
                    skip_message = (
                        f"Current page does not look challenged"
                        + (f" ({current_url})" if current_url else "")
                        + ". Continue the task on this page — do not start "
                        "challenge recovery unless the document itself is blocked."
                    )
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Page already clear — skip challenge recovery",
                        task_id=task_id,
                        message=skip_message,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="browser_challenge_recovery",
                        tool_call_id=recovery_call_id,
                        extra_metadata={
                            "recoveryStage": "skipped_clean_page",
                            "resumeUrl": current_url,
                        },
                    )
                    action_result = {
                        "success": True,
                        "message": skip_message,
                        "recovery_action": "skipped_clean_page",
                        "current_url": current_url,
                    }
                    await _finalize_browser_recovery_action_result(
                        action_result=action_result,
                        dom_service=dom_service,
                        action_history=action_history,
                        thinking=thinking,
                        recovery_reason=recovery_reason,
                        browser_turn_messages=browser_turn_messages,
                        task_prompt=task_prompt,
                        browser_state=browser_state,
                        unified_action=unified_action,
                        recovery_call_id=recovery_call_id,
                        browser_stream=browser_stream,
                    )
                    continue

                progress_titles = {
                    "capture_browser_state": "Capturing browser state",
                    "captcha_solver": "Waiting for CAPTCHA auto-solver",
                    "known_challenge_cookies": "Testing challenge cookies",
                    "all_target_cookies": "Testing target-site cookies",
                    "non_auth_cookies": "Testing non-auth cookies",
                    "cookie_isolation": "Isolating poisoned cookie state",
                    "apply_cookie_fix": "Applying safe cookie recovery",
                    "browser_config_search": "Searching browser configurations",
                    "live_verify": "Verifying live tab cleared challenge",
                }

                async def emit_recovery_progress(stage: str, message: str) -> None:
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title=progress_titles.get(stage, "Recovering from browser challenge"),
                        task_id=task_id,
                        message=message,
                        status=MessageStatus.IN_PROGRESS,
                        browser_url=browser_url,
                        action_type="browser_challenge_recovery",
                        tool_call_id=recovery_call_id,
                        extra_metadata={"recoveryStage": stage},
                    )

                async def search_browser_configs(storage_state: Dict[str, Any]) -> Dict[str, Any]:
                    nonlocal require_payment_cdn, payment_cdn_verify_url
                    user_agent = ""
                    with contextlib.suppress(Exception):
                        user_agent = str(
                            await asyncio.wait_for(
                                input_page.evaluate("() => navigator.userAgent"),
                                timeout=15,
                            )
                        )
                    blocked_resource_url = str(
                        unified_action.get("params", {}).get("blocked_resource_url") or ""
                    ).strip()
                    if blocked_resource_requires_payment_cdn(blocked_resource_url):
                        require_payment_cdn = True
                        payment_cdn_verify_url = blocked_resource_url or payment_cdn_verify_url
                    verify_url = blocked_resource_url or payment_cdn_verify_url
                    result = await recover_browser_challenge(
                        config,
                        task_id,
                        current_url,
                        storage_state,
                        user_agent,
                        blocked_resource_url=verify_url,
                        require_payment_cdn=require_payment_cdn,
                    )
                    if result.get("rate_limited"):
                        raise RuntimeError("Browser provider slots are busy; challenge recovery could not run")
                    return result

                try:
                    if playwright_browser is None or input_page is None:
                        raise RuntimeError("Browser state is unavailable for auth-preserving challenge recovery")
                    recovery_storage_state = await _capture_recovery_storage_state(
                        input_page,
                        emit_recovery_progress,
                    )

                    provider_exit_rejected = bool(
                        unified_action.get("params", {}).get("provider_exit_rejected")
                    )
                    escalate_after_cookie_false_stable = (
                        not provider_exit_rejected and cookie_recovery_successes >= 1
                    )
                    if escalate_after_cookie_false_stable:
                        logger.warning(
                            "Escalating repeated challenge recovery to browser config search",
                            agent_id=agent_id,
                            task_id=task_id,
                            cookie_recovery_successes=cookie_recovery_successes,
                            reason=recovery_reason,
                        )
                    recovery = await recover_from_challenge(
                        source_state=recovery_storage_state,
                        target_url=current_url,
                        wait_for_solver=lambda: _wait_for_provider_captcha_solver(
                            config, task_id, page=input_page
                        ),
                        probe=lambda candidate: probe_storage_state(
                            playwright_browser,
                            candidate,
                            current_url,
                        ),
                        commit_cookie_removals=lambda keys: commit_cookie_removals(
                            input_page,
                            keys,
                            current_url,
                        ),
                        search_configs=search_browser_configs,
                        progress=emit_recovery_progress,
                        provider_exit_rejected=provider_exit_rejected
                        or escalate_after_cookie_false_stable,
                    )
                    if recovery.recovery == "cookies_sanitized":
                        cookie_recovery_successes += 1

                    config_result = recovery.config_result
                    if config_result is not None:
                        new_cdp_url = config_result.get("ws_url")
                        if not isinstance(new_cdp_url, str) or not new_cdp_url:
                            raise RuntimeError("Challenge recovery selected a browser without a CDP URL")
                        try:
                            reconnected = await _reconnect_browser_stack_after_rotation(
                                new_cdp_url=new_cdp_url,
                                old_dom_service=dom_service,
                                old_playwright_browser=playwright_browser,
                                old_playwright_instance=playwright_instance,
                                old_driver_pid=playwright_driver_pid,
                                fingerprint_injection=fingerprint_injection,
                                agent_id=agent_id,
                            )
                        except Exception:
                            # The reconnect helper disconnects the old stack before attaching to
                            # the promoted session. Drop every dead handle so the error path cannot
                            # attempt a screenshot/action against the disconnected browser and mask
                            # the original reconnect failure.
                            if humanizer is not None:
                                with contextlib.suppress(Exception):
                                    await humanizer.close()
                                humanizer = None
                            dom_service = None
                            dom_page = None
                            input_page = None
                            playwright_browser = None
                            playwright_instance = None
                            playwright_driver_pid = None
                            raise
                        dom_service = reconnected["dom_service"]
                        dom_page = reconnected["dom_page"]
                        input_page = reconnected["input_page"]
                        playwright_browser = reconnected["playwright_browser"]
                        playwright_instance = reconnected["playwright_instance"]
                        playwright_driver_pid = reconnected["playwright_driver_pid"]
                        session_id = config_result.get("session_id", session_id)
                        browser_url = config_result.get("debug_url", browser_url)
                        cdp_url = new_cdp_url
                        browser_session_metadata = _updated_rotation_session_metadata(
                            browser_session_metadata,
                            dict(config_result),
                        )
                        # Preloaded winners already applied auth/origin state during
                        # candidate probes. Re-running origin restore clears
                        # localStorage and rewrites the challenged capture onto the
                        # clean session (Eventim Cloudflare false-stable after promote).
                        if not bool(config_result.get("storage_state_preloaded")):
                            await _restore_rotation_storage_state(
                                input_page,
                                recovery_storage_state,
                                current_url=current_url,
                                restore_cookies=True,
                            )
                        # The rotated target came up with a fresh, empty virtual
                        # authenticator. Re-seed the passkeys we already hold so
                        # passkey auth survives the reset exactly like the cookies
                        # and localStorage restored just above.
                        await sync_passkeys_onto_target(context="after proxy rotation")

                        if browser_recorder is not None:
                            with contextlib.suppress(Exception):
                                await browser_recorder.transition_browser(
                                    page=input_page,
                                    session_id=session_id,
                                    browser_url=browser_url or "",
                                    session_metadata=browser_session_metadata,
                                )
                        if browser_network_recorder is None and network_recorder_task is not None:
                            with contextlib.suppress(Exception):
                                browser_network_recorder = await asyncio.wait_for(
                                    asyncio.shield(network_recorder_task),
                                    timeout=10,
                                )
                        if browser_network_recorder is not None:
                            with contextlib.suppress(Exception):
                                await browser_network_recorder.transition_browser(
                                    browser_session=dom_service.session,
                                    session_id=session_id,
                                )

                        humanizer = await _replace_browser_humanizer(
                            current_humanizer=humanizer,
                            enabled=_env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True),
                            dom_page=dom_page,
                            input_page=input_page,
                            cursor_observer=observe_cursor,
                            humanizer_factory=BrowserHumanizer,
                        )

                        await emit_recovery_progress(
                            "live_verify",
                            "Verifying the promoted browser cleared the challenge on the live tab.",
                        )
                        if not await verify_live_page_cleared_challenge(input_page, current_url):
                            provider = config_result.get("provider")
                            proxy_tier = config_result.get("proxy_tier")
                            config_key = config_result.get("config_key") or f"{provider}/{proxy_tier}"
                            raise RuntimeError(
                                f"Promoted {config_key} passed candidate probes but the live tab "
                                "is still challenged"
                            )
                        blocked_resource_url = str(
                            unified_action.get("params", {}).get("blocked_resource_url") or ""
                        ).strip()
                        if blocked_resource_url:
                            await emit_recovery_progress(
                                "live_verify",
                                "Verifying the blocked third-party resource loads on the "
                                "promoted tab.",
                            )
                            if not await verify_live_blocked_resources(
                                input_page, [blocked_resource_url]
                            ):
                                provider = config_result.get("provider")
                                proxy_tier = config_result.get("proxy_tier")
                                config_key = (
                                    config_result.get("config_key") or f"{provider}/{proxy_tier}"
                                )
                                raise RuntimeError(
                                    f"Promoted {config_key} cleared the challenge but blocked "
                                    f"resource still fails: {blocked_resource_url}"
                                )

                    browser_state = await dom_service.get_browser_state(include_screenshot=False)
                    current_url = browser_state.get("url", current_url)
                    if config_result is not None:
                        provider = config_result.get("provider")
                        proxy_tier = config_result.get("proxy_tier")
                        config_key = config_result.get("config_key") or f"{provider}/{proxy_tier}"
                        blocked_resource_url = str(
                            unified_action.get("params", {}).get("blocked_resource_url") or ""
                        ).strip()
                        recovery_message = (
                            f"Recovered by selecting {config_key}; live tab verified clean"
                            + (
                                f"; blocked resource cleared ({blocked_resource_url})"
                                if blocked_resource_url
                                else ""
                            )
                            + "; signed-in state was preserved."
                        )
                    else:
                        recovery_message = (
                            "Recovered by removing a proven non-auth cookie subset; signed-in state was preserved."
                        )
                    if current_url:
                        recovery_message = (
                            f"{recovery_message} Current page URL: {current_url}. "
                            "Continue the task on this page."
                        )
                        from urllib.parse import urlparse as _urlparse_pin

                        pin_host = (_urlparse_pin(str(current_url)).hostname or "").lower()
                        if pin_host:
                            navigation_pin_host = pin_host
                            navigation_pin_url = str(current_url)
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Browser challenge recovered",
                        task_id=task_id,
                        message=recovery_message,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="browser_challenge_recovery",
                        tool_call_id=recovery_call_id,
                        extra_metadata={
                            "recoveryStage": "complete",
                            "provider": config_result.get("provider") if config_result else None,
                            "proxyTier": config_result.get("proxy_tier") if config_result else None,
                            "configKey": config_result.get("config_key") if config_result else None,
                            "resumeUrl": current_url,
                        },
                    )
                    action_result = {
                        "success": True,
                        "message": recovery_message,
                        "recovery_action": recovery.recovery,
                        "provider": config_result.get("provider") if config_result else None,
                        "proxy_tier": config_result.get("proxy_tier") if config_result else None,
                        "config_key": config_result.get("config_key") if config_result else None,
                        "removed_cookie_count": len(recovery.removed_cookie_keys),
                        "current_url": current_url,
                    }
                except Exception as exc:
                    error_message = extract_error_message(exc)
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Browser challenge recovery failed",
                        task_id=task_id,
                        message=error_message,
                        status=MessageStatus.ERROR,
                        browser_url=browser_url,
                        action_type="browser_challenge_recovery",
                        tool_call_id=recovery_call_id,
                    )
                    action_result = {"success": False, "error": error_message}

                await _finalize_browser_recovery_action_result(
                    action_result=action_result,
                    dom_service=dom_service,
                    action_history=action_history,
                    thinking=thinking,
                    recovery_reason=recovery_reason,
                    browser_turn_messages=browser_turn_messages,
                    task_prompt=task_prompt,
                    browser_state=browser_state,
                    unified_action=unified_action,
                    recovery_call_id=recovery_call_id,
                    browser_stream=browser_stream,
                )
                continue

            if action_name == "send_message_to_user":
                message = unified_action.get("params", {}).get("message", "")
                reason = unified_action.get("params", {}).get("reason", "other")

                logger.info("Browser agent requested user attention", reason=reason)
                await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                dom_service = None

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
                    total_input_tokens,
                    total_output_tokens,
                    model_pricing,
                    execution_time_ms,
                    usage_by_model,
                )
                await browser_stream.finish_tools(status="FINISHED")

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
                completion_tool_status = "ERROR"
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

                    verifier_context = await build_browser_verifier_context(
                        goal=goal,
                        current_url=current_url,
                        browser_state=browser_state,
                        action_history=action_history,
                        config=config,
                        session_id=session_id,
                        payment_card_evidence=_build_payment_card_verifier_evidence(payment_card_last4),
                        browser_checkpoints=verifier_checkpoints,
                    )

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
                            None,
                            None,
                            (
                                {
                                    "browser_recording_manifest_path": str(
                                        browser_recorder.output_dir / "manifest.json"
                                    ),
                                    "browser_recording_path": str(browser_recorder.output_dir / "index.html"),
                                    "browser_recording_task_id": browser_recorder.task_id,
                                    "browser_session_metadata": browser_session_metadata,
                                }
                                if browser_recorder
                                else None
                            ),
                        ],
                        start_to_close_timeout=timedelta(seconds=VERIFIER_ULTRA_TIMEOUT_SECONDS),
                    )

                    v_usage = progress_result.get("usage", {})
                    v_input_tokens = v_usage.get("prompt_tokens", 0) or 0
                    v_output_tokens = v_usage.get("completion_tokens", 0) or 0
                    total_input_tokens += v_input_tokens
                    total_output_tokens += v_output_tokens
                    accumulate_model_usage(
                        usage_by_model,
                        v_usage.get("actual_model"),
                        v_input_tokens,
                        v_output_tokens,
                        cache_read_input_tokens=int(v_usage.get("cache_read_input_tokens") or 0),
                        cache_creation_input_tokens=int(v_usage.get("cache_creation_input_tokens") or 0),
                        from_fast_cache=bool(v_usage.get("from_fast_cache")),
                    )

                    score = progress_result.get("score", 0.0)
                    v_reasoning = progress_result.get("reasoning", "")
                    if progress_result.get("structured_response") is not None:
                        latest_structured_response = progress_result["structured_response"]

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
                    if browser_recorder:
                        await browser_recorder.mark(
                            f"Verifier progress: {score * 100:.0f}%",
                            action="verify",
                        )

                    if score >= 1.0:
                        completion_tool_status = "FINISHED"
                        execution_time_ms = (safe_time() - start_time) * 1000
                        structured_response = progress_result.get("structured_response")

                        uploaded_paths = list(available_file_paths.values()) if available_file_paths else []
                        output_files = await extract_session_files(
                            session_id, user_id, config, exclude_paths=uploaded_paths
                        )

                        last_screenshot_b64 = browser_state.get("screenshot")
                        if last_screenshot_b64:
                            if browser_recorder:
                                await browser_recorder.write_final_screenshot(last_screenshot_b64)
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

                        await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                        dom_service = None
                        await close_browser_session(config, session_id, pause=False)

                        context_message = build_context_summary(
                            success=True,
                            close_reasoning=close_reasoning,
                            visited_urls=visited_urls,
                            reasoning_messages=reasoning_messages,
                            action_summary=action_summary,
                        )
                        context_message = append_completion_evidence(
                            context_message,
                            browser_url=current_url,
                            structured_response=structured_response,
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
                            output_schema=response_schema,
                        )

                        usage_items = build_usage_items(
                            total_input_tokens,
                            total_output_tokens,
                            model_pricing,
                            execution_time_ms,
                            usage_by_model,
                        )
                        await _propagate_browser_credentials_with_progress(
                            config=config,
                            agent_id=agent_id,
                            task_id=task_id,
                            browser_url=browser_url,
                            status="completed",
                            success=True,
                            message=context_message,
                        )

                        return {
                            "status": "completed",
                            "success": True,
                            "message": context_message,
                            "browser_url": browser_url,
                            "task_id": task_id,
                            "usage_items": usage_items,
                            "execution_time_ms": execution_time_ms,
                            "auth_assistance_resume_mode": auth_assistance_resume_mode,
                            "session_id": session_id,
                            "structured_response": structured_response,
                            "output_files": output_files,
                        }

                    verifier_feedback_thinking = f"""I just checked in with verifier for the task and it said:
<verifier_response>
Score: {score:.0%}
Reasoning: {v_reasoning}
</verifier_response>

Based on this feedback, I need to continue working on the task and address the issues mentioned."""

                    await save_browser_assistant_message(
                        agent_id,
                        verifier_feedback_thinking,
                        task_id,
                        stream_id=llm_result.get("_thinking_stream_id"),
                    )

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

                    current_state = await dom_service.get_browser_state(include_screenshot=False)
                    current_screenshot = current_state.get("screenshot")

                    rejection_result = {
                        "success": False,
                        "error": "Verifier rejected completion.",
                        "score": score,
                        "reasoning": v_reasoning,
                    }
                    _append_browser_turn_messages(
                        browser_turn_messages,
                        task=task_prompt,
                        browser_state=browser_state,
                        include_screenshot=False,
                        unified_action=unified_action,
                        result=rejection_result,
                        tool_call_id=continuing_tool_call_id,
                    )

                    await action_history.record_action(
                        dom_service=dom_service,
                        action="wait",
                        thinking=verifier_feedback_thinking,
                        result={
                            "success": True,
                            "message": "Verifier feedback processed",
                        },
                        screenshot=current_screenshot,
                    )

                    logger.info(
                        "\U0001f50d [TRACE] Recorded verifier feedback action",
                        step=len(action_history),
                        has_screenshot=bool(current_screenshot),
                        thinking_preview=verifier_feedback_thinking[:200],
                    )

                except Exception as verifier_error:
                    completion_tool_status = "ERROR"
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
                finally:
                    await browser_stream.finish_tools(status=completion_tool_status)

                continue

            # 6. Execute regular action
            tool_call_id_action = _browser_action_tool_call_id(llm_result)

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
                auxiliary=({"coordinates": coords_for_cursor} if coords_for_cursor else None),
            )
            if browser_recorder:
                await browser_recorder.mark(
                    title_progress,
                    action=action_name,
                    metadata={
                        "step": iteration,
                        "phase": "start",
                        "action": action_name,
                        "target_coordinates": coords_for_cursor,
                    },
                )

            # Resolve the background-attached network recorder so read_network_requests
            # can query captured traffic (the recorder attaches a few seconds into the run).
            if browser_network_recorder is None and network_recorder_task is not None and network_recorder_task.done():
                with contextlib.suppress(Exception):
                    browser_network_recorder = network_recorder_task.result()

            activity.heartbeat(f"Step {iteration} - executing {action_name}")
            try:
                result = await asyncio.wait_for(
                    execute_action(
                        dom_service,
                        action_history,
                        unified_action,
                        available_file_paths,
                        session_id=session_id,
                        config=config,
                        humanizer=humanizer,
                        secret_refs=secret_refs,
                        password_origins=password_origins,
                        credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                        user_id=user_id,
                        current_url=current_url,
                        trusted_page_urls=visited_urls,
                        write_lock_enabled=write_lock_enabled,
                        write_lock_approvals=write_lock_approvals,
                        system_name=system_name,
                        browser_network_recorder=browser_network_recorder,
                        current_auth_realm=auth_realm,
                        prepare_credentials_for_url=_prepare_credentials_for_url,
                        navigation_pin_host=navigation_pin_host,
                        navigation_origin_base_domain=navigation_origin_base_domain,
                    ),
                    timeout=BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                await _recover_browser_step(
                    f"action_timeout_{action_name}_{BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS}s",
                    reload_page=False,
                )
                result = {
                    "success": False,
                    "error": (
                        f"Browser action '{action_name}' timed out after "
                        f"{BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS}s; generic browser supervisor recovery ran."
                    ),
                    "supervisor_recovered": True,
                }
            except Exception as action_error:
                logger.error(
                    "Browser action raised exception",
                    agent_id=agent_id,
                    task_id=task_id,
                    session_id=session_id,
                    iteration=iteration,
                    current_url=current_url,
                    action_context=_summarize_browser_action_for_log(unified_action),
                    error_type=type(action_error).__name__,
                    error=extract_error_message(action_error),
                    traceback=traceback.format_exc(),
                )
                await _recover_browser_step(
                    f"action_error_{action_name}:{type(action_error).__name__}:"
                    f"{extract_error_message(action_error)[:160]}",
                    reload_page=False,
                )
                result = {
                    "success": False,
                    "error": (
                        f"Browser action '{action_name}' failed with {type(action_error).__name__}: "
                        f"{extract_error_message(action_error)[:300]}. "
                        "Generic browser supervisor recovery ran; continue from current page state."
                    ),
                    "supervisor_recovered": True,
                }
            if isinstance(result, dict) and result.get("current_url"):
                current_url = str(result.get("current_url") or "")
                if current_url and (not visited_urls or current_url != visited_urls[-1]):
                    visited_urls.append(current_url)
            if (
                not result.get("credential_ref")
                and action_name == "input_text"
                and minted_credential_ref
                and str(unified_action.get("params", {}).get("text", "")).strip().lower() in minted_account_labels
            ):
                result["credential_ref"] = minted_credential_ref

            _append_browser_turn_messages(
                browser_turn_messages,
                task=task_prompt,
                browser_state=browser_state,
                include_screenshot=False,
                unified_action=unified_action,
                result=result,
                tool_call_id=tool_call_id_action,
            )

            if result.get("status") == "needs_write_approval":
                approval_type = result.get("approval_type", "unknown")
                question = result.get(
                    "question",
                    f"{system_name} wants to perform a write action. Approve?",
                )
                write_lock_notification = None
                write_lock_notification_usage = None

                try:
                    activity.heartbeat(f"Step {iteration} - generating write lock notification")
                    notification_result = await _generate_write_lock_notification(
                        rose_client=rose_client,
                        task_prompt=task_prompt,
                        dynamic_system_context=dynamic_system_context,
                        browser_turn_messages=browser_turn_messages,
                        browser_state=browser_state,
                        action_entries=action_entries,
                        config=config,
                        user_id=user_id,
                        agent_id=agent_id,
                        browser_task_id=task_id,
                        iteration=iteration,
                        token_state=token_state,
                        gpt_token=gpt_token,
                        gpt_account_id=gpt_account_id,
                        gpt_token_source=gpt_token_source,
                        gpt_token_pool_id=gpt_token_pool_id,
                        browser_use_mode=browser_use_mode,
                        approval_type=approval_type,
                        current_url=current_url,
                        trusted_page_urls=visited_urls,
                        pending_action=unified_action,
                        write_lock_result=result,
                        system_name=system_name,
                        fallback_question=question,
                    )
                    write_lock_notification = notification_result.get("notification")
                    write_lock_notification_usage = {
                        "usage": notification_result.get("usage", {}),
                        "actual_model": notification_result.get("actual_model"),
                        "request_id": notification_result.get("request_id"),
                        "mode": notification_result.get("mode"),
                    }
                    question = notification_result.get("question") or question
                    logger.info(
                        "Generated write lock notification metadata",
                        approval_type=approval_type,
                        request_id=write_lock_notification_usage.get("request_id"),
                        mode=write_lock_notification_usage.get("mode"),
                        cache_read_input_tokens=(
                            write_lock_notification_usage.get("usage", {}).get("cache_read_input_tokens", 0)
                        ),
                        cache_creation_input_tokens=(
                            write_lock_notification_usage.get("usage", {}).get("cache_creation_input_tokens", 0)
                        ),
                    )
                except Exception as notification_error:
                    _enforce_write_lock_notification_failure_policy(approval_type, notification_error)
                    logger.warning(
                        "Failed to generate write lock notification metadata; using fallback question",
                        approval_type=approval_type,
                        error=str(notification_error),
                    )

                logger.info(
                    "Write lock approval required - returning to workflow",
                    approval_type=approval_type,
                    url=current_url,
                )

                checkpoint = _browser_ground_truth_checkpoint(browser_state, current_url)
                _append_bounded_verifier_checkpoint(verifier_checkpoints, checkpoint)

                if dom_service:
                    try:
                        await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                        dom_service = None
                    except Exception as e:
                        logger.warning(f"Failed to disconnect browser before write lock return: {e}")

                logger.info(
                    "Returning to workflow for write lock approval",
                    task_id=task_id,
                    session_id=session_id,
                    cdp_url=cdp_url[:50] if cdp_url else None,
                )
                await browser_stream.finish_tools(status="FINISHED")
                return {
                    "status": "awaiting_write_approval",
                    "approval_type": approval_type,
                    "question": question,
                    "current_url": current_url,
                    "pending_action": unified_action,
                    "pending_action_target": llm_result.get("_fast_cache_browser_target"),
                    "write_lock_notification": write_lock_notification,
                    "write_lock_notification_usage": write_lock_notification_usage,
                    "write_lock_approvals": write_lock_approvals,
                    "step_count": iteration,
                    "session_id": session_id,
                    "cdp_url": cdp_url,
                    "task_id": task_id,
                    "auth_realm": auth_realm,
                    "recorded_passkey_credential_ids": sorted(recorded_passkey_credential_ids),
                    **_browser_resume_continuity_state(
                        action_history=action_history,
                        visited_urls=visited_urls,
                        verifier_checkpoints=verifier_checkpoints,
                    ),
                }

            if result.get("status") in {"needs_payment_card_approval", "awaiting_payment_card_approval"}:
                payment_request = result.get("payment_request", {})
                logger.info(
                    "Payment card approval required - returning to workflow",
                    agent_id=agent_id,
                    task_id=task_id,
                    session_id=session_id,
                    iteration=iteration,
                    url=current_url,
                    payment_request_summary=_summarize_payment_request_for_log(payment_request),
                )

                # Close out the request_payment_card action message. This activity returns to the
                # workflow here, BEFORE the generic success branch below that saves the FINISHED
                # row. Without this, the IN_PROGRESS row saved at the top of the loop (same
                # tool_call_id_action) never gets a matching FINISHED row and the tool call spins
                # forever in the UI. The request itself succeeded — the approval/mint that follows
                # is surfaced separately by the workflow's "Payment card ready" event.
                await save_browser_action_message(
                    agent_id=agent_id,
                    title=title_done,
                    task_id=task_id,
                    message="",
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url,
                    action_type=action_name,
                    tool_call_id=tool_call_id_action,
                    steps_taken=iteration,
                    total_steps=MAX_ITERATIONS,
                )

                # Generate the same rich write-lock notification the write-approval path produces so
                # the payment approval renders #662's itemized purchase notification instead of a
                # plain question. Best-effort — the workflow falls back to build_payment_question.
                payment_write_lock_notification = None
                payment_write_lock_notification_usage = None
                try:
                    activity.heartbeat(f"Step {iteration} - generating payment approval notification")
                    payment_notification_result = await _generate_write_lock_notification(
                        rose_client=rose_client,
                        task_prompt=task_prompt,
                        dynamic_system_context=dynamic_system_context,
                        browser_turn_messages=browser_turn_messages,
                        browser_state=browser_state,
                        action_entries=action_entries,
                        config=config,
                        user_id=user_id,
                        agent_id=agent_id,
                        browser_task_id=task_id,
                        iteration=iteration,
                        token_state=token_state,
                        gpt_token=gpt_token,
                        gpt_account_id=gpt_account_id,
                        gpt_token_source=gpt_token_source,
                        gpt_token_pool_id=gpt_token_pool_id,
                        browser_use_mode=browser_use_mode,
                        approval_type="payment",
                        current_url=current_url,
                        trusted_page_urls=visited_urls,
                        pending_action=unified_action,
                        write_lock_result=result,
                        system_name=system_name,
                        fallback_question=f"{system_name} wants to make a purchase. Approve?",
                    )
                    payment_write_lock_notification = payment_notification_result.get("notification")
                    payment_write_lock_notification_usage = {
                        "usage": payment_notification_result.get("usage", {}),
                        "actual_model": payment_notification_result.get("actual_model"),
                        "request_id": payment_notification_result.get("request_id"),
                        "mode": payment_notification_result.get("mode"),
                    }
                except Exception as notification_error:
                    logger.warning(
                        "Failed to generate payment approval notification; using fallback question",
                        error=str(notification_error),
                    )

                checkpoint = _browser_ground_truth_checkpoint(browser_state, current_url)
                _append_bounded_verifier_checkpoint(verifier_checkpoints, checkpoint)

                if dom_service:
                    try:
                        await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                        dom_service = None
                    except Exception as e:
                        logger.warning(f"Failed to disconnect browser before payment card return: {e}")

                await browser_stream.finish_tools(status="FINISHED")
                return {
                    "status": "awaiting_payment_card_approval",
                    "payment_request": payment_request,
                    "current_url": current_url,
                    "write_lock_notification": payment_write_lock_notification,
                    "write_lock_notification_usage": payment_write_lock_notification_usage,
                    "write_lock_approvals": write_lock_approvals,
                    "step_count": iteration,
                    "session_id": session_id,
                    "cdp_url": cdp_url,
                    "task_id": task_id,
                    "auth_realm": auth_realm,
                    "recorded_passkey_credential_ids": sorted(recorded_passkey_credential_ids),
                    **_browser_resume_continuity_state(
                        action_history=action_history,
                        visited_urls=visited_urls,
                        verifier_checkpoints=verifier_checkpoints,
                    ),
                }

            if result.get("success", True):
                logger.info(
                    f"Action {action_name} successful",
                    agent_id=agent_id,
                    title=title_done,
                    task_id=task_id,
                )
                if input_page and _botsigged_diagnostics_enabled(start_url):
                    with contextlib.suppress(Exception):
                        await _capture_botsigged_diagnostics(
                            input_page,
                            agent_id=agent_id,
                            task_id=task_id,
                            checkpoint=f"after_action_{iteration}_{action_name}",
                        )
                extra_metadata = None
                if result.get("credential_ref"):
                    auth_runtime_state.mark_credential_ref(result["credential_ref"])
                    extra_metadata = {"credential_ref": result["credential_ref"]}
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
                    auxiliary=({"coordinates": coords_for_cursor} if coords_for_cursor else None),
                    extra_metadata=extra_metadata,
                )
                if browser_recorder:
                    await browser_recorder.mark(
                        title_done,
                        action=action_name,
                        metadata={
                            "step": iteration,
                            "phase": "finish",
                            "action": action_name,
                            "target_coordinates": coords_for_cursor,
                        },
                    )
                await browser_stream.finish_tools(status="FINISHED")
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
                    auxiliary=({"coordinates": coords_for_cursor} if coords_for_cursor else None),
                )
                if browser_recorder:
                    await browser_recorder.mark(
                        title_done,
                        action="error",
                        metadata={
                            "step": iteration,
                            "phase": "error",
                            "action": action_name,
                            "target_coordinates": coords_for_cursor,
                        },
                    )
                await browser_stream.finish_tools(status="ERROR")

            await asyncio.sleep(ACTION_LOOP_DELAY_SECONDS)

        # Max iterations reached
        logger.warning(f"Max iterations reached: {MAX_ITERATIONS}")

        # Final synthesis pass — mirror run_agent's max-iterations handling
        # (loop/run_agent.py:1889). A browser sub-agent that exhausts its step
        # budget without ever calling attempt_completion would otherwise hand
        # the parent structured_response=None. Run the verifier one last time
        # against final-state ground truth to salvage partial structured data,
        # so the parent receives best-effort output instead of an empty payload.
        # Must run BEFORE the session is closed (verifier reads session files).
        # Guarded: any failure leaves structured_response unchanged (no worse
        # than before) and never blocks the terminal return.
        if latest_structured_response is None and response_schema and dom_service:
            try:
                # Re-read the FINAL-state DOM before grading: browser_state was
                # captured before the last action, so verifying against it evaluates
                # stale ground truth and can misreport a last-step completion. Fall
                # back to the last-known state if the refresh fails.
                try:
                    browser_state = await asyncio.wait_for(
                        dom_service.get_browser_state(include_screenshot=False),
                        timeout=10,
                    )
                    current_url = browser_state.get("url", current_url) or current_url
                except Exception:
                    pass
                if not browser_state:
                    raise RuntimeError("no browser_state available for final verifier pass")
                final_verifier_context = await build_browser_verifier_context(
                    goal=goal,
                    current_url=current_url,
                    browser_state=browser_state,
                    action_history=action_history,
                    config=config,
                    session_id=session_id,
                    browser_checkpoints=verifier_checkpoints,
                )
                final_verifier_prompt = build_verifier_prompt(
                    response_schema=transform_schema_for_remote_session(response_schema)
                )
                final_progress = await call_temporal_activity_from_activity(
                    check_progress,
                    args=[
                        final_verifier_context,
                        final_verifier_prompt,
                        VERIFIER_ULTRA_MODEL,
                        transform_schema_for_remote_session(response_schema),
                        token_state.access_token,
                        "verifier_browser_max_steps",
                        agent_id,
                        None,
                        None,
                        user_id,
                        gpt_token,
                        gpt_account_id,
                        gpt_token_source,
                        gpt_token_pool_id,
                        user_id,
                        None,
                        None,
                        (
                            {
                                "browser_recording_manifest_path": str(browser_recorder.output_dir / "manifest.json"),
                                "browser_recording_path": str(browser_recorder.output_dir / "index.html"),
                                "browser_recording_task_id": browser_recorder.task_id,
                                "browser_session_metadata": browser_session_metadata,
                            }
                            if browser_recorder
                            else None
                        ),
                    ],
                    start_to_close_timeout=timedelta(seconds=VERIFIER_ULTRA_TIMEOUT_SECONDS),
                )
                fv_usage = final_progress.get("usage", {})
                fv_input_tokens = fv_usage.get("prompt_tokens", 0) or 0
                fv_output_tokens = fv_usage.get("completion_tokens", 0) or 0
                total_input_tokens += fv_input_tokens
                total_output_tokens += fv_output_tokens
                accumulate_model_usage(
                    usage_by_model,
                    fv_usage.get("actual_model"),
                    fv_input_tokens,
                    fv_output_tokens,
                    cache_read_input_tokens=int(fv_usage.get("cache_read_input_tokens") or 0),
                    cache_creation_input_tokens=int(fv_usage.get("cache_creation_input_tokens") or 0),
                    from_fast_cache=bool(fv_usage.get("from_fast_cache")),
                )
                if final_progress.get("structured_response") is not None:
                    latest_structured_response = final_progress["structured_response"]
            except Exception as final_verifier_error:
                logger.warning(
                    "[BrowserAgent] Final max-steps verifier pass failed; returning best-effort text only",
                    agent_id=agent_id,
                    error=extract_error_message(final_verifier_error),
                )

        await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
        dom_service = None
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
            output_schema=response_schema,
        )

        execution_time_ms = (safe_time() - start_time) * 1000
        usage_items = build_usage_items(
            total_input_tokens,
            total_output_tokens,
            model_pricing,
            execution_time_ms,
            usage_by_model,
        )
        await _propagate_browser_credentials_with_progress(
            config=config,
            agent_id=agent_id,
            task_id=task_id,
            browser_url=browser_url,
            status="max_iterations",
            success=False,
            message=context_message,
        )

        # Best-effort answer — mirror run_agent's best_effort_response
        # (loop/run_agent.py). Surfaces the agent's last synthesized reasoning
        # as usable output so a runaway that never called attempt_completion
        # still returns something the parent can act on, not an empty payload.
        best_effort_response = build_best_effort_response(
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            visited_urls=visited_urls,
        )

        return {
            "status": "max_iterations",
            "success": False,
            "message": context_message,
            "browser_url": browser_url,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms,
            "structured_response": latest_structured_response,
            "best_effort_response": best_effort_response,
        }

    except asyncio.CancelledError:
        logger.info("\U0001f534 Browser agent activity cancelled (paused)")

        if dom_service:
            with contextlib.suppress(Exception):
                await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                dom_service = None

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
                    output_schema=response_schema,
                )

        return {
            "status": "cancelled",
            "task_id": task_id,
            "session_id": session_id,
            "browser_url": browser_url,
            "message": "Browser agent cancelled by user",
        }

    except Exception as e:
        last_action = action_summary[-1] if action_summary else "initialization"
        logger.error(
            "Browser automation failed",
            agent_id=agent_id,
            task_id=task_id,
            session_id=session_id,
            error_type=type(e).__name__,
            error=extract_error_message(e),
            current_url=current_url,
            last_action=last_action,
            action_count=len(action_summary),
            visited_url_count=len(visited_urls),
            latest_structured_response_keys=(
                list(latest_structured_response.keys()) if isinstance(latest_structured_response, dict) else None
            ),
            traceback=traceback.format_exc(),
        )

        if dom_service:
            with contextlib.suppress(Exception):
                await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                dom_service = None

        if session_id:
            retryable_notification_error = isinstance(e, PurchaseApprovalNotificationRetryableError)
            await close_browser_session(
                config,
                session_id,
                pause=retryable_notification_error,
                current_url=current_url if retryable_notification_error else None,
            )

        error_context = f"Failed during: {last_action}"
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
                    output_schema=response_schema,
                    extra_metadata={
                        "browser_error_type": type(e).__name__,
                        "browser_error_message": extract_error_message(e),
                        "browser_error_context": error_context,
                        "browser_last_action": last_action,
                        "browser_current_url": current_url,
                    },
                )
            try:
                await _propagate_browser_credentials_with_progress(
                    config=config,
                    agent_id=agent_id,
                    task_id=task_id,
                    browser_url=browser_url or "",
                    status="error",
                    success=False,
                    message=error_message,
                )
            except Exception as propagation_error:
                logger.warning(
                    "Credential propagation failed after browser error; preserving original browser error",
                    error=extract_error_message(propagation_error),
                )

        raise
    finally:
        _hb_stop.set()
        _heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _heartbeat_task
        diagnostics_finalized = False
        if browser_network_recorder is None and network_recorder_task is not None:
            try:
                browser_network_recorder = await asyncio.wait_for(
                    asyncio.shield(network_recorder_task),
                    timeout=10,
                )
            except Exception as diagnostics_resolve_error:
                logger.warning(
                    "Browser diagnostics recorder was unavailable before activity return",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=extract_error_message(diagnostics_resolve_error),
                )
        if browser_network_recorder is not None:
            try:
                await _finalize_browser_diagnostics_for_fe(
                    browser_network_recorder=browser_network_recorder,
                    agent_id=agent_id,
                    task_id=task_id,
                    user_id=user_id,
                    browser_url=browser_url,
                )
                diagnostics_finalized = True
            except Exception as diagnostics_error:
                logger.warning(
                    "Browser diagnostics finalization failed before activity return",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=extract_error_message(diagnostics_error),
                )
        _schedule_browser_cleanup(
            agent_id=agent_id,
            task_id=task_id,
            user_id=user_id,
            browser_url=browser_url,
            browser_session_metadata=dict(browser_session_metadata),
            input_page=input_page,
            start_url=start_url,
            cursor_streamer=cursor_streamer,
            interaction_layer_task=interaction_layer_task,
            humanizer=humanizer,
            browser_network_recorder=None if diagnostics_finalized else browser_network_recorder,
            network_recorder_task=None if diagnostics_finalized else network_recorder_task,
            browser_recorder=browser_recorder,
            dom_service=dom_service,
            playwright_browser=playwright_browser,
            playwright_instance=playwright_instance,
            playwright_driver_pid=playwright_driver_pid,
        )
        playwright_browser = None
        playwright_instance = None
        input_page = None
        dom_service = None
        _clear_browser_activity_memory_buffers(
            action_history=action_history,
            browser_network_recorder=browser_network_recorder if diagnostics_finalized else None,
            mutable_buffers=(
                action_entries,
                browser_state,
                browser_turn_messages,
                otp_user_messages,
                seen_otp_codes,
                visited_urls,
                reasoning_messages,
                action_summary,
                resume_user_messages,
                session_passwords,
                session_passkeys,
                available_file_paths,
                passkey_ref_by_credential_id,
                browser_session_metadata,
            ),
        )


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
            current_start_url = start_url
            result = None

            while True:
                activity_args = [
                    user_id,
                    agent_id,
                    goal,
                    tool_call_id,
                    (write_lock_resume_state.get("task_id") if write_lock_resume_state else None),
                    (write_lock_resume_state.get("session_id") if write_lock_resume_state else None),
                    (write_lock_resume_state.get("cdp_url") if write_lock_resume_state else None),
                    write_lock_resume_state is not None,
                    output_schema,
                    attachments if attachments else None,
                    write_lock_enabled,
                    current_start_url,
                    write_lock_resume_state,
                    system_name,
                    bool(active_claude_token) and not bool(active_gpt_token),
                    active_gpt_token,
                    active_gpt_account_id,
                    active_gpt_source,
                    active_gpt_pool_id,
                    False,
                ]
                world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
                if world_model_mode != "real":
                    activity_args.append(world_model_mode)
                async with span(
                    "browser_activity_wait",
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name="spawn_browser_agent",
                    is_resume=write_lock_resume_state is not None,
                    span_source="agents.domains.spawn_browser_agent_v3.handler.SpawnBrowserAgentManagerV3.execute",
                    span_key="agents.domains.spawn_browser_agent_v3.handler.SpawnBrowserAgentManagerV3.execute",
                ):
                    activity_handle = workflow.start_activity(
                        spawn_browser_agent_activity_v3,
                        args=activity_args,
                        start_to_close_timeout=timedelta(minutes=ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES),
                        heartbeat_timeout=timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS),
                        cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                        retry_policy=RetryPolicy(maximum_attempts=MAX_ACTIVITY_ATTEMPTS),
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
                        result = {
                            "status": "cancelled",
                            "message": "Browser agent cancelled by user",
                        }

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

                    from tools.request_user_approval import (
                        UserRejectedError,
                        request_user_approval_direct,
                    )

                    try:
                        approval_response = await request_user_approval_direct(
                            workflow_instance,
                            question=result["question"],
                            metadata={
                                "toolApproval": True,
                                "writePermission": True,
                                "url": result.get("current_url", ""),
                                "writeLockNotification": result.get("write_lock_notification"),
                                "writeLockNotificationUsage": result.get("write_lock_notification_usage"),
                            },
                        )

                        approval_type = result.get("approval_type", "unknown")
                        current_approvals = dict(result.get("write_lock_approvals") or {})
                        approved_at = workflow.now().timestamp()
                        # Prefer merchant checkout URL over Kernel live-view current_url
                        # so a write-lock approval after payment does not re-key the
                        # domain to *.kernel.sh / *.onkernel.com.
                        grant_url = (
                            resolve_site_write_lock_grant_url(
                                {
                                    **(result if isinstance(result, dict) else {}),
                                    "start_url": current_start_url or start_url,
                                }
                            )
                            or result.get("current_url", "")
                        )
                        current_approvals[approval_type] = {
                            "domain": get_domain_from_url(grant_url),
                            "approved_at": approved_at,
                        }
                        # Payment-card mint already unlocked the site for this
                        # activity — keep that session-scoped site unlock alive
                        # across later write-lock approvals on the same page.
                        prior_resume = write_lock_resume_state or {}
                        prior_payment_refs = prior_resume.get("payment_card_refs")
                        prior_payment_last4 = prior_resume.get("payment_card_last4")
                        if prior_payment_refs or current_approvals.get(SITE_WRITE_LOCK_APPROVAL_KEY):
                            current_approvals = grant_site_write_lock_approvals(
                                current_approvals,
                                grant_url,
                                approved_at,
                            )

                        write_lock_resume_state = {
                            "pending_action": result.get("pending_action"),
                            "pending_action_target": result.get("pending_action_target"),
                            "write_lock_approvals": current_approvals,
                            "approval_type": approval_type,
                            "step_count": result.get("step_count", 0),
                            "session_id": result.get("session_id"),
                            "cdp_url": result.get("cdp_url"),
                            "task_id": result.get("task_id"),
                            "auth_realm": result.get("auth_realm"),
                            "recorded_passkey_credential_ids": result.get("recorded_passkey_credential_ids", []),
                        }
                        # Preserve minted card refs across write-lock resumes so
                        # purchase bypass + site unlock stay available.
                        if prior_payment_refs:
                            write_lock_resume_state["payment_card_refs"] = prior_payment_refs
                        if prior_payment_last4:
                            write_lock_resume_state["payment_card_last4"] = prior_payment_last4
                        _copy_browser_resume_continuity_fields(result, write_lock_resume_state)
                        _copy_simulated_browser_resume_fields(result, write_lock_resume_state)

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
                            rejection_feedback=(rejection_feedback[:100] if rejection_feedback else ""),
                        )
                        error_msg = f"User denied permission for {result.get('approval_type', 'action')}"
                        if rejection_feedback:
                            error_msg = f'User rejected with feedback: "{rejection_feedback}"\n\n{error_msg}'
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="Action blocked by user",
                            message=error_msg,
                            status=MessageStatus.FINISHED,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "action_type": "write_lock_rejected",
                            },
                        )
                        return

                if result and result.get("status") == "awaiting_payment_card_approval":
                    from tools.request_user_approval import (
                        request_user_approval_direct,
                        request_user_attention_direct,
                    )

                    logger.info(
                        "Browser payment approval started",
                        agent_id=workflow_instance.agent_id,
                        task_id=result.get("task_id"),
                        session_id=result.get("session_id"),
                        current_url=result.get("current_url"),
                        payment_request_summary=_summarize_payment_request_for_log(result.get("payment_request", {})),
                    )
                    payment_payload = normalize_payment_payload(
                        result.get("payment_request", {}),
                        workflow_instance.user_id or "",
                    )
                    # Link the purchase to this agent. main's normalize_payment_payload
                    # intentionally omits agentId from the fingerprint (user-scoped
                    # idempotent reuse), but the purchase row still needs the agentId so
                    # the lifecycle lookup (findLatestPurchaseLifecycleByAgentId) and
                    # session-end cleanup can find it. Set it after normalize so the
                    # fingerprint stays user-scoped.
                    payment_payload["agentId"] = workflow_instance.agent_id
                    logger.info(
                        "Browser payment payload normalized",
                        agent_id=workflow_instance.agent_id,
                        task_id=result.get("task_id"),
                        fingerprint=payment_payload.get("fingerprint"),
                        payment_request_summary=_summarize_payment_request_for_log(payment_payload),
                    )
                    lookup_result, matched_fingerprint = await _lookup_payment_purchase(
                        workflow_instance.user_id or "",
                        payment_payload,
                        getattr(workflow_instance, "world_model_mode", "real"),
                    )
                    # Mint uses the same fingerprint as lookup. When a held
                    # purchase was created before canonicalization shipped,
                    # retain its legacy key so the backend returns that card.
                    payment_payload["fingerprint"] = matched_fingerprint
                    logger.info(
                        "Browser payment purchase lookup finished",
                        agent_id=workflow_instance.agent_id,
                        task_id=result.get("task_id"),
                        fingerprint=payment_payload.get("fingerprint"),
                        reusable=lookup_result.get("reusable"),
                    )

                    # Always surface payment_approval attention — even when a held
                    # purchase is reusable. Skipping it left fleets with
                    # attentionRequestId=null, so Place-order write_lock became the
                    # first observed attention ("Expected payment_approval, observed
                    # write_lock") and H-06 site unlock was never gated on a real
                    # approval. Reuse still applies at mint; this only restores the
                    # approval UX / benchmark contract.
                    approval_response = await request_user_approval_direct(
                        workflow_instance,
                        question=build_payment_question(payment_payload),
                        metadata={
                            "toolApproval": True,
                            "writePermission": True,
                            "url": result.get("current_url", "")
                            or current_start_url
                            or start_url,
                            "requestPaymentCard": payment_payload,
                            "writeLockNotification": result.get("write_lock_notification"),
                            "writeLockNotificationUsage": result.get("write_lock_notification_usage"),
                            "reusablePurchase": bool(lookup_result.get("reusable")),
                        },
                    )
                    logger.info(
                        "Browser payment approval granted",
                        agent_id=workflow_instance.agent_id,
                        task_id=result.get("task_id"),
                        attention_request_id=approval_response.get("attention_request_id"),
                        reusable=bool(lookup_result.get("reusable")),
                    )

                    funding_retry_deadline = None

                    async def mint_payment_card() -> Dict[str, Any]:
                        nonlocal funding_retry_deadline
                        activity_args = [workflow_instance.user_id or "", payment_payload]
                        world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
                        if world_model_mode != "real":
                            activity_args.append(world_model_mode)
                        while True:
                            minted_card = await workflow.execute_activity(
                                "mint_purchase_card_activity",
                                args=activity_args,
                                start_to_close_timeout=timedelta(seconds=MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS),
                                retry_policy=RetryPolicy(maximum_attempts=1),
                            )
                            if minted_card.get("status") != "agentcard_company_funding_in_progress":
                                return minted_card

                            if funding_retry_deadline is None:
                                funding_retry_deadline = workflow.now() + timedelta(minutes=10)
                            retry_seconds = _normalize_funding_retry_seconds(minted_card.get("retryAfterSeconds", 5))
                            if workflow.now() + timedelta(seconds=retry_seconds) >= funding_retry_deadline:
                                return minted_card
                            logger.info(
                                "AgentCard company funding pending; resuming same purchase",
                                agent_id=workflow_instance.agent_id,
                                task_id=result.get("task_id"),
                                retry_seconds=retry_seconds,
                            )
                            await workflow.sleep(retry_seconds)

                    async def create_agentcard_setup_attention(
                        setup_card: Dict[str, Any],
                    ) -> Dict[str, Any]:
                        setup_action = setup_card.get("setupAction") or "connect_agentcard"
                        connect_url = setup_card.get("connectUrl") or ""
                        agentcard_status = setup_card.get("agentcardStatus") or "setup_required"
                        setup_url = setup_card.get("setupUrl") or setup_card.get("checkoutUrl") or ""
                        primary_setup_url = setup_url or connect_url
                        setup_title = "One Time Agent Payment Setup"
                        setup_question = (
                            "One Time Agent Payment Setup is required before I can issue "
                            "the one-time payment card for your approved purchase."
                        )
                        if primary_setup_url:
                            setup_question = f"{setup_question}\n\nOpen this setup link:\n{primary_setup_url}"
                        setup_question = (
                            f"{setup_question}\n\nAfter setup is complete, return to Rose "
                            "and I will retry the payment automatically."
                        )
                        setup_attention = await request_user_attention_direct(
                            workflow_instance,
                            question=setup_question,
                            title=setup_title,
                            metadata={
                                "attentionKind": f"agentcard_user_{agentcard_status}",
                                "toolName": "spawn_browser_agent",
                                # The outer browser tool emits the same setup state on
                                # its own tool-call id, then supersedes it with the
                                # resumed checkout result. Keep this standalone row
                                # visible to the user without leaving stale setup work
                                # in the parent model's context after checkout succeeds.
                                "excludeFromModel": True,
                                "task_id": result.get("task_id"),
                                "action_type": f"agentcard_user_{agentcard_status}",
                                "agentCardSetup": {
                                    "status": agentcard_status,
                                    "setupAction": setup_action,
                                    "connectUrl": connect_url,
                                    "setupUrl": primary_setup_url,
                                    "setupTool": setup_card.get("setupTool"),
                                    "setupStatus": setup_card.get("setupStatus"),
                                    "setupSessionId": setup_card.get("setupSessionId"),
                                    "title": setup_title,
                                },
                                "requestPaymentCard": payment_payload,
                                "previousPaymentApprovalAttentionRequestId": approval_response.get(
                                    "attention_request_id"
                                ),
                            },
                            sms_event_type="agentcard_setup",
                            sms_payload={
                                "setup_url": primary_setup_url,
                                "agentcard_status": agentcard_status,
                            },
                        )
                        return {
                            "setup_action": setup_action,
                            "connect_url": connect_url,
                            "agentcard_status": agentcard_status,
                            "primary_setup_url": primary_setup_url,
                            "setup_title": setup_title,
                            "setup_question": setup_question,
                            "setup_attention": setup_attention,
                            "setup_card": setup_card,
                        }

                    card = await mint_payment_card()
                    waited_for_agentcard_setup = False
                    while card.get("status") == "agentcard_setup_required":
                        setup_info = await create_agentcard_setup_attention(card)
                        logger.info(
                            "Created AgentCard setup attention request",
                            agentcard_status=setup_info["agentcard_status"],
                            setup_action=setup_info["setup_action"],
                            attention_request_id=setup_info["setup_attention"].get("attention_request_id"),
                        )
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title=setup_info["setup_title"],
                            message=setup_info["setup_question"],
                            status=MessageStatus.FINISHED,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "task_id": result.get("task_id"),
                                "action_type": f"agentcard_user_{setup_info['agentcard_status']}",
                                "agentCardSetup": {
                                    "status": setup_info["agentcard_status"],
                                    "setupAction": setup_info["setup_action"],
                                    "connectUrl": setup_info["connect_url"],
                                    "setupUrl": setup_info["primary_setup_url"],
                                    "setupTool": card.get("setupTool"),
                                    "setupStatus": card.get("setupStatus"),
                                    "setupSessionId": card.get("setupSessionId"),
                                },
                                "agentCardSetupAttentionRequestId": setup_info["setup_attention"].get(
                                    "attention_request_id"
                                ),
                                "previousPaymentApprovalAttentionRequestId": approval_response.get(
                                    "attention_request_id"
                                ),
                            },
                        )

                        if waited_for_agentcard_setup:
                            return

                        waited_for_agentcard_setup = True
                        connect_deadline = workflow.now() + timedelta(minutes=10)
                        agentcard_status_result: Dict[str, Any] = {"connected": False}
                        while workflow.now() < connect_deadline:
                            agentcard_status_result = await workflow.execute_activity(
                                "agentcard_status_activity",
                                args=[workflow_instance.user_id or ""],
                                start_to_close_timeout=timedelta(seconds=30),
                                retry_policy=RetryPolicy(maximum_attempts=3),
                            )
                            if agentcard_status_result.get("connected"):
                                break
                            await workflow.sleep(5)

                        if not agentcard_status_result.get("connected"):
                            logger.info(
                                "Timed out waiting for AgentCard setup",
                                agentcard_status=setup_info["agentcard_status"],
                                attention_request_id=setup_info["setup_attention"].get("attention_request_id"),
                            )
                            return

                        logger.info(
                            "AgentCard setup completed; retrying card mint",
                            attention_request_id=setup_info["setup_attention"].get("attention_request_id"),
                        )
                        setup_attention_id = setup_info["setup_attention"].get("attention_request_id")
                        if setup_attention_id:
                            await workflow.execute_activity(
                                "resolve_attention_request_activity",
                                args=[
                                    workflow_instance.user_id or "",
                                    setup_attention_id,
                                    "AgentCard setup completed.",
                                ],
                                start_to_close_timeout=timedelta(seconds=30),
                                retry_policy=RetryPolicy(maximum_attempts=3),
                            )
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="Agent payment setup complete",
                            message="Agent payment setup is complete. Retrying the one-time payment card.",
                            status=MessageStatus.FINISHED,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "task_id": result.get("task_id"),
                                "action_type": "agentcard_user_setup_completed",
                                "agentCardSetup": {
                                    "status": "connected",
                                    "previousStatus": setup_info["agentcard_status"],
                                },
                                "agentCardSetupAttentionRequestId": setup_attention_id,
                                "previousPaymentApprovalAttentionRequestId": approval_response.get(
                                    "attention_request_id"
                                ),
                            },
                        )
                        card = await mint_payment_card()

                    # Subscription gate: minting real money requires an active
                    # plan. If the backend says so, raise a subscription gate
                    # ORGANICALLY (not injected) and retry once it's resolved.
                    if card.get("status") == "subscription_required":
                        from tools.gate import (
                            GateRejectedError,
                            build_subscription_gate,
                            mint_subscription_checkout_activity,
                            raise_gate_direct,
                        )

                        checkout_url = None
                        try:
                            checkout_url = await workflow.execute_activity(
                                mint_subscription_checkout_activity,
                                args=[workflow_instance.user_id or ""],
                                start_to_close_timeout=timedelta(seconds=30),
                                retry_policy=RetryPolicy(maximum_attempts=3),
                            )
                        except Exception as exc:
                            logger.warning(
                                "Subscription checkout URL unavailable; raising subscription gate with default action",
                                error=extract_error_message(exc),
                            )

                        try:
                            await raise_gate_direct(
                                workflow_instance,
                                build_subscription_gate(checkout_url=checkout_url),
                                gate_key="subscription",
                            )
                        except GateRejectedError:
                            yield ToolEvent(
                                type=EventType.POST_MESSAGE,
                                title="Purchase cancelled",
                                message="A subscription is required to complete purchases — cancelled for now.",
                                status=MessageStatus.FINISHED,
                                metadata={
                                    "toolName": "spawn_browser_agent",
                                    "action_type": "purchase_cancelled",
                                },
                            )
                            return

                        # Resolved — retry the mint now that the user has subscribed.
                        card = await mint_payment_card()
                        if card.get("status") == "subscription_required":
                            yield ToolEvent(
                                type=EventType.POST_MESSAGE,
                                title="Subscription still inactive",
                                message="I couldn't confirm an active subscription yet, so I can't complete the purchase.",
                                status=MessageStatus.FINISHED,
                                metadata={
                                    "toolName": "spawn_browser_agent",
                                    "action_type": "purchase_blocked",
                                },
                            )
                            return

                    # KYC gate: AgentCard can reject card issuing when the
                    # customer/cardholder still needs identity verification.
                    # Raise the blocking KYC gate and retry once the webhook
                    # resolves it.
                    if card.get("status") == "kyc_required":
                        from tools.gate import (
                            GateRejectedError,
                            build_kyc_gate,
                            raise_gate_direct,
                        )

                        try:
                            await raise_gate_direct(
                                workflow_instance,
                                build_kyc_gate(),
                                gate_key="kyc",
                            )
                        except GateRejectedError:
                            yield ToolEvent(
                                type=EventType.POST_MESSAGE,
                                title="Purchase cancelled",
                                message="Identity verification is required to issue a card — cancelled for now.",
                                status=MessageStatus.FINISHED,
                                metadata={
                                    "toolName": "spawn_browser_agent",
                                    "action_type": "purchase_cancelled",
                                },
                            )
                            return

                        card = await mint_payment_card()
                        if card.get("status") == "kyc_required":
                            yield ToolEvent(
                                type=EventType.POST_MESSAGE,
                                title="Identity verification still incomplete",
                                message="I couldn't confirm completed identity verification yet, so I can't issue the card.",
                                status=MessageStatus.FINISHED,
                                metadata={
                                    "toolName": "spawn_browser_agent",
                                    "action_type": "purchase_blocked",
                                },
                            )
                            return

                    if card.get("status") == "agentcard_company_funding_in_progress":
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="Payment funding is delayed",
                            message=(
                                "AgentCard has not confirmed the company funding transfer yet. "
                                "The approved purchase is preserved and can be retried without "
                                "creating another charge."
                            ),
                            status=MessageStatus.FINISHED,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "task_id": result.get("task_id"),
                                "action_type": "purchase_funding_delayed",
                            },
                        )
                        return

                    logger.info(
                        "Browser payment card minted",
                        agent_id=workflow_instance.agent_id,
                        task_id=result.get("task_id"),
                        card_id=card.get("cardId") or card.get("id"),
                        last4=card.get("last4"),
                    )
                    card_number = card.get("pan") or card.get("cardNumber") or card.get("card_number") or ""
                    card_expiry = card.get("expiry") or card.get("expiration") or card.get("cardExpiry") or ""
                    card_cvv = card.get("cvv") or card.get("cvc") or card.get("cardCvv") or ""
                    payment_card_refs = {
                        "card_number": card_number,
                        "card_name": card.get("name") or "Rose Labs",
                        "card_expiry": card_expiry,
                        "card_cvv": card_cvv,
                    }

                    # Payment-card approval unlocks write locks on the merchant
                    # checkout domain for THIS browser activity only (resume state).
                    # Prefer normalized payment_payload product URLs + spawn
                    # start_url — Kernel live-view current_url is often a proxy
                    # host (*.kernel.sh / *.onkernel.com) and must not become the
                    # unlock domain. New spawns start empty.
                    grant_source = {
                        **(result if isinstance(result, dict) else {}),
                        "payment_request": payment_payload,
                        "start_url": current_start_url or start_url,
                    }
                    grant_url = resolve_site_write_lock_grant_url(grant_source)
                    current_approvals = grant_site_write_lock_approvals(
                        result.get("write_lock_approvals", {}),
                        grant_url,
                        workflow.now().timestamp(),
                    )
                    logger.info(
                        "Browser payment site write-lock unlock",
                        agent_id=workflow_instance.agent_id,
                        task_id=result.get("task_id"),
                        grant_url=grant_url,
                        unlock_domain=(current_approvals.get(SITE_WRITE_LOCK_APPROVAL_KEY) or {}).get(
                            "domain"
                        ),
                        current_url=result.get("current_url"),
                    )

                    write_lock_resume_state = {
                        "pending_action": None,
                        "write_lock_approvals": current_approvals,
                        "approval_type": "payment",
                        "step_count": result.get("step_count", 0),
                        "session_id": result.get("session_id"),
                        "cdp_url": result.get("cdp_url"),
                        "task_id": result.get("task_id"),
                        "auth_realm": result.get("auth_realm"),
                        "payment_card_refs": payment_card_refs,
                        "payment_card_last4": _normalize_payment_card_last4(card.get("last4")),
                        "recorded_passkey_credential_ids": result.get("recorded_passkey_credential_ids", []),
                    }
                    _copy_browser_resume_continuity_fields(result, write_lock_resume_state)
                    _copy_simulated_browser_resume_fields(result, write_lock_resume_state)

                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Payment card ready",
                        message=f"One-time card ending in {card.get('last4', '****')} is ready for checkout.",
                        status=MessageStatus.FINISHED,
                        metadata={
                            "toolName": "spawn_browser_agent",
                            "task_id": result.get("task_id"),
                            "requestUserApproval": {
                                "writePermission": True,
                                "attentionRequestId": approval_response.get("attention_request_id"),
                                "requestPaymentCard": payment_payload,
                            },
                        },
                    )

                    continue

                if result and result.get("status") == "awaiting_auth_assistance":
                    request_id = result.get("request_id")
                    base_site = result.get("base_site") or "Current Site"
                    auth_request = result.get("auth_assistance_request") or {}
                    auth_handoff = auth_request.get("handoff") or {}

                    logger.info(
                        "Browser agent needs user authentication assistance",
                        request_id=request_id,
                        base_site=base_site,
                    )

                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"Requesting User Assistance for {base_site} Login",
                        message="",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={
                            "toolName": "spawn_browser_agent",
                            "action_type": "auth_assistance",
                            "task_id": result.get("task_id"),
                            "requestUserAuthentication": {
                                "requestId": request_id,
                                "authRealm": result.get("auth_realm"),
                                "steelSessionId": result.get("session_id"),
                                "taskId": result.get("task_id"),
                                "handoffMode": result.get("handoff_mode"),
                                "browserUrl": result.get("browser_url"),
                                "liveViewUrl": (
                                    auth_request.get("liveViewUrl")
                                    or auth_request.get("live_view_url")
                                    or auth_handoff.get("liveViewUrl")
                                    or auth_handoff.get("live_view_url")
                                ),
                            },
                        },
                    )

                    if not request_id:
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="Authentication assistance failed",
                            message="Backend did not return an auth assistance request id.",
                            status=MessageStatus.ERROR,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "action_type": "auth_assistance",
                            },
                        )
                        return

                    workflow_instance.is_paused = True
                    if hasattr(workflow_instance, "_update_tree_state"):
                        await workflow_instance._update_tree_state(status="PAUSED")

                    await workflow.wait_condition(
                        lambda request_id=request_id: (
                            request_id in getattr(workflow_instance, "_signal_responses", {})
                            or not workflow_instance.is_paused
                        )
                    )
                    if request_id in getattr(workflow_instance, "_signal_responses", {}):
                        workflow_instance._signal_responses.pop(request_id, None)
                        workflow_instance.is_paused = False
                        if hasattr(workflow_instance, "_update_tree_state"):
                            await workflow_instance._update_tree_state(status="ACTIVE")

                    write_lock_resume_state = {
                        "pending_action": None,
                        "write_lock_approvals": result.get("write_lock_approvals", {}),
                        "approval_type": "auth_assistance",
                        "step_count": result.get("step_count", 0),
                        "session_id": result.get("session_id"),
                        "cdp_url": result.get("cdp_url"),
                        "handoff_mode": result.get("handoff_mode"),
                        "task_id": result.get("task_id"),
                        "auth_realm": result.get("auth_realm"),
                        "recorded_passkey_credential_ids": result.get("recorded_passkey_credential_ids", []),
                    }
                    _copy_browser_resume_continuity_fields(result, write_lock_resume_state)
                    _copy_simulated_browser_resume_fields(result, write_lock_resume_state)

                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="User Assistance Received",
                        message="",
                        status=MessageStatus.FINISHED,
                        metadata={
                            "toolName": "spawn_browser_agent",
                            "action_type": "auth_assistance",
                            "task_id": result.get("task_id"),
                            "requestUserAuthentication": {
                                "requestId": request_id,
                                "authRealm": result.get("auth_realm"),
                                "steelSessionId": result.get("session_id"),
                                "taskId": result.get("task_id"),
                                "handoffMode": result.get("handoff_mode"),
                            },
                        },
                    )

                    continue

                break

            tool_usage: Dict[str, list] = browser_usage_items_to_tool_usage(result.get("usage_items"))

            output_files = result.get("output_files", [])
            final_status = MessageStatus.FINISHED if result.get("success", True) else MessageStatus.ERROR
            final_metadata = {"toolName": "spawn_browser_agent"}
            for key in (
                "task_id",
                "world_model_simulated",
                "world_model_session_id",
                "world_model_name",
                "simulated_browser_steps",
                "simulated_latest_frame",
            ):
                if result.get(key) is not None:
                    final_metadata[key] = result[key]
            if output_schema:
                final_metadata["output_schema"] = output_schema
            if result.get("structured_response") is not None:
                final_metadata["structured_response"] = result["structured_response"]
            if result.get("auth_assistance_resume_mode"):
                final_metadata["requestUserAuthentication"] = {
                    "steelSessionId": result.get("session_id"),
                    "taskId": result.get("task_id"),
                    "resumeMode": result.get("auth_assistance_resume_mode"),
                }
            # Surface the max-steps best-effort salvage to the parent. Without this
            # the activity's best_effort_response is dropped at the manager boundary
            # and a runaway that never called attempt_completion returns only the
            # generic "max steps" notice. Fold it into the message when there's no
            # clean structured completion; always expose it in metadata.
            final_message = result.get("message", "")
            best_effort_response = result.get("best_effort_response")
            if best_effort_response:
                final_metadata["best_effort_response"] = best_effort_response
                if result.get("structured_response") is None:
                    final_message = (
                        f"{final_message}\n\n{best_effort_response}" if final_message else best_effort_response
                    )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation complete",
                message=final_message,
                status=final_status,
                metadata=final_metadata,
                data={"usage": tool_usage},
            )

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

        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                raise

            last_result = locals().get("result")
            logger.error(
                "Browser manager failed",
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                error_type=type(e).__name__,
                error=extract_error_message(e),
                result_status=(last_result.get("status") if isinstance(last_result, dict) else None),
                task_id=(last_result.get("task_id") if isinstance(last_result, dict) else None),
                session_id=(last_result.get("session_id") if isinstance(last_result, dict) else None),
                current_url=(last_result.get("current_url") if isinstance(last_result, dict) else None),
                payment_request_summary=(
                    _summarize_payment_request_for_log(last_result.get("payment_request", {}))
                    if isinstance(last_result, dict)
                    else None
                ),
                traceback=traceback.format_exc(),
            )
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
                event.data["usage"],
                tool_name="spawn_browser_agent",
                call_site="browser_agent",
            )

    return last_status
