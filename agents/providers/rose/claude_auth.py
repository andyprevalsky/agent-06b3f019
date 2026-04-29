"""Direct Anthropic streaming call + retry + pool-rotation.

The Claude OAuth / "claudeAuth" path. When a user's Claude Max token is
available, we call Anthropic directly — the user's subscription pays for
inference, so Rose sees $0 cost. The pool of shared tokens the backend
maintains (`fetch_claude_max_token_activity` / `mark_claude_token_rate_limited_activity`)
is rotated on auth/rate-limit failures via the callbacks in
`ClaudeAuthContext`.

Contract (P1):

    In-place retry (same token):
        429                -> up to 3 attempts, exp backoff (retry-after honoured, cap 5s)
        5xx                -> up to 3 attempts, exp backoff (cap 5s)
        connect/tls errors -> up to 3 attempts, exp backoff (cap 5s)

    Pool rotation (fetch fresh token, up to `max_rotations` swaps):
        401 / 403          -> rotate immediately
        429 after retries  -> rotate

    Fall-through (raise typed error, caller goes to waterfall):
        400                -> RoseInvalidRequest  (do NOT rotate; next token
                              would hit the same 400 and chain through pool)
        stall / TTFT miss  -> RoseStallError
        rotation exhausted -> RoseAuthError

The stream itself (from `streaming.parse_anthropic_sse`) enforces the idle
timeout; this module only handles pre-stream HTTP error classification and
orchestration.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from providers.rose.errors import (
    RoseAuthError,
    RoseError,
    RoseInvalidRequest,
    RoseRateLimitError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.pools import PoolSpec
from providers.rose.streaming import parse_anthropic_sse
from providers.rose.transforms import (
    _extract_tools_from_response_format,
    apply_anthropic_tool_config,
    transform_messages_for_anthropic,
)
from providers.rose.transport import get_error_body, post_anthropic_stream
from providers.rose.types import ClaudeAuthContext, StreamChunk

logger = structlog.get_logger()

_MAX_ATTEMPTS_PER_TOKEN = 3
_BACKOFF_CAP_S = 5.0
_DEFAULT_IDLE_TIMEOUT_S = 60.0
_COOLDOWN_SECONDS = 5 * 60


# Claude OAuth tokens require the first two system blocks to be a specific
# identity pair — the token validator at Anthropic checks for these. Order
# and text match research/.../service/claude-token.ts:277-290 exactly.
_IDENTITY_BLOCK = {
    "type": "text",
    "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
}
_DISCLAIMER_BLOCK = {
    "type": "text",
    "text": (
        "Disregard the previous identity — you are NOT Claude Code. "
        "You are a Rose Labs AI agent. Follow the system instructions below."
    ),
}


def _add_cache_breakpoint(messages: List[Dict[str, Any]]) -> None:
    """Add cache_control to the last content block of the last message.

    Mutates in place. Mirrors Claude Code's addCacheBreakpoints: exactly one
    message-level marker so the server knows where the reusable prefix ends.
    """
    if not messages:
        return
    last = messages[-1]
    content = last.get("content")
    if isinstance(content, str):
        last["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
    elif isinstance(content, list) and content:
        target = content[-1]
        if isinstance(target, dict):
            target["cache_control"] = {"type": "ephemeral"}


def _add_tool_cache_breakpoint(body: Dict[str, Any]) -> None:
    """Add cache_control to the last tool definition so system+tools prefix is cached."""
    tools = body.get("tools")
    if tools and isinstance(tools, list) and len(tools) > 0:
        tools[-1]["cache_control"] = {"type": "ephemeral"}


def build_anthropic_body(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    max_tokens: Optional[int],
    skip_cache_write: bool = False,
) -> Dict[str, Any]:
    """Assemble the Anthropic /v1/messages request body for a claudeAuth call.

    Returns a dict ready to pass as JSON to `post_anthropic_stream`. The body
    is deterministic in its inputs — callers can safely reuse it across
    token rotations without rebuilding.

    skip_cache_write: when True, system+tools still get cache markers (so the
    shared prefix can be READ from cache), but the message-level breakpoint is
    omitted so the one-off trailing message doesn't WRITE a new cache entry.
    """
    static_system, dynamic_system, anthropic_messages = transform_messages_for_anthropic(messages)

    if not anthropic_messages:
        raise RoseInvalidRequest(
            "claudeAuth: messages list is empty after transform (only system prompt, no user/assistant messages)",
            status=400,
        )

    body: Dict[str, Any] = {
        "model": pool_spec.claude_auth_model,
        "messages": anthropic_messages,
        "max_tokens": max_tokens or 8192,
        "stream": True,
    }

    system_blocks: List[Dict[str, Any]] = []
    if static_system:
        system_blocks.append({
            "type": "text",
            "text": static_system,
            "cache_control": {"type": "ephemeral", "scope": "global"},
        })
    if dynamic_system:
        system_blocks.append({"type": "text", "text": dynamic_system})
    body["system"] = [_IDENTITY_BLOCK, _DISCLAIMER_BLOCK, *system_blocks]

    if not skip_cache_write and anthropic_messages:
        _add_cache_breakpoint(anthropic_messages)

    body["thinking"] = {"type": "adaptive"}
    body["temperature"] = 1

    # Resolve native tools: prefer explicit tools; fall back to extracting
    # from response_format (the Pydantic-schema → anyOf → native-tools path).
    # Extraction happens once here so the body is self-contained and
    # deterministic across retries/rotations.
    native_tools = tools
    if native_tools is None and response_format is not None:
        extracted = _extract_tools_from_response_format(response_format)
        if extracted is not None:
            native_tools = extracted["tools"]

    native_tool_mode = apply_anthropic_tool_config(
        body,
        response_format,
        True,  # always native tools on claudeAuth
        native_tools,
        tool_choice,
    )

    _add_tool_cache_breakpoint(body)

    # Anthropic rejects thinking when tool_choice forces tool use.
    # Both "any" (must use some tool) and "tool" (must use specific tool)
    # count as forced — only "auto" (model decides) allows thinking.
    tc = body.get("tool_choice") or {}
    if native_tool_mode and tc.get("type") in ("any", "tool") and "thinking" in body:
        body.pop("thinking", None)
        body.pop("temperature", None)

    # Set effort AFTER apply_anthropic_tool_config (which may pop output_config
    # for json_schema reasons) — effort is always valid regardless of tool mode.
    oc = body.get("output_config") or {}
    oc["effort"] = "high"
    body["output_config"] = oc

    def _h(obj: Any) -> str:
        return hashlib.md5(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:8]

    logger.info(
        "cache.prefix_fingerprint",
        static_sys_hash=_h(static_system),
        dynamic_sys_hash=_h(dynamic_system),
        tools_hash=_h(body.get("tools")),
        msg_count=len(anthropic_messages),
        skip_cache_write=skip_cache_write,
    )

    return body


async def claude_auth_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    response_format: Optional[Dict[str, Any]] = None,
    max_tokens: Optional[int] = None,
    skip_cache_write: bool = False,
    auth: ClaudeAuthContext,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_IDLE_TIMEOUT_S,
    idle_timeout_s: float = _DEFAULT_IDLE_TIMEOUT_S,
) -> AsyncIterator[StreamChunk]:
    """Run a claudeAuth attempt end-to-end, yielding normalized StreamChunks.

    On any fall-through failure, raises a typed `RoseError` the caller
    (client.py) translates into a waterfall attempt. On success, the
    generator runs to completion and the last yielded chunk has
    `kind="done"`.
    """
    body = build_anthropic_body(
        pool_spec=pool_spec,
        messages=messages,
        tools=tools,
        tool_choice=tool_choice,
        response_format=response_format,
        max_tokens=max_tokens,
        skip_cache_write=skip_cache_write,
    )
    actual_model = f"{pool_spec.claude_auth_model}-claude"
    current_auth = auth
    rotations = 0

    while True:
        try:
            async for chunk in _attempt_with_token(
                body=body,
                auth=current_auth,
                pool_spec=pool_spec,
                actual_model=actual_model,
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                ttft_timeout_s=ttft_timeout_s,
                idle_timeout_s=idle_timeout_s,
            ):
                yield chunk
            return
        except _RotateToken as rotate:
            await _cool_down(current_auth, rotate.reason, request_id, agent_id, call_site)
            rotations += 1
            if rotations > current_auth.max_rotations:
                raise RoseAuthError(
                    f"claudeAuth exhausted after {rotations} rotations ({rotate.reason})",
                    status=rotate.status,
                )
            fresh = await _fetch_fresh_or_none(current_auth)
            if fresh is None:
                raise RoseAuthError(
                    f"claudeAuth: no fresh token available after {rotations} rotations ({rotate.reason})",
                    status=rotate.status,
                )
            current_auth = fresh


class _RotateToken(Exception):
    """Internal signal — the current token should be cooled down and swapped."""

    def __init__(self, reason: str, *, status: Optional[int]) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


async def _attempt_with_token(
    *,
    body: Dict[str, Any],
    auth: ClaudeAuthContext,
    pool_spec: PoolSpec,
    actual_model: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    ttft_timeout_s: float,
    idle_timeout_s: float,
) -> AsyncIterator[StreamChunk]:
    """One full try with a single token — up to 3 in-place retries on 429/5xx."""
    last_error: Optional[Exception] = None
    for attempt in range(_MAX_ATTEMPTS_PER_TOKEN):
        try:
            async with post_anthropic_stream(
                body=body,
                claude_token=auth.token,
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                connect_timeout_s=ttft_timeout_s,
            ) as response:
                status = response.status_code

                if status == 200:
                    async for chunk in parse_anthropic_sse(
                        response,
                        actual_model=actual_model,
                        pool_name="claude-token",
                        request_id=request_id,
                        idle_timeout_s=idle_timeout_s,
                    ):
                        yield chunk
                    return

                error_body = get_error_body(response)

                if status == 429:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(_backoff_for_429(response, attempt))
                        continue
                    raise _RotateToken("rate_limit", status=status)

                if status in (401, 403):
                    raise _RotateToken("auth_error", status=status)

                if status == 400:
                    # Do NOT rotate — request shape is the problem; next
                    # token would hit the same 400 and chain through pool.
                    logger.warning(
                        "rose.claude_auth.invalid_request",
                        request_id=request_id,
                        agent_id=agent_id,
                        call_site=call_site,
                        body=error_body[:500],
                    )
                    raise RoseInvalidRequest(
                        f"Anthropic 400: {error_body[:200]}",
                        status=status,
                    )

                if status >= 500:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(min(2 ** attempt, _BACKOFF_CAP_S))
                        continue
                    raise RoseServerError(
                        f"Anthropic {status}: {error_body[:200]}",
                        status=status,
                    )

                raise RoseError(
                    f"Anthropic {status}: {error_body[:200]}",
                    status=status,
                )
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                await asyncio.sleep(min(2 ** attempt, _BACKOFF_CAP_S))
                continue
            raise RoseServerError(f"Anthropic connect/read error: {exc}") from exc
        except RoseStallError:
            # Stall doesn't rotate — waterfall may fare better on a different
            # provider stack entirely.
            raise
        except _RotateToken:
            raise
        except RoseError:
            raise

    # Unreachable — loop body either yields, raises, or continues.
    if last_error:
        raise RoseServerError(f"Anthropic: exhausted retries: {last_error}") from last_error
    raise RoseServerError("Anthropic: exhausted retries with no error captured")


def _backoff_for_429(response: httpx.Response, attempt: int) -> float:
    """Respect Retry-After when present, else exponential backoff capped at 5s."""
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return max(1.0, min(float(retry_after), _BACKOFF_CAP_S))
        except ValueError:
            pass
    return min(2 ** attempt, _BACKOFF_CAP_S)


async def _cool_down(
    auth: ClaudeAuthContext,
    reason: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
) -> None:
    """Mark the current token as cooled-down via the backend callback."""
    logger.warning(
        "rose.claude_auth.rotate",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        reason=reason,
        source=auth.source,
        pool_token_id=auth.pool_token_id,
    )
    if auth.mark_rate_limited is None:
        logger.warning(
            "rose.claude_auth.no_mark_rate_limited_callback",
            request_id=request_id,
            agent_id=agent_id,
        )
        return
    try:
        await auth.mark_rate_limited(auth, _COOLDOWN_SECONDS)
    except Exception as exc:
        logger.warning(
            "rose.claude_auth.cooldown_failed",
            request_id=request_id,
            agent_id=agent_id,
            error=str(exc),
        )


async def _fetch_fresh_or_none(auth: ClaudeAuthContext) -> Optional[ClaudeAuthContext]:
    """Ask the caller-supplied fetch callback for a replacement token."""
    if auth.fetch_fresh is None:
        return None
    try:
        fresh = await auth.fetch_fresh(auth.user_id)
    except Exception as exc:
        logger.warning("rose.claude_auth.fetch_fresh_failed", error=str(exc))
        return None
    if fresh is None:
        return None
    # Preserve the caller's callbacks + rotation budget across the swap.
    fresh.mark_rate_limited = fresh.mark_rate_limited or auth.mark_rate_limited
    fresh.fetch_fresh = fresh.fetch_fresh or auth.fetch_fresh
    if fresh.max_rotations is None or fresh.max_rotations == 3:
        fresh.max_rotations = auth.max_rotations
    return fresh
