"""Direct Cerebras hop for rose-fast pools.

Posts the pool's `cerebras_model` to api.cerebras.ai. This is not an
OpenRouter provider pin — OpenRouter does not route Qwen 3.8 27B to Cerebras.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from providers.rose.errors import RoseError
from providers.rose.pools import PoolSpec
from providers.rose.streaming import parse_openai_sse
from providers.rose.transforms import transform_messages_for_openai
from providers.rose.transport import post_cerebras_stream
from providers.rose.types import StreamChunk
from providers.rose.waterfall import _openrouter_tool_choice, _openrouter_tools

logger = structlog.get_logger()

CEREBRAS_DIRECT_POOL = "cerebras-direct"


def _strip_cerebras_cache_control(value: Any) -> Any:
    """Cerebras rejects Anthropic/OpenRouter ``cache_control`` markers.

    Live qwen-3.8-27b (2026-09-28) 400s
    ``messages.0.system.content.list[...].text.cache_control`` as unsupported
    and then falls through to OpenRouter. Keep text/image parts; drop the key.
    """
    if isinstance(value, dict):
        return {
            key: _strip_cerebras_cache_control(nested)
            for key, nested in value.items()
            if key != "cache_control"
        }
    if isinstance(value, list):
        return [_strip_cerebras_cache_control(item) for item in value]
    return value


def build_cerebras_body(
    *,
    model: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    temperature: Optional[float],
    max_tokens: Optional[int],
    effort: Optional[str],
) -> Dict[str, Any]:
    openrouter_tools = _openrouter_tools(tools)
    body: Dict[str, Any] = {
        "model": model,
        "messages": _strip_cerebras_cache_control(
            transform_messages_for_openai(
                messages,
                tools_declared=bool(openrouter_tools),
                inject_cache_breakpoints=False,
            )
        ),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if effort:
        body["reasoning_effort"] = effort
    if openrouter_tools:
        body["tools"] = openrouter_tools
    if tool_choice is not None and openrouter_tools:
        body["tool_choice"] = _openrouter_tool_choice(tool_choice, model)
    if response_format is not None:
        body["response_format"] = response_format
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_completion_tokens"] = max_tokens
    return body


async def cerebras_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    response_format: Optional[Dict[str, Any]] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    cerebras_key: str,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    per_step_timeout_s: float = 60.0,
    idle_timeout_s: Optional[float] = None,
) -> AsyncIterator[StreamChunk]:
    model = pool_spec.cerebras_model
    if not model:
        raise RoseError(f"pool {pool_spec.name} has no cerebras_model")
    body = build_cerebras_body(
        model=model,
        messages=messages,
        tools=tools,
        tool_choice=tool_choice,
        response_format=response_format,
        temperature=temperature,
        max_tokens=max_tokens,
        effort=pool_spec.cerebras_reasoning_effort,
    )
    logger.info(
        "rose.cerebras.start",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        pool=pool_spec.name,
        model=model,
    )
    try:
        async with post_cerebras_stream(
            body=body,
            cerebras_key=cerebras_key,
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            connect_timeout_s=per_step_timeout_s,
        ) as response:
            status = response.status_code
            if status >= 400:
                raise RoseError(
                    f"Cerebras {model} returned {status}",
                    status=status,
                )
            async for chunk in parse_openai_sse(
                response,
                actual_model=model,
                pool_name=CEREBRAS_DIRECT_POOL,
                request_id=request_id,
                idle_timeout_s=idle_timeout_s,
            ):
                yield chunk
    except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
        raise RoseError(f"Cerebras {model} connect/read error: {exc}") from exc
