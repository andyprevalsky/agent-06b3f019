"""Sequential model fallback — the "waterfall" path.

Tries each model in the pool in order. Streams the first one that returns a
2xx with non-empty content. Each step is bounded by a 60s timeout (the same
`WATERFALL_TIMEOUT_MS` used today in research). On exhaustion, raises
`RoseAllFailed` carrying the per-step error list so the caller can log a
coherent end-to-end picture.

No retries at this layer — each step is a single attempt. The provider-level
retry / backoff / rotation logic belongs in `claude_auth.py`; the waterfall
is intentionally shallow because it exists as a fallback for claudeAuth
failures, not as its own retry ladder.

This module is the OpenRouter counterpart to `claude_auth.py`. Every model
in both `rose-1-lite` and `rose-1-ultra` waterfalls routes through
OpenRouter today, so a single transport path is sufficient.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from providers.rose.errors import (
    RoseAllFailed,
    RoseError,
    RoseInvalidRequest,
    RoseStallError,
    RoseStepError,
)
from providers.rose.pools import PoolSpec
from providers.rose.streaming import parse_openai_sse
from providers.rose.transforms import is_anthropic_model, transform_messages_for_openai
from providers.rose.transport import get_error_body, post_openrouter_stream
from providers.rose.types import StreamChunk

logger = structlog.get_logger()

_PER_STEP_TIMEOUT_S = 60.0


def _openrouter_tools(tools: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None
    out: List[Dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        parameters = function.get("parameters") or function.get("input_schema") or {}
        if not isinstance(parameters, dict):
            parameters = {}
        function_body: Dict[str, Any] = {
            "name": name,
            "description": function.get("description") or "",
            "parameters": parameters,
        }
        if "strict" in function:
            function_body["strict"] = bool(function.get("strict"))
        out.append({"type": "function", "function": function_body})
    return out or None


def _rejects_named_tool_choice(model: str) -> bool:
    """Google AI Studio 400s on the OpenAI named-function `tool_choice` form.

    Observed as `INVALID_ARGUMENT` on `google/gemini-*` routes. Because the
    named form is only sent for forced-tool calls, this turned every waterfall
    step that reached a Google model into a hard failure — and when Google was
    the last reachable model (Anthropic excluded, OpenAI out of credits) the
    whole call died with RoseAllFailed even though the agent's work had already
    succeeded.
    """
    return model.lower().startswith("google/")


def _openrouter_tool_choice(tool_choice: Any, model: str = "") -> Any:
    if tool_choice == "any":
        return "required"
    if isinstance(tool_choice, dict) and isinstance(tool_choice.get("name"), str):
        # Degrade to "required" only where the named form is rejected outright.
        # This does not loosen the contract: the caller re-checks that exactly
        # one tool came back and that it is the required one
        # (`helpers/llm.py` raises LLMStructuredOutputError otherwise), so a
        # model that picks a different tool still fails loudly.
        if _rejects_named_tool_choice(model):
            return "required"
        return {"type": "function", "function": {"name": tool_choice["name"]}}
    return tool_choice


def build_openrouter_body(
    *,
    model: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    response_format: Optional[Dict[str, Any]],
    temperature: Optional[float],
    max_tokens: Optional[int],
    seed: Optional[int],
    provider_fast_mode: bool = False,
) -> Dict[str, Any]:
    """Assemble the OpenRouter /chat/completions request body for one model.

    Deterministic in its inputs — the same call shape is reused for every
    step of the waterfall, only `model` changes.
    """
    # Resolve tools BEFORE building messages, so the message transform knows
    # whether this request will actually declare any. Without that, tool-call
    # history reaches a provider with no functionDeclarations — a deterministic
    # 400 on Google (see flatten_tool_history_to_text).
    openrouter_tools = _openrouter_tools(tools)
    body: Dict[str, Any] = {
        "model": model,
        "messages": transform_messages_for_openai(
            messages, tools_declared=bool(openrouter_tools)
        ),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if openrouter_tools:
        body["tools"] = openrouter_tools
    if tool_choice is not None and openrouter_tools:
        body["tool_choice"] = _openrouter_tool_choice(tool_choice, model)
    if response_format is not None:
        body["response_format"] = response_format
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if seed is not None:
        body["seed"] = seed
    if provider_fast_mode:
        body["speed"] = "fast"
    return body


async def waterfall_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    response_format: Optional[Dict[str, Any]] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    seed: Optional[int] = None,
    provider_fast_mode: bool = False,
    openrouter_key: str,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    per_step_timeout_s: float = _PER_STEP_TIMEOUT_S,
    idle_timeout_s: Optional[float] = None,
    exclude_anthropic_family: bool = False,
) -> AsyncIterator[StreamChunk]:
    """Walk the pool's waterfall until one model streams a clean response.

    On success: yields the normalized stream and returns. On exhaustion:
    raises `RoseAllFailed` with per-step errors.
    """
    step_errors: List[RoseStepError] = []

    for idx, model in enumerate(pool_spec.waterfall):
        if exclude_anthropic_family and is_anthropic_model(model):
            logger.warning(
                "rose.waterfall.step_skipped",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                pool=pool_spec.name,
                step=idx + 1,
                total=len(pool_spec.waterfall),
                model=model,
                reason="anthropic_family_excluded",
            )
            continue

        if response_format is not None and is_anthropic_model(model):
            error = RoseInvalidRequest(
                "Skipping OpenRouter Anthropic structured-output request: "
                "Bedrock rejects response_format as output_config.format"
            )
            step_errors.append(RoseStepError(model=model, error=error))
            logger.warning(
                "rose.waterfall.step_skipped",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                pool=pool_spec.name,
                step=idx + 1,
                total=len(pool_spec.waterfall),
                model=model,
                reason="anthropic_openrouter_response_format_unsupported",
            )
            continue

        logger.info(
            "rose.waterfall.step",
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            pool=pool_spec.name,
            step=idx + 1,
            total=len(pool_spec.waterfall),
            model=model,
        )
        body = build_openrouter_body(
            model=model,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            response_format=response_format,
            temperature=temperature,
            max_tokens=max_tokens,
            seed=seed,
            provider_fast_mode=provider_fast_mode,
        )
        emitted_user_visible = False
        try:
            async for chunk in _stream_one_step(
                body=body,
                model=model,
                pool_name=pool_spec.name,
                openrouter_key=openrouter_key,
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                per_step_timeout_s=per_step_timeout_s,
                idle_timeout_s=idle_timeout_s,
            ):
                if chunk.kind in {"content", "reasoning", "tool_call", "codex_reasoning_item"}:
                    emitted_user_visible = True
                yield chunk
            return
        except RoseError as exc:
            if emitted_user_visible:
                raise
            logger.warning(
                "rose.waterfall.step_failed",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                pool=pool_spec.name,
                step=idx + 1,
                model=model,
                error=str(exc),
            )
            step_errors.append(RoseStepError(model=model, error=exc))
        except asyncio.TimeoutError:
            msg = f"per-step timeout ({per_step_timeout_s}s)"
            logger.warning(
                "rose.waterfall.step_timeout",
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                pool=pool_spec.name,
                step=idx + 1,
                model=model,
            )
            step_errors.append(RoseStepError(model=model, error=RoseStallError(msg)))

    logger.error(
        "rose.waterfall.all_failed",
        request_id=request_id,
        agent_id=agent_id,
        call_site=call_site,
        pool=pool_spec.name,
        step_count=len(step_errors),
    )
    raise RoseAllFailed(
        f"All {len(pool_spec.waterfall)} waterfall models failed for pool {pool_spec.name}",
        step_errors=step_errors,
    )


async def _stream_one_step(
    *,
    body: Dict[str, Any],
    model: str,
    pool_name: str,
    openrouter_key: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    per_step_timeout_s: float,
    idle_timeout_s: Optional[float],
) -> AsyncIterator[StreamChunk]:
    """One waterfall step — open stream, classify on error, yield on success.

    Maps provider responses to typed errors the caller aggregates:
      non-2xx -> RoseError subclass (propagated, waterfall records + continues)
      connect/read exc -> wrapped RoseError
      empty stream -> RoseStallError from parse_openai_sse
    """
    try:
        async with post_openrouter_stream(
            body=body,
            openrouter_key=openrouter_key,
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            connect_timeout_s=per_step_timeout_s,
        ) as response:
            status = response.status_code
            if status >= 400:
                error_body = get_error_body(response)
                raise RoseError(
                    f"OpenRouter {model} returned {status}: {error_body[:2000]}",
                    status=status,
                )
            async for chunk in parse_openai_sse(
                response,
                actual_model=model,
                pool_name=pool_name,
                request_id=request_id,
                idle_timeout_s=idle_timeout_s,
            ):
                yield chunk
    except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
        raise RoseError(f"OpenRouter {model} connect/read error: {exc}") from exc
