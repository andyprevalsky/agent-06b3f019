"""Fast Mode cache — backend HTTP client.

Reads/writes go to the backend store (Postgres + Supabase) via /api/fast-cache.
Gating is the caller's job: reads happen only when Fast Mode is on; allowlisted
accounts may still write-through when Fast Mode is off.
Failures degrade gracefully (a read miss / a dropped write) so the cache can never
break a live run (#16).
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict

import httpx
import structlog

from . import normalize

logger = structlog.get_logger(__name__)

_GET_TIMEOUT_S = 15.0
_SET_TIMEOUT_S = 30.0

# A single pooled client per worker process. Creating a fresh httpx.AsyncClient per
# cache call churns connections and can overwhelm the backend under the high call
# volume Fast Mode generates (get+set on every LLM call). Reuse one bounded pool.
_client: Optional[httpx.AsyncClient] = None


class CacheRecord(TypedDict):
    hit: bool
    value: Any
    blobPath: Optional[str]


def _shared_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=_SET_TIMEOUT_S,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _client


def _backend() -> tuple[str, str]:
    from config import load_config

    config = load_config()
    return config.backend.api_url, (config.backend.api_key or "")


async def cache_get_record(key: str) -> CacheRecord:
    """Return the raw cache record for `key`.

    This exposes `blobPath` for binary cache entries while keeping `cache_get`
    as the simple value-only API used by LLM/search/fetch JSON callers.
    """
    try:
        api_url, api_key = _backend()
        resp = await _shared_client().post(
            f"{api_url}/api/fast-cache/get",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json={"key": key},
            timeout=_GET_TIMEOUT_S,
        )
        if resp.status_code != 200:
            logger.warning("fast_cache.get_failed", key=key, status=resp.status_code)
            return {"hit": False, "value": None, "blobPath": None}
        data = resp.json()
        return {
            "hit": bool(data.get("hit")),
            "value": data.get("value"),
            "blobPath": data.get("blobPath"),
        }
    except Exception as exc:  # cache must never break a run
        logger.warning("fast_cache.get_error", key=key, error=str(exc))
        return {"hit": False, "value": None, "blobPath": None}


async def cache_get(key: str) -> Optional[Any]:
    """Return the cached value for `key`, or None on miss / any error."""
    record = await cache_get_record(key)
    return record.get("value") if record.get("hit") else None


# Per-process memo of (read_enabled, goal, write_enabled) keyed by agent_id, so
# auto-resolution costs at most one backend lookup per agent per worker process.
_AGENT_FASTMODE: dict[str, tuple[bool, Optional[str], bool]] = {}


async def resolve_agent_fast_mode(agent_id: str) -> tuple[bool, Optional[str], bool]:
    """Look up (read_enabled, goal, write_enabled) for an agent.

    `read_enabled` is the persisted Fast Mode flag. `write_enabled` may be true
    for allowlisted accounts even when reads are off. Returns all-false on any
    error (degrade to no-cache).
    """
    if agent_id in _AGENT_FASTMODE:
        return _AGENT_FASTMODE[agent_id]
    enabled, goal, write_enabled = False, None, False
    try:
        api_url, api_key = _backend()
        # Dedicated internal endpoint (API-key auth, no RLS) — the agent serializer
        # doesn't expose fastModeCacheEnabled and GET /agents needs an X-User-Id.
        resp = await _shared_client().post(
            f"{api_url}/api/fast-cache/agent-flag",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json={"agentId": agent_id},
            timeout=_GET_TIMEOUT_S,
        )
        if resp.status_code == 200:
            data = resp.json()
            enabled = bool(data.get("enabled"))
            goal = data.get("goal")
            write_enabled = bool(data.get("writeEnabled", enabled))
        else:
            logger.warning("fast_cache.resolve_agent_failed", agent_id=agent_id, status=resp.status_code)
    except Exception as exc:  # noqa: BLE001
        logger.warning("fast_cache.resolve_agent_error", agent_id=agent_id, error=str(exc))
    # Only memoize a positive resolution — a transient failure shouldn't disable
    # the cache for the rest of the run.
    if goal and (enabled or write_enabled):
        _AGENT_FASTMODE[agent_id] = (enabled, goal, write_enabled)
    return enabled, goal, write_enabled


async def ensure_context(agent_id: Optional[str], goal: Optional[str] = None):
    """Ensure a FastCacheContext is set for the current activity. No-op if one is
    already enabled. Otherwise auto-resolves (enabled, goal) from the agent row.
    One line at an activity's entry makes every LLM call inside it cache-aware —
    no signature threading."""
    from .context import FastCacheContext, current_context, set_context

    existing = current_context()
    if existing is not None and existing.active:
        return existing
    if not agent_id:
        return existing
    enabled, resolved_goal, write_enabled = await resolve_agent_fast_mode(agent_id)
    g = goal or resolved_goal
    if g and (enabled or write_enabled):
        ctx = FastCacheContext(enabled=enabled, goal=g, write_enabled=write_enabled)
        set_context(ctx)
        return ctx
    return existing


async def ensure_position_context(agent_id: Optional[str], step: int):
    """Compatibility wrapper for old callers.

    Main agent loop/verifier calls have a durable step. Use it for replay so live
    tool-result IDs and timing do not bust cache hits, while the static request
    fingerprint still invalidates prompt/schema/config changes.
    """
    from .context import FastCacheContext, set_context

    if not agent_id:
        return None
    enabled, goal, write_enabled = await resolve_agent_fast_mode(agent_id)
    if goal and (enabled or write_enabled):
        ctx = FastCacheContext(
            enabled=enabled,
            goal=goal,
            base_step=step,
            write_enabled=write_enabled,
        )
        set_context(ctx)
        return ctx
    return None


async def cache_set(
    key: str,
    kind: str,
    goal_hash: str,
    value: Any,
    blob_path: Optional[str] = None,
) -> bool:
    """Write `value` under `key`. Last write wins. Never raises."""
    try:
        api_url, api_key = _backend()
        resp = await _shared_client().post(
            f"{api_url}/api/fast-cache/set",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json={
                "key": key,
                "kind": kind,
                "goalHash": goal_hash,
                "value": normalize.strip_secrets(value),
                "blobPath": blob_path,
            },
            timeout=_SET_TIMEOUT_S,
        )
        if resp.status_code != 200:
            logger.warning("fast_cache.set_failed", key=key, status=resp.status_code)
            return False
        return True
    except Exception as exc:
        logger.warning("fast_cache.set_error", key=key, error=str(exc))
        return False
