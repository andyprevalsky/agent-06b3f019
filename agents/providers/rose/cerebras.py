"""Direct Cerebras hop for rose-fast pools.

Posts the pool's `cerebras_model` to api.cerebras.ai. This is not an
OpenRouter provider pin — OpenRouter does not route Qwen 3.8 27B to Cerebras.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from config import load_config
from providers.rose.errors import RoseError, RoseRateLimitError
from providers.rose.pools import PoolSpec
from providers.rose.streaming import parse_openai_sse
from providers.rose.transforms import transform_messages_for_openai
from providers.rose.transport import post_cerebras_stream
from providers.rose.types import StreamChunk
from providers.rose.waterfall import _openrouter_tool_choice, _openrouter_tools

logger = structlog.get_logger()

CEREBRAS_DIRECT_POOL = "cerebras-direct"

# Same shared backend cooldown contract as the funded Anthropic key. Fast local
# reads and a single in-flight lookup keep this off the per-token hot path.
_COOLDOWN_RECHECK_S = 15.0
_COOLDOWN_RPC_TIMEOUT_S = 2.0
_cooldowns: Dict[tuple, tuple] = {}
_cooldown_reads: Dict[tuple, asyncio.Task] = {}


def _reset_cerebras_cooldown_cache() -> None:
    """Test-only reset; active RPC tasks must already have completed."""
    _cooldowns.clear()
    _cooldown_reads.clear()


def _cooldown_scope(key: str, model: str):
    credential_id = hashlib.sha256(key.encode()).hexdigest()
    cfg = load_config()
    backend = getattr(cfg, "backend", None)
    base = (getattr(backend, "api_url", "") or "").rstrip("/")
    return (base, credential_id, model), getattr(backend, "api_key", "") or ""


def _remember_cooldown(scope: tuple, seconds: float) -> None:
    now = time.monotonic()
    previous = _cooldowns.get(scope, (0.0, 0.0))
    _cooldowns[scope] = (max(previous[0], now + seconds), now + _COOLDOWN_RECHECK_S)
    if len(_cooldowns) > 256:
        for key, (until, check_after) in list(_cooldowns.items()):
            if max(until, check_after) <= now:
                _cooldowns.pop(key, None)


async def _cerebras_on_cooldown(scope: tuple, api_key: str) -> bool:
    now = time.monotonic()
    until, check_after = _cooldowns.get(scope, (0.0, 0.0))
    if now < until:
        return True
    if now < check_after or not scope[0] or not api_key:
        return False

    async def read_shared():
        try:
            async with asyncio.timeout(_COOLDOWN_RPC_TIMEOUT_S):
                async with httpx.AsyncClient(timeout=_COOLDOWN_RPC_TIMEOUT_S) as client:
                    response = await client.get(
                        f"{scope[0]}/api/integrations/compute-code/cerebras-key/cooldown",
                        headers={"X-API-Key": api_key},
                        params={"credentialId": scope[1], "model": scope[2]},
                    )
            value = response.json().get("rateLimitedUntil") if response.status_code == 200 else None
            if isinstance(value, str):
                reset = datetime.fromisoformat(value.replace("Z", "+00:00"))
                seconds = (reset - datetime.now(timezone.utc)).total_seconds()
                if seconds > 0:
                    _remember_cooldown(scope, seconds)
        except Exception:
            # Health lookup failure must not disable an otherwise usable route.
            logger.warning("rose.cerebras.cooldown_read_failed")
        finally:
            old = _cooldowns.get(scope, (0.0, 0.0))
            _cooldowns[scope] = (old[0], time.monotonic() + _COOLDOWN_RECHECK_S)

    task = _cooldown_reads.get(scope)
    if task is None:
        task = asyncio.create_task(read_shared())
        _cooldown_reads[scope] = task
        task.add_done_callback(
            lambda done: _cooldown_reads.pop(scope, None) if _cooldown_reads.get(scope) is done else None
        )
    await asyncio.shield(task)
    return time.monotonic() < _cooldowns.get(scope, (0.0, 0.0))[0]


def _provider_cooldown_seconds(response: httpx.Response) -> Optional[float]:
    """Honor actual provider retry/reset headers; never guess token demand."""
    exhausted = []
    for header, value in response.headers.items():
        if not header.startswith("x-ratelimit-remaining-"):
            continue
        try:
            remaining = float(value)
            if math.isfinite(remaining) and remaining <= 0:
                exhausted.append(header.removeprefix("x-ratelimit-remaining-"))
        except ValueError:
            pass
    if response.status_code != 429 and not exhausted:
        return None
    delays = []
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            delays.append(float(retry_after))
        except ValueError:
            try:
                delays.append((parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds())
            except (ValueError, TypeError):
                pass
    for dimension in exhausted:
        try:
            delays.append(float(response.headers.get(f"x-ratelimit-reset-{dimension}", "")))
        except ValueError:
            pass
    valid = []
    for delay in delays:
        if math.isfinite(delay):
            try:
                # Malformed huge headers must not poison local state or raise
                # before the already-existing waterfall can recover.
                datetime.now(timezone.utc) + timedelta(seconds=max(0.0, delay))
            except (OverflowError, ValueError):
                continue
            valid.append(max(0.0, delay))
    return max(valid) if valid else 60.0


async def _mark_cerebras_cooldown(scope: tuple, api_key: str, seconds: float) -> None:
    if seconds <= 0:
        return
    _remember_cooldown(scope, seconds)
    until = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
    await _publish_cerebras_cooldown(scope, api_key, until)


async def _publish_cerebras_cooldown(scope: tuple, api_key: str, until: str) -> None:
    if not scope[0] or not api_key:
        return
    try:
        async with asyncio.timeout(_COOLDOWN_RPC_TIMEOUT_S):
            async with httpx.AsyncClient(timeout=_COOLDOWN_RPC_TIMEOUT_S) as client:
                response = await client.post(
                    f"{scope[0]}/api/integrations/compute-code/token/rate-limited",
                    headers={"X-API-Key": api_key},
                    json={
                        "type": "cerebras",
                        "source": "pool",
                        "credentialId": scope[1],
                        "model": scope[2],
                        "rateLimitedUntil": until,
                    },
                )
                response.raise_for_status()
    except Exception:
        logger.warning("rose.cerebras.cooldown_mark_failed")


def _strip_cerebras_cache_control(value: Any) -> Any:
    """Cerebras rejects Anthropic/OpenRouter ``cache_control`` markers.

    Live qwen-3.8-27b (2026-09-28) 400s
    ``messages.0.system.content.list[...].text.cache_control`` as unsupported
    and then falls through to OpenRouter. Keep text/image parts; drop the key.
    """
    if isinstance(value, dict):
        return {key: _strip_cerebras_cache_control(nested) for key, nested in value.items() if key != "cache_control"}
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
    scope, backend_key = _cooldown_scope(cerebras_key, model)
    if await _cerebras_on_cooldown(scope, backend_key):
        from providers.rose.whm_retry_observation import observe_cooldown

        observe_cooldown(model, max(0.0, _cooldowns.get(scope, (0.0, 0.0))[0] - time.monotonic()))
        logger.info("rose.cerebras.cooldown_skip", request_id=request_id, model=model)
        raise RoseRateLimitError("Cerebras route is on its reported quota cooldown", status=429)
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
    cooldown_mark: Optional[asyncio.Task] = None
    stream_completed = False
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
            cooldown_s = _provider_cooldown_seconds(response)
            if cooldown_s is not None:
                if status >= 400:
                    await _mark_cerebras_cooldown(scope, backend_key, cooldown_s)
                elif cooldown_s > 0:
                    # Quota headers govern later calls, not the successful
                    # response already streaming. Record locally before yield;
                    # the existing bounded shared write can finish separately.
                    _remember_cooldown(scope, cooldown_s)
                    until = (datetime.now(timezone.utc) + timedelta(seconds=cooldown_s)).isoformat()
                    cooldown_mark = asyncio.create_task(_publish_cerebras_cooldown(scope, backend_key, until))
            if status >= 400:
                from providers.rose.whm_retry_observation import observe_http_failure

                await observe_http_failure(model, response, cooldown_seconds=cooldown_s)
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
            stream_completed = True
    except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
        raise RoseError(f"Cerebras {model} connect/read error: {exc}") from exc
    finally:
        if cooldown_mark is not None:
            if not stream_completed:
                cooldown_mark.cancel()
            await asyncio.gather(cooldown_mark, return_exceptions=True)
