"""Fast Mode cache — backend HTTP client.

Reads/writes go to the backend store (Postgres + Supabase) via /api/fast-cache.
Gating is the caller's job: reads happen only when Fast Mode is on; allowlisted
accounts may still write-through when Fast Mode is off.
Failures degrade gracefully (a read miss / a dropped write) so the cache can never
break a live run (#16).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from typing import Any, Optional, TypedDict

import httpx
import structlog

from helpers.trace_archive import archive_json_deferred
from helpers.tracing import backend_api_headers, current_root_agent_id, current_span_id, span

from . import normalize

logger = structlog.get_logger(__name__)

_GET_TIMEOUT_S = 15.0
# A failed GET is conceded as a cache MISS, which sends the caller to an EXPENSIVE
# live LLM call. Under a fan-out the backend fast-cache endpoint 500s from DB-pool
# pressure, so retry the cheap GET a few times before conceding — a retry costs
# milliseconds; a false miss costs a full live model call.
_GET_MAX_ATTEMPTS = 3
_GET_RETRY_BACKOFF_S = 0.15
_SET_TIMEOUT_S = 30.0
_GET_BATCH_DELAY_S = 0.005
_GET_BATCH_MAX_KEYS = 500
_GET_BATCH_MAX_IN_FLIGHT = int(os.environ.get("FAST_CACHE_GET_BATCH_MAX_IN_FLIGHT", "16") or "16")
_HTTP_MAX_CONNECTIONS = int(os.environ.get("FAST_CACHE_HTTP_MAX_CONNECTIONS", "80") or "80")
_HTTP_MAX_KEEPALIVE_CONNECTIONS = int(
    os.environ.get("FAST_CACHE_HTTP_MAX_KEEPALIVE_CONNECTIONS", "40") or "40"
)
_ARCHIVE_READ_MAX_CONCURRENCY = 4

# A single pooled client per worker process. Creating a fresh httpx.AsyncClient per
# cache call churns connections and can overwhelm the backend under the high call
# volume Fast Mode generates (get+set on every LLM call). Reuse one bounded pool.
_client: Optional[httpx.AsyncClient] = None
_pending_gets: dict[str, list[tuple[asyncio.Future[CacheRecord], float]]] = {}
_pending_gets_lock: Optional[asyncio.Lock] = None
_pending_gets_flush_task: Optional[asyncio.Task[None]] = None
_pending_gets_batch_tasks: set[asyncio.Task[None]] = set()
_archive_read_tasks: set[asyncio.Task[None]] = set()
_archive_read_semaphore: Optional[asyncio.Semaphore] = None
_archive_read_semaphore_loop: Optional[asyncio.AbstractEventLoop] = None
_prefetched_records: dict[str, tuple[CacheRecord, float]] = {}
_PREFETCH_TTL_S = 5.0


class CacheRecord(TypedDict):
    hit: bool
    value: Any
    blobPath: Optional[str]


class _BatchUnsupported(Exception):
    pass


def _shared_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=_SET_TIMEOUT_S,
            limits=httpx.Limits(
                max_connections=_HTTP_MAX_CONNECTIONS,
                max_keepalive_connections=_HTTP_MAX_KEEPALIVE_CONNECTIONS,
            ),
        )
    return _client


def _backend() -> tuple[str, str]:
    from config import load_config

    config = load_config()
    return config.backend.api_url, (config.backend.api_key or "")


def _pending_lock() -> asyncio.Lock:
    global _pending_gets_lock
    if _pending_gets_lock is None:
        _pending_gets_lock = asyncio.Lock()
    return _pending_gets_lock


def _key_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _key_kind(key: str) -> str:
    parts = key.split(":", 4)
    return parts[2] if len(parts) >= 3 and parts[0] == "fastmode" else "unknown"


async def cache_get_record(key: str) -> CacheRecord:
    """Return the raw cache record for `key`.

    This exposes `blobPath` for binary cache entries while keeping `cache_get`
    as the simple value-only API used by LLM/search/fetch JSON callers.
    """
    prefetched = _pop_valid_prefetched_record(key)
    if prefetched is not None:
        _queue_archive_cache_read(
            key,
            hit=bool(prefetched.get("hit")),
            value=prefetched.get("value"),
            blob_path=prefetched.get("blobPath"),
            status=200,
        )
        logger.info(
            "fast_cache.prefetch_hit",
            key=key,
            key_hash=_key_hash(key),
            kind=_key_kind(key),
            hit=bool(prefetched.get("hit")),
        )
        return prefetched

    last_status: Optional[int] = None
    last_error: Optional[str] = None
    for attempt in range(_GET_MAX_ATTEMPTS):
        try:
            record = await _cache_get_record_batched(key)
            _queue_archive_cache_read(
                key,
                hit=bool(record.get("hit")),
                value=record.get("value"),
                blob_path=record.get("blobPath"),
                status=200,
            )
            return record
        except _BatchUnsupported:
            record, status = await _cache_get_record_direct(key)
            if status == 200:
                _queue_archive_cache_read(
                    key,
                    hit=bool(record.get("hit")),
                    value=record.get("value"),
                    blob_path=record.get("blobPath"),
                    status=status,
                )
                return record
            last_status = status
            if status is not None and status < 500:
                break
        except Exception as exc:  # timeout / connection reset — transient, retry
            last_error = str(exc)
        if attempt < _GET_MAX_ATTEMPTS - 1:
            await asyncio.sleep(_GET_RETRY_BACKOFF_S * (attempt + 1))

    # Retries exhausted — concede a miss so the cache never hard-breaks a run.
    if last_status is not None:
        logger.warning("fast_cache.get_failed", key=key, status=last_status, attempts=_GET_MAX_ATTEMPTS)
    else:
        logger.warning("fast_cache.get_error", key=key, error=(last_error or "")[:300], attempts=_GET_MAX_ATTEMPTS)
    _queue_archive_cache_read(key, hit=False, value=None, blob_path=None, status=last_status, error=last_error)
    return {"hit": False, "value": None, "blobPath": None}


async def _cache_get_record_direct(key: str) -> tuple[CacheRecord, Optional[int]]:
    api_url, api_key = _backend()
    resp = await _shared_client().post(
        f"{api_url}/api/fast-cache/get",
        headers=backend_api_headers(api_key),
        json={"key": key},
        timeout=_GET_TIMEOUT_S,
    )
    if resp.status_code != 200:
        return {"hit": False, "value": None, "blobPath": None}, resp.status_code
    data = resp.json()
    return {
        "hit": bool(data.get("hit")),
        "value": data.get("value"),
        "blobPath": data.get("blobPath"),
    }, resp.status_code


async def _cache_get_record_batched(key: str) -> CacheRecord:
    global _pending_gets_flush_task

    loop = asyncio.get_running_loop()
    future: asyncio.Future[CacheRecord] = loop.create_future()
    started = time.monotonic()
    async with _pending_lock():
        _pending_gets.setdefault(key, []).append((future, started))
        if _pending_gets_flush_task is None or _pending_gets_flush_task.done():
            _pending_gets_flush_task = asyncio.create_task(_flush_pending_gets())
    async with span(
        "fast_cache.cache_get_wait",
        cache_key_hash=_key_hash(key),
        cache_key_kind=_key_kind(key),
        max_in_flight=_GET_BATCH_MAX_IN_FLIGHT,
    ):
        record = await future
    logger.info(
        "fast_cache.cache_get_timing",
        key=key,
        key_hash=_key_hash(key),
        kind=_key_kind(key),
        hit=bool(record.get("hit")),
        total_ms=int((time.monotonic() - started) * 1000),
    )
    return record


async def _flush_pending_gets() -> None:
    await asyncio.sleep(_GET_BATCH_DELAY_S)
    while True:
        _pending_gets_batch_tasks.difference_update(task for task in _pending_gets_batch_tasks if task.done())
        while len(_pending_gets_batch_tasks) >= max(1, _GET_BATCH_MAX_IN_FLIGHT):
            done, _pending = await asyncio.wait(_pending_gets_batch_tasks, return_when=asyncio.FIRST_COMPLETED)
            _pending_gets_batch_tasks.difference_update(done)
            for task in done:
                task.result()

        async with _pending_lock():
            batch_items = list(_pending_gets.items())[:_GET_BATCH_MAX_KEYS]
            if not batch_items:
                return
            for key, _futures in batch_items:
                _pending_gets.pop(key, None)

        task = asyncio.create_task(_deliver_pending_get_batch(batch_items))
        _pending_gets_batch_tasks.add(task)

        def _on_done(done: asyncio.Task[None]) -> None:
            _pending_gets_batch_tasks.discard(done)
            try:
                done.result()
            except Exception as exc:
                logger.warning("fast_cache.get_many_batch_task_error", error=str(exc)[:200])

        task.add_done_callback(_on_done)
        await asyncio.sleep(0)


async def _deliver_pending_get_batch(
    batch_items: list[tuple[str, list[tuple[asyncio.Future[CacheRecord], float]]]],
) -> None:
    now = time.monotonic()
    keys = [key for key, _futures in batch_items]
    waiter_count = sum(len(futures) for _key, futures in batch_items)
    enqueued_times = [enqueued_at for _key, futures in batch_items for _future, enqueued_at in futures]
    queue_wait_ms = [int((now - enqueued_at) * 1000) for enqueued_at in enqueued_times]
    queue_avg_ms = int(sum(queue_wait_ms) / len(queue_wait_ms)) if queue_wait_ms else 0
    queue_max_ms = max(queue_wait_ms) if queue_wait_ms else 0
    try:
        async with span(
            "fast_cache.get_many.http",
            key_count=len(keys),
            waiter_count=waiter_count,
            queue_wait_avg_ms=queue_avg_ms,
            queue_wait_max_ms=queue_max_ms,
            max_in_flight=_GET_BATCH_MAX_IN_FLIGHT,
        ):
            records = await _fetch_cache_records_many(keys)
        logger.info(
            "fast_cache.get_many_batch",
            key_count=len(keys),
            waiter_count=waiter_count,
            queue_wait_avg_ms=queue_avg_ms,
            queue_wait_max_ms=queue_max_ms,
        )
        for key, futures in batch_items:
            record = records.get(key) or {"hit": False, "value": None, "blobPath": None}
            for future, _enqueued_at in futures:
                if not future.done():
                    future.set_result(record)
    except Exception as exc:
        for _key, futures in batch_items:
            for future, _enqueued_at in futures:
                if not future.done():
                    future.set_exception(exc)


async def _fetch_cache_records_many(keys: list[str]) -> dict[str, CacheRecord]:
    api_url, api_key = _backend()
    resp = await _shared_client().post(
        f"{api_url}/api/fast-cache/get-many",
        headers=backend_api_headers(api_key),
        json={"keys": keys},
        timeout=_GET_TIMEOUT_S,
    )
    if resp.status_code in {404, 405}:
        raise _BatchUnsupported()
    if resp.status_code != 200:
        raise RuntimeError(f"fast-cache get-many failed: {resp.status_code}")
    data = resp.json()
    raw_results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw_results, dict):
        raise _BatchUnsupported()

    records: dict[str, CacheRecord] = {}
    for key in keys:
        raw = raw_results.get(key)
        if isinstance(raw, dict):
            records[key] = {
                "hit": bool(raw.get("hit")),
                "value": raw.get("value"),
                "blobPath": raw.get("blobPath"),
            }
        else:
            records[key] = {"hit": False, "value": None, "blobPath": None}
    return records


def _pop_valid_prefetched_record(key: str) -> Optional[CacheRecord]:
    entry = _prefetched_records.pop(key, None)
    if entry is None:
        return None
    record, expires_at = entry
    if expires_at <= time.monotonic():
        return None
    return record


async def prefetch_cache_records(keys: list[str], *, reason: str = "") -> None:
    """Fetch exact fast-cache keys now so immediate tool handlers can consume them.

    This is intentionally one-shot and short-lived: it is not a durable Python LRU,
    so purge/write semantics still belong to the backend fast-cache store.
    """
    unique_keys = []
    seen = set()
    now = time.monotonic()
    for key in keys:
        if not key or key in seen:
            continue
        seen.add(key)
        entry = _prefetched_records.get(key)
        if entry is not None and entry[1] > now:
            continue
        unique_keys.append(key)
    if not unique_keys:
        return

    try:
        async with span(
            "fast_cache.prefetch",
            key_count=len(unique_keys),
            reason=reason,
        ):
            records = await _fetch_cache_records_many(unique_keys)
    except Exception as exc:
        logger.warning(
            "fast_cache.prefetch_error",
            key_count=len(unique_keys),
            reason=reason,
            error=str(exc)[:200],
        )
        return

    expires_at = time.monotonic() + _PREFETCH_TTL_S
    hit_count = 0
    for key in unique_keys:
        record = records.get(key)
        if record is None or not record.get("hit"):
            continue
        _prefetched_records[key] = (record, expires_at)
        hit_count += 1
    logger.info(
        "fast_cache.prefetch_done",
        key_count=len(unique_keys),
        hit_count=hit_count,
        reason=reason,
    )


async def cache_get(key: str) -> Optional[Any]:
    """Return the cached value for `key`, or None on miss / any error."""
    record = await cache_get_record(key)
    return record.get("value") if record.get("hit") else None


# Per-process memo of (read_enabled, goal, write_enabled, root_agent_id) keyed by agent_id, so
# auto-resolution costs at most one backend lookup per agent per worker process.
_AGENT_FASTMODE: dict[str, tuple[bool, Optional[str], bool, Optional[str]]] = {}


async def resolve_agent_fast_mode(agent_id: str) -> tuple[bool, Optional[str], bool, Optional[str]]:
    """Look up (read_enabled, goal, write_enabled, root_agent_id) for an agent.

    `read_enabled` is the persisted Fast Mode flag. `write_enabled` may be true
    for allowlisted accounts even when reads are off. Returns all-false on any
    error (degrade to no-cache).
    """
    if agent_id in _AGENT_FASTMODE:
        return _AGENT_FASTMODE[agent_id]
    enabled, goal, write_enabled, root_agent_id = False, None, False, None
    try:
        api_url, api_key = _backend()
        # Dedicated internal endpoint (API-key auth, no RLS) — the agent serializer
        # doesn't expose fastModeCacheEnabled and GET /agents needs an X-User-Id.
        resp = await _shared_client().post(
            f"{api_url}/api/fast-cache/agent-flag",
            headers=backend_api_headers(api_key),
            json={"agentId": agent_id},
            timeout=_GET_TIMEOUT_S,
        )
        if resp.status_code == 200:
            data = resp.json()
            enabled = bool(data.get("enabled"))
            goal = data.get("goal")
            write_enabled = bool(data.get("writeEnabled", enabled))
            root_agent_id = data.get("rootAgentId") if isinstance(data.get("rootAgentId"), str) else agent_id
        else:
            logger.warning("fast_cache.resolve_agent_failed", agent_id=agent_id, status=resp.status_code)
    except Exception as exc:
        logger.warning("fast_cache.resolve_agent_error", agent_id=agent_id, error=str(exc))
    # Only memoize a positive resolution — a transient failure shouldn't disable
    # the cache for the rest of the run.
    if goal and (enabled or write_enabled):
        _AGENT_FASTMODE[agent_id] = (enabled, goal, write_enabled, root_agent_id)
    return enabled, goal, write_enabled, root_agent_id


async def resolve_archive_root_agent_id() -> Optional[str]:
    root_agent_id = current_root_agent_id()
    agent_id = structlog.contextvars.get_contextvars().get("agent_id")
    if isinstance(agent_id, str):
        try:
            _enabled, _goal, _write_enabled, resolved_root = await resolve_agent_fast_mode(agent_id)
            if resolved_root:
                return resolved_root
        except Exception as exc:  # archive best-effort path
            logger.warning("fast_cache.resolve_archive_root_error", agent_id=agent_id, error=str(exc)[:200])
    return root_agent_id


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
    enabled, resolved_goal, write_enabled, _root_agent_id = await resolve_agent_fast_mode(agent_id)
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
    enabled, goal, write_enabled, _root_agent_id = await resolve_agent_fast_mode(agent_id)
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
    sanitized_value = normalize.strip_secrets(value)
    await _archive_cache_write(key, kind, goal_hash, sanitized_value, blob_path)
    try:
        api_url, api_key = _backend()
        resp = await _shared_client().post(
            f"{api_url}/api/fast-cache/set",
            headers=backend_api_headers(api_key),
            json={
                "key": key,
                "kind": kind,
                "goalHash": goal_hash,
                "value": sanitized_value,
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


# browser_http cache ops fire once per page SUBRESOURCE (images, scripts, css) —
# thousands per browser session. Archiving each one floods the backend archive
# endpoint (observed: 5.5k queued artifacts saturating the Node event loop).
# Browser-level state is already archived via recordings + transitions, and
# cache-replayed observations are deduped out of the WMH corpus anyway, so these
# artifacts carry no corpus signal worth that cost.
_ARCHIVE_SKIPPED_KINDS = ("browser_http",)


def _archive_skipped(key: str, kind: Optional[str] = None) -> bool:
    if kind in _ARCHIVE_SKIPPED_KINDS:
        return True
    return any(f":{skipped}:" in key for skipped in _ARCHIVE_SKIPPED_KINDS)


async def _archive_cache_write(
    key: str,
    kind: str,
    goal_hash: str,
    value: Any,
    blob_path: Optional[str],
) -> None:
    try:
        if _archive_skipped(key, kind):
            return
        root_agent_id = await resolve_archive_root_agent_id()
        if not root_agent_id:
            return
        key_hash = hashlib.sha256(key.encode("utf-8")).hexdigest()

        span_id = current_span_id()

        def payload() -> dict[str, Any]:
            return {
                "key": key,
                "kind": kind,
                "goal_hash": goal_hash,
                "span_id": span_id,
                "blob_path": blob_path,
                "value": value,
            }

        archive_json_deferred(
            root_agent_id=root_agent_id,
            path=f"provider/fast-cache/{kind}/{key_hash}.json.gz.enc",
            payload_factory=payload,
        )
    except Exception as exc:  # cache/archive must never break provider calls
        logger.warning("fast_cache.archive_error", key=key, kind=kind, error=str(exc)[:200])


async def _archive_cache_read(
    key: str,
    *,
    hit: bool,
    value: Any,
    blob_path: Optional[str],
    status: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    try:
        if _archive_skipped(key):
            return
        root_agent_id = await resolve_archive_root_agent_id()
        if not root_agent_id:
            return
        key_hash = hashlib.sha256(key.encode("utf-8")).hexdigest()
        span_id = current_span_id()

        def payload() -> dict[str, Any]:
            sanitized_value = normalize.strip_secrets(value)
            return {
                "key": key,
                "key_hash": key_hash,
                "operation": "read",
                "hit": hit,
                "status": status,
                "error": error,
                "span_id": span_id,
                "blob_path": blob_path,
                "value": sanitized_value,
            }

        archive_json_deferred(
            root_agent_id=root_agent_id,
            path=f"provider/fast-cache/read/{key_hash}.{int(time.time() * 1000)}.json.gz.enc",
            payload_factory=payload,
        )
    except Exception as exc:  # cache/archive must never break provider calls
        logger.warning("fast_cache.archive_read_error", key=key, error=str(exc)[:200])


def _archive_read_limiter() -> asyncio.Semaphore:
    global _archive_read_semaphore, _archive_read_semaphore_loop

    loop = asyncio.get_running_loop()
    if _archive_read_semaphore is None or _archive_read_semaphore_loop is not loop:
        _archive_read_semaphore = asyncio.Semaphore(_ARCHIVE_READ_MAX_CONCURRENCY)
        _archive_read_semaphore_loop = loop
    return _archive_read_semaphore


async def _archive_cache_read_limited(
    key: str,
    *,
    hit: bool,
    value: Any,
    blob_path: Optional[str],
    status: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    async with _archive_read_limiter():
        await _archive_cache_read(
            key,
            hit=hit,
            value=value,
            blob_path=blob_path,
            status=status,
            error=error,
        )


def _queue_archive_cache_read(
    key: str,
    *,
    hit: bool,
    value: Any,
    blob_path: Optional[str],
    status: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    """Archive fast-cache read evidence without blocking cache replay.

    A read archive is diagnostic side work. Waiting for it on a cache hit makes
    a replay depend on archive/root-resolution IO even though the cached value is
    already available. Keep a strong task reference so the enqueue has a chance
    to complete, and log failures from the task callback.
    """
    task = asyncio.create_task(
        _archive_cache_read_limited(
            key,
            hit=hit,
            value=value,
            blob_path=blob_path,
            status=status,
            error=error,
        )
    )
    _archive_read_tasks.add(task)

    def _on_done(done: asyncio.Task[None]) -> None:
        _archive_read_tasks.discard(done)
        try:
            done.result()
        except Exception as exc:  # archive must never break cache callers
            logger.warning("fast_cache.archive_read_task_error", key=key, error=str(exc)[:200])

    task.add_done_callback(_on_done)
