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
  4. Enforces a top-level deadline (default 120s).
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

import structlog
from pydantic import BaseModel

from config import load_config
from providers.rose.browser_use import build_browser_use_messages, normalize_browser_use_response
from providers.rose.claude_auth import claude_auth_complete
from providers.rose.errors import (
    RoseAuthError,
    RoseDeadlineError,
    RoseError,
    RoseInvalidRequest,
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
    tool_requires_forced_choice,
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

_DEFAULT_DEADLINE_S = 120.0
_DEFAULT_TTFT_TIMEOUT_S = 20.0
_DEFAULT_IDLE_TIMEOUT_S = None
_HEARTBEAT_INTERVAL_S = 10.0

# Errors from claude_auth that mean "try the waterfall next" — as long as
# they fire before the first non-metadata chunk reaches the caller.
_FALL_THROUGH_ERRORS = (
    RoseInvalidRequest,
    RoseStallError,
    RoseServerError,
    RoseAuthError,
    RoseRateLimitError,
)


def _is_synthetic_output_toolset(tools: Optional[List[Dict[str, Any]]]) -> bool:
    return (
        isinstance(tools, list)
        and len(tools) == 1
        and isinstance(tools[0], dict)
        and tools[0].get("name") == SYNTHETIC_OUTPUT_TOOL_NAME
    )


class _FallThrough(Exception):
    """Internal signal — claudeAuth failed cleanly before emitting content."""


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

        openrouter_response_format = (
            build_openai_response_format(response_model) if response_model is not None else None
        )
        claude_auth_tools = None
        claude_auth_tool_choice = None
        gpt_auth_tools = None
        gpt_auth_tool_choice = None
        direct_auth_tools = None
        if response_model is not None and (claude_auth is not None or gpt_auth is not None):
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
            if claude_auth_tools and any(tool_requires_forced_choice(tool) for tool in claude_auth_tools):
                claude_auth_tool_choice = "any"
        if gpt_auth is not None:
            # Plain structured-output models are better enforced by the
            # Responses `text.format` JSON schema than by a synthetic submit
            # tool. Keep native tools only for real tool-call models.
            if not _is_synthetic_output_toolset(direct_auth_tools):
                gpt_auth_tools = direct_auth_tools
            if gpt_auth_tools:
                gpt_auth_tool_choice = "any"

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

        async def _guarded(source: AsyncIterator[StreamChunk]) -> AsyncIterator[StreamChunk]:
            """Wrap an upstream generator with deadline + TTFT checks."""
            nonlocal last_heartbeat
            it = source.__aiter__()
            saw_productive_chunk = False
            productive_kinds = {"content", "reasoning", "tool_call", "codex_reasoning_item"}
            while True:
                r = remaining()
                if r <= 0:
                    raise RoseDeadlineError(f"rose.complete deadline exceeded after {deadline_s}s")
                progress_timeout = remaining() if saw_productive_chunk else ttft_timeout_s
                try:
                    chunk = await asyncio.wait_for(it.__anext__(), timeout=min(r, progress_timeout))
                except asyncio.TimeoutError as exc:
                    if saw_productive_chunk:
                        raise RoseDeadlineError(f"rose.complete deadline exceeded after {deadline_s}s") from exc
                    raise RoseStallError(f"rose.complete TTFT exceeded {ttft_timeout_s}s") from exc
                except StopAsyncIteration:
                    return
                if chunk.kind in productive_kinds:
                    saw_productive_chunk = True
                now = time.monotonic()
                if now - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                    _safe_heartbeat(f"rose.complete call_site={call_site} request_id={rid}")
                    last_heartbeat = now
                yield chunk

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
                attempt_auth = _single_attempt_auth(direct_auth)
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
                            ttft_timeout_s=ttft_timeout_s,
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
                            ttft_timeout_s=ttft_timeout_s,
                            idle_timeout_s=idle_timeout_s,
                        )

                    direct_yielded_any = False
                    try:
                        async for chunk in _guarded(source):
                            direct_yielded_any = True
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
                            yield chunk
                    except RoseStallError as exc:
                        if not direct_yielded_any:
                            raise _FallThrough() from exc
                        raise
                    logger.info(
                        "rose.complete.direct_auth.done",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        token_type=direct_auth.token_type,
                        rotations=direct_rotations,
                        elapsed_s=round(time.monotonic() - started, 3),
                    )
                    return
                except _FallThrough as ft:
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
                        rotations=direct_rotations,
                    )

                    can_rotate = (
                        token_error in ("auth_error", "rate_limit")
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
                    )

            if direct_token_errors:
                claude_token_error = direct_token_errors.get("claude", claude_token_error)
                gpt_token_error = direct_token_errors.get("gpt", gpt_token_error)

            async for chunk in _guarded(
                waterfall_complete(
                    pool_spec=pool_spec,
                    messages=messages,
                    tools=None,
                    tool_choice=None,
                    response_format=openrouter_response_format,
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
                yield chunk
            logger.info(
                "rose.complete.waterfall.done",
                request_id=rid,
                agent_id=agent_id,
                call_site=call_site,
                elapsed_s=round(time.monotonic() - started, 3),
            )
        except RoseError as exc:
            logger.error(
                "rose.complete.failed",
                request_id=rid,
                agent_id=agent_id,
                call_site=call_site,
                elapsed_s=round(time.monotonic() - started, 3),
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

    async def complete_browser_use(
        self,
        *,
        task: str,
        browser_state: Dict[str, Any],
        action_history: List[Dict[str, Any]],
        available_actions: List[str],
        include_screenshot: bool = True,
        claude_auth: Optional[ClaudeAuthContext] = None,
        gpt_auth: Optional[GptAuthContext] = None,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        call_site: str = "browser_use",
        deadline_s: float = _DEFAULT_DEADLINE_S,
    ) -> Dict[str, Any]:
        """Run one browser-use step through the rose-1-browser-use pool.

        Builds the browser-use messages, runs the standard claudeAuth ->
        waterfall pipeline (no tools — model returns JSON in text), parses
        the JSON action envelope, and returns a dict shaped:

            {
                "action":        UnifiedAction,
                "actual_model":  "anthropic/claude-opus-4.7" | ...,
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
                "mode": "claude" | "waterfall",
            }

        Raises `RoseError` on transport / pool failure and `ValueError` if
        the model's text reply doesn't contain a parseable action envelope.
        """
        messages = build_browser_use_messages(
            task=task,
            browser_state=browser_state,
            action_history=action_history,
            available_actions=available_actions,
            include_screenshot=include_screenshot,
        )
        response = await self.collect(
            pool="rose-1-browser-use",
            messages=messages,
            max_tokens=16000,
            temperature=1.0,
            claude_auth=claude_auth,
            gpt_auth=gpt_auth,
            agent_id=agent_id,
            request_id=request_id,
            call_site=call_site,
            deadline_s=deadline_s,
        )

        action = normalize_browser_use_response(response.content)
        actual_model = response.actual_model or ""
        # Only the `-claude` suffix indicates direct Anthropic via claudeAuth
        # (set in claude_auth.py). Plain "anthropic/claude-*" model names came
        # through the waterfall (sequential pool tries via OpenRouter).
        is_claude = actual_model.endswith("-claude")

        return {
            "action": action,
            "actual_model": actual_model,
            "pool_name": response.pool_name or "rose-1-browser-use",
            "request_id": response.request_id,
            "usage": response.usage,
            "claude_token_error": response.claude_token_error,
            "gpt_token_error": response.gpt_token_error,
            "mode": "claude" if is_claude else ("gpt" if actual_model.endswith("-gpt") else "waterfall"),
        }

    async def collect(
        self,
        *,
        pool: PoolName,
        messages: List[Dict[str, Any]],
        response_model: Optional[Type[BaseModel]] = None,
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
    ) -> RoseResponse:
        """Consume the stream into a single `RoseResponse` — convenience for
        non-streaming callers who don't care about incremental chunks."""
        result = RoseResponse()
        async for chunk in self.complete(
            pool=pool,
            messages=messages,
            response_model=response_model,
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
    # `done` is terminal — nothing to fold.


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
