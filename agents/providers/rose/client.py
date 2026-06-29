"""RoseClient — public orchestration layer for the Rose completions path.

One entry point, `RoseClient.complete()`, that:

  1. Tries the claudeAuth path (if a `ClaudeAuthContext` was supplied),
     buffering the metadata chunk so a pre-first-content failure can fall
     through to the waterfall without the caller ever seeing `claude-token`
     metadata it'll never receive content for.
  2. Tries the gptAuth path (if a `GptAuthContext` was supplied) under the
     same pre-first-content fall-through contract.
  3. Falls through to the pool's waterfall on any typed direct-token error
     (`RoseInvalidRequest`, `RoseStallError`, `RoseServerError`,
     `RoseAuthError`, `RoseRateLimitError`) **before first content**.
  4. Enforces a top-level deadline (default 590s).
  5. Heartbeats every 10s so a long stream doesn't drop its Temporal
     activity.

All business logic lives in `claude_auth.py` and `waterfall.py`; this
module only does ordering + deadline + heartbeat + span propagation.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional, Type, cast

import httpx
import structlog
from pydantic import BaseModel

from config import load_config
from providers.rose.browser_use import (
    build_browser_use_messages,
    build_browser_use_tools,
    normalize_browser_use_response,
    normalize_browser_use_tool_call,
)
from providers.rose.claude_auth import anthropic_api_key_complete, claude_auth_complete
from providers.rose.errors import (
    RoseAuthError,
    RoseDeadlineError,
    RoseError,
    RoseInvalidRequest,
    RosePaymentRequiredError,
    RoseRateLimitError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.gpt_auth import gpt_auth_complete
from providers.rose.legacy_adapter import classify_claude_token_error, classify_gpt_token_error
from providers.rose.pools import PoolName, get_pool
from providers.rose.schema import (
    SYNTHETIC_OUTPUT_TOOL_NAME,
    build_anthropic_tools_from_response_model,
    build_openai_response_format,
)
from providers.rose.types import (
    ChunkKind,
    ClaudeAuthContext,
    ComputeAuthContext,
    GptAuthContext,
    RoseResponse,
    StreamChunk,
)
from providers.rose.waterfall import waterfall_complete

logger = structlog.get_logger()

# Wall-clock cap for the whole streaming call. Sits under the Temporal
# start_to_close for call_llm_activity so Rose can fail cleanly before the
# activity is killed. This budget covers the complete direct-auth/fallback
# waterfall, not a single provider attempt.
_DEFAULT_DEADLINE_S = 590.0
# TTFT: Anthropic 150k cache-warm contexts TTFB at 6-15s; 45s was sufficient
# there. But Codex Responses API on gpt-5.5 with large explore-agent contexts
# (network metadata + 200-contact rollup + tool results) regularly TTFBs at
# 30-60s, and the 45s ceiling was firing as a spurious stall on healthy calls.
# Observed in outreach-batch: 10 explore_agent gpt calls hit the 45s TTFT,
# then rotated to claude and succeeded in ~9s — burning ~450s per run on a
# threshold mismatched to the actual provider. 90s tolerates Codex cold-start
# while still catching genuine half-closed connections.
_DEFAULT_TTFT_TIMEOUT_S = 90.0
# Per-chunk idle *after* the first productive chunk. Anthropic batches large
# 150k responses with 26-30s silences between bursts; 120s clears those
# while still catching half-closed connections.
_DEFAULT_IDLE_TIMEOUT_S: Optional[float] = 120.0
_HEARTBEAT_INTERVAL_S = 10.0
_STALL_TOKEN_COOLDOWN_S = 10 * 60

# Errors from claude_auth that mean "try the waterfall next" — as long as
# they fire before the first non-metadata chunk reaches the caller.
_FALL_THROUGH_ERRORS = (
    RoseInvalidRequest,
    RoseStallError,
    RoseServerError,
    RoseAuthError,
    RoseRateLimitError,
    RosePaymentRequiredError,
)

# Stall-retry budget for direct-auth attempts. Empty: the new 45s TTFT
# already covers cold-start jitter, and 150k Anthropic batched responses
# need the full deadline window — not three escalating retries that each
# kill the connection right before the model's flush burst arrives.
# A real stall still falls through to rotation/waterfall on the first
# attempt (see classify_*_token_error below).
_STALL_TTFT_MULTIPLIERS: tuple[float, ...] = ()


def _is_synthetic_output_toolset(tools: Optional[List[Dict[str, Any]]]) -> bool:
    return (
        isinstance(tools, list)
        and len(tools) == 1
        and isinstance(tools[0], dict)
        and tools[0].get("name") == SYNTHETIC_OUTPUT_TOOL_NAME
    )


class _FallThrough(Exception):
    """Internal signal — claudeAuth failed cleanly before emitting content."""


# ── Shared ANTHROPIC_API_KEY cooldown ──────────────────────────────────────
# The funded ANTHROPIC_API_KEY default is one global credential. Agents have no
# DB, so its out-of-credits backoff is read/written through the backend (the
# same DB row the backend chat path uses) — one shared cooldown across all
# workers + workflows, no hammering. A short in-memory cache keeps the LLM hot
# path off the backend on the common (clear) case.
_ANTHROPIC_COOLDOWN_RECHECK_S = 15.0
_anthropic_cooldown_skip_until = 0.0  # time.monotonic() < this ⇒ locally known cooled
_anthropic_cooldown_last_check = 0.0


def _reset_anthropic_api_key_cooldown_cache() -> None:
    """Test-only: clear the in-memory cooldown cache between cases."""
    global _anthropic_cooldown_skip_until, _anthropic_cooldown_last_check
    _anthropic_cooldown_skip_until = 0.0
    _anthropic_cooldown_last_check = 0.0


async def _anthropic_api_key_on_cooldown() -> bool:
    """Whether the shared funded key is backed off (in-memory fast path, then
    a throttled backend read). Failures are treated as 'not on cooldown' so a
    transient backend blip never disables the fallback."""
    global _anthropic_cooldown_skip_until, _anthropic_cooldown_last_check
    now = time.monotonic()
    if now < _anthropic_cooldown_skip_until:
        return True
    if now - _anthropic_cooldown_last_check < _ANTHROPIC_COOLDOWN_RECHECK_S:
        return False
    _anthropic_cooldown_last_check = now
    cfg = load_config()
    base = (cfg.backend.api_url or "").rstrip("/")
    if not base:
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{base}/api/integrations/compute-code/anthropic-key/cooldown",
                headers={"X-API-Key": cfg.backend.api_key or ""},
            )
            if resp.status_code == 200 and resp.json().get("onCooldown") is True:
                _anthropic_cooldown_skip_until = now + _ANTHROPIC_COOLDOWN_RECHECK_S
                return True
    except Exception:
        return False
    return False


async def _mark_anthropic_api_key_cooldown(reason: str) -> None:
    """Back the shared funded key off (in-memory + backend DB) so no other
    worker/workflow retries it until it recovers."""
    global _anthropic_cooldown_skip_until
    _anthropic_cooldown_skip_until = time.monotonic() + _ANTHROPIC_COOLDOWN_RECHECK_S
    cfg = load_config()
    base = (cfg.backend.api_url or "").rstrip("/")
    if not base:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{base}/api/integrations/compute-code/token/rate-limited",
                headers={"X-API-Key": cfg.backend.api_key or "", "Content-Type": "application/json"},
                json={"type": "anthropic", "source": "pool", "failureReason": reason},
            )
    except Exception:
        logger.warning("rose.anthropic_apikey.cooldown_mark_failed", reason=reason)


def _single_attempt_auth(auth: ComputeAuthContext) -> ComputeAuthContext:
    """Clone a direct-token auth context for exactly one provider attempt.

    Provider modules still own HTTP retry and DB marking for the current token.
    RoseClient owns cross-provider compute rotation, so provider-internal fresh
    fetch is disabled on this clone.
    """
    if auth.token_type == "claude":
        return ClaudeAuthContext(
            token=auth.token,
            source=auth.source,
            user_id=auth.user_id,
            pool_token_id=auth.pool_token_id,
            mark_rate_limited=auth.mark_rate_limited,
            fetch_fresh=None,
            max_rotations=0,
        )
    return GptAuthContext(
        token=auth.token,
        source=auth.source,
        user_id=auth.user_id,
        account_id=auth.account_id,
        pool_token_id=auth.pool_token_id,
        mark_rate_limited=auth.mark_rate_limited,
        fetch_fresh=None,
        max_rotations=0,
    )


def _compute_token_payload(auth: ComputeAuthContext) -> Dict[str, Any]:
    return {
        "type": auth.token_type,
        "accessToken": auth.token,
        "accountId": auth.account_id,
        "source": auth.source,
        "poolTokenId": auth.pool_token_id,
    }


async def _mark_direct_auth_stalled(
    auth: ComputeAuthContext,
    *,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    failure_reason: str = "stall",
) -> None:
    """Temporarily back off a compute token that produced no first token."""
    if auth.mark_rate_limited is None:
        logger.warning(
            "rose.complete.direct_auth.stall_cooldown_unavailable",
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            token_type=auth.token_type,
            source=auth.source,
            pool_token_id=auth.pool_token_id,
            failure_reason=failure_reason,
        )
        return
    try:
        ok = await auth.mark_rate_limited(
            auth,
            _STALL_TOKEN_COOLDOWN_S,
            None,
            failure_reason,
        )
        if ok:
            logger.info(
                "rose.complete.direct_auth.stall_cooldown_marked",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                token_type=auth.token_type,
                source=auth.source,
                pool_token_id=auth.pool_token_id,
                failure_reason=failure_reason,
                cooldown_seconds=_STALL_TOKEN_COOLDOWN_S,
            )
        else:
            logger.warning(
                "rose.complete.direct_auth.stall_cooldown_not_marked",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                token_type=auth.token_type,
                source=auth.source,
                pool_token_id=auth.pool_token_id,
                failure_reason=failure_reason,
                cooldown_seconds=_STALL_TOKEN_COOLDOWN_S,
            )
    except Exception as exc:
        logger.warning(
            "rose.complete.direct_auth.stall_cooldown_failed",
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            token_type=auth.token_type,
            source=auth.source,
            pool_token_id=auth.pool_token_id,
            failure_reason=failure_reason,
            cooldown_seconds=_STALL_TOKEN_COOLDOWN_S,
            error=str(exc),
        )


def _safe_heartbeat(message: str) -> None:
    """Emit a Temporal activity heartbeat if we're inside an activity,
    otherwise silently skip. Matches the pattern in `helpers/llm.py`."""
    with contextlib.suppress(Exception):
        from temporalio import activity

        activity.heartbeat(message)


def _cache_input_accounting(
    *,
    actual_model: str,
    prompt_tokens: int,
    cache_read: int,
    cache_write: int,
) -> Dict[str, Any]:
    """Return provider-correct prompt-cache totals for logging.

    Anthropic direct usage reports `input_tokens` as only the uncached tail;
    cache read/write tokens are exclusive counters. OpenAI-compatible usage
    reports `cached_tokens` inside the already-total `prompt_tokens`.
    """
    prompt_tokens = max(int(prompt_tokens or 0), 0)
    cache_read = max(int(cache_read or 0), 0)
    cache_write = max(int(cache_write or 0), 0)

    if actual_model.endswith("-claude"):
        total_input = prompt_tokens + cache_read + cache_write
        accounting = "exclusive"
    else:
        total_input = max(prompt_tokens, cache_read + cache_write)
        accounting = "inclusive"

    cache_pct = round(cache_read / total_input * 100) if total_input > 0 else 0
    uncached_input = max(total_input - cache_read - cache_write, 0)
    return {
        "total_input": total_input,
        "uncached_input": uncached_input,
        "cache_hit_pct": cache_pct,
        "cache_accounting": accounting,
    }


def _dump_display_model(actual_model: str) -> str:
    """Human-facing model for debug dumps, without direct-auth route suffixes."""
    if actual_model.endswith("-claude"):
        return actual_model[: -len("-claude")]
    if actual_model.endswith("-gpt"):
        return actual_model[: -len("-gpt")]
    return actual_model


def _browser_use_dump_config(
    *,
    pool_spec: Any,
    response: RoseResponse,
    mode: str,
    max_tokens: int,
    temperature: float,
    include_screenshot: bool,
    call_site: str,
    deadline_s: float,
    claude_auth: Optional[ClaudeAuthContext],
    gpt_auth: Optional[GptAuthContext],
    available_actions: List[str],
    tools: List[Dict[str, Any]],
    tool_choice: Any,
) -> Dict[str, Any]:
    """Capture behavior-shaping values for a browser-use LLM call dump."""
    actual_model = response.actual_model or ""
    effective_model = _dump_display_model(actual_model)
    if mode == "gpt":
        effective_params = {
            "model": pool_spec.gpt_auth_model,
            "temperature": None,
            "max_tokens": None,
            "reasoning_effort": None,
            "store": False,
            "parallel_tool_calls": True,
            "include": ["reasoning.encrypted_content"],
        }
    elif mode == "claude":
        effective_params = {
            "model": pool_spec.claude_auth_model,
            "temperature": 1,
            "max_tokens": max_tokens or 8192,
            "reasoning_effort": None,
            "thinking": None,
            "stream": True,
        }
    else:
        effective_params = {
            "model": effective_model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "reasoning_effort": None,
            "stream": True,
        }
    return {
        "pool": "rose-1-browser-use",
        "actual_model": effective_model,
        "actual_model_raw": actual_model,
        "pool_name": response.pool_name or "rose-1-browser-use",
        "mode": mode,
        "call_site": call_site,
        "effective_params": effective_params,
        "requested_params": {
            "max_tokens": max_tokens,
            "temperature": temperature,
            "reasoning_effort": None,
            "thinking": None,
            "seed": None,
            "response_format": None,
            "tools": tools,
            "tool_choice": tool_choice,
        },
        "max_tokens": effective_params["max_tokens"],
        "temperature": effective_params["temperature"],
        "reasoning_effort": effective_params["reasoning_effort"],
        "thinking": effective_params.get("thinking"),
        "seed": None,
        "response_format": None,
        "tools": tools,
        "tool_choice": tool_choice,
        "include_screenshot": include_screenshot,
        "deadline_s": deadline_s,
        "direct_auth": {
            "claude": claude_auth is not None,
            "gpt": gpt_auth is not None,
        },
        "candidate_models": {
            "claude_auth": pool_spec.claude_auth_model,
            "gpt_auth": pool_spec.gpt_auth_model,
            "waterfall": list(pool_spec.waterfall),
        },
        "available_actions": list(available_actions),
    }


def _messages_without_internal_system_boundaries(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return dump-safe messages with internal cache sentinels removed.

    Browser-use builds one logical system prompt with
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY so provider transforms can split static and
    dynamic cache regions. That marker is never meant to be model-visible, so
    dumps store the same content as separate system messages instead of
    persisting the sentinel text.
    """
    try:
        from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    except Exception:
        return [dict(message) for message in messages]

    cleaned: List[Dict[str, Any]] = []
    for message in messages:
        content = message.get("content")
        if message.get("role") != "system" or not isinstance(content, str):
            cleaned.append(dict(message))
            continue
        if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in content:
            cleaned.append(dict(message))
            continue
        for part in content.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY):
            text = part.strip()
            if not text:
                continue
            cloned = dict(message)
            cloned["content"] = text
            cleaned.append(cloned)
    return cleaned


