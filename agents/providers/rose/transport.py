"""HTTP transport for direct provider calls — Anthropic + Codex + OpenRouter.

Thin wrapper around `httpx.AsyncClient` that:
  - Builds provider-specific headers (Anthropic OAuth + beta flags vs.
    OpenRouter Bearer + referer)
  - Returns a streaming response context manager the caller iterates with
    the parsers in streaming.py
  - Caps connect/header time so a hung TLS handshake fails fast (the
    idle/stall timeout while streaming is enforced by streaming.py)

No retry, no rotation, no waterfall — those live in `claude_auth.py` and
`waterfall.py`. This module is the lowest layer.
"""

from __future__ import annotations

import contextlib
from typing import Any, AsyncIterator, Dict, Optional

import httpx
import structlog

from helpers.http_client import get_streaming_http_client
from providers.rose.streaming import _note_stream_attempt

logger = structlog.get_logger()


ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions"
CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses"

# Mirrors research/.../service/claude-token.ts:320-322. The combination of
# `claude-code-20250219` + `oauth-2025-04-20` is what unlocks the Claude Max
# OAuth token path; the others are feature betas the agent stack relies on.
ANTHROPIC_BETA_HEADER = (
    "claude-code-20250219,"
    "oauth-2025-04-20,"
    "interleaved-thinking-2025-05-14,"
    "prompt-caching-scope-2026-01-05,"
    "advanced-tool-use-2025-11-20,"
    "effort-2025-11-24"
)
ANTHROPIC_API_KEY_BETA_HEADER = ",".join(
    beta for beta in ANTHROPIC_BETA_HEADER.split(",") if beta != "oauth-2025-04-20"
)
ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_X_APP = "cli"
ANTHROPIC_USER_AGENT = "claude-cli/2.1.251 (external, sdk-ts, agent-sdk/0.2.75)"

# Caller specifies the per-attempt connect/header deadline. 60s matches
# WATERFALL_TIMEOUT_MS in research config; claude_auth.py uses the same
# value for its TTFT window before falling through.
DEFAULT_CONNECT_TIMEOUT_S = 60.0


def _anthropic_headers(claude_token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {claude_token}",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA_HEADER,
        "x-app": ANTHROPIC_X_APP,
        "User-Agent": ANTHROPIC_USER_AGENT,
        "Content-Type": "application/json",
    }


def _anthropic_api_key_headers(api_key: str) -> Dict[str, str]:
    """Headers for the funded ANTHROPIC_API_KEY default — standard `x-api-key`
    auth (billed), as opposed to the Claude Max OAuth `Authorization: Bearer`
    path. No `oauth-2025-04-20` beta, which is OAuth-only."""
    return {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_API_KEY_BETA_HEADER,
        "Content-Type": "application/json",
    }


def _with_fast_mode_beta(headers: Dict[str, str], body: Dict[str, Any]) -> Dict[str, str]:
    if body.get("speed") != "fast":
        return headers
    betas = [item.strip() for item in headers.get("anthropic-beta", "").split(",") if item.strip()]
    if ANTHROPIC_FAST_MODE_BETA not in betas:
        betas.append(ANTHROPIC_FAST_MODE_BETA)
    return {**headers, "anthropic-beta": ",".join(betas)}


def _openrouter_headers(openrouter_key: str, referer: str = "https://roselabs.ai") -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {openrouter_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Rose Agents",
    }


def _cerebras_headers(cerebras_key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {cerebras_key}",
        "Content-Type": "application/json",
    }


def _openai_headers(openai_key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {openai_key}",
        "Content-Type": "application/json",
    }


def _codex_headers(gpt_token: str, account_id: Optional[str] = None) -> Dict[str, str]:
    headers = {
        "Authorization": f"Bearer {gpt_token}",
        "Content-Type": "application/json",
        "User-Agent": "codex_cli_rs/0.0.0 (Rose Agents)",
        "originator": "codex_cli_rs",
    }
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
    return headers


def _codex_extra_headers_from_body(
    body: Dict[str, Any],
    *,
    thread_id: Optional[str] = None,
) -> Dict[str, str]:
    del thread_id  # Provider affinity follows the cache session, never the root agent.
    cache_scope = body.get("prompt_cache_key")
    if isinstance(cache_scope, str) and cache_scope.strip():
        scope = cache_scope.strip()
        # These three headers jointly select the provider's cache-affinity lane.
        # A root agent can own several independent conversations at once
        # (execute loop, browser child, parallel explores), so using agent_id for
        # either thread header aliases those lanes and lets one evict another.
        return {
            "session-id": scope,
            "thread-id": scope,
            "x-client-request-id": scope,
        }
    return {}


@contextlib.asynccontextmanager
async def post_anthropic_stream(
    *,
    body: Dict[str, Any],
    claude_token: Optional[str] = None,
    api_key: Optional[str] = None,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
) -> AsyncIterator[httpx.Response]:
    """Open a streaming POST to Anthropic Messages API.

    Pass exactly one of `claude_token` (Claude Max OAuth, `Authorization: Bearer`)
    or `api_key` (the funded ANTHROPIC_API_KEY default, `x-api-key`, billed).

    Yields an `httpx.Response` whose body the caller iterates via
    `streaming.parse_anthropic_sse`. The response is closed automatically
    on context exit (success, error, or cancel).

    The body MUST include `"stream": true`. Caller is responsible for the
    request shape (system blocks, messages, tools, thinking, etc.).
    """
    if (claude_token is None) == (api_key is None):
        raise ValueError("post_anthropic_stream requires exactly one of claude_token / api_key")
    headers = _anthropic_api_key_headers(api_key) if api_key is not None else _anthropic_headers(claude_token)
    headers = _with_fast_mode_beta(headers, body)
    _note_stream_attempt()
    timeout = httpx.Timeout(connect=connect_timeout_s, read=None, write=connect_timeout_s, pool=connect_timeout_s)
    logger.info(
        "rose.transport.anthropic.start",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        model=body.get("model"),
    )
    async with get_streaming_http_client().stream(
        "POST", ANTHROPIC_API_URL, headers=headers, json=body, timeout=timeout
    ) as response:
        if response.status_code >= 400:
            # Read body for error context. It's small for error responses;
            # caller turns this into a typed RoseError.
            error_body = (await response.aread()).decode("utf-8", errors="replace")
            logger.warning(
                "rose.transport.anthropic.error",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                status=response.status_code,
                # Validation failures echo request fragments, which can
                # expose user content / internal schema. Log only the
                # body length; the full body is still attached below for
                # the caller's error classifier.
                error_body_len=len(error_body),
            )
            # Attach body to response for the caller's error classifier.
            setattr(response, "_rose_error_body", error_body)
        yield response


