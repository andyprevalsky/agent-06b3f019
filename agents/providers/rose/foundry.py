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

Rate-limit cooldowns are shared: every worker process reads and reports them
through its backend (``/compute-code/foundry-deployment/cooldown`` and
``token/rate-limited type=foundry``), so a rejection seen by one process stops
the others from re-hitting that deployment until it expires. Benchmark guests
forward those calls to the compute-token authority. The module dicts are a
short-lived local cache, and the only state when no backend key is configured.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import ssl
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, FrozenSet, List, Optional
from urllib.parse import urlsplit

import httpx
import structlog

from providers.rose.errors import RoseAuthError, RoseError, RoseInvalidRequest, RoseRateLimitError, RoseServerError
from providers.rose.gpt_auth import build_codex_responses_body
from providers.rose.pools import PoolSpec, foundry_model, foundry_models
from providers.rose.streaming import parse_responses_sse
from providers.rose.truncation import model_key
from providers.rose.types import StreamChunk

logger = structlog.get_logger()
# Keyed by (region endpoint, deployment) and by region endpoint respectively.
_cooldown_until: dict[tuple[str, str], float] = {}
_auth_cooldown_until: dict[str, float] = {}
# Escalation strikes per (region endpoint, deployment), mirrored from the backend.
_strikes: dict[tuple[str, str], int] = {}
# When this process last read each deployment's shared cooldown (monotonic).
_shared_checked_at: dict[tuple[str, str], float] = {}
_shared_reads: dict[tuple[tuple[str, str], ...], asyncio.Task] = {}

# Rate-limit hold without provider retry advice: 30 s, 60 s, then 300 s per
# deployment (openclaw/src/agents/auth-profiles/usage-failure-state.ts:18-27).
# Mirrors FOUNDRY_COOLDOWN_LADDER_SECONDS in the backend's shared store.
_COOLDOWN_LADDER_S = (30.0, 60.0, 300.0)
# Bounds how long another process's fresh mark can go unseen here.
_SHARED_RECHECK_S = 5.0
_SHARED_RPC_TIMEOUT_S = 2.0
# codex-rs/codex-api/src/sse/responses_error.rs:137-143 (used at :90-125).
_TRY_AGAIN_RE = re.compile(r"(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)")

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
    models = foundry_models(pool_spec)
    listed = _listed(regions, models)
    return any(
        now >= _auth_cooldown_until.get(region.endpoint, 0.0) and _region_deployments(region, models, listed)
        for region in regions
    )


# Non-reasoning Foundry models (the open-weights pool's DeepSeek) reject
# reasoning.effort and reasoning includes with HTTP 400; omit both for them.
_NO_REASONING_MODELS = frozenset({"DeepSeek-V3.2"})


def foundry_candidates(pool_spec: PoolSpec, skip_models: FrozenSet[str] = frozenset()) -> tuple[str, ...]:
    """The pool's Foundry models minus any excluded (by ``model_key``) after a truncation."""
    return tuple(model for model in foundry_models(pool_spec) if model_key(model) not in skip_models)


def _as_models(models: str | tuple[str, ...]) -> tuple[str, ...]:
    return (models,) if isinstance(models, str) else models


def _served_model(deployment: str, models: str | tuple[str, ...]) -> str:
    """The model a deployment name serves: the first of ``models`` it equals or extends."""
    models = _as_models(models)
    return next((model for model in models if deployment == model or deployment.startswith(f"{model}-")), models[0])


def _matching(configured: tuple[str, ...], models: str | tuple[str, ...]) -> list[str]:
    models = _as_models(models)
    return [name for name in configured if any(name == m or name.startswith(f"{m}-") for m in models)]


def _listed(regions: list[FoundryRegion], models: str | tuple[str, ...]) -> bool:
    return any(_matching(region.deployments, models) for region in regions)


def _region_deployments(
    region: FoundryRegion, models: str | tuple[str, ...], listed_elsewhere: bool = False
) -> list[str]:
    """Deployments serving ``models``: configured names equal to one or prefixed ``<model>-``.

    A region's deployment list is shared by every Foundry pool, so one pool's
    deployments must never receive another pool's model. Without a matching
    name, region 1 uses Foundry's deploymentless inference for the pool's own
    model unless another region lists one of ``models`` (that region is where
    it is deployed; region 1's deploymentless call would be a terminal 400).
    Other regions serve only the names they list, so a new resource holding
    only GPT-6 Sol never receives Luna or DeepSeek traffic.
    """
    matching = _matching(region.deployments, models)
    if matching or region.slot != 1 or listed_elsewhere:
        return matching
    return [_as_models(models)[0]]


def _rotated(names: list[str], route_key: str) -> list[str]:
    if not names:
        return []
    start = int(hashlib.sha256(route_key.encode()).hexdigest()[:8], 16) % len(names)
    return names[start:] + names[:start]


def _rendezvous_weight(route_key: str, region: FoundryRegion) -> int:
    return int(hashlib.sha256(f"{route_key}\n{region.endpoint}".encode()).hexdigest()[:16], 16)


