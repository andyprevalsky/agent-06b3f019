"""Handler for spawn-browser-agent-v3 domain.

Thin entry point: Temporal activity function and ToolManager.
Parses input, delegates to service layer, formats output.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import random
import json
import os
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
from helpers.messages import stream_browser_cursor
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.tracing import span, traced
from loop.activity_helper import call_temporal_activity_from_activity
from providers.fast_cache.browser_use_cache import cached_browser_decision
from providers.fast_cache.context import write_through_enabled_for_user
from providers.rose import ClaudeAuthContext, GptAuthContext, RoseClient
from providers.rose.browser_use import build_browser_state_message_content
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
from .recording import BrowserAgentRecorder, BrowserNetworkRecorder, browser_recording_output_dir
from .repo import (
    close_browser_session,
    create_user_auth_assistance_request,
    fetch_auth_options,
    fetch_claude_token,
    fetch_session_info,
    init_browser_session,
    inject_local_storage,
    list_session_files,
    propagate_browser_run_credentials,
    report_claude_token_rate_limited,
    resume_browser_session,
    save_browser_action_message,
    save_browser_assistant_message,
    save_browser_credential_ref_message,
    upload_file_to_session,
)
from .service import (
    AuthRuntimeState,
    build_action_titles,
    build_auth_assistance_resume_user_message,
    build_browser_dynamic_system_context,
    build_browser_task_prompt,
    build_context_summary,
    build_usage_items,
    extract_session_files,
    safe_time,
    select_auth_assistance_current_url,
)
from .service_actions import (
    execute_action,
    get_domain_from_url,
    get_element_description,
)
from .service_crypto import (
    ExtractedOTP,
    auth_realm_from_url,
    build_auth_options_prompt_section,
    build_autopay_prompt_section,
    decrypt_payment_info,
    extract_rate_limited_until,
    fetch_recent_otps,
    format_otp_user_message,
    is_usable_email_otp,
)
from .types import ClaudeTokenState

logger = structlog.get_logger()


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


def _env_enabled(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in _FALSE_ENV_VALUES


def _botsigged_diagnostics_enabled(start_url: str) -> bool:
    if not _env_enabled("BROWSER_AGENT_BOTSIGGED_DIAGNOSTICS", False):
        return False
    return "botsigged.com" in (start_url or "").lower()


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


async def _stop_playwright_resources(
    playwright_browser: Optional[Any],
    playwright_instance: Optional[Any],
    agent_id: str,
    close_browser: bool = True,
) -> None:
    """Disconnect Playwright's CDP client and stop its local driver process."""
    if playwright_browser and close_browser:
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
    extra_user_messages: Optional[List[Dict[str, str]]] = None,
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

    rose_kwargs = dict(
        task=task,
        browser_state=browser_state_for_llm,
        action_history=action_entries,
        available_actions=AVAILABLE_ACTIONS,
        dynamic_system_context=dynamic_system_context,
        turn_messages=turn_messages,
        agent_id=agent_id,
        call_site=f"browser_use_step_{iteration}",
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
                    {"type": "text", "text": "Screenshot captured by the screenshot tool."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"}},
                ],
            }
        )


