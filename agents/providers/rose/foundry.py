"""GPT Responses fallback through Microsoft Foundry Global Standard deployments.

Both the agent and backend paths use the Codex Responses request builder, so
reasoning effort, tools, structured output and prompt caching stay aligned.
The deployment name replaces the model field; Foundry bills the Azure resource.

The unsuffixed AZURE_FOUNDRY_ENDPOINT / _API_KEY / _DEPLOYMENTS variables are
region 1. AZURE_FOUNDRY_ENDPOINT_<n> / AZURE_FOUNDRY_API_KEY_<n> /
AZURE_FOUNDRY_DEPLOYMENTS_<n> (n = 2..9) add further Azure resources, normally
in other regions; a region needs both endpoint and key. Each route key ranks
regions by rendezvous hashing: one agent keeps a stable primary region (and its
prompt cache) while agents spread evenly, and a failing region's traffic spreads
over all remaining regions. Pre-content 429s, in-stream rate limits, 5xx and
transport errors try the next region; cooldowns are per (region, deployment).
"""

from __future__ import annotations

import hashlib
import os
import ssl
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlsplit

import httpx
import structlog

from providers.rose.errors import RoseAuthError, RoseError, RoseInvalidRequest, RoseRateLimitError, RoseServerError
from providers.rose.gpt_auth import build_codex_responses_body
from providers.rose.pools import PoolSpec, foundry_model
from providers.rose.streaming import parse_responses_sse
from providers.rose.types import StreamChunk

logger = structlog.get_logger()
# Keyed by (region endpoint, deployment) and by region endpoint respectively.
_cooldown_until: dict[tuple[str, str], float] = {}
_auth_cooldown_until: dict[str, float] = {}

_REGION_SLOTS = range(1, 10)


def _suffix(slot: int) -> str:
    return "" if slot == 1 else f"_{slot}"


FOUNDRY_REGION_ENV_NAMES: tuple[str, ...] = tuple(
    f"AZURE_FOUNDRY_{name}{_suffix(slot)}" for slot in _REGION_SLOTS for name in ("ENDPOINT", "API_KEY", "DEPLOYMENTS")
)


@dataclass(frozen=True)
class FoundryRegion:
    """One Azure resource. The key is excluded from repr so it cannot reach a log."""

    slot: int
    endpoint: str
    api_key: str = field(repr=False)
    deployments: tuple[str, ...] = ()

    @property
    def host(self) -> str:
        return urlsplit(self.endpoint).hostname or ""


def _configured_names(variable: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in os.getenv(variable, "").split(",") if item.strip())


def foundry_regions() -> list[FoundryRegion]:
    """Configured regions in slot order; the endpoint drops a trailing ``/openai/v1``."""
    regions = []
    for slot in _REGION_SLOTS:
        suffix = _suffix(slot)
        endpoint = os.getenv(f"AZURE_FOUNDRY_ENDPOINT{suffix}", "").strip().rstrip("/")
        key = os.getenv(f"AZURE_FOUNDRY_API_KEY{suffix}", "").strip()
        if not (endpoint and key):
            continue
        if endpoint.endswith("/openai/v1"):
            endpoint = endpoint[: -len("/openai/v1")]
        regions.append(FoundryRegion(slot, endpoint, key, _configured_names(f"AZURE_FOUNDRY_DEPLOYMENTS{suffix}")))
    return regions


# (slot, endpoint) pairs already warned about, so a bad optional slot logs once.
_warned_insecure_regions: set[tuple[int, str]] = set()


def _routable_regions() -> list[FoundryRegion]:
    """Configured regions that routing may use: HTTPS endpoints only.

    A non-HTTPS optional region (slot 2..9) is dropped with one warning naming
    its env slot, so a typo there cannot stop the healthy regions. A non-HTTPS
    region 1, or a configuration with no HTTPS region left, stays a whole-config
    error: it raises ``RoseInvalidRequest`` naming the env slot.
    """
    configured = foundry_regions()
    usable = [region for region in configured if region.endpoint.startswith("https://")]
    insecure = [region for region in configured if not region.endpoint.startswith("https://")]
    if insecure and (insecure[0].slot == 1 or not usable):
        raise RoseInvalidRequest(f"AZURE_FOUNDRY_ENDPOINT{_suffix(insecure[0].slot)} must be HTTPS")
    for region in insecure:
        if (region.slot, region.endpoint) not in _warned_insecure_regions:
            _warned_insecure_regions.add((region.slot, region.endpoint))
            logger.warning(
                "rose.foundry.region_not_https",
                env=f"AZURE_FOUNDRY_ENDPOINT{_suffix(region.slot)}",
                region_slot=region.slot,
            )
    return usable


def foundry_configured(pool_spec: PoolSpec) -> bool:
    if not pool_spec.foundry_enabled:
        return False
    try:
        regions = _routable_regions()
    except RoseInvalidRequest:
        # Routing rejects this configuration; let foundry_complete surface that error.
        return True
    now = time.monotonic()
    model = foundry_model(pool_spec)
    return any(
        now >= _auth_cooldown_until.get(region.endpoint, 0.0) and _region_deployments(region, model)
        for region in regions
    )


# Non-reasoning Foundry models (the open-weights pool's DeepSeek) reject
# reasoning.effort and reasoning includes with HTTP 400; omit both for them.
_NO_REASONING_MODELS = frozenset({"DeepSeek-V3.2"})


def _matching(configured: tuple[str, ...], model: str) -> list[str]:
    return [name for name in configured if name == model or name.startswith(f"{model}-")]


