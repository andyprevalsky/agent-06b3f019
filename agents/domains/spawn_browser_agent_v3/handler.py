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
import sys
import time
import traceback
import uuid as uuid_module
import weakref
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List, Optional, Tuple

import structlog
import structlog.contextvars
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError

from browser_tools.schemas import AVAILABLE_ACTIONS, BrowserToolArgsValidationError
from browser_tools.secret_refs import (
    redact_current_secret_values,
    register_logging_secret_refs,
    secret_logging_context,
    secret_placeholder,
)
from config import load_config
from helpers.activity_generation_drain import GENERATION_SUPERSEDED, activity_drain_reason
from helpers.attachments import extract_attachments_from_context, upload_to_storage
from helpers.file_resolution import (
    resolve_file_pointers_from_extracted,
    transform_schema_for_remote_session,
)
from helpers.generation_handoff import (
    DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    GenerationHandoffRequested,
    park_pending_tool,
    take_tool_resume,
)
from helpers.messages import poll_new_messages, stream_browser_cursor
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.tracing import span, traced
from helpers.user_profile import build_user_profile_sections
from helpers.wait_condition_or_handoff import (
    live_handoff_queue,
    sleep_or_generation_handoff,
    wait_condition_or_generation_handoff,
)
from helpers.workflow_generation import WorkflowGenerationSealed
from helpers.world_model_runtime import WorldModelToolExecutionAdapter
from loop.activity_helper import call_temporal_activity_from_activity
from providers.fast_cache.browser_use_cache import cached_browser_decision
from providers.fast_cache.context import write_through_enabled_for_user
from providers.rose import ClaudeAuthContext, GptAuthContext, RoseClient
from providers.rose.browser_use import format_browser_state_for_tool
from providers.rose.errors import BrowserModelOutputValidationError
from providers.rose.types import ComputeTokenSource
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent, ToolManager
from utils.attention_requests import REJECTION_SENTINEL
from utils.error_utils import error_chain_has_type, extract_error_message
from utils.payment_card import (
    MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS,
    build_payment_question,
    normalize_payment_payload,
    reuse_payment_approval,
)
from utils.prompts import build_verifier_prompt

from .activity_heartbeat import (
    browser_activity_checkpoint,
    start_browser_activity_heartbeat,
    stop_browser_activity_heartbeat,
    wait_for_browser_work,
)
from .cdp_urls import open_browser_cdp_connection, redact_cdp_url, redact_url_secrets
from .challenge_recovery import (
    commit_cookie_removals,
    live_tab_looks_challenged,
    page_looks_challenged,
    recover_from_challenge,
    verify_live_page_cleared_challenge,
)
from .config import (
    BROWSER_DISCONNECT_TIMEOUT_SECONDS,
    BROWSER_DRAIN_YIELD_STATUS,
    BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS,
    BROWSER_SESSION_EXPIRING,
    BROWSER_SESSION_MIN_REMAINING_SECONDS,
    BROWSER_STATE_SOFT_ATTEMPTS,
    BROWSER_STATE_SOFT_TIMEOUT_SECONDS,
    BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS,
    BROWSER_SUPERVISOR_MAX_RECOVERIES,
    BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
    BROWSER_USE_PRICING_POOL,
    BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS,
    HEARTBEAT_TIMEOUT_SECONDS,
    MAX_ACTIVITY_ATTEMPTS,
    MAX_CLAUDE_TOKEN_ROTATIONS,
    MAX_CONSECUTIVE_API_FAILURES,
    MAX_ITERATIONS,
    NAVIGATE_TO_URL_TIMEOUT_SECONDS,
    SESSION_INIT_TRANSIENT_MAX_ATTEMPTS,
    SESSION_INIT_TRANSIENT_RETRY_SECONDS,
    SESSION_MAX_WAIT_SECONDS,
    SESSION_RETRY_INTERVAL_SECONDS,
    VERIFIER_ULTRA_MODEL,
    VERIFIER_ULTRA_TIMEOUT_SECONDS,
    adjust_iteration_after_action,
    browser_pool_for_agent_model,
    browser_start_to_close_timeout_minutes,
    skip_browser_network_recording,
)
from .credential_runtime import build_realm_credential_state, unknown_realm_credential_state
from .download_persist import BrowserDownloadPersister
from .recording import (
    BrowserAgentRecorder,
    BrowserNetworkRecorder,
    SimulatedBrowserRecorder,
    blocked_resource_requires_payment_cdn,
    blocked_resource_url_for_recovery,
    browser_recording_output_dir,
    normalize_simulated_browser_frame,
)
from .repo import (
    BrowserSessionCloseError,
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
    probe_cookie_variant_ephemeral,
    propagate_browser_run_credentials,
    recover_browser_challenge,
    report_claude_token_rate_limited,
    resume_browser_session,
    save_browser_action_message,
    save_browser_assistant_message,
    save_browser_credential_ref_message,
    save_minted_account_password,
    upload_file_to_session,
)
from .resume_store import hydrate_resume_context, persist_resume_context
from .service import (
    AuthRuntimeState,
    accumulate_model_usage,
    append_completion_evidence,
    browser_usage_items_to_tool_usage,
    build_action_titles,
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
    apply_user_write_lock_grant,
    execute_action,
    get_domain_from_url,
    get_element_description,
    grant_site_write_lock_approvals,
    resolve_site_write_lock_grant_url,
    wait_for_navigation_ready,
)
from .service_crypto import (
    MINTED_NEW_PASSWORD_REF,
    PAYMENT_CARD_ENTRY_RULE,
    PAYMENT_CARD_SECRET_REFS,
    ExtractedOTP,
    auth_realm_from_url,
    auth_realm_matches_url,
    build_autopay_prompt_section,
    decrypt_payment_info,
    extract_rate_limited_until,
    fetch_recent_otps,
    finalize_parked_payment_card_approval_history,
    format_otp_user_message,
    has_payment_card_secret_refs,
    is_usable_email_otp,
    mask_secret_values,
)
from .state_prefetch import BrowserStatePrefetch
from .step_timing import StepPhaseTimer
from .streaming import BrowserStreamingRoseClient, BrowserThinkingStream
from .tilion_worker import (
    apply_worker_state as apply_tilion_worker_state,
)
from .tilion_worker import (
    durable_downloads as durable_tilion_downloads,
)
from .tilion_worker import (
    is_single_cdp_client_provider,
    tilion_emulation,
)
from .tilion_worker import (
    release_session as release_tilion_session_files,
)
from .tilion_worker import (
    restore_downloads as restore_tilion_downloads,
)
from .tilion_worker import (
    stage_upload as stage_tilion_upload,
)
from .tilion_worker import (
    worker_apply_payload as tilion_worker_apply_payload,
)
from .types import ClaudeTokenState

logger = structlog.get_logger()

# Resume marker for a sign-in-help request the user declined.
AUTH_ASSISTANCE_DECLINED = "auth_assistance_declined"
BROWSER_PROGRESS_TITLE = "Browser Agent In Progress"


def _stable_browser_task_id(agent_id: str, tool_call_id: str) -> str:
    """Allocate the browser ownership ID before its cancellable activity starts."""
    return str(
        uuid_module.uuid5(
            uuid_module.NAMESPACE_URL,
            f"rose-browser-task:{agent_id}:{tool_call_id}",
        )
    )


def _browser_task_terminal_metadata(
    result: Any,
    started_task_id: Optional[str],
    *,
    code: Optional[str] = None,
) -> Dict[str, Any]:
    """Task-scoped ``task_complete`` metadata for a manager-side browser end.

    Durable evidence (``publish_evidence_links``, the payment-abandonment seal)
    requires every browser task that posted rows to close with ``task_complete``
    under its own task_id. When the activity returns parked (awaiting approval,
    payment, or auth) it posts no terminal, so every manager exit after that —
    pause, rejection, purchase outcome, deploy handoff, failure — owns it.
    ``started_task_id`` is the id the manager handed the activity; ``None``
    before any activity starts, so a pre-activity failure never names a task
    that posted no rows. ``code`` preserves the specific outcome.
    """
    source = result if isinstance(result, dict) else {}
    metadata: Dict[str, Any] = {"toolName": "spawn_browser_agent", "action_type": "task_complete"}
    task_id = source.get("task_id") or started_task_id
    if task_id:
        metadata["task_id"] = task_id
    for key in ("browser_url", "session_id", "browser_cleanup"):
        if source.get(key):
            metadata[key] = source[key]
    if code:
        metadata["code"] = code
    return metadata


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
    ):
        return None
    if target_realm in failed_realms:
        return {"auth_realm": target_realm, "credential_preparation_error": failed_realms[target_realm]}
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
        return {"auth_realm": target_realm, "credential_preparation_error": error_signature}


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
    scoped_receipt = bool(payment_payload.get("agentId"))
    if world_model_mode not in {None, "real"}:
        activity_args.extend([
            world_model_mode,
            payment_payload if scoped_receipt else None,
            payment_payload.get("agentId"),
        ])
    elif scoped_receipt:
        activity_args.extend([world_model_mode, payment_payload])
    result = await workflow.execute_activity(
        "lookup_purchase_activity",
        args=activity_args,
        start_to_close_timeout=timedelta(seconds=90 if scoped_receipt else 30),
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


BROWSER_TERMINAL_DISCONNECT_TIMEOUT_SECONDS = 10.0
_EXPIRED_OPTIONAL_CDP_TASK_NAME = "browser-terminal-io:optional-cdp-cleanup"


async def _bounded_browser_terminal_io(operation: Any, step: str) -> Any:
    """Bound a CDP teardown call even when it ignores task cancellation."""
    task = asyncio.create_task(operation, name=f"browser-terminal-io:{step}")
    try:
        done, _ = await asyncio.wait({task}, timeout=BROWSER_TERMINAL_DISCONNECT_TIMEOUT_SECONDS)
        if done:
            return await task
        task.cancel()

        def consume_result(finished: asyncio.Task) -> None:
            with contextlib.suppress(BaseException):
                finished.result()

        task.add_done_callback(consume_result)
        logger.warning("Browser terminal I/O exceeded bound", step=step)
        raise TimeoutError(f"Browser {step} exceeded terminal bound")
    except BaseException:
        if not task.done():
            task.cancel()
        raise


async def _await_bounded_browser_cleanup(
    coro: Any,
    *,
    timeout_s: float,
    timeout_message: str,
    failure_message: str,
) -> bool:
    """Run cleanup under a hard deadline that does not await cancellation.

    ``asyncio.wait_for`` cancels the inner awaitable and then waits for that
    cancellation to finish. ``DomService.disconnect`` catches CancelledError while
    draining the captcha indicator task, then continues into ``session.stop()`` —
    so a wedged CDP stop would still block past the deadline. Own the task and
    stop awaiting it when the deadline expires. Retain it for eventual result
    retrieval; the worker's bounded terminal-I/O shutdown owns its final drain.
    """
    task = asyncio.create_task(coro, name=_EXPIRED_OPTIONAL_CDP_TASK_NAME)
    done, _pending = await asyncio.wait({task}, timeout=timeout_s)
    if task in done:
        exc = None if task.cancelled() else task.exception()
        if exc is not None:
            logger.warning(failure_message, error=extract_error_message(exc))
        return not task.cancelled() and exc is None
    task.cancel()
    # Keep a strong reference + retrieve the eventual result so a late
    # non-CancelledError from session.stop() is not logged as "Task exception
    # was never retrieved" after we abandon the deadline.
    _background_browser_cleanup_tasks.add(task)

    def _discard(done_task: asyncio.Task) -> None:
        _background_browser_cleanup_tasks.discard(done_task)
        with contextlib.suppress(BaseException):
            done_task.result()

    task.add_done_callback(_discard)
    logger.warning(timeout_message, timeout_s=timeout_s)

    return False

async def disconnect_browser_after_passkey_capture(
    dom_service: Any,
    capture_passkey_usage: Any,
    *, observe_parked_page: Any = None,
) -> Any:
    """Capture credential evidence before a terminal browser disconnect.

    Both the passkey readback and BrowserSession.stop() talk to CDP. When the
    remote session is already gone (or CDP is wedged), either await can hang
    indefinitely — which strands payment/write-lock returns before the workflow
    can create the attention request (local repro: agent-payment-idempotent-
    abandonment hung for 7+ minutes after write_lock_notification dump with
    only BROWSER_CURSOR broadcasts, never reaching "Creating approval request").
    Bound both steps so approval/handoff paths always resume.
    """
    capture_complete = await _await_bounded_browser_cleanup(
        capture_passkey_usage(),
        timeout_s=BROWSER_DISCONNECT_TIMEOUT_SECONDS,
        timeout_message="Passkey usage capture timed out before disconnect",
        failure_message="Passkey usage capture failed before disconnect",
    )
    observation = None
    if capture_complete and observe_parked_page is not None:
        try:
            observation = observe_parked_page()
        except Exception as error:
            # Optional observation failure supplies no park proof; disconnect
            # remains owned here. Cancellation and other control signals escape.
            logger.warning("Parked browser observation unavailable", error_type=type(error).__name__)
    detached = await _await_bounded_browser_cleanup(
        dom_service.disconnect(),
        timeout_s=BROWSER_DISCONNECT_TIMEOUT_SECONDS,
        timeout_message="Browser disconnect timed out; continuing terminal return",
        failure_message="Browser disconnect failed; continuing terminal return",
    )
    return observation if detached else None


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


def _private_browser_runtime_url(dom_service: Any, fallback: Any = "") -> str:
    """Use the private browser URL for routing, independently of redacted views."""
    accessor = inspect.getattr_static(dom_service, "runtime_current_url", None)
    if callable(accessor):
        return str(dom_service.runtime_current_url(fallback=str(fallback or "")) or fallback or "")
    return str(fallback or "")


async def _prepare_pending_write_lock_action(
    dom_service: Any,
    pending_action: Dict[str, Any],
    *,
    target_signature: Optional[Dict[str, Any]] = None,
) -> tuple[Dict[str, Any], Dict[str, Any], str]:
    """Rehydrate browser state before replaying the exact action a user approved."""
    browser_state = await dom_service.get_browser_state(include_screenshot=False)
    current_url = _private_browser_runtime_url(dom_service, browser_state.get("url"))
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
    *,
    max_checkpoints: Optional[int] = None,
) -> bool:
    """Append distinct browser ground truth while enforcing the verifier payload cap."""
    from domains.spawn_browser_agent_v3.config import VERIFIER_CHECKPOINT_MAX

    if not checkpoint:
        return False
    appended = not verifier_checkpoints or checkpoint != verifier_checkpoints[-1]
    if appended:
        verifier_checkpoints.append(checkpoint)
    limit = VERIFIER_CHECKPOINT_MAX if max_checkpoints is None else int(max_checkpoints)
    if limit < 1:
        limit = 1
    verifier_checkpoints[:] = verifier_checkpoints[-limit:]
    return appended


def _preserve_observed_interaction_for_verifier(
    *,
    action_name: str,
    succeeded: bool,
    awaiting_observation: bool,
    observed_state: Dict[str, Any],
    current_url: str,
    verifier_checkpoints: List[Dict[str, Any]],
) -> bool:
    """Retain browser DOM proof when an agent observes a prior interaction's result.

    A screenshot file path in action history is not viewable by the verifier.
    The already-fetched DOM at a subsequent screenshot/read-state action is
    browser ground truth and avoids another CDP round trip.
    """
    if not succeeded:
        return awaiting_observation
    if action_name in {"screenshot", "read_browser_state"} and awaiting_observation:
        checkpoint = _browser_ground_truth_checkpoint(
            observed_state, current_url, kind="preserved_evidence"
        )
        if _append_bounded_verifier_checkpoint(verifier_checkpoints, checkpoint):
            return False
    if action_name in {
        "goto", "click", "click_coordinates", "evaluate", "input_text", "select_dropdown",
        "drag", "press_keys", "press_key", "upload_file", "submit_form",
    }:
        return True
    return awaiting_observation


def _replace_resume_image_blocks(value: Any) -> Any:
    """Replace image payloads with valid text blocks in simulated resume history."""
    if isinstance(value, dict):
        if value.get("type") == "image_url" or "image_url" in value:
            return {"type": "text", "text": "[image omitted from Temporal resume]"}
        return {key: _replace_resume_image_blocks(nested) for key, nested in value.items()}
    if isinstance(value, list):
        return [_replace_resume_image_blocks(item) for item in value]
    return value



