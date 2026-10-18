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
import os
import ssl
import time
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator, Dict, FrozenSet, List, Optional, Type, cast

import structlog
from pydantic import BaseModel

from config import load_config
from helpers.activity_heartbeat import safe_heartbeat
from helpers.http_client import get_http_client
from providers.rose.browser_use import (
    build_browser_use_messages,
    build_browser_use_tools,
    filter_browser_use_actions_for_state,
    normalize_browser_use_response,
    normalize_browser_use_tool_call,
    normalize_browser_use_tool_calls,
)
from providers.rose.cerebras import cerebras_complete
from providers.rose.claude_auth import (
    DEFAULT_REASONING_EFFORT,
    anthropic_api_key_complete,
    claude_auth_complete,
)
from providers.rose.errors import (
    BrowserModelOutputValidationError,
    RoseAuthError,
    RoseDeadlineError,
    RoseError,
    RoseInvalidRequest,
    RosePaymentRequiredError,
    RoseRateLimitError,
    RoseRefusalError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.foundry import foundry_complete, foundry_configured
from providers.rose.gpt_auth import gpt_auth_complete, openai_api_key_complete
from providers.rose.legacy_adapter import classify_claude_token_error, classify_gpt_token_error
from providers.rose.policy import anthropic_family_excluded
from providers.rose.pools import PoolName, foundry_model, get_pool
from providers.rose.schema import (
    SYNTHETIC_OUTPUT_TOOL_NAME,
    build_anthropic_tools_from_response_model,
    build_openai_response_format,
)
from providers.rose.streaming import _stream_progress
from providers.rose.structured_output import StructuredOutputAccumulator
from providers.rose.transforms import messages_contain_images, route_model_accepts_images
from providers.rose.truncation import model_key, recover_truncated
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

# Provider errors that mean "try the next route" — as long as
# they fire before the first non-metadata chunk reaches the caller.
# TLS record alerts can escape httpx as raw SSLError while reading headers.
_FALL_THROUGH_ERRORS = (
    ssl.SSLError,
    RoseInvalidRequest,
    RoseStallError,
    RoseServerError,
    RoseAuthError,
    RoseRateLimitError,
    RosePaymentRequiredError,
    RoseRefusalError,
)

# Stall-retry budget for direct-auth attempts. Empty: the new 45s TTFT
# already covers cold-start jitter, and 150k Anthropic batched responses
# need the full deadline window — not three escalating retries that each
# kill the connection right before the model's flush burst arrives.
# A real stall still falls through to rotation/waterfall on the first
# attempt (see classify_*_token_error below).
_STALL_TTFT_MULTIPLIERS: tuple[float, ...] = ()


def _openai_api_key() -> str:
    return (os.getenv("GPT_API_KEY") or "").strip()


def _cerebras_api_key() -> str:
    return (os.getenv("CEREBRAS_API_KEY") or "").strip()


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
        client = get_http_client()
        resp = await client.get(
            f"{base}/api/integrations/compute-code/anthropic-key/cooldown",
            timeout=5.0,
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
        client = get_http_client()
        await client.post(
            f"{base}/api/integrations/compute-code/token/rate-limited",
            timeout=5.0,
            headers={"X-API-Key": cfg.backend.api_key or "", "Content-Type": "application/json"},
            json={"type": "anthropic", "source": "pool", "failureReason": reason},
        )
    except Exception:
        logger.warning("rose.anthropic_apikey.cooldown_mark_failed", reason=reason)


# The shared GPT_API_KEY uses the same cross-worker DB cooldown as Anthropic,
# with its own row so one provider cannot suppress the other.
_gpt_api_key_cooldown_skip_until = 0.0
_gpt_api_key_cooldown_last_check = 0.0


def _reset_gpt_api_key_cooldown_cache() -> None:
    global _gpt_api_key_cooldown_skip_until, _gpt_api_key_cooldown_last_check
    _gpt_api_key_cooldown_skip_until = 0.0
    _gpt_api_key_cooldown_last_check = 0.0


async def _gpt_api_key_on_cooldown() -> bool:
    global _gpt_api_key_cooldown_skip_until, _gpt_api_key_cooldown_last_check
    now = time.monotonic()
    if now < _gpt_api_key_cooldown_skip_until:
        return True
    if now - _gpt_api_key_cooldown_last_check < _ANTHROPIC_COOLDOWN_RECHECK_S:
        return False
    _gpt_api_key_cooldown_last_check = now
    cfg = load_config()
    base = (cfg.backend.api_url or "").rstrip("/")
    if not base:
        return False
    try:
        client = get_http_client()
        resp = await client.get(
            f"{base}/api/integrations/compute-code/gpt-key/cooldown",
            timeout=5.0,
            headers={"X-API-Key": cfg.backend.api_key or ""},
        )
        if resp.status_code == 200 and resp.json().get("onCooldown") is True:
            _gpt_api_key_cooldown_skip_until = now + _ANTHROPIC_COOLDOWN_RECHECK_S
            return True
    except Exception:
        return False
    return False


async def _mark_gpt_api_key_cooldown(reason: str) -> None:
    global _gpt_api_key_cooldown_skip_until
    _gpt_api_key_cooldown_skip_until = time.monotonic() + _ANTHROPIC_COOLDOWN_RECHECK_S
    cfg = load_config()
    base = (cfg.backend.api_url or "").rstrip("/")
    if not base:
        return
    try:
        client = get_http_client()
        resp = await client.post(
            f"{base}/api/integrations/compute-code/token/rate-limited",
            timeout=5.0,
            headers={"X-API-Key": cfg.backend.api_key or "", "Content-Type": "application/json"},
            json={"type": "gpt_api_key", "source": "pool", "failureReason": reason},
        )
        resp.raise_for_status()
    except Exception:
        logger.warning("rose.gpt_apikey.cooldown_mark_failed", reason=reason)


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
            lineage_key=auth.lineage_key,
            mark_rate_limited=auth.mark_rate_limited,
            fetch_fresh=None,
            heartbeat_lease=auth.heartbeat_lease,
            max_rotations=0,
        )
    return GptAuthContext(
        token=auth.token,
        source=auth.source,
        user_id=auth.user_id,
        account_id=auth.account_id,
        pool_token_id=auth.pool_token_id,
        lineage_key=auth.lineage_key,
        mark_rate_limited=auth.mark_rate_limited,
        fetch_fresh=None,
        heartbeat_lease=auth.heartbeat_lease,
        max_rotations=0,
    )


def _fire_and_forget_lease_heartbeat(auth: ComputeAuthContext) -> None:
    if auth.heartbeat_lease is None or not auth.lineage_key:
        return

    async def _heartbeat() -> None:
        with contextlib.suppress(Exception):
            await auth.heartbeat_lease(auth)

    with contextlib.suppress(Exception):
        asyncio.create_task(_heartbeat())


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
    safe_heartbeat(message)


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

    if actual_model.endswith(("-claude", "-anthropic")):
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


def _normalize_usage_input_tokens(actual_model: str, usage_data: Dict[str, Any]) -> Dict[str, Any]:
    """Expose one provider-neutral usage contract to agent cost accounting.

    Native Anthropic usage already reports only the uncached input tail in
    ``prompt_tokens``. OpenAI-compatible APIs include cached reads and writes
    in ``prompt_tokens``. The workflow prices those three buckets separately,
    so forwarding OpenAI's inclusive counter double-charges cached input.
    """
    cache_read = usage_data.get("cache_read_input_tokens", 0) or 0
    cache_write = usage_data.get("cache_creation_input_tokens", 0) or 0
    prompt_tokens = usage_data.get("prompt_tokens", 0) or 0
    cache_stats = _cache_input_accounting(
        actual_model=actual_model,
        prompt_tokens=prompt_tokens,
        cache_read=cache_read,
        cache_write=cache_write,
    )
    if cache_stats["cache_accounting"] == "exclusive":
        return usage_data
    return {
        **usage_data,
        "prompt_tokens": cache_stats["uncached_input"],
        "prompt_tokens_total": cache_stats["total_input"],
    }


def _dump_display_model(actual_model: str) -> str:
    """Human-facing model for debug dumps, without direct-auth route suffixes."""
    if actual_model.endswith("-claude"):
        return actual_model[: -len("-claude")]
    if actual_model.endswith("-gpt"):
        return actual_model[: -len("-gpt")]
    if actual_model.endswith("-openai"):
        return actual_model[: -len("-openai")]
    if actual_model.endswith("-foundry"):
        return actual_model[: -len("-foundry")]
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
    # complete_browser_use omits effort → body builders stamp DEFAULT (xhigh).
    # Record the effective wire value so dumps match what was actually sent.
    effective_effort = DEFAULT_REASONING_EFFORT
    if mode == "gpt":
        effective_params = {
            "model": pool_spec.gpt_auth_model,
            "temperature": None,
            "max_tokens": None,
            "reasoning_effort": effective_effort,
            "store": False,
            "parallel_tool_calls": True,
            "include": ["reasoning.encrypted_content"],
        }
    elif mode == "claude":
        effective_params = {
            "model": pool_spec.claude_auth_model,
            "temperature": 1,
            "max_tokens": max_tokens or 8192,
            "reasoning_effort": effective_effort,
            "thinking": None,
            "stream": True,
        }
    else:
        effective_params = {
            "model": effective_model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "reasoning_effort": effective_effort,
            "stream": True,
        }
    return {
        "pool": pool_spec.name,
        "actual_model": effective_model,
        "actual_model_raw": actual_model,
        "pool_name": response.pool_name or pool_spec.name,
        "mode": mode,
        "call_site": call_site,
        "effective_params": effective_params,
        "requested_params": {
            "max_tokens": max_tokens,
            "temperature": temperature,
            "reasoning_effort": None,  # caller omitted; builders fill default
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

    async def complete(self, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        """CENTRAL Fast Mode cache notch. EVERY agent LLM call funnels through
        `RoseClient.complete()`, so record/replay lives here — one place, no gaps,
        no per-call-site wiring. The cache context is read from the contextvar
        (position keying, set by the main loop for drift-robustness) or auto-resolved
        from `agent_id` (content keying, for every other call). On a hit the stored
        response is re-emitted as a synthetic stream; on a miss the live stream is
        teed and written when the `done` chunk arrives (never in a finally — see the
        GeneratorExit note in fast_cache.rose_cache). Allowlisted accounts can
        write-through with Fast Mode off: no read/replay, but successful calls are
        recorded for future Fast Mode runs.
        """
        from providers.fast_cache import client as _fc
        from providers.fast_cache.context import cache_writes_disabled, current_context
        from providers.fast_cache.rose_cache import FastCacheLookupError
        from providers.fast_cache.rose_cache import (
            accumulate_chunk as _fc_accumulate,
        )
        from providers.fast_cache.rose_cache import (
            empty_response as _fc_empty,
        )
        from providers.fast_cache.rose_cache import (
            replay_with_context as _fc_replay,
        )
        from providers.fast_cache.rose_cache import (
            request_key_material as _fc_request_key_material,
        )
        from providers.fast_cache.rose_cache import soft_complete_on_miss as _fc_soft_complete
        from providers.fast_cache.rose_cache import swf_scrape_passthrough as _fc_swf_passthrough

        call_site = kwargs.get("call_site", "unspecified")
        agent_id = kwargs.get("agent_id")
        messages = kwargs.get("messages")
        pool = kwargs.get("pool")
        probe_read_only = os.environ.get("BENCHMARK_DEMO_CACHE_READ_ONLY") == "1" and os.environ.get(
            "BENCHMARK_ISOLATED_RUN", ""
        ).strip().lower() in {"1", "true", "yes", "on"}
        exclude_anthropic_family = anthropic_family_excluded(bool(kwargs.get("_exclude_anthropic_family", False)))
        if exclude_anthropic_family != bool(kwargs.get("_exclude_anthropic_family", False)):
            kwargs = {**kwargs, "_exclude_anthropic_family": exclude_anthropic_family}

        # Browser steps run on their spawning agent's pool, so the explicit
        # flag (set by complete_browser_use) identifies them on any pool.
        browser_use = bool(kwargs.pop("browser_use", False))
        if browser_use or pool == "rose-1-browser-use" or str(call_site).startswith("browser_use"):
            if probe_read_only:
                raise FastCacheLookupError("DEMO replay probe forbids live browser LLM calls")
            async with aclosing(self._complete_impl(**kwargs, browser_use=True)) as live_stream:
                async for chunk in live_stream:
                    yield chunk
            return

        ctx = current_context()
        if ctx is None or not ctx.active:
            ctx = await _fc.ensure_context(agent_id)

        if "provider_fast_mode" not in kwargs:
            if ctx is not None and ctx.active:
                kwargs = {**kwargs, "provider_fast_mode": bool(ctx.provider_fast_mode)}
            elif agent_id:
                from providers.fast_cache.client import resolve_provider_fast_mode

                kwargs = {
                    **kwargs,
                    "provider_fast_mode": await resolve_provider_fast_mode(agent_id),
                }

        if ctx is None or not ctx.active or messages is None:
            if probe_read_only:
                raise FastCacheLookupError("DEMO replay probe has no usable cache context; live fallback is disabled")
            async with aclosing(self._complete_impl(**kwargs)) as live_stream:
                async for chunk in live_stream:
                    yield chunk
            return

        key = ctx.llm_key(call_site, _fc_request_key_material(kwargs))
        if ctx.read_enabled:
            lookup_failed = False
            stored: Any = None
            hit_key: Any = None
            try:
                from providers.fast_cache.rose_cache import lookup_llm_cache

                stored, hit_key = await lookup_llm_cache(ctx, call_site, _fc_request_key_material(kwargs))
            except FastCacheLookupError as exc:
                logger.warning(
                    "fast_cache.get_error",
                    key=key,
                    error=f"{type(exc).__name__}: {exc}"[:200],
                )
                if ctx.soft_complete_allowed:
                    raise
                stored, hit_key = None, None
                lookup_failed = True
            if stored is not None:
                can_promote_alias = str(call_site or "").strip() != "dag_param_populator"
                if hit_key and hit_key != key and ctx.should_write and can_promote_alias:
                    # Migrate demo-era / drifted keys onto the current fingerprint
                    # so subsequent runs hit without the alias path.
                    try:
                        await _fc.cache_set(key, "llm", ctx.goal_hash, stored)
                        logger.info(
                            "llm.cache.alias_promoted",
                            call_site=call_site,
                            from_key=hit_key,
                            to_key=key,
                        )
                    except Exception as exc:
                        logger.warning(
                            "llm.cache.alias_promote_error",
                            call_site=call_site,
                            error=str(exc)[:200],
                        )
                logger.info(
                    "llm.cache.replay",
                    call_site=call_site,
                    key=key,
                    hit_key=hit_key or key,
                    alias_hit=bool(hit_key and hit_key != key),
                )
                async with aclosing(
                    _fc_replay(
                        stored,
                        call_site=call_site,
                        complete_kwargs=kwargs,
                        cache_key=key,
                        hit_key=hit_key or key,
                        reason="cache_hit",
                    )
                ) as replay_stream:
                    async for chunk in replay_stream:
                        yield chunk
                return
            # Mirror cached_complete: cache-read failures must not look like a
            # clean miss and must not emit synthetic passthrough completions.
            if not lookup_failed:
                site = str(call_site or "").strip()
                # SWF: July explore namespaces often lack summarize_web_fetch rows
                # even when the scrape hit. Pass page text through instead of a
                # soft stub (reward hack) or a live Haiku call ($).
                if site == "summarize_web_fetch":
                    if ctx.soft_complete_allowed:
                        derived = _fc_swf_passthrough(messages)
                        logger.info(
                            "llm.cache.replay",
                            call_site=call_site,
                            key=key,
                            hit_key="scrape_passthrough",
                            reason="swf_scrape_passthrough",
                        )
                        async with aclosing(
                            _fc_replay(
                                derived,
                                call_site=call_site,
                                complete_kwargs=kwargs,
                                cache_key=key,
                                hit_key="scrape_passthrough",
                                reason="swf_scrape_passthrough",
                            )
                        ) as replay_stream:
                            async for chunk in replay_stream:
                                yield chunk
                        return
                    # Non-demo FM: fall through to live summarize.
                if site in {"completion_summary", "context_compression"}:
                    terminal = _fc_soft_complete(site)
                    if terminal is not None and ctx.soft_complete_allowed:
                        logger.info(
                            "llm.cache.replay",
                            call_site=call_site,
                            key=key,
                            hit_key="terminal_passthrough",
                            reason="fm_terminal_passthrough",
                        )
                        async with aclosing(
                            _fc_replay(
                                terminal,
                                call_site=call_site,
                                complete_kwargs=kwargs,
                                cache_key=key,
                                hit_key="terminal_passthrough",
                                reason="fm_terminal_passthrough",
                            )
                        ) as replay_stream:
                            async for chunk in replay_stream:
                                yield chunk
                        return
                soft = _fc_soft_complete(call_site)
                # Warm end-of-trajectory: emit as replay passthrough (not soft_complete)
                # so honest hit metrics stay replay-only / soft≈0.
                if (
                    soft is not None
                    and ctx.soft_complete_allowed
                    and await _fc.trajectory_prior_exists(ctx.goal_hash, call_site, ctx.base_step)
                ):
                    logger.info(
                        "llm.cache.replay",
                        call_site=call_site,
                        key=key,
                        hit_key="trajectory_end_passthrough",
                        reason="fm_trajectory_end_passthrough",
                    )
                    async with aclosing(
                        _fc_replay(
                            soft,
                            call_site=call_site,
                            complete_kwargs=kwargs,
                            cache_key=key,
                            hit_key="trajectory_end_passthrough",
                            reason="fm_trajectory_end_passthrough",
                        )
                    ) as replay_stream:
                        async for chunk in replay_stream:
                            yield chunk
                    return
                # Cold allowlisted sites must not burn live LLM under Fast Mode read.
                # Known July GP execute namespaces start at p:1 — do not stub them
                # as cold when the first get-position flakes.
                from providers.fast_cache.rose_cache import is_july_explore_site, is_july_gp_execute_site

                if (
                    soft is not None
                    and ctx.soft_complete_allowed
                    and not is_july_gp_execute_site(ctx, call_site)
                    and not is_july_explore_site(ctx, call_site)
                ):
                    logger.info(
                        "llm.cache.replay",
                        call_site=call_site,
                        key=key,
                        hit_key="cold_namespace_passthrough",
                        reason="fm_cold_namespace_passthrough",
                    )
                    async with aclosing(
                        _fc_replay(
                            soft,
                            call_site=call_site,
                            complete_kwargs=kwargs,
                            cache_key=key,
                            hit_key="cold_namespace_passthrough",
                            reason="fm_cold_namespace_passthrough",
                        )
                    ) as replay_stream:
                        async for chunk in replay_stream:
                            yield chunk
                    return
            logger.info("llm.cache.miss", call_site=call_site, key=key, lookup_failed=lookup_failed)
        else:
            # Write-through must always call live LLM. Soft/passthrough end-notches
            # belong only on the Fast Mode *read* path. Applying them here aborts
            # cold seeding after p:1 (prior slot = the row this run just wrote),
            # which left spawn-sub-agents explore/execute stuck in attempt_completion
            # loops with cache-status stubs instead of substantive tool evidence.
            logger.info("llm.cache.write_only", call_site=call_site, key=key)

        if probe_read_only:
            raise FastCacheLookupError("DEMO replay probe cache miss; live fallback is disabled")
        if ctx.read_enabled and ctx.soft_complete_allowed and cache_writes_disabled() and not ctx.should_write:
            raise FastCacheLookupError(
                f"Strict read-only benchmark cache miss for {call_site or 'unknown'}; live fallback is disabled"
            )

        structured_response_model = kwargs.get("response_model") is not None
        acc = _fc_empty()
        async with aclosing(self._complete_impl(**kwargs)) as live_stream:
            async for chunk in live_stream:
                _fc_accumulate(acc, chunk)
                if chunk.kind == "done" and ctx.should_write and not structured_response_model:
                    stored = await _fc.cache_set(key, "llm", ctx.goal_hash, acc)
                    logger.info("llm.cache.stored" if stored else "llm.cache.store_skipped", call_site=call_site, key=key)
                yield chunk

    async def _complete_impl(self, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        """One completion under the shared cut-off policy (`providers/rose/truncation.py`).

        `recover_truncation=True` is passed by consumers that handle `restart`
        chunks; everyone else gets exactly one attempt, as before.
        """
        if not kwargs.pop("recover_truncation", False):
            kwargs.pop("result_required", None)
            kwargs.pop("retry_partial_errors", None)
            async with aclosing(self._complete_once(**kwargs)) as stream:
                async for chunk in stream:
                    yield chunk
            return
        async with aclosing(recover_truncated(self._complete_once, kwargs)) as stream:
            async for chunk in stream:
                yield chunk

    async def _complete_once(
        self,
        *,
        pool: PoolName,
        messages: List[Dict[str, Any]],
        response_model: Optional[Type[BaseModel]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        context_tools: Optional[
            List[Dict[str, Any]]
        ] = None,  # Declared-only tools legalizing forked tool history (never called)
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
        provider_fast_mode: bool = True,
        dump_context: bool = True,
        dump_extra: Optional[Dict[str, Any]] = None,
        cache_namespace: Optional[str] = None,
        prefer_azure: bool = False,
        json_mode: bool = False,
        browser_use: bool = False,
        _exclude_anthropic_family: bool = False,
        _skip_models: FrozenSet[str] = frozenset(),
    ) -> AsyncIterator[StreamChunk]:
        """Run a full Rose completion, yielding normalized StreamChunks.

        Order: one `metadata` chunk first, then any number of
        `content`/`tool_call`/`reasoning` chunks, then exactly one `usage`
        chunk, then exactly one `done` chunk. All failures raise typed
        `RoseError`s; callers never see error chunks.
        """
        # Allow a process owner to prove that a maintenance or benchmark run
        # cannot consume Anthropic credit. This complements the existing
        # call-scoped flag and covers nested browser/evaluator calls as well.
        _exclude_anthropic_family = anthropic_family_excluded(_exclude_anthropic_family)
        pool_spec = get_pool(pool)
        rid = request_id or uuid.uuid4().hex[:12]
        auth_identity = claude_auth or gpt_auth
        foundry_route_key = agent_id or (auth_identity.user_id if auth_identity else rid)
        started = time.monotonic()
        first_contentful_at: Optional[float] = None

        openrouter_response_format = (
            build_openai_response_format(response_model) if response_model is not None
            else {"type": "json_object"} if json_mode else None
        )
        direct_auth_tools = tools
        effective_tool_choice = tool_choice
        if direct_auth_tools is None and response_model is not None:
            direct_auth_tools = build_anthropic_tools_from_response_model(
                response_model,
                model=pool_spec.claude_auth_model,
            )
        # OpenRouter accepts the same native function-tool contract. Preserve
        # the AgentAction projection through the final fallback instead of
        # reverting to response_format, which OpenRouter's Anthropic routes
        # reject and some Gemini routes handle inconsistently.
        waterfall_tools = None
        waterfall_tool_choice = effective_tool_choice
        if not _is_synthetic_output_toolset(direct_auth_tools):
            waterfall_tools = direct_auth_tools
        if waterfall_tools:
            waterfall_tool_choice = effective_tool_choice or "any"
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
                            "provider_fast_mode": provider_fast_mode,
                        },
                        # Effective wire effort: callers may omit; body builders
                        # always stamp DEFAULT_REASONING_EFFORT (xhigh).
                        "reasoning_effort": (effort if effort is not None else DEFAULT_REASONING_EFFORT),
                        "response_model": response_model.__name__ if response_model else None,
                        "direct_auth": {
                            "claude": claude_auth is not None,
                            "gpt": gpt_auth is not None,
                        },
                        "candidate_models": {
                            "claude_auth": (None if _exclude_anthropic_family else pool_spec.claude_auth_model),
                            "gpt_auth": pool_spec.gpt_auth_model,
                            "waterfall": [
                                model
                                for model in pool_spec.waterfall
                                if not (_exclude_anthropic_family and "anthropic/" in model)
                            ],
                        },
                        "exclude_anthropic_family": _exclude_anthropic_family,
                    },
                    response_format=None if waterfall_tools else openrouter_response_format,
                    tools=waterfall_tools,
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

        def _with_cache_sequence(chunk: StreamChunk) -> StreamChunk:
            """Expose the exact provider cache namespace on persisted usage."""
            if chunk.kind != "usage" or not cache_namespace:
                return chunk
            return StreamChunk(
                kind="usage",
                data={**chunk.data, "cache_sequence_id": cache_namespace},
            )

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
        gpt_api_key_tools = None
        gpt_api_key_tool_choice = None
        anthropic_api_key_tools = None
        anthropic_api_key_tool_choice = None
        # A direct credential can rotate between Claude and GPT inside this
        # call, so prepare both provider contracts before route selection. If
        # these projections depend on the credential present at entry, a
        # cross-type rotation receives a response_format intended for the old
        # route instead of the AgentAction native tools.
        if not _is_synthetic_output_toolset(direct_auth_tools):
            claude_auth_tools = direct_auth_tools
            gpt_auth_tools = direct_auth_tools
        if claude_auth_tools:
            # response_model is the explicit signal that "tool_calls is the
            # only legal response shape." `auto` lets Anthropic emit prose
            # instead, so force a native tool call on either direct route.
            claude_auth_tool_choice = effective_tool_choice or "any"
        if gpt_auth_tools:
            gpt_auth_tool_choice = effective_tool_choice or "any"
        # The funded OpenAI API-key route uses the same Responses native
        # tool protocol as gptAuth, so it must preserve real tool schemas even
        # when there is no direct GPT token lease.
        if not _is_synthetic_output_toolset(direct_auth_tools):
            gpt_api_key_tools = direct_auth_tools
        if gpt_api_key_tools:
            gpt_api_key_tool_choice = effective_tool_choice or "any"
        # The funded Anthropic API-key route is the same native Anthropic
        # protocol as claudeAuth, so it must preserve real tool schemas even
        # when the direct route was GPT-only and then fell through.
        if not _is_synthetic_output_toolset(direct_auth_tools):
            anthropic_api_key_tools = direct_auth_tools
        if anthropic_api_key_tools:
            anthropic_api_key_tool_choice = effective_tool_choice or "any"
        waterfall_tools = tools
        waterfall_tool_choice = tool_choice
        if tools is None and direct_auth_tools and not _is_synthetic_output_toolset(direct_auth_tools):
            # AgentAction response models already have provider-neutral native
            # tool schemas. Preserve that contract through the OpenRouter
            # waterfall so Anthropic is not skipped merely because the original
            # caller supplied a response_model instead of explicit tools.
            waterfall_tools = direct_auth_tools
            waterfall_tool_choice = effective_tool_choice or "any"

        # OpenRouter's OpenAI providers apply the same strict-schema subset as
        # the Responses API. Rich AgentAction models can contain intentionally
        # open JSON values (for example spawn_agent.items), which cannot be
        # represented by that subset and are rejected before inference. Use the
        # provider-native function contract for real AgentAction tools on the
        # waterfall too. The structured-streaming caller already reconstructs
        # native tool chunks into the AgentAction envelope, exactly as it does
        # for direct Claude/GPT and funded API-key routes. Plain response models
        # keep their response_format contract via the synthetic-output guard.
        waterfall_tools = tools
        waterfall_tool_choice = effective_tool_choice
        if waterfall_tools is None and not _is_synthetic_output_toolset(direct_auth_tools):
            waterfall_tools = direct_auth_tools
            waterfall_tool_choice = effective_tool_choice or "any"

        eligible_claude_auth = claude_auth if model_key(pool_spec.claude_auth_model) not in _skip_models else None
        eligible_gpt_auth = gpt_auth if model_key(pool_spec.gpt_auth_model) not in _skip_models else None
        if not pool_spec.direct_auth_enabled:
            # An open-weights-only pool must never reach a proprietary
            # direct-token provider, or the model guarantee it exists to make
            # is silently void.
            direct_auth = None
        elif _exclude_anthropic_family and eligible_gpt_auth is not None:
            direct_auth = eligible_gpt_auth
        elif _exclude_anthropic_family:
            direct_auth = None
        else:
            direct_auth = eligible_claude_auth or eligible_gpt_auth

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
            exclude_anthropic_family=_exclude_anthropic_family,
        )

        def remaining() -> float:
            return deadline_s - (time.monotonic() - started)

        last_heartbeat = started
        first_chunk_at: Optional[float] = None
        last_chunk_at: Optional[float] = None
        first_productive_kind: Optional[str] = None
        last_chunk_kind: Optional[str] = None
        chunk_counts: Dict[str, int] = {}
        active_route = "not_started"
        buffered_tool_argument_fragments = 0
        last_tool_argument_at: Optional[float] = None

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
                "buffered_tool_argument_fragments": buffered_tool_argument_fragments,
                "last_tool_argument_s": _elapsed_s(last_tool_argument_at),
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

            Nonempty buffered tool-argument fragments are also real progress.
            They refresh a configured idle window without emitting partial
            tools. When idle checks are disabled, TTFT still bounds the wait
            for the first emitted productive chunk.
            Each HTTP attempt resets TTFT; metadata/keepalives do not refresh it.
            """
            nonlocal first_chunk_at, first_contentful_at, first_productive_kind
            nonlocal last_chunk_at, last_chunk_kind, last_heartbeat
            nonlocal buffered_tool_argument_fragments, last_tool_argument_at
            ttft_budget = ttft_override if ttft_override is not None else ttft_timeout_s
            it = source.__aiter__()
            saw_productive_chunk = False
            saw_emitted_productive_chunk = False
            attempt_started = time.monotonic()
            last_progress_at: Optional[float] = None
            productive_kinds = {"content", "reasoning", "tool_call", "codex_reasoning_item"}

            def note_progress(kind: str, size: int) -> None:
                nonlocal saw_productive_chunk, attempt_started, last_progress_at
                nonlocal saw_emitted_productive_chunk
                nonlocal buffered_tool_argument_fragments, last_tool_argument_at
                now = time.monotonic()
                if kind == "attempt":
                    attempt_started = now
                    saw_productive_chunk = False
                    saw_emitted_productive_chunk = False
                    last_progress_at = None
                    last_tool_argument_at = None
                elif kind == "tool_arguments" and size > 0:
                    saw_productive_chunk = True
                    last_progress_at = now
                    last_tool_argument_at = now
                    buffered_tool_argument_fragments += 1

            while True:
                r = remaining()
                if r <= 0:
                    raise RoseDeadlineError(f"rose.complete deadline exceeded after {deadline_s}s")
                wait_started = time.monotonic()
                # Slice long waits so Temporal heartbeats keep firing during
                # TTFT / mid-stream idle gaps. Without this, a single
                # wait_for up to ttft_timeout_s (90s) or idle_timeout_s (120s)
                # can outrun reasoning's activity heartbeat_timeout and
                # cancel the activity mid-call (seen as "activity Heartbeat
                # timeout" on dag_reasoning while provider_read was still
                # blocked on the first token).
                chunk = None
                timed_out = False
                # Do NOT use asyncio.wait_for for sliced waits — on timeout it
                # cancels the pending __anext__ and permanently closes the
                # upstream async generator. Use asyncio.wait so heartbeats can
                # fire while the same __anext__ awaitable stays outstanding.
                progress_token = _stream_progress.set(note_progress)
                try:
                    next_item = asyncio.ensure_future(it.__anext__())
                finally:
                    # The pending task inherits this request's callback; the
                    # consumer and concurrent sibling requests never do.
                    _stream_progress.reset(progress_token)
                try:
                    while True:
                        using_idle_budget = saw_productive_chunk and (
                            idle_timeout_s is not None or saw_emitted_productive_chunk
                        )
                        if using_idle_budget:
                            progress_timeout = idle_timeout_s
                            # Preserve consumer backpressure tolerance between
                            # normalized chunks, while refreshing a pending
                            # chunk only from actual parser progress.
                            progress_deadline = (
                                max(wait_started, last_progress_at or wait_started) + progress_timeout
                                if progress_timeout is not None
                                else started + deadline_s
                            )
                        else:
                            progress_timeout = ttft_budget
                            progress_deadline = attempt_started + ttft_budget
                        outer_deadline_limited = started + deadline_s <= progress_deadline
                        wait_deadline = min(started + deadline_s, progress_deadline)
                        slice_timeout = min(
                            _HEARTBEAT_INTERVAL_S,
                            wait_deadline - time.monotonic(),
                        )
                        if slice_timeout <= 0:
                            timed_out = True
                            break
                        done, _pending = await asyncio.wait({next_item}, timeout=slice_timeout)
                        if next_item in done:
                            try:
                                chunk = next_item.result()
                            except StopAsyncIteration:
                                return
                            break
                        now = time.monotonic()
                        if now - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                            _safe_heartbeat(f"rose.complete waiting call_site={call_site} request_id={rid}")
                            last_heartbeat = now
                        # Recompute before declaring expiry: the parser may
                        # have consumed arguments without yielding a chunk.
                finally:
                    # If the chunk landed in the same tick as the deadline,
                    # consume it instead of reporting a stall (CodeRabbit #1260).
                    if timed_out and next_item.done() and not next_item.cancelled():
                        try:
                            chunk = next_item.result()
                            timed_out = False
                        except StopAsyncIteration:
                            chunk = None
                            timed_out = False
                    # Always cancel an unfinished __anext__ on exit — including
                    # CancelledError while awaiting asyncio.wait. Leaving it
                    # running after the activity ends raises an unobserved
                    # exception (CodeRabbit #1260).
                    if not next_item.done():
                        next_item.cancel()
                        with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                            await next_item
                if chunk is None and not timed_out:
                    return
                if timed_out:
                    if outer_deadline_limited:
                        raise RoseDeadlineError(f"rose.complete deadline exceeded after {deadline_s}s")
                    if using_idle_budget:
                        raise RoseDeadlineError(f"rose.complete idle for {progress_timeout}s (deadline {deadline_s}s)")
                    raise RoseStallError(f"rose.complete TTFT exceeded {ttft_budget}s")
                assert chunk is not None
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
                    saw_emitted_productive_chunk = True
                    last_progress_at = now
                if now - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                    _safe_heartbeat(f"rose.complete call_site={call_site} request_id={rid}")
                    last_heartbeat = now
                yielded_at = time.monotonic()
                yield chunk
                if not saw_productive_chunk:
                    # TTFT measures provider waits, excluding time a downstream
                    # consumer deliberately keeps this generator suspended.
                    # The fixed whole-call deadline still includes that time.
                    attempt_started += time.monotonic() - yielded_at

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
                is_gpt=_seen_actual_model.endswith(("-gpt", "-openai", "-foundry")),
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
                candidate = (
                    pool_spec.claude_auth_model if direct_auth.token_type == "claude" else pool_spec.gpt_auth_model
                )
                if model_key(candidate) in _skip_models:
                    logger.info(
                        "rose.complete.direct_auth.skipped", actual_model=candidate, reason="candidate_excluded"
                    )
                    break
                if _exclude_anthropic_family and direct_auth.token_type == "claude":
                    logger.info(
                        "rose.complete.direct_auth.skipped",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        token_type=direct_auth.token_type,
                        reason="anthropic_family_excluded",
                    )
                    break
                active_route = f"direct_auth:{direct_auth.token_type}"
                # Per-token stall-retry: bump TTFT and re-attempt with the
                # same token before classifying as a fall-through. Cold pool
                # slots often clear on attempt 2 with a wider window.
                stall_retry_idx = 0
                ft_to_handle: Optional[_FallThrough] = None
                while True:
                    attempt_auth = _single_attempt_auth(direct_auth)
                    _fire_and_forget_lease_heartbeat(direct_auth)
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
                                context_tools=context_tools,
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
                                provider_fast_mode=provider_fast_mode,
                                ttft_timeout_s=current_ttft_s,
                                idle_timeout_s=idle_timeout_s,
                            )
                        else:
                            source = _try_gpt_auth(
                                pool_spec=pool_spec,
                                messages=messages,
                                tools=gpt_auth_tools,
                                context_tools=context_tools,
                                tool_choice=gpt_auth_tool_choice,
                                response_format=None if gpt_auth_tools else openrouter_response_format,
                                temperature=temperature,
                                effort=effort,
                                auth=cast(GptAuthContext, attempt_auth),
                                request_id=rid,
                                agent_id=agent_id,
                                call_site=call_site,
                                cache_namespace=cache_namespace,
                                provider_fast_mode=provider_fast_mode,
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
                                    chunk = StreamChunk(
                                        kind="usage",
                                        data=_normalize_usage_input_tokens(_seen_actual_model, chunk.data),
                                    )
                                chunk = _with_cache_sequence(chunk)
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
                        if isinstance(cause, RoseStallError) and stall_retry_idx < len(_STALL_TTFT_MULTIPLIERS):
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
                    token_error = classify_claude_token_error(cause) if isinstance(cause, RoseError) else "server_error"
                    claude_token_error = token_error
                else:
                    token_error = classify_gpt_token_error(cause) if isinstance(cause, RoseError) else "server_error"
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

            # ── OpenAI API-key funded default ──────────────────────────────
            # After compute tokens (claude/gpt) are exhausted and before the
            # Anthropic/OpenRouter fallbacks: if a funded GPT API key is
            # configured, try the pool's GPT model with priority service tier.
            # An open-weights-only pool must not reach the funded proprietary
            # API keys either -- gating only the OAuth routes left this hole,
            # through which a pinned run could still be served by gpt_auth_model.
            openai_api_key = _openai_api_key() if pool_spec.direct_auth_enabled else ""
            if (
                openai_api_key
                and model_key(pool_spec.gpt_auth_model) not in _skip_models
                and not await _gpt_api_key_on_cooldown()
            ):
                active_route = "openai_apikey"
                openai_yielded_any = False
                try:
                    async for chunk in _guarded(
                        _try_openai_api_key(
                            **({"max_tokens": max_tokens} if max_tokens is not None else {}),
                            pool_spec=pool_spec,
                            model=pool_spec.gpt_auth_model,
                            messages=messages,
                            api_key=openai_api_key,
                            tools=gpt_api_key_tools,
                            context_tools=context_tools,
                            tool_choice=gpt_api_key_tool_choice,
                            response_format=None if gpt_api_key_tools else openrouter_response_format,
                            temperature=temperature,
                            effort=effort,
                            provider_fast_mode=provider_fast_mode,
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            cache_namespace=cache_namespace,
                            ttft_timeout_s=ttft_timeout_s,
                            idle_timeout_s=idle_timeout_s,
                        )
                    ):
                        chunk = _with_timing_if_done(chunk)
                        openai_yielded_any = True
                        if chunk.kind == "metadata":
                            metadata = dict(chunk.data)
                            if claude_token_error is not None:
                                metadata["claude_token_error"] = claude_token_error
                            if gpt_token_error is not None:
                                metadata["gpt_token_error"] = gpt_token_error
                            chunk = StreamChunk(kind="metadata", data=metadata)
                            if chunk.data.get("actual_model"):
                                _seen_actual_model = chunk.data["actual_model"]
                        elif chunk.kind == "usage":
                            _emit_llm_cache(chunk.data)
                            chunk = StreamChunk(
                                kind="usage",
                                data=_normalize_usage_input_tokens(_seen_actual_model, chunk.data),
                            )
                        chunk = _with_cache_sequence(chunk)
                        _record_dump_chunk(chunk)
                        yield chunk
                    logger.info(
                        "rose.complete.openai_apikey.done",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        elapsed_s=round(time.monotonic() - started, 3),
                        **_observability_fields(),
                    )
                    _finalize_dump()
                    return
                except (_FallThrough, RoseStallError) as exc:
                    if openai_yielded_any:
                        raise
                    cause = exc.__cause__ if isinstance(exc, _FallThrough) else exc
                    if isinstance(cause, (RosePaymentRequiredError, RoseAuthError)):
                        await _mark_gpt_api_key_cooldown(type(cause).__name__)
                    logger.info(
                        "rose.complete.openai_apikey.fall_through",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        reason=type(cause).__name__ if cause else "unknown",
                    )

            # ── Anthropic API-key funded default ───────────────────────────
            # After compute tokens (claude/gpt) and the shared GPT key are
            # exhausted and before the OpenRouter waterfall: if a funded
            # ANTHROPIC_API_KEY is configured and not on the shared cooldown,
            # try it (billed, `-anthropic` suffix so cost is recorded). On
            # out-of-credits/bad-key before first content, back it off (shared
            # DB cooldown) and fall through.
            anthropic_api_key = (load_config().anthropic.api_key or "").strip()
            if (
                pool_spec.direct_auth_enabled
                and not _exclude_anthropic_family
                and anthropic_api_key
                and model_key(pool_spec.claude_auth_model) not in _skip_models
                and not await _anthropic_api_key_on_cooldown()
            ):
                active_route = "anthropic_apikey"
                api_yielded_any = False
                try:
                    async for chunk in _guarded(
                        _try_anthropic_api_key(
                            pool_spec=pool_spec,
                            messages=messages,
                            api_key=anthropic_api_key,
                            tools=anthropic_api_key_tools,
                            context_tools=context_tools,
                            tool_choice=anthropic_api_key_tool_choice,
                            response_format=None if anthropic_api_key_tools else openrouter_response_format,
                            max_tokens=max_tokens,
                            skip_cache_write=skip_cache_write,
                            thinking=thinking,
                            effort=effort,
                            provider_fast_mode=provider_fast_mode,
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            ttft_timeout_s=ttft_timeout_s,
                            idle_timeout_s=idle_timeout_s,
                        )
                    ):
                        chunk = _with_timing_if_done(chunk)
                        api_yielded_any = True
                        if chunk.kind == "metadata":
                            metadata = dict(chunk.data)
                            if claude_token_error is not None:
                                metadata["claude_token_error"] = claude_token_error
                            if gpt_token_error is not None:
                                metadata["gpt_token_error"] = gpt_token_error
                            chunk = StreamChunk(kind="metadata", data=metadata)
                            if chunk.data.get("actual_model"):
                                _seen_actual_model = chunk.data["actual_model"]
                        elif chunk.kind == "usage":
                            _emit_llm_cache(chunk.data)
                            chunk = StreamChunk(
                                kind="usage",
                                data=_normalize_usage_input_tokens(_seen_actual_model, chunk.data),
                            )
                        chunk = _with_cache_sequence(chunk)
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

            cerebras_key = _cerebras_api_key() if pool_spec.cerebras_model else ""
            for route in (("foundry", "cerebras") if prefer_azure else ("cerebras", "foundry")):
                if route == "cerebras" and cerebras_key and model_key(pool_spec.cerebras_model) not in _skip_models:
                    active_route = "cerebras"
                    cerebras_yielded_any = False
                    try:
                        async with aclosing(
                            cerebras_complete(
                                pool_spec=pool_spec,
                                messages=messages,
                                tools=waterfall_tools,
                                tool_choice=waterfall_tool_choice,
                                response_format=None if waterfall_tools else openrouter_response_format,
                                temperature=temperature,
                                max_tokens=max_tokens,
                                cerebras_key=cerebras_key,
                                request_id=rid,
                                agent_id=agent_id,
                                call_site=call_site,
                                per_step_timeout_s=ttft_timeout_s,
                                idle_timeout_s=idle_timeout_s,
                            )
                        ) as cerebras_source:
                            async for chunk in _guarded(cerebras_source):
                                chunk = _with_timing_if_done(chunk)
                                cerebras_yielded_any = True
                                if chunk.kind == "metadata":
                                    metadata = dict(chunk.data)
                                    if claude_token_error is not None:
                                        metadata["claude_token_error"] = claude_token_error
                                    if gpt_token_error is not None:
                                        metadata["gpt_token_error"] = gpt_token_error
                                    chunk = StreamChunk(kind="metadata", data=metadata)
                                    if chunk.data.get("actual_model"):
                                        _seen_actual_model = chunk.data["actual_model"]
                                elif chunk.kind == "usage":
                                    _emit_llm_cache(chunk.data)
                                    chunk = StreamChunk(
                                        kind="usage",
                                        data=_normalize_usage_input_tokens(_seen_actual_model, chunk.data),
                                    )
                                chunk = _with_cache_sequence(chunk)
                                _record_dump_chunk(chunk)
                                yield chunk
                        logger.info(
                            "rose.complete.cerebras.done",
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            elapsed_s=round(time.monotonic() - started, 3),
                            **_observability_fields(),  # pragma: allowlist secret
                        )
                        _finalize_dump()
                        return
                    except (_FallThrough, RoseStallError, RoseError) as exc:
                        if cerebras_yielded_any:
                            raise
                        cause = exc.__cause__ if isinstance(exc, _FallThrough) else exc
                        logger.info(
                            "rose.complete.cerebras.fall_through",
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            reason=type(cause).__name__ if cause else type(exc).__name__,
                        )

                # Funded Azure fallback for the pool's GPT model and Responses shape
                # (the compute-token contract). It follows direct credentials and
                # direct Cerebras hop by default. Collected WHM calls can prefer
                # Azure and discard a partial reply before retrying another model.
                # Ordinary visible partial replies remain errors.
                # A model that was cut off at its output limit is excluded from every
                # route that serves it, funded ones included (see truncation.py).
                if route != "foundry":
                    continue
                # A text-only Foundry model cannot see an image request, so
                # screenshots retain main's direct vision-waterfall routing.
                foundry_blind = messages_contain_images(messages) and not route_model_accepts_images(
                    foundry_model(pool_spec)
                )
                if foundry_blind and foundry_configured(pool_spec):
                    logger.info(
                        "rose.complete.foundry.skipped",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        model=foundry_model(pool_spec),
                        reason="images_need_vision",
                    )
                if (
                    foundry_configured(pool_spec)
                    and not foundry_blind
                    and model_key(foundry_model(pool_spec)) not in _skip_models
                ):
                    active_route = "foundry"
                    foundry_yielded_any = False
                    try:
                        async with aclosing(
                            foundry_complete(
                                **({"max_tokens": max_tokens} if max_tokens is not None else {}),
                                pool_spec=pool_spec,
                                messages=messages,
                                response_format=None if gpt_api_key_tools else openrouter_response_format,
                                tools=gpt_api_key_tools,
                                context_tools=context_tools,
                                tool_choice=gpt_api_key_tool_choice,
                                temperature=temperature,
                                # A fallback layer: speed pools pin their fast effort (xhigh TTFT is slow).
                                effort=pool_spec.waterfall_reasoning_effort or effort,
                                provider_fast_mode=provider_fast_mode,
                                request_id=rid,
                                route_key=foundry_route_key,
                                agent_id=agent_id,
                                call_site=call_site,
                                cache_namespace=cache_namespace,
                                ttft_timeout_s=ttft_timeout_s,
                                idle_timeout_s=idle_timeout_s,
                            )
                        ) as foundry_source:
                            async for chunk in _guarded(foundry_source):
                                chunk = _with_timing_if_done(chunk)
                                foundry_yielded_any = True
                                if chunk.kind == "metadata":
                                    metadata = dict(chunk.data)
                                    if claude_token_error is not None:
                                        metadata["claude_token_error"] = claude_token_error
                                    if gpt_token_error is not None:
                                        metadata["gpt_token_error"] = gpt_token_error
                                    chunk = StreamChunk(kind="metadata", data=metadata)
                                    if chunk.data.get("actual_model"):
                                        _seen_actual_model = chunk.data["actual_model"]
                                elif chunk.kind == "usage":
                                    _emit_llm_cache(chunk.data)
                                    chunk = StreamChunk(
                                        kind="usage", data=_normalize_usage_input_tokens(_seen_actual_model, chunk.data)
                                    )
                                chunk = _with_cache_sequence(chunk)
                                _record_dump_chunk(chunk)
                                yield chunk
                        logger.info("rose.complete.foundry.done", request_id=rid, agent_id=agent_id, call_site=call_site)
                        _finalize_dump()
                        return
                    except (_FallThrough, RoseStallError, RoseError) as exc:
                        if foundry_yielded_any:
                            raise
                        cause = exc.__cause__ if isinstance(exc, _FallThrough) else exc
                        logger.info(
                            "rose.complete.foundry.fall_through",
                            request_id=rid,
                            agent_id=agent_id,
                            call_site=call_site,
                            reason=type(cause).__name__ if cause else "unknown",
                        )

            active_route = "waterfall"
            async for chunk in waterfall_complete(
                pool_spec=pool_spec,
                messages=messages,
                tools=waterfall_tools,
                tool_choice=waterfall_tool_choice,
                response_format=None if waterfall_tools else openrouter_response_format,
                temperature=temperature,
                max_tokens=max_tokens,
                seed=seed,
                provider_fast_mode=provider_fast_mode,
                effort=effort,
                openrouter_key=self._or_key(),
                request_id=rid,
                agent_id=agent_id,
                call_site=call_site,
                per_step_timeout_s=ttft_timeout_s,
                idle_timeout_s=idle_timeout_s,
                exclude_anthropic_family=_exclude_anthropic_family,
                cache_namespace=cache_namespace,
                skip_cache_write=skip_cache_write,
                skip_models=_skip_models,
                browser_use=browser_use,
                stream_guard=_guarded,
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
                    chunk = StreamChunk(
                        kind="usage",
                        data=_normalize_usage_input_tokens(_seen_actual_model, chunk.data),
                    )
                chunk = _with_cache_sequence(chunk)
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
        cache_namespace: Optional[str] = None,
        pool: PoolName = "rose-1-browser-use",
    ) -> Dict[str, Any]:
        """Run one browser-use step through ``pool`` (the spawning agent's pool).

        Builds the browser-use messages and native browser-action tools, runs
        the standard claudeAuth -> waterfall pipeline, parses the first tool
        call, and returns a dict shaped:

            {
                "action":        UnifiedAction,
                "actual_model":  "anthropic/claude-opus-4.8" | ...,
                "pool_name":     pool,
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
        pool_spec = get_pool(pool)
        # A browser step needs one action. A 16k cap let a malformed Qwen
        # response stream for 215s without a tool call (WebDecoy bench),
        # consuming half the task deadline before the caller could retry.
        max_tokens = 2048
        temperature = 0.3
        state_actions = filter_browser_use_actions_for_state(available_actions, browser_state)
        tools = build_browser_use_tools(state_actions)
        # IMPORTANT: "auto", not "any". Forcing tool use ("any") forbids the model from
        # emitting a reasoning text block before its tool call; without that reasoning step
        # the model degenerates into reflexively re-picking the safe no-op `screenshot` tool
        # every turn (verified: identical request returns a 17-token bare `screenshot` under
        # "any" vs. reasoned `input_text`/`click` actions under "auto"). The browser loop is
        # agentic — it needs the model to think, then act.
        tool_choice = "auto"
        messages = build_browser_use_messages(
            task=task,
            browser_state=browser_state,
            action_history=action_history,
            available_actions=state_actions,
            include_screenshot=include_screenshot,
            dynamic_system_context=dynamic_system_context,
            turn_messages=turn_messages,
        )
        # Bind failed dumps to the same request that the client attempts.
        request_id = request_id or uuid.uuid4().hex[:12]
        try:
            response = await self.collect(
                pool=pool,
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
                cache_namespace=cache_namespace,
                browser_use=True,
            )
        except Exception as exc:
            try:
                from helpers.observability import dump_llm_context

                dump_llm_context(
                    call_site=call_site,
                    messages=_messages_without_internal_system_boundaries(messages),
                    agent_id=agent_id,
                    model=pool,
                    config={
                        "pool": pool,
                        "actual_model": None,
                        "mode": None,
                        "capture_boundary": "complete_browser_use.collect",
                        "requested_params": {
                            "max_tokens": max_tokens,
                            "temperature": temperature,
                            "reasoning_effort": None,
                            "thinking": None,
                            "seed": None,
                            "response_format": None,
                            "tool_choice": tool_choice,
                            "deadline_s": deadline_s,
                            "ttft_timeout_s": _DEFAULT_TTFT_TIMEOUT_S,
                            "idle_timeout_s": _DEFAULT_IDLE_TIMEOUT_S,
                            "provider_fast_mode": True,
                            "skip_cache_write": skip_cache_write,
                            "cache_namespace": cache_namespace,
                        },
                        "pool_direct_auth_enabled": pool_spec.direct_auth_enabled,
                        "pool_waterfall_reasoning_effort": pool_spec.waterfall_reasoning_effort,
                        "candidate_models": {
                            "cerebras": pool_spec.cerebras_model,
                            "waterfall": list(pool_spec.waterfall),
                        },
                        "direct_auth_requested": {
                            "claude": claude_auth is not None,
                            "gpt": gpt_auth is not None,
                        },
                    },
                    tools=tools,
                    output={"request_id": request_id, "error": {"type": type(exc).__name__, "message": str(exc)}},
                    extra={
                        "browser_state": browser_state,
                        "action_history": action_history,
                        "turn_messages_count": len(turn_messages or []),
                        **(dump_extra or {}),
                    },
                )
            except Exception:
                logger.debug("rose.browser_use.dump_failure_failed", call_site=call_site, exc_info=True)
            raise

        actual_model = response.actual_model or ""
        # Only the `-claude` suffix indicates direct Anthropic via claudeAuth
        # (set in claude_auth.py). Plain "anthropic/claude-*" model names came
        # through the waterfall (sequential pool tries via OpenRouter).
        is_claude = actual_model.endswith("-claude")
        mode = "claude" if is_claude else ("gpt" if actual_model.endswith("-gpt") else "waterfall")
        from browser_tools.schemas import BrowserToolArgsValidationError

        output_validation_error = None
        action = None
        try:
            available_tool_names = [tool["name"] for tool in tools]
            if response.tool_calls:
                # Check the declared action before coordinate/key projections
                # can replace its name with an internal implementation action.
                normalize_browser_use_tool_call(
                    response.tool_calls[0], available_actions=available_tool_names,
                )
                action = normalize_browser_use_tool_calls(
                    response.tool_calls,
                    thinking=(response.reasoning or response.content or None),
                )
            else:
                action = normalize_browser_use_response(
                    response.content, available_actions=available_tool_names,
                )
        except BrowserToolArgsValidationError:
            raise
        except ValueError as normalization_error:
            output_validation_error = BrowserModelOutputValidationError(
                str(normalization_error), response=response,
            )

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
                    **({"output_validation_error": str(output_validation_error), "private_output_validation_detail": output_validation_error.private_detail} if output_validation_error else {}),
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

        if output_validation_error is not None:
            raise output_validation_error

        return {
            "action": action,
            "actual_model": actual_model,
            "pool_name": response.pool_name or pool,
            "request_id": response.request_id,
            "usage": response.usage,
            "claude_token_error": response.claude_token_error,
            "gpt_token_error": response.gpt_token_error,
            "mode": mode,
            "timing": response.timing,
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
        cache_namespace: Optional[str] = None,
        result_required: bool = False,
        prefer_azure: bool = False,
        retry_partial_errors: bool = False,
        json_mode: bool = False,
        browser_use: bool = False,
    ) -> RoseResponse:
        """Consume the stream into a single `RoseResponse` — convenience for
        non-streaming callers who don't care about incremental chunks.

        `result_required` declares a plain reply that is itself the result (for
        example a JSON document), so an output-limit cut-off gets the shared
        recovery in `providers/rose/truncation.py` instead of a partial reply."""
        result = RoseResponse()
        structured_output = StructuredOutputAccumulator() if response_model is not None else None
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
            cache_namespace=cache_namespace,
            browser_use=browser_use,
            recover_truncation=True,
            result_required=result_required,
            **({"prefer_azure": True} if prefer_azure else {}),
            **({"retry_partial_errors": True} if retry_partial_errors else {}),
            **({"json_mode": True} if json_mode else {}),
        ):
            if chunk.kind == "restart":
                result = RoseResponse()
                structured_output = StructuredOutputAccumulator() if response_model is not None else None
            elif chunk.kind == "content" and structured_output is not None:
                structured_output.add_chunk(chunk)
            else:
                _fold(result, chunk)
        if structured_output is not None:
            extracted = structured_output.current_text()
            if extracted:
                result.content = extracted
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
    elif kind == "reasoning":
        result.reasoning += chunk.data.get("text", "")
    elif kind == "content":
        result.content += chunk.data.get("text", "")
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
    context_tools: Optional[List[Dict[str, Any]]] = None,
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
    provider_fast_mode: bool = True,
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
        context_tools=context_tools,
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
        provider_fast_mode=provider_fast_mode,
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
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    temperature: Optional[float],
    effort: Optional[str],
    auth: GptAuthContext,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    cache_namespace: Optional[str] = None,
    provider_fast_mode: bool = True,
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
        context_tools=context_tools,
        tool_choice=tool_choice,
        temperature=temperature,
        effort=effort,
        auth=auth,
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        cache_namespace=cache_namespace,
        provider_fast_mode=provider_fast_mode,
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


async def _try_openai_api_key(
    *,
    pool_spec: Any,
    model: str,
    messages: List[Dict[str, Any]],
    api_key: str,
    tools: Optional[List[Dict[str, Any]]],
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    temperature: Optional[float],
    effort: Optional[str],
    provider_fast_mode: bool = True,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    cache_namespace: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = _DEFAULT_IDLE_TIMEOUT_S,
    max_tokens: Optional[int] = None,
) -> AsyncIterator[StreamChunk]:
    """Yield from the funded OpenAI API-key route, buffering metadata for
    pre-content fall-through."""
    buffered: Optional[StreamChunk] = None
    yielded_any = False
    gen = openai_api_key_complete(
        **({"max_tokens": max_tokens} if max_tokens is not None else {}),
        pool_spec=pool_spec,
        model=model,
        messages=messages,
        response_format=response_format,
        tools=tools,
        context_tools=context_tools,
        tool_choice=tool_choice,
        temperature=temperature,
        effort=effort,
        openai_key=api_key,
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        cache_namespace=cache_namespace,
        provider_fast_mode=provider_fast_mode,
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
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    max_tokens: Optional[int],
    skip_cache_write: bool,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    thinking: Optional[Dict[str, Any]] = None,
    effort: Optional[str] = None,
    provider_fast_mode: bool = True,
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
        context_tools=context_tools,
        tool_choice=tool_choice,
        response_format=response_format,
        max_tokens=max_tokens,
        skip_cache_write=skip_cache_write,
        thinking=thinking,
        effort=effort,
        provider_fast_mode=provider_fast_mode,
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
