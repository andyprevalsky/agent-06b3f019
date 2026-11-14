"""DEMO cache — backend HTTP client.

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
from .context import demo_recording_enabled, owned_recording_namespace
from .env import demo_cache_env
from providers.rose.speed import normalize_agent_speed

logger = structlog.get_logger(__name__)

_GET_TIMEOUT_S = 15.0
# A failed GET is conceded as a cache MISS, which sends the caller to an EXPENSIVE
# live LLM call. Under a fan-out the backend demo-cache endpoint 500s from DB-pool
# pressure, so retry the cheap GET a few times before conceding — a retry costs
# milliseconds; a false miss costs a full live model call.
_GET_MAX_ATTEMPTS = 3
_GET_RETRY_BACKOFF_S = 0.15
_SET_TIMEOUT_S = 30.0
_GET_BATCH_DELAY_S = 0.005
_GET_BATCH_MAX_KEYS = 500
_GET_BATCH_MAX_IN_FLIGHT = int(demo_cache_env("DEMO_CACHE_GET_BATCH_MAX_IN_FLIGHT", "16") or "16")
_HTTP_MAX_CONNECTIONS = int(demo_cache_env("DEMO_CACHE_HTTP_MAX_CONNECTIONS", "80") or "80")
_HTTP_MAX_KEEPALIVE_CONNECTIONS = int(demo_cache_env("DEMO_CACHE_HTTP_MAX_KEEPALIVE_CONNECTIONS", "40") or "40")
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
# get-position is a SQL LIKE per (goalHash, callSite, step). Fifty July GPs
# replaying the same Huberman-class namespace were paying that RTT on every
# inner explore/execute turn (~31 serial lookups × ~384ms). Memoize the
# durable slot across the worker process so sibling agents share one fetch,
# and slide a small prefetch window so the next steps are already local.
_POSITION_MEMO_TTL_S = 1800.0
_POSITION_PREFETCH_AHEAD = 8
_POSITION_HTTP_MAX_IN_FLIGHT = int(demo_cache_env("DEMO_CACHE_POSITION_MAX_IN_FLIGHT", "16") or "16")
_position_memo: dict[tuple[str, str, int], tuple[Optional[Any], Optional[str], float]] = {}
_position_inflight: dict[tuple[str, str, int], asyncio.Future[tuple[Optional[Any], Optional[str]]]] = {}
_position_http_sem: Optional[asyncio.Semaphore] = None
_position_http_sem_loop: Optional[asyncio.AbstractEventLoop] = None


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
    if owned_recording_namespace() is not None:
        return {"hit": False, "value": None, "blobPath": None}
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
            "demo_cache.prefetch_hit",
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
        logger.warning("demo_cache.get_failed", key=key, status=last_status, attempts=_GET_MAX_ATTEMPTS)
    else:
        logger.warning("demo_cache.get_error", key=key, error=(last_error or "")[:300], attempts=_GET_MAX_ATTEMPTS)
    _queue_archive_cache_read(key, hit=False, value=None, blob_path=None, status=last_status, error=last_error)
    return {"hit": False, "value": None, "blobPath": None}


async def _cache_get_record_direct(key: str) -> tuple[CacheRecord, Optional[int]]:
    if owned_recording_namespace() is not None:
        return ({"hit": False, "value": None, "blobPath": None}, 200)
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
    if owned_recording_namespace() is not None:
        return {"hit": False, "value": None, "blobPath": None}
    global _pending_gets_flush_task

    loop = asyncio.get_running_loop()
    future: asyncio.Future[CacheRecord] = loop.create_future()
    started = time.monotonic()
    async with _pending_lock():
        _pending_gets.setdefault(key, []).append((future, started))
        if _pending_gets_flush_task is None or _pending_gets_flush_task.done():
            _pending_gets_flush_task = asyncio.create_task(_flush_pending_gets())
    async with span(
        "demo_cache.cache_get_wait",
        cache_key_hash=_key_hash(key),
        cache_key_kind=_key_kind(key),
        max_in_flight=_GET_BATCH_MAX_IN_FLIGHT,
    ):
        record = await future
    logger.info(
        "demo_cache.cache_get_timing",
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
        done_tasks = [task for task in list(_pending_gets_batch_tasks) if task.done()]
        _pending_gets_batch_tasks.difference_update(done_tasks)
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
                logger.warning("demo_cache.get_many_batch_task_error", error=str(exc)[:200])

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
            "demo_cache.get_many.http",
            key_count=len(keys),
            waiter_count=waiter_count,
            queue_wait_avg_ms=queue_avg_ms,
            queue_wait_max_ms=queue_max_ms,
            max_in_flight=_GET_BATCH_MAX_IN_FLIGHT,
        ):
            records = await _fetch_cache_records_many(keys)
        logger.info(
            "demo_cache.get_many_batch",
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
    if owned_recording_namespace() is not None:
        return {key: {"hit": False, "value": None, "blobPath": None} for key in keys}
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
        raise RuntimeError(f"demo-cache get-many failed: {resp.status_code}")
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
    """Fetch exact demo-cache keys now so immediate tool handlers can consume them.

    This is intentionally one-shot and short-lived: it is not a durable Python LRU,
    so purge/write semantics still belong to the backend demo-cache store.
    """
    if owned_recording_namespace() is not None:
        return
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
            "demo_cache.prefetch",
            key_count=len(unique_keys),
            reason=reason,
        ):
            records = await _fetch_cache_records_many(unique_keys)
    except Exception as exc:
        logger.warning(
            "demo_cache.prefetch_error",
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
        "demo_cache.prefetch_done",
        key_count=len(unique_keys),
        hit_count=hit_count,
        reason=reason,
    )


async def cache_get(key: str) -> Optional[Any]:
    """Return the cached value for `key`, or None on miss / any error."""
    record = await cache_get_record(key)
    return record.get("value") if record.get("hit") else None


async def cache_get_first(keys: list[str]) -> tuple[Optional[Any], Optional[str]]:
    """Return `(value, hit_key)` for the first hitting key in `keys`, else `(None, None)`."""
    if owned_recording_namespace() is not None:
        return None, None
    ordered: list[str] = []
    seen: set[str] = set()
    for key in keys:
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    if not ordered:
        return None, None
    if len(ordered) == 1:
        value = await cache_get(ordered[0])
        return (value, ordered[0]) if value is not None else (None, None)

    # Prefer get-many so alias lookups stay one RTT; fall back to serial gets.
    try:
        records = await _fetch_cache_records_many(ordered)
        for key in ordered:
            record = records.get(key) or {}
            if record.get("hit") and record.get("value") is not None:
                return record.get("value"), key
        return None, None
    except _BatchUnsupported:
        for key in ordered:
            value = await cache_get(key)
            if value is not None:
                return value, key
        return None, None
    except Exception as exc:
        # Transport / 5xx after get-many: try serial, but if every key still
        # misses, re-raise so callers set lookup_failed and skip passthroughs.
        for key in ordered:
            try:
                value = await cache_get(key)
            except Exception:
                continue
            if value is not None:
                return value, key
        raise RuntimeError(f"demo-cache get-first failed: {exc}") from exc


def _position_memo_key(goal_hash: str, call_site: str, step: int) -> tuple[str, str, int]:
    return (goal_hash, (call_site or "").strip(), int(step))


def _position_http_semaphore() -> asyncio.Semaphore:
    global _position_http_sem, _position_http_sem_loop
    loop = asyncio.get_running_loop()
    if _position_http_sem is None or _position_http_sem_loop is not loop:
        _position_http_sem = asyncio.Semaphore(_POSITION_HTTP_MAX_IN_FLIGHT)
        _position_http_sem_loop = loop
    return _position_http_sem


def _position_memo_get(goal_hash: str, call_site: str, step: int) -> Optional[tuple[Optional[Any], Optional[str]]]:
    entry = _position_memo.get(_position_memo_key(goal_hash, call_site, step))
    if entry is None:
        return None
    value, key, expires_at = entry
    if expires_at <= time.monotonic():
        _position_memo.pop(_position_memo_key(goal_hash, call_site, step), None)
        return None
    return value, key


def _position_memo_put(
    goal_hash: str,
    call_site: str,
    step: int,
    value: Optional[Any],
    key: Optional[str],
) -> None:
    _position_memo[_position_memo_key(goal_hash, call_site, step)] = (
        value,
        key,
        time.monotonic() + _POSITION_MEMO_TTL_S,
    )


def clear_position_memo() -> None:
    """Test helper: drop process-local get-position memo + in-flight waits."""
    _position_memo.clear()
    _position_inflight.clear()


def _schedule_position_prefetch(goal_hash: str, call_site: str, step: int) -> None:
    """Fill the next few durable slots without blocking the current lookup."""
    if owned_recording_namespace() is not None:
        return
    ahead = [
        current
        for current in range(int(step) + 1, int(step) + 1 + _POSITION_PREFETCH_AHEAD)
        if _position_memo_get(goal_hash, call_site, current) is None
        and _position_memo_key(goal_hash, call_site, current) not in _position_inflight
    ]
    if not ahead:
        return

    async def _prefetch() -> None:
        await asyncio.gather(
            *[_fetch_position_http(goal_hash, call_site, current) for current in ahead],
            return_exceptions=True,
        )

    try:
        asyncio.get_running_loop().create_task(_prefetch())
    except RuntimeError:
        return


async def _fetch_position_http(
    goal_hash: str,
    call_site: str,
    step: int,
) -> tuple[Optional[Any], Optional[str]]:
    """One get-position HTTP, single-flighted and memoized per durable slot.

    The HTTP round-trip runs in its own task that no caller owns. Every caller
    (the first one included) awaits it through ``asyncio.shield`` so one
    consumer's cancellation can never reach the shared fetch or its other
    waiters. Without the shield, ``asyncio.wait_for`` cancelling a waiter
    cancelled the shared future itself: the owner then hit
    ``InvalidStateError`` on ``set_result`` and every later caller for that
    slot raised ``CancelledError`` — a BaseException that escaped the
    ``except Exception`` retry ladders in ``lookup_llm_cache`` and
    ``call_temporal_activity_from_activity``, failed the whole explore
    activity, and surfaced as a ``spawn_agent`` ERROR chip (RCA
    2026-10-02, test-mass-agent-run-0). Conversely a cancelled owner used to
    leave its waiters on a future nobody would ever resolve.
    """
    if owned_recording_namespace() is not None:
        return None, None
    memo_key = _position_memo_key(goal_hash, call_site, step)
    cached = _position_memo_get(goal_hash, call_site, step)
    if cached is not None:
        return cached
    fetch = _position_inflight.get(memo_key)
    if fetch is None:
        fetch = asyncio.get_running_loop().create_task(_fetch_position_http_once(goal_hash, call_site, step))
        _position_inflight[memo_key] = fetch

        def _on_done(done: asyncio.Task[tuple[Optional[Any], Optional[str]]]) -> None:
            if _position_inflight.get(memo_key) is done:
                _position_inflight.pop(memo_key, None)
            if not done.cancelled():
                # Every live waiter re-raises this; mark it retrieved so an
                # abandoned fetch does not log "exception was never retrieved".
                done.exception()

        fetch.add_done_callback(_on_done)
    return await asyncio.shield(fetch)


async def _fetch_position_http_once(
    goal_hash: str,
    call_site: str,
    step: int,
) -> tuple[Optional[Any], Optional[str]]:
    """The single shared get-position round-trip behind ``_fetch_position_http``."""
    if owned_recording_namespace() is not None:
        return None, None
    api_url, api_key = _backend()
    body: dict[str, Any] = {"goalHash": goal_hash, "callSite": call_site, "step": int(step)}
    last_error: Optional[Exception] = None
    for attempt in range(_GET_MAX_ATTEMPTS):
        async with _position_http_semaphore():
            cached = _position_memo_get(goal_hash, call_site, step)
            if cached is not None:
                return cached
            try:
                resp = await _shared_client().post(
                    f"{api_url}/api/fast-cache/get-position",
                    headers=backend_api_headers(api_key),
                    json=body,
                    timeout=_GET_TIMEOUT_S,
                )
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "demo_cache.get_position_error",
                    error=f"{type(exc).__name__}: {exc}"[:300],
                    attempt=attempt + 1,
                )
                resp = None
        if resp is None:
            if attempt < _GET_MAX_ATTEMPTS - 1:
                await asyncio.sleep(_GET_RETRY_BACKOFF_S * (attempt + 1))
                continue
            if last_error is not None:
                raise last_error
            raise RuntimeError("demo-cache get-position failed after retries")
        if resp.status_code != 200:
            if resp.status_code in {404, 405}:
                _position_memo_put(goal_hash, call_site, step, None, None)
                return (None, None)
            logger.warning(
                "demo_cache.get_position_failed",
                status=resp.status_code,
                attempt=attempt + 1,
            )
            if resp.status_code >= 500 and attempt < _GET_MAX_ATTEMPTS - 1:
                await asyncio.sleep(_GET_RETRY_BACKOFF_S * (attempt + 1))
                continue
            raise RuntimeError(f"demo-cache get-position failed: {resp.status_code}")
        data = resp.json()
        if not data.get("hit"):
            result: tuple[Optional[Any], Optional[str]] = (None, None)
        else:
            result = (data.get("value"), data.get("key"))
        _position_memo_put(goal_hash, call_site, step, result[0], result[1])
        return result
    if last_error is not None:
        raise last_error
    raise RuntimeError("demo-cache get-position failed after retries")


async def cache_get_position_fallback(
    goal_hash: str,
    call_site: str,
    step: Optional[int] = None,
) -> tuple[Optional[Any], Optional[str]]:
    """Oldest matching entry for goal/site/step when exact keys miss.

    Restores the Jul 2026 OAi demo warm cache after fingerprint drift: prefer the
    earliest row under that durable trajectory slot (the original warm write).

    When ``step is None`` (content-addressed contexts), return a miss — the
    backend position query does not compare the request fingerprint, so a
    fallback would replay another request's value for the same call site.
    Transport / non-404 errors raise so callers can set ``lookup_failed`` and
    skip synthetic passthroughs.

    Hits (and clean misses) are memoized on the worker so 50-way Fast Mode
    fan-out does not re-query the same July slot. The next few steps are
    prefetched in the background so the sequential explore/execute loop
    does not serialize on HTTP.
    """
    if owned_recording_namespace() is not None:
        return None, None
    if step is None:
        return None, None
    current = int(step)
    cached = _position_memo_get(goal_hash, call_site, current)
    if cached is not None:
        _schedule_position_prefetch(goal_hash, call_site, current)
        return cached
    result = await _fetch_position_http(goal_hash, call_site, current)
    _schedule_position_prefetch(goal_hash, call_site, current)
    return result


async def trajectory_prior_exists(
    goal_hash: str,
    call_site: str,
    step: Optional[int],
) -> bool:
    """True when an earlier durable slot exists for this goal/site.

    Soft-complete is only valid at true end-of-trajectory (warm namespace ran
    out of rows). Cold namespaces (no prior slot) must not soft-complete —
    that fakes hits and diverges from July replay.
    """
    if owned_recording_namespace() is not None:
        return False
    if not goal_hash or step is None or int(step) <= 0:
        return False
    try:
        prior, _ = await cache_get_position_fallback(goal_hash, call_site, int(step) - 1)
    except Exception:
        return False
    return prior is not None


# Per-process memo of
# (read_enabled, goal, write_enabled, root_agent_id, root_goal, provider_fast_mode)
# keyed by agent_id, so auto-resolution costs at most one backend lookup per agent
# per worker process.
_AGENT_FASTMODE: dict[str, tuple[bool, Optional[str], bool, Optional[str], Optional[str], bool]] = {}
# Per-process memo of the agent's provider speed (Agent.speed), filled by the
# same one lookup. Speed never gates a cache; it only reaches provider legs.
_AGENT_SPEED: dict[str, str] = {}


async def resolve_agent_fast_mode(
    agent_id: str,
    *,
    refresh: bool = False,
) -> tuple[bool, Optional[str], bool, Optional[str], Optional[str], bool]:
    """Look up (read_enabled, goal, write_enabled, root_agent_id, root_goal, provider_fast_mode).

    `read_enabled` is DEMO-prompt cache replay (independent of the Fast Mode
    button). `provider_fast_mode` is the button / LLM speed flag persisted on
    the agent row. `write_enabled` follows demo cache (DEMO trees record+replay).
    Returns all-false on any error (degrade to no-cache / provider default).

    `refresh=True` re-reads the agent row and replaces this process's memo. A
    workflow run start uses it: a wake or chat follow-up persists a new
    Agent.goal for the same agent id, so a memo from the previous run is stale.
    """
    if refresh:
        _AGENT_FASTMODE.pop(agent_id, None)
        _AGENT_SPEED.pop(agent_id, None)
    elif agent_id in _AGENT_FASTMODE:
        cached = _AGENT_FASTMODE[agent_id]
        return (False, *cached[1:]) if owned_recording_namespace() is not None else cached
    enabled, goal, write_enabled, root_agent_id, root_goal = False, None, False, None, None
    provider_fast_mode = True
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
            root_goal_raw = data.get("rootGoal")
            root_goal = root_goal_raw if isinstance(root_goal_raw, str) and root_goal_raw else goal
            if "providerFastMode" in data:
                provider_fast_mode = bool(data.get("providerFastMode"))
            else:
                # Legacy responses: button lived on the same flag as cache.
                provider_fast_mode = bool(data.get("enabled", True))
            # A backend that predates Agent.speed sends only the legacy button.
            _AGENT_SPEED[agent_id] = normalize_agent_speed(data.get("speed", provider_fast_mode))
        else:
            logger.warning("demo_cache.resolve_agent_failed", agent_id=agent_id, status=resp.status_code)
    except Exception as exc:
        logger.warning("demo_cache.resolve_agent_error", agent_id=agent_id, error=str(exc))
    # Only memoize a positive resolution — a transient failure shouldn't disable
    # the cache for the rest of the run.
    if goal and (enabled or write_enabled):
        _AGENT_FASTMODE[agent_id] = (
            enabled,
            goal,
            write_enabled,
            root_agent_id,
            root_goal,
            provider_fast_mode,
        )
    elif goal:
        # Still memoize provider_fast_mode for non-demo agents so LLM speed
        # respects the button without re-fetching every call.
        _AGENT_FASTMODE[agent_id] = (
            enabled,
            goal,
            write_enabled,
            root_agent_id,
            root_goal,
            provider_fast_mode,
        )
    return (False if owned_recording_namespace() is not None else enabled), goal, write_enabled, root_agent_id, root_goal, provider_fast_mode


async def soft_complete_allowed_for_agent(
    agent_id: Optional[str],
    goal: Optional[str] = None,
) -> bool:
    """True when soft-complete stubs may fire for this agent (exact bench match).

    Resolves the tree root goal when needed so for_each children under
    ``test-mass-agent-run-0`` inherit stub eligibility.
    """
    if owned_recording_namespace() is not None:
        return False
    if normalize.soft_complete_allowed(goal):
        return True
    if not agent_id:
        return False
    _enabled, resolved_goal, _write_enabled, _root_id, root_goal, _pfm = await resolve_agent_fast_mode(agent_id)
    return normalize.soft_complete_allowed(goal or resolved_goal, root_goal=root_goal)


async def resolve_soft_complete_root_goal(
    agent_id: Optional[str],
    goal: Optional[str] = None,
) -> Optional[str]:
    """Return the tree-root goal used to gate soft-complete stubs."""
    if not agent_id:
        return goal
    try:
        _e, resolved_goal, _w, _r, root_goal, _pfm = await resolve_agent_fast_mode(agent_id)
        return root_goal or goal or resolved_goal
    except Exception:
        return goal


async def resolve_archive_root_agent_id() -> Optional[str]:
    root_agent_id = current_root_agent_id()
    agent_id = structlog.contextvars.get_contextvars().get("agent_id")
    if isinstance(agent_id, str):
        try:
            _enabled, _goal, _write_enabled, resolved_root, _root_goal, _pfm = await resolve_agent_fast_mode(agent_id)
            if resolved_root:
                return resolved_root
        except Exception as exc:  # archive best-effort path
            logger.warning("demo_cache.resolve_archive_root_error", agent_id=agent_id, error=str(exc)[:200])
    return root_agent_id


async def ensure_context(agent_id: Optional[str], goal: Optional[str] = None):
    """Ensure a DemoCacheContext is set for the current activity. No-op if one is
    already enabled. Otherwise auto-resolves (enabled, goal) from the agent row.
    One line at an activity's entry makes every LLM call inside it cache-aware —
    no signature threading."""
    from .context import DemoCacheContext, current_context, set_context

    existing = current_context()
    if existing is not None and existing.active:
        return existing
    if not agent_id:
        return existing
    (
        enabled,
        resolved_goal,
        write_enabled,
        _root_agent_id,
        root_goal,
        provider_fast_mode,
    ) = await resolve_agent_fast_mode(agent_id)
    g = goal or resolved_goal
    if g and (enabled or write_enabled):
        ctx = DemoCacheContext(
            enabled=enabled,
            goal=g,
            write_enabled=write_enabled,
            root_goal=root_goal or g,
            provider_fast_mode=provider_fast_mode,
        )
        set_context(ctx)
        return ctx
    return existing


async def ensure_position_context(agent_id: Optional[str], step: int):
    """Compatibility wrapper for old callers.

    Main agent loop/verifier calls have a durable step. Use it for replay so live
    tool-result IDs and timing do not bust cache hits, while the static request
    fingerprint still invalidates prompt/schema/config changes.
    """
    from .context import DemoCacheContext, set_context

    if not agent_id:
        return None
    enabled, goal, write_enabled, _root_agent_id, root_goal, provider_fast_mode = await resolve_agent_fast_mode(
        agent_id
    )
    if goal and (enabled or write_enabled):
        ctx = DemoCacheContext(
            enabled=enabled,
            goal=goal,
            base_step=step,
            write_enabled=write_enabled,
            root_goal=root_goal or goal,
            provider_fast_mode=provider_fast_mode,
        )
        set_context(ctx)
        return ctx
    return None


async def resolve_agent_speed(agent_id: Optional[str]) -> str:
    """Provider speed for an agent's LLM calls; standard without an agent or on error.

    One memoized backend read per agent per process (the agent-flag lookup that
    already resolves the DEMO cache context), never one per LLM call.
    """
    if not agent_id:
        return "standard"
    if agent_id in _AGENT_SPEED:
        return _AGENT_SPEED[agent_id]
    try:
        await resolve_agent_fast_mode(agent_id)
    except Exception:
        return "standard"
    return _AGENT_SPEED.get(agent_id, "standard")


async def resolve_provider_fast_mode(agent_id: Optional[str]) -> bool:
    """Resolve the Fast Mode button (LLM speed) for an agent. Defaults True."""
    if not agent_id:
        return True
    try:
        _e, _g, _w, _r, _rg, provider_fast_mode = await resolve_agent_fast_mode(agent_id)
        return bool(provider_fast_mode)
    except Exception:
        return True


def cache_write_allowed(goal_hash: str, *, goal: Optional[str] = None, root_goal: Optional[str] = None) -> bool:
    """False for a DEMO replay namespace unless a deliberate re-recording is enabled.

    World-model simulation keys carry their own scope, so a DEMO goal's cold
    simulation miss writes through to that isolated namespace without touching
    the frozen real-run recording.
    """
    owned_recording_namespace()  # Validate an explicit owner even on direct write-only calls.
    frozen_demo_hash = not normalize.world_model_cache_scope() and goal_hash in normalize.demo_cache_goal_hashes()
    demo_namespace = frozen_demo_hash or normalize.soft_complete_allowed(goal, root_goal=root_goal)
    return not demo_namespace or demo_recording_enabled()


async def cache_write_decision_for_agent(agent_id: Optional[str], goal: Optional[str]) -> Optional[bool]:
    """Write-only tool gate: True/False once decided, None while the tree root is unresolved."""
    if not cache_write_allowed(normalize.goal_hash(goal or ""), goal=goal):
        return False
    if demo_recording_enabled() or not agent_id:
        return True
    _enabled, resolved_goal, _write_enabled, _root_id, root_goal, _pfm = await resolve_agent_fast_mode(agent_id)
    if not resolved_goal:
        # An unresolved tree root may be a frozen DEMO recording; losing one
        # write-through entry is safer than poisoning a replay namespace.
        logger.info("demo_cache.write_skipped_unresolved_agent", agent_id=agent_id)
        return None
    return not normalize.soft_complete_allowed(goal or resolved_goal, root_goal=root_goal)


async def cache_write_allowed_for_agent(agent_id: Optional[str], goal: Optional[str]) -> bool:
    """Write-only tool gate: the goal and the agent's resolved tree root must both be writable."""
    return await cache_write_decision_for_agent(agent_id, goal) is True


async def cache_set(
    key: str,
    kind: str,
    goal_hash: str,
    value: Any,
    blob_path: Optional[str] = None,
    *,
    goal: Optional[str] = None,
    root_goal: Optional[str] = None,
) -> bool:
    """Write `value` under `key`. Last write wins. Never raises."""
    if not cache_write_allowed(goal_hash, goal=goal, root_goal=root_goal):
        # DEMO replay namespaces are frozen recordings (DEMO_CACHE_RECORD_DEMO=1 re-records).
        logger.info("demo_cache.set_skipped_demo_namespace", key=key)
        return False
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
            logger.warning("demo_cache.set_failed", key=key, status=resp.status_code)
            return False
        return resp.json().get("stored") is True
    except Exception as exc:
        logger.warning("demo_cache.set_error", key=key, error=str(exc))
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
        logger.warning("demo_cache.archive_error", key=key, kind=kind, error=str(exc)[:200])


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
        logger.warning("demo_cache.archive_read_error", key=key, error=str(exc)[:200])


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
    """Archive demo-cache read evidence without blocking cache replay.

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
            logger.warning("demo_cache.archive_read_task_error", key=key, error=str(exc)[:200])

    task.add_done_callback(_on_done)