class RoseClient:
    """Stateless client — one instance can serve many concurrent `complete()`
    calls. Config is read lazily from `load_config()` on first use.
    """

    def __init__(self, openrouter_key: Optional[str] = None) -> None:
        self._openrouter_key = openrouter_key

    def _or_key(self) -> str:
        if self._openrouter_key:
            return self._openrouter_key
        return load_config().openrouter.api_key

    async def complete(
        self,
        *,
        pool: PoolName,
        messages: List[Dict[str, Any]],
        response_model: Optional[Type[BaseModel]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Any = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        seed: Optional[int] = None,
        skip_cache_write: bool = False,
        claude_auth: Optional[ClaudeAuthContext] = None,
        gpt_auth: Optional[GptAuthContext] = None,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        call_site: str = "unspecified",
        deadline_s: float = _DEFAULT_DEADLINE_S,
        ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
        idle_timeout_s: Optional[float] = _DEFAULT_IDLE_TIMEOUT_S,
        thinking: Optional[Dict[str, Any]] = None,
        effort: Optional[str] = None,
        dump_context: bool = True,
        dump_extra: Optional[Dict[str, Any]] = None,
    ) -> AsyncIterator[StreamChunk]:
        """Run a full Rose completion, yielding normalized StreamChunks.

        Order: one `metadata` chunk first, then any number of
        `content`/`tool_call`/`reasoning` chunks, then exactly one `usage`
        chunk, then exactly one `done` chunk. All failures raise typed
        `RoseError`s; callers never see error chunks.
        """
        pool_spec = get_pool(pool)
        rid = request_id or uuid.uuid4().hex[:12]
        started = time.monotonic()
        first_contentful_at: Optional[float] = None

        openrouter_response_format = (
            build_openai_response_format(response_model) if response_model is not None else None
        )
        dump_path: Optional[str] = None
        dump_result = RoseResponse()
        if dump_context:
            try:
                from helpers.observability import dump_llm_context

                dump_path = dump_llm_context(
                    call_site=call_site,
                    messages=_messages_without_internal_system_boundaries(messages),
                    agent_id=agent_id,
                    model=pool,
                    config={
                        "pool": pool,
                        "requested_params": {
                            "temperature": temperature,
                            "max_tokens": max_tokens,
                            "seed": seed,
                            "skip_cache_write": skip_cache_write,
                            "tool_choice": tool_choice,
                            "thinking": thinking,
                            "reasoning_effort": effort,
                            "deadline_s": deadline_s,
                            "ttft_timeout_s": ttft_timeout_s,
                            "idle_timeout_s": idle_timeout_s,
                        },
                        "response_model": response_model.__name__ if response_model else None,
                        "direct_auth": {
                            "claude": claude_auth is not None,
                            "gpt": gpt_auth is not None,
                        },
                        "candidate_models": {
                            "claude_auth": pool_spec.claude_auth_model,
                            "gpt_auth": pool_spec.gpt_auth_model,
                            "waterfall": list(pool_spec.waterfall),
                        },
                    },
                    response_format=None if tools else openrouter_response_format,
                    tools=tools,
                    extra=dump_extra,
                )
            except Exception:
                logger.debug("rose.complete.dump_start_failed", call_site=call_site, exc_info=True)

        def _record_dump_chunk(chunk: StreamChunk) -> None:
            if not dump_context:
                return
            try:
                _fold(dump_result, chunk)
            except Exception:
                logger.debug("rose.complete.dump_chunk_failed", call_site=call_site, exc_info=True)

        def _finalize_dump(error: Optional[BaseException] = None) -> None:
            if not dump_context or not dump_path:
                return
            try:
                from helpers.observability import update_llm_dump

                output: Dict[str, Any] = {
                    "content": dump_result.content,
                    "reasoning": dump_result.reasoning,
                    "tool_calls": dump_result.tool_calls,
                    "codex_reasoning_items": dump_result.codex_reasoning_items,
                    "usage": dump_result.usage,
                    "timing": dump_result.timing,
                    "request_id": dump_result.request_id or rid,
                    "actual_model": dump_result.actual_model,
                    "pool_name": dump_result.pool_name,
                    "claude_token_error": dump_result.claude_token_error,
                    "gpt_token_error": dump_result.gpt_token_error,
                }
                if error is not None:
                    output["error"] = {
                        "type": type(error).__name__,
                        "message": str(error),
                    }
                update_llm_dump(
                    dump_path,
                    model=_dump_display_model(dump_result.actual_model or pool),
                    output=output,
                )
            except Exception:
                logger.debug("rose.complete.dump_finalize_failed", call_site=call_site, exc_info=True)

        claude_auth_tools = None
        claude_auth_tool_choice = None
        gpt_auth_tools = None
        gpt_auth_tool_choice = None
        direct_auth_tools = tools
        effective_tool_choice = tool_choice
        if (
            direct_auth_tools is None
            and response_model is not None
            and (claude_auth is not None or gpt_auth is not None)
        ):
            direct_auth_tools = build_anthropic_tools_from_response_model(
                response_model,
                model=pool_spec.claude_auth_model,
            )
        if claude_auth is not None:
            # Plain structured-output models are better enforced by Anthropic
            # `output_config.format` than by a synthetic submit tool. Keep
            # native tools only for real tool-call models.
            if not _is_synthetic_output_toolset(direct_auth_tools):
                claude_auth_tools = direct_auth_tools
            if claude_auth_tools:
                # response_model is the explicit signal that "tool_calls is the
                # only legal response shape." `auto` lets Anthropic emit prose
                # instead — when it does, the streaming parser shoves text into
                # the JSON envelope slot and json.loads explodes (Expecting
                # value: line 1 column 1). Mirror gpt_auth (just below): force
                # `any` whenever native tools are populated.
                claude_auth_tool_choice = effective_tool_choice or "any"
        if gpt_auth is not None:
            # Plain structured-output models are better enforced by the
            # Responses `text.format` JSON schema than by a synthetic submit
            # tool. Keep native tools only for real tool-call models.
            if not _is_synthetic_output_toolset(direct_auth_tools):
                gpt_auth_tools = direct_auth_tools
            if gpt_auth_tools:
                gpt_auth_tool_choice = effective_tool_choice or "any"

        direct_auth: Optional[ComputeAuthContext] = claude_auth or gpt_auth

        logger.info(
            "rose.complete.start",
            request_id=rid,
            agent_id=agent_id,
            call_site=call_site,
            pool=pool,
            claude_auth_present=claude_auth is not None,
            gpt_auth_present=gpt_auth is not None,
            direct_auth_type=direct_auth.token_type if direct_auth is not None else None,
            claude_auth_tool_count=len(claude_auth_tools or []),
            deadline_s=deadline_s,
            ttft_timeout_s=ttft_timeout_s,
            idle_timeout_s=idle_timeout_s,
        )

        remaining = lambda: deadline_s - (time.monotonic() - started)
        last_heartbeat = started
        first_chunk_at: Optional[float] = None
        last_chunk_at: Optional[float] = None
        first_productive_kind: Optional[str] = None
        last_chunk_kind: Optional[str] = None
        chunk_counts: Dict[str, int] = {}
        active_route = "not_started"

        def _elapsed_s(timestamp: Optional[float]) -> Optional[float]:
            return round(timestamp - started, 3) if timestamp is not None else None

        def _observability_fields() -> Dict[str, Any]:
            return {
                "active_route": active_route,
                "first_chunk_s": _elapsed_s(first_chunk_at),
                "first_contentful_token_s": _elapsed_s(first_contentful_at),
                "first_productive_kind": first_productive_kind,
                "last_chunk_s": _elapsed_s(last_chunk_at),
                "last_chunk_kind": last_chunk_kind,
                "chunk_counts": dict(chunk_counts),
            }

        async def _guarded(
            source: AsyncIterator[StreamChunk],
            *,
            ttft_override: Optional[float] = None,
        ) -> AsyncIterator[StreamChunk]:
            """Wrap an upstream generator with deadline + TTFT + idle checks.

            - Before the first productive chunk: enforce `ttft_timeout_s` (or
              `ttft_override` when set, used by the stall-retry path) and
              raise `RoseStallError` so the caller can fall through to the
              waterfall.
            - After the first productive chunk: enforce `idle_timeout_s` (if
              set) so a mid-stream half-closed connection doesn't burn the
              full deadline before the loop can retry. Hitting the idle
              window raises `RoseDeadlineError`; the outer deadline still
              caps total time.
            """
            nonlocal first_chunk_at, first_contentful_at, first_productive_kind
            nonlocal last_chunk_at, last_chunk_kind, last_heartbeat
            ttft_budget = ttft_override if ttft_override is not None else ttft_timeout_s
            it = source.__aiter__()
            saw_productive_chunk = False
            productive_kinds = {"content", "reasoning", "tool_call", "codex_reasoning_item"}
            while True:
                r = remaining()
                if r <= 0:
                    raise RoseDeadlineError(f"rose.complete deadline exceeded after {deadline_s}s")
                if saw_productive_chunk:
                    # Per-chunk idle ceiling once content has started. None
                    # means "let the deadline handle it" (legacy behavior);
                    # a finite value catches silent half-closes faster.
                    progress_timeout = idle_timeout_s if idle_timeout_s is not None else r
                else:
                    progress_timeout = ttft_budget
                try:
                    chunk = await asyncio.wait_for(it.__anext__(), timeout=min(r, progress_timeout))
                except asyncio.TimeoutError as exc:
                    if saw_productive_chunk:
                        raise RoseDeadlineError(
                            f"rose.complete idle for {progress_timeout}s (deadline {deadline_s}s)"
                        ) from exc
                    raise RoseStallError(f"rose.complete TTFT exceeded {ttft_budget}s") from exc
                except StopAsyncIteration:
                    return
                now = time.monotonic()
                chunk_kind = str(chunk.kind)
                chunk_counts[chunk_kind] = chunk_counts.get(chunk_kind, 0) + 1
                last_chunk_at = now
                last_chunk_kind = chunk_kind
                if first_chunk_at is None:
                    first_chunk_at = now
                    logger.info(
                        "rose.complete.first_chunk",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        active_route=active_route,
                        kind=chunk_kind,
                        elapsed_s=round(now - started, 3),
                    )
                if chunk.kind in productive_kinds:
                    if first_contentful_at is None:
                        first_contentful_at = now
                        first_productive_kind = chunk_kind
                        logger.info(
                            "rose.complete.first_productive_chunk",
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            active_route=active_route,
                            kind=chunk_kind,
                            elapsed_s=round(now - started, 3),
                            chunk_counts=dict(chunk_counts),
                        )
                    saw_productive_chunk = True
                if now - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                    _safe_heartbeat(f"rose.complete call_site={call_site} request_id={rid}")
                    last_heartbeat = now
                yield chunk

        def _with_timing_if_done(chunk: StreamChunk) -> StreamChunk:
            if chunk.kind != "done":
                return chunk
            completed = time.monotonic()
            timing = {
                "first_contentful_token_s": (
                    round(first_contentful_at - started, 3) if first_contentful_at is not None else None
                ),
                "round_trip_s": round(completed - started, 3),
            }
            return StreamChunk(kind="done", data={**chunk.data, "timing": timing})

        # Tracks the legacy `claude_token_error` string when claudeAuth falls
        # through to waterfall — surfaced on waterfall's metadata chunk so the
        # workflow's rotation logic (which only sees the final usage dict) can
        # tell *why* we ended up on a non-claude model.
        claude_token_error: Optional[str] = None
        gpt_token_error: Optional[str] = None

        # Per-call state for cache-event emission. We emit one `llm.cache`
        # event per RoseClient.complete invocation so every caller (structured
        # streaming, browser_use, message_person, verifier, …) is visible to
        # agent_cache.py. Tracked lazily because actual_model arrives on the
        # metadata chunk and the token counts on the usage chunk.
        _seen_actual_model: str = "unknown"
        _llm_cache_emitted: bool = False

        def _emit_llm_cache(usage_data: Dict[str, Any]) -> None:
            nonlocal _llm_cache_emitted
            if _llm_cache_emitted:
                return
            _llm_cache_emitted = True
            cache_read = usage_data.get("cache_read_input_tokens", 0) or 0
            cache_write = usage_data.get("cache_creation_input_tokens", 0) or 0
            prompt_tokens = usage_data.get("prompt_tokens", 0) or 0
            completion_tokens = usage_data.get("completion_tokens", 0) or 0
            cache_stats = _cache_input_accounting(
                actual_model=_seen_actual_model,
                prompt_tokens=prompt_tokens,
                cache_read=cache_read,
                cache_write=cache_write,
            )
            logger.info(
                "llm.cache",
                call_site=call_site,
                agent_id=agent_id,
                actual_model=_seen_actual_model,
                is_claude=_seen_actual_model.endswith("-claude"),
                is_gpt=_seen_actual_model.endswith("-gpt"),
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cache_read=cache_read,
                cache_write=cache_write,
                cache_hit_pct=cache_stats["cache_hit_pct"],
                cache_total_input=cache_stats["total_input"],
                cache_uncached_input=cache_stats["uncached_input"],
                cache_accounting=cache_stats["cache_accounting"],
                finish=usage_data.get("finish_reason", ""),
            )

        try:
            direct_rotations = 0
            direct_token_errors: Dict[str, str] = {}
            while direct_auth is not None:
                active_route = f"direct_auth:{direct_auth.token_type}"
                # Per-token stall-retry: bump TTFT and re-attempt with the
                # same token before classifying as a fall-through. Cold pool
                # slots often clear on attempt 2 with a wider window.
                stall_retry_idx = 0
                ft_to_handle: Optional[_FallThrough] = None
                while True:
                    attempt_auth = _single_attempt_auth(direct_auth)
                    current_ttft_s = (
                        ttft_timeout_s * _STALL_TTFT_MULTIPLIERS[stall_retry_idx - 1]
                        if stall_retry_idx > 0
                        else ttft_timeout_s
                    )
                    try:
                        if direct_auth.token_type == "claude":
                            source = _try_claude_auth(
                                pool_spec=pool_spec,
                                messages=messages,
                                tools=claude_auth_tools,
                                tool_choice=claude_auth_tool_choice,
                                response_format=None if claude_auth_tools else openrouter_response_format,
                                max_tokens=max_tokens,
                                skip_cache_write=skip_cache_write,
                                auth=cast(ClaudeAuthContext, attempt_auth),
                                request_id=rid,
                                agent_id=agent_id,
                                call_site=call_site,
                                thinking=thinking,
                                effort=effort,
                                ttft_timeout_s=current_ttft_s,
                                idle_timeout_s=idle_timeout_s,
                            )
                        else:
                            source = _try_gpt_auth(
                                pool_spec=pool_spec,
                                messages=messages,
                                tools=gpt_auth_tools,
                                tool_choice=gpt_auth_tool_choice,
                                response_format=None if gpt_auth_tools else openrouter_response_format,
                                temperature=temperature,
                                effort=effort,
                                auth=cast(GptAuthContext, attempt_auth),
                                request_id=rid,
                                agent_id=agent_id,
                                call_site=call_site,
                                ttft_timeout_s=current_ttft_s,
                                idle_timeout_s=idle_timeout_s,
                            )

                        direct_yielded_any = False
                        direct_yielded_user_visible = False
                        try:
                            async for chunk in _guarded(source, ttft_override=current_ttft_s):
                                chunk = _with_timing_if_done(chunk)
                                direct_yielded_any = True
                                if chunk.kind in ("content", "reasoning", "tool_call"):
                                    direct_yielded_user_visible = True
                                if chunk.kind == "metadata" and chunk.data.get("actual_model"):
                                    _seen_actual_model = chunk.data["actual_model"]
                                elif chunk.kind == "usage":
                                    token_used = _compute_token_payload(direct_auth)
                                    usage_data = {
                                        **chunk.data,
                                        "compute_token_used": token_used,
                                        "compute_token_rotated": direct_rotations > 0,
                                    }
                                    if direct_auth.token_type == "claude":
                                        usage_data["claude_token_rotated"] = direct_rotations > 0
                                    else:
                                        usage_data["gpt_token_rotated"] = direct_rotations > 0
                                    chunk = StreamChunk(kind="usage", data=usage_data)
                                    _emit_llm_cache(chunk.data)
                                _record_dump_chunk(chunk)
                                yield chunk
                        except RoseStallError as exc:
                            if not direct_yielded_any:
                                raise _FallThrough() from exc
                            raise
                        except RoseDeadlineError as exc:
                            timeout_stall = RoseStallError(f"direct auth timeout_stall: {exc}")
                            setattr(timeout_stall, "failure_reason", "timeout_stall")
                            setattr(timeout_stall, "deadline_error", exc)
                            if not direct_yielded_user_visible:
                                raise _FallThrough() from timeout_stall
                            await _mark_direct_auth_stalled(
                                direct_auth,
                                request_id=rid,
                                agent_id=agent_id,
                                call_site=call_site,
                                failure_reason="timeout_stall",
                            )
                            raise
                        logger.info(
                            "rose.complete.direct_auth.done",
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            token_type=direct_auth.token_type,
                            rotations=direct_rotations,
                            stall_retries=stall_retry_idx,
                            elapsed_s=round(time.monotonic() - started, 3),
                            **_observability_fields(),
                        )
                        _finalize_dump()
                        return
                    except _FallThrough as ft:
                        cause = ft.__cause__
                        if (
                            isinstance(cause, RoseStallError)
                            and stall_retry_idx < len(_STALL_TTFT_MULTIPLIERS)
                        ):
                            stall_retry_idx += 1
                            next_ttft_s = ttft_timeout_s * _STALL_TTFT_MULTIPLIERS[stall_retry_idx - 1]
                            logger.info(
                                "rose.complete.direct_auth.stall_retry",
                                request_id=rid,
                                agent_id=agent_id,
                                call_site=call_site,
                                token_type=direct_auth.token_type,
                                attempt=stall_retry_idx,
                                next_ttft_s=next_ttft_s,
                            )
                            continue
                        ft_to_handle = ft
                        break

                ft = ft_to_handle
                assert ft is not None
                cause = ft.__cause__
                if direct_auth.token_type == "claude":
                    token_error = (
                        classify_claude_token_error(cause)
                        if isinstance(cause, RoseError)
                        else "server_error"
                    )
                    claude_token_error = token_error
                else:
                    token_error = (
                        classify_gpt_token_error(cause)
                        if isinstance(cause, RoseError)
                        else "server_error"
                    )
                    gpt_token_error = token_error
                direct_token_errors[direct_auth.token_type] = token_error
                logger.info(
                    "rose.complete.direct_auth.failed",
                    request_id=rid,
                    agent_id=agent_id,
                    call_site=call_site,
                    token_type=direct_auth.token_type,
                    reason=type(cause).__name__ if cause else "unknown",
                    token_error=token_error,
                    failure_reason=getattr(cause, "failure_reason", token_error),
                    rotations=direct_rotations,
                    stall_retries=stall_retry_idx,
                )
                failure_reason = str(getattr(cause, "failure_reason", token_error))
                if token_error == "stall":
                    await _mark_direct_auth_stalled(
                        direct_auth,
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        failure_reason=failure_reason,
                    )

                if token_error == "stall" and failure_reason == "timeout_stall" and remaining() <= 0:
                    deadline_error = getattr(cause, "deadline_error", None)
                    if isinstance(deadline_error, RoseDeadlineError):
                        raise deadline_error
                    raise RoseDeadlineError(f"rose.complete deadline exceeded after {deadline_s}s")

                # Stalls are rotation-eligible immediately: cold-start jitter
                # is absorbed by the 90s TTFT, and Anthropic's batched-response
                # silences are absorbed by the 120s idle window. A stall here
                # means the token/route itself is unhealthy, so rotate.
                can_rotate = (
                    token_error in ("auth_error", "rate_limit", "stall")
                    and direct_rotations < direct_auth.max_rotations
                    and direct_auth.fetch_fresh is not None
                )
                if not can_rotate:
                    break
                fresh = await direct_auth.fetch_fresh(direct_auth.user_id)
                if fresh is None:
                    break
                direct_rotations += 1
                direct_auth = fresh
                logger.info(
                    "rose.complete.direct_auth.rotated",
                    request_id=rid,
                    agent_id=agent_id,
                    call_site=call_site,
                    next_token_type=direct_auth.token_type,
                    next_source=direct_auth.source,
                    rotations=direct_rotations,
                    token_error=token_error,
                )

            if direct_token_errors:
                claude_token_error = direct_token_errors.get("claude", claude_token_error)
                gpt_token_error = direct_token_errors.get("gpt", gpt_token_error)

            # ── Anthropic API-key funded default ───────────────────────────
            # After compute tokens (claude/gpt) are exhausted and before the
            # OpenRouter waterfall: if a funded ANTHROPIC_API_KEY is configured
            # and not on the shared cooldown, try it (billed, `-anthropic`
            # suffix so cost is recorded). On out-of-credits/bad-key before
            # first content, back it off (shared DB cooldown) and fall through.
            anthropic_api_key = (load_config().anthropic.api_key or "").strip()
            if anthropic_api_key and not await _anthropic_api_key_on_cooldown():
                active_route = "anthropic_apikey"
                api_yielded_any = False
                try:
                    async for chunk in _guarded(
                        _try_anthropic_api_key(
                            pool_spec=pool_spec,
                            messages=messages,
                            api_key=anthropic_api_key,
                            tools=claude_auth_tools,
                            tool_choice=claude_auth_tool_choice,
                            response_format=None if claude_auth_tools else openrouter_response_format,
                            max_tokens=max_tokens,
                            skip_cache_write=skip_cache_write,
                            thinking=thinking,
                            effort=effort,
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            ttft_timeout_s=ttft_timeout_s,
                            idle_timeout_s=idle_timeout_s,
                        )
                    ):
                        chunk = _with_timing_if_done(chunk)
                        api_yielded_any = True
                        if chunk.kind == "metadata" and chunk.data.get("actual_model"):
                            _seen_actual_model = chunk.data["actual_model"]
                        elif chunk.kind == "usage":
                            _emit_llm_cache(chunk.data)
                        _record_dump_chunk(chunk)
                        yield chunk
                    logger.info(
                        "rose.complete.anthropic_apikey.done",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        elapsed_s=round(time.monotonic() - started, 3),
                        **_observability_fields(),
                    )
                    _finalize_dump()
                    return
                except (_FallThrough, RoseStallError) as exc:
                    if api_yielded_any:
                        raise
                    cause = exc.__cause__ if isinstance(exc, _FallThrough) else exc
                    if isinstance(cause, (RosePaymentRequiredError, RoseAuthError)):
                        await _mark_anthropic_api_key_cooldown(type(cause).__name__)
                    logger.info(
                        "rose.complete.anthropic_apikey.fall_through",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        reason=type(cause).__name__ if cause else "unknown",
                    )

            active_route = "waterfall"
            async for chunk in _guarded(
                waterfall_complete(
                    pool_spec=pool_spec,
                    messages=messages,
                    tools=tools,
                    tool_choice=tool_choice,
                    response_format=None if tools else openrouter_response_format,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    seed=seed,
                    openrouter_key=self._or_key(),
                    request_id=rid,
                    agent_id=agent_id,
                    call_site=call_site,
                    per_step_timeout_s=ttft_timeout_s,
                    idle_timeout_s=idle_timeout_s,
                )
            ):
                chunk = _with_timing_if_done(chunk)
                if claude_token_error is not None and chunk.kind == "metadata":
                    chunk = StreamChunk(
                        kind="metadata",
                        data={**chunk.data, "claude_token_error": claude_token_error},
                    )
                if gpt_token_error is not None and chunk.kind == "metadata":
                    chunk = StreamChunk(
                        kind="metadata",
                        data={**chunk.data, "gpt_token_error": gpt_token_error},
                    )
                if chunk.kind == "metadata" and chunk.data.get("actual_model"):
                    _seen_actual_model = chunk.data["actual_model"]
                elif chunk.kind == "usage":
                    _emit_llm_cache(chunk.data)
                _record_dump_chunk(chunk)
                yield chunk
            logger.info(
                "rose.complete.waterfall.done",
                request_id=rid,
                agent_id=agent_id,
                call_site=call_site,
                elapsed_s=round(time.monotonic() - started, 3),
                **_observability_fields(),
            )
            _finalize_dump()
        except RoseError as exc:
            _finalize_dump(exc)
            logger.error(
                "rose.complete.failed",
                request_id=rid,
                agent_id=agent_id,
                call_site=call_site,
                elapsed_s=round(time.monotonic() - started, 3),
                error_type=type(exc).__name__,
                error=str(exc),
                **_observability_fields(),
            )
            raise

    async def complete_browser_use(
        self,
        *,
        task: str,
        browser_state: Dict[str, Any],
        action_history: List[Dict[str, Any]],
        available_actions: List[str],
        include_screenshot: bool = False,
        dynamic_system_context: Optional[str] = None,
        turn_messages: Optional[List[Dict[str, Any]]] = None,
        claude_auth: Optional[ClaudeAuthContext] = None,
        gpt_auth: Optional[GptAuthContext] = None,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        call_site: str = "browser_use",
        deadline_s: float = _DEFAULT_DEADLINE_S,
        skip_cache_write: bool = False,
        dump_extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Run one browser-use step through the rose-1-browser-use pool.

        Builds the browser-use messages and native browser-action tools, runs
        the standard claudeAuth -> waterfall pipeline, parses the first tool
        call, and returns a dict shaped:

            {
                "action":        UnifiedAction,
                "actual_model":  "anthropic/claude-opus-4.8" | ...,
                "pool_name":     "rose-1-browser-use",
                "request_id":    str,
                "usage": {
                    "prompt_tokens": int,
                    "completion_tokens": int,
                    "total_tokens": int,
                    "cache_creation_input_tokens"?: int,
                    "cache_read_input_tokens"?: int,
                },
                "claude_token_error": Optional[str],
                "mode": "claude" | "gpt" | "waterfall",
            }

        Raises `RoseError` on transport / pool failure and `ValueError` if
        the model does not return a parseable browser action.
        """
        pool_spec = get_pool("rose-1-browser-use")
        max_tokens = 16000
        temperature = 1.0
        tools = build_browser_use_tools(available_actions)
        tool_choice = "any"
        messages = build_browser_use_messages(
            task=task,
            browser_state=browser_state,
            action_history=action_history,
            available_actions=available_actions,
            include_screenshot=include_screenshot,
            dynamic_system_context=dynamic_system_context,
            turn_messages=turn_messages,
        )
        response = await self.collect(
            pool="rose-1-browser-use",
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            max_tokens=max_tokens,
            temperature=temperature,
            claude_auth=claude_auth,
            gpt_auth=gpt_auth,
            agent_id=agent_id,
            request_id=request_id,
            call_site=call_site,
            deadline_s=deadline_s,
            skip_cache_write=skip_cache_write,
            dump_context=False,
        )

        actual_model = response.actual_model or ""
        # Only the `-claude` suffix indicates direct Anthropic via claudeAuth
        # (set in claude_auth.py). Plain "anthropic/claude-*" model names came
        # through the waterfall (sequential pool tries via OpenRouter).
        is_claude = actual_model.endswith("-claude")
        mode = "claude" if is_claude else ("gpt" if actual_model.endswith("-gpt") else "waterfall")
        if response.tool_calls:
            action = normalize_browser_use_tool_call(
                response.tool_calls[0],
                thinking=(response.reasoning or response.content or None),
            )
        else:
            action = normalize_browser_use_response(response.content)

        try:
            from helpers.observability import dump_llm_context

            # The renderer shows `output` as its own collapsible section; keep
            # it beside provider-visible messages/tools. Internal cache
            # sentinels are split out so dumps never show them as LLM text.
            dump_messages = _messages_without_internal_system_boundaries(messages)
            dump_llm_context(
                call_site=call_site,
                messages=dump_messages,
                agent_id=agent_id,
                model=_dump_display_model(actual_model),
                config=_browser_use_dump_config(
                    pool_spec=pool_spec,
                    response=response,
                    mode=mode,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    include_screenshot=include_screenshot,
                    call_site=call_site,
                    deadline_s=deadline_s,
                    claude_auth=claude_auth,
                    gpt_auth=gpt_auth,
                    available_actions=available_actions,
                    tools=tools,
                    tool_choice=tool_choice,
                ),
                tools=tools,
                output={
                    "action": action,
                    "content": response.content,
                    "reasoning": response.reasoning,
                    "tool_calls": response.tool_calls,
                    "usage": response.usage,
                    "timing": response.timing,
                    "request_id": response.request_id,
                },
                extra={
                    "browser_state": browser_state,
                    "action_history": action_history,
                    "turn_messages_count": len(turn_messages or []),
                    **(dump_extra or {}),
                },
            )
        except Exception:
            logger.debug("rose.browser_use.dump_output_failed", call_site=call_site, exc_info=True)

        return {
            "action": action,
            "actual_model": actual_model,
            "pool_name": response.pool_name or "rose-1-browser-use",
            "request_id": response.request_id,
            "usage": response.usage,
            "claude_token_error": response.claude_token_error,
            "gpt_token_error": response.gpt_token_error,
            "mode": mode,
        }

    async def collect(
        self,
        *,
        pool: PoolName,
        messages: List[Dict[str, Any]],
        response_model: Optional[Type[BaseModel]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Any = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        seed: Optional[int] = None,
        skip_cache_write: bool = False,
        claude_auth: Optional[ClaudeAuthContext] = None,
        gpt_auth: Optional[GptAuthContext] = None,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        call_site: str = "unspecified",
        deadline_s: float = _DEFAULT_DEADLINE_S,
        dump_context: bool = True,
        dump_extra: Optional[Dict[str, Any]] = None,
    ) -> RoseResponse:
        """Consume the stream into a single `RoseResponse` — convenience for
        non-streaming callers who don't care about incremental chunks."""
        result = RoseResponse()
        async for chunk in self.complete(
            pool=pool,
            messages=messages,
            response_model=response_model,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            seed=seed,
            skip_cache_write=skip_cache_write,
            claude_auth=claude_auth,
            gpt_auth=gpt_auth,
            agent_id=agent_id,
            request_id=request_id,
            call_site=call_site,
            deadline_s=deadline_s,
            dump_context=dump_context,
            dump_extra=dump_extra,
        ):
            _fold(result, chunk)
        return result


def _fold(result: RoseResponse, chunk: StreamChunk) -> None:
    """Mutate `result` in place from one chunk."""
    kind: ChunkKind = chunk.kind
    if kind == "metadata":
        result.actual_model = chunk.data.get("actual_model", "")
        result.pool_name = chunk.data.get("pool_name", "")
        result.request_id = chunk.data.get("request_id", "")
        # Only present when claudeAuth fell through — see client.complete().
        if "claude_token_error" in chunk.data:
            result.claude_token_error = chunk.data["claude_token_error"]
        if "gpt_token_error" in chunk.data:
            result.gpt_token_error = chunk.data["gpt_token_error"]
    elif kind == "content":
        result.content += chunk.data.get("text", "")
    elif kind == "reasoning":
        result.reasoning += chunk.data.get("text", "")
    elif kind == "codex_reasoning_item":
        result.codex_reasoning_items.append(dict(chunk.data))
    elif kind == "tool_call":
        result.tool_calls.append(dict(chunk.data))
    elif kind == "usage":
        result.usage = dict(chunk.data)
    elif kind == "done":
        timing = chunk.data.get("timing")
        if isinstance(timing, dict):
            result.timing = dict(timing)


async def _try_claude_auth(
    *,
    pool_spec: Any,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    max_tokens: Optional[int],
    skip_cache_write: bool,
    auth: ClaudeAuthContext,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    thinking: Optional[Dict[str, Any]] = None,
    effort: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = _DEFAULT_IDLE_TIMEOUT_S,
) -> AsyncIterator[StreamChunk]:
    """Yield from claudeAuth, but buffer the metadata chunk so a pre-content
    failure raises `_FallThrough` without the caller ever seeing a
    `claude-token` metadata event it'll never receive content for.
    """
    buffered: Optional[StreamChunk] = None
    yielded_any = False
    gen = claude_auth_complete(
        pool_spec=pool_spec,
        messages=messages,
        tools=tools,
        tool_choice=tool_choice,
        response_format=response_format,
        max_tokens=max_tokens,
        skip_cache_write=skip_cache_write,
        auth=auth,
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        thinking=thinking,
        effort=effort,
        ttft_timeout_s=ttft_timeout_s,
        idle_timeout_s=idle_timeout_s,
    )
    try:
        async for chunk in gen:
            if chunk.kind == "metadata" and buffered is None and not yielded_any:
                buffered = chunk
                continue
            if buffered is not None:
                yield buffered
                buffered = None
            yield chunk
            yielded_any = True
    except _FALL_THROUGH_ERRORS as exc:
        if not yielded_any:
            # Nothing has reached the caller (either buffered metadata only,
            # or HTTP failure before any chunk arrived) — safe to retry via
            # waterfall. The buffered metadata is discarded so the caller
            # never sees a `claude-token` event we won't deliver content for.
            raise _FallThrough() from exc
        # Already flushed content to caller — can't silently switch providers.
        raise


async def _try_gpt_auth(
    *,
    pool_spec: Any,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    temperature: Optional[float],
    effort: Optional[str],
    auth: GptAuthContext,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = _DEFAULT_IDLE_TIMEOUT_S,
) -> AsyncIterator[StreamChunk]:
    """Yield from gptAuth, buffering metadata for pre-content fall-through."""
    buffered: Optional[StreamChunk] = None
    yielded_any = False
    gen = gpt_auth_complete(
        pool_spec=pool_spec,
        messages=messages,
        response_format=response_format,
        tools=tools,
        tool_choice=tool_choice,
        temperature=temperature,
        effort=effort,
        auth=auth,
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        ttft_timeout_s=ttft_timeout_s,
        idle_timeout_s=idle_timeout_s,
    )
    try:
        async for chunk in gen:
            if chunk.kind == "metadata" and buffered is None and not yielded_any:
                buffered = chunk
                continue
            if buffered is not None:
                yield buffered
                buffered = None
            yield chunk
            yielded_any = True
    except _FALL_THROUGH_ERRORS as exc:
        if not yielded_any:
            raise _FallThrough() from exc
        raise


async def _try_anthropic_api_key(
    *,
    pool_spec: Any,
    messages: List[Dict[str, Any]],
    api_key: str,
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    max_tokens: Optional[int],
    skip_cache_write: bool,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    thinking: Optional[Dict[str, Any]] = None,
    effort: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = _DEFAULT_IDLE_TIMEOUT_S,
) -> AsyncIterator[StreamChunk]:
    """Yield from the funded Anthropic API-key path, buffering metadata so a
    pre-content failure raises `_FallThrough` (caller falls to the waterfall)."""
    buffered: Optional[StreamChunk] = None
    yielded_any = False
    gen = anthropic_api_key_complete(
        pool_spec=pool_spec,
        messages=messages,
        api_key=api_key,
        tools=tools,
        tool_choice=tool_choice,
        response_format=response_format,
        max_tokens=max_tokens,
        skip_cache_write=skip_cache_write,
        thinking=thinking,
        effort=effort,
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        ttft_timeout_s=ttft_timeout_s,
        idle_timeout_s=idle_timeout_s,
    )
    try:
        async for chunk in gen:
            if chunk.kind == "metadata" and buffered is None and not yielded_any:
                buffered = chunk
                continue
            if buffered is not None:
                yield buffered
                buffered = None
            yield chunk
            yielded_any = True
    except _FALL_THROUGH_ERRORS as exc:
        if not yielded_any:
            raise _FallThrough() from exc
        raise