def _region_deployments(region: FoundryRegion, model: str) -> list[str]:
    """Deployments serving ``model``: configured names equal to it or prefixed ``<model>-``.

    A region's deployment list is shared by every Foundry pool, so one pool's
    deployments must never receive another pool's model. Without a matching
    name, region 1 uses Foundry's deploymentless inference for the model id;
    other regions serve only the names they list, so a new resource holding
    only GPT-6 Sol never receives Luna or DeepSeek traffic.
    """
    matching = _matching(region.deployments, model)
    return (matching or [model]) if region.slot == 1 else matching


def _rotated(names: list[str], route_key: str) -> list[str]:
    if not names:
        return []
    start = int(hashlib.sha256(route_key.encode()).hexdigest()[:8], 16) % len(names)
    return names[start:] + names[:start]


def _rendezvous_weight(route_key: str, region: FoundryRegion) -> int:
    return int(hashlib.sha256(f"{route_key}\n{region.endpoint}".encode()).hexdigest()[:16], 16)


def _route_plan(regions: list[FoundryRegion], model: str, route_key: str) -> list[tuple[FoundryRegion, str]]:
    """Every (region, deployment) to try, primary region first, for this route key."""
    serving = [region for region in regions if _region_deployments(region, model)]
    serving.sort(key=lambda region: (-_rendezvous_weight(route_key, region), region.slot))
    return [
        (region, deployment)
        for region in serving
        for deployment in _rotated(_region_deployments(region, model), route_key)
    ]


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


def _record_http_failure(status: int, region: FoundryRegion, deployment: str, headers: httpx.Headers) -> RoseError:
    """Classify a non-200 Foundry response and record the cooldown it implies."""
    if status == 429:
        _cooldown_until[(region.endpoint, deployment)] = time.monotonic() + _cooldown_seconds(headers)
        return RoseRateLimitError(f"Foundry deployment {deployment} rate limited", status=status)
    if status in (401, 403):
        # A key belongs to one Azure resource; other regions keep serving.
        _auth_cooldown_until[region.endpoint] = time.monotonic() + 300
        return RoseAuthError(f"Foundry authentication failed ({status})", status=status)
    if status == 400:
        return RoseInvalidRequest("Foundry rejected the Responses request", status=status)
    return RoseServerError(f"Foundry deployment {deployment} returned {status}", status=status)


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
    max_tokens: Optional[int] = None,
) -> AsyncIterator[StreamChunk]:
    model = foundry_model(pool_spec)
    regions = _routable_regions()
    last_error: Optional[RoseError] = None
    skipped_cooling = False
    attempt = 0
    timeout = httpx.Timeout(connect=ttft_timeout_s, read=None, write=ttft_timeout_s, pool=ttft_timeout_s)
    route_key = route_key or agent_id or request_id

    async with httpx.AsyncClient(timeout=timeout) as client:
        for region, deployment in _route_plan(regions, model, route_key):
            now = time.monotonic()
            if now < _auth_cooldown_until.get(region.endpoint, 0.0):
                continue
            if now < _cooldown_until.get((region.endpoint, deployment), 0.0):
                skipped_cooling = True
                continue
            attempt += 1
            # Region identity only; the key is never part of any log event.
            where = {"region": region.host, "region_slot": region.slot, "deployment": deployment}
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
            if max_tokens is not None:
                body["max_output_tokens"] = max_tokens
            if model in _NO_REASONING_MODELS:
                body.pop("reasoning", None)
                body.pop("include", None)
            yielded_visible = False
            try:
                async with client.stream(
                    "POST", f"{region.endpoint}/openai/v1/responses", headers={"api-key": region.api_key}, json=body
                ) as response:
                    if response.status_code != 200:
                        status = response.status_code
                        from providers.rose.whm_retry_observation import observe_http_failure

                        await observe_http_failure(foundry_model(pool_spec), response, body_read_required=True)
                        # Consume the error for connection reuse; never log its body or key.
                        await response.aread()
                        last_error = _record_http_failure(status, region, deployment, response.headers)
                        logger.warning("rose.foundry.attempt_failed", request_id=request_id, status=status, **where)
                        # A request-shape error applies to every region and deployment.
                        if status == 400:
                            break
                        continue

                    buffered: Optional[StreamChunk] = None
                    try:
                        async for chunk in parse_responses_sse(
                            response,
                            actual_model=f"{model}-foundry",
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
                        logger.info("rose.foundry.served", request_id=request_id, attempt=attempt, **where)
                        return
                    except RoseError as exc:
                        if yielded_visible:
                            raise
                        last_error = exc
                        if isinstance(exc, RoseRateLimitError):
                            _cooldown_until[(region.endpoint, deployment)] = time.monotonic() + _cooldown_seconds(
                                response.headers
                            )
                        logger.warning(
                            "rose.foundry.stream_failed", request_id=request_id, error_type=type(exc).__name__, **where
                        )
                        # An in-stream request-shape rejection is the same everywhere.
                        if isinstance(exc, RoseInvalidRequest):
                            break
            # TLS record alerts can escape httpx as raw SSLError while reading headers.
            except (httpx.TransportError, ssl.SSLError) as exc:
                if yielded_visible:
                    raise
                last_error = RoseServerError(f"Foundry transport failed: {type(exc).__name__}")
                logger.warning(
                    "rose.foundry.transport_failed", request_id=request_id, error_type=type(exc).__name__, **where
                )
    if last_error is not None:
        raise last_error
    if skipped_cooling:
        # Every candidate is cooling; let the waterfall move on without a request.
        raise RoseRateLimitError("Every Foundry region and deployment is cooling down")
    raise RoseServerError("No usable Foundry deployment")