def _route_plan(
    regions: list[FoundryRegion], models: str | tuple[str, ...], route_key: str
) -> list[tuple[FoundryRegion, str]]:
    """Every (region, deployment) to try, primary region first, for this route key."""
    listed = _listed(regions, models)
    serving = [region for region in regions if _region_deployments(region, models, listed)]
    serving.sort(key=lambda region: (-_rendezvous_weight(route_key, region), region.slot))
    return [
        (region, deployment)
        for region in serving
        for deployment in _rotated(_region_deployments(region, models, listed), route_key)
    ]


def _retry_hint_seconds(headers: httpx.Headers, message: str = "") -> Optional[float]:
    """Provider retry advice: Retry-After headers, else an in-stream "try again in N s".

    Same order as codex-rs/codex-api/src/sse/responses_error.rs:90-125: the
    header wins, the message is parsed only when no header was sent.
    """
    for name, scale in (("retry-after-ms", 1000.0), ("retry-after", 1.0)):
        value = headers.get(name)
        if value:
            try:
                seconds = float(value) / scale
            except ValueError:
                continue
            if seconds > 0 and seconds == seconds and seconds != float("inf"):
                return seconds
    match = _TRY_AGAIN_RE.search(message or "")
    if match is None:
        return None
    value = float(match.group(1))
    seconds = value / 1000.0 if match.group(2).lower() == "ms" else value
    return seconds if seconds > 0 else None


def _remember_local_rate_limit(key: tuple[str, str], hint: Optional[float]) -> float:
    """Local cooldown for one rejection; returns its length in seconds.

    A rejection while the deployment is already cooling belongs to the same
    failure generation (requests already in flight), so it adds no strike.
    """
    now = time.monotonic()
    active_until = _cooldown_until.get(key, 0.0)
    if now < active_until:
        if hint is not None:
            _cooldown_until[key] = max(active_until, now + hint)
        return _cooldown_until[key] - now
    strikes = _strikes.get(key, 0) + 1
    _strikes[key] = strikes
    seconds = (
        hint
        if hint is not None
        else _COOLDOWN_LADDER_S[min(strikes, len(_COOLDOWN_LADDER_S)) - 1]
    )
    _cooldown_until[key] = now + seconds
    return seconds


def _shared_scope() -> Optional[tuple[str, str]]:
    """The backend that owns shared cooldowns (same env as config.load_config)."""
    api_key = (os.getenv("BACKEND_API_KEY", "") or "").strip()
    if not api_key:
        return None
    base = (os.getenv("BACKEND_API_URL", "") or "").strip().rstrip("/") or "https://navi-j9a9.onrender.com"
    return base, api_key


def _shared_key(key: tuple[str, str]) -> str:
    return f"{(urlsplit(key[0]).hostname or '').lower()}:{key[1]}"


