"""RoseClient — public orchestration layer for the Rose completions path.

One entry point, `RoseClient.complete()`, that:

  1. Tries the claudeAuth path (if a `ClaudeAuthContext` was supplied),
     buffering the metadata chunk so a pre-first-content failure can fall
     through to the waterfall without the caller ever seeing `claude-token`
     metadata it'll never receive content for.
  2. Falls through to the pool's waterfall on any typed claudeAuth error
     (`RoseInvalidRequest`, `RoseStallError`, `RoseServerError`,
     `RoseAuthError`, `RoseRateLimitError`) **before first content**.
  3. Enforces a top-level deadline (default 120s).
  4. Heartbeats every 10s so a long stream doesn't drop its Temporal
     activity.

All business logic lives in `claude_auth.py` and `waterfall.py`; this
module only does ordering + deadline + heartbeat + span propagation.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

import structlog

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
from providers.rose.legacy_adapter import classify_claude_token_error
from providers.rose.pools import PoolName, get_pool
from providers.rose.types import ChunkKind, ClaudeAuthContext, RoseResponse, StreamChunk
from providers.rose.waterfall import waterfall_complete

logger = structlog.get_logger()

_DEFAULT_DEADLINE_S = 120.0
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


class _FallThrough(Exception):
    """Internal signal — claudeAuth failed cleanly before emitting content."""


def _safe_heartbeat(message: str) -> None:
    """Emit a Temporal activity heartbeat if we're inside an activity,
    otherwise silently skip. Matches the pattern in `helpers/llm.py`."""
    with contextlib.suppress(Exception):
        from temporalio import activity
        activity.heartbeat(message)


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
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Any = None,
        response_format: Optional[Dict[str, Any]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        seed: Optional[int] = None,
        skip_cache_write: bool = False,
        claude_auth: Optional[ClaudeAuthContext] = None,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        call_site: str = "unspecified",
        deadline_s: float = _DEFAULT_DEADLINE_S,
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

        logger.info(
            "rose.complete.start",
            request_id=rid,
            agent_id=agent_id,
            call_site=call_site,
            pool=pool,
            claude_auth_present=claude_auth is not None,
            tool_count=len(tools or []),
            deadline_s=deadline_s,
        )

        remaining = lambda: deadline_s - (time.monotonic() - started)
        last_heartbeat = started

        async def _guarded(source: AsyncIterator[StreamChunk]) -> AsyncIterator[StreamChunk]:
            """Wrap an upstream generator with deadline + heartbeat checks.

            Each `__anext__` is capped at `min(idle_window, remaining)` so
            a hung provider can't outrun the top-level deadline.
            """
            nonlocal last_heartbeat
            it = source.__aiter__()
            while True:
                r = remaining()
                if r <= 0:
                    raise RoseDeadlineError(
                        f"rose.complete deadline exceeded after {deadline_s}s"
                    )
                # Cap the per-chunk wait at the deadline's remaining budget;
                # the inner layers already enforce their own 60s idle timeout.
                try:
                    chunk = await asyncio.wait_for(it.__anext__(), timeout=r)
                except asyncio.TimeoutError as exc:
                    raise RoseDeadlineError(
                        f"rose.complete deadline exceeded after {deadline_s}s"
                    ) from exc
                except StopAsyncIteration:
                    return
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

        try:
            if claude_auth is not None:
                try:
                    async for chunk in _guarded(_try_claude_auth(
                        pool_spec=pool_spec,
                        messages=messages,
                        tools=tools,
                        tool_choice=tool_choice,
                        response_format=response_format,
                        max_tokens=max_tokens,
                        skip_cache_write=skip_cache_write,
                        auth=claude_auth,
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        thinking=thinking,
                        effort=effort,
                    )):
                        yield chunk
                    logger.info(
                        "rose.complete.claude_auth.done",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        elapsed_s=round(time.monotonic() - started, 3),
                    )
                    return
                except _FallThrough as ft:
                    cause = ft.__cause__
                    if isinstance(cause, RoseError):
                        claude_token_error = classify_claude_token_error(cause)
                    else:
                        claude_token_error = "server_error"
                    logger.info(
                        "rose.complete.fall_through_to_waterfall",
                        request_id=rid,
                        agent_id=agent_id,
                        call_site=call_site,
                        reason=type(cause).__name__ if cause else "unknown",
                        claude_token_error=claude_token_error,
                    )

            async for chunk in _guarded(waterfall_complete(
                pool_spec=pool_spec,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                response_format=response_format,
                temperature=temperature,
                max_tokens=max_tokens,
                seed=seed,
                openrouter_key=self._or_key(),
                request_id=rid,
                agent_id=agent_id,
                call_site=call_site,
            )):
                if claude_token_error is not None and chunk.kind == "metadata":
                    chunk = StreamChunk(
                        kind="metadata",
                        data={**chunk.data, "claude_token_error": claude_token_error},
                    )
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
                "mode": "claude" | "racing",
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
            agent_id=agent_id,
            request_id=request_id,
            call_site=call_site,
            deadline_s=deadline_s,
        )

        action = normalize_browser_use_response(response.content)
        actual_model = response.actual_model or ""
        # Only the `-claude` suffix indicates direct Anthropic via claudeAuth
        # (set in claude_auth.py). Plain "anthropic/claude-*" model names from
        # the waterfall route through OpenRouter and count as racing mode.
        is_claude = actual_model.endswith("-claude")

        return {
            "action": action,
            "actual_model": actual_model,
            "pool_name": response.pool_name or "rose-1-browser-use",
            "request_id": response.request_id,
            "usage": response.usage,
            "claude_token_error": response.claude_token_error,
            "mode": "claude" if is_claude else "racing",
        }

    async def collect(
        self,
        *,
        pool: PoolName,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Any = None,
        response_format: Optional[Dict[str, Any]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        seed: Optional[int] = None,
        skip_cache_write: bool = False,
        claude_auth: Optional[ClaudeAuthContext] = None,
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
            tools=tools,
            tool_choice=tool_choice,
            response_format=response_format,
            temperature=temperature,
            max_tokens=max_tokens,
            seed=seed,
            skip_cache_write=skip_cache_write,
            claude_auth=claude_auth,
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
    elif kind == "content":
        result.content += chunk.data.get("text", "")
    elif kind == "reasoning":
        result.reasoning += chunk.data.get("text", "")
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
