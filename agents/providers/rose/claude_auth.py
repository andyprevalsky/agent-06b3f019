"""Direct Anthropic streaming call + retry + pool-rotation.

The Claude OAuth / "claudeAuth" path. When a user's Claude Max token is
available, we call Anthropic directly — the user's subscription pays for
inference, so Rose sees $0 cost. The pool of shared tokens the backend
maintains (`fetch_claude_max_token_activity` / `mark_claude_token_rate_limited_activity`)
is rotated on auth/rate-limit failures via the callbacks in
`ClaudeAuthContext`.

Contract (P1):

    In-place retry (same token):
        transient 429      -> up to 3 attempts, exp backoff + jitter
        usage-window 429   -> rotate immediately; do not retry known-dead token
        5xx                -> up to 3 attempts, exp backoff (cap 5s)
        connect/tls errors -> up to 3 attempts, exp backoff (cap 5s)

    Pool rotation (fetch fresh token, up to `max_rotations` swaps):
        401 / 403          -> rotate immediately
        429 after retries  -> rotate

    Fall-through (raise typed error, caller goes to waterfall):
        400                -> RoseInvalidRequest  (do NOT rotate; next token
                              would hit the same 400 and chain through pool)
        TTFT miss          -> RoseStallError
        rotation exhausted -> RoseAuthError

The outer Rose client owns the time-to-first-contentful-token timeout; this
module only handles pre-stream HTTP error classification and orchestration.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from helpers.tracing import span, stream_span
from providers.rose.errors import (
    RoseAuthError,
    RoseError,
    RoseInvalidRequest,
    RosePaymentRequiredError,
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
from providers.rose.transport import anthropic_error_fields, get_error_body, post_anthropic_stream
from providers.rose.types import ClaudeAuthContext, StreamChunk
from providers.rose.uncached_context import is_uncached_context
from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

logger = structlog.get_logger()


def _anthropic_400_message(error_body: str) -> str:
    """Name the provider's error code so a fall-through reason is diagnosable."""
    code = anthropic_error_fields(error_body)["error_code"]
    return f"Anthropic 400 ({code})" if code else "Anthropic 400"


def _anthropic_error_message(error_body: str) -> Optional[str]:
    """Anthropic's validation message (names the rejected field), capped at 200 chars."""
    try:
        error = json.loads(error_body).get("error")
    except (ValueError, AttributeError):
        return None
    message = error.get("message") if isinstance(error, dict) else None
    return message[:200] if isinstance(message, str) else None