def json_dumps_compact(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


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
    """Attach a CDP Fetch route that records/replays the browser's HTTPS responses.

    HIT → fulfill from cache (no internet). MISS → continue live, capture the body
    via a response listener. Browser session + actions stay live; only network
    responses are cached. Failures degrade to live (never break the session).
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

    await context.route("**/*", _route)
    context.on("response", lambda r: asyncio.ensure_future(_record(r)))


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
) -> Dict[str, Any]:
    """Browser agent activity using browser-use BrowserSession + Rose API."""
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from browser_tools.dom_service import ActionHistory, DOMService
    from browser_tools.humanizer import BrowserHumanizer
    from helpers.llm import check_progress

    dom_service = None
    input_page = None
    playwright_browser = None
    playwright_instance = None
    humanizer = None
    browser_recorder: Optional[BrowserAgentRecorder] = None
    browser_network_recorder: Optional[BrowserNetworkRecorder] = None
    cursor_streamer: Optional[BrowserCursorRealtimeStreamer] = None
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
    auth_realm = auth_realm_from_url(start_url)

    pending_write_lock_action: Optional[Dict[str, Any]] = None
    resume_step_count: int = 0
    auth_assistance_resume_mode: Optional[str] = None
    resume_user_messages: List[Dict[str, str]] = []
    if write_lock_resume_state:
        pending_write_lock_action = write_lock_resume_state.get("pending_action")
        write_lock_approvals = write_lock_resume_state.get("write_lock_approvals", {})
        resume_step_count = write_lock_resume_state.get("step_count", 0)
        session_id = write_lock_resume_state.get("session_id") or session_id
        cdp_url = write_lock_resume_state.get("cdp_url") or cdp_url
        auth_realm = write_lock_resume_state.get("auth_realm") or auth_realm
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
    logger.info("Using response schema from tool call", fields=len(response_schema.get("fields", [])))

    session_passwords: List[Dict[str, Any]] = []
    session_passkeys: List[Dict[str, Any]] = []
    session_auth_options: Optional[Dict[str, Any]] = None
    session_credential_ref: Optional[Dict[str, Any]] = None
    browser_session_metadata: Dict[str, Any] = {}

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
            is_auth_assistance_resume = (
                write_lock_resume_state is not None
                and write_lock_resume_state.get("approval_type") == "auth_assistance"
            )
            if is_auth_assistance_resume:
                logger.info("Resuming auth-assistance browser task via existing Steel session", task_id=task_id)
                session_info = await fetch_session_info(config, task_id, validate_live=True)
                expected_session_id = write_lock_resume_state.get("session_id") if write_lock_resume_state else None
                session_matches = (
                    expected_session_id is None
                    or session_info.get("session_id") is None
                    or session_info.get("session_id") == expected_session_id
                )
                same_session_available = session_info.get("same_session_available") is True and session_matches
                if same_session_available:
                    session_info["resume_mode"] = "same_steel_session"
                    auth_assistance_resume_mode = "same_steel_session"
                    logger.info(
                        "Reconnecting to live Steel session after auth assistance",
                        task_id=task_id,
                        session_id=session_info.get("session_id"),
                    )
                else:
                    unavailable_reason = session_info.get("same_session_unavailable_reason")
                    if not session_matches:
                        unavailable_reason = "session_id_mismatch"
                    logger.warning(
                        "Existing Steel session unavailable after auth assistance; creating replacement session",
                        task_id=task_id,
                        session_id=session_info.get("session_id"),
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
                            raise Exception(
                                f"Browser session unavailable after {int(_elapsed)}s (rate limited by Steel)"
                            )
                        logger.info(
                            "Steel rate limited during replacement auth-assistance resume",
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
                session_info = await fetch_session_info(config, task_id)
            session_id = session_info.get("session_id")
            browser_url = session_info.get("debug_url")
            cdp_url = session_info.get("ws_url")
            fingerprint_injection = session_info.get("fingerprint_injection")
            session_passwords = session_info.get("passwords", [])
            session_passkeys = session_info.get("passkeys", [])
            session_auth_options = session_info.get("auth_options")
            session_credential_ref = session_info.get("credential_ref") or session_info.get("auth_credential_ref")
            browser_session_metadata = session_info.get("browser_session_metadata") or {}
            auth_realm = auth_realm or auth_realm_from_url(session_info.get("saved_url", ""))
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
            session_passkeys = session_data.get("passkeys", [])
            session_auth_options = session_data.get("auth_options")
            session_credential_ref = session_data.get("credential_ref") or session_data.get("auth_credential_ref")
            browser_session_metadata = session_data.get("browser_session_metadata") or {}
            user_profile = session_data.get("user_settings") or {}
        _record_timing("session_init", t_session)

        if not cdp_url:
            raise RuntimeError("No CDP URL provided - backend must return ws_url from Steel")

        t_auth = time.monotonic()
        auth_options = session_auth_options or {}
        if auth_options.get("realm"):
            auth_realm = auth_options["realm"]
        if not auth_options and auth_realm:
            auth_options = await fetch_auth_options(config, user_id, auth_realm)
            auth_realm = auth_options.get("realm") or auth_realm
        elif not auth_options:
            auth_options = {"realm": "this site"}
        auth_runtime_state = AuthRuntimeState.from_auth_options(auth_options)
        minted_option = auth_options.get("minted") or {}
        minted_account_label = (
            minted_option.get("email")
            or minted_option.get("agentEmail")
            or minted_option.get("agent_email")
            or minted_option.get("accountLabel")
            or minted_option.get("account_label")
        )
        minted_phone_label = minted_option.get("phone") or minted_option.get("agentPhone") or minted_option.get("agent_phone")
        minted_account_labels = {
            str(label).strip().lower()
            for label in (minted_account_label, minted_phone_label)
            if label
        }
        minted_primary_label = minted_account_label or minted_phone_label
        minted_credential_ref = (
            {"kind": "minted_account", "id": str(minted_option.get("id") or minted_primary_label)}
            if minted_option and minted_primary_label
            else None
        )
        _record_timing("auth_options", t_auth)

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

            # Fast Mode: record/replay the page's HTTPS responses via a CDP Fetch route.
            # On a hit we fulfill from cache (no internet); on a miss we let the request
            # go live and capture the response body. Write-through mode records without
            # fulfilling from cache. The browser session + actions stay live.
            fast_mode_write_through = write_through_enabled_for_user(user_id)
            if goal and (fast_mode_cache_enabled or fast_mode_write_through):
                await _install_fast_mode_network_cache(
                    _playwright_context,
                    goal,
                    read_enabled=fast_mode_cache_enabled,
                    write_enabled=fast_mode_cache_enabled or fast_mode_write_through,
                )

            if _botsigged_diagnostics_enabled(start_url):
                await _install_botsigged_diagnostics(_input_page, agent_id=agent_id, task_id=task_id)

            t = time.monotonic()
            fingerprint_injection_enabled = _env_enabled("BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED", True)
            if fingerprint_injection and fingerprint_injection_enabled:
                from helpers.fingerprint_injection import apply_fingerprint_injection

                injection_success = await apply_fingerprint_injection(_input_page, fingerprint_injection)
                if injection_success:
                    logger.info("\U0001f510 Applied fingerprint injection via CDP (Sec-CH-UA-Platform, init scripts)")
                else:
                    logger.warning(
                        "\u26a0\ufe0f Failed to apply fingerprint injection - browser may leak real fingerprint"
                    )
            elif fingerprint_injection and not fingerprint_injection_enabled:
                logger.info("\U0001f510 Browser-agent fingerprint injection disabled by env")
            else:
                logger.info("\U0001f510 No fingerprint injection data provided - using Steel defaults")
            _record_timing("parallel.browser.fingerprint", t)

            t = time.monotonic()
            _humanizer = None
            if _env_enabled("BROWSER_AGENT_HUMANIZER_ENABLED", True):
                _humanizer = BrowserHumanizer(dom_page=_dom_page, input_page=_input_page, fast=False)
                await _humanizer.initialize_cursor(start_pos=(640, 400))
                logger.info("\U0001f916 BrowserHumanizer initialized (browser-use for DOM, Playwright for input)")
            else:
                logger.info("\U0001f916 BrowserHumanizer disabled by env; using browser-use input events")
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
            _user_context_sections: List[str] = []
            if user_profile.get("addressLine1"):
                addr_lines = [
                    user_profile.get("name", ""),
                    user_profile["addressLine1"],
                    user_profile.get("addressLine2", ""),
                    f"{user_profile.get('city', '')}, {user_profile.get('state', '')} {user_profile.get('postalCode', '')}",
                    user_profile.get("country", "United States"),
                ]
                shipping_address = "\n".join(line for line in addr_lines if line)
                _user_context_sections.append(f"## Delivery Address\n{shipping_address}")

            _autopay_section = ""
            _card_refs: Dict[str, str] = {}
            encrypted_payment = user_profile.get("encryptedPaymentInformation")
            if encrypted_payment and config.payment.decryption_key:
                payment_data = decrypt_payment_info(encrypted_payment, config.payment.decryption_key)
                if payment_data:
                    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
                    if autopay_limit_cents > 0:
                        _autopay_section = build_autopay_prompt_section(payment_data, encrypted_payment)
                        _user_context_sections.append(_autopay_section.strip())
                        _card_refs = {
                            "card_number": payment_data.get("card_number", ""),
                            "card_name": payment_data.get("cardholder_name", ""),
                            "card_expiry": payment_data.get("card_expiry", ""),
                            "card_cvv": payment_data.get("card_cvv", ""),
                        }
                    else:
                        _user_context_sections.append(
                            "## Payment Authorization\n"
                            "Autopay DISABLED. For ALL purchases, use send_message_to_user to get explicit approval."
                        )
            _record_timing("parallel.data.user_profile", t)

            t = time.monotonic()
            _ref_to_encrypted: Dict[str, str] = {}
            _password_origins: Dict[str, str] = {}
            _credential_refs_by_secret_ref: Dict[str, Dict[str, str]] = {}
            if session_passwords:
                logger.info(f"Loaded {len(session_passwords)} passwords from session response")
            (
                _auth_options_section,
                _ref_to_encrypted,
                _password_origins,
                _credential_refs_by_secret_ref,
            ) = build_auth_options_prompt_section(auth_options, session_passwords)

            _secret_refs: Dict[str, str] = {}

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

            attemptable_password_ids = {
                str(credential_ref.get("id"))
                for ref, credential_ref in _credential_refs_by_secret_ref.items()
                if ref in _secret_refs and credential_ref.get("kind") == "password" and credential_ref.get("id")
            }
            auth_runtime_state.restrict_password_ids_to_attemptable(attemptable_password_ids)

            logger.info(
                "Built secret refs for type interception",
                card_refs_count=len(_card_refs),
                password_refs_count=len([k for k in _secret_refs if k not in _card_refs]),
                attemptable_password_count=len(attemptable_password_ids),
            )
            _record_timing("parallel.data.passwords", t)

            t = time.monotonic()
            _user_context_section = (
                "\n\n# User Context\n\n" + "\n\n".join(_user_context_sections)
                if _user_context_sections
                else ""
            )
            _base_custom_instructions = _user_context_section + "\n\n" + _auth_options_section
            if session_credential_ref and task_id:
                await save_browser_credential_ref_message(
                    agent_id=agent_id,
                    task_id=task_id,
                    message="Browser session credential applied at session start.",
                    role="TOOL",
                    tool_name="browser_session_auth",
                    credential_ref=session_credential_ref,
                )
            _model_pricing = await get_model_pricing_with_fallback("rose-1-browser-use")
            _record_timing("parallel.data.instructions", t)

            return (
                _user_context_section,
                _autopay_section,
                _card_refs,
                _auth_options_section,
                _ref_to_encrypted,
                _credential_refs_by_secret_ref,
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
        recording_output_dir = browser_recording_output_dir(agent_id, task_id) if task_id else None
        browser_recorder = await BrowserAgentRecorder.create(
            page=input_page,
            agent_id=agent_id,
            task_id=task_id,
            session_id=session_id,
            browser_url=browser_url,
            session_metadata=browser_session_metadata,
        )
        cursor_streamer = BrowserCursorRealtimeStreamer(agent_id=agent_id, task_id=task_id)

        def observe_cursor(x: int, y: int) -> None:
            if browser_recorder:
                browser_recorder.set_cursor(x, y)
            if cursor_streamer:
                cursor_streamer.set_cursor(x, y)

        if humanizer:
            humanizer.set_cursor_observer(observe_cursor)
            humanizer.start_idle_movement()
        if recording_output_dir:
            browser_network_recorder = await BrowserNetworkRecorder.create(
                browser_session=dom_service.session,
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
                output_dir=recording_output_dir,
            )
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
        if browser_network_recorder and task_id:
            await save_browser_action_message(
                agent_id=agent_id,
                title="Browser network recording started",
                task_id=task_id,
                message=f"Local browser network log will be saved: {browser_network_recorder.network_dir / 'index.json'}",
                status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url,
                action_type="network_recording",
                tool_call_id=str(uuid_module.uuid4()),
                extra_metadata={"network_recording_path": str(browser_network_recorder.network_dir / "index.json")},
            )

        (
            shipping_section,
            autopay_section,
            card_refs,
            auth_options_section,
            ref_to_encrypted,
            credential_refs_by_secret_ref,
            secret_refs,
            password_origins,
            base_custom_instructions,
            model_pricing,
        ) = data_result

        # Cloud-custody passkeys: decrypt the private keys server-side (never to
        # the LLM) and seed a CDP virtual authenticator on the Steel session.
        # passkey_ref_by_credential_id lets us record a passkey credential_ref at
        # session end if the relying party actually exercised the credential.
        passkey_ref_by_credential_id: Dict[str, Dict[str, str]] = {}
        if session_passkeys and config.payment.decryption_key:
            from cryptography.hazmat.backends import default_backend
            from cryptography.hazmat.primitives import serialization

            from .service_crypto import decrypt_password_with_key

            _pk_private_key = serialization.load_pem_private_key(
                base64.b64decode(config.payment.decryption_key), password=None, backend=default_backend()
            )

            async def _decrypt_passkey(pk: Dict[str, Any]) -> Optional[Dict[str, Any]]:
                decrypted = await asyncio.to_thread(
                    decrypt_password_with_key, pk.get("encryptedPrivateKey", ""), _pk_private_key
                )
                if not decrypted:
                    return None
                return {
                    "credentialId": pk.get("credentialId"),
                    "privateKey": decrypted,
                    "rpId": pk.get("rpId"),
                    "userHandle": pk.get("userHandle"),
                    "signCount": pk.get("signCount") or 0,
                }

            _decrypted_passkeys = [pk for pk in await asyncio.gather(*[_decrypt_passkey(p) for p in session_passkeys]) if pk]
            for src in session_passkeys:
                cid = src.get("credentialId")
                if cid and src.get("id"):
                    passkey_ref_by_credential_id[cid] = {"kind": "passkey", "id": str(src.get("id"))}
            await dom_service.inject_passkeys(_decrypted_passkeys)
            logger.info(
                "Injected cloud-custody passkeys into Steel virtual authenticator",
                count=len(_decrypted_passkeys),
            )

        _passkey_usage_recorded = {"done": False}

        async def record_passkey_usage_once() -> None:
            """If the relying party exercised a stored passkey, record a
            credential_ref so post-run propagation can mark success/failure."""
            if _passkey_usage_recorded["done"] or not passkey_ref_by_credential_id:
                return
            _passkey_usage_recorded["done"] = True
            try:
                used = await dom_service.get_used_passkey_credential_ids()
            except Exception as e:
                logger.warning("Failed to read passkey usage", error=extract_error_message(e))
                return
            for cid in used:
                ref = passkey_ref_by_credential_id.get(cid)
                if ref and task_id:
                    await save_browser_credential_ref_message(
                        agent_id=agent_id,
                        task_id=task_id,
                        message="Passkey used for authentication.",
                        role="TOOL",
                        tool_name="browser_session_auth",
                        credential_ref=ref,
                    )

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
            if browser_recorder:
                await browser_recorder.mark(f"Navigated -> {nav_url[:80]}", action="goto")

            logger.info(f"\U0001f310 Auto-navigated to start URL: {nav_url}")

            # Warm-up human activity after the page loads, before the agent's
            # first deliberate action. Clears two behavioral-biometrics tells:
            # "first interaction too soon after page load" (reading dwell) and
            # "no scroll activity during session" (a scroll down + partial up).
            try:
                if humanizer is not None:
                    await asyncio.sleep(random.uniform(1.0, 2.0))
                    await humanizer.scroll(random.randint(120, 320))
                    await asyncio.sleep(random.uniform(0.4, 0.9))
                    await humanizer.scroll(-random.randint(60, 160))
            except Exception as warmup_err:
                logger.warning(f"⚠️ Warm-up scroll failed: {warmup_err}")
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
        seen_otp_codes: set[str] = set()
        otp_user_messages: List[Dict[str, str]] = []
        browser_turn_messages: List[Dict[str, Any]] = []
        browser_turn_messages.extend(resume_user_messages)
        otp_history_count = 0
        task_prompt = build_browser_task_prompt(goal)
        dynamic_system_context = build_browser_dynamic_system_context(
            base_custom_instructions,
            available_files=list(available_file_paths.keys()) if available_file_paths else None,
            response_schema=response_schema,
        )

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
                    credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                    user_id=user_id,
                    current_url=current_url,
                    write_lock_enabled=write_lock_enabled,
                    write_lock_approvals=write_lock_approvals,
                    system_name=system_name,
                )

                action_name = unified_action.get("action", "unknown")
                logger.info(f"Pending write lock action executed: {action_name}", result=result)

                activity.heartbeat(f"Step {iteration} - fetching browser state")
                browser_state = await dom_service.get_browser_state(include_screenshot=False)
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
            browser_state = await dom_service.get_browser_state(include_screenshot=False)
            current_url = browser_state.get("url", "")

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
                        thinking_preview=last.get("thinking", "")[:100] if last.get("thinking") else "NONE",
                    )

                activity.heartbeat(f"Step {iteration} - calling Rose API")
                # Fast Mode: replay the recorded decision when the browser request
                # fingerprint matches. The live browser session still executes the
                # action — only the LLM "what next" decision is cached.
                async def _live_browser_decision() -> Dict[str, Any]:
                    live_result = await _call_browser_use_with_rotation(
                        rose_client=rose_client,
                        task=task_prompt,
                        dynamic_system_context=dynamic_system_context,
                        turn_messages=browser_turn_messages,
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
                        extra_user_messages=[],
                        dump_extra=(
                            {
                                "browser_recording_manifest_path": str(browser_recorder.output_dir / "manifest.json"),
                                "browser_recording_path": str(browser_recorder.output_dir / "index.html"),
                                "browser_recording_task_id": browser_recorder.task_id,
                                "browser_session_metadata": browser_session_metadata,
                                "iteration": iteration,
                            }
                            if browser_recorder
                            else {"iteration": iteration}
                        ),
                    )
                    return _attach_browser_replay_target(live_result, dom_service)

                llm_result = await cached_browser_decision(
                    enabled=fast_mode_cache_enabled,
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
                    write_enabled=fast_mode_cache_enabled or write_through_enabled_for_user(user_id),
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
            unified_action = _remap_cached_browser_action_target(
                unified_action,
                cached_target=llm_result.get("_fast_cache_browser_target"),
                dom_service=dom_service,
            )
            if unified_action is not llm_result.get("action"):
                llm_result = dict(llm_result)
                llm_result["action"] = unified_action
            action_name = unified_action.get("action", "")
            thinking = unified_action.get("thinking", "")

            if thinking:
                reasoning_messages.append(thinking)
                await save_browser_assistant_message(agent_id, thinking, task_id)

            action_summary.append(f"{action_name}: {json.dumps(unified_action, sort_keys=True, default=str)[:500]}")
            if len(action_summary) > 20:
                action_summary[:] = action_summary[-20:]
            if action_name == "attempt_completion":
                auth_runtime_state.mark_guest_attempted()

            # 5. Handle special actions
            if action_name == "request_user_assistance_for_authentication":
                tool_call_id_action = str(uuid_module.uuid4())
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
                            logger.warning("Failed to fetch OTPs while delaying auth assistance", error=str(e))
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
                        continue
                allowed, guard_reason, guard_state = auth_runtime_state.user_assistance_guard()
                if not allowed:
                    logger.info(
                        "Blocked premature user authentication assistance request",
                        base_site=base_site,
                        reason=guard_reason,
                        auth_guard_state=guard_state,
                    )
                    blocked_result = {"success": False, "error": guard_reason, "auth_guard_state": guard_state}
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
                    continue
                logger.info("Browser agent requested user authentication assistance", base_site=base_site)
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

                await dom_service.disconnect()
                await _stop_playwright_resources(
                    playwright_browser,
                    playwright_instance,
                    agent_id,
                    close_browser=False,
                )
                playwright_browser = None
                playwright_instance = None

                execution_time_ms = (safe_time() - start_time) * 1000
                usage_items = build_usage_items(
                    total_input_tokens, total_output_tokens, model_pricing, execution_time_ms
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
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items,
                }

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
                    verifier_actual_model = v_usage.get("actual_model", "")
                    if not (
                        str(verifier_actual_model).endswith("-claude") or str(verifier_actual_model).endswith("-gpt")
                    ):
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
                    if browser_recorder:
                        await browser_recorder.mark(
                            f"Verifier progress: {score * 100:.0f}%",
                            action="verify",
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

                        await record_passkey_usage_once()
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
                            output_schema=response_schema,
                        )

                        usage_items = build_usage_items(
                            total_input_tokens, total_output_tokens, model_pricing, execution_time_ms
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
                credential_refs_by_secret_ref=credential_refs_by_secret_ref,
                user_id=user_id,
                current_url=current_url,
                write_lock_enabled=write_lock_enabled,
                write_lock_approvals=write_lock_approvals,
                system_name=system_name,
            )
            if (
                not result.get("credential_ref")
                and action_name == "input_text"
                and minted_credential_ref
                and str(unified_action.get("params", {}).get("text", "")).strip().lower()
                in minted_account_labels
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
                    auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None,
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
            output_schema=response_schema,
        )

        execution_time_ms = (safe_time() - start_time) * 1000
        usage_items = build_usage_items(total_input_tokens, total_output_tokens, model_pricing, execution_time_ms)
        await _propagate_browser_credentials_with_progress(
            config=config,
            agent_id=agent_id,
            task_id=task_id,
            browser_url=browser_url,
            status="max_iterations",
            success=False,
            message=context_message,
        )

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
                    output_schema=response_schema,
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
        if humanizer:
            with contextlib.suppress(Exception):
                await humanizer.close()
        if browser_network_recorder:
            with contextlib.suppress(Exception):
                network_index_path = await browser_network_recorder.close()
                if network_index_path and task_id:
                    await save_browser_action_message(
                        agent_id=agent_id,
                        title="Browser network recording saved",
                        task_id=task_id,
                        message=f"Local browser network log: {network_index_path}",
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url or "",
                        action_type="network_recording",
                        tool_call_id=str(uuid_module.uuid4()),
                        extra_metadata={"network_recording_path": str(network_index_path)},
                    )
        if browser_recorder:
            with contextlib.suppress(Exception):
                recording_path = await browser_recorder.close()
                if recording_path and task_id:
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
                            "browser_session_metadata": browser_session_metadata,
                        },
                    )
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
            current_start_url = start_url
            result = None

            while True:
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
                            current_start_url,
                            write_lock_resume_state,
                            system_name,
                            bool(active_claude_token) and not bool(active_gpt_token),
                            active_gpt_token,
                            active_gpt_account_id,
                            active_gpt_source,
                            active_gpt_pool_id,
                            getattr(workflow_instance, "fast_mode_cache_enabled", False),
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
                            metadata={"toolName": "spawn_browser_agent", "action_type": "auth_assistance"},
                        )
                        return

                    workflow_instance.is_paused = True
                    if hasattr(workflow_instance, "_update_tree_state"):
                        await workflow_instance._update_tree_state(status="PAUSED")

                    await workflow.wait_condition(
                        lambda: (
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
                    }

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
            final_status = MessageStatus.FINISHED if result.get("success", True) else MessageStatus.ERROR
            final_metadata = {"toolName": "spawn_browser_agent"}
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
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation complete",
                message=result.get("message", ""),
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