@contextlib.asynccontextmanager
async def post_openai_responses_stream(
    *,
    body: Dict[str, Any],
    openai_key: str,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
) -> AsyncIterator[httpx.Response]:
    """Open a streaming POST to OpenAI Responses with a project API key."""
    _note_stream_attempt()
    timeout = httpx.Timeout(connect=connect_timeout_s, read=None, write=connect_timeout_s, pool=connect_timeout_s)
    logger.info(
        "rose.transport.openai.start",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        model=body.get("model"),
    )
    async with get_streaming_http_client().stream(
        "POST",
        OPENAI_RESPONSES_API_URL,
        headers=_openai_headers(openai_key),
        json=body,
        timeout=timeout,
    ) as response:
        if response.status_code >= 400:
            error_body = (await response.aread()).decode("utf-8", errors="replace")
            logger.warning(
                "rose.transport.openai.error",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                status=response.status_code,
                error_body_len=len(error_body),
            )
            setattr(response, "_rose_error_body", error_body)
        yield response


@contextlib.asynccontextmanager
async def post_openrouter_stream(
    *,
    body: Dict[str, Any],
    openrouter_key: str,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
) -> AsyncIterator[httpx.Response]:
    """Open a streaming POST to OpenRouter (OpenAI-compatible chat completions).

    Same contract as `post_anthropic_stream` but with OpenRouter headers and
    the OpenAI-style URL. The body's `model` field is provider-prefixed
    (e.g. `google/gemini-3-flash-preview`).
    """
    headers = _openrouter_headers(openrouter_key)
    _note_stream_attempt()
    timeout = httpx.Timeout(connect=connect_timeout_s, read=None, write=connect_timeout_s, pool=connect_timeout_s)
    logger.info(
        "rose.transport.openrouter.start",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        model=body.get("model"),
    )
    async with get_streaming_http_client().stream(
        "POST", OPENROUTER_API_URL, headers=headers, json=body, timeout=timeout
    ) as response:
        if response.status_code >= 400:
            error_body = (await response.aread()).decode("utf-8", errors="replace")
            logger.warning(
                "rose.transport.openrouter.error",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                status=response.status_code,
                # See post_anthropic_stream for rationale — log length
                # only; raw body stays on the response for the classifier.
                error_body_len=len(error_body),
            )
            setattr(response, "_rose_error_body", error_body)
        yield response


@contextlib.asynccontextmanager
async def post_cerebras_stream(
    *,
    body: Dict[str, Any],
    cerebras_key: str,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
) -> AsyncIterator[httpx.Response]:
    """Open a streaming POST to Cerebras chat completions (not OpenRouter)."""
    _note_stream_attempt()
    timeout = httpx.Timeout(connect=connect_timeout_s, read=None, write=connect_timeout_s, pool=connect_timeout_s)
    logger.info(
        "rose.transport.cerebras.start",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        model=body.get("model"),
    )
    async with get_streaming_http_client().stream(
        "POST",
        CEREBRAS_API_URL,
        headers=_cerebras_headers(cerebras_key),
        json=body,
        timeout=timeout,
    ) as response:
        if response.status_code >= 400:
            error_body = (await response.aread()).decode("utf-8", errors="replace")
            logger.warning(
                "rose.transport.cerebras.error",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                status=response.status_code,
                error_body_len=len(error_body),
            )
            setattr(response, "_rose_error_body", error_body)
        yield response


@contextlib.asynccontextmanager
async def post_codex_stream(
    *,
    body: Dict[str, Any],
    gpt_token: str,
    account_id: Optional[str] = None,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
) -> AsyncIterator[httpx.Response]:
    """Open a streaming POST to Codex's ChatGPT-account Responses backend."""
    headers = {
        **_codex_headers(gpt_token, account_id),
        **_codex_extra_headers_from_body(body, thread_id=agent_id),
    }
    _note_stream_attempt()
    timeout = httpx.Timeout(connect=connect_timeout_s, read=None, write=connect_timeout_s, pool=connect_timeout_s)
    logger.info(
        "rose.transport.codex.start",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        model=body.get("model"),
    )
    async with get_streaming_http_client().stream(
        "POST", CODEX_API_URL, headers=headers, json=body, timeout=timeout
    ) as response:
        if response.status_code >= 400:
            error_body = (await response.aread()).decode("utf-8", errors="replace")
            logger.warning(
                "rose.transport.codex.error",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                status=response.status_code,
                error_body_len=len(error_body),
            )
            setattr(response, "_rose_error_body", error_body)
        yield response


def get_error_body(response: httpx.Response) -> str:
    """Return the error body captured by `post_*_stream` for an error response."""
    return getattr(response, "_rose_error_body", "")