_MAX_ATTEMPTS_PER_TOKEN = 3
_BACKOFF_CAP_S = 5.0
_DEFAULT_TTFT_TIMEOUT_S = 60.0
_COOLDOWN_SECONDS = 5 * 60
_USAGE_WINDOW_RESET_THRESHOLD_S = 60.0
_MAX_CACHE_CONTROL_BLOCKS = 4


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

    Replaces ``messages[-1]`` with a marked copy (the list is mutated, the
    caller's message dicts are not — they are reused for the waterfall
    fallback). Mirrors Claude Code's addCacheBreakpoints: exactly one
    message-level marker so the server knows where the reusable prefix ends.

    Trailing uncached runtime context (``UncachedContextText``, e.g. the
    environment status tail) is skipped: the marker lands on the last stable
    block before it (TS parity: claudeAuth.ts ``addCacheBreakpoint``).
    """
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        content = message.get("content")
        if isinstance(content, str):
            if is_uncached_context(content):
                continue
            messages[index] = {
                **message,
                "content": [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}],
            }
            return
        if not isinstance(content, list) or not content:
            return
        for block_index in range(len(content) - 1, -1, -1):
            target = content[block_index]
            if not isinstance(target, dict):
                return
            if target.get("type") == "text" and is_uncached_context(target.get("text")):
                continue
            marked = {**target, "cache_control": {"type": "ephemeral"}}
            messages[index] = {**message, "content": [*content[:block_index], marked, *content[block_index + 1 :]]}
            return


def _add_tool_cache_breakpoint(body: Dict[str, Any]) -> None:
    """Add cache_control to the last tool definition so system+tools prefix is cached."""
    tools = body.get("tools")
    if tools and isinstance(tools, list) and len(tools) > 0:
        tools[-1]["cache_control"] = {"type": "ephemeral"}


def _drop_cache_control(obj: Any) -> bool:
    if isinstance(obj, dict) and "cache_control" in obj:
        obj.pop("cache_control", None)
        return True
    return False


def _count_cache_control_blocks(body: Dict[str, Any]) -> int:
    count = 0
    system = body.get("system")
    if isinstance(system, list):
        count += sum(1 for block in system if isinstance(block, dict) and "cache_control" in block)

    tools = body.get("tools")
    if isinstance(tools, list):
        count += sum(1 for tool in tools if isinstance(tool, dict) and "cache_control" in tool)

    messages = body.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if isinstance(content, list):
                count += sum(1 for block in content if isinstance(block, dict) and "cache_control" in block)
            elif isinstance(content, dict) and "cache_control" in content:
                count += 1
    return count


def _enforce_cache_control_cap(body: Dict[str, Any]) -> None:
    """Keep Anthropic's four most useful cumulative cache breakpoints.

    A message breakpoint includes the system and tools that precede it, so it
    is the only marker that can reuse a long conversation. When the execute
    prompt's three system markers plus tools and messages exceed Anthropic's
    four-marker cap, drop the latest redundant system markers first. Dropping
    messages first silently reduced agent calls to system+tool cache hits.
    """

    def over_cap() -> bool:
        return _count_cache_control_blocks(body) > _MAX_CACHE_CONTROL_BLOCKS

    system = body.get("system")
    if isinstance(system, list):
        for block in reversed(system):
            if not over_cap():
                break
            _drop_cache_control(block)

    messages = body.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not over_cap() or not isinstance(msg, dict):
                break
            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    if not over_cap():
                        break
                    _drop_cache_control(block)
            elif isinstance(content, dict) and over_cap():
                _drop_cache_control(content)

    tools = body.get("tools")
    if isinstance(tools, list):
        for tool in reversed(tools):
            if not over_cap():
                break
            _drop_cache_control(tool)


def _build_system_blocks(static_system: Optional[str], dynamic_system: Optional[str]) -> List[Dict[str, Any]]:
    """Build Anthropic system blocks from boundary-split prompt sections.

    A single boundary preserves the legacy contract: static prompt is cached,
    dynamic prompt is uncached. Multiple boundaries mean the prompt builder has
    intentionally marked several stable system blocks, so each non-empty block
    receives a global cache marker.
    """
    blocks: List[Dict[str, Any]] = []
    if static_system:
        blocks.append(
            {
                "type": "text",
                "text": static_system,
                "cache_control": {"type": "ephemeral", "scope": "global"},
            }
        )

    if not dynamic_system:
        return blocks

    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in dynamic_system:
        blocks.append({"type": "text", "text": dynamic_system})
        return blocks

    for part in dynamic_system.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY):
        text = part.strip()
        if not text:
            continue
        blocks.append(
            {
                "type": "text",
                "text": text,
                "cache_control": {"type": "ephemeral", "scope": "global"},
            }
        )
    return blocks


DEFAULT_REASONING_EFFORT = "xhigh"


def _normalize_reasoning_effort(effort: Optional[str]) -> str:
    """Map our internal effort sentinel to Anthropic's accepted values.

    Anthropic accepts low / medium / high / xhigh / max for output_config.effort.
    The literal "max" value is accepted by the API but causes the response stream
    to hang without emitting a first chunk (~160s, then TTFT timeout). xhigh is
    the highest reliably-streaming level — mirror gpt_auth which also routes
    our "max" sentinel to "xhigh" as the de-facto top tier.

    "minimal" is an OpenAI chat sentinel; Anthropic rejects it — map to "low".

    Default is xhigh for every call so request bodies are always well-formed
    (effort present) unless a caller explicitly passes a different level.
    """
    if effort == "minimal":
        return "low"
    if effort == "max":
        return "xhigh"
    return effort or DEFAULT_REASONING_EFFORT


def _supports_anthropic_fast_mode(model: str) -> bool:
    return model in {"claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"}


def _model_supports_output_config_effort(model: str) -> bool:
    """Return whether Anthropic accepts ``output_config.effort`` for ``model``.

    ``claude-haiku-4-5`` (rose-1-mini claudeAuth) 400s with
    "This model does not support the effort parameter." Stamping effort on
    every body (DoorDash xhigh default) therefore fails every mini claudeAuth
    call, forcing summarize_web_fetch onto a paid waterfall that can burn the
    full TTFT budget (90s) per fetch — enough to time out spawn-sub-agents.
    """
    return "haiku" not in model.lower()


def _model_rejects_forced_tool_choice(model: str) -> bool:
    """Fable 5.1 / Mythos 5.1 400 on tool_choice type any/tool.

    Official Claude API IDs are `claude-fable-5-1` / `claude-mythos-5-1`.
    OpenRouter uses a dot (`claude-fable-5.1`); normalize so both match.
    Do not match leftover Fable 5 (`claude-fable-5`) — that model still
    accepts forced tool_choice.

    Opus 5.5 shares the downgrade. A credited probe was blocked (zero
    balance) before tool_choice could be confirmed, and a 400 on type
    any/tool would fail every planner call. Drop the Opus clause once a
    credited call shows it accepts forced tool_choice.
    """
    canonical = model.lower().replace(".", "-")
    return "claude-fable-5-1" in canonical or "claude-mythos-5-1" in canonical or "claude-opus-5-5" in canonical


def _downgrade_forced_tool_choice_if_unsupported(body: Dict[str, Any], model: str) -> None:
    if not _model_rejects_forced_tool_choice(model):
        return
    tc = body.get("tool_choice")
    if not isinstance(tc, dict):
        return
    tc_type = tc.get("type")
    if tc_type not in ("any", "tool"):
        return
    downgraded: Dict[str, Any] = {"type": "auto"}
    if tc_type == "tool":
        # Named required_tool used to mean "call this once". auto alone would
        # re-open parallel same-tool fan-out; keep the single-call contract.
        downgraded["disable_parallel_tool_use"] = True
    body["tool_choice"] = downgraded


def build_anthropic_body(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    max_tokens: Optional[int],
    skip_cache_write: bool = False,
    thinking: Optional[Dict[str, Any]] = None,
    effort: Optional[str] = None,
    provider_fast_mode: bool = True,
    context_tools: Optional[List[Dict[str, Any]]] = None,
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
    if provider_fast_mode and _supports_anthropic_fast_mode(pool_spec.claude_auth_model):
        body["speed"] = "fast"

    system_blocks = _build_system_blocks(static_system, dynamic_system)
    body["system"] = [_IDENTITY_BLOCK, _DISCLAIMER_BLOCK, *system_blocks]

    if not skip_cache_write and anthropic_messages:
        _add_cache_breakpoint(anthropic_messages)

    # Anti-pattern: never default to adaptive thinking. It (a) 400s on
    # claude-haiku-4-5 ("adaptive thinking is not supported on this model"),
    # (b) hangs Anthropic streams on Opus when "max" effort is set, and (c) is
    # incompatible with forced tool_choice on every Pydantic-schema caller —
    # the cleanup at the bottom of this function used to pop it back off
    # specifically because of that. Just don't set it. If a caller ever has a
    # real reason to enable thinking, they can pass it explicitly.
    if thinking is not None:
        body["thinking"] = thinking
    body["temperature"] = 1

    # Resolve native tools: prefer explicit tools; fall back to extracting
    # from response_format (the Pydantic-schema → anyOf → native-tools path).
    # Extraction happens once here so the body is self-contained and
    # deterministic across retries/rotations.
    native_tools = tools
    came_from_response_format = False
    if native_tools is None and response_format is not None:
        extracted = _extract_tools_from_response_format(response_format)
        if extracted is not None:
            native_tools = extracted["tools"]
            came_from_response_format = True

    # When tools were synthesized from response_format, the caller didn't pass
    # an explicit tool_choice — but structured output REQUIRES the tool to be
    # called or the streaming JSON parser blows up on assistant prose.
    # apply_anthropic_tool_config defaults to "auto" on this path, so override.
    effective_tool_choice = tool_choice
    if came_from_response_format and tool_choice is None:
        effective_tool_choice = "any"

    # Mutates `body` in place to attach native tool config; the returned mode
    # is unused on the claudeAuth path.
    apply_anthropic_tool_config(
        body,
        response_format,
        True,  # always native tools on claudeAuth
        native_tools,
        effective_tool_choice,
    )
    _downgrade_forced_tool_choice_if_unsupported(body, pool_spec.claude_auth_model)

    # Context-only definitions describe historical tool_use/tool_result blocks;
    # Anthropic accepts those blocks without re-declaring the historical tool.
    # A tool present in body.tools is callable, so never append context-only
    # entries (especially under auto/any selection).
    del context_tools

    _add_tool_cache_breakpoint(body)
    _enforce_cache_control_cap(body)

    # Stamp output_config.effort when the model accepts it (default xhigh;
    # planner_llm still passes "max" → xhigh). Haiku rejects effort — omit
    # rather than 400 every rose-1-mini claudeAuth call (see helper docstring).
    if _model_supports_output_config_effort(pool_spec.claude_auth_model):
        oc = body.get("output_config") or {}
        oc["effort"] = _normalize_reasoning_effort(effort)
        body["output_config"] = oc
    else:
        oc = body.get("output_config")
        if isinstance(oc, dict) and "effort" in oc:
            oc = {k: v for k, v in oc.items() if k != "effort"}
            if oc:
                body["output_config"] = oc
            else:
                body.pop("output_config", None)

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
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    response_format: Optional[Dict[str, Any]] = None,
    max_tokens: Optional[int] = None,
    skip_cache_write: bool = False,
    thinking: Optional[Dict[str, Any]] = None,
    effort: Optional[str] = None,
    auth: ClaudeAuthContext,
    request_id: str,
    provider_fast_mode: bool = True,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = None,
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
        context_tools=context_tools,
        tool_choice=tool_choice,
        response_format=response_format,
        max_tokens=max_tokens,
        skip_cache_write=skip_cache_write,
        thinking=thinking,
        effort=effort,
        provider_fast_mode=provider_fast_mode,
    )
    actual_model = f"{pool_spec.claude_auth_model}-claude"
    current_auth = auth
    rotations = 0

    while True:
        try:
            # One span per token attempt — makes the waterfall show which token
            # (and how many rotations in) produced this call's latency, instead
            # of lumping every attempt into the opaque parent call_llm span.
            async with stream_span(
                "llm.attempt",
                provider="claudeAuth",
                actual_model=actual_model,
                rotation=rotations,
                call_site=call_site,
                request_id=request_id,
                agent_id=agent_id,
            ):
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
            setattr(auth, "rotated", True)
            setattr(auth, "last_rotation_reason", rotate.reason)
            setattr(auth, "last_rate_limited_until", rotate.rate_limited_until)
            # Cooldown is a silent asyncio.sleep today; span it so the time a
            # rotation costs is attributable instead of invisible.
            async with span(
                "llm.cooldown",
                reason=rotate.reason,
                rate_limited_until=rotate.rate_limited_until,
                rotation=rotations,
                call_site=call_site,
                request_id=request_id,
                agent_id=agent_id,
            ):
                await _cool_down(
                    current_auth,
                    rotate.reason,
                    request_id,
                    agent_id,
                    call_site,
                    rate_limited_until=rotate.rate_limited_until,
                )
            rotations += 1
            if rotations > current_auth.max_rotations:
                error_cls = RoseRateLimitError if rotate.reason == "rate_limit" else RoseAuthError
                raise error_cls(
                    f"claudeAuth exhausted after {rotations} rotations ({rotate.reason})",
                    status=rotate.status,
                )
            fresh = await _fetch_fresh_or_none(current_auth)
            if fresh is None:
                error_cls = RoseRateLimitError if rotate.reason == "rate_limit" else RoseAuthError
                raise error_cls(
                    f"claudeAuth: no fresh token available after {rotations} rotations ({rotate.reason})",
                    status=rotate.status,
                )
            current_auth = fresh


async def anthropic_api_key_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    api_key: str,
    tools: Optional[List[Dict[str, Any]]] = None,
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    response_format: Optional[Dict[str, Any]] = None,
    max_tokens: Optional[int] = None,
    skip_cache_write: bool = False,
    thinking: Optional[Dict[str, Any]] = None,
    effort: Optional[str] = None,
    request_id: str,
    provider_fast_mode: bool = True,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = None,
) -> AsyncIterator[StreamChunk]:
    """Funded ANTHROPIC_API_KEY fallback (billed, `x-api-key`). Mirrors
    `claude_auth_complete` but without pool rotation — it's a single global
    credential — and classifies HTTP 402 as `RosePaymentRequiredError` so the
    client backs the key off. `actual_model` carries the `-anthropic` suffix so
    downstream cost accounting bills it (unlike the `-claude` $0 OAuth path)."""
    body = build_anthropic_body(
        pool_spec=pool_spec,
        messages=messages,
        tools=tools,
        context_tools=context_tools,
        tool_choice=tool_choice,
        response_format=response_format,
        max_tokens=max_tokens,
        skip_cache_write=skip_cache_write,
        thinking=thinking,
        effort=effort,
        provider_fast_mode=provider_fast_mode,
    )
    actual_model = f"{pool_spec.claude_auth_model}-anthropic"

    for attempt in range(_MAX_ATTEMPTS_PER_TOKEN):
        try:
            async with post_anthropic_stream(
                body=body,
                api_key=api_key,
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                connect_timeout_s=ttft_timeout_s,
            ) as response:
                status = response.status_code
                if status == 200:
                    async with stream_span(
                        "llm.provider_read",
                        actual_model=actual_model,
                        attempt=attempt,
                        request_id=request_id,
                        agent_id=agent_id,
                    ):
                        async for chunk in parse_anthropic_sse(
                            response,
                            actual_model=actual_model,
                            pool_name="anthropic-apikey",
                            request_id=request_id,
                            idle_timeout_s=idle_timeout_s,
                        ):
                            yield chunk
                    return

                error_body = get_error_body(response)
                if status == 402:
                    raise RosePaymentRequiredError("Anthropic 402 (out of credits)", status=status)
                if status in (401, 403):
                    raise RoseAuthError(f"Anthropic {status}", status=status)
                if status == 429:
                    raise RoseRateLimitError("Anthropic 429", status=status)
                if status == 400 and re.search(
                    r"credit balance is too low|out of credits|purchase credits",
                    error_body,
                    re.IGNORECASE,
                ):
                    raise RosePaymentRequiredError("Anthropic 400 (out of credits)", status=status)
                if status == 400:
                    raise RoseInvalidRequest(_anthropic_400_message(error_body), status=status)
                if status >= 500:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                        continue
                    raise RoseServerError(f"Anthropic {status}", status=status)
                raise RoseError(f"Anthropic {status}", status=status)
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                continue
            raise RoseServerError(f"Anthropic connect/read error: {exc}") from exc

    raise RoseServerError("Anthropic API key: exhausted retries with no error captured")


class _RotateToken(Exception):
    """Internal signal — the current token should be cooled down and swapped."""

    def __init__(
        self,
        reason: str,
        *,
        status: Optional[int],
        rate_limited_until: Optional[str] = None,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status
        self.rate_limited_until = rate_limited_until


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
    idle_timeout_s: Optional[float],
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
                    try:
                        # Spans the SSE generation phase only — separating "the
                        # model streamed slowly" from connect/TTFT (= llm.attempt
                        # minus llm.provider_read) and from broadcast stalls.
                        async with stream_span(
                            "llm.provider_read",
                            actual_model=actual_model,
                            attempt=attempt,
                            request_id=request_id,
                            agent_id=agent_id,
                        ):
                            async for chunk in parse_anthropic_sse(
                                response,
                                actual_model=actual_model,
                                pool_name="claude-token",
                                request_id=request_id,
                                idle_timeout_s=idle_timeout_s,
                            ):
                                yield chunk
                        return
                    except RoseRateLimitError as exc:
                        # HTTP 200 + in-band rate_limit_error from SSE.
                        # Mirror the HTTP 429 path: transient → backoff
                        # retry on same token; persistent (usage-window
                        # signal or far-future reset) → rotate.
                        msg = str(exc)
                        rate_limited_until = _extract_rate_limited_until(response, msg)
                        if _should_rotate_429_without_retry(msg, rate_limited_until):
                            raise _RotateToken(
                                "rate_limit",
                                status=429,
                                rate_limited_until=rate_limited_until,
                            )
                        if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                            async with span(
                                "llm.backoff",
                                reason="rate_limit_inband",
                                attempt=attempt,
                                request_id=request_id,
                                agent_id=agent_id,
                            ):
                                await asyncio.sleep(_backoff_for_429(response, attempt))
                            continue
                        raise _RotateToken(
                            "rate_limit",
                            status=429,
                            rate_limited_until=rate_limited_until,
                        )
                    except RoseAuthError as exc:
                        # HTTP 200 + in-band authentication_error/permission_error.
                        # Mirror the HTTP 401/403 path: rotate immediately.
                        msg = str(exc)
                        rate_limited_until = _extract_rate_limited_until(response, msg)
                        reason = "rate_limit" if rate_limited_until or _looks_like_rate_limit(msg) else "auth_error"
                        raise _RotateToken(
                            reason,
                            status=401,
                            rate_limited_until=rate_limited_until,
                        )

                error_body = get_error_body(response)

                if status == 429:
                    rate_limited_until = _extract_rate_limited_until(response, error_body)
                    if _should_rotate_429_without_retry(error_body, rate_limited_until):
                        raise _RotateToken(
                            "rate_limit",
                            status=status,
                            rate_limited_until=rate_limited_until,
                        )
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        async with span(
                            "llm.backoff",
                            reason="rate_limit_http",
                            attempt=attempt,
                            request_id=request_id,
                            agent_id=agent_id,
                        ):
                            await asyncio.sleep(_backoff_for_429(response, attempt))
                        continue
                    raise _RotateToken(
                        "rate_limit",
                        status=status,
                        rate_limited_until=rate_limited_until,
                    )

                if status in (401, 403):
                    rate_limited_until = _extract_rate_limited_until(response, error_body)
                    reason = "rate_limit" if rate_limited_until or _looks_like_rate_limit(error_body) else "auth_error"
                    raise _RotateToken(
                        reason,
                        status=status,
                        rate_limited_until=rate_limited_until,
                    )

                if status == 400:
                    # Do NOT rotate — request shape is the problem; next
                    # token would hit the same 400 and chain through pool.
                    logger.warning(
                        "rose.claude_auth.invalid_request",
                        request_id=request_id,
                        agent_id=agent_id,
                        call_site=call_site,
                        body_len=len(error_body),
                        provider_message=_anthropic_error_message(error_body),
                    )
                    raise RoseInvalidRequest(
                        _anthropic_400_message(error_body),
                        status=status,
                    )

                if status >= 500:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                        continue
                    raise RoseServerError(
                        f"Anthropic {status}",
                        status=status,
                    )

                raise RoseError(
                    f"Anthropic {status}",
                    status=status,
                )
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
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
    delay: float
    if retry_after:
        try:
            delay = max(1.0, min(float(retry_after), _BACKOFF_CAP_S))
        except ValueError:
            delay = min(2**attempt, _BACKOFF_CAP_S)
    else:
        delay = min(2**attempt, _BACKOFF_CAP_S)
    jitter = random.uniform(0, min(delay * 0.25, 1.0))
    return min(delay + jitter, _BACKOFF_CAP_S)


_RESET_HEADER_NAMES = (
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
    "anthropic-ratelimit-requests-reset",
    "x-ratelimit-reset",
    "x-rate-limit-reset",
    "ratelimit-reset",
)
_ISO_TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
_EPOCH_RESET_RE = re.compile(
    r"(?:reset|until|retry(?:_|\s|-)?after|available(?:_|\s|-)?at)[^\d]{0,32}(\d{10,13})",
    re.IGNORECASE,
)
_DURATION_RE = re.compile(
    r"(?:try again|retry|reset|available)[^.\n]{0,80}?\bin\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)\b",
    re.IGNORECASE,
)


def _extract_rate_limited_until(response: httpx.Response, error_body: str) -> Optional[str]:
    """Return the backend cooldown timestamp Anthropic gives us, when present."""
    for header_name in _RESET_HEADER_NAMES:
        parsed = _parse_reset_value(response.headers.get(header_name))
        if parsed:
            return parsed

    parsed = _parse_body_reset_time(error_body)
    if parsed:
        return parsed

    return _parse_retry_after(response.headers.get("retry-after"))


def _parse_body_reset_time(error_body: str) -> Optional[str]:
    for match in _ISO_TS_RE.finditer(error_body or ""):
        parsed = _parse_reset_value(match.group(0))
        if parsed:
            return parsed

    for match in _EPOCH_RESET_RE.finditer(error_body or ""):
        parsed = _parse_epoch_value(match.group(1))
        if parsed:
            return parsed

    duration_match = _DURATION_RE.search(error_body or "")
    if duration_match:
        amount = int(duration_match.group(1))
        unit = duration_match.group(2).lower()
        seconds = amount
        if unit.startswith("minute"):
            seconds = amount * 60
        elif unit.startswith("hour"):
            seconds = amount * 60 * 60
        return _format_utc(datetime.now(timezone.utc) + timedelta(seconds=seconds))

    return None


def _parse_retry_after(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    stripped = value.strip()
    try:
        seconds = max(0.0, float(stripped))
        return _format_utc(datetime.now(timezone.utc) + timedelta(seconds=seconds))
    except ValueError:
        pass
    return _parse_http_date(stripped)


def _parse_reset_value(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    stripped = value.strip().strip('"')

    parsed_epoch = _parse_epoch_value(stripped)
    if parsed_epoch:
        return parsed_epoch

    try:
        dt = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return _format_utc(dt)
    except ValueError:
        pass

    return _parse_http_date(stripped)


def _parse_epoch_value(value: str) -> Optional[str]:
    try:
        epoch = int(value)
    except (TypeError, ValueError):
        return None
    if epoch > 10_000_000_000:
        epoch = int(epoch / 1000)
    if epoch < 1_000_000_000:
        return None
    return _format_utc(datetime.fromtimestamp(epoch, tz=timezone.utc))


def _parse_http_date(value: str) -> Optional[str]:
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return _format_utc(dt)


def _format_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _should_rotate_429_without_retry(
    error_body: str,
    rate_limited_until: Optional[str],
) -> bool:
    return _looks_like_usage_window_limit(error_body) or _reset_is_far_future(rate_limited_until)


def _reset_is_far_future(rate_limited_until: Optional[str]) -> bool:
    if not rate_limited_until:
        return False
    try:
        reset_at = datetime.fromisoformat(rate_limited_until.replace("Z", "+00:00"))
    except ValueError:
        return False
    if reset_at.tzinfo is None:
        reset_at = reset_at.replace(tzinfo=timezone.utc)
    seconds_until_reset = (reset_at.astimezone(timezone.utc) - datetime.now(timezone.utc)).total_seconds()
    return seconds_until_reset > _USAGE_WINDOW_RESET_THRESHOLD_S


def _looks_like_usage_window_limit(error_body: str) -> bool:
    body = (error_body or "").lower()
    return any(
        phrase in body
        for phrase in (
            "usage limit",
            "usage_limit",
            "weekly limit",
            "monthly limit",
            "plan limit",
            "subscription limit",
            "quota exceeded",
            "limit resets",
            "resets at",
        )
    )


def _looks_like_rate_limit(error_body: str) -> bool:
    body = (error_body or "").lower()
    return any(
        phrase in body
        for phrase in (
            "usage limit",
            "rate limit",
            "rate_limit",
            "quota",
            "too many requests",
        )
    )


async def _cool_down(
    auth: ClaudeAuthContext,
    reason: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    rate_limited_until: Optional[str] = None,
) -> None:
    """Mark the current token as cooled-down via the backend callback."""
    logger.warning(
        "rose.claude_auth.rotate",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        reason=reason,
        rate_limited_until=rate_limited_until,
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
        await auth.mark_rate_limited(
            auth,
            _COOLDOWN_SECONDS,
            rate_limited_until,
            reason,
        )
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
    if fresh.max_rotations is None or fresh.max_rotations == 2:
        fresh.max_rotations = auth.max_rotations
    return fresh