def _browser_turn_messages_for_resume(
    browser_turn_messages: Optional[List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Keep the provider-visible transcript exactly as it was before the pause."""
    return list(browser_turn_messages or [])


def _complete_pending_payment_card_result(
    browser_turn_messages: List[Dict[str, Any]],
    action_history: Any,
    *,
    last4: Optional[str],
    card_refs: Dict[str, str],
) -> bool:
    """Resolve the real pending result in both saved browser histories."""
    if not has_payment_card_secret_refs(card_refs):
        return False
    entries = action_history.get_entries()
    pending_entry = next(
        (
            entry for entry in reversed(entries)
            if entry.get("action") == "request_payment_card"
            and (entry.get("result") or {}).get("status") in {
                "needs_payment_card_approval", "awaiting_payment_card_approval"
            }
        ),
        None,
    )
    for message in reversed(browser_turn_messages):
        if message.get("role") != "tool" or message.get("name") != "request_payment_card":
            continue
        try:
            result = json.loads(message.get("content") or "")
        except (TypeError, ValueError):
            continue
        if not isinstance(result, dict):
            continue
        if result.get("status") in {"payment_card_ready", "approved"}:
            # The outer approval+mint loop may already have finalized this
            # persisted tool result before the browser activity resumes.
            # Accept that completed outcome instead of treating it as a lost
            # pending result and restarting the payment flow.
            result_last4 = result.get("last4") or result.get("card_last4")
            if last4 and result_last4 != last4:
                continue
            if pending_entry is not None:
                pending_entry["result"] = dict(result)
                action_history.restore_entries(entries)
            elif not any(
                entry.get("action") == "request_payment_card"
                and (entry.get("result") or {}).get("status") in {"payment_card_ready", "approved"}
                and (
                    not last4
                    or ((entry.get("result") or {}).get("last4") or (entry.get("result") or {}).get("card_last4"))
                    == last4
                )
                for entry in entries
            ):
                entries.append({
                    "step": max((entry.get("step", 0) for entry in entries), default=0) + 1,
                    "action": "request_payment_card",
                    "result": dict(result),
                })
                action_history.restore_entries(entries)
            return True
        if result.get("status") not in {
            "needs_payment_card_approval",
            "awaiting_payment_card_approval",
        }:
            continue
        result["status"] = "approved"
        result["card_last4"] = last4
        result["card_secret_refs"] = [secret_placeholder(ref) for ref in PAYMENT_CARD_SECRET_REFS]
        message["content"] = json_dumps_compact(result)
        if pending_entry is None:
            # Older paused activities saved the real tool result in the browser
            # transcript but returned before recording its action-history entry.
            entries.append({
                "step": max((entry.get("step", 0) for entry in entries), default=0) + 1,
                "action": "request_payment_card",
                "result": dict(result),
            })
        else:
            pending_entry["result"] = dict(result)
        action_history.restore_entries(entries)
        return True
    return False


async def _load_browser_resume_user_instructions(
    agent_id: str,
    resume_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Read the task's durable input range, deduplicating by source row identity."""
    cursor = resume_state.get("user_message_cursor")
    tool_call_id = resume_state.get("tool_call_id")
    floor_confirmed = bool(cursor) and resume_state.get("user_message_cursor_is_task_start") is True
    epoch = datetime.fromtimestamp(0, timezone.utc)
    cursor_time = datetime.fromisoformat(cursor.replace("Z", "+00:00")) if floor_confirmed else None
    since = cursor_time if floor_confirmed and cursor_time is not None else epoch
    rows = await poll_new_messages(
        agent_id, since - timedelta(microseconds=1),
        **({"browser_tool_call_id": tool_call_id, "browser_task_id": resume_state.get("task_id")} if tool_call_id else {}),
    )
    if not floor_confirmed:
        starts = [
            datetime.fromisoformat(str(row["timestamp"]).replace("Z", "+00:00"))
            for row in rows
            if row.get("timestamp") and tool_call_id
            and (row.get("metadata") or {}).get("toolCallId") == tool_call_id
            and (row.get("metadata") or {}).get("toolName") == "spawn_browser_agent"
            and (row.get("metadata") or {}).get("action_type") == "session_starting"
        ]
        if not starts:
            raise ValueError("Browser task input boundary is unavailable")
        cursor_time = min(starts)
    messages = list(resume_state.get("user_instruction_messages") or [])
    seen_ids = set(resume_state.get("user_instruction_message_ids") or [])
    for row in sorted(rows, key=lambda row: (str(row.get("timestamp") or ""), str(row.get("id") or row.get("message_id") or ""))):
        if str(row.get("role") or "").upper() != "USER" or (row.get("metadata") or {}).get("hidden"):
            continue
        raw_timestamp = row.get("timestamp")
        if not raw_timestamp:
            continue
        timestamp = raw_timestamp if isinstance(raw_timestamp, datetime) else datetime.fromisoformat(str(raw_timestamp).replace("Z", "+00:00"))
        if timestamp < cursor_time:
            continue
        message_id = row.get("id") or row.get("message_id")
        text = row.get("text")
        if not message_id or message_id in seen_ids or not isinstance(text, str) or not text.strip():
            continue
        messages.append({"role": "user", "content": text})
        seen_ids.add(message_id)
    return {
        **resume_state,
        "user_instruction_messages": messages,
        "user_instruction_message_ids": sorted(seen_ids),
        "user_message_cursor": cursor_time.isoformat(),
        "user_message_cursor_is_task_start": True,
    }


def _model_visible_browser_message(
    message: Any, redact: Any, *, action_result_redact: Any = None, secret_values_used: bool = False,
) -> Any:
    """Project a native transcript envelope without exempting its page payloads."""
    if not isinstance(message, dict):
        return redact(message)

    def visible_json(text: Any, action_name: str = "", *, tool_arguments: bool = False) -> Any:
        if not isinstance(text, str):
            return redact(text)
        try:
            original = json.loads(text)
        except (ValueError, TypeError):
            return redact(text)
        payload = redact(original)
        if tool_arguments:
            target_fields = {
                "click": ("index",), "input_text": ("index",), "scroll": ("index",),
                "dropdown_options": ("index",), "select_dropdown": ("index",),
                "upload_file": ("index",), "click_coordinates": ("x", "y"),
                "drag": ("source_index", "target_index", "start_x", "start_y", "end_x", "end_y"),
            }
            if isinstance(original, dict) and isinstance(payload, dict):
                for key in target_fields.get(action_name, ()):
                    value = original.get(key)
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                        payload[key] = value
        elif action_name and callable(action_result_redact):
            payload = action_result_redact(action_name, original)
        return json_dumps_compact(payload)

    safe = redact(message)
    role = message.get("role")
    if isinstance(role, str) and role in {"user", "assistant", "tool", "system", "developer", "USER", "TOOL"}:
        safe["role"] = role
    # These values are produced by the native transcript writer, never by a
    # nested evaluate result or another page-controlled dictionary.
    for key in ("tool_call_id", "name"):
        if isinstance(message.get(key), str):
            safe[key] = message[key]
    content = message.get("content")
    if isinstance(content, list):
        blocks = []
        for block in content:
            visible_block = redact(block)
            if (isinstance(block, dict) and isinstance(block.get("type"), str)
                    and block["type"] in {"image_url", "image", "input_image"}
                    and (secret_values_used or visible_block != block)):
                omitted = ("[image withheld after private credential entry]" if secret_values_used
                           else "[image omitted from Temporal resume]")
                visible_block = {"type": "text", "text": redact(omitted)}
            elif isinstance(block, dict) and block.get("type") == "text" and isinstance(visible_block, dict):
                visible_block["type"] = "text"
            blocks.append(visible_block)
        safe["content"] = blocks
    elif content is not None:
        safe["content"] = visible_json(content, str(message.get("name") or "")) if role == "tool" else redact(content)
    calls = message.get("tool_calls")
    if isinstance(calls, list):
        visible_calls = []
        for call in calls:
            if not isinstance(call, dict):
                visible_calls.append(redact(call))
                continue
            visible_call = redact(call)
            if isinstance(call.get("id"), str):
                visible_call["id"] = call["id"]
            if call.get("type") == "function":
                visible_call["type"] = "function"
            function = call.get("function")
            if isinstance(function, dict):
                visible_function = redact(function)
                if isinstance(function.get("name"), str):
                    visible_function["name"] = function["name"]
                if "arguments" in function:
                    visible_function["arguments"] = visible_json(
                        function["arguments"], str(function.get("name") or ""), tool_arguments=True,
                    )
                visible_call["function"] = visible_function
            visible_calls.append(visible_call)
        safe["tool_calls"] = visible_calls
    return safe


def _model_visible_browser_turn_messages(
    messages: Any, redact: Any, *, secret_values_used: bool, action_result_redact: Any = None,
) -> Any:
    """Preserve only screenshot-tool transport linked to its harness tool call."""
    # Message keys are protocol; nested content still belongs to the page.
    visible = ([_model_visible_browser_message(message, redact, action_result_redact=action_result_redact,
                                              secret_values_used=secret_values_used)
                for message in messages] if isinstance(messages, list) else redact(messages))
    if secret_values_used or not isinstance(messages, list) or not isinstance(visible, list):
        return visible
    for index in range(2, len(messages)):
        assistant, tool, image = messages[index - 2:index + 1]
        if not all(isinstance(item, dict) for item in (assistant, tool, image)):
            continue
        if assistant.get("role") != "assistant" or tool.get("role") != "tool" or tool.get("name") != "screenshot":
            continue
        if not any(isinstance(call, dict) and call.get("id") == tool.get("tool_call_id")
                   and isinstance(call.get("function"), dict) and call["function"].get("name") == "screenshot"
                   for call in assistant.get("tool_calls") or []):
            continue
        try:
            result = json.loads(tool.get("content") or "")
        except (TypeError, ValueError):
            continue
        content = image.get("content")
        screenshot_label = "Screenshot captured by the screenshot tool."
        if (not isinstance(result, dict) or result.get("screenshot_attached") is not True
                or image.get("role") != "user" or not isinstance(content, list) or len(content) != 2
                or content[0] not in ({"type": "text", "text": screenshot_label},
                                      {"type": "text", "text": redact(screenshot_label)})
                or not isinstance(content[1], dict) or content[1].get("type") != "image_url"):
            continue
        payload = content[1].get("image_url")
        url = payload.get("url") if isinstance(payload, dict) else None
        if not isinstance(url, str) or not url.startswith("data:image/png;base64,"):
            continue
        try:
            png = base64.b64decode(url.split(",", 1)[1], validate=True)
        except ValueError:
            continue
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            continue
        visible_content = visible[index].get("content")
        if isinstance(visible_content, list) and len(visible_content) == 2:
            visible[index]["role"] = "user"
            visible_content[0] = {"type": "text", "text": redact(content[0]["text"])}
            visible_content[1] = {"type": "image_url", "image_url": {"url": url}}
    return visible


def _model_visible_browser_verifier_context(context: Any, dom_service: Any, browser_state: Dict[str, Any]) -> Any:
    """Keep only the builder's final trusted raster intact before private entry."""
    visible = ([_model_visible_browser_message(message, dom_service.model_visible_value,
                                               secret_values_used=getattr(dom_service, "secret_values_used", False))
                for message in context]
               if isinstance(context, list) else dom_service.model_visible_value(context))
    if isinstance(context, list) and isinstance(visible, list):
        for observation_index, (original, safe_message) in enumerate(zip(context, visible)):
            metadata = original.get("metadata") if isinstance(original, dict) else None
            if not isinstance(metadata, dict) or not isinstance(safe_message, dict):
                continue
            step = metadata.get("browser_action_step")
            evidence = metadata.get("structured_response")
            if (original.get("role") == "TOOL" and metadata.get("toolName") == "read_browser_state"
                    and type(step) is int and isinstance(evidence, dict) and evidence.get("step") == step):
                visible[observation_index] = {
                    "role": "TOOL", "text": "",
                    "metadata": {"toolName": "read_browser_state", "toolStatus": "FINISHED", "browser_action_step": step,
                                 "structured_response": {"step": step, "formatted_state": dom_service.model_visible_value(evidence.get("formatted_state"))}},
                }
    screenshot = browser_state.get("screenshot")
    if (getattr(dom_service, "secret_values_used", False) or browser_state.get("screenshot_placeholder")
            or not isinstance(screenshot, str) or not screenshot
            or not isinstance(context, list) or not context or not isinstance(visible, list)):
        return visible
    # Final evidence precedes optional historical observations in admission.
    final_index = next((index for index in range(len(context) - 1, -1, -1)
                        if isinstance(context[index], dict)
                        and (context[index].get("metadata") or {}).get("toolName") == "final_screenshot"), -1)
    if final_index < 0:
        return visible
    original = context[final_index]
    if not isinstance(original, dict) or original.get("role") != "TOOL":
        return visible
    metadata = original.get("metadata")
    if (isinstance(metadata, dict) and metadata.get("toolName") == "final_screenshot"
            and metadata.get("screenshot_b64") == screenshot and isinstance(visible[final_index], dict)):
        visible[final_index]["role"] = "TOOL"
        visible[final_index]["metadata"] = {
            **dom_service.model_visible_value(metadata),
            "toolName": "final_screenshot", "toolStatus": "FINISHED", "screenshot_b64": screenshot,
        }
    return visible


def _model_visible_browser_output_schema(schema: Any, redact: Any) -> Any:
    """Redact schema data while retaining declared contract mechanics."""
    field_types = {
        "str", "string", "int", "integer", "float", "number", "bool", "boolean",
        "list[str]", "list[int]", "object", "list[object]", "file_pointer",
        "list[file_pointer]", "session_file_pointer", "list[session_file_pointer]",
    }
    field_keys = {
        "name", "type", "description", "required", "nullable", "properties",
        "minLength", "maxLength", "minItems", "maxItems", "default", "enum",
    }

    def visible_field(field: Any) -> Any:
        if not isinstance(field, dict):
            return redact(field)
        visible = {
            key if key in field_keys else redact(key): redact(value)
            for key, value in field.items()
        }
        if isinstance(field.get("type"), str) and field["type"] in field_types:
            visible["type"] = field["type"]
        for key in ("minLength", "maxLength", "minItems", "maxItems"):
            if isinstance(field.get(key), int) and not isinstance(field[key], bool):
                visible[key] = field[key]
        properties = field.get("properties")
        if isinstance(properties, list):
            visible["properties"] = [visible_field(item) for item in properties]
        elif isinstance(properties, dict):
            visible["properties"] = {
                redact(name): visible_field(spec) if isinstance(spec, dict)
                else spec if isinstance(spec, str) and spec in field_types else redact(spec)
                for name, spec in properties.items()
            }
        return visible

    visible = redact(schema)
    if isinstance(schema, dict) and isinstance(schema.get("fields"), list):
        visible["fields"] = [visible_field(field) for field in schema["fields"]]
    return visible


async def _refresh_browser_output_schema(
    *,
    goal: str,
    agent_id: str,
    response_schema: Dict[str, Any],
    resume_state: Optional[Dict[str, Any]],
    compute_auth: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Refresh the delegated contract only when durable real input changed."""
    state = resume_state or {}
    if state.get("approval_type") == AUTH_ASSISTANCE_DECLINED:
        return response_schema, {}
    messages = state.get("user_instruction_messages") or []
    if len(messages) <= int(state.get("schema_user_instruction_count") or 0):
        return response_schema, {}
    from helpers.llm import _build_verifier_response_model, _generate_response_schema_with_rose

    usage: Dict[str, Any] = {}
    try:
        def visible(value: Any) -> Any:
            return mask_secret_values(redact_current_secret_values(value), state.get("secret_redaction_refs"))

        schema, _title, usage = await _generate_response_schema_with_rose(
            "\n\n".join([
                visible(goal),
                "Current output schema (preserve fields unless later user feedback changes them):\n"
                + json_dumps_compact(_model_visible_browser_output_schema(response_schema, visible)),
                *[visible(message["content"]) for message in messages],
            ]),
            agent_id=agent_id,
            compute_auth=compute_auth,
        )
        if not isinstance(schema, dict) or not schema.get("fields"):
            raise ValueError("Browser schema refresh returned no fields")
        if _build_verifier_response_model(schema).model_json_schema() == _build_verifier_response_model(response_schema).model_json_schema():
            schema = response_schema
    except WorkflowGenerationSealed:
        raise
    except Exception as error:
        if any(error_chain_has_type(error, kind) for kind in (
            "CancelledError", "WorkflowGenerationSealed", "GenerationHandoffRequested",
        )):
            raise
        # Instruction delivery is independent of this optional model request.
        # Keep the accepted contract and leave this input revision retryable.
        logger.warning(
            "Browser schema refresh failed; retaining accepted schema",
            agent_id=agent_id,
            error=extract_error_message(error),
        )
        state["_schema_refresh_error"] = {"type": type(error).__name__, "message": extract_error_message(error)}
        return response_schema, usage
    state.pop("_schema_refresh_error", None)
    state["schema_user_instruction_count"] = len(messages)
    return schema, usage


async def _sync_browser_user_instructions(
    *,
    agent_id: str,
    goal: str,
    response_schema: Dict[str, Any],
    instruction_state: Dict[str, Any],
    turn_messages: List[Dict[str, Any]],
    compute_auth: Optional[Dict[str, Any]],
    require_current_schema: bool = False,
    require_confirmed_read: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any], List[Dict[str, Any]]]:
    """Use the resume transport for live input and accept only its latest contract."""
    state = instruction_state
    usages = []
    schema_attempts_left: Dict[int, int] = {}
    retry_poll = (require_current_schema or require_confirmed_read) and state.get("_user_instruction_poll_confirmed") is not False
    while True:
        try:
            state = await _load_browser_resume_user_instructions(agent_id, state)
        except WorkflowGenerationSealed:
            raise
        except Exception as error:
            if any(error_chain_has_type(error, kind) for kind in (
                "CancelledError", "WorkflowGenerationSealed", "GenerationHandoffRequested",
            )):
                raise
            if retry_poll:
                retry_poll = False
                continue
            state["_user_instruction_poll_confirmed"] = False
            state["_user_instruction_poll_error"] = {"type": type(error).__name__, "message": extract_error_message(error)}
            logger.warning("Browser instruction read failed", agent_id=agent_id, error=extract_error_message(error))
            break
        state["_user_instruction_poll_confirmed"] = True
        state.pop("_user_instruction_poll_error", None)
        count = len(state.get("user_instruction_messages") or [])
        _append_browser_user_instructions(state, turn_messages)
        state["delivered_user_instruction_count"] = count
        if count <= int(state.get("schema_user_instruction_count") or 0):
            break
        previously_attempted = count <= int(state.get("schema_attempted_user_instruction_count") or 0)
        if not require_current_schema and previously_attempted:
            break
        if require_current_schema:
            remaining = schema_attempts_left.setdefault(count, 1 if previously_attempted else 2)
            if remaining == 0:
                break
            schema_attempts_left[count] = remaining - 1
        # This activity attempts a failed revision once. The accepted count alone
        # survives suspension, so a fresh activity can retry without losing input.
        state["schema_attempted_user_instruction_count"] = count
        response_schema, usage = await _refresh_browser_output_schema(
            goal=goal, agent_id=agent_id, response_schema=response_schema,
            resume_state=state, compute_auth=compute_auth,
        )
        if usage:
            usages.append(usage)
        if require_current_schema and schema_attempts_left[count] == 0 and count > int(state.get("schema_user_instruction_count") or 0):
            break
        # A correction can arrive while schema generation awaits its provider.
        # The same cursor and source-ID ledger admit it before publishing state.
    state["browser_output_schema"] = response_schema
    return state, response_schema, usages


class BrowserInstructionUnavailableError(RuntimeError):
    """A real input/schema dependency remained unavailable at an action boundary."""

    def __init__(self, failure: Dict[str, str]):
        super().__init__(failure["message"])
        self.original_error_type = failure["type"]


def _require_browser_instruction_state(state: Dict[str, Any], *, current_schema: bool) -> None:
    if state.get("_user_instruction_poll_confirmed") is not True:
        failure = state.get("_user_instruction_poll_error") or {"type": "RuntimeError", "message": "Browser instruction read is unconfirmed"}
        raise BrowserInstructionUnavailableError(failure)
    if current_schema and int(state.get("schema_user_instruction_count") or 0) < len(state.get("user_instruction_messages") or []):
        failure = state.get("_schema_refresh_error") or {"type": "RuntimeError", "message": "Browser output schema revision is unaccepted"}
        raise BrowserInstructionUnavailableError(failure)


def _append_browser_user_instructions(
    resume_state: Optional[Dict[str, Any]],
    browser_turn_messages: List[Dict[str, Any]],
) -> List[Dict[str, str]]:
    """Deliver genuine user feedback once across repeated activity resumes."""
    state = resume_state or {}
    messages = [
        {"role": "user", "content": message["content"]}
        for message in state.get("user_instruction_messages", [])
        if isinstance(message, dict) and isinstance(message.get("content"), str)
    ]
    delivered = int(state.get("delivered_user_instruction_count") or 0)
    browser_turn_messages.extend(dict(message) for message in messages[delivered:])
    return messages


def _browser_resume_continuity_state(
    *,
    action_history: Any,
    visited_urls: List[str],
    verifier_checkpoints: List[Dict[str, Any]],
    browser_turn_messages: Optional[List[Dict[str, Any]]] = None,
    reasoning_messages: Optional[List[str]] = None,
    action_summary: Optional[List[str]] = None,
    auth_runtime_state: Optional[AuthRuntimeState] = None,
    user_instruction_messages: Optional[List[Dict[str, str]]] = None,
    user_message_cursor: Optional[str] = None,
    user_message_cursor_is_task_start: bool = False,
    user_instruction_message_ids: Optional[List[str]] = None,
    response_schema: Optional[Dict[str, Any]] = None,
    schema_user_instruction_count: int = 0,
    private_runtime_state: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Serialize exact task continuity for inline or encrypted storage."""
    state = {
        "action_history": action_history.get_entries(),
        "visited_urls": list(visited_urls),
        "verifier_checkpoints": list(verifier_checkpoints),
        "browser_turn_messages": _browser_turn_messages_for_resume(browser_turn_messages),
        "reasoning_messages": list(reasoning_messages or []),
        "action_summary": list(action_summary or []),
        "auth_attempts": auth_runtime_state.snapshot() if auth_runtime_state is not None else None,
        "user_instruction_messages": list(user_instruction_messages or []),
        "delivered_user_instruction_count": len(user_instruction_messages or []),
        "user_message_cursor": user_message_cursor,
        "user_message_cursor_is_task_start": user_message_cursor_is_task_start,
        "user_instruction_message_ids": list(user_instruction_message_ids or []),
        "schema_user_instruction_count": schema_user_instruction_count,
        "browser_output_schema": response_schema,
    }
    if hasattr(action_history, "secret_redaction_state"):
        privacy_state = action_history.secret_redaction_state()
        # The state below is private input to persist_resume_context, which
        # must archive it encrypted whenever bindings are present.
        if privacy_state:
            state = action_history.model_visible_value(state)
            state["browser_turn_messages"] = _model_visible_browser_turn_messages(
                _browser_turn_messages_for_resume(browser_turn_messages), action_history.model_visible_value,
                secret_values_used=bool(privacy_state.get("secret_values_used")),
            )
            state["action_history"] = action_history.get_entries()
            state["auth_attempts"] = auth_runtime_state.snapshot() if auth_runtime_state is not None else None
            state["browser_output_schema"] = _model_visible_browser_output_schema(
                response_schema, action_history.model_visible_value
            )
            # Cursor, deduplication IDs, and counts are trusted protocol state.
            state.update({
                "delivered_user_instruction_count": len(user_instruction_messages or []),
                "user_message_cursor": user_message_cursor,
                "user_message_cursor_is_task_start": user_message_cursor_is_task_start,
                "user_instruction_message_ids": list(user_instruction_message_ids or []),
                "schema_user_instruction_count": schema_user_instruction_count,
            })
            state.update(privacy_state)
            if privacy_state.get("secret_redaction_refs") and private_runtime_state:
                # Only the encrypted archive may carry exact routing/grant data.
                state["private_browser_runtime"] = private_runtime_state
    return state


def _restore_browser_auth_attempts(state: AuthRuntimeState, snapshot: Any) -> None:
    """Restore attempted paths only; current realm credentials remain authoritative."""
    if not isinstance(snapshot, dict):
        return
    password = snapshot.get("password")
    password = password if isinstance(password, dict) else {}
    attempted_ids = password.get("attempted_ids") or []
    if isinstance(attempted_ids, list):
        state.passwords_attempted.update(
            credential_id
            for credential_id in attempted_ids
            if isinstance(credential_id, str) and credential_id in state.password_ids
        )
    email_otp = snapshot.get("email_otp")
    minted = snapshot.get("minted")
    guest = snapshot.get("guest")
    email_otp = email_otp if isinstance(email_otp, dict) else {}
    minted = minted if isinstance(minted, dict) else {}
    guest = guest if isinstance(guest, dict) else {}
    state.email_otp_attempted = bool(email_otp.get("attempted"))
    state.minted_attempted = bool(minted.get("attempted"))
    state.guest_option_seen = bool(guest.get("option_seen"))
    state.guest_attempted = bool(guest.get("attempted"))


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


def _redact_browser_activity_error(error: Exception, redact: Callable[[Any], Any]) -> Exception:
    """Keep private failure payloads out of Temporal history and parent tools."""
    from temporalio.exceptions import ApplicationError

    changed = False
    current: Optional[BaseException] = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        try:
            message = str(current)
        except Exception:
            message = extract_error_message(current)
        details = {"details": list(current.details) if isinstance(current, ApplicationError) else []}
        if redact(message) != message or redact(details) != details:
            changed = True
        current = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
    if not changed:
        return error
    message = redact(extract_error_message(error))
    if isinstance(error, WorkflowGenerationSealed):
        return WorkflowGenerationSealed(message)
    if isinstance(error, ApplicationError):
        details = redact({"details": list(error.details)})["details"]
        return ApplicationError(
            message,
            *details,
            type=redact(error.type) if error.type else None,
            non_retryable=error.non_retryable,
            next_retry_delay=error.next_retry_delay,
            category=error.category,
        )
    # Temporal already represents ordinary Python failures as ApplicationError
    # with their Python type. Keep that type and the original retry behavior.
    return ApplicationError(message, type=type(error).__name__)


async def _propagate_browser_credentials_with_progress(
    *,
    config: Any,
    agent_id: str,
    task_id: Optional[str],
    browser_url: str,
    status: str,
    success: bool,
    message: str,
    redact: Optional[Callable[[Any], Any]] = None,
) -> Optional[Dict[str, Any]]:
    if not task_id:
        return None
    redact = redact or (lambda value: value)
    message = redact(message)

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
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        # Propagation is bookkeeping about the credentials the finished run used.
        # The run's own outcome stands: a backend 500 here (a Prisma transaction
        # expiring under load, 2026-10-06) must not turn a completed browser task
        # into a failure that the planner then retries from scratch.
        error_message = redact(extract_error_message(e))
        logger.warning(
            "Credential propagation failed; keeping the browser run's outcome",
            agent_id=agent_id,
            task_id=task_id,
            status=status,
            error=error_message,
        )
        # The diagnostic write is best-effort: the backend that just failed the
        # propagation may refuse this message too, and that must not turn the
        # fallback into a raise either.
        try:
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
        except WorkflowGenerationSealed:
            raise
        except Exception as save_error:
            logger.warning(
                "Credential propagation diagnostic message was not saved",
                agent_id=agent_id,
                task_id=task_id,
                error=redact(extract_error_message(save_error)),
            )
        return {"outcome": "unknown", "refs": 0, "applied": 0, "error": error_message}

    original_result = result
    result = redact(result)
    for key in ("refs", "applied"):
        if isinstance(original_result.get(key), int) and not isinstance(original_result[key], bool):
            result[key] = original_result[key]
    outcome = result.get("outcome", "unknown")
    refs = result.get("refs", 0)
    applied = result.get("applied", 0)
    await save_browser_action_message(
        agent_id=agent_id,
        title="Credential state updated",
        task_id=task_id,
        message=redact(f"Outcome: {outcome}. Credential refs: {refs}. Updates applied: {applied}."),
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

    Provider profiles persist within one provider. Capturing Playwright storage
    lets Kernel-to-Steel and Steel-to-Browser-Use recoveries retain the same
    cookies, localStorage, and IndexedDB across providers.
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


def _cdp_multiplexer_kwargs(cdp_multiplexer: Optional[Any]) -> Dict[str, Any]:
    """DOMService kwargs: only single-CDP-client sessions hand over a multiplexer."""
    return {"cdp_multiplexer": cdp_multiplexer} if cdp_multiplexer is not None else {}


def _fresh_connect_url_minter(config: Any, task_id: Optional[str]) -> Optional[Callable[[], Awaitable[Optional[str]]]]:
    """Mint a fresh provider CDP URL for an in-activity redial (Tilion tokens last 1800 s).

    GET /api/browser-session/task/{task_id} returns a freshly minted ws_url for
    ACTIVE Tilion rows; the cached URL is never reused after expiry.
    """
    if config is None or not task_id:
        return None

    async def mint() -> Optional[str]:
        info = await fetch_session_info(config, task_id)
        ws_url = info.get("ws_url") if isinstance(info, dict) else None
        return ws_url if isinstance(ws_url, str) and ws_url else None

    return mint


async def _reconnect_browser_stack_after_rotation(
    *,
    new_cdp_url: str,
    old_dom_service: Any,
    old_playwright_browser: Optional[Any],
    old_playwright_instance: Optional[Any],
    old_driver_pid: Optional[int],
    fingerprint_injection: Optional[Any],
    agent_id: str,
    provider: Optional[str] = None,
    config: Any = None,
    task_id: Optional[str] = None,
    exit_geo_locale: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Tear down the current CDP/Playwright stack and reattach to `new_cdp_url`.

    Backs the rotate_ip tool: the backend recreates the browser session on a fresh
    proxy and returns a new ws_url; the agent must drop its live connection and
    reconnect to it. Captured storage restores login across providers. Fingerprint
    injection is re-applied so the rotated IP does not pair with a fresh device
    fingerprint. Returns the new dom_service/pages/playwright handles + driver pid.
    """
    from browser_tools.dom_service import DOMService, browser_downloads_path_for_provider

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
    connection_cdp_url, cdp_multiplexer = await open_browser_cdp_connection(
        new_cdp_url,
        label=f"rotation:{agent_id}",
        refresh_url=_fresh_connect_url_minter(config, task_id),
        # Tilion stays on New York/en-US whatever the exit geo; the multiplexer
        # applies the session's timezone/locale to every target it attaches.
        emulation=tilion_emulation(fingerprint_injection, exit_geo_locale),
    )
    dom_service = DOMService(
        cdp_url=connection_cdp_url,
        downloads_path=browser_downloads_path_for_provider(provider),
        **_cdp_multiplexer_kwargs(cdp_multiplexer),
    )
    if hasattr(old_dom_service, "secret_redaction_state"):
        dom_service.restore_secret_redaction_state(old_dom_service.secret_redaction_state())
    pw_instance = None
    pw_browser = None
    driver_pid = None
    try:
        await dom_service.connect()
        if config is not None and task_id:
            from browser_tools.captcha_solve_indicator import (
                start_captcha_telemetry_indicator_for_task,
            )

            start_captcha_telemetry_indicator_for_task(
                dom_service,
                fetch_telemetry=fetch_browser_captcha_telemetry,
                config=config,
                task_id=task_id,
            )
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


class TabFocusCache:
    """Per-activity memo for tab focus sync.

    A Playwright page keeps its CDP target id for its whole life, so resolving
    it once per page replaces a per-step CDP session + Target.getTargetInfo
    round trip for every open tab. ``foreground`` remembers the last
    (target, tab count) brought to front: an unchanged pair means nothing could
    have taken the foreground from the agent, while a new/closed tab forces
    a fresh bring_to_front.
    """

    def __init__(self) -> None:
        self.target_ids: "weakref.WeakKeyDictionary[Any, str]" = weakref.WeakKeyDictionary()
        self.foreground: Optional[Tuple[str, int]] = None


async def _page_target_id(context: Any, page: Any, cache: Optional[TabFocusCache]) -> Optional[str]:
    if cache is not None:
        with contextlib.suppress(TypeError):
            cached = cache.target_ids.get(page)
            if cached:
                return cached
    cdp_session = None
    try:
        cdp_session = await context.new_cdp_session(page)
        target_info = await cdp_session.send("Target.getTargetInfo")
        target_id = target_info.get("targetInfo", {}).get("targetId")
    finally:
        if cdp_session is not None:
            with contextlib.suppress(Exception):
                await cdp_session.detach()
    if target_id and cache is not None:
        with contextlib.suppress(TypeError):
            cache.target_ids[page] = target_id
    return target_id


async def _synchronize_playwright_page_with_agent_focus(
    *,
    dom_service: Any,
    playwright_browser: Any,
    current_page: Any,
    focus_cache: Optional[TabFocusCache] = None,
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
    foreground_key = (focused_target_id, len(pages))
    for page in pages:
        try:
            target_id = await _page_target_id(contexts[0], page, focus_cache)
            if target_id != focused_target_id:
                continue
            if focus_cache is None or focus_cache.foreground != foreground_key or page is not current_page:
                await page.bring_to_front()
                if focus_cache is not None:
                    focus_cache.foreground = foreground_key
            return page
        except Exception as exc:
            logger.debug(
                "Unable to compare Playwright page with browser-use focus",
                error=str(exc),
            )

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
    focus_cache: Optional[TabFocusCache] = None,
) -> Tuple[Any, Any]:
    """Atomically move live view, recorder, and synthesized input to agent focus."""
    focused_page = await _synchronize_playwright_page_with_agent_focus(
        dom_service=dom_service,
        playwright_browser=playwright_browser,
        current_page=current_page,
        focus_cache=focus_cache,
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
    serial_cdp_keyboard: bool = False,
) -> Any:
    """Rebind synthesized input after a provider handoff without leaking idle work."""
    if current_humanizer is not None:
        with contextlib.suppress(Exception):
            await current_humanizer.close()
    if not enabled:
        return None
    rebound_humanizer = humanizer_factory(
        dom_page=dom_page,
        input_page=input_page,
        fast=False,
        # Tilion drops pipelined Input.dispatchKeyEvent commands.
        **({"serial_cdp_keyboard": True} if serial_cdp_keyboard else {}),
    )
    await rebound_humanizer.initialize_cursor(start_pos=(640, 400))
    rebound_humanizer.set_cursor_observer(cursor_observer)
    rebound_humanizer.start_idle_movement()
    return rebound_humanizer


def _harvest_otp_poll(
    task: Optional["asyncio.Task[int]"], *, propagate_sealed: bool = True
) -> Optional["asyncio.Task[int]"]:
    """Collect a finished background OTP poll without ever waiting on it.

    Returns the task while it is still in flight, ``None`` once it has been
    harvested (or never started) so the caller can start the next poll. A
    transiently failed poll never fails the step. A sealed generation must stop.
    """
    if task is None or not task.done():
        return task
    if task.cancelled():
        return None
    error = task.exception()
    if isinstance(error, WorkflowGenerationSealed):
        if propagate_sealed:
            raise error
    elif error is not None:
        logger.warning("Failed to fetch OTPs", error=str(error)[:200])
    elif task.result():
        logger.info("Appended OTP user messages", count=task.result())
    return None


async def _drain_otp_poll(task: Optional["asyncio.Task[int]"], *, grace_s: float = 2.0) -> None:
    """Let an in-flight OTP poll finish its credential-ref writes, then stop it."""
    if task is None:
        return
    if not task.done():
        await asyncio.wait({task}, timeout=grace_s)
        task.cancel()
    # The owner observes sealing synchronously; callbacks only consume exceptions.
    task.add_done_callback(lambda done: _harvest_otp_poll(done, propagate_sealed=False))
    _harvest_otp_poll(task)


def _restored_indexes_unresolved(dom_service: Any, *, transcript_restored: bool) -> bool:
    """Whether a resumed transcript cites [index] values this connection cannot resolve.

    An activity that resumes a browser task (write approval, payment card,
    deploy drain) restores the model's transcript, including the [index]
    values of the last read_browser_state, but connects a new DOMService whose
    selector map is empty until its first DOM build.
    """
    return transcript_restored and not getattr(dom_service, "selector_map", None)


def _step_observe_needs_dom(
    *,
    fast_mode_replay: bool,
    browser_recorder: Any,
    restored_indexes_unresolved: bool = False,
) -> bool:
    """Whether the per-step observe must build the full DOM.

    The browser LLM never receives page state implicitly (it calls
    read_browser_state, which builds its own DOM), so the step-start observe
    only needs URL/title. Two consumers still need the full tree every step:
    Fast Mode replay remaps cached targets against the live selector map, and
    file-based recorders persist per-iteration DOM observations for the world
    model corpus (Kernel replay recorders ignore observations). A resumed
    activity needs it once, so the indexes its restored transcript already
    cites resolve against this connection's selector map.
    """
    if fast_mode_replay or restored_indexes_unresolved:
        return True
    return browser_recorder is not None and not getattr(browser_recorder, "uses_kernel_replay", False)


async def _take_speculative_browser_state(
    state_prefetch: BrowserStatePrefetch,
    dom_service: Any,
) -> Optional[Dict[str, Any]]:
    """Speculative DOM build for read_browser_state, if still on the same page."""
    if not state_prefetch.in_flight or dom_service is None:
        state_prefetch.discard()
        return None
    try:
        live_url = (await dom_service.get_page_identity()).get("url")
    except Exception:
        state_prefetch.discard()
        return None
    try:
        # The build already overlapped the LLM call; one still running after
        # the soft budget is stalled, and the fresh build that replaces it keeps
        # the full action timeout for challenge freezes.
        return await asyncio.wait_for(
            state_prefetch.take(dom_service, live_url),
            timeout=BROWSER_STATE_SOFT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning("Speculative browser state build timed out; building fresh")
        return None


async def _observe_step_page(dom_service: Any, *, needs_dom: bool) -> Dict[str, Any]:
    if needs_dom:
        return await dom_service.get_browser_state(include_screenshot=False)
    return await dom_service.get_page_identity()


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
        browser_activity_checkpoint("Waiting for user to hand browser control back")
        await asyncio.sleep(0.5)
        try:
            state = await fetch_browser_control_state(config, task_id)
        except Exception as exc:
            logger.warning("Unable to refresh browser control state; continuing to yield", error=str(exc))
    return yielded


def _browser_action_tool_call_id(llm_result: Dict[str, Any]) -> str:
    """Return the one streamed tool-call id used for an action's full lifecycle."""
    return str(llm_result.get("tool_call_id") or uuid_module.uuid4())


def _captcha_solver_wait_complete(
    *,
    provider: str,
    elapsed_seconds: float,
    page_still_challenged: bool,
    saw_active_solver: bool,
    inactive_polls: int,
) -> bool:
    if page_still_challenged:
        return False
    # Browser Use V4 exposes no in-flight solve status. Its own guidance says
    # to leave a rendered CAPTCHA alone for about 10 seconds before inspecting
    # or switching browsers; three fast null-telemetry polls are too short.
    if provider == "browser-use" and elapsed_seconds < 10:
        return False
    return saw_active_solver or inactive_polls >= 3


async def _wait_for_provider_captcha_solver(
    config: Any,
    task_id: str,
    *,
    page: Optional[Any] = None,
    provider: str = "",
) -> None:
    """Give provider-native auto-solving the first chance before recovery probes.

    Kernel telemetry sets ``isSolving`` to null (terminal outcomes only). When the
    live tab still looks challenged, keep waiting up to the 45s ceiling instead of
    treating three null polls as "solver done".
    """
    started_at = asyncio.get_running_loop().time()
    deadline = started_at + 45
    saw_active_solver = False
    inactive_polls = 0
    last_provider = provider
    while asyncio.get_running_loop().time() < deadline:
        browser_activity_checkpoint("Waiting for provider CAPTCHA auto-solver")
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
            if page_still_challenged or (
                last_provider == "browser-use"
                and asyncio.get_running_loop().time() - started_at < 10
            ):
                await asyncio.sleep(2)
                continue
            await asyncio.sleep(2)
            return
        last_provider = str(telemetry.get("provider") or "")
        is_solving = telemetry.get("isSolving")
        if is_solving is True:
            saw_active_solver = True
            inactive_polls = 0
        elif page_still_challenged:
            # Hard WAF / Kernel-null telemetry: wait out the solver window on the
            # live challenged page instead of exiting after three idle polls.
            inactive_polls = 0
        else:
            inactive_polls += 1
        if is_solving is not True and _captcha_solver_wait_complete(
            provider=last_provider,
            elapsed_seconds=asyncio.get_running_loop().time() - started_at,
            page_still_challenged=page_still_challenged,
            saw_active_solver=saw_active_solver,
            inactive_polls=inactive_polls,
        ):
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


# Clock slack between the mail server's receipt time and this worker's clock.
OTP_TASK_START_SLACK_SECONDS = 30


async def _append_new_otp_user_messages(
    *,
    otps: List[ExtractedOTP],
    seen_otp_codes: set[str],
    otp_user_messages: List[Dict[str, str]],
    credential_refs_by_secret_ref: Optional[Dict[str, Dict[str, str]]] = None,
    pending_otp_ref_messages: Optional[Dict[tuple[str, str, str], str]] = None,
    agent_id: str,
    task_id: Optional[str],
    task_elapsed_seconds: Optional[float] = None,
) -> int:
    """Append unseen OTPs as USER messages and log credential refs.

    A code that arrived before this task started was sent for something else
    (an earlier task of the same user); handing it over as "recently received"
    sends the agent to the site with a code the site never issued it.
    """
    new_count = 0
    pending_refs = pending_otp_ref_messages if pending_otp_ref_messages is not None else {}
    for otp in otps:
        if not is_usable_email_otp(otp):
            logger.info(
                "Skipping stale email OTP",
                agent_id=agent_id,
                source_message_id=otp.source_message_id,
                ttl_seconds=otp.ttl_seconds,
            )
            continue
        if (
            task_elapsed_seconds is not None
            and otp.age_seconds > task_elapsed_seconds + OTP_TASK_START_SLACK_SECONDS
        ):
            # Remember the stale MESSAGE, not its code: a site may reissue the
            # same code for this sign-in, and that fresh mail must still arrive.
            stale_marker = f"stale-message:{otp.source_message_id or otp.code}"
            if stale_marker not in seen_otp_codes:
                seen_otp_codes.add(stale_marker)
                logger.info(
                    "Skipping OTP that predates this browser task",
                    agent_id=agent_id,
                    source_message_id=otp.source_message_id,
                    age_seconds=otp.age_seconds,
                    task_elapsed_seconds=int(task_elapsed_seconds),
                )
            continue

        if otp.code in seen_otp_codes:
            continue
        seen_otp_codes.add(otp.code)
        message = format_otp_user_message(otp)
        otp_user_messages.append({"role": "user", "content": message})
        credential_ref = None
        if otp.credential_id:
            credential_ref = {"kind": otp.credential_kind, "id": str(otp.credential_id)}
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
            ref_key = (otp.code, credential_ref["kind"], credential_ref["id"])
            pending_refs.setdefault(ref_key, message)

    # Persistence retries do not depend on the mailbox returning the OTP again.
    # Each already-owned reference gets one attempt on this existing poll.
    if task_id:
        for ref_key, message in list(pending_refs.items()):
            try:
                accepted = await save_browser_credential_ref_message(
                    agent_id=agent_id,
                    task_id=task_id,
                    message=message,
                    role="USER",
                    credential_ref={"kind": ref_key[1], "id": ref_key[2]},
                )
            except WorkflowGenerationSealed:
                pending_refs.clear()
                raise
            if accepted is True:
                pending_refs.pop(ref_key, None)

    return new_count


async def _fetch_and_append_recent_otp_user_messages(
    *,
    user_id: str,
    api_url: str,
    api_key: str,
    seen_otp_codes: set[str],
    otp_user_messages: List[Dict[str, str]],
    credential_refs_by_secret_ref: Dict[str, Dict[str, str]],
    pending_otp_ref_messages: Optional[Dict[tuple[str, str, str], str]] = None,
    agent_id: str,
    task_id: Optional[str],
    task_elapsed_seconds: Optional[float] = None,
) -> int:
    otps = await fetch_recent_otps(user_id, api_url, api_key)
    return await _append_new_otp_user_messages(
        otps=otps,
        seen_otp_codes=seen_otp_codes,
        otp_user_messages=otp_user_messages,
        credential_refs_by_secret_ref=credential_refs_by_secret_ref,
        pending_otp_ref_messages=pending_otp_ref_messages,
        agent_id=agent_id,
        task_id=task_id,
        task_elapsed_seconds=task_elapsed_seconds,
    )


def _browser_prompt_cache_namespace(task_id: Optional[str], call_site: str) -> Optional[str]:
    """Return one stable provider cache lane per browser task and logical call path."""
    if not task_id:
        return None
    logical_lane = re.sub(r"_(?:step|fork)_\d+$", "", call_site)
    return f"browser-task:{task_id}:{logical_lane}"


def _compute_token_source(source: Optional[str]) -> ComputeTokenSource:
    return "pool" if source == "pool" else "user"


async def _call_browser_use_with_rotation(
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
    pool: str = BROWSER_USE_PRICING_POOL,
    dump_extra: Optional[Dict[str, Any]] = None,
    dom_service: Any = None,
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
        available_actions=[
            action for action in AVAILABLE_ACTIONS
            if action != "screenshot" or getattr(dom_service, "secret_values_used", False) is not True
        ],
        dynamic_system_context=dynamic_system_context,
        turn_messages=turn_messages,
        agent_id=agent_id,
        call_site=effective_call_site,
        cache_namespace=_browser_prompt_cache_namespace(browser_task_id, effective_call_site),
        skip_cache_write=skip_cache_write,
        dump_extra=dump_extra,
        pool=pool,
    )
    if dom_service is not None and hasattr(dom_service, "model_visible_value"):
        redact = dom_service.model_visible_value

        for key in ("task", "dynamic_system_context", "dump_extra"):
            rose_kwargs[key] = redact(rose_kwargs[key])
        rose_kwargs["turn_messages"] = _model_visible_browser_turn_messages(
            turn_messages, redact, secret_values_used=dom_service.secret_values_used,
            action_result_redact=getattr(dom_service, "model_visible_action_result", None),
        )
        rose_kwargs["browser_state"] = redact(browser_state_for_llm)
        rose_kwargs["action_history"] = [redact(entry) for entry in action_entries]
        # Preserve only harness-owned action mechanics, never similarly named
        # fields inside an evaluate result or other page-supplied payload.
        for original, visible in zip(action_entries, rose_kwargs.get("action_history", [])):
            for key in ("step", "action", "index", "coordinates"):
                if key in original:
                    visible[key] = original[key]
            for key in ("params", "result"):
                if key in original:
                    visible[key] = dom_service.model_visible_value(original[key])
            if not dom_service.secret_values_used and original.get("screenshot"):
                visible["screenshot"] = original["screenshot"]
        for key in ("viewport", "scroll_position", "page_stats"):
            if key in browser_state_for_llm:
                rose_kwargs["browser_state"][key] = browser_state_for_llm[key]
        if "tabs" in browser_state_for_llm:
            rose_kwargs["browser_state"]["tabs"] = [
                {**dom_service.model_visible_value(tab), **({"id": tab["id"]} if "id" in tab else {})}
                for tab in browser_state_for_llm["tabs"]
            ]
        if not dom_service.secret_values_used and browser_state_for_llm.get("screenshot"):
            rose_kwargs["browser_state"]["screenshot"] = browser_state_for_llm["screenshot"]
        if extra_user_messages:
            rose_kwargs["browser_state"]["_extra_user_messages"] = _model_visible_browser_turn_messages(
                extra_user_messages, redact, secret_values_used=dom_service.secret_values_used,
                action_result_redact=getattr(dom_service, "model_visible_action_result", None),
            )

    use_claude = browser_use_mode == "claude" and bool(token_state.access_token)
    use_gpt = browser_use_mode == "gpt" and bool(gpt_token)
    claude_auth = (
        ClaudeAuthContext(
            token=token_state.access_token or "",
            source=_compute_token_source(token_state.source),
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
            source=_compute_token_source(gpt_token_source),
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

        browser_activity_checkpoint(f"Step {iteration} - retrying Rose API (rotation {rotations})")
        rotated_auth = ClaudeAuthContext(
            token=token_state.access_token or "",
            source=_compute_token_source(token_state.source),
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
    if action_name in {"click", "click_coordinates"} and "index" not in args and isinstance(coords, dict):
        args.setdefault("x", coords.get("x"))
        args.setdefault("y", coords.get("y"))
    return args


def _browser_tool_result_for_history(action_name: str, result: Dict[str, Any]) -> Dict[str, Any]:
    # formatted_state already embeds url/title/viewport/tabs/dom — keep only that
    # for read_browser_state so the model is not billed twice for the same DOM.
    if action_name == "read_browser_state" and result.get("formatted_state"):
        return {
            "success": result.get("success", True),
            "message": result.get("message", ""),
            "formatted_state": result["formatted_state"],
            **({"auth_context": result["auth_context"]} if "auth_context" in result else {}),
        }
    clean: Dict[str, Any] = {}
    for key, value in (result or {}).items():
        if key in {"screenshot", "screenshot_b64", "base64"}:
            continue
        if key in {"dom_tree"}:
            continue
        clean[key] = value
    if action_name == "screenshot" and (result.get("screenshot") or result.get("screenshot_b64")):
        clean["screenshot_attached"] = True
    return clean


def _append_browser_turn_messages(
    turn_messages: List[Dict[str, Any]],
    *,
    unified_action: Dict[str, Any],
    result: Dict[str, Any],
    tool_call_id: str,
) -> None:
    """Append assistant tool call and tool result to the next LLM context."""
    action_name = unified_action.get("action") or "unknown"
    thinking = unified_action.get("thinking") or ""
    args = _browser_tool_arguments(unified_action)
    # The provider normalizes click_coordinates to an internal click + coordinates.
    # Reconstruct the advertised tool name here so the next LLM turn does not see
    # a successful but invalid-looking click({}) and try to correct a valid action.
    if action_name == "click" and "index" not in args and {"x", "y"} <= args.keys():
        action_name = "click_coordinates"
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


def _resolve_payment_card_tool_result_for_resume(
    turn_messages: List[Dict[str, Any]],
    payment_card_refs: Dict[str, Any],
    payment_card_last4: Any,
) -> bool:
    """Finish the pending browser tool result with safe refs after approval."""
    if not has_payment_card_secret_refs(payment_card_refs):
        return False

    for index in range(len(turn_messages) - 1, 0, -1):
        message = turn_messages[index]
        if message.get("role") != "tool" or message.get("name") != "request_payment_card":
            continue
        prior = turn_messages[index - 1]
        if prior.get("role") != "assistant" or not any(
            call.get("id") == message.get("tool_call_id")
            and (call.get("function") or {}).get("name") == "request_payment_card"
            for call in prior.get("tool_calls") or []
        ):
            continue
        try:
            previous_result = json.loads(message.get("content") or "")
        except (TypeError, ValueError):
            continue
        if not isinstance(previous_result, dict) or previous_result.get("status") != "awaiting_payment_card_approval":
            continue

        finished_result: Dict[str, Any] = {
            **previous_result,
            "success": True,
            "status": "payment_card_ready",
            "card_secret_refs": {
                ref: secret_placeholder(ref) for ref in PAYMENT_CARD_SECRET_REFS
            },
        }
        safe_last4 = _normalize_payment_card_last4(payment_card_last4)
        if safe_last4:
            finished_result["card_last4"] = safe_last4
        turn_messages[index] = {**message, "content": json_dumps_compact(finished_result)}
        return True
    return False


async def _get_browser_state_soft(
    dom_service: Any,
    *,
    include_screenshot: bool = False,
    timeout_seconds: float = BROWSER_STATE_SOFT_TIMEOUT_SECONDS,
    attempts: int = BROWSER_STATE_SOFT_ATTEMPTS,
) -> Optional[Dict[str, Any]]:
    """Best-effort browser state with a short timeout and one retry.

    For optional refreshes only (e.g. screenshot after a durable verifier
    rejection). Healthy fetches finish near ~10s p95; hanging CDP on a frozen
    challenge page must not burn the 300s BrowserStateRequest budget or sit
    inside a critical try/except. Returns None when every attempt times out or
    errors — callers continue without the screenshot.
    """
    last_error: Optional[BaseException] = None
    total_attempts = max(1, int(attempts))
    per_attempt_timeout = float(timeout_seconds)
    for attempt in range(1, total_attempts + 1):
        try:
            return await asyncio.wait_for(
                dom_service.get_browser_state(include_screenshot=include_screenshot),
                timeout=per_attempt_timeout,
            )
        except Exception as exc:
            last_error = exc
            logger.warning(
                "Soft get_browser_state attempt failed",
                attempt=attempt,
                attempts=total_attempts,
                timeout_seconds=per_attempt_timeout,
                include_screenshot=include_screenshot,
                error=str(exc)[:200],
            )
    if last_error is not None:
        logger.warning(
            "Soft get_browser_state exhausted attempts; continuing without state",
            attempts=total_attempts,
            timeout_seconds=per_attempt_timeout,
            error=str(last_error)[:200],
        )
    return None


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
        unified_action=unified_action,
        result=action_result,
        tool_call_id=recovery_call_id,
    )
    await browser_stream.finish_tools(status="FINISHED" if action_result.get("success") else "ERROR")



def _feed_browser_model_output_validation_error_back(*, error, browser_turn_messages, dom_service):
    """Preserve actual model output and explicit runtime feedback, without inventing actions."""
    response = error.response
    messages = []
    if response.content:
        messages.append({"role": "assistant", "content": response.content})
    if response.tool_calls:
        messages.append({"role": "assistant", "content": (
            "Rejected provider tool-call records (untrusted model output; not executed):\n"
            + json.dumps(response.tool_calls, ensure_ascii=False, default=str)
        )})
    feedback = (
        "[Browser runtime output validation] The preceding completed model response "
        "did not contain a valid browser action. This is runtime validation feedback, "
        "not a user request. Return a valid action using the existing tools or supported "
        "action JSON. No action was executed."
    )
    redact = getattr(dom_service, "model_visible_value", None)
    if callable(redact):
        messages = _model_visible_browser_turn_messages(
            messages, redact, secret_values_used=getattr(dom_service, "secret_values_used", False),
        )
    browser_turn_messages.extend(messages)
    # Transport role is not durable human authorship; no user ledger is written.
    browser_turn_messages.append({"role": "user", "content": feedback})

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

    browser_activity_checkpoint("starting browser recovery snapshot")
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
            page = await wait_for_browser_work(dom_service.session.get_current_page(), timeout=timeout_s)

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
        page_data = await wait_for_browser_work(_read_page(), timeout=timeout_s)
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
                    "title": await wait_for_browser_work(tab.title(), timeout=1.5),
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

    browser_activity_checkpoint("starting browser recovery actions")
    actions: List[str] = []
    if input_page is None:
        return actions

    with contextlib.suppress(Exception):
        await wait_for_browser_work(input_page.bring_to_front(), timeout=timeout_s)
        actions.append("bring_to_front")

    with contextlib.suppress(Exception):
        await wait_for_browser_work(input_page.keyboard.press("Escape"), timeout=timeout_s)
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
        clicked = await wait_for_browser_work(_click_dismiss_button(), timeout=timeout_s)
        if clicked:
            actions.append(clicked)

    if reload_page:
        with contextlib.suppress(Exception):
            current_url = getattr(input_page, "url", "") or ""
            if current_url.startswith(("http://", "https://")):
                await wait_for_browser_work(
                    input_page.reload(),
                    timeout=timeout_s + 2,
                )
                actions.append("reload")
            elif fallback_url.startswith(("http://", "https://")):
                await wait_for_browser_work(
                    input_page.goto(fallback_url, wait_until="domcontentloaded", timeout=int(timeout_s * 1000)),
                    timeout=timeout_s + 2,
                )
                actions.append("goto_fallback_url")

    return actions


async def _hard_recover_frozen_renderer_page(
    *,
    input_page: Optional[Any],
    playwright_browser: Optional[Any],
    fallback_url: str = "",
    timeout_s: float = 20.0,
) -> tuple[Optional[Any], List[str]]:
    """Open a fresh page, then kill the frozen target via browser-process CDP.

    When classify_evaluate_cdp_stall reports renderer_main_thread_blocked, the
    page-target CDP is dead but Browser.getVersion still works. Creating the
    replacement page *before* closing the hung target is required: closing the
    last page target via CDP can tear down the Playwright BrowserContext.
    """
    actions: List[str] = []
    if playwright_browser is None or not hasattr(playwright_browser, "new_browser_cdp_session"):
        return input_page, actions

    target_url = (getattr(input_page, "url", None) or "") if input_page is not None else ""
    resume_url = fallback_url if fallback_url.startswith(("http://", "https://")) else target_url
    if not resume_url and fallback_url:
        resume_url = fallback_url

    context = getattr(input_page, "context", None) if input_page is not None else None
    if context is None:
        contexts = getattr(playwright_browser, "contexts", None) or []
        context = contexts[0] if contexts else None
    if context is None:
        actions.append("no_browser_context")
        return None, actions

    frozen_target_ids: List[str] = []
    browser_cdp = None
    try:
        browser_cdp = await playwright_browser.new_browser_cdp_session()
        targets = await asyncio.wait_for(browser_cdp.send("Target.getTargets"), timeout=5.0)
        for info in targets.get("targetInfos") or []:
            if info.get("type") != "page":
                continue
            page_url = str(info.get("url") or "")
            target_id = info.get("targetId")
            if not target_id:
                continue
            should_close = False
            if target_url and page_url == target_url:
                should_close = True
            elif resume_url.startswith(("http://", "https://")) and page_url.startswith(
                ("http://", "https://")
            ):
                try:
                    from urllib.parse import urlparse

                    if urlparse(page_url).netloc == urlparse(resume_url).netloc:
                        should_close = True
                except Exception:
                    should_close = False
            elif input_page is not None and not target_url.startswith(("http://", "https://")):
                should_close = True
            if should_close:
                frozen_target_ids.append(str(target_id))
    except Exception as exc:
        actions.append(f"browser_cdp_list_failed:{type(exc).__name__}")
        if browser_cdp is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(browser_cdp.detach(), timeout=1.0)
            browser_cdp = None

    try:
        # Prefer a fresh BrowserContext: under a pegged renderer,
        # context.new_page() can fail with "Please use browser.new_context()".
        new_context = await asyncio.wait_for(playwright_browser.new_context(), timeout=10.0)
        new_page = await asyncio.wait_for(new_context.new_page(), timeout=10.0)
        actions.append("new_context_page")
    except Exception as exc:
        actions.append(f"new_page_failed:{type(exc).__name__}")
        try:
            new_page = await asyncio.wait_for(context.new_page(), timeout=10.0)
            actions.append("new_page")
        except Exception as exc2:
            actions.append(f"context_new_page_failed:{type(exc2).__name__}")
            if browser_cdp is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(browser_cdp.detach(), timeout=1.0)
            return None, actions

    if resume_url.startswith(("http://", "https://")):
        try:
            await asyncio.wait_for(
                new_page.goto(
                    resume_url,
                    wait_until="domcontentloaded",
                    timeout=int(timeout_s * 1000),
                ),
                timeout=timeout_s + 5,
            )
            actions.append("goto_resume_url")
        except Exception as exc:
            actions.append(f"goto_resume_failed:{type(exc).__name__}")
    elif resume_url:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(new_page.goto(resume_url), timeout=10.0)
            actions.append("goto_resume_url")

    if browser_cdp is not None:
        closed = 0
        for target_id in frozen_target_ids:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    browser_cdp.send("Target.closeTarget", {"targetId": target_id}),
                    timeout=5.0,
                )
                closed += 1
                actions.append(f"close_target:{target_id[:12]}")
        if closed:
            actions.append(f"closed_targets:{closed}")
        with contextlib.suppress(Exception):
            await asyncio.wait_for(browser_cdp.detach(), timeout=1.0)

    if input_page is not None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(input_page.close(), timeout=3.0)
            actions.append("close_playwright_page")

    return new_page, actions


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


# Max fork attempts including the first call. Every gate retries with the
# validation/tool error in context before falling back to the deterministic question.
_WRITE_LOCK_NOTIFICATION_FORK_ATTEMPTS = 3

# Worked examples for the notification fork — payloads mirror the fields our
# renderer (_render_write_lock_notification_question / _append_*_notification)
# and schema already prescribe. Shown to the model as format targets, not as
# hardcoded gate→trigger routing.
_WRITE_LOCK_NOTIFICATION_EXAMPLES: tuple[tuple[str, Dict[str, Any], str], ...] = (
    (
        "Purchases (buying / placing an order)",
        {
            "trigger_type": "purchase",
            "action": "buy one black Carhartt beanie",
            "service": {
                "name": "Amazon",
                "domain": "amazon.com",
                "url": "https://www.amazon.com/checkout/spc",
            },
            "media": [
                {
                    "url": "https://m.media-amazon.com/images/I/beanie.jpg",
                    "alt": "Carhartt beanie",
                    "kind": "product",
                }
            ],
            "purchase": {
                "items": [
                    {
                        "title": "Carhartt Mens Knit Cuffed Beanie Hat, Black",
                        "price": "$19.99",
                        "quantity": "1",
                        "description": "Black, One Size",
                        "rating": "4.8 stars",
                        "review_count": "167,432 reviews",
                        "image_url": "https://m.media-amazon.com/images/I/beanie.jpg",
                        "product_url": "https://www.amazon.com/dp/B000000001",
                        "seller": "Amazon.com",
                        "shipping": "FREE Two Day delivery, arriving Saturday, Jun 27, 2026",
                    }
                ],
                "totals": {
                    "subtotal": "$19.99",
                    "shipping": "$0.00",
                    "tax": "$1.72",
                    "total": "$21.71",
                },
                "payment_method": "Visa ending in 0000",
                "delivery_address": "Jane Example, 1 Example St, San Francisco, CA 94105",
            },
        },
        (
            "Every visible item; one media image (or rendered_summary for multi-item). "
            "Per item require title, numeric rating, review count, and a canonical "
            "product-detail URL already in the trajectory — never cart/checkout/order/return URLs. "
            "Include price, qty, description (<80 chars), seller, shipping, totals, payment, address when visible."
        ),
    ),
    (
        "Emails / outbound messages",
        {
            "trigger_type": "message",
            "action": "send email",
            "service": {
                "name": "Gmail",
                "domain": "mail.google.com",
                "url": "https://mail.google.com/mail/u/0/#inbox?compose=new",
            },
            "media": [],
            "message": {
                "to": ["alex@example.com"],
                "cc": [],
                "bcc": [],
                "subject": "Dinner Friday",
                "body": "Want to grab dinner Friday at 7?",
                "attachments": [],
            },
        },
        "Include visible to/cc/bcc, subject, body, and attachments when shown.",
    ),
    (
        "Social posts",
        {
            "trigger_type": "social_post",
            "action": "post publicly",
            "service": {"name": "X", "domain": "x.com", "url": "https://x.com/compose/post"},
            "media": [],
            "social_post": {
                "destination": "your profile",
                "audience": "Public",
                "body": "Shipped the v1 release today.",
                "attachments": [],
            },
        },
        "Include visible destination, audience, body, and attachments when shown.",
    ),
    (
        "Returns / refund confirmations",
        {
            "trigger_type": "generic_write",
            "action": "confirm Amazon return for Carhartt beanie",
            "service": {
                "name": "Amazon",
                "domain": "amazon.com",
                "url": "https://www.amazon.com/spr/returns/contract/example",
            },
            "media": [
                {
                    "url": "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA152_.jpg",
                    "alt": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
                    "kind": "product",
                }
            ],
            "generic_write": {
                "label": "Confirm return",
                "target": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
                "payload_summary": (
                    "Refund $10.84 to original payment method via Whole Foods Dropoff. "
                    "Return by Sep 19, 2026."
                ),
            },
        },
        (
            "Use generic_write for return/refund confirmations. Put item title in target and "
            "refund amount, original payment method, the named drop-off/pickup location from "
            "the page (e.g. 'Whole Foods Dropoff' — never a bare 'drop-off/pickup' placeholder), "
            "and return-by date in payload_summary. Do not invent purchase ratings or "
            "product-detail URLs. If no named drop-off is visible yet, the irreversible commit "
            "has not been reached — do not fabricate one."
        ),
    ),
    (
        "Payment field entry",
        {
            "trigger_type": "payment",
            "action": "enter payment details",
            "service": {
                "name": "Delta",
                "domain": "delta.com",
                "url": "https://www.delta.com/checkout",
            },
            "media": [
                {
                    "url": "https://cdn.delta.com/receipt.png",
                    "alt": "Booking summary",
                    "kind": "page_preview",
                }
            ],
            "payment": {
                "merchant": "Delta Air Lines",
                "amount": "$412.30",
                "purpose": "Flight SFO -> JFK",
                "fields": ["card number", "expiration date", "CVV"],
            },
        },
        "Never include card numbers, CVV, passwords, tokens, or one-time codes.",
    ),
)


def _write_lock_notification_example_block() -> str:
    """Render prescribed worked examples for the fork prompt."""
    sections: List[str] = [
        "Call generate_write_lock_notification exactly once.",
        "Choose the trigger_type whose example best matches the real-world irreversible action.",
        "Copy that example's shape; fill fields only from the browser trajectory — never invent.",
        "If Runtime evidence includes media_candidates, use only those URLs for media / image_url.",
        "approval_type in Runtime evidence is a hint from the click gate, not a required trigger_type.",
        "",
    ]
    for title, payload, notes in _WRITE_LOCK_NOTIFICATION_EXAMPLES:
        rendered = _render_write_lock_notification_question(
            payload,
            system_name="Rose",
            fallback_question="Approve?",
        )
        sections.append(f"### {title}")
        sections.append(f"Notes: {notes}")
        sections.append("Tool args example:")
        sections.append(json_dumps_compact({"tool": "generate_write_lock_notification", **payload}))
        sections.append("Notification format this produces:")
        sections.append(rendered)
        sections.append("")
    return "\n".join(sections).strip()


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
        "mechanic.\n\n"
        f"{_write_lock_notification_example_block()}\n\n"
        f"Runtime evidence:\n{json_dumps_compact(evidence)}"
    )


class PurchaseApprovalContextError(RuntimeError):
    """Raised when a purchase approval cannot meet its required context contract."""


class PurchaseApprovalNotificationRetryableError(RuntimeError):
    """Raised when transient notification generation should preserve checkout state for retry.

    Kept for backwards-compatible imports/tests. Write-lock notification forks now
    retry with the error in context for every gate and fall back to the deterministic
    question instead of aborting the browser session.
    """


def _enforce_write_lock_notification_failure_policy(approval_type: str, error: Exception) -> None:
    """All gates fall through to the deterministic fallback question after fork retries."""
    logger.info(
        "Write-lock notification fork exhausted; using fallback question",
        approval_type=approval_type,
        error_type=type(error).__name__,
        error=str(error)[:300],
    )


def _write_lock_notification_retry_feedback(error: Exception) -> str:
    detail = getattr(error, "detail", None) or str(error)
    return (
        "Your previous generate_write_lock_notification call failed:\n"
        f"{detail}\n"
        "Call generate_write_lock_notification exactly once again. Choose the trigger_type "
        "whose example matches the real-world action and satisfy that example's required "
        "fields using only evidence already in the browser trajectory. Do not invent "
        "unavailable fields."
    )


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
    pool: str = BROWSER_USE_PRICING_POOL,
    dom_service: Any = None,
) -> Dict[str, Any]:
    """Fork browser-use context to generate write-lock approval metadata."""
    from browser_tools.schemas import GenerateWriteLockNotificationTool

    prompt = _write_lock_notification_prompt(
        approval_type=approval_type,
        current_url=current_url,
        pending_action=pending_action,
        write_lock_result=write_lock_result,
        media_candidates=browser_state.get("media_candidates"),
    )
    extra_user_messages: List[Dict[str, Any]] = [{"role": "user", "content": prompt}]
    browser_turn_messages = [dict(message) for message in browser_turn_messages]
    fork_result: Dict[str, Any] = {}
    validated_notification: Any = None
    # Same policy for every gate: retry with the error in context, then let the
    # caller fall back to the deterministic question.
    for attempt in range(_WRITE_LOCK_NOTIFICATION_FORK_ATTEMPTS):
        try:
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
                extra_user_messages=extra_user_messages,
                call_site=f"write_lock_notification_fork_{iteration}"
                + (f"_retry{attempt}" if attempt else ""),
                skip_cache_write=True,
                pool=pool,
                dom_service=dom_service,
                dump_extra={
                    "write_lock_notification_fork": True,
                    "approval_type": approval_type,
                    "current_url": current_url,
                    "fork_attempt": attempt,
                },
            )
            action = fork_result.get("action") or {}
            if action.get("action") != "generate_write_lock_notification":
                raise ValueError(
                    "write-lock notification fork did not call generate_write_lock_notification; "
                    f"got {action.get('action')!r}"
                )
            try:
                validated_notification = GenerateWriteLockNotificationTool.model_validate(
                    {"tool": "generate_write_lock_notification", **dict(action.get("params") or {})},
                    context={"trusted_page_urls": [*trusted_page_urls, current_url]},
                )
            except ValueError as error:
                raise PurchaseApprovalContextError(str(error)) from error
            break
        except BrowserModelOutputValidationError as fork_error:
            if attempt >= _WRITE_LOCK_NOTIFICATION_FORK_ATTEMPTS - 1:
                raise
            _feed_browser_model_output_validation_error_back(
                error=fork_error, browser_turn_messages=browser_turn_messages, dom_service=dom_service,
            )
        except (BrowserToolArgsValidationError, PurchaseApprovalContextError, ValueError) as fork_error:
            logger.info(
                "Write-lock notification fork failed; retrying with error in context",
                attempt=attempt,
                approval_type=approval_type,
                error_type=type(fork_error).__name__,
                detail=str(getattr(fork_error, "detail", fork_error))[:400],
            )
            if attempt >= _WRITE_LOCK_NOTIFICATION_FORK_ATTEMPTS - 1:
                raise
            extra_user_messages = [
                {"role": "user", "content": prompt},
                {"role": "user", "content": _write_lock_notification_retry_feedback(fork_error)},
            ]
    else:
        raise RuntimeError("write-lock notification fork exhausted without a validated notification")

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
    from browser_tools.control_projection import OperationalResult

    # Normalize while still private and unmasked, before deriving either view.
    notification_source = GenerateWriteLockNotificationTool.model_validate(
        {"tool": "generate_write_lock_notification", **notification},
        context={"trusted_page_urls": [*trusted_page_urls, current_url]},
    )
    return OperationalResult({
        "notification": notification,
        "question": question,
        "usage": fork_result.get("usage") or {},
        "actual_model": fork_result.get("actual_model"),
        "request_id": fork_result.get("request_id"),
        "mode": fork_result.get("mode"),
    }, field="write_lock_notification", source=notification_source)


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


def _recording_part_metadata(browser_recorder: Any) -> Dict[str, Any]:
    """Identify which activity part a saved recording covers.

    An approval/auth-assistance pause ends the activity and saves its recording;
    the resumed activity saves another for the same task. The FE plays every part
    and orders/places them by this start, since save order can differ.
    """
    started_at = getattr(browser_recorder, "started_at", None)
    return {"recording_started_at": started_at} if isinstance(started_at, str) and started_at else {}


async def _finalize_kernel_replay_for_fe(
    *,
    browser_recorder: BrowserAgentRecorder | SimulatedBrowserRecorder,
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
    extra_metadata: Dict[str, Any] = {
        "browser_session_metadata": browser_session_metadata,
        **_recording_part_metadata(browser_recorder),
    }
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
        except Exception as exc:  # stitch/upload is best-effort
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

    accepted = await save_browser_action_message(
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
    if not accepted:
        raise RuntimeError("Browser recording message was not acknowledged")
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
    browser_recorder: BrowserAgentRecorder | SimulatedBrowserRecorder,
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
        except WorkflowGenerationSealed:
            raise
        except Exception as exc:  # recording upload is best-effort
            logger.warning(
                "Browser recording upload failed",
                agent_id=agent_id,
                task_id=task_id,
                error=repr(exc),
                html_bytes=len(html_bytes) if isinstance(html_bytes, (bytes, bytearray)) else None,
            )

        accepted = await save_browser_action_message(
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
                **_recording_part_metadata(browser_recorder),
            },
        )
        if not accepted:
            raise RuntimeError("Browser recording message was not acknowledged")
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
    browser_recorder: BrowserAgentRecorder | SimulatedBrowserRecorder,
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
        except WorkflowGenerationSealed:
            raise
        except Exception as exc:  # final cleanup should not mask the activity result
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
    except WorkflowGenerationSealed:
        raise
    except Exception as exc:  # final cleanup should not mask the activity result
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
    except WorkflowGenerationSealed:
        raise
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
    except WorkflowGenerationSealed:
        raise
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


@contextlib.contextmanager
def _suppress_browser_cleanup_errors():
    """Ordinary cleanup is best-effort; native generation fencing must escape."""
    try:
        yield
    except WorkflowGenerationSealed:
        raise
    except Exception:
        pass


async def _emit_browser_task_terminal_for_fe(
    *,
    agent_id: str,
    task_id: Optional[str],
    tool_call_id: Optional[str],
    browser_url: Optional[str],
    title: str = "Browser Session Closed",
    message: str = "Browser session closed",
    preparation_cancellation: Optional[Dict[str, Any]] = None,
    cleanup_failure: Optional[Dict[str, Any]] = None,
) -> None:
    """Close the FE live browser chip after recording/session teardown.

    ``computeActiveBrowserPanels`` keeps a panel open until it sees an explicit
    terminal ``action_type`` (``task_complete`` / ``session_paused`` /
    ``write_lock_rejected``). Finalizing a ``recording`` message alone does
    **not** close the chip — timeout/cancel paths historically left hub
    transcripts with FINISHED recordings and an IN_PROGRESS ``browser`` row,
    so every FE link kept showing an active browser panel.

    Reuses the spawn ``tool_call_id`` so the FE can associate the terminal with
    the open panel, but marks ``excludeFromModel=True``: this row is FE-only.
    Without that flag, late teardown FINISHED wins LLM tool-result dedup over
    the real "Browser automation complete" / "✓ Task Completed" payload and
    smoke context validation reports a false role_alternation dual-write.
    """
    if not task_id:
        return
    with _suppress_browser_cleanup_errors():
        await save_browser_action_message(
            agent_id=agent_id,
            title="Browser Session Cleanup Failed" if cleanup_failure else title,
            task_id=task_id,
            message="Browser session cleanup failed" if cleanup_failure else message,
            status=MessageStatus.ERROR if cleanup_failure else MessageStatus.FINISHED,
            browser_url=browser_url or "",
            action_type="task_complete",
            tool_call_id=tool_call_id or str(uuid_module.uuid4()),
            is_completion_message=True,
            extra_metadata={
                "excludeFromModel": True,
                **({"browser_cleanup": cleanup_failure} if cleanup_failure else {}),
                **({"browser_preparation_cancellation": preparation_cancellation} if preparation_cancellation else {}),
            },
        )


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
    tool_call_id: Optional[str] = None,
    emit_task_terminal: bool = True,
    local_only: bool = False,
    local_only_recorders: Optional[List[Any]] = None,
    local_only_setup_tasks: tuple[Any, ...] = (),
    preparation_cancellation: Optional[Dict[str, Any]] = None,
    cleanup_failure: Optional[Dict[str, Any]] = None,
) -> asyncio.Task:
    async def _cleanup() -> None:
        logger.info("Browser cleanup started in background", agent_id=agent_id, task_id=task_id)
        resolved_network_recorder = browser_network_recorder
        async def dispose_local() -> None:
            nonlocal resolved_network_recorder
            # Cancel setup before collecting its registered instances.
            deadline = asyncio.get_running_loop().time() + BROWSER_TERMINAL_DISCONNECT_TIMEOUT_SECONDS
            owned_tasks = {task for task in (interaction_layer_task, network_recorder_task, *local_only_setup_tasks)
                           if isinstance(task, asyncio.Task)}
            if cursor_streamer is not None:
                cursor_streamer.closed = True
                if isinstance(cursor_streamer.flush_task, asyncio.Task):
                    owned_tasks.add(cursor_streamer.flush_task)
            for owned_task in owned_tasks:
                owned_task.cancel()
                owned_task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
            if owned_tasks:
                await asyncio.wait(owned_tasks, timeout=max(0.0, deadline - asyncio.get_running_loop().time()))
            if resolved_network_recorder is None and network_recorder_task is not None:
                if network_recorder_task.done() and not network_recorder_task.cancelled():
                    with contextlib.suppress(Exception):
                        resolved_network_recorder = network_recorder_task.result()
            recorders = [browser_recorder, resolved_network_recorder, *(local_only_recorders or [])]
            aborted = set()
            for recorder in recorders:
                if recorder is not None and id(recorder) not in aborted:
                    aborted.add(id(recorder))
                    with contextlib.suppress(Exception):
                        await recorder.abort_local(
                            settle_timeout=max(0.0, deadline - asyncio.get_running_loop().time())
                        )
            if humanizer is not None:
                with contextlib.suppress(Exception):
                    await _bounded_browser_terminal_io(humanizer.close(), "sealed humanizer detach")
            if dom_service is not None:
                with contextlib.suppress(Exception):
                    await _bounded_browser_terminal_io(dom_service.disconnect(), "sealed CDP detach")
            await _stop_playwright_resources(
                playwright_browser, playwright_instance, agent_id,
                close_browser=False, driver_pid=playwright_driver_pid,
            )
        try:
            if local_only:
                await dispose_local()
                return
            if cursor_streamer:
                with _suppress_browser_cleanup_errors():
                    await cursor_streamer.close()
            if input_page and _botsigged_diagnostics_enabled(start_url):
                with _suppress_browser_cleanup_errors():
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
                with _suppress_browser_cleanup_errors():
                    await asyncio.wait_for(asyncio.shield(interaction_layer_task), timeout=10)
            if humanizer:
                with _suppress_browser_cleanup_errors():
                    await humanizer.close()
            if network_recorder_task is not None:
                with _suppress_browser_cleanup_errors():
                    resolved_network_recorder = await asyncio.wait_for(network_recorder_task, timeout=10)
            if resolved_network_recorder:
                with _suppress_browser_cleanup_errors():
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
            # Recording finalize alone does not close the FE live chip. Emit a
            # task_complete terminal so timeout/cancel cleanup cannot leave the
            # panel stuck on an IN_PROGRESS browser row (hotel k=5 hub chips).
            if emit_task_terminal and not local_only:
                await _emit_browser_task_terminal_for_fe(
                    agent_id=agent_id,
                    task_id=task_id,
                    tool_call_id=tool_call_id,
                    browser_url=browser_url,
                    title="Browser Session Closed",
                    message="Browser session closed after teardown",
                    preparation_cancellation=preparation_cancellation,
                    cleanup_failure=cleanup_failure,
                )
            if dom_service:
                try:
                    await _bounded_browser_terminal_io(dom_service.disconnect(), "cleanup CDP disconnect")
                except Exception as disconnect_error:
                    logger.warning(
                        "Browser cleanup CDP disconnect failed",
                        agent_id=agent_id,
                        task_id=task_id,
                        error=extract_error_message(disconnect_error),
                    )
            await _stop_playwright_resources(
                playwright_browser,
                playwright_instance,
                agent_id,
                driver_pid=playwright_driver_pid,
            )
        except WorkflowGenerationSealed:
            await dispose_local()
        except Exception as exc:  # background cleanup must never crash the worker loop
            logger.warning(
                "Browser cleanup failed in background",
                agent_id=agent_id,
                task_id=task_id,
                error=extract_error_message(exc),
            )
            if emit_task_terminal and not local_only:
                try:
                    await _emit_browser_task_terminal_for_fe(
                        agent_id=agent_id,
                        task_id=task_id,
                        tool_call_id=tool_call_id,
                        browser_url=browser_url,
                        title="Browser Session Closed",
                        message="Browser session closed after teardown error",
                        cleanup_failure=cleanup_failure,
                    )
                except WorkflowGenerationSealed:
                    await dispose_local()
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
    # Optional CDP children enter this set only after their own deadline expired.
    # Keep them referenced, but do not spend the recording/provider drain on them
    # again. The worker event-loop owner closes these narrowly named I/O tasks.
    pending = [
        task for task in _background_browser_cleanup_tasks
        if not task.done() and task.get_name() != _EXPIRED_OPTIONAL_CDP_TASK_NAME
    ]
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
    agent_model: Optional[str] = None,
) -> Dict[str, Any]:
    # Browser steps run on the spawning agent's Rose pool (ultra root → ultra).
    browser_pool = browser_pool_for_agent_model(agent_model)
    # A browser is its own stateful environment. Do not inherit either the
    # benchmark runner's explicit session or the parent agent's module-cached
    # session. The latter uses ``agent_id`` as its cache key and can be created
    # by a provider boundary before this activity starts; sharing it makes WMH
    # answer browser actions using the parent's whole-agent output contract.
    # The tool-call namespace remains stable across write-lock resumes, whose
    # payload also restores the exact browser session id.
    world_model = WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        session_scope_id=f"{agent_id}:browser:{tool_call_id}",
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
            browser_pool=browser_pool,
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
        browser_pool=browser_pool,
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

    if action_name == "read_browser_state":
        state = dict(browser_state or {})
        formatted_state = format_browser_state_for_tool(state)
        result = {
            "success": True,
            "message": "Browser state captured.",
            "formatted_state": formatted_state,
            "url": state.get("url", ""),
            "title": state.get("title", ""),
            "viewport": state.get("viewport"),
            "scroll_position": state.get("scroll_position"),
            "page_stats": state.get("page_stats"),
            "tabs": state.get("tabs"),
            "dom_tree": state.get("dom_tree", ""),
        }
        return result, state, _simulated_browser_frame_from_result(result, state)

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
    "browser_turn_messages",
    "reasoning_messages",
    "action_summary",
    "auth_attempts",
    "secret_values_used",
    "browser_resume_context_ref",
    "user_instruction_messages",
    "delivered_user_instruction_count",
    "user_message_cursor",
    "user_message_cursor_is_task_start",
    "user_instruction_message_ids",
    "schema_user_instruction_count",
    "browser_output_schema",
)


def _copy_browser_resume_continuity_fields(source: Dict[str, Any], target: Dict[str, Any]) -> None:
    for key in _BROWSER_RESUME_CONTINUITY_FIELDS:
        if key in source:
            target[key] = source[key]


_BROWSER_PAUSE_STATUSES = frozenset(
    {
        "awaiting_write_approval",
        "awaiting_payment_card_approval",
        "awaiting_auth_assistance",
        BROWSER_DRAIN_YIELD_STATUS,
    }
)
_PAYMENT_RESUME_FIELDS = ("payment_card_refs", "payment_card_last4")


def _payment_resume_fields(resume_state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Minted-card fields every later resume of the same browser task must keep."""
    return {key: resume_state[key] for key in _PAYMENT_RESUME_FIELDS if resume_state and resume_state.get(key)}


def _reused_session_deadline(session_info: Dict[str, Any]) -> Optional[Tuple[str, float]]:
    """(session id, monotonic release time) of a reused provider session with a lifetime."""
    if session_info.get("same_session_available") is not True:
        return None
    health = session_info.get("browser_session_health")
    ttl_ms = health.get("ttlMs") if isinstance(health, dict) else None
    session_id = session_info.get("session_id")
    if not isinstance(session_id, str) or isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)):
        return None
    return session_id, time.monotonic() + ttl_ms / 1000


def _session_expiring(deadline: Optional[Tuple[str, float]], session_id: Optional[str]) -> bool:
    if deadline is None or deadline[0] != session_id:
        return False
    return deadline[1] - time.monotonic() < BROWSER_SESSION_MIN_REMAINING_SECONDS


def _drain_resume_state(result: Dict[str, Any], prior_resume: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Resume state that restarts a drained browser task at its next step."""
    prior = prior_resume or {}
    resume_state: Dict[str, Any] = {
        "pending_action": None,
        "write_lock_approvals": result.get("write_lock_approvals", {}),
        # Only a payment resume changes activity startup (card refs + merchant
        # unlock); any other value continues the step loop unchanged.
        "approval_type": "payment" if prior.get("approval_type") == "payment" else BROWSER_DRAIN_YIELD_STATUS,
        "step_count": result.get("step_count", 0),
        "session_id": result.get("session_id"),
        "cdp_url": result.get("cdp_url"),
        "task_id": result.get("task_id"),
        "auth_realm": result.get("auth_realm"),
        "recorded_passkey_credential_ids": result.get("recorded_passkey_credential_ids", []),
        **_payment_resume_fields(prior),
    }
    if prior.get("generation_yield") is False or result.get("yield_reason") == GENERATION_SUPERSEDED:
        resume_state["generation_yield"] = False
    _copy_browser_resume_continuity_fields(result, resume_state)
    return resume_state


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
    retained_turns = [message for message in turn_messages[:-24] if message.get("role") == "user"] + turn_messages[-24:]
    compact_turns = [
        dict(message) if message.get("role") == "user" else _compact_browser_turn_message_for_resume(message)
        for message in retained_turns
    ]
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


def _compact_browser_turn_message_for_resume(message: Dict[str, Any]) -> Dict[str, Any]:
    """Keep payment tool JSON parseable when a large cart crosses a resume boundary."""
    compact = _compact_simulated_resume_value(_replace_resume_image_blocks(message))
    if message.get("role") == "tool" and message.get("name") == "request_payment_card":
        try:
            result = json.loads(message.get("content") or "")
        except (TypeError, ValueError):
            result = None
        if isinstance(result, dict) and result.get("status") == "awaiting_payment_card_approval":
            compact["content"] = json_dumps_compact(
                {"success": result.get("success", True), "status": "awaiting_payment_card_approval"}
            )
    if message.get("role") == "assistant":
        for original_call, compact_call in zip(message.get("tool_calls") or [], compact.get("tool_calls") or []):
            original_function = original_call.get("function") or {}
            if original_function.get("name") != "request_payment_card":
                continue
            arguments = original_function.get("arguments")
            if not isinstance(arguments, str) or len(arguments) <= _SIMULATED_RESUME_MAX_TEXT_CHARS:
                continue
            try:
                request = json.loads(arguments)
            except (TypeError, ValueError):
                continue
            if isinstance(request, dict):
                compact_call["function"]["arguments"] = json_dumps_compact(
                    _summarize_payment_request_for_log(request)
                )
    return compact


def _simulated_browser_verifier_context(
    *,
    goal: str,
    browser_state: Dict[str, Any],
    action_entries: List[Dict[str, Any]],
    frame: Optional[Dict[str, Any]],
    payment_card_last4: Optional[str],
    user_instruction_messages: Optional[List[Dict[str, str]]] = None,
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
    context[1:1] = [{"role": "USER", "text": message["content"]} for message in user_instruction_messages or []]
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
    user_instruction_messages: Optional[List[Dict[str, str]]] = None,
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
                user_instruction_messages=user_instruction_messages,
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
    *,
    pricing_pool: str = BROWSER_USE_PRICING_POOL,
) -> List[Dict[str, Any]]:
    """Simulated twin of `build_usage_items`: same per-actual-model llm rows,
    a free World-Model-Harness service row instead of a paid browser row."""
    items = build_browser_llm_usage_items(
        total_input_tokens,
        total_output_tokens,
        model_pricing,
        usage_by_model,
        pricing_pool=pricing_pool,
    )
    items.append({"type": "service", "cost_cents": 0, "provider": "World Model Harness"})
    return items


async def _spawn_browser_agent_activity_v3_simulated(
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
    browser_pool: str = BROWSER_USE_PRICING_POOL,
) -> Dict[str, Any]:
    """Run the real browser-use policy against WMH state without creating a browser."""

    del session_id, cdp_url, is_resume, attachments
    if not output_schema:
        raise ValueError("output_schema is required for browser agent")
    structlog.contextvars.bind_contextvars(agent_id=agent_id)
    config = load_config()
    started_at = safe_time()
    resume = write_lock_resume_state or {}
    output_schema = resume.get("browser_output_schema") or output_schema
    instruction_state = dict(resume)
    task_id = str(task_id or resume.get("task_id") or f"wmh-browser-{tool_call_id}")
    instruction_state["tool_call_id"] = tool_call_id
    instruction_state["task_id"] = task_id
    browser_url = "about:blank"
    browser_state = dict(resume.get("simulated_browser_state") or {})
    action_entries = list(resume.get("simulated_action_entries") or [])
    turn_messages = list(resume.get("simulated_turn_messages") or [])
    if resume.get("approval_type") == "payment":
        _resolve_payment_card_tool_result_for_resume(
            turn_messages,
            resume.get("payment_card_refs") or {},
            resume.get("payment_card_last4"),
        )
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

    model_pricing = await get_model_pricing_with_fallback(browser_pool)
    task_prompt = build_browser_task_prompt(goal)
    dynamic_system_context = build_browser_dynamic_system_context(
        "# Simulated Browser Runtime\n"
        "Operate the stateful simulated website one concrete action per turn. Continue until the requested "
        "outcome is actually visible in state. Do not claim actions you did not take.",
        response_schema=output_schema,
    )
    rose_client = BrowserStreamingRoseClient()
    recorder: Optional[SimulatedBrowserRecorder] = None
    browser_stream: Optional[BrowserThinkingStream] = None
    resumed_unread_user_input = len(instruction_state.get("user_instruction_messages") or []) > int(instruction_state.get("delivered_user_instruction_count") or 0)
    _append_browser_user_instructions(instruction_state, turn_messages)
    instruction_state["delivered_user_instruction_count"] = len(instruction_state.get("user_instruction_messages") or [])

    async def sync_user_instructions(*, require_current_schema=False, require_confirmed_read=False) -> bool:
        nonlocal instruction_state, output_schema, dynamic_system_context
        nonlocal total_input_tokens, total_output_tokens
        previous_schema = output_schema
        instruction_state, output_schema, usages = await _sync_browser_user_instructions(
            agent_id=agent_id, goal=goal, response_schema=output_schema,
            instruction_state=instruction_state, turn_messages=turn_messages,
            require_current_schema=require_current_schema, require_confirmed_read=require_confirmed_read,
            compute_auth={
                "type": "gpt" if gpt_token else "claude", "accessToken": gpt_token or token_state.access_token,
                "accountId": gpt_account_id if gpt_token else None,
                "source": gpt_token_source if gpt_token else token_state.source,
                "poolTokenId": gpt_token_pool_id if gpt_token else token_state.pool_token_id,
                "userId": user_id, "agentId": agent_id, "rootAgentId": agent_id,
            },
        )
        if output_schema != previous_schema:
            dynamic_system_context = build_browser_dynamic_system_context(
                "# Simulated Browser Runtime\n"
                "Operate the stateful simulated website one concrete action per turn. Continue until the requested "
                "outcome is actually visible in state. Do not claim actions you did not take.",
                response_schema=output_schema,
            )
        for usage in usages:
            input_tokens = int(usage.get("prompt_tokens") or 0)
            output_tokens = int(usage.get("completion_tokens") or 0)
            total_input_tokens += input_tokens
            total_output_tokens += output_tokens
            accumulate_model_usage(
                usage_by_model, usage.get("actual_model"), input_tokens, output_tokens,
                cache_read_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
                cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
                from_fast_cache=bool(usage.get("from_fast_cache")),
                cache_sequence_id=usage.get("cache_sequence_id"),
            )

        if require_current_schema or require_confirmed_read:
            _require_browser_instruction_state(instruction_state, current_schema=require_current_schema)
        return instruction_state.get("_user_instruction_poll_confirmed") is True

    def resume_payload() -> Dict[str, Any]:
        return {key: instruction_state.get(key) for key in (
            "user_instruction_messages", "user_instruction_message_ids", "user_message_cursor", "user_message_cursor_is_task_start",
            "delivered_user_instruction_count", "schema_user_instruction_count", "browser_output_schema",
        )} | _simulated_browser_resume_payload(
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
                browser_recorder=recorder,
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

        previous_instruction_count = len(instruction_state.get("user_instruction_messages") or [])
        initial_read_confirmed = await sync_user_instructions()
        if not initial_read_confirmed and isinstance(resume.get("pending_action"), dict):
            await sync_user_instructions(require_confirmed_read=True)
        new_user_input = resumed_unread_user_input or previous_instruction_count != len(instruction_state.get("user_instruction_messages") or [])
        pending_action = None if new_user_input else resume.get("pending_action")
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
            if not await sync_user_instructions():
                await sync_user_instructions(require_confirmed_read=True)
            with contextlib.suppress(Exception):
                browser_activity_checkpoint(f"Simulated browser step {iteration}")
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
                    browser_state={},
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
                    pool=browser_pool,
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
                cache_sequence_id=usage.get("cache_sequence_id"),
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
                _append_browser_turn_messages(
                    turn_messages,
                    unified_action=action,
                    result=result,
                    tool_call_id=action_call_id,
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
                await sync_user_instructions(require_current_schema=True)
                verification_instruction_count = len(instruction_state.get("user_instruction_messages") or [])
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
                    user_instruction_messages=instruction_state.get("user_instruction_messages"),
                )
                await sync_user_instructions(require_current_schema=True)
                if (
                    verification_instruction_count != len(instruction_state.get("user_instruction_messages") or [])
                    or int(instruction_state.get("schema_user_instruction_count") or 0) < len(instruction_state.get("user_instruction_messages") or [])
                ):
                    completion_entry["verifier_superseded_by_user_feedback"] = True
                    await browser_stream.finish_tools(status="ERROR")
                    continue
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
                            goal=goal,
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
                            "browser_output_schema": output_schema,
                            "steps_taken": iteration,
                        },
                    )
                    await finalize_recording()
                    return {
                        "status": "completed",
                        "success": True,
                        "message": context_message,
                        "browser_url": redact_url_secrets(browser_url),
                        "current_url": browser_state.get("url", ""),
                        "task_id": task_id,
                        "session_id": world_model_session_id,
                        "world_model_session_id": world_model_session_id,
                        "world_model_name": world_model.world_model_name,
                        "world_model_simulated": True,
                        "simulated_browser_steps": iteration,
                        "simulated_latest_frame": latest_frame,
                        "structured_response": structured,
                        "browser_output_schema": output_schema,
                        "execution_time_ms": (safe_time() - started_at) * 1000,
                        "usage_items": _simulated_browser_usage_items(
                            total_input_tokens,
                            total_output_tokens,
                            model_pricing,
                            usage_by_model,
                            pricing_pool=browser_pool,
                        ),
                    }
                rejection = {"success": False, "score": score, "reasoning": reasoning}
                completion_entry["result"] = rejection
                _append_browser_turn_messages(
                    turn_messages,
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
    except (asyncio.CancelledError, WorkflowGenerationSealed):
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
            if isinstance(exc, BrowserInstructionUnavailableError) and browser_stream is not None:
                await browser_stream.finish_tools(status="ERROR")
        with contextlib.suppress(Exception):
            await finalize_recording()
        return {
            "status": "failed",
            "success": False,
            "error": True,
            "message": f"Simulated browser automation failed: {extract_error_message(exc)}",
            **({
                "usage_items": _simulated_browser_usage_items(
                    total_input_tokens, total_output_tokens, model_pricing,
                    usage_by_model, pricing_pool=browser_pool,
                ),
                "browser_error_type": exc.original_error_type,
                "browser_error_message": extract_error_message(exc),
                "browser_output_schema": output_schema,
                "structured_response": None,
            } if isinstance(exc, BrowserInstructionUnavailableError) else {}),
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


class _BrowserSessionPreparationCancelled(asyncio.CancelledError):
    def __init__(self, session_data: Optional[Dict[str, Any]]):
        super().__init__()
        self.session_data = session_data


async def _init_browser_session_preserving_owner(
    config: Any, user_id: str, agent_id: str, start_url: str, *, task_id: Optional[str]
) -> Dict[str, Any]:
    """Join the same bounded init request before cancellation releases its owner.

    Cancellation can arrive after backend allocation and before its credential
    preparation response. Keep that HTTP operation alive to recover the exact
    returned handle; never replay an ambiguously completed session creation.
    """
    owned_init = asyncio.create_task(
        init_browser_session(config, user_id, agent_id, start_url, task_id=task_id)
    )
    try:
        return await asyncio.shield(owned_init)
    except asyncio.CancelledError:
        while not owned_init.done():
            try:
                await asyncio.shield(owned_init)
            except asyncio.CancelledError:
                if owned_init.cancelled():
                    break
            except Exception:
                break
        session_data = None
        try:
            session_data = owned_init.result()
        except (asyncio.CancelledError, Exception) as init_error:
            logger.warning(
                "Cancelled browser preparation has no acknowledged session owner",
                agent_id=agent_id,
                task_id=task_id,
                error_type=type(init_error).__name__,
            )
        raise _BrowserSessionPreparationCancelled(session_data) from None


async def _spawn_browser_agent_activity_v3_real(
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
    browser_pool: str = BROWSER_USE_PRICING_POOL,
) -> Dict[str, Any]:
    """Browser agent activity using browser-use BrowserSession + Rose API."""
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    # Fast Mode warm demos (OAi mass-agent): never open Kernel/Steel. Live
    # sessions still hung on YouTube/Instagram navigates after decision
    # soft-complete (verify19), and the 3m FM ceiling then failed for_each
    # finalize for dozens of children (verify20). Soft-complete the tool
    # without a provider session so warm paths stay ~$0 and finish. Write-lock
    # / resume still need the live browser. Restricted to exact-match
    # fast_cache:on bench trees (test-mass-agent-run-0 / OAi demo).
    from providers.fast_cache.client import soft_complete_allowed_for_agent

    if (
        fast_mode_cache_enabled
        and not is_resume
        and not write_lock_resume_state
        and await soft_complete_allowed_for_agent(agent_id, goal)
    ):
        message = (
            "Fast Mode soft-completed browser goal without a live Kernel/Steel "
            "session; treating cached trajectory evidence as sufficient."
        )
        logger.info(
            "Fast Mode soft-completing browser without live session",
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            goal=(goal or "")[:160],
        )
        await save_browser_action_message(
            agent_id=agent_id,
            title="\u2713 Task Completed",
            task_id=task_id or tool_call_id,
            message=message,
            status=MessageStatus.FINISHED,
            action_type="task_complete",
            tool_call_id=tool_call_id,
            is_completion_message=True,
            output_schema=output_schema,
        )
        usage_by_model: Dict[str, Dict[str, int]] = {}
        accumulate_model_usage(
            usage_by_model,
            "fast-mode-soft-complete",
            0,
            0,
            from_fast_cache=True,
        )
        usage_items = build_usage_items(
            0,
            0,
            {"input_cents_per_1k": 0, "output_cents_per_1k": 0},
            0.0,
            usage_by_model,
            pricing_pool=browser_pool,
            fast_mode_cache_enabled=True,
        )
        return {
            "status": "completed",
            "success": True,
            "message": message,
            "browser_url": None,
            "task_id": task_id or tool_call_id,
            "usage_items": usage_items,
            "execution_time_ms": 0.0,
            "session_id": None,
            "structured_response": None,
            "output_files": [],
        }

    private_browser_runtime: Dict[str, Any] = {}
    if write_lock_resume_state:
        hydrated_resume = dict(await hydrate_resume_context(
            agent_id=agent_id, resume_state=write_lock_resume_state
        ))
        private_browser_runtime = hydrated_resume.pop("private_browser_runtime", {})
        if "browser_output_schema" in private_browser_runtime:
            hydrated_resume["browser_output_schema"] = private_browser_runtime["browser_output_schema"]
        write_lock_resume_state = hydrated_resume
        write_lock_resume_state["tool_call_id"] = tool_call_id
        write_lock_resume_state["task_id"] = task_id or write_lock_resume_state.get("task_id")
        if write_lock_resume_state.get("approval_type") != AUTH_ASSISTANCE_DECLINED:
            try:
                write_lock_resume_state = await _load_browser_resume_user_instructions(
                    agent_id, write_lock_resume_state
                )
                write_lock_resume_state["_user_instruction_poll_confirmed"] = True
            except WorkflowGenerationSealed:
                raise
            except Exception as error:
                write_lock_resume_state["_user_instruction_poll_confirmed"] = False
                write_lock_resume_state["_user_instruction_poll_error"] = {"type": type(error).__name__, "message": extract_error_message(error)}
                logger.warning("Browser resume instruction read failed", agent_id=agent_id,
                               error=mask_secret_values(extract_error_message(error), write_lock_resume_state.get("secret_redaction_refs")))

    from browser_tools.dom_service import ActionHistory, DOMService, browser_downloads_path_for_provider
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
    browser_download_persister: Optional[BrowserDownloadPersister] = None
    download_persister_task: Optional[asyncio.Task] = None
    interaction_layer_task: Optional[asyncio.Task] = None
    cursor_streamer: Optional[BrowserCursorRealtimeStreamer] = None
    action_history = ActionHistory()

    def _redact_activity_value(value: Any) -> Any:
        # Private hydration can precede DOM binding, and cleanup can outlive
        # its transport. Keep those boundaries under the activity's policy.
        return mask_secret_values(
            redact_current_secret_values(action_history.model_visible_value(value)),
            (write_lock_resume_state or {}).get("secret_redaction_refs"),
        )

    async def _save_browser_action_message(**kwargs: Any) -> Any:
        # Routing IDs stay exact; only user/model-visible payloads are redacted.
        trusted_credential_ref = (kwargs.get("extra_metadata") or {}).get("credential_ref")
        trusted_coordinates = (kwargs.get("auxiliary") or {}).get("coordinates")
        for key in ("title", "message", "extra_metadata", "auxiliary"):
            if key in kwargs:
                kwargs[key] = _redact_activity_value(kwargs[key])
        # Only these harness-selected bookkeeping fields bypass content masking.
        # Page result/message dictionaries never enter these metadata slots.
        metadata = kwargs.get("extra_metadata")
        if isinstance(metadata, dict) and isinstance(trusted_credential_ref, dict):
            visible_ref = metadata.get("credential_ref")
            if isinstance(visible_ref, dict):
                for key in ("kind", "id", "username", "origin"):
                    if isinstance(trusted_credential_ref.get(key), str):
                        visible_ref[key] = trusted_credential_ref[key]
        auxiliary = kwargs.get("auxiliary")
        if isinstance(auxiliary, dict) and isinstance(trusted_coordinates, dict):
            coordinates = auxiliary.get("coordinates")
            if isinstance(coordinates, dict):
                for key in ("x", "y"):
                    value = trusted_coordinates.get(key)
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                        coordinates[key] = value
        if "output_schema" in kwargs:
            kwargs["output_schema"] = _model_visible_browser_output_schema(kwargs["output_schema"], _redact_activity_value)
        return await save_browser_action_message(**kwargs)

    def _pause_continuity_state(approval_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        grant_url = resolve_site_write_lock_grant_url({
            **(approval_result or {}), "start_url": start_url,
            "visited_urls": visited_urls, "current_url": current_url,
        })
        if "{{secret:" in grant_url:
            # A model-visible product/notification URL may already be masked.
            # The exact browser destination is still private, observed state.
            grant_url = current_url
        return _browser_resume_continuity_state(
            action_history=action_history, visited_urls=visited_urls,
            verifier_checkpoints=verifier_checkpoints, browser_turn_messages=browser_turn_messages,
            reasoning_messages=reasoning_messages, action_summary=action_summary,
            auth_runtime_state=auth_runtime_state,
            response_schema=response_schema,
            schema_user_instruction_count=schema_user_instruction_count,
            user_instruction_messages=user_instruction_messages,
            user_message_cursor=user_message_cursor,
            user_message_cursor_is_task_start=bool(instruction_state.get("user_message_cursor_is_task_start")),
            user_instruction_message_ids=user_instruction_message_ids,
            private_runtime_state={
                "current_url": current_url, "auth_realm": auth_realm,
                "browser_output_schema": response_schema,
                "write_lock_approvals": dict(write_lock_approvals), "grant_url": grant_url,
                # Tilion downloads are durable in attachment storage; the
                # resumed activity (maybe on another worker) extracts them.
                "tilion_downloads": durable_tilion_downloads(session_id),
                **({"pending_action_target": approval_result["pending_action_target"]}
                   if approval_result and approval_result.get("pending_action_target") else {}),
            },
        )

    def _visible_activity_result(
        result: Dict[str, Any], *, operational_sources: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # Archive references and routing IDs remain exact protocol values.
        auth_response = result.get("auth_assistance_request")
        payment_response = result.get("payment_request")
        for key in ("current_url", "question", "write_lock_notification", "payment_request",
                    "auth_assistance_request", "write_lock_approvals", "auth_realm", "base_site",
                    "message", "structured_response", "best_effort_response",
                    "browser_error_message"):
            if key in result:
                source = (operational_sources or {}).get(key)
                if source is not None:
                    from browser_tools.control_projection import project_operational_source
                    result[key] = project_operational_source(source, _redact_activity_value)
                else:
                    result[key] = _redact_activity_value(result[key])
        observation = result.get("browser_page_observation")
        if isinstance(observation, dict):
            # Routing/phase keys remain exact protocol; only location is page data.
            result["browser_page_observation"] = {
                **observation, "origin": _redact_activity_value(observation.get("origin")),
                "path": _redact_activity_value(observation.get("path")),
            }
        # Receipt image URLs are typed text, not raster attachments. Preserve
        # only their HTTP(S) strings through the same secret-value redactor;
        # arbitrary nested media and data-image payloads remain suppressed.
        visible_payment = result.get("payment_request")
        if isinstance(payment_response, dict) and isinstance(visible_payment, dict):
            items_key = "line_items" if "line_items" in payment_response else "lineItems"
            original_items = payment_response.get(items_key)
            visible_items = visible_payment.get(items_key)
            if isinstance(original_items, list) and isinstance(visible_items, list):
                for original_item, visible_item in zip(original_items, visible_items):
                    if not isinstance(original_item, dict) or not isinstance(visible_item, dict):
                        continue
                    image_url = original_item.get("image_url")
                    if isinstance(image_url, str) and image_url.startswith(("https://", "http://")):
                        visible_item["image_url"] = _redact_activity_value(image_url)
        if "browser_output_schema" in result:
            result["browser_output_schema"] = _model_visible_browser_output_schema(
                result["browser_output_schema"], _redact_activity_value
            )
        target = result.get("pending_action_target")
        if isinstance(target, dict):
            result["pending_action_target"] = _redact_activity_value(target)
            if isinstance(target.get("index"), int) and not isinstance(target["index"], bool):
                result["pending_action_target"]["index"] = target["index"]
        if isinstance(auth_response, dict):
            request_ids = ("id", "requestId", "request_id", "attentionRequestId", "agentId", "userId",
                           "browserSessionId", "steelSessionId", "mode")
            visible_auth = result["auth_assistance_request"]
            for key in request_ids:
                if key in auth_response:
                    visible_auth[key] = auth_response[key]
            for key, protocol_keys in (("request", request_ids),
                                       ("handoff", ("type", "steelSessionId", "liveViewUrl"))):
                original = auth_response.get(key)
                if isinstance(original, dict):
                    visible_auth[key] = _redact_activity_value(original)
                    for field in protocol_keys:
                        if field in original:
                            visible_auth[key][field] = original[field]
        return result

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
    reasoning_messages: List[str] = [
        message
        for message in ((write_lock_resume_state or {}).get("reasoning_messages") or [])
        if isinstance(message, str)
    ]
    action_summary: List[str] = [
        summary
        for summary in ((write_lock_resume_state or {}).get("action_summary") or [])
        if isinstance(summary, str)
    ]
    write_lock_approvals: Dict[str, Dict] = {}
    auth_realm = auth_realm_from_url(start_url)
    verifier_checkpoints: List[Dict[str, Any]] = []
    awaiting_observation_checkpoint = False
    # Eventim checkaddtocart POST can keep returning 403 challenge HTML while the
    # document GET looks clean — cookie-stage recovery then false-succeeds forever.
    # After one cookies_sanitized result, escalate subsequent recoveries to config search.
    cookie_recovery_successes = 0
    # Sticky hard filter: once a critical third-party resource block triggered
    # recovery on this task, later recoveries still re-verify that URL.
    require_payment_cdn = False
    payment_cdn_verify_url = ""

    pending_write_lock_action: Optional[Dict[str, Any]] = None
    pending_write_lock_target: Optional[Dict[str, Any]] = None
    resume_step_count: int = 0
    auth_assistance_resume_mode: Optional[str] = None
    payment_card_last4: Optional[str] = None
    if write_lock_resume_state:
        has_new_user_input = len(write_lock_resume_state.get("user_instruction_messages") or []) > int(
            write_lock_resume_state.get("delivered_user_instruction_count") or 0
        )
        # An approved queued action predates this input. The actor must decide
        # what to do after reading it, even when write permission remains valid.
        if not has_new_user_input:
            pending_write_lock_action = write_lock_resume_state.get("pending_action")
            pending_write_lock_target = (private_browser_runtime.get("pending_action_target")
                                         or write_lock_resume_state.get("pending_action_target"))
        write_lock_approvals = dict(private_browser_runtime.get("write_lock_approvals")
                                    or write_lock_resume_state.get("write_lock_approvals") or {})
        resume_step_count = write_lock_resume_state.get("step_count", 0)
        session_id = write_lock_resume_state.get("session_id") or session_id
        cdp_url = write_lock_resume_state.get("cdp_url") or cdp_url
        auth_realm = private_browser_runtime.get("auth_realm") or write_lock_resume_state.get("auth_realm") or auth_realm
        current_url = str(private_browser_runtime.get("current_url") or "")
        approved_at = write_lock_resume_state.get("write_lock_approved_at")
        grant_url = private_browser_runtime.get("grant_url")
        if grant_url and isinstance(approved_at, (int, float)):
            if write_lock_resume_state.get("approval_type") == "payment":
                write_lock_approvals = grant_site_write_lock_approvals(write_lock_approvals, grant_url, approved_at)
            elif write_lock_resume_state.get("pending_action"):
                write_lock_approvals = apply_user_write_lock_grant(
                    write_lock_approvals, write_lock_resume_state.get("approval_type", "unknown"),
                    grant_url, approved_at,
                )
        payment_card_last4 = _normalize_payment_card_last4(write_lock_resume_state.get("payment_card_last4"))
        # Belt-and-suspenders: older resume payloads may still carry awaiting tool
        # rows if they were parked before finalize-on-mint shipped.
        if write_lock_resume_state.get("approval_type") == "payment" and (
            write_lock_resume_state.get("payment_card_refs") or payment_card_last4
        ):
            finalize_parked_payment_card_approval_history(
                write_lock_resume_state,
                last4=payment_card_last4,
            )
        action_history.restore_entries(write_lock_resume_state.get("action_history"))
        visited_urls = [
            str(url) for url in (write_lock_resume_state.get("visited_urls") or []) if isinstance(url, str) and url
        ]

        verifier_checkpoints = [
            checkpoint
            for checkpoint in (write_lock_resume_state.get("verifier_checkpoints") or [])
            if isinstance(checkpoint, dict) and checkpoint.get("dom_tree")
        ]
        # H-06 heal: payment-card resume must unlock the merchant domain. Older
        # grants keyed Kernel live-view hosts (*.kernel.sh / *.onkernel.com);
        # re-resolve from start_url / visited merchant URLs when needed.
        if write_lock_resume_state.get("approval_type") == "payment" and (
            write_lock_resume_state.get("payment_card_refs") or payment_card_last4
        ):
            merchant_grant_url = private_browser_runtime.get("grant_url") or resolve_site_write_lock_grant_url(
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
                    grant_url=_redact_activity_value(merchant_grant_url),
                    unlock_domain=_redact_activity_value(merchant_domain),
                    prior_domain=_redact_activity_value(site_entry.get("domain")),
                )
        logger.info(
            "Resuming from write lock approval",
            has_pending_action=pending_write_lock_action is not None,
            approval_type=write_lock_resume_state.get("approval_type"),
            step_count=resume_step_count,
        )

    response_schema = (write_lock_resume_state or {}).get("browser_output_schema") or output_schema
    if not response_schema:
        raise ValueError(
            "output_schema is required for browser agent - parent agent must provide structured output schema in tool call"
        )
    schema_user_instruction_count = int((write_lock_resume_state or {}).get("schema_user_instruction_count") or 0)

    logger.info(
        "Using response schema from tool call",
        fields=len(response_schema.get("fields", [])),
    )

    session_passwords: List[Dict[str, Any]] = []
    session_passkeys: List[Dict[str, Any]] = []
    session_auth_options: Optional[Dict[str, Any]] = None
    session_credential_ref: Optional[Dict[str, Any]] = None
    browser_session_metadata: Dict[str, Any] = {}
    preparation_cancellation: Optional[Dict[str, Any]] = None

    # Decouple the Temporal heartbeat from the browser event loop. A
    # bot-challenge can freeze CDP for 90-260s (agent 9ec05898), and concurrent
    # screenshot/DOM work can starve the asyncio loop itself (agent 37b7bb31):
    # an asyncio keepalive then dies with the work it was meant to outlive.
    # A process-local thread pump heartbeats every registered activity context.
    _heartbeat_token = start_browser_activity_heartbeat()
    action_entries: List[Dict[str, Any]] = []
    browser_turn_messages: List[Dict[str, Any]] = [
        message
        for message in ((write_lock_resume_state or {}).get("browser_turn_messages") or [])
        if isinstance(message, dict)
    ]
    if (write_lock_resume_state or {}).get("approval_type") == "payment":
        _resolve_payment_card_tool_result_for_resume(
            browser_turn_messages,
            (write_lock_resume_state or {}).get("payment_card_refs") or {},
            payment_card_last4,
        )
    otp_user_messages: List[Dict[str, str]] = []
    # The background OTP poll writes here, not into credential_refs_by_secret_ref,
    # because a realm transition rebinds that dict while a poll is in flight.
    otp_credential_refs: Dict[str, Dict[str, str]] = {}
    seen_otp_codes: set[str] = set()
    pending_otp_ref_messages: Dict[tuple[str, str, str], str] = {}
    generation_sealed = False
    locally_owned_recorders: List[Any] = []
    otp_task_started_monotonic = time.monotonic()
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
        # Read-only. Do NOT re-seed / rebuild the virtual authenticator here.
        # Agent f380ca3c (browser-amazon-return 2026-09-28): syncing before every
        # usage poll ran ~3s after Sign-in-with-Passkey clicks, called
        # WebAuthn.enable + addVirtualAuthenticator mid-ceremony, and surfaced
        # Amazon's "No passkeys available for amazon.com on this device" dialog
        # despite a healthy pre-click seed — burning ~5 minutes of the 665s cap
        # before the return write_lock. Pre-action
        # ensure_browser_overlays_suppressed() already re-arms before
        # ceremony-capable clicks/typing; usage readback must not race that.
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

        Navigation / proxy-rotation boundaries MUST force-rebuild: Kernel can leave
        ``WebAuthn.getCredentials`` succeeding briefly after a nav while the
        virtual-authenticator environment is already dying. Agents f380ca3c /
        c3b1ca09 (browser-amazon-return 2026-09-28): ``after start navigation``
        logged ``seeded 0`` (health check trusted the stale id), then ~5–6s later
        ``environment has not been enabled`` — Amazon's sign-in page probed an
        empty authenticator, disabled the passkey CTA, and burned the write_lock
        budget on password fallback. Invalidate before those syncs so we always
        re-enable + re-seed rather than trust a dying health check.
        """
        if dom_service is None:
            return 0
        for pk in new_passkeys or []:
            credential_id = pk.get("credentialId")
            if credential_id:
                seeded_decrypted_passkeys_by_credential_id[credential_id] = pk
        if not seeded_decrypted_passkeys_by_credential_id:
            return 0
        # Known target-boundary contexts: never trust cached authenticator health.
        if context in ("after start navigation", "after proxy rotation"):
            await dom_service.invalidate_passkey_state_for_live_target()
        injected = await dom_service.inject_passkeys(list(seeded_decrypted_passkeys_by_credential_id.values()))
        logger.info(
            "Seeded cloud-custody passkeys onto browser virtual authenticator",
            count=injected,
            held=len(seeded_decrypted_passkeys_by_credential_id),
            context=context,
        )
        return injected

    # Pause-for-resume returns (write / payment / auth assistance) still run
    # ``finally`` teardown, but must NOT emit task_complete — the browser task
    # resumes in a later activity call and the FE chip must stay open.
    browser_task_paused_for_resume = False
    otp_poll_task: Optional["asyncio.Task[int]"] = None
    cleanup_failure: Optional[Dict[str, Any]] = None

    async def _close_browser_with_cleanup_receipt(
        exact_session_id: str, pause: bool = False, current_url: str = ""
    ) -> None:
        nonlocal cleanup_failure
        try:
            options = {"pause": pause}
            if current_url:
                options["current_url"] = current_url
            await close_browser_session(config, exact_session_id, **options)
        except BrowserSessionCloseError as cleanup_error:
            cleanup_failure = cleanup_error.receipt()
        except asyncio.CancelledError:
            cleanup_failure = BrowserSessionCloseError(exact_session_id, pause).receipt()
            raise
    state_prefetch = BrowserStatePrefetch()
    # Bind before browser/event-bus tasks start; their inherited policy is
    # updated in place as private bindings are hydrated or realms change.
    _secret_log_scope = secret_logging_context((write_lock_resume_state or {}).get("secret_redaction_refs"), fresh=True)
    _secret_log_scope.__enter__()

    try:
        response_schema, schema_usage = await _refresh_browser_output_schema(
            goal=goal,
            agent_id=agent_id,
            response_schema=response_schema,
            resume_state=write_lock_resume_state,
            compute_auth={
                "type": "gpt" if gpt_token else "claude",
                "accessToken": gpt_token or token_state.access_token,
                "accountId": gpt_account_id if gpt_token else None,
                "source": gpt_token_source if gpt_token else token_state.source,
                "poolTokenId": gpt_token_pool_id if gpt_token else token_state.pool_token_id,
                "userId": user_id,
                "agentId": agent_id,
                "rootAgentId": agent_id,
            },
        )
        schema_user_instruction_count = int((write_lock_resume_state or {}).get("schema_user_instruction_count") or 0)
        schema_input_tokens = int(schema_usage.get("prompt_tokens") or 0)
        schema_output_tokens = int(schema_usage.get("completion_tokens") or 0)
        total_input_tokens += schema_input_tokens
        total_output_tokens += schema_output_tokens
        if schema_usage:
            accumulate_model_usage(
                usage_by_model, schema_usage.get("actual_model"), schema_input_tokens, schema_output_tokens,
                cache_read_input_tokens=int(schema_usage.get("cache_read_input_tokens") or 0),
                cache_creation_input_tokens=int(schema_usage.get("cache_creation_input_tokens") or 0),
                from_fast_cache=bool(schema_usage.get("from_fast_cache")),
                cache_sequence_id=schema_usage.get("cache_sequence_id"),
            )

        if (write_lock_resume_state or {}).get("approval_type") == AUTH_ASSISTANCE_DECLINED:
            # The user said no, so nothing is left to try. Release the browser
            # that was kept alive for them and end the task; ``finally`` posts
            # the terminal event that closes the FE chip.
            declined_session_id = (write_lock_resume_state or {}).get("session_id") or session_id
            # The handoff may have replaced the provider session while the task
            # was paused; close the task's current session, not just the saved id.
            try:
                current = await fetch_session_info(config, task_id)
                declined_session_id = str(current.get("session_id") or declined_session_id or "")
            except WorkflowGenerationSealed:
                raise
            except Exception as lookup_error:
                logger.warning(
                    "Could not look up the declined task's current session; closing the saved one",
                    task_id=task_id,
                    error=str(lookup_error),
                )
            if declined_session_id:
                await _close_browser_with_cleanup_receipt(declined_session_id, pause=False)
            logger.info("User declined auth assistance; ending browser task", task_id=task_id)
            return _visible_activity_result({
                "status": "completed",
                "success": False,
                "user_declined_auth": True,
                **({"browser_cleanup": cleanup_failure} if cleanup_failure else {}),
                "message": f"User declined to sign in to {auth_realm or 'the site'}.",
                "browser_url": redact_url_secrets(browser_url),
                "task_id": task_id,
                "usage_items": [],
                "execution_time_ms": 0,
                "session_id": declined_session_id,
                "structured_response": None,
                "output_files": [],
            })

        # ===== SETUP TIMING TRACKER =====
        setup_origin = time.monotonic()
        timing_events: list[tuple[str, float, float]] = []

        def _record_timing(name: str, start: float, end: Optional[float] = None):
            if end is None:
                end = time.monotonic()
            timing_events.append((name, (start - setup_origin) * 1000, (end - setup_origin) * 1000))

        # ===== PHASE 1: SESSION INIT =====
        t_session = time.monotonic()
        session_worker_apply: Optional[Dict[str, Any]] = None
        session_exit_geo_locale: Optional[Dict[str, Any]] = None
        # Tilion bills 2 credits per session create; count this activity's creates
        # (initial, replacement on resume, rotation/recovery) for the cost row.
        tilion_creates = {"count": 0}
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
        reused_session_deadline: Optional[Tuple[str, float]] = None
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
                        browser_activity_checkpoint(f"Waiting to resume browser availability ({int(_elapsed)}s)")
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
                        browser_activity_checkpoint(f"Waiting to resume browser availability ({int(_elapsed)}s)")
                        await asyncio.sleep(SESSION_RETRY_INTERVAL_SECONDS)
                    session_info["resume_mode"] = "new_steel_session_after_unavailable"
                    session_info["same_session_unavailable_reason"] = unavailable_reason
            session_id = session_info.get("session_id")
            reused_session_deadline = _reused_session_deadline(session_info)
            browser_url = session_info.get("debug_url")
            cdp_url = session_info.get("ws_url")
            fingerprint_injection = session_info.get("fingerprint_injection")
            session_passwords = session_info.get("passwords", [])
            session_passkeys = session_info.get("passkeys", [])
            session_auth_options = session_info.get("auth_options")
            session_worker_apply = tilion_worker_apply_payload(session_info)
            session_exit_geo_locale = session_info.get("exit_geo_locale")
            session_credential_ref = session_info.get("credential_ref") or session_info.get("auth_credential_ref")
            browser_session_metadata = session_info.get("browser_session_metadata") or {}
            if browser_session_metadata.get("provider") == "tilion" and bool(session_info.get("resume_mode")):
                # A replacement session was created; a same-session resume was not.
                tilion_creates["count"] += 1
            user_profile, auth_realm = _resume_context_from_session_info(session_info, auth_realm)
            browser_activity_checkpoint(f"Resuming task {task_id}")
        else:
            browser_activity_checkpoint("Initializing browser session")
            _session_wait_start = time.monotonic()
            _waiting_msg_sent = False
            _transient_init_attempts = 0

            while True:
                session_data = await _init_browser_session_preserving_owner(
                    config,
                    user_id,
                    agent_id,
                    start_url,
                    task_id=task_id,
                )

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
                    browser_activity_checkpoint(
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
                    await _save_browser_action_message(
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
                browser_activity_checkpoint(f"Waiting for browser availability ({int(_elapsed)}s)")
                await asyncio.sleep(SESSION_RETRY_INTERVAL_SECONDS)

            task_id = session_data["task_id"]
            session_id = session_data["session_id"]
            browser_url = session_data["debug_url"]
            cdp_url = session_data.get("ws_url")
            fingerprint_injection = session_data.get("fingerprint_injection")
            session_passwords = session_data.get("passwords", [])
            session_passkeys = session_data.get("passkeys", [])
            session_auth_options = session_data.get("auth_options")
            session_worker_apply = tilion_worker_apply_payload(session_data)
            session_exit_geo_locale = session_data.get("exit_geo_locale")
            session_credential_ref = session_data.get("credential_ref") or session_data.get("auth_credential_ref")
            browser_session_metadata = session_data.get("browser_session_metadata") or {}
            if browser_session_metadata.get("provider") == "tilion":
                tilion_creates["count"] += 1
            user_profile = session_data.get("user_settings") or {}
        _record_timing("session_init", t_session)
        # Durable Tilion downloads from before a write-lock/payment/auth pause,
        # keyed by the session this activity actually runs on.
        restore_tilion_downloads(session_id, private_browser_runtime.get("tilion_downloads"))

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

        browser_activity_checkpoint(f"Connecting via CDP: {redact_cdp_url(cdp_url)[:50]}...")

        # ===== PHASE 2: PARALLEL SETUP =====
        t_parallel = time.monotonic()

        async def _setup_browser():
            """Connect DOMService + Playwright, apply fingerprint, init humanizer."""
            nonlocal playwright_driver_pid
            _disable_cdp_websocket_proxy()
            # Tilion admits one CDP client: browser-use and Playwright share one
            # loopback-multiplexed socket owned (and closed) by the DOMService.
            connection_cdp_url, _cdp_multiplexer = await open_browser_cdp_connection(
                cdp_url,
                label=f"session:{agent_id}",
                refresh_url=_fresh_connect_url_minter(config, task_id),
                # Tilion stays on New York/en-US whatever the exit geo; the
                # multiplexer applies the session's timezone/locale to every
                # target before it runs, including after a redial.
                emulation=tilion_emulation(fingerprint_injection, session_exit_geo_locale),
            )
            _dom_service = DOMService(
                cdp_url=connection_cdp_url,
                downloads_path=browser_downloads_path_for_provider(
                    browser_session_metadata.get("provider")
                ),
                **_cdp_multiplexer_kwargs(_cdp_multiplexer),
            )
            if hasattr(_dom_service, "restore_secret_redaction_state"):
                _dom_service.restore_secret_redaction_state(write_lock_resume_state or {})
                if (
                    is_resume
                    and "secret_values_used" not in (write_lock_resume_state or {})
                    and (write_lock_resume_state or {}).get("payment_card_refs")
                ):
                    _dom_service.mark_secret_used()
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
                await _save_browser_action_message(
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
                await _save_browser_action_message(
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
            _secret_refs.update(_realm_credential_state.password_secret_refs)
            register_logging_secret_refs(_secret_refs)

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
            _base_custom_instructions = _user_context_section
            _model_pricing = await get_model_pricing_with_fallback(browser_pool)
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
        from browser_tools.captcha_solve_indicator import start_captcha_telemetry_indicator_for_task

        start_captcha_telemetry_indicator_for_task(
            dom_service,
            fetch_telemetry=fetch_browser_captcha_telemetry,
            config=config,
            task_id=task_id,
        )
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
            # Fast Mode warm demos: skip CDP Network.enable capture. YouTube /
            # Instagram navigations flood the recorder and stall the activity
            # for tens of minutes while every LLM decision was already a cache
            # hit (verify19 Huberman hang).
            if skip_browser_network_recording(fast_mode=fast_mode_cache_enabled, goal=goal):
                return None
            if fast_mode_cache_enabled:
                from providers.fast_cache.client import soft_complete_allowed_for_agent

                if await soft_complete_allowed_for_agent(agent_id, goal):
                    return None
            if not recording_output_dir:
                return None
            recorder = await BrowserNetworkRecorder.create(
                browser_session=dom_service.session,
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
                output_dir=recording_output_dir,
                register_local_owner=locally_owned_recorders.append,
            )
            if recorder and recorder.persists_network_log and task_id:
                await _save_browser_action_message(
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

        async def _create_download_persister():
            # Kernel CDP downloads_path alone does not always yield listFiles entries;
            # listen for Chrome Browser.download* events and materialize only those.
            # Pass the per-session provider (not BROWSER_PROVIDER env) so Steel
            # sessions get /files + omit-directory upload semantics.
            return await BrowserDownloadPersister.create(
                browser_session=dom_service.session,
                session_id=session_id,
                config=config,
                user_id=user_id,
                agent_id=agent_id,
                task_id=task_id or "",
                provider=browser_session_metadata.get("provider"),
            )

        download_persister_task = asyncio.create_task(_create_download_persister())

        async def _init_humanizer():
            if not _env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True):
                logger.info("\U0001f916 BrowserHumanizer disabled by env; using browser-use input events")
                return None
            _humanizer = BrowserHumanizer(
                dom_page=dom_page,
                input_page=input_page,
                fast=False,
                # Tilion drops pipelined Input.dispatchKeyEvent commands.
                serial_cdp_keyboard=is_single_cdp_client_provider(browser_session_metadata.get("provider")),
            )
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
                    register_local_owner=locally_owned_recorders.append,
                ),
                _apply_logo_hijack(dom_service),
            )
            _record_timing("humanizer_recorders_logo", t)
            cursor_streamer = BrowserCursorRealtimeStreamer(agent_id=agent_id, task_id=task_id)

            if humanizer:
                humanizer.set_cursor_observer(observe_cursor)
                humanizer.start_idle_movement()
            if browser_recorder and task_id:
                await _save_browser_action_message(
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

        if hasattr(dom_service, "register_secret_refs"):
            dom_service.restore_secret_redaction_state(write_lock_resume_state or {})
            dom_service.register_secret_refs(secret_refs)
            if is_resume and "secret_values_used" not in (write_lock_resume_state or {}) and secret_refs:
                # Legacy paused sessions predate usage tracking and may already
                # contain entered/autofilled credentials. Fail closed on pixels.
                dom_service.mark_secret_used()
            action_history.bind_dom_service(dom_service)
            # Restore happened before credentials were decrypted. Sanitize the
            # complete histories now, before persistence, logging or a model call.
            action_history.restore_entries(action_history.get_entries())
            browser_turn_messages[:] = _model_visible_browser_turn_messages(
                browser_turn_messages, dom_service.model_visible_value,
                secret_values_used=dom_service.secret_values_used,
                action_result_redact=getattr(dom_service, "model_visible_action_result", None),
            )
            verifier_checkpoints[:] = dom_service.model_visible_value(verifier_checkpoints)
            reasoning_messages[:] = dom_service.model_visible_value(reasoning_messages)
            action_summary[:] = dom_service.model_visible_value(action_summary)

        # Use the same fail-closed worker hydration path at session start and
        # on every later realm transition.
        auth_options = initial_realm_credential_state.auth_options
        auth_runtime_state = initial_realm_credential_state.auth_runtime_state
        if (
            write_lock_resume_state
            and write_lock_resume_state.get("auth_realm") == auth_realm
            and write_lock_resume_state.get("approval_type") != "auth_assistance"
        ):
            _restore_browser_auth_attempts(
                auth_runtime_state, write_lock_resume_state.get("auth_attempts")
            )
        passkey_ref_by_credential_id.update(initial_realm_credential_state.passkey_ref_by_credential_id)
        if initial_realm_credential_state.decrypted_passkeys:
            await sync_passkeys_onto_target(
                initial_realm_credential_state.decrypted_passkeys,
                context="session start",
            )

        # ===== PHASE 3: POST-SETUP =====
        t_post = time.monotonic()

        if session_worker_apply:
            # Tilion: the backend returned saved state instead of connecting to
            # the browser this worker holds; apply it over the worker's socket.
            await apply_tilion_worker_state(playwright_browser, session_worker_apply)

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

                    browser_activity_checkpoint(f"Downloading {filename}...")
                    file_content = await download_from_storage(storage_path)

                    browser_activity_checkpoint(f"Uploading {filename} to browser session...")
                    if getattr(dom_service, "single_cdp_client", False) is True:
                        # Tilion: the backend cannot reach the browser while the
                        # worker holds CDP; upload_file sets these bytes itself.
                        upload_result = stage_tilion_upload(
                            session_id,
                            filename,
                            file_content,
                            fp.get("mime_type", "application/octet-stream"),
                        )
                    else:
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

            start_url_nav_error: Optional[BaseException] = None

            async def _navigate_to_start_url():
                nonlocal start_url_nav_error
                t = time.monotonic()
                try:
                    event = dom_service.session.event_bus.dispatch(
                        NavigateToUrlEvent(url=nav_url, wait_until="commit")
                    )
                    await event
                    await event.event_result(raise_if_any=True, raise_if_none=False)
                    ready_state = await _wait_for_document_ready(dom_service)
                    logger.info(f"\U0001f310 Start URL readiness: {ready_state}")
                except Exception as nav_exc:
                    # Do not kill the whole browser activity on start_url
                    # navigate failure. A tool ERROR here caused the root agent
                    # to re-spawn with Fandango after an AMC 20s CDP timeout
                    # (browser-event-ticket, 2026-08-20). Keep the session and
                    # let the agent loop retry navigation. Do not catch
                    # CancelledError/BaseException — activity cancellation must
                    # still abort.
                    start_url_nav_error = nav_exc
                    logger.error(
                        "Start URL navigation failed (continuing into agent loop): %s",
                        nav_exc,
                    )
                _record_timing("navigation.navigate", t)

            # The "Navigating" progress message is pure bookkeeping \u2014 write it
            # while the navigation is already underway.
            await asyncio.gather(
                _navigate_to_start_url(),
                _save_browser_action_message(
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

            if start_url_nav_error is None:

                async def _mark_navigated():
                    if browser_recorder:
                        await browser_recorder.mark(f"Navigated -> {nav_url[:80]}", action="goto")

                async def _wait_for_start_url_ready():
                    t = time.monotonic()
                    await wait_for_navigation_ready(dom_service, url=nav_url)
                    _record_timing("navigation.wait_ready", t)

                await asyncio.gather(
                    _wait_for_start_url_ready(),
                    _save_browser_action_message(
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
            else:
                await _save_browser_action_message(
                    agent_id=agent_id,
                    title=f"Start URL navigate deferred \u2192 {nav_url[:40]}",
                    task_id=task_id,
                    message=(
                        f"Initial navigation to {nav_url} failed "
                        f"({type(start_url_nav_error).__name__}: {start_url_nav_error}). "
                        f"Configured Page.navigate budget="
                        f"{NAVIGATE_TO_URL_TIMEOUT_SECONDS}s; continuing so the "
                        f"agent can retry without a tool ERROR."
                    ),
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url,
                    action_type="goto",
                    tool_call_id=tool_call_id,
                    steps_taken=0,
                    total_steps=MAX_ITERATIONS,
                )
                logger.warning(
                    "Continuing browser agent after start URL navigate failure "
                    "(budget=%ss): %s",
                    NAVIGATE_TO_URL_TIMEOUT_SECONDS,
                    start_url_nav_error,
                )

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
        user_instruction_messages = _append_browser_user_instructions(
            write_lock_resume_state, browser_turn_messages
        )
        user_message_cursor = (write_lock_resume_state or {}).get("user_message_cursor")
        user_instruction_message_ids = list((write_lock_resume_state or {}).get("user_instruction_message_ids") or [])
        otp_history_count = 0
        supervisor_recovery_count = 0
        failed_steel_auth_recovery_ids: set[str] = set()
        task_prompt = build_browser_task_prompt(goal)
        dynamic_system_context = build_browser_dynamic_system_context(
            base_custom_instructions,
            available_files=(list(available_file_paths.keys()) if available_file_paths else None),
            response_schema=response_schema,
        )
        instruction_state = {
            **(write_lock_resume_state or {}),
            "user_instruction_messages": user_instruction_messages,
            "tool_call_id": tool_call_id,
            "user_message_cursor": user_message_cursor,
            "user_message_cursor_is_task_start": bool((write_lock_resume_state or {}).get("user_message_cursor_is_task_start")),
            "task_id": task_id,
            "user_instruction_message_ids": user_instruction_message_ids,
            "delivered_user_instruction_count": len(user_instruction_messages),
            "schema_user_instruction_count": schema_user_instruction_count,
            "schema_attempted_user_instruction_count": len(user_instruction_messages),
        }

        async def sync_user_instructions(*, require_current_schema=False, require_confirmed_read=False) -> bool:
            nonlocal instruction_state, response_schema, user_instruction_messages
            nonlocal user_message_cursor, user_instruction_message_ids, dynamic_system_context
            nonlocal latest_structured_response, total_input_tokens, total_output_tokens
            nonlocal pending_write_lock_action, pending_write_lock_target, schema_user_instruction_count
            previous_count = len(user_instruction_messages)
            previous_schema = response_schema
            instruction_state, response_schema, usages = await _sync_browser_user_instructions(
                agent_id=agent_id, goal=goal, response_schema=response_schema,
                instruction_state=instruction_state, turn_messages=browser_turn_messages,
                require_current_schema=require_current_schema, require_confirmed_read=require_confirmed_read,
                compute_auth={
                    "type": "gpt" if gpt_token else "claude",
                    "accessToken": gpt_token or token_state.access_token,
                    "accountId": gpt_account_id if gpt_token else None,
                    "source": gpt_token_source if gpt_token else token_state.source,
                    "poolTokenId": gpt_token_pool_id if gpt_token else token_state.pool_token_id,
                    "userId": user_id, "agentId": agent_id, "rootAgentId": agent_id,
                },
            )
            user_instruction_messages = instruction_state["user_instruction_messages"]
            user_message_cursor = instruction_state["user_message_cursor"]
            user_instruction_message_ids = instruction_state["user_instruction_message_ids"]
            schema_user_instruction_count = int(instruction_state.get("schema_user_instruction_count") or 0)
            if len(user_instruction_messages) != previous_count:
                latest_structured_response = None
                pending_write_lock_action = None
                pending_write_lock_target = None
            if response_schema != previous_schema:
                dynamic_system_context = build_browser_dynamic_system_context(
                    base_custom_instructions,
                    available_files=(list(available_file_paths.keys()) if available_file_paths else None),
                    response_schema=response_schema,
                )
            for usage in usages:
                input_tokens = int(usage.get("prompt_tokens") or 0)
                output_tokens = int(usage.get("completion_tokens") or 0)
                total_input_tokens += input_tokens
                total_output_tokens += output_tokens
                accumulate_model_usage(
                    usage_by_model, usage.get("actual_model"), input_tokens, output_tokens,
                    cache_read_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
                    cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
                    from_fast_cache=bool(usage.get("from_fast_cache")),
                    cache_sequence_id=usage.get("cache_sequence_id"),
                )

            if require_current_schema or require_confirmed_read:
                _require_browser_instruction_state(instruction_state, current_schema=require_current_schema)
            return instruction_state.get("_user_instruction_poll_confirmed") is True

        if (
            (write_lock_resume_state or {}).get("approval_type") == "payment"
            and (write_lock_resume_state or {}).get("pending_action") is None
            and (write_lock_resume_state or {}).get("payment_card_refs")
        ):
            if not _complete_pending_payment_card_result(
                browser_turn_messages, action_history, last4=payment_card_last4, card_refs=card_refs
            ):
                raise RuntimeError("Approved payment card has no pending browser tool result to complete")
        failed_credential_prep_realms: Dict[str, str] = {}
        credential_preparation_error: Optional[str] = None
        pending_credential_reload_realm: Optional[str] = None
        action_redaction_refs: Optional[List[Dict[str, str]]] = None

        def _credential_binding() -> tuple:
            ref = session_credential_ref or {}
            return (session_id, ref.get("kind"), ref.get("id"))

        active_credential_binding = _credential_binding()

        def _activate_realm_credentials(realm_state: Any, payload: Dict[str, Any]) -> None:
            nonlocal active_credential_binding
            nonlocal auth_realm
            nonlocal auth_options
            nonlocal auth_options_section
            nonlocal auth_runtime_state
            nonlocal credential_refs_by_secret_ref
            nonlocal credential_preparation_error
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
            if hasattr(dom_service, "register_secret_refs"):
                dom_service.register_secret_refs(secret_refs)
            if action_redaction_refs is not None:
                action_redaction_refs.append(dict(secret_refs))
            session_passwords = list(payload.get("passwords") or [])
            session_passkeys = list(payload.get("passkeys") or [])
            session_credential_ref = realm_state.auth_credential_ref
            credential_preparation_error = payload.get("credential_preparation_error")
            active_credential_binding = _credential_binding()

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


        async def _prepare_credentials_for_url_unquarantined(
            target_url: str,
        ) -> Optional[Dict[str, Any]]:
            """Atomically activate every saved credential type for a new realm."""
            target_realm = auth_realm_from_url(target_url)
            if not target_realm:
                return None
            if not session_id:
                raise RuntimeError(f"Cannot prepare credentials for {target_realm} without a browser session")

            browser_activity_checkpoint(f"Preparing saved credentials for {target_realm}")
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
            realm_worker_apply = tilion_worker_apply_payload(payload)
            if realm_worker_apply:
                await apply_tilion_worker_state(playwright_browser, realm_worker_apply)
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

            _activate_realm_credentials(realm_state, payload)

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
            summary = {
                "auth_realm": auth_realm,
                "cookies_injected": payload.get("cookies_injected"),
                "password_count": len(realm_state.password_secret_refs),
                "passkey_count": len(realm_state.decrypted_passkeys),
                "passkeys_newly_injected": injected_passkey_count,
            }
            if payload.get("credential_preparation_error"):
                summary["credential_preparation_error"] = payload["credential_preparation_error"]
                logger.warning(
                    "Activated realm credentials after browser-state restoration failed",
                    auth_realm=auth_realm,
                    error=payload["credential_preparation_error"],
                )
            return summary

        async def _prepare_credentials_for_url(target_url: str) -> Optional[Dict[str, Any]]:
            previous_auth_realm = auth_realm
            if _credential_binding() != active_credential_binding:
                # A replaced browser or selected credential invalidates both
                # inventory reuse and the previous session's quarantine.
                previous_auth_realm = ""
                failed_credential_prep_realms.clear()
            target_realm = auth_realm_from_url(target_url)
            if target_realm != previous_auth_realm and not auth_realm_matches_url(previous_auth_realm, target_url):
                # Invalidate unrelated context before discovery, including a
                # return to a quarantined realm. Missing inventory is unknown.
                _activate_realm_credentials(unknown_realm_credential_state(target_realm), {})
            return await prepare_optional_realm_credentials(
                target_url=target_url,
                current_auth_realm=previous_auth_realm,
                failed_realms=failed_credential_prep_realms,
                prepare_credentials=_prepare_credentials_for_url_unquarantined,
            )

        async def _auth_context_for_url(observed_url: str) -> Dict[str, Any]:
            """Publish only safe inventory for an actual browser tool observation."""
            nonlocal pending_credential_reload_realm
            realm = auth_realm_from_url(observed_url)
            realm_changed = bool(realm and not auth_realm_matches_url(auth_realm, observed_url))
            prepared = await _prepare_credentials_for_url(observed_url)
            if realm_changed and prepared is not None and not prepared.get("credential_preparation_error"):
                pending_credential_reload_realm = auth_realm
            if not realm:
                # Non-web pages have no authentication inventory. In particular,
                # about:blank must not inherit another tab's realm.
                return {"auth_realm": "", "inventory_status": "not_applicable"}
            context: Dict[str, Any] = {
                "auth_realm": auth_realm if auth_options_section else realm,
                "inventory_status": "available" if auth_options_section else "unknown",
            }
            if auth_options_section:
                context["auth_options"] = auth_options_section
            error = credential_preparation_error or failed_credential_prep_realms.get(realm)
            if error:
                context["credential_preparation_error"] = error
            return context

        async def _execute_action(*args: Any, **kwargs: Any) -> Dict[str, Any]:
            """Observe every real action and retain its secrets through redaction."""
            nonlocal action_redaction_refs
            redaction_refs = [dict(secret_refs)]
            action_redaction_refs = redaction_refs
            kwargs["auth_context_for_url"] = _auth_context_for_url
            successful_secret_refs: set[str] = set()
            kwargs["successful_secret_refs"] = successful_secret_refs
            # A tool may navigate or refresh the active realm while executing.
            # Persist the password for the page authorized at resolution time.
            credential_url = kwargs.get("current_url") or current_url
            try:
                before_actions = len(action_history)
                result = await execute_action(*args, **kwargs)
                if len(action_history) > before_actions:
                    result["action_step"] = action_history.last_action_step()
                if MINTED_NEW_PASSWORD_REF in successful_secret_refs and credential_url:
                    try:
                        await save_minted_account_password(config, user_id, credential_url)
                    except Exception as save_error:
                        logger.warning(
                            "Failed to save minted account password",
                            agent_id=agent_id,
                            task_id=task_id,
                            error=_redact_activity_value(extract_error_message(save_error)),
                        )
                # Ref names can collide across realms. Keep each binding's
                # values until this result is safe to log, persist, and submit.
                if hasattr(dom_service, "model_visible_action_result"):
                    action = kwargs.get("action") or (args[2] if len(args) > 2 else {})
                    from browser_tools.control_projection import retain_operational_source
                    result = retain_operational_source(
                        result, dom_service.model_visible_action_result(action.get("action", ""), result),
                    )
                else:
                    for refs in redaction_refs:
                        result = mask_secret_values(result, refs)
                return result
            finally:
                action_redaction_refs = None

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
            browser_activity_checkpoint(f"Step {iteration} - browser supervisor recovery: {reason}")
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

        observe_page_state: Dict[str, Any] = {}
        # Cleared by the first step observe; see _restored_indexes_unresolved.
        restored_transcript_unobserved = bool(browser_turn_messages)
        consecutive_budget_free = 0
        consecutive_keystroke_free = 0
        allow_generation_yield = (write_lock_resume_state or {}).get("generation_yield") is not False
        drain_checkpoint_failed = False
        step_timer = StepPhaseTimer(agent_id=agent_id, task_id=task_id)
        tab_focus_cache = TabFocusCache()
        while iteration < MAX_ITERATIONS:
            # Drain checkpoint. Between steps, with no approved action still
            # owed, the task is fully captured by the same resume payload a
            # write-lock pause returns, so the manager can restart it at this
            # step on a live worker (rolling deploy), generation (cutover), or
            # replacement session (the reused one is about to be released)
            # instead of dying mid-step. Every invocation runs at least one
            # step before it may yield again.
            if iteration > resume_step_count and pending_write_lock_action is None and not drain_checkpoint_failed:
                drain_reason = await activity_drain_reason(allow_generation_handoff=allow_generation_yield)
                if not drain_reason and _session_expiring(reused_session_deadline, session_id):
                    drain_reason = BROWSER_SESSION_EXPIRING
                if drain_reason:
                    try:
                        drain_continuity = await persist_resume_context(
                            agent_id=agent_id,
                            task_id=task_id,
                            force_private=bool(action_history.secret_redaction_state().get("secret_redaction_refs")),
                            state=_pause_continuity_state(),
                        )
                    except Exception as checkpoint_error:
                        drain_checkpoint_failed = True
                        logger.warning(
                            "Browser drain checkpoint failed; continuing on this worker",
                            agent_id=agent_id,
                            task_id=task_id,
                            drain_reason=drain_reason,
                            error=extract_error_message(checkpoint_error),
                        )
                    else:
                        logger.info(
                            "Browser task yielding at step boundary",
                            agent_id=agent_id,
                            task_id=task_id,
                            session_id=session_id,
                            drain_reason=drain_reason,
                            step_count=iteration,
                        )
                        if dom_service:
                            try:
                                await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                            except Exception as e:
                                logger.warning(f"Failed to disconnect browser before drain yield: {e}")
                            dom_service = None
                        browser_task_paused_for_resume = True
                        step_timer.finish()
                        return _visible_activity_result({
                            "status": BROWSER_DRAIN_YIELD_STATUS,
                            "yield_reason": drain_reason,
                            "current_url": current_url,
                            "write_lock_approvals": write_lock_approvals,
                            "step_count": iteration,
                            "session_id": session_id,
                            "cdp_url": cdp_url,
                            "task_id": task_id,
                            "browser_url": redact_url_secrets(browser_url),
                            "auth_realm": auth_realm,
                            "recorded_passkey_credential_ids": sorted(recorded_passkey_credential_ids),
                            "usage_items": build_usage_items(
                                total_input_tokens,
                                total_output_tokens,
                                model_pricing,
                                (safe_time() - start_time) * 1000,
                                usage_by_model,
                                pricing_pool=browser_pool,
                                fast_mode_cache_enabled=bool(fast_mode_cache_enabled),
                                provider=browser_session_metadata.get("provider"),
                                session_creates=tilion_creates["count"],
                            ),
                            **drain_continuity,
                        })
            iteration += 1
            step_timer.start_step(iteration)
            browser_activity_checkpoint(f"Step {iteration}")
            if await _wait_for_browser_user_control(config, task_id):
                tab_focus_cache.foreground = None
                state_prefetch.discard()
            step_timer.mark("user_control_wait")

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
                focus_cache=tab_focus_cache,
            )
            step_timer.mark("tab_rebind")

            if not await sync_user_instructions():
                await sync_user_instructions(require_confirmed_read=True)

            # Handle pending write lock action
            if pending_write_lock_action:
                state_prefetch.discard()
                if await _wait_for_browser_user_control(config, task_id):
                    # The approved target may have changed under user control;
                    # retain it and re-resolve against a fresh DOM next step.
                    tab_focus_cache.foreground = None
                    continue
                logger.info("Executing pending write lock action after approval")
                unified_action, _, current_url = await _prepare_pending_write_lock_action(
                    dom_service,
                    pending_write_lock_action,
                    target_signature=pending_write_lock_target,
                )
                pending_write_lock_action = None
                pending_write_lock_target = None

                browser_activity_checkpoint(f"Step {iteration} - executing pending write lock action")
                if (
                    browser_network_recorder is None
                    and network_recorder_task is not None
                    and network_recorder_task.done()
                ):
                    with contextlib.suppress(Exception):
                        browser_network_recorder = network_recorder_task.result()

                result = await _execute_action(
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
                    auth_context_for_url=_auth_context_for_url,
                )

                if result.get("status") == "needs_write_approval":
                    raise RuntimeError(
                        "The resumed page did not recognize the just-approved write action; refusing to loop"
                    )

                action_name = unified_action.get("action", "unknown")
                logger.info(f"Pending write lock action executed: {action_name}", result=result)

                browser_activity_checkpoint(f"Step {iteration} - write lock action applied")
                if isinstance(result, dict) and result.get("current_url"):
                    current_url = _private_browser_runtime_url(dom_service, result.get("current_url") or current_url)
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
                _append_browser_turn_messages(
                    browser_turn_messages,
                    unified_action=unified_action,
                    result=result,
                    tool_call_id=f"write-lock-resume-{iteration}",
                )

                continue

            # 0. Recent OTPs are polled in the background (backend HTTP); the
            # step never waits on it. Codes a finished poll found are appended
            # as USER messages here, at a turn boundary, and the next poll starts.
            otp_poll_task = _harvest_otp_poll(otp_poll_task)
            if otp_credential_refs:
                credential_refs_by_secret_ref.update(otp_credential_refs)
                otp_credential_refs.clear()
            if len(otp_user_messages) > otp_history_count:
                browser_turn_messages.extend(otp_user_messages[otp_history_count:])
                otp_history_count = len(otp_user_messages)
            if otp_poll_task is None:
                otp_poll_task = asyncio.create_task(
                    _fetch_and_append_recent_otp_user_messages(
                        user_id=user_id,
                        api_url=config.backend.api_url,
                        api_key=config.backend.api_key,
                        seen_otp_codes=seen_otp_codes,
                        otp_user_messages=otp_user_messages,
                        credential_refs_by_secret_ref=otp_credential_refs,
                        pending_otp_ref_messages=pending_otp_ref_messages,
                        agent_id=agent_id,
                        task_id=task_id,
                        task_elapsed_seconds=time.monotonic() - otp_task_started_monotonic,
                    )
                )
            step_timer.mark("otp_poll")

            # One guarded state fetch supplies URL + observe text (avoid double DOM).
            browser_activity_checkpoint(f"Step {iteration} - resolving page state")
            try:
                # Kernel drops the WebAuthn VA environment ~5s after seed (agent
                # c1ebd389 median 5.6s). Re-arm before every state observe so the
                # passkey CTA Amazon already rendered — or is about to probe —
                # sees a live authenticator, not the dead environment usage
                # readback keeps logging between ceremony-capable actions.
                # Soft-timeout: passkey re-arm can hang on a frozen renderer
                # (Runtime.evaluate / Page.reload); do not block the guarded
                # state fetch / supervisor recovery path indefinitely.
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(
                        dom_service.ensure_browser_overlays_suppressed(),
                        timeout=BROWSER_STATE_SOFT_TIMEOUT_SECONDS,
                    )
                step_timer.mark("overlay_suppress")
                observe_needs_dom = _step_observe_needs_dom(
                    fast_mode_replay=bool(fast_mode_cache_enabled),
                    browser_recorder=browser_recorder,
                    restored_indexes_unresolved=_restored_indexes_unresolved(
                        dom_service,
                        transcript_restored=restored_transcript_unobserved,
                    ),
                )
                observe_page_state = await asyncio.wait_for(
                    _observe_step_page(dom_service, needs_dom=observe_needs_dom),
                    timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                )
                restored_transcript_unobserved = False
                step_timer.annotate(observe_dom=observe_needs_dom)
                current_url = _private_browser_runtime_url(dom_service, observe_page_state.get("url") or current_url)
                step_timer.mark("observe_state")
            except asyncio.TimeoutError:
                recovered = await _recover_browser_step(
                    f"browser_url_timeout_{BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS}s",
                    reload_page=True,
                )
                if recovered:
                    continue
                raise
            except Exception as state_error:
                recovered = await _recover_browser_step(
                    f"browser_url_error:{type(state_error).__name__}:{extract_error_message(state_error)[:160]}",
                    reload_page=True,
                )
                if recovered:
                    continue
                raise
            await record_passkey_usage_once()
            step_timer.mark("passkey_usage")
            auth_runtime_state.observe_page_text(observe_page_state.get("title") or "")

            # Clicks, form submissions, and server redirects can cross an auth
            # realm without a goto tool call. Prepare that realm before the
            # model observes or interacts with it, then reload once so newly
            # injected cookies and origin state participate in the first page
            # request the agent acts on.
            observed_auth_realm = auth_realm_from_url(current_url)
            observed_realm_changed = (
                observed_auth_realm != auth_realm and not auth_realm_matches_url(auth_realm, current_url)
            )
            reload_prepared_realm = bool(
                pending_credential_reload_realm
                and auth_realm_matches_url(pending_credential_reload_realm, current_url)
            )
            pending_credential_reload_realm = None
            if _credential_binding() != active_credential_binding or observed_realm_changed:
                prepared_realm = await _prepare_credentials_for_url(current_url)
                reload_prepared_realm = bool(
                    observed_realm_changed and prepared_realm is not None
                    and not prepared_realm.get("credential_preparation_error")
                )
            if reload_prepared_realm:
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

                browser_activity_checkpoint(f"Step {iteration} - calling Rose API")
                step_timer.mark("realm_and_payment_prep")
                if browser_recorder:
                    with contextlib.suppress(Exception):
                        # Reuse observe_page_state from earlier in this iteration —
                        # a second unbounded get_browser_state can stall 90-260s on
                        # a frozen challenge renderer (no timeout wrapper here).
                        await browser_recorder.record_observation(
                            iteration=iteration,
                            browser_state=observe_page_state,
                            action_entries=action_entries,
                        )
                step_timer.mark("record_observation")
                if not observe_needs_dom:
                    state_prefetch.start(dom_service)

                # Fast Mode: replay the recorded decision when the browser request
                # fingerprint matches. The live browser session still executes the
                # action — only the LLM "what next" decision is cached.
                async def _live_browser_decision(
                    iteration_snapshot: int = iteration,
                    browser_state_snapshot: Dict[str, Any] = {},
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
                        pool=browser_pool,
                        dom_service=dom_service_snapshot,
                    )
                    return _attach_browser_replay_target(live_result, dom_service_snapshot)

                browser_stream = BrowserThinkingStream(
                    agent_id=agent_id,
                    task_id=task_id,
                    iteration=iteration,
                )
                await browser_stream.start()
                step_timer.mark("thinking_stream_start")
                rose_client.set_thinking_stream(browser_stream)
                decision_succeeded = False
                try:
                    # Fast Mode: replay July OAi-demo browser decisions; on miss
                    # soft-complete with done (see browser_use_cache) so we never
                    # fall through to live rose-1-browser-use (verify13 stall).
                    fm_write_through = write_through_enabled_for_user(user_id)
                    llm_result = await asyncio.wait_for(
                        cached_browser_decision(
                            enabled=bool(fast_mode_cache_enabled),
                            goal=goal,
                            request={
                                "task": task_prompt,
                                "dynamic_system_context": dynamic_system_context,
                                "turn_messages": browser_turn_messages,
                                # url/title enter the Fast Mode cache key via
                                # canonical_browser_use_request — empty {} would
                                # replay a stale decision after a page change.
                                "browser_state": {
                                    "url": observe_page_state.get("url") or current_url,
                                    "title": observe_page_state.get("title"),
                                },
                                "action_entries": action_entries,
                                "config": {
                                    "browser_use_mode": browser_use_mode,
                                },
                            },
                            call_llm=_live_browser_decision,
                            write_enabled=bool(
                                fast_mode_cache_enabled or fm_write_through
                            ),
                            agent_id=agent_id,
                        ),
                        timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                    )
                    decision_succeeded = True
                    step_timer.mark("llm_decision")
                finally:
                    rose_client.set_thinking_stream(None)
                    otp_poll_task = _harvest_otp_poll(otp_poll_task)
                    await browser_stream.finish()
                    if not decision_succeeded:
                        await browser_stream.finish_tools(status="ERROR")
                step_timer.mark("thinking_stream_finish")
                llm_timing = llm_result.get("timing") if isinstance(llm_result.get("timing"), dict) else {}
                step_timer.annotate(
                    llm_round_trip_ms=(
                        int(llm_timing["round_trip_s"] * 1000)
                        if isinstance(llm_timing.get("round_trip_s"), (int, float))
                        else None
                    ),
                    llm_mode=llm_result.get("mode"),
                    llm_from_fast_cache=bool((llm_result.get("usage") or {}).get("from_fast_cache")),
                )
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
                    cache_sequence_id=usage.get("cache_sequence_id"),
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
            except BrowserModelOutputValidationError as validation_error:
                response = validation_error.response
                usage = response.usage or {}
                step_input_tokens = usage.get("prompt_tokens", 0) or 0
                step_output_tokens = usage.get("completion_tokens", 0) or 0
                total_input_tokens += step_input_tokens
                total_output_tokens += step_output_tokens
                accumulate_model_usage(
                    usage_by_model, response.actual_model, step_input_tokens, step_output_tokens,
                    cache_read_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
                    cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
                    from_fast_cache=bool(usage.get("from_fast_cache")),
                    cache_sequence_id=usage.get("cache_sequence_id"),
                )
                _feed_browser_model_output_validation_error_back(
                    error=validation_error, browser_turn_messages=browser_turn_messages, dom_service=dom_service,
                )
                consecutive_api_failures = 0
                logger.warning(
                    "Completed browser response failed output validation",
                    iteration=iteration, request_id=response.request_id, actual_model=response.actual_model,
                    consecutive_failures=consecutive_api_failures,
                )
                continue
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
                    browser_state={},
                    task_prompt=task_prompt,
                    iteration=iteration,
                    agent_id=agent_id,
                    task_id=task_id,
                    browser_url=browser_url,
                )
                continue
            except WorkflowGenerationSealed:
                raise
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

            # Observe a finished native poll before any decision side effects.
            otp_poll_task = _harvest_otp_poll(otp_poll_task)

            # Reset consecutive failure counter on success
            consecutive_api_failures = 0

            _rose_request_id = llm_result.get("request_id", "unknown")

            if await _wait_for_browser_user_control(config, task_id):
                # Never execute an action planned against the pre-handoff DOM.
                tab_focus_cache.foreground = None
                state_prefetch.discard()
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

            # Finish the already-owned inbox poll before transferring control,
            # using the same bounded drain as activity shutdown. Admit any real
            # eligible input it produced through the next ordinary model turn.
            if action_name == "request_user_assistance_for_authentication":
                await _drain_otp_poll(otp_poll_task)
                otp_poll_task = None
                if len(otp_user_messages) > otp_history_count:
                    await browser_stream.finish_tools(status="ERROR")
                    state_prefetch.discard()
                    iteration, consecutive_budget_free, consecutive_keystroke_free = (
                        adjust_iteration_after_action(
                            iteration=iteration,
                            action_name=action_name,
                            consecutive_budget_free=consecutive_budget_free,
                            consecutive_keystroke_free=consecutive_keystroke_free,
                            action_executed=False,
                        )
                    )
                    continue

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
                            exit_geo_locale=replacement.get("exit_geo_locale") or session_exit_geo_locale,
                            agent_id=agent_id,
                            provider=pending_browser_session_metadata.get("provider"),
                            config=config,
                            task_id=task_id,
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
                        if browser_session_metadata.get("provider") == "tilion":
                            tilion_creates["count"] += 1
                        dom_service = reconnected["dom_service"]
                        if hasattr(dom_service, "model_visible_value"):
                            action_history.bind_dom_service(dom_service)
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
                        if browser_download_persister is None and download_persister_task is not None:
                            with contextlib.suppress(Exception):
                                if download_persister_task.done():
                                    browser_download_persister = download_persister_task.result()
                        if browser_download_persister is not None:
                            with contextlib.suppress(Exception):
                                await browser_download_persister.transition_browser(
                                    browser_session=dom_service.session,
                                    session_id=session_id,
                                    provider=browser_session_metadata.get("provider"),
                                )
                        humanizer = await _replace_browser_humanizer(
                            serial_cdp_keyboard=is_single_cdp_client_provider(browser_session_metadata.get("provider")),
                            current_humanizer=humanizer,
                            enabled=_env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True),
                            dom_page=dom_page,
                            input_page=input_page,
                            cursor_observer=observe_cursor,
                            humanizer_factory=BrowserHumanizer,
                        )
                        browser_state = await dom_service.get_browser_state(include_screenshot=False)
                        current_url = _private_browser_runtime_url(dom_service, browser_state.get("url") or current_url)
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
                            unified_action=unified_action,
                            result=recovery_result,
                            tool_call_id=tool_call_id_action,
                        )
                        await _save_browser_action_message(
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
                    auth_realm=_redact_activity_value(auth_realm or base_site),
                    browser_session_id=task_id,
                    steel_session_id=session_id,
                    browser_url=browser_url,
                    current_url=_redact_activity_value(auth_handoff_current_url),
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
                    unified_action=unified_action,
                    result=success_result,
                    tool_call_id=tool_call_id_action,
                )

                parked_page = await disconnect_browser_after_passkey_capture(
                    dom_service, record_passkey_usage_once,
                    observe_parked_page=lambda: {
                        **dom_service.get_parked_page_identity(), "phase": "park_time",
                        "agent_id": agent_id, "user_id": user_id, "task_id": task_id,
                        "session_id": session_id, "request_id": request_id, "tool_call_id": tool_call_id,
                    },
                )
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
                    pricing_pool=browser_pool,
                    fast_mode_cache_enabled=bool(fast_mode_cache_enabled),
                    provider=browser_session_metadata.get("provider"),
                    session_creates=tilion_creates["count"],
                )
                await _propagate_browser_credentials_with_progress(
                    redact=_redact_activity_value,
                    config=config,
                    agent_id=agent_id,
                    task_id=task_id,
                    browser_url=browser_url,
                    status="awaiting_auth_assistance",
                    success=False,
                    message="Automated authentication options were exhausted; requesting user assistance.",
                )
                await browser_stream.finish_tools(status="FINISHED")

                # Public evidence needs location, not private URL query/fragment/userinfo.
                public_parked_page = None
                if isinstance(parked_page, dict) and isinstance(parked_page.get("url"), str):
                    from urllib.parse import urlsplit
                    try:
                        page_parts = urlsplit(parked_page["url"])
                        public_parked_page = {
                            **{key: parked_page.get(key) for key in (
                                "target_id", "phase", "agent_id", "user_id", "task_id",
                                "session_id", "request_id", "tool_call_id",
                            )},
                            "origin": page_parts.scheme + "://" + page_parts.netloc.rsplit("@", 1)[-1],
                            "path": page_parts.path,
                        }
                    except ValueError:
                        pass  # Invalid optional measurement cannot fail the auth handoff.
                resume_result = {
                    "status": "awaiting_auth_assistance",
                    "browser_page_observation": public_parked_page,
                    "request_id": request_id,
                    "auth_assistance_request": request_info,
                    "base_site": base_site,
                    "auth_realm": auth_realm or base_site,
                    "task_id": task_id,
                    "session_id": session_id,
                    "browser_url": redact_url_secrets(browser_url),
                    "cdp_url": cdp_url,
                    "handoff_mode": "same_steel_session_live_view",
                    "step_count": iteration,
                    "recorded_passkey_credential_ids": sorted(recorded_passkey_credential_ids),
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items,
                    **(await persist_resume_context(
                        agent_id=agent_id,
                        task_id=task_id,
                        force_private=bool(action_history.secret_redaction_state().get("secret_redaction_refs")),
                        state=_pause_continuity_state(),
                    )),
                }
                browser_task_paused_for_resume = True
                resume_result = _visible_activity_result(resume_result)
                return resume_result

            if action_name == "recover_from_challenge":
                recovery_params = unified_action.get("params", {}) or {}
                recovery_reason = recovery_params.get("reason", "")
                # Default true: preserve authenticated cookies unless the model
                # explicitly opts into a fresh-cookie machine search.
                if "auth_cookies_are_preserved" in recovery_params:
                    auth_cookies_are_preserved = bool(
                        recovery_params.get("auth_cookies_are_preserved")
                    )
                else:
                    auth_cookies_are_preserved = True
                allow_logged_out_cookie_commit = not auth_cookies_are_preserved
                recovery_call_id = _browser_action_tool_call_id(llm_result)
                logger.info(
                    "Browser agent requested staged challenge recovery",
                    reason=recovery_reason,
                    auth_cookies_are_preserved=auth_cookies_are_preserved,
                )

                provider_exit_rejected = bool(recovery_params.get("provider_exit_rejected"))
                # The recorder attaches in the background; the clean-page check
                # needs it to see a cited first-party transport failure.
                if browser_network_recorder is None and network_recorder_task is not None:
                    with contextlib.suppress(Exception):
                        browser_network_recorder = await asyncio.wait_for(
                            asyncio.shield(network_recorder_task),
                            timeout=10,
                        )
                # If the live tab is already clean and this was not a hard
                # provider-exit rejection, skip — avoids recovery loops the model
                # invents from third-party network noise on an otherwise fine page.
                if (
                    not provider_exit_rejected
                    and input_page is not None
                    and not await live_tab_looks_challenged(
                        input_page,
                        network_recorder=browser_network_recorder,
                        recovery_reason=recovery_reason,
                    )
                ):
                    skip_message = (
                        "Current page does not look challenged"
                        + (f" ({current_url})" if current_url else "")
                        + ". Continue the task on this page — do not start "
                        "challenge recovery unless the document itself is blocked."
                    )
                    await _save_browser_action_message(
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
                        browser_state={},
                        unified_action=unified_action,
                        recovery_call_id=recovery_call_id,
                        browser_stream=browser_stream,
                    )
                    continue

                progress_titles = {
                    "capture_browser_state": "Capturing browser state",
                    "captcha_solver": "Waiting for CAPTCHA auto-solver",
                    "cookie_probe_wave": "Probing cookie variants",
                    "apply_cookie_fix": "Applying safe cookie recovery",
                    "preserve_auth_state": "Preserving auth; searching configs",
                    "fresh_cookie_config_search": "Fresh-cookie config search",
                    "browser_config_search": "Searching browser configurations",
                    "live_verify": "Verifying live tab cleared challenge",
                }

                async def emit_recovery_progress(stage: str, message: str) -> None:
                    await _save_browser_action_message(
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

                async def search_browser_configs(storage_lanes: list) -> Dict[str, Any]:
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
                        # Sticky URL is still useful as LLM evidence; hard CDN filter is gone.
                        require_payment_cdn = True
                        payment_cdn_verify_url = blocked_resource_url or payment_cdn_verify_url
                    verify_url = blocked_resource_url or payment_cdn_verify_url
                    lanes = list(storage_lanes or [])
                    primary_state = (
                        lanes[0].get("storage_state")
                        if lanes and isinstance(lanes[0], dict)
                        else recovery_storage_state
                    )
                    preserve_auth = auth_cookies_are_preserved
                    result = await recover_browser_challenge(
                        config,
                        task_id,
                        current_url,
                        primary_state if isinstance(primary_state, dict) else recovery_storage_state,
                        user_agent,
                        storage_lanes=lanes,
                        recovery_reason=str(recovery_reason or "") or "",
                        blocked_resource_url=verify_url,
                        require_payment_cdn=require_payment_cdn,
                        preserve_auth=preserve_auth,
                    )
                    if result.get("rate_limited"):
                        raise RuntimeError("Browser provider slots are busy; challenge recovery could not run")
                    return result

                challenge_classifier_usages: list = []
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
                    async def probe_cookie_variant_remote(candidate: Dict[str, Any]) -> bool:
                        # Ephemeral Kernel/Steel session — never new_context on live desktop.
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
                        return await probe_cookie_variant_ephemeral(
                            config,
                            task_id,
                            current_url,
                            candidate,
                            user_agent=user_agent,
                            recovery_reason=str(recovery_reason or "") or "",
                            blocked_resource_url=blocked_resource_url,
                        )

                    recovery = await recover_from_challenge(
                        source_state=recovery_storage_state,
                        target_url=current_url,
                        wait_for_solver=lambda: _wait_for_provider_captcha_solver(
                            config,
                            task_id,
                            page=input_page,
                            provider=str(browser_session_metadata.get("provider") or ""),
                        ),
                        probe=probe_cookie_variant_remote,
                        commit_cookie_removals=lambda keys: commit_cookie_removals(
                            input_page,
                            keys,
                            current_url,
                            recovery_reason=str(recovery_reason or "") or None,
                            network_recorder=browser_network_recorder,
                        ),
                        search_configs=search_browser_configs,
                        progress=emit_recovery_progress,
                        skip_cookie_probes=provider_exit_rejected
                        or escalate_after_cookie_false_stable,
                        allow_logged_out_cookie_commit=allow_logged_out_cookie_commit,
                    )
                    if recovery.recovery == "cookies_sanitized":
                        cookie_recovery_successes += 1

                    config_result = recovery.config_result
                    if config_result is not None:
                        if config_result.get("success") is False:
                            raise RuntimeError(
                                str(config_result.get("error") or "No viable browser recovery configuration")
                            )
                        new_cdp_url = config_result.get("ws_url")
                        if not isinstance(new_cdp_url, str) or not new_cdp_url:
                            raise RuntimeError("Challenge recovery selected a browser without a CDP URL")
                        promoted_metadata = _updated_rotation_session_metadata(
                            browser_session_metadata,
                            dict(config_result),
                        )
                        try:
                            reconnected = await _reconnect_browser_stack_after_rotation(
                                new_cdp_url=new_cdp_url,
                                old_dom_service=dom_service,
                                old_playwright_browser=playwright_browser,
                                old_playwright_instance=playwright_instance,
                                old_driver_pid=playwright_driver_pid,
                                fingerprint_injection=fingerprint_injection,
                                exit_geo_locale=session_exit_geo_locale,
                                agent_id=agent_id,
                                provider=promoted_metadata.get("provider")
                                or config_result.get("provider"),
                                config=config,
                                task_id=task_id,
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
                        if hasattr(dom_service, "model_visible_value"):
                            action_history.bind_dom_service(dom_service)
                        dom_page = reconnected["dom_page"]
                        input_page = reconnected["input_page"]
                        playwright_browser = reconnected["playwright_browser"]
                        playwright_instance = reconnected["playwright_instance"]
                        playwright_driver_pid = reconnected["playwright_driver_pid"]
                        session_id = config_result.get("session_id", session_id)
                        browser_url = config_result.get("debug_url", browser_url)
                        cdp_url = new_cdp_url
                        browser_session_metadata = promoted_metadata
                        if browser_session_metadata.get("provider") == "tilion":
                            tilion_creates["count"] += 1
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
                        if browser_download_persister is None and download_persister_task is not None:
                            with contextlib.suppress(Exception):
                                browser_download_persister = await asyncio.wait_for(
                                    asyncio.shield(download_persister_task),
                                    timeout=10,
                                )
                        if browser_download_persister is not None:
                            with contextlib.suppress(Exception):
                                await browser_download_persister.transition_browser(
                                    browser_session=dom_service.session,
                                    session_id=session_id,
                                    provider=browser_session_metadata.get("provider"),
                                )

                        humanizer = await _replace_browser_humanizer(
                            serial_cdp_keyboard=is_single_cdp_client_provider(browser_session_metadata.get("provider")),
                            current_humanizer=humanizer,
                            enabled=_env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True),
                            dom_page=dom_page,
                            input_page=input_page,
                            cursor_observer=observe_cursor,
                            humanizer_factory=BrowserHumanizer,
                        )

                        # Preloaded winners already classified clean once on this
                        # remote session (single-nav probe). Skip a second live-tab
                        # LLM verify — resume at the settled URL instead.
                        if not bool(config_result.get("storage_state_preloaded")):
                            await emit_recovery_progress(
                                "live_verify",
                                "Verifying the promoted browser cleared the challenge on the live tab.",
                            )
                            live_verify_dom_tree = None
                            with contextlib.suppress(Exception):
                                live_verify_state = await dom_service.get_browser_state(
                                    include_screenshot=False
                                )
                                live_verify_dom_tree = (
                                    str(live_verify_state.get("dom_tree") or "") or None
                                )
                            live_verify_url = str(
                                config_result.get("saved_url") or current_url or ""
                            ).strip() or current_url
                            if not await verify_live_page_cleared_challenge(
                                input_page,
                                live_verify_url,
                                attempts=1,
                                agent_id=agent_id,
                                user_id=user_id,
                                claude_token=token_state.access_token,
                                claude_token_source=token_state.source,
                                claude_token_pool_id=token_state.pool_token_id,
                                gpt_token=gpt_token,
                                gpt_account_id=gpt_account_id,
                                gpt_token_source=gpt_token_source,
                                gpt_token_pool_id=gpt_token_pool_id,
                                usage_collector=challenge_classifier_usages,
                                agent_dom_tree=live_verify_dom_tree,
                                network_recorder=browser_network_recorder,
                                recovery_reason=str(recovery_reason or "") or None,
                            ):
                                provider = config_result.get("provider")
                                proxy_tier = config_result.get("proxy_tier")
                                config_key = (
                                    config_result.get("config_key") or f"{provider}/{proxy_tier}"
                                )
                                raise RuntimeError(
                                    f"Promoted {config_key} passed candidate probes but the live tab "
                                    "is still challenged"
                                )
                        saved_resume = str(config_result.get("saved_url") or "").strip()
                        if saved_resume.startswith(("http://", "https://")):
                            current_url = saved_resume
                        # Blocked-resource CDN hard-verify removed: the LLM live
                        # gate already receives blocked_resource_url via recovery_reason.

                    browser_state = await dom_service.get_browser_state(include_screenshot=False)
                    current_url = _private_browser_runtime_url(dom_service, browser_state.get("url") or current_url)
                    if config_result is not None:
                        saved_resume = str(config_result.get("saved_url") or "").strip()
                        if saved_resume.startswith(("http://", "https://")) and not str(
                            current_url or ""
                        ).startswith(("http://", "https://")):
                            current_url = saved_resume
                        provider = config_result.get("provider")
                        proxy_tier = config_result.get("proxy_tier")
                        config_key = config_result.get("config_key") or f"{provider}/{proxy_tier}"
                        blocked_resource_url = str(
                            unified_action.get("params", {}).get("blocked_resource_url") or ""
                        ).strip()
                        verified_phrase = (
                            "probe already verified clean"
                            if bool(config_result.get("storage_state_preloaded"))
                            else "live tab verified clean"
                        )
                        auth_cookie_note = (
                            "authenticated cookies were preserved"
                            if auth_cookies_are_preserved
                            else "fresh-cookie recovery was allowed (auth cookies not required)"
                        )
                        recovery_message = (
                            f"Recovered by selecting {config_key}; {verified_phrase}"
                            + (
                                f"; blocked resource cleared ({blocked_resource_url})"
                                if blocked_resource_url
                                else ""
                            )
                            + f"; {auth_cookie_note}."
                        )
                    else:
                        auth_cookie_note = (
                            "authenticated cookies were preserved"
                            if auth_cookies_are_preserved
                            else "fresh-cookie recovery was allowed (auth cookies not required)"
                        )
                        recovery_message = (
                            "Recovered by removing a proven non-auth cookie subset; "
                            f"{auth_cookie_note}."
                        )
                    if current_url:
                        recovery_message = (
                            f"{recovery_message} Current page URL: {current_url}. "
                            "Continue the task on this page."
                        )
                    await _save_browser_action_message(
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
                    await _save_browser_action_message(
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
                finally:
                    # Fold Python-side rose-1-mini classifier usage into the
                    # browser ledger (success or fail). Backend probe classifiers
                    # already wrote ToolUsage via recordChallengeClassifierUsage.
                    for classifier_usage in challenge_classifier_usages:
                        if not isinstance(classifier_usage, dict):
                            continue
                        c_in = int(classifier_usage.get("prompt_tokens") or 0)
                        c_out = int(classifier_usage.get("completion_tokens") or 0)
                        total_input_tokens += c_in
                        total_output_tokens += c_out
                        accumulate_model_usage(
                            usage_by_model,
                            classifier_usage.get("actual_model") or "rose-labs/rose-1-mini",
                            c_in,
                            c_out,
                            cache_read_input_tokens=int(
                                classifier_usage.get("cache_read_input_tokens") or 0
                            ),
                            cache_creation_input_tokens=int(
                                classifier_usage.get("cache_creation_input_tokens") or 0
                            ),
                            from_fast_cache=bool(classifier_usage.get("from_fast_cache")),
                            cache_sequence_id=classifier_usage.get("cache_sequence_id"),
                        )

                await _finalize_browser_recovery_action_result(
                    action_result=action_result,
                    dom_service=dom_service,
                    action_history=action_history,
                    thinking=thinking,
                    recovery_reason=recovery_reason,
                    browser_turn_messages=browser_turn_messages,
                    task_prompt=task_prompt,
                    browser_state={},
                    unified_action=unified_action,
                    recovery_call_id=recovery_call_id,
                    browser_stream=browser_stream,
                )
                continue

            if action_name in ("attempt_completion", "done"):
                close_reasoning = unified_action.get("params", {}).get("reasoning", "") or unified_action.get(
                    "params", {}
                ).get("text", "")

                verifier_call_id = str(uuid_module.uuid4())
                completion_tool_status = "ERROR"
                try:
                    await sync_user_instructions(require_current_schema=True)
                    verification_instruction_count = len(user_instruction_messages)
                    await _save_browser_action_message(
                        agent_id=agent_id,
                        title="\u2696\ufe0f Verifying completion",
                        task_id=task_id,
                        message="",
                        status=MessageStatus.IN_PROGRESS,
                        browser_url=browser_url,
                        action_type="system",
                        tool_call_id=verifier_call_id,
                    )

                    # The verifier must see the rendered page: a goal grounded in
                    # what is visible (colors, images, layout) is unverifiable
                    # from DOM text alone, so a DOM-only judge rejects every
                    # completion at 0.5 and the agent loops to its deadline
                    # (browser-smoke ec464455). build_browser_verifier_context
                    # forwards this capture as the final_screenshot image block.
                    verifier_browser_state = await asyncio.wait_for(
                        dom_service.get_browser_state(include_screenshot=True),
                        timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                    )
                    verifier_context = await build_browser_verifier_context(
                        goal=goal,
                        current_url=current_url,
                        browser_state=verifier_browser_state,
                        user_instruction_messages=user_instruction_messages,
                        action_history=action_history,
                        config=config,
                        session_id=session_id,
                        payment_card_evidence=_build_payment_card_verifier_evidence(payment_card_last4),
                        browser_checkpoints=verifier_checkpoints,
                    )

                    if hasattr(dom_service, "model_visible_value"):
                        verifier_context = _model_visible_browser_verifier_context(verifier_context, dom_service, verifier_browser_state)

                    remote_session_schema = transform_schema_for_remote_session(
                        _model_visible_browser_output_schema(response_schema, _redact_activity_value)
                    )
                    verifier_prompt = build_verifier_prompt(response_schema=remote_session_schema)

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
                            bool(fast_mode_cache_enabled),
                            goal if fast_mode_cache_enabled else None,
                            int(iteration or 0),
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
                        cache_sequence_id=v_usage.get("cache_sequence_id"),
                    )

                    score = progress_result.get("score", 0.0)
                    v_reasoning = progress_result.get("reasoning", "")

                    progress_title = f"\u2696\ufe0f Progress: {float(score or 0.0) * 100:.0f}%"

                    await _save_browser_action_message(
                        agent_id=agent_id,
                        title=progress_title,
                        task_id=task_id,
                        message=v_reasoning,
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url,
                        action_type="system",
                        tool_call_id=verifier_call_id,
                    )
                    await sync_user_instructions(require_current_schema=True)
                    if (
                        verification_instruction_count != len(user_instruction_messages)
                        or int(instruction_state.get("schema_user_instruction_count") or 0) < len(user_instruction_messages)
                    ):
                        continue

                    if progress_result.get("structured_response") is not None:
                        latest_structured_response = progress_result["structured_response"]
                    if browser_recorder:
                        await browser_recorder.mark(
                            f"Verifier progress: {float(score or 0.0) * 100:.0f}%",
                            action="verify",
                        )

                    if score >= 1.0:
                        completion_tool_status = "FINISHED"
                        execution_time_ms = (safe_time() - start_time) * 1000
                        # A passing verifier call may omit the output it already
                        # produced on an earlier call; keep that cached response.
                        structured_response = (
                            progress_result.get("structured_response") or latest_structured_response
                        )

                        uploaded_paths = list(available_file_paths.values()) if available_file_paths else []
                        output_files = await extract_session_files(
                            session_id, user_id, config, exclude_paths=uploaded_paths
                        )

                        try:
                            final_screenshot_state = await asyncio.wait_for(
                                dom_service.get_browser_state(include_screenshot=True),
                                timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                            )
                            last_screenshot_b64 = final_screenshot_state.get("screenshot")
                        except Exception as screenshot_error:
                            logger.warning(
                                "[BrowserAgent] Failed to capture final screenshot",
                                agent_id=agent_id,
                                error=extract_error_message(screenshot_error),
                            )
                            last_screenshot_b64 = None
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
                        await _close_browser_with_cleanup_receipt(session_id, pause=False)

                        context_message = build_context_summary(
                            success=True,
                            close_reasoning=close_reasoning,
                            visited_urls=visited_urls,
                            reasoning_messages=reasoning_messages,
                            action_summary=action_summary,
                            goal=goal,
                        )
                        context_message = append_completion_evidence(
                            context_message,
                            browser_url=current_url,
                            structured_response=structured_response,
                        )
                        await _save_browser_action_message(
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
                            extra_metadata={"browser_cleanup": cleanup_failure} if cleanup_failure else None,
                        )

                        usage_items = build_usage_items(
                            total_input_tokens,
                            total_output_tokens,
                            model_pricing,
                            execution_time_ms,
                            usage_by_model,
                            pricing_pool=browser_pool,
                            fast_mode_cache_enabled=bool(fast_mode_cache_enabled),
                            provider=browser_session_metadata.get("provider"),
                            session_creates=tilion_creates["count"],
                        )
                        await _propagate_browser_credentials_with_progress(
                            redact=_redact_activity_value,
                            config=config,
                            agent_id=agent_id,
                            task_id=task_id,
                            browser_url=browser_url,
                            status="completed",
                            success=True,
                            message=context_message,
                        )

                        return _visible_activity_result({
                            "status": "completed",
                            "success": True,
                            **({"browser_cleanup": cleanup_failure} if cleanup_failure else {}),
                            "message": context_message,
                            "browser_url": redact_url_secrets(browser_url),
                            "task_id": task_id,
                            "usage_items": usage_items,
                            "execution_time_ms": execution_time_ms,
                            "auth_assistance_resume_mode": auth_assistance_resume_mode,
                            "session_id": session_id,
                            "structured_response": structured_response,
                            "browser_output_schema": response_schema,
                            "output_files": output_files,
                        })

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
                    await _save_browser_action_message(
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

                    # Optional refresh only — rejection is already durable above.
                    # Soft 10s×2 budget (healthy p95≈10–12s); never burn the 300s
                    # challenge-survival BrowserStateRequest timeout here, and
                    # never let a CDP hang become "Verification failed".
                    current_state = await _get_browser_state_soft(
                        dom_service,
                        include_screenshot=True,
                    )
                    current_screenshot = (
                        current_state.get("screenshot") if current_state else None
                    )

                    rejection_result = {
                        "success": False,
                        "error": "Verifier rejected completion.",
                        "score": score,
                        "reasoning": v_reasoning,
                    }
                    _append_browser_turn_messages(
                        browser_turn_messages,
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

                except (BrowserSessionCloseError, BrowserInstructionUnavailableError, WorkflowGenerationSealed):
                    raise
                except Exception as verifier_error:
                    completion_tool_status = "ERROR"
                    logger.error(f"Verifier failed: {verifier_error}")
                    await _save_browser_action_message(
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
                    guest_click_text = element_desc
                    try:
                        children_text = element.get_all_children_text()
                        if children_text and str(children_text).strip():
                            guest_click_text = str(children_text)
                    except Exception:
                        attrs = getattr(element, "attributes", None) or {}
                        aria = attrs.get("aria-label") or attrs.get("ariaLabel") or ""
                        guest_click_text = f"{element_desc} {aria}".strip()
                    auth_runtime_state.observe_clicked_element_text(guest_click_text)

            title_progress, title_done, action_name = build_action_titles(
                action_name, unified_action, element_desc, coords, secret_refs
            )
            if hasattr(dom_service, "model_visible_value"):
                title_progress = dom_service.model_visible_value(title_progress)
                title_done = dom_service.model_visible_value(title_done)

            coords_for_cursor = coords
            if not coords_for_cursor and idx is not None:
                coord_tuple = await dom_service.get_element_coordinates(idx)
                if coord_tuple:
                    coords_for_cursor = {"x": coord_tuple[0], "y": coord_tuple[1]}

            await _save_browser_action_message(
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

            prefetched_browser_state = observe_page_state
            if action_name == "read_browser_state" and "dom_tree" not in observe_page_state:
                speculative_state = await _take_speculative_browser_state(state_prefetch, dom_service)
                step_timer.annotate(state_prefetch="hit" if speculative_state else "miss")
                prefetched_browser_state = speculative_state or observe_page_state
            else:
                state_prefetch.discard()
            step_timer.mark("pre_action_bookkeeping")
            step_timer.annotate(action=action_name)
            browser_activity_checkpoint(f"Step {iteration} - executing {action_name}")
            action_task = asyncio.create_task(
                    _execute_action(
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
                        prefetched_browser_state=prefetched_browser_state,
                        auth_context_for_url=_auth_context_for_url,
                    )
            )
            try:
                result = await asyncio.wait_for(
                    action_task,
                    timeout=BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                from domains.spawn_browser_agent_v3.service_actions import BrowserEvaluateDeadlineExceeded

                timeout_error = sys.exception()
                action_timeout_seconds = (
                    timeout_error.timeout_seconds
                    if isinstance(timeout_error, BrowserEvaluateDeadlineExceeded)
                    else BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS if action_task.cancelled() else None
                )
                timeout_description = (
                    f"after {action_timeout_seconds:g}s"
                    if action_timeout_seconds is not None
                    else f"with unknown timeout source (configured supervisor cap {BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS:g}s)"
                )
                timeout_reason = (
                    f"{action_timeout_seconds:g}s" if action_timeout_seconds is not None else "unknown_source"
                )
                # Any action can hang on a frozen renderer (Momence Konva waiver:
                # evaluate OR click). Classify via browser-process CDP before soft
                # recovery; soft bring_to_front alone cannot reclaim the page.
                from domains.spawn_browser_agent_v3.service_actions import (
                    _evaluate_code_fingerprint,
                    classify_evaluate_cdp_stall,
                )

                stall: Dict[str, Any] = await classify_evaluate_cdp_stall(
                    input_page=input_page,
                    playwright_browser=playwright_browser,
                    timeout_s=2.0,
                )
                stall_log: Dict[str, Any] = {
                    "agent_id": agent_id,
                    "task_id": task_id,
                    "session_id": session_id,
                    "iteration": iteration,
                    "current_url": current_url,
                    "action_name": action_name,
                    "stall": stall,
                }
                if action_name == "evaluate":
                    eval_code = str((unified_action.get("params") or {}).get("code") or "")
                    stall_log.update(_evaluate_code_fingerprint(eval_code))
                logger.error(
                    "Browser action timed out; CDP stall classification",
                    **stall_log,
                )
                renderer_frozen = stall.get("verdict") == "renderer_main_thread_blocked"
                await _recover_browser_step(
                    f"action_timeout_{action_name}_{timeout_reason}",
                    reload_page=renderer_frozen,
                )
                if renderer_frozen:
                    recycled_page, hard_actions = await _hard_recover_frozen_renderer_page(
                        input_page=input_page,
                        playwright_browser=playwright_browser,
                        fallback_url=current_url or "",
                    )
                    logger.warning(
                        "Hard recovery after renderer-frozen action timeout",
                        agent_id=agent_id,
                        task_id=task_id,
                        action_name=action_name,
                        actions=hard_actions,
                        recycled=recycled_page is not None,
                    )
                    if recycled_page is not None:
                        from browser_tools.humanizer import BrowserHumanizer

                        input_page = recycled_page
                        humanizer = await _replace_browser_humanizer(
                            serial_cdp_keyboard=is_single_cdp_client_provider(browser_session_metadata.get("provider")),
                            current_humanizer=humanizer,
                            enabled=True,
                            dom_page=dom_page,
                            input_page=input_page,
                            cursor_observer=observe_cursor,
                            humanizer_factory=BrowserHumanizer,
                        )
                        if browser_recorder is not None:
                            browser_recorder.page = input_page
                        # Point browser-use at a fresh navigation so DOM/state
                        # watchdogs leave the destroyed frozen target.
                        resume = current_url or getattr(input_page, "url", "") or ""
                        if resume.startswith(("http://", "https://")) and dom_service is not None:
                            with contextlib.suppress(Exception):
                                from browser_use.browser.events import NavigateToUrlEvent

                                nav = dom_service.session.event_bus.dispatch(
                                    NavigateToUrlEvent(url=resume, wait_until="commit")
                                )
                                await asyncio.wait_for(nav, timeout=30.0)
                                with contextlib.suppress(Exception):
                                    await nav.event_result(raise_if_any=False, raise_if_none=False)
                        input_page, humanizer = await _rebind_browser_tab_runtime(
                            dom_service=dom_service,
                            dom_page=dom_page,
                            playwright_browser=playwright_browser,
                            current_page=input_page,
                            humanizer=humanizer,
                            browser_recorder=browser_recorder,
                            cursor_observer=observe_cursor,
                            focus_cache=tab_focus_cache,
                        )
                result = {
                    "success": False,
                    "error": (
                        f"Browser action '{action_name}' timed out {timeout_description}; "
                        + (
                            "hard renderer recovery ran after CDP classified "
                            "renderer_main_thread_blocked."
                            if renderer_frozen
                            else "generic browser supervisor recovery ran."
                        )
                    ),
                    "supervisor_recovered": True,
                    "renderer_stall": stall or None,
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
            step_timer.mark("execute_action")
            # Retain only the validated producer source privately; history/forks use the safe view.
            payment_operational_source = getattr(result, "operational_source", None) if (
                getattr(result, "operational_field", None) == "payment_request"
            ) else None
            # Nothing a tool read back from the page may carry a secret the tool typed.
            result = (
                dom_service.model_visible_action_result(action_name, result)
                if hasattr(dom_service, "model_visible_action_result")
                else mask_secret_values(result, secret_refs)
            )
            state_prefetch.arm(
                action_name,
                success=isinstance(result, dict) and bool(result.get("success", True)),
            )
            if isinstance(result, dict) and result.get("current_url"):
                current_url = _private_browser_runtime_url(dom_service, result.get("current_url"))
                if current_url and (not visited_urls or current_url != visited_urls[-1]):
                    visited_urls.append(current_url)
            if (
                not result.get("credential_ref")
                and action_name == "input_text"
                and minted_credential_ref
                and str(unified_action.get("params", {}).get("text", "")).strip().lower() in minted_account_labels
            ):
                result["credential_ref"] = minted_credential_ref
            if (
                action_name == "input_text"
                and isinstance(result.get("credential_ref"), dict)
                and result["credential_ref"].get("kind") == "minted_account"
            ):
                # Post-run propagation saves the exact identifier that signed in
                # as a passwordless login for this site, so record what was typed.
                result["credential_ref"] = {
                    **result["credential_ref"],
                    "username": str(unified_action.get("params", {}).get("text", "")),
                    "origin": str(current_url or ""),
                }

            _append_browser_turn_messages(
                browser_turn_messages,
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
                notification_operational_source = None
                write_lock_notification_usage = None
                write_lock_browser_state = None

                try:
                    browser_activity_checkpoint(f"Step {iteration} - generating write lock notification")
                    # Screenshot required so checkout-preview fallback can fire when
                    # item images / media candidates are missing.
                    write_lock_browser_state = await asyncio.wait_for(
                        dom_service.get_browser_state(include_screenshot=True),
                        timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                    )
                    if approval_type == "return":
                        from browser_tools.write_lock import enrich_return_write_lock_question

                        page_text = str(
                            write_lock_browser_state.get("dom_tree")
                            or write_lock_browser_state.get("formatted_state")
                            or ""
                        )
                        question = enrich_return_write_lock_question(
                            question,
                            page_text,
                            url=current_url,
                            system_name=system_name,
                        )
                    # Cap the notification fork so a slow waterfall cannot burn the
                    # remaining bench budget after drop-off is already selected
                    # (agent 788d17cf: write_lock at T+631s, fork still in flight at
                    # dynamic timeout). Enriched return fallback already names drop-off.
                    _notification_timeout_s = (
                        45.0 if approval_type == "return" else BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS
                    )
                    notification_result = await asyncio.wait_for(
                        _generate_write_lock_notification(
                            rose_client=rose_client,
                            task_prompt=task_prompt,
                            dynamic_system_context=dynamic_system_context,
                            browser_turn_messages=browser_turn_messages,
                            browser_state=write_lock_browser_state,
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
                            pool=browser_pool,
                            dom_service=dom_service,
                        ),
                        timeout=_notification_timeout_s,
                    )
                    write_lock_notification = notification_result.get("notification")
                    notification_operational_source = getattr(notification_result, "operational_source", None)
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

                # Reuse the just-fetched write-lock state (no browser action since).
                # If that fetch failed, try once more for a checkpoint — but never
                # let a frozen CDP wipe the already-ready approval return.
                checkpoint_state = write_lock_browser_state
                if not checkpoint_state:
                    try:
                        checkpoint_state = await asyncio.wait_for(
                            dom_service.get_browser_state(include_screenshot=False),
                            timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                        )
                    except Exception:
                        checkpoint_state = {}
                checkpoint = _browser_ground_truth_checkpoint(checkpoint_state, current_url)
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
                    cdp_url=redact_cdp_url(cdp_url)[:50] if cdp_url else None,
                )
                await browser_stream.finish_tools(status="FINISHED")
                resume_result = {
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
                    **(await persist_resume_context(
                        agent_id=agent_id,
                        task_id=task_id,
                        force_private=bool(action_history.secret_redaction_state().get("secret_redaction_refs")),
                        state=_pause_continuity_state({
                            "write_lock_notification": write_lock_notification,
                            "pending_action_target": llm_result.get("_fast_cache_browser_target"),
                        }),
                    )),
                }
                browser_task_paused_for_resume = True
                resume_result = _visible_activity_result(resume_result, operational_sources={
                    "write_lock_notification": notification_operational_source,
                })
                return resume_result

            if result.get("status") in {"needs_payment_card_approval", "awaiting_payment_card_approval"}:
                payment_request = result.get("payment_request", {})
                await action_history.record_action(
                    dom_service=dom_service,
                    action="request_payment_card",
                    thinking=thinking,
                    result=dict(result),
                )
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
                await _save_browser_action_message(
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
                payment_notification_operational_source = None
                payment_write_lock_notification_usage = None
                payment_notification_state = None
                try:
                    browser_activity_checkpoint(f"Step {iteration} - generating payment approval notification")
                    payment_notification_state = await asyncio.wait_for(
                        dom_service.get_browser_state(include_screenshot=True),
                        timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                    )
                    payment_notification_result = await _generate_write_lock_notification(
                        rose_client=rose_client,
                        task_prompt=task_prompt,
                        dynamic_system_context=dynamic_system_context,
                        browser_turn_messages=browser_turn_messages,
                        browser_state=payment_notification_state,
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
                        pool=browser_pool,
                        dom_service=dom_service,
                    )
                    payment_write_lock_notification = payment_notification_result.get("notification")
                    payment_notification_operational_source = getattr(payment_notification_result, "operational_source", None)
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

                # Reuse payment notification state when available (no action since).
                checkpoint_state = payment_notification_state
                if not checkpoint_state:
                    try:
                        checkpoint_state = await asyncio.wait_for(
                            dom_service.get_browser_state(include_screenshot=False),
                            timeout=BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
                        )
                    except Exception:
                        checkpoint_state = {}
                checkpoint = _browser_ground_truth_checkpoint(checkpoint_state, current_url)
                _append_bounded_verifier_checkpoint(verifier_checkpoints, checkpoint)

                if dom_service:
                    try:
                        await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                        dom_service = None
                    except Exception as e:
                        logger.warning(f"Failed to disconnect browser before payment card return: {e}")

                await browser_stream.finish_tools(status="FINISHED")
                resume_result = {
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
                    **(await persist_resume_context(
                        agent_id=agent_id,
                        task_id=task_id,
                        force_private=bool(action_history.secret_redaction_state().get("secret_redaction_refs")),
                        state=_pause_continuity_state({
                            "payment_request": payment_request,
                            "write_lock_notification": payment_write_lock_notification,
                        }),
                    )),
                }
                browser_task_paused_for_resume = True
                resume_result = _visible_activity_result(resume_result, operational_sources={
                    "payment_request": payment_operational_source,
                    "write_lock_notification": payment_notification_operational_source,
                })
                return resume_result

            if result.get("success", True):
                awaiting_observation_checkpoint = _preserve_observed_interaction_for_verifier(
                    action_name=action_name,
                    succeeded=True,
                    awaiting_observation=awaiting_observation_checkpoint,
                    observed_state=observe_page_state,
                    current_url=current_url,
                    verifier_checkpoints=verifier_checkpoints,
                )
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
                # Preserve the same masked observation for credential classification.
                # Metadata is not repeated in the parent planner's tool text.
                if action_name == "read_browser_state" and result.get("formatted_state"):
                    extra_metadata = {**(extra_metadata or {}), "browser_observation": result["formatted_state"]}
                await _save_browser_action_message(
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
                await _save_browser_action_message(
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

            # Observation-only tools (read_browser_state) replaced free per-turn
            # DOM injection — refund the step so they do not burn the action
            # budget. Single-character input_text/press_key appends are the
            # same class: the tool already types char-by-char internally, so
            # counting each keystroke against MAX_ITERATIONS makes ordinary
            # form fills miss Submit (065aee2c / browser-biometrics-webdecoy).
            # Cap consecutive refunds so a stuck model still terminates.
            prior_iteration = iteration
            iteration, consecutive_budget_free, consecutive_keystroke_free = (
                adjust_iteration_after_action(
                    iteration=iteration,
                    action_name=action_name,
                    consecutive_budget_free=consecutive_budget_free,
                    action_params=unified_action.get("params") or {},
                    consecutive_keystroke_free=consecutive_keystroke_free,
                )
            )
            if iteration != prior_iteration:
                logger.info(
                    (
                        "Observation action did not consume step budget"
                        if str(action_name or "").strip().lower()
                        == "read_browser_state"
                        else "Keystroke continuation did not consume step budget"
                    ),
                    action=action_name,
                    iteration=iteration,
                    consecutive_budget_free=consecutive_budget_free,
                    consecutive_keystroke_free=consecutive_keystroke_free,
                )

            step_timer.mark("post_action_bookkeeping")

        step_timer.finish()
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
                await sync_user_instructions(require_current_schema=True)
                # Re-read the FINAL-state DOM before grading: browser_state was
                # captured before the last action, so verifying against it evaluates
                # stale ground truth and can misreport a last-step completion. Fall
                # back to the last-known state if the refresh fails.
                try:
                    # Same final-state evidence as the attempt_completion
                    # verifier, including the rendered screenshot.
                    final_browser_state = await asyncio.wait_for(
                        dom_service.get_browser_state(include_screenshot=True),
                        timeout=10,
                    )
                    current_url = _private_browser_runtime_url(dom_service, final_browser_state.get("url") or current_url)
                except Exception:
                    # Last-known loop observation — prefer a stale-but-real page
                    # over skipping synthesis entirely when the refresh freezes.
                    final_browser_state = (
                        observe_page_state if isinstance(observe_page_state, dict) else {}
                    )
                if not final_browser_state:
                    raise RuntimeError("no browser_state available for final verifier pass")
                final_verifier_context = await build_browser_verifier_context(
                    goal=goal,
                    current_url=current_url,
                    browser_state=final_browser_state,
                    user_instruction_messages=user_instruction_messages,
                    action_history=action_history,
                    config=config,
                    session_id=session_id,
                    browser_checkpoints=verifier_checkpoints,
                )
                if hasattr(dom_service, "model_visible_value"):
                    final_verifier_context = _model_visible_browser_verifier_context(final_verifier_context, dom_service, final_browser_state)
                final_remote_schema = transform_schema_for_remote_session(
                    _model_visible_browser_output_schema(response_schema, _redact_activity_value)
                )
                final_verifier_prompt = build_verifier_prompt(response_schema=final_remote_schema)
                verification_instruction_count = len(user_instruction_messages)
                final_progress = await call_temporal_activity_from_activity(
                    check_progress,
                    args=[
                        final_verifier_context,
                        final_verifier_prompt,
                        VERIFIER_ULTRA_MODEL,
                        final_remote_schema,
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
                        bool(fast_mode_cache_enabled),
                        goal if fast_mode_cache_enabled else None,
                        int(iteration or 0),
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
                    cache_sequence_id=fv_usage.get("cache_sequence_id"),
                )
                await sync_user_instructions(require_current_schema=True)
                if (
                    verification_instruction_count == len(user_instruction_messages)
                    and int(instruction_state.get("schema_user_instruction_count") or 0) >= len(user_instruction_messages)
                    and final_progress.get("structured_response") is not None
                ):
                    latest_structured_response = final_progress["structured_response"]
            except (BrowserInstructionUnavailableError, WorkflowGenerationSealed):
                raise
            except Exception as final_verifier_error:
                logger.warning(
                    "[BrowserAgent] Final max-steps verifier pass failed; returning best-effort text only",
                    agent_id=agent_id,
                    error=extract_error_message(final_verifier_error),
                )

        await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
        dom_service = None
        await _close_browser_with_cleanup_receipt(session_id, pause=False)

        context_message = build_context_summary(
            success=False,
            close_reasoning=f"Max iterations ({MAX_ITERATIONS}) reached",
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            goal=goal,
        )

        await _save_browser_action_message(
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
            extra_metadata={"browser_cleanup": cleanup_failure} if cleanup_failure else None,
        )

        execution_time_ms = (safe_time() - start_time) * 1000
        usage_items = build_usage_items(
            total_input_tokens,
            total_output_tokens,
            model_pricing,
            execution_time_ms,
            usage_by_model,
            pricing_pool=browser_pool,
            fast_mode_cache_enabled=bool(fast_mode_cache_enabled),
            provider=browser_session_metadata.get("provider"),
            session_creates=tilion_creates["count"],
        )
        await _propagate_browser_credentials_with_progress(
            redact=_redact_activity_value,
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

        return _visible_activity_result({
            "status": "max_iterations",
            "success": False,
            **({"browser_cleanup": cleanup_failure} if cleanup_failure else {}),
            "message": context_message,
            "browser_url": redact_url_secrets(browser_url),
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms,
            "structured_response": latest_structured_response,
            "best_effort_response": best_effort_response,
            "browser_output_schema": response_schema,
        })

    except asyncio.CancelledError as cancellation:
        logger.info("\U0001f534 Browser agent activity cancelled (paused)")

        if isinstance(cancellation, _BrowserSessionPreparationCancelled):
            prepared = cancellation.session_data
            if (
                isinstance(prepared, dict)
                and isinstance(prepared.get("task_id"), str)
                and (task_id is None or prepared["task_id"] == task_id)
                and isinstance(prepared.get("session_id"), str)
                and prepared["session_id"]
            ):
                task_id = prepared["task_id"]
                session_id = prepared["session_id"]
                browser_url = prepared.get("debug_url")
                browser_session_metadata = prepared.get("browser_session_metadata") or {}
                provider = browser_session_metadata.get("provider")
                if provider in {"kernel", "steel", "browser-use", "tilion"}:
                    preparation_cancellation = {
                        "version": 1,
                        "agent_id": agent_id,
                        "task_id": task_id,
                        "tool_call_id": tool_call_id,
                        "session_id": session_id,
                        "provider": provider,
                        "phase": "initial_session_preparation",
                        "init_acknowledged": True,
                        "task_actions_started": False,
                    }

        if dom_service:
            with contextlib.suppress(Exception):
                await disconnect_browser_after_passkey_capture(dom_service, record_passkey_usage_once)
                dom_service = None

        if session_id and cleanup_failure is None:
            await _close_browser_with_cleanup_receipt(session_id, pause=True, current_url=current_url)

        if task_id:
            with _suppress_browser_cleanup_errors():
                await _save_browser_action_message(
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
                    extra_metadata={"browser_cleanup": cleanup_failure} if cleanup_failure else None,
                )

        return {
            "status": "cancelled",
            "task_id": task_id,
            "session_id": session_id,
            "browser_url": redact_url_secrets(browser_url),
            "message": "Browser agent cancelled by user",
            **({"browser_cleanup": cleanup_failure} if cleanup_failure else {}),
        }

    except WorkflowGenerationSealed:
        generation_sealed = True
        raise
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

        if session_id and cleanup_failure is None:
            retryable_notification_error = isinstance(e, PurchaseApprovalNotificationRetryableError)
            await _close_browser_with_cleanup_receipt(
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
            goal=goal,
        )

        error_message = _redact_activity_value(error_message)

        if task_id:
            with _suppress_browser_cleanup_errors():
                await _save_browser_action_message(
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
                        **({"browser_cleanup": cleanup_failure} if cleanup_failure else {}),
                        "browser_error_type": e.original_error_type if isinstance(e, BrowserInstructionUnavailableError) else type(e).__name__,
                        "browser_error_message": extract_error_message(e),
                        "browser_error_context": error_context,
                        "browser_last_action": last_action,
                        "browser_current_url": current_url,
                    },
                )
            try:
                await _propagate_browser_credentials_with_progress(
                    redact=_redact_activity_value,
                    config=config,
                    agent_id=agent_id,
                    task_id=task_id,
                    browser_url=browser_url or "",
                    status="error",
                    success=False,
                    message=error_message,
                )
            except WorkflowGenerationSealed:
                raise
            except Exception as propagation_error:
                logger.warning(
                    "Credential propagation failed after browser error; preserving original browser error",
                    error=extract_error_message(propagation_error),
                )

        if isinstance(e, BrowserInstructionUnavailableError):
            execution_time_ms = (safe_time() - start_time) * 1000
            return _visible_activity_result({
                "status": "failed", "success": False, "error": True,
                "message": error_message, "task_id": task_id, "session_id": session_id,
                "browser_error_type": e.original_error_type,
                "browser_error_message": extract_error_message(e),
                "browser_output_schema": response_schema, "structured_response": None,
                "usage_items": build_usage_items(
                    total_input_tokens, total_output_tokens, model_pricing,
                    execution_time_ms, usage_by_model, pricing_pool=browser_pool,
                    fast_mode_cache_enabled=bool(fast_mode_cache_enabled),
                    provider=browser_session_metadata.get("provider"),
                    session_creates=tilion_creates["count"],
                ),
                "execution_time_ms": execution_time_ms,
            })
        safe_error = _redact_browser_activity_error(e, _redact_activity_value)
        if safe_error is e:
            raise
        raise safe_error from None

    finally:
        try:
            generation_sealed = generation_sealed or isinstance(sys.exception(), WorkflowGenerationSealed)
            if generation_sealed and otp_poll_task is not None:
                otp_poll_task.cancel()
            stop_browser_activity_heartbeat(_heartbeat_token)
            otp_generation_error = None
            try:
                await _drain_otp_poll(otp_poll_task)
            except WorkflowGenerationSealed as error:
                # Finish local resource cleanup before propagating the stop signal.
                otp_generation_error = error
                generation_sealed = True
            state_prefetch.discard()
            diagnostics_finalized = False
            if not generation_sealed and browser_network_recorder is None and network_recorder_task is not None:
                try:
                    browser_network_recorder = await asyncio.wait_for(
                        asyncio.shield(network_recorder_task),
                        timeout=10,
                    )
                except WorkflowGenerationSealed as error:
                    generation_sealed = True
                    otp_generation_error = error
                    if otp_poll_task is not None:
                        otp_poll_task.cancel()
                except Exception as diagnostics_resolve_error:
                    logger.warning(
                        "Browser diagnostics recorder was unavailable before activity return",
                        agent_id=agent_id,
                        task_id=task_id,
                        error=extract_error_message(diagnostics_resolve_error),
                    )
            if not generation_sealed and browser_network_recorder is not None:
                try:
                    await _finalize_browser_diagnostics_for_fe(
                        browser_network_recorder=browser_network_recorder,
                        agent_id=agent_id,
                        task_id=task_id,
                        user_id=user_id,
                        browser_url=browser_url,
                    )
                    diagnostics_finalized = True
                except WorkflowGenerationSealed as error:
                    generation_sealed = True
                    otp_generation_error = error
                    if otp_poll_task is not None:
                        otp_poll_task.cancel()
                except Exception as diagnostics_error:
                    logger.warning(
                        "Browser diagnostics finalization failed before activity return",
                        agent_id=agent_id,
                        task_id=task_id,
                        error=extract_error_message(diagnostics_error),
                    )
            if generation_sealed and download_persister_task is not None:
                if download_persister_task.done() and not download_persister_task.cancelled():
                    with contextlib.suppress(Exception):
                        browser_download_persister = download_persister_task.result()
                else:
                    download_persister_task.cancel()
            if not generation_sealed and browser_download_persister is None and download_persister_task is not None:
                try:
                    browser_download_persister = await asyncio.wait_for(
                        asyncio.shield(download_persister_task),
                        timeout=10,
                    )
                except WorkflowGenerationSealed as error:
                    generation_sealed = True
                    otp_generation_error = error
                    if otp_poll_task is not None:
                        otp_poll_task.cancel()
                except Exception:
                    pass
            if browser_download_persister is not None:
                with contextlib.suppress(Exception):
                    await browser_download_persister.close()
            # Worker-held Tilion uploads/downloads end with the activity that
            # extracted them; keep worker RSS bounded.
            release_tilion_session_files(session_id)
            _schedule_browser_cleanup(
                agent_id=agent_id,
                preparation_cancellation=preparation_cancellation,
                cleanup_failure=cleanup_failure,
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
                tool_call_id=tool_call_id,
                # Happy-path / error handlers already post task_complete before
                # finally. CancelledError also posts one, but force-cancel and
                # hub-archive races still need cleanup as the terminal safety net.
                # Pause-for-resume returns must keep the FE chip open for the next
                # activity call (write / payment / auth assistance).
                emit_task_terminal=not browser_task_paused_for_resume and not generation_sealed,
                local_only=generation_sealed,
                local_only_recorders=locally_owned_recorders,
                local_only_setup_tasks=(download_persister_task,),
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
                    browser_turn_messages,
                    otp_user_messages,
                    seen_otp_codes,
                    pending_otp_ref_messages,
                    otp_credential_refs,
                    visited_urls,
                    reasoning_messages,
                    action_summary,
                    session_passwords,
                    session_passkeys,
                    available_file_paths,
                    passkey_ref_by_credential_id,
                    browser_session_metadata,
                ),
            )
            if otp_generation_error is not None:
                raise otp_generation_error
        except Exception as cleanup_error:
            safe_error = _redact_browser_activity_error(cleanup_error, _redact_activity_value)
            if safe_error is cleanup_error:
                raise
            raise safe_error from None
        finally:
            _secret_log_scope.__exit__(None, None, None)


# ========================================
# WORKFLOW HELPER & MANAGER
# ========================================


def _browser_abandoned_resume_event(task_id: str, reason: str) -> ToolEvent:
    """Close a browser task when its manager abandons a pending resume.

    Activity cleanup intentionally leaves approval/auth tasks open for a later
    activity call. If the manager returns instead, it owns the terminal event.
    """
    return ToolEvent(
        type=EventType.POST_MESSAGE,
        title="Browser automation stopped",
        message=reason,
        status=MessageStatus.ERROR,
        metadata={
            "toolName": "spawn_browser_agent",
            "action_type": "task_complete",
            "task_id": task_id,
            "excludeFromModel": True,
        },
    )


def _browser_resume_was_paused(workflow_instance: Any, pause_sequence: Optional[int] = None) -> bool:
    return workflow_instance.is_paused or (
        pause_sequence is not None
        and getattr(workflow_instance, "_pause_signal_sequence", 0) != pause_sequence
    )


class _BrowserPaymentResumeAbandoned(Exception):
    """An interrupted payment approval no longer authorizes another card mint."""


async def _request_browser_write_approval_until_paused(
    workflow_instance: Any, *, pause_sequence: int, **approval_kwargs
):
    """End an exact deferred browser resume on PAUSE without inventing rejection."""
    if _browser_resume_was_paused(workflow_instance, pause_sequence) and not approval_kwargs.get("resume_request"):
        return None
    from tools.request_user_approval import request_user_approval_direct

    approval = asyncio.create_task(
        request_user_approval_direct(workflow_instance, **approval_kwargs, close_on_cancel=True)
    )
    # cutover-class: primitive — joined companion of the handoff-aware approval wait
    pause = asyncio.create_task(
        workflow.wait_condition(lambda: _browser_resume_was_paused(workflow_instance, pause_sequence))
    )
    try:
        await asyncio.wait({approval, pause}, return_when=asyncio.FIRST_COMPLETED)
        if _browser_resume_was_paused(workflow_instance, pause_sequence) and not approval.done():
            approval.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await approval
            return None
        response = await approval
        return None if _browser_resume_was_paused(workflow_instance, pause_sequence) else response
    finally:
        for owned in (approval, pause):
            if not owned.done():
                owned.cancel()
        await asyncio.gather(approval, pause, return_exceptions=True)


class SpawnBrowserAgentManagerV3(ToolManager):
    """Manager using browser-use BrowserSession + Rose API."""

    tool_name = "spawn_browser_agent"

    async def execute_tool(
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
        if hasattr(workflow_instance, "context"):
            context_attachments = extract_attachments_from_context(workflow_instance.context)
            filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

            def _fp_dict(fp: Any) -> Dict[str, Any]:
                return {
                    "id": fp.id,
                    "storage_path": fp.storage_path,
                    "original_filename": fp.original_filename,
                    "mime_type": fp.mime_type,
                    "size_bytes": fp.size_bytes,
                    "created_at": fp.created_at,
                }

            if requested_attachments:
                if isinstance(requested_attachments, str):
                    requested_attachments = [requested_attachments]
                for filename in requested_attachments:
                    if filename in filename_to_pointer:
                        attachments.append(_fp_dict(filename_to_pointer[filename]))
                    else:
                        logger.warning(
                            "[BrowserAgent] Attachment not found in context",
                            agent_id=agent_id,
                            filename=filename,
                            available_files=list(filename_to_pointer.keys()),
                        )
                # Wrong/missing names previously left available_files empty so
                # upload_file could never succeed. Fall back to every parent
                # attachment when nothing matched.
                if not attachments and filename_to_pointer:
                    logger.warning(
                        "[BrowserAgent] No requested attachments matched; "
                        "falling back to all parent context attachments",
                        agent_id=agent_id,
                        requested=requested_attachments,
                        available_files=list(filename_to_pointer.keys()),
                    )
                    attachments = [_fp_dict(fp) for fp in filename_to_pointer.values()]
            elif filename_to_pointer:
                # Parent omitted attachments but context has files — forward them
                # so upload tasks (e.g. tinypng) do not spawn with an empty set.
                logger.info(
                    "[BrowserAgent] No attachments requested; forwarding parent context files",
                    agent_id=agent_id,
                    available_files=list(filename_to_pointer.keys()),
                )
                attachments = [_fp_dict(fp) for fp in filename_to_pointer.values()]

        # A previous generation parked this exact tool call across a deploy
        # (continue_as_new). Its chip is still open; resume from the parked
        # state instead of starting a new browser task.
        resume_hint = take_tool_resume(workflow_instance, tool_call_id)
        auth_pause_sequence = (resume_hint or {}).get(
            "auth_pause_signal_sequence", getattr(workflow_instance, "_pause_signal_sequence", 0)
        )

        logger.info(
            "Browser agent starting (v3)",
            goal=goal,
            has_output_schema=output_schema is not None,
            num_attachments=len(attachments),
            resumed_phase=(resume_hint or {}).get("phase"),
        )

        if resume_hint is None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Starting up a browser",
                message="",
                status=MessageStatus.IN_PROGRESS,
                metadata={"toolName": "spawn_browser_agent", "action_type": "session_starting"},
            )

        result = None
        activity_task_id: Optional[str] = None
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
            parked_result = None
            parked_approval = None
            if resume_hint is not None:
                write_lock_resume_state = resume_hint.get("write_lock_resume_state")
                current_start_url = resume_hint.get("current_start_url") or start_url
                parked_result = resume_hint.get("parked_result")
                parked_approval = resume_hint.get("approval")

            def park_browser_task(phase: str, resume_state: Optional[Dict[str, Any]], **parked: Any) -> bool:
                return park_pending_tool(
                    workflow_instance,
                    tool_call_id,
                    {
                        "phase": phase,
                        "write_lock_resume_state": resume_state,
                        "current_start_url": current_start_url,
                        **parked,
                    },
                )

            def park_browser_approval(phase: str, pause_sequence: int) -> Callable[[Dict[str, str]], bool]:
                # The approval branches only read the card refs from the prior
                # resume state; the paused result carries everything else.
                def park(approval: Dict[str, str]) -> bool:
                    return park_browser_task(
                        phase,
                        _payment_resume_fields(write_lock_resume_state),
                        parked_result=result,
                        approval=approval,
                        approval_pause_signal_sequence=pause_sequence,
                    )

                return park

            while True:
                reentered_pause = parked_result is not None
                if reentered_pause:
                    # Re-enter the pause branch the previous generation parked in
                    # (approval / auth wait) without running the activity again.
                    result, parked_result = parked_result, None
                    was_cancelled = False
                    known_task_id = result.get("task_id") or _stable_browser_task_id(agent_id, tool_call_id)
                    activity_task_id = known_task_id
                else:
                    known_task_id = (
                        write_lock_resume_state.get("task_id") if isinstance(write_lock_resume_state, dict) else None
                    ) or _stable_browser_task_id(agent_id, tool_call_id)
                    activity_args = [
                        user_id,
                        agent_id,
                        goal,
                        tool_call_id,
                        known_task_id,
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
                        bool(getattr(workflow_instance, "fast_mode_cache_enabled", False)),
                    ]
                    world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
                    activity_args.append(world_model_mode if world_model_mode != "real" else None)
                    activity_args.append(getattr(workflow_instance, "model", None))
                    async with span(
                        "browser_activity_wait",
                        agent_id=agent_id,
                        tool_call_id=tool_call_id,
                        tool_name="spawn_browser_agent",
                        is_resume=write_lock_resume_state is not None,
                        span_source="agents.domains.spawn_browser_agent_v3.handler.SpawnBrowserAgentManagerV3.execute",
                        span_key="agents.domains.spawn_browser_agent_v3.handler.SpawnBrowserAgentManagerV3.execute",
                    ):
                        fm_enabled = bool(getattr(workflow_instance, "fast_mode_cache_enabled", False))
                        browser_timeout_minutes = browser_start_to_close_timeout_minutes(
                            fast_mode=fm_enabled,
                            goal=goal,
                            workflow_instance=workflow_instance,
                        )
                        activity_handle = workflow.start_activity(
                            spawn_browser_agent_activity_v3,
                            args=activity_args,
                            start_to_close_timeout=timedelta(minutes=browser_timeout_minutes),
                            heartbeat_timeout=timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS),
                            cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                            retry_policy=RetryPolicy(maximum_attempts=MAX_ACTIVITY_ATTEMPTS),
                        )
                        activity_task_id = known_task_id

                        was_cancelled = False
                        # The workflow allocates task_id before starting the activity,
                        # so TRY_CANCEL cannot erase the ownership key along with the
                        # activity return value.
                        # cutover-class: activity-bound — cannot continue_as_new until browser activity ends
                        await workflow.wait_condition(
                            lambda handle=activity_handle: handle.done() or workflow_instance.is_paused
                        )
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
                            if known_task_id:
                                result["task_id"] = known_task_id

                    pause_usage_items = (result or {}).get("usage_items")
                    if (result or {}).get("status") in _BROWSER_PAUSE_STATUSES and pause_usage_items:
                        # Each activity call reports only its own tokens; a paused
                        # call's usage is billed here because the final result
                        # will not include it.
                        yield ToolEvent(
                            type=EventType.USAGE,
                            data={"usage": browser_usage_items_to_tool_usage(pause_usage_items)},
                        )

                if was_cancelled or (result and result.get("status") == "cancelled"):
                    logger.info("\U0001f534 Browser agent cancelled")
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Browser Session Paused",
                        message="User paused the browser agent",
                        status=MessageStatus.ERROR,
                        metadata=_browser_task_terminal_metadata(result, activity_task_id),
                    )
                    return

                if result and result.get("status") == BROWSER_DRAIN_YIELD_STATUS:
                    # The activity checkpointed at a step boundary because a deploy
                    # is draining its worker or superseded its generation. Restart
                    # it from that step: on a live worker of this queue, or on the
                    # live generation after continue_as_new carries this tool call.
                    write_lock_resume_state = _drain_resume_state(result, write_lock_resume_state)
                    handoff_queue = await live_handoff_queue(workflow_instance)
                    if handoff_queue:
                        if park_browser_task(
                            "activity",
                            {k: v for k, v in write_lock_resume_state.items() if k != "generation_yield"},
                        ):
                            logger.info(
                                "Browser task parked for generation handoff",
                                agent_id=agent_id,
                                task_id=result.get("task_id"),
                                step_count=result.get("step_count"),
                                yield_reason=result.get("yield_reason"),
                                handoff_task_queue=handoff_queue,
                            )
                            raise GenerationHandoffRequested(handoff_queue, parked=True)
                        # Parking is unavailable here (DAG turn or payload budget):
                        # finish on this generation instead of yielding every step.
                        write_lock_resume_state["generation_yield"] = False
                    logger.info(
                        "Browser task drained at a step boundary; restarting from the same step",
                        agent_id=agent_id,
                        task_id=result.get("task_id"),
                        step_count=result.get("step_count"),
                        yield_reason=result.get("yield_reason"),
                        generation_yield=write_lock_resume_state.get("generation_yield", True),
                    )
                    continue

                if result and result.get("status") == "awaiting_write_approval":
                    write_pause_sequence = getattr(workflow_instance, "_pause_signal_sequence", 0)
                    if reentered_pause:
                        write_pause_sequence = (resume_hint or {}).get(
                            "approval_pause_signal_sequence", write_pause_sequence
                        )
                    logger.info(
                        "Browser agent needs write lock approval",
                        approval_type=result.get("approval_type"),
                        url=result.get("current_url"),
                    )

                    from tools.request_user_approval import UserRejectedError

                    try:
                        approval_resume, parked_approval = parked_approval, None
                        approval_response = await _request_browser_write_approval_until_paused(
                            workflow_instance,
                            pause_sequence=write_pause_sequence,
                            question=result["question"],
                            metadata={
                                "toolApproval": True,
                                "writePermission": True,
                                "browserTaskId": result.get("task_id") or known_task_id,
                                "url": result.get("current_url", ""),
                                "writeLockNotification": result.get("write_lock_notification"),
                                "writeLockNotificationUsage": result.get("write_lock_notification_usage"),
                            },
                            park=park_browser_approval("write_approval", write_pause_sequence),
                            resume_request=approval_resume,
                        )
                        if approval_response is None:
                            yield _browser_abandoned_resume_event(
                                result.get("task_id") or known_task_id,
                                "Browser paused while awaiting write approval.",
                            )
                            return

                        approval_type = result.get("approval_type", "unknown")
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
                        # Purchase grants unlock the merchant for this activity
                        # (same helper as payment-card). Typed-only 120s expiry
                        # re-prompted Amazon Buy Now after auth/address friction
                        # (agent 2c475824).
                        prior_resume = write_lock_resume_state or {}
                        prior_payment_refs = prior_resume.get("payment_card_refs")
                        prior_payment_last4 = prior_resume.get("payment_card_last4")
                        current_approvals = apply_user_write_lock_grant(
                            result.get("write_lock_approvals"),
                            approval_type,
                            grant_url,
                            approved_at,
                            prior_payment_refs=prior_payment_refs,
                        )

                        write_lock_resume_state = {
                            "pending_action": result.get("pending_action"),
                            "pending_action_target": result.get("pending_action_target"),
                            "write_lock_approvals": current_approvals,
                            "write_lock_approved_at": approved_at,
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
                                # Progress, not a terminal: the browser task
                                # resumes on the same session right after this.
                                "action_type": "write_lock_granted",
                                "task_id": write_lock_resume_state.get("task_id"),
                                "requestUserApproval": {
                                    "writePermission": True,
                                    "attentionRequestId": approval_response.get("attention_request_id"),
                                },
                            },
                        )
                        if (
                            workflow_instance.is_paused
                            or getattr(workflow_instance, "_pause_signal_sequence", 0) != write_pause_sequence
                        ):
                            yield _browser_abandoned_resume_event(
                                result.get("task_id") or known_task_id,
                                "Browser paused before resuming the approved action.",
                            )
                            return

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
                            metadata=_browser_task_terminal_metadata(
                                result, activity_task_id, code="write_lock_rejected"
                            ),
                        )
                        return

                if result and result.get("status") == "awaiting_payment_card_approval":
                    from tools.request_user_approval import request_user_attention_direct

                    payment_pause_sequence = getattr(workflow_instance, "_pause_signal_sequence", 0)
                    if reentered_pause:
                        payment_pause_sequence = (resume_hint or {}).get(
                            "approval_pause_signal_sequence", payment_pause_sequence
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
                    if lookup_result.get("usageItems"):
                        yield ToolEvent(
                            type=EventType.USAGE,
                            data={"usage": browser_usage_items_to_tool_usage(lookup_result["usageItems"])},
                        )
                    if lookup_result.get("error"):
                        raise RuntimeError(str(lookup_result["error"]))
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

                    approval_resume, parked_approval = parked_approval, None
                    approval_response = reuse_payment_approval(
                        lookup_result, payment_payload, workflow_instance.agent_id, approval_resume
                    ) or await _request_browser_write_approval_until_paused(
                        workflow_instance,
                        pause_sequence=payment_pause_sequence,
                        question=build_payment_question(payment_payload),
                        metadata={
                            "toolApproval": True,
                            "writePermission": True,
                            "browserTaskId": result.get("task_id") or known_task_id,
                            "url": result.get("current_url", "")
                            or current_start_url
                            or start_url,
                            "requestPaymentCard": payment_payload,
                            "writeLockNotification": result.get("write_lock_notification"),
                            "writeLockNotificationUsage": result.get("write_lock_notification_usage"),
                            "reusablePurchase": bool(lookup_result.get("reusable")),
                        },
                        park=park_browser_approval("payment_approval", payment_pause_sequence),
                        resume_request=approval_resume,
                    )
                    if approval_response is None:
                        yield _browser_abandoned_resume_event(
                            result.get("task_id") or known_task_id,
                            "Browser paused while awaiting payment approval.",
                        )
                        return
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
                            if _browser_resume_was_paused(workflow_instance, payment_pause_sequence):
                                raise _BrowserPaymentResumeAbandoned
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
                            await sleep_or_generation_handoff(
                                workflow_instance, retry_seconds, workflow_mod=workflow
                            )

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
                        setup_metadata: Dict[str, Any] = {
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
                        }
                        if waited_for_agentcard_setup:
                            setup_metadata.update(
                                _browser_task_terminal_metadata(
                                    result, activity_task_id, code=setup_metadata["action_type"]
                                )
                            )
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title=setup_info["setup_title"],
                            message=setup_info["setup_question"],
                            status=MessageStatus.FINISHED,
                            metadata=setup_metadata,
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
                            await sleep_or_generation_handoff(
                                workflow_instance, 5, workflow_mod=workflow
                            )

                        if not agentcard_status_result.get("connected"):
                            logger.info(
                                "Timed out waiting for AgentCard setup",
                                agentcard_status=setup_info["agentcard_status"],
                                attention_request_id=setup_info["setup_attention"].get("attention_request_id"),
                            )
                            yield ToolEvent(
                                type=EventType.POST_MESSAGE,
                                title="Agent payment setup not completed",
                                message="",
                                status=MessageStatus.FINISHED,
                                metadata={
                                    **_browser_task_terminal_metadata(
                                        result, activity_task_id, code="agentcard_setup_timed_out"
                                    ),
                                    # The setup request above stays the parent's tool result.
                                    "excludeFromModel": True,
                                },
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

                    # Over-limit: mint exceeded MAX_PURCHASE_CENTS. Hard tool error —
                    # do NOT raise a subscribe gate (that mislabel hung agents that
                    # simply asked for a cart larger than the org-wallet float).
                    if card.get("status") == "purchase_above_max_limit":
                        limit = card.get("maxPurchaseCents")
                        if isinstance(limit, int):
                            dollars = limit / 100
                            limit_text = f" of ${dollars:.2f} ({limit} cents)"
                        else:
                            limit_text = ""
                        message = str(
                            card.get("error")
                            or f"Purchase is above max limit{limit_text}."
                        )
                        # action_type must be a FE-terminal browser action
                        # (task_complete / session_paused / write_lock_rejected)
                        # or the live browser chip stays open after we return.
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title="Purchase above max limit",
                            message=message,
                            status=MessageStatus.ERROR,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "task_id": result.get("task_id"),
                                "action_type": "task_complete",
                                "code": "purchase_above_max_limit",
                                "maxPurchaseCents": limit,
                            },
                        )
                        return

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
                                metadata=_browser_task_terminal_metadata(
                                    result, activity_task_id, code="purchase_cancelled"
                                ),
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
                                metadata=_browser_task_terminal_metadata(
                                    result, activity_task_id, code="purchase_blocked"
                                ),
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
                                metadata=_browser_task_terminal_metadata(
                                    result, activity_task_id, code="purchase_cancelled"
                                ),
                            )
                            return

                        card = await mint_payment_card()
                        if card.get("status") == "kyc_required":
                            yield ToolEvent(
                                type=EventType.POST_MESSAGE,
                                title="Identity verification still incomplete",
                                message="I couldn't confirm completed identity verification yet, so I can't issue the card.",
                                status=MessageStatus.FINISHED,
                                metadata=_browser_task_terminal_metadata(
                                    result, activity_task_id, code="purchase_blocked"
                                ),
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
                            metadata=_browser_task_terminal_metadata(
                                result, activity_task_id, code="purchase_funding_delayed"
                            ),
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

                    payment_card_last4 = _normalize_payment_card_last4(card.get("last4"))
                    write_lock_resume_state = {
                        "pending_action": None,
                        "write_lock_approvals": current_approvals,
                        "write_lock_approved_at": workflow.now().timestamp(),
                        "approval_type": "payment",
                        "step_count": result.get("step_count", 0),
                        "session_id": result.get("session_id"),
                        "cdp_url": result.get("cdp_url"),
                        "task_id": result.get("task_id"),
                        "auth_realm": result.get("auth_realm"),
                        "payment_card_refs": payment_card_refs,
                        "payment_card_last4": payment_card_last4,
                        "recorded_passkey_credential_ids": result.get("recorded_passkey_credential_ids", []),
                    }
                    _copy_browser_resume_continuity_fields(result, write_lock_resume_state)
                    _copy_simulated_browser_resume_fields(result, write_lock_resume_state)
                    # Parked activity left request_payment_card as awaiting; mint finished —
                    # complete that tool outcome before the resumed browser model reads history.
                    finalize_parked_payment_card_approval_history(
                        write_lock_resume_state,
                        last4=payment_card_last4,
                    )

                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="Payment card ready",
                        message=f"One-time card ending in {card.get('last4', '****')} is ready for checkout.",
                        status=MessageStatus.FINISHED,
                        metadata={
                            "toolName": "spawn_browser_agent",
                            # Progress, not a terminal: the browser task resumes
                            # on the same session right after this event.
                            "action_type": "payment_card_ready",
                            "task_id": result.get("task_id"),
                            "requestUserApproval": {
                                "writePermission": True,
                                "attentionRequestId": approval_response.get("attention_request_id"),
                                "requestPaymentCard": payment_payload,
                            },
                        },
                    )
                    if _browser_resume_was_paused(workflow_instance, payment_pause_sequence):
                        yield _browser_abandoned_resume_event(
                            result.get("task_id") or known_task_id,
                            "Browser paused before resuming the approved payment.",
                        )
                        return

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

                    if not reentered_pause:
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title=f"Requesting User Assistance for {base_site} Login",
                            message="",
                            status=MessageStatus.IN_PROGRESS,
                            metadata={
                                "toolName": "spawn_browser_agent",
                                "action_type": "auth_assistance",
                                "browser_page_observation": result.get("browser_page_observation"),
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
                            metadata=_browser_task_terminal_metadata(
                                result, activity_task_id, code="auth_assistance_failed"
                            ),
                        )
                        return

                    if getattr(workflow_instance, "_pause_signal_sequence", 0) != auth_pause_sequence:
                        yield _browser_abandoned_resume_event(
                            result.get("task_id") or known_task_id,
                            "Browser paused while awaiting authentication assistance.",
                        )
                        return
                    workflow_instance.is_paused = True
                    if hasattr(workflow_instance, "_update_tree_state"):
                        await workflow_instance._update_tree_state(status="PAUSED")

                    try:
                        await wait_condition_or_generation_handoff(
                            lambda request_id=request_id: (
                                request_id in getattr(workflow_instance, "_signal_responses", {})
                                or not workflow_instance.is_paused
                                or getattr(workflow_instance, "_pause_signal_sequence", 0) != auth_pause_sequence
                            ),
                            workflow_instance,
                            workflow_mod=workflow,
                        )
                    except GenerationHandoffRequested as exc:
                        # The live-view handoff request stays open; the next
                        # generation re-waits on the same request id (signal
                        # responses and the paused state ride continue_as_new).
                        if park_browser_task(
                            "auth_assistance",
                            _payment_resume_fields(write_lock_resume_state),
                            parked_result=result,
                            auth_pause_signal_sequence=auth_pause_sequence,
                        ):
                            raise GenerationHandoffRequested(exc.task_queue, parked=True) from None
                        raise
                    if getattr(workflow_instance, "_pause_signal_sequence", 0) != auth_pause_sequence:
                        yield _browser_abandoned_resume_event(
                            result.get("task_id") or known_task_id,
                            "Browser paused while awaiting authentication assistance.",
                        )
                        return
                    user_declined = False
                    if request_id in getattr(workflow_instance, "_signal_responses", {}):
                        signal_response = workflow_instance._signal_responses.pop(request_id, None)
                        # A decline used to be read as "the user signed in": the
                        # task resumed on a signed-out page and asked again.
                        user_declined = (
                            isinstance(signal_response, str) and signal_response.strip() == REJECTION_SENTINEL
                        )
                        workflow_instance.is_paused = False
                        if hasattr(workflow_instance, "_update_tree_state"):
                            await workflow_instance._update_tree_state(status="ACTIVE")

                    prior_resume = write_lock_resume_state or {}
                    write_lock_resume_state = {
                        "pending_action": None,
                        "write_lock_approvals": result.get("write_lock_approvals", {}),
                        "approval_type": AUTH_ASSISTANCE_DECLINED if user_declined else "auth_assistance",
                        "step_count": result.get("step_count", 0),
                        "session_id": result.get("session_id"),
                        "cdp_url": result.get("cdp_url"),
                        "handoff_mode": result.get("handoff_mode"),
                        "task_id": result.get("task_id"),
                        "auth_realm": result.get("auth_realm"),
                        "recorded_passkey_credential_ids": result.get("recorded_passkey_credential_ids", []),
                    }
                    for payment_field in (
                        "payment_card_refs",
                        "payment_card_last4",
                    ):
                        if prior_resume.get(payment_field):
                            write_lock_resume_state[payment_field] = prior_resume[payment_field]
                    _copy_browser_resume_continuity_fields(result, write_lock_resume_state)
                    _copy_simulated_browser_resume_fields(result, write_lock_resume_state)

                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="User Declined To Sign In" if user_declined else "User Assistance Received",
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
                    if getattr(workflow_instance, "_pause_signal_sequence", 0) != auth_pause_sequence:
                        yield _browser_abandoned_resume_event(
                            result.get("task_id") or known_task_id,
                            "Browser paused before resuming authentication assistance.",
                        )
                        return

                    continue

                break

            tool_usage: Dict[str, list] = browser_usage_items_to_tool_usage(result.get("usage_items"))

            output_files = result.get("output_files", [])
            verified_completion = result.get("status") == "completed" and result.get("success") is True
            # A user declining sign-in help is a clean end, not a tool error: the
            # parent reports it instead of respawning the browser.
            user_declined_auth = bool(result.get("user_declined_auth"))
            final_status = (
                MessageStatus.FINISHED if verified_completion or user_declined_auth else MessageStatus.ERROR
            )
            # Declare terminality explicitly. The front-end must never have to
            # infer "this browser task is over" from a missing action_type — a
            # workflow-scope progress event would look identical.
            final_metadata = {
                "toolName": "spawn_browser_agent",
                "action_type": "task_complete",
                "success": verified_completion,
            }
            if user_declined_auth:
                final_metadata["authAssistanceDeclined"] = True
            for key in (
                "task_id",
                "browser_cleanup",
                "browser_error_type",
                "browser_error_message",
                "world_model_simulated",
                "world_model_session_id",
                "world_model_name",
                "simulated_browser_steps",
                "simulated_latest_frame",
            ):
                if result.get(key) is not None:
                    final_metadata[key] = result[key]
            final_output_schema = result.get("browser_output_schema") or output_schema
            if final_output_schema:
                final_metadata["output_schema"] = final_output_schema
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

        except _BrowserPaymentResumeAbandoned:
            yield _browser_abandoned_resume_event(
                result.get("task_id") or known_task_id,
                "Browser paused before resuming the approved payment.",
            )
        except GenerationHandoffRequested as exc:
            if not exc.parked:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Browser automation interrupted",
                    message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    status=MessageStatus.FINISHED,
                    metadata=_browser_task_terminal_metadata(result, activity_task_id),
                )
            raise
        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                raise

            last_result = result
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
                metadata=_browser_task_terminal_metadata(result, activity_task_id),
            )


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
