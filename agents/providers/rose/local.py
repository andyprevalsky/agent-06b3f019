"""Loopback-only OpenAI chat transport for Rose Local (llama-server)."""

from __future__ import annotations

import os
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from providers.rose.errors import RoseError
from providers.rose.streaming import parse_openai_sse
from providers.rose.transforms import transform_messages_for_openai
from providers.rose.types import StreamChunk
from providers.rose.waterfall import _openrouter_tool_choice, _openrouter_tools


def local_config() -> tuple[str, str]:
    base = os.environ.get("ROSE_LOCAL_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/")
    model = os.environ.get("ROSE_LOCAL_MODEL", "").strip()
    parsed = urlparse(base)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise RoseError("Rose Local requires an HTTP loopback endpoint")
    if not model:
        raise RoseError("Rose Local requires ROSE_LOCAL_MODEL")
    return base, model


async def local_complete(
    *,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    temperature: Optional[float],
    max_tokens: Optional[int],
    seed: Optional[int],
    request_id: str,
) -> AsyncIterator[StreamChunk]:
    base, model = local_config()
    native_tools = _openrouter_tools(tools)
    body: Dict[str, Any] = {
        "model": model,
        "messages": transform_messages_for_openai(
            messages, tools_declared=bool(native_tools), inject_cache_breakpoints=False
        ),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if native_tools:
        body["tools"] = native_tools
        if tool_choice is not None:
            body["tool_choice"] = _openrouter_tool_choice(tool_choice)
    if response_format is not None and not native_tools:
        body["response_format"] = response_format
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if seed is not None:
        body["seed"] = seed

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0), trust_env=False) as client:
            async with client.stream("POST", f"{base}/chat/completions", json=body) as response:
                if response.status_code >= 400:
                    raise RoseError(f"Rose Local returned HTTP {response.status_code}", status=response.status_code)
                async for chunk in parse_openai_sse(
                    response, actual_model=f"local/{model}", pool_name="rose-local", request_id=request_id
                ):
                    yield chunk
    except httpx.HTTPError as exc:
        raise RoseError(f"Rose Local endpoint unavailable: {exc}") from exc
