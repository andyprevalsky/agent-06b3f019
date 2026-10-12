"""GPT Responses fallback through Microsoft Foundry Global Standard deployments.

Both the agent and backend paths use the Codex Responses request builder, so
reasoning effort, tools, structured output and prompt caching stay aligned.
The deployment name replaces the model field; Foundry bills the Azure resource.
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from providers.rose.errors import RoseAuthError, RoseError, RoseInvalidRequest, RoseRateLimitError, RoseServerError
from providers.rose.gpt_auth import build_codex_responses_body
from providers.rose.pools import PoolSpec, foundry_model
from providers.rose.streaming import parse_responses_sse
from providers.rose.types import StreamChunk

logger = structlog.get_logger()
_cooldown_until: dict[str, float] = {}
_auth_cooldown_until = 0.0


def foundry_configured(pool_spec: PoolSpec) -> bool:
    return bool(
        pool_spec.foundry_enabled
        and time.monotonic() >= _auth_cooldown_until
        and os.getenv("AZURE_FOUNDRY_ENDPOINT", "").strip()
        and os.getenv("AZURE_FOUNDRY_API_KEY", "").strip()
    )


# Non-reasoning Foundry models (the open-weights pool's DeepSeek) reject
# reasoning.effort and reasoning includes with HTTP 400; omit both for them.
_NO_REASONING_MODELS = frozenset({"DeepSeek-V3.2"})


def _deployments(model: str) -> list[str]:
    """Deployments serving ``model``: configured names equal to it or prefixed ``<model>-``.

    AZURE_FOUNDRY_DEPLOYMENTS is shared by every Foundry pool, so one pool's
    deployments must never receive another pool's model. Without a matching
    configured name, Foundry's deploymentless inference serves the model id.
    """
    configured = [item.strip() for item in os.getenv("AZURE_FOUNDRY_DEPLOYMENTS", "").split(",") if item.strip()]
    matching = [name for name in configured if name == model or name.startswith(f"{model}-")]
    return matching or [model]


def _ordered_deployments(model: str, route_key: str) -> list[str]:
    deployments = _deployments(model)
    if not deployments:
        return []
    start = int(hashlib.sha256(route_key.encode()).hexdigest()[:8], 16) % len(deployments)
    return deployments[start:] + deployments[:start]


def _cooldown_seconds(headers: httpx.Headers) -> float:
    if headers.get("retry-after-ms"):
        try:
            return max(1.0, min(60.0, float(headers["retry-after-ms"]) / 1000.0))
        except ValueError:
            pass
    try:
        return max(1.0, min(60.0, float(headers.get("retry-after", "1"))))
    except ValueError:
        return 1.0


async def foundry_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
    context_tools: Optional[List[Dict[str, Any]]],
    tool_choice: Any,
    temperature: Optional[float],
    effort: Optional[str],
    provider_fast_mode: bool,
    request_id: str,
    route_key: Optional[str],
    agent_id: Optional[str],
    call_site: Optional[str],
    cache_namespace: Optional[str],
    ttft_timeout_s: float,
    idle_timeout_s: Optional[float],
) -> AsyncIterator[StreamChunk]:
    global _auth_cooldown_until
    endpoint = os.environ["AZURE_FOUNDRY_ENDPOINT"].strip().rstrip("/")
    if endpoint.endswith("/openai/v1"):
        endpoint = endpoint[: -len("/openai/v1")]
    if not endpoint.startswith("https://"):
        raise RoseInvalidRequest("AZURE_FOUNDRY_ENDPOINT must be HTTPS")
    url = f"{endpoint}/openai/v1/responses"
    key = os.environ["AZURE_FOUNDRY_API_KEY"].strip()
    last_error: RoseError = RoseServerError("No usable Foundry deployment")
    timeout = httpx.Timeout(connect=ttft_timeout_s, read=None, write=ttft_timeout_s, pool=ttft_timeout_s)
    route_key = route_key or agent_id or request_id

    async with httpx.AsyncClient(timeout=timeout) as client:
        for deployment in _ordered_deployments(foundry_model(pool_spec), route_key):
            if time.monotonic() < _cooldown_until.get(deployment, 0):
                continue
            body = build_codex_responses_body(
                pool_spec=pool_spec,
                model_override=deployment,
                messages=messages,
                response_format=response_format,
                tools=tools,
                context_tools=context_tools,
                tool_choice=tool_choice,
                temperature=temperature,
                effort=effort,
                provider_fast_mode=provider_fast_mode,
                cache_namespace=cache_namespace,
                request_id=request_id,
                # Foundry Standard deployments honor caller cache markers as breakpoints.
                cache_breakpoints=True,
            )
            if foundry_model(pool_spec) in _NO_REASONING_MODELS:
                body.pop("reasoning", None)
                body.pop("include", None)
            yielded_visible = False
            try:
                async with client.stream("POST", url, headers={"api-key": key}, json=body) as response:
                    if response.status_code != 200:
                        status = response.status_code
                        # Consume the error for connection reuse; never log its body or key.
                        await response.aread()
                        if status == 429:
                            _cooldown_until[deployment] = time.monotonic() + _cooldown_seconds(response.headers)
                            last_error = RoseRateLimitError(
                                f"Foundry deployment {deployment} rate limited", status=status
                            )
                        elif status in (401, 403):
                            _auth_cooldown_until = time.monotonic() + 300
                            last_error = RoseAuthError(f"Foundry authentication failed ({status})", status=status)
                        elif status == 400:
                            last_error = RoseInvalidRequest("Foundry rejected the Responses request", status=status)
                        else:
                            last_error = RoseServerError(
                                f"Foundry deployment {deployment} returned {status}", status=status
                            )
                        logger.warning("rose.foundry.attempt_failed", deployment=deployment, status=status)
                        # A request-shape or authentication error applies to every deployment.
                        if status in (400, 401, 403):
                            break
                        continue

                    buffered: Optional[StreamChunk] = None
                    try:
                        async for chunk in parse_responses_sse(
                            response,
                            actual_model=f"{foundry_model(pool_spec)}-foundry",
                            pool_name="foundry",
                            request_id=request_id,
                            idle_timeout_s=idle_timeout_s,
                        ):
                            if chunk.kind == "metadata" and buffered is None:
                                buffered = chunk
                                continue
                            if buffered is not None:
                                yield buffered
                                buffered = None
                            yielded_visible = True
                            yield chunk
                        return
                    except RoseError as exc:
                        if yielded_visible:
                            raise
                        last_error = exc
                        if isinstance(exc, RoseRateLimitError):
                            _cooldown_until[deployment] = time.monotonic() + _cooldown_seconds(response.headers)
                        logger.warning(
                            "rose.foundry.stream_failed", deployment=deployment, error_type=type(exc).__name__
                        )
            except httpx.TransportError as exc:
                if yielded_visible:
                    raise
                last_error = RoseServerError(f"Foundry transport failed: {type(exc).__name__}")
                logger.warning("rose.foundry.transport_failed", deployment=deployment, error_type=type(exc).__name__)
    raise last_error