def _apply_shared_until(key: tuple[str, str], until: Optional[str]) -> None:
    if not isinstance(until, str):
        return
    try:
        remaining = (datetime.fromisoformat(until.replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds()
    except ValueError:
        return
    if remaining > 0:
        _cooldown_until[key] = max(_cooldown_until.get(key, 0.0), time.monotonic() + remaining)


async def _refresh_shared_cooldowns(keys: list[tuple[str, str]]) -> None:
    """Read the shared cooldown of every stale deployment in one request."""
    scope = _shared_scope()
    now = time.monotonic()
    stale = tuple(sorted({key for key in keys if now - _shared_checked_at.get(key, -1e18) >= _SHARED_RECHECK_S}))
    if scope is None or not stale:
        return

    async def read() -> None:
        try:
            async with asyncio.timeout(_SHARED_RPC_TIMEOUT_S):
                async with httpx.AsyncClient(timeout=_SHARED_RPC_TIMEOUT_S) as rpc:
                    response = await rpc.get(
                        f"{scope[0]}/api/integrations/compute-code/foundry-deployment/cooldown",
                        headers={"X-API-Key": scope[1]},
                        params={"keys": ",".join(_shared_key(key) for key in stale)},
                    )
            if response.status_code != 200:
                raise RoseServerError(f"shared Foundry cooldown read returned {response.status_code}")
            cooldowns = response.json().get("cooldowns") or {}
            for key in stale:
                state = cooldowns.get(_shared_key(key)) or {}
                _strikes[key] = int(state.get("strikes") or 0)
                _cooldown_until.pop(key, None)
                _apply_shared_until(key, state.get("rateLimitedUntil"))
        except Exception as exc:
            # With a configured authority, unknown shared state must not send
            # traffic to a deployment another worker may already have cooled.
            logger.warning("rose.foundry.shared_cooldown_read_failed", error_type=type(exc).__name__)
            raise RoseServerError("Foundry shared cooldown authority unavailable") from exc
        checked = time.monotonic()
        for key in stale:
            _shared_checked_at[key] = checked

    task = _shared_reads.get(stale)
    if task is None:
        task = asyncio.create_task(read())
        _shared_reads[stale] = task
        task.add_done_callback(
            lambda done: _shared_reads.pop(stale, None) if _shared_reads.get(stale) is done else None
        )
    await asyncio.shield(task)


async def _report_rate_limit(region: FoundryRegion, deployment: str, hint: Optional[float]) -> None:
    """Cool the deployment here at once, then publish it for every other process."""
    key = (region.endpoint, deployment)
    seconds = _remember_local_rate_limit(key, hint)
    scope = _shared_scope()
    if scope is None:
        return
    body: dict[str, Any] = {
        "type": "foundry",
        "source": "pool",
        "region": region.host.lower(),
        "deployment": deployment,
    }
    if hint is not None:
        body["retryAfterSeconds"] = hint
    try:
        async with asyncio.timeout(_SHARED_RPC_TIMEOUT_S):
            async with httpx.AsyncClient(timeout=_SHARED_RPC_TIMEOUT_S) as rpc:
                response = await rpc.post(
                    f"{scope[0]}/api/integrations/compute-code/token/rate-limited",
                    headers={"X-API-Key": scope[1]},
                    json=body,
                )
        if response.status_code != 200:
            raise RoseServerError(f"shared Foundry cooldown mark returned {response.status_code}")
        state = response.json()
        # The shared store owns escalation; adopt its strike count and expiry.
        _strikes[key] = int(state.get("strikes") or _strikes.get(key, 0))
        until = state.get("rateLimitedUntil")
        if isinstance(until, str):
            _cooldown_until.pop(key, None)
            _apply_shared_until(key, until)
            if key not in _cooldown_until:
                _cooldown_until[key] = time.monotonic() + seconds
        _shared_checked_at[key] = time.monotonic()
    except Exception as exc:
        logger.warning("rose.foundry.shared_cooldown_mark_failed", error_type=type(exc).__name__)
        raise RoseServerError("Foundry shared cooldown authority unavailable") from exc


async def _report_served(region: FoundryRegion, deployment: str) -> None:
    """A served request ends this deployment's escalation everywhere."""
    key = (region.endpoint, deployment)
    if _strikes.pop(key, 0) <= 0:
        return
    scope = _shared_scope()
    if scope is None:
        return
    try:
        async with asyncio.timeout(_SHARED_RPC_TIMEOUT_S):
            async with httpx.AsyncClient(timeout=_SHARED_RPC_TIMEOUT_S) as rpc:
                await rpc.post(
                    f"{scope[0]}/api/integrations/compute-code/foundry-deployment/served",
                    headers={"X-API-Key": scope[1]},
                    json={"region": region.host.lower(), "deployment": deployment},
                )
    except Exception as exc:
        logger.warning("rose.foundry.shared_cooldown_reset_failed", error_type=type(exc).__name__)


def _reset_foundry_cooldown_cache() -> None:
    """Test-only reset; shared reads must already have completed."""
    _cooldown_until.clear()
    _auth_cooldown_until.clear()
    _strikes.clear()
    _shared_checked_at.clear()
    _shared_reads.clear()


def _record_http_failure(status: int, region: FoundryRegion, deployment: str, headers: httpx.Headers) -> RoseError:
    """Classify a non-200 Foundry response; a 429's cooldown is reported by the caller."""
    if status == 429:
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
    skip_models: FrozenSet[str] = frozenset(),
) -> AsyncIterator[StreamChunk]:
    model = foundry_model(pool_spec)
    # A model cut off at its output limit is excluded from every route serving it.
    candidates = foundry_candidates(pool_spec, skip_models)
    if not candidates:
        raise RoseServerError("Every Foundry model for this pool is excluded")
    regions = _routable_regions()
    last_error: Optional[RoseError] = None
    skipped_cooling = False
    attempt = 0
    timeout = httpx.Timeout(connect=ttft_timeout_s, read=None, write=ttft_timeout_s, pool=ttft_timeout_s)
    route_key = route_key or agent_id or request_id

    plan = _route_plan(regions, candidates, route_key)
    await _refresh_shared_cooldowns([(region.endpoint, deployment) for region, deployment in plan])
    async with httpx.AsyncClient(timeout=timeout) as client:
        for region, deployment in plan:
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
                        if status == 429:
                            await _report_rate_limit(region, deployment, _retry_hint_seconds(response.headers))
                        logger.warning("rose.foundry.attempt_failed", request_id=request_id, status=status, **where)
                        # A request-shape error applies to every region and deployment.
                        if status == 400:
                            break
                        continue

                    buffered: Optional[StreamChunk] = None
                    try:
                        async for chunk in parse_responses_sse(
                            response,
                            actual_model=f"{_served_model(deployment, candidates)}-foundry",
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
                        await _report_served(region, deployment)
                        return
                    except RoseError as exc:
                        if isinstance(exc, RoseRateLimitError):
                            await _report_rate_limit(
                                region, deployment, _retry_hint_seconds(response.headers, str(exc))
                            )
                        if yielded_visible:
                            raise
                        last_error = exc
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
