"""Latest provider usage-window snapshot per subscription token.

Claude and Codex report how much of the account's 5-hour and 7-day windows a
token has used on every response (headers) — successes AND failures (429/403
carry the same headers, plus the rejected window). We record the latest
snapshot per token here and the existing lineage heartbeat
(`helpers/llm.py:heartbeat_compute_token_lineage_activity`) carries it to the
backend, so the compute screen's per-account usage bars stay current without
any extra provider roundtrip.

Delivery
--------
    response headers ──observe()──► _snapshots[fingerprint]
                      └─flush(auth)──► asyncio task: auth.heartbeat_lease(auth)
                                        (pops via take(), 5 s timeout, never raises)

The client also heartbeats before each attempt (lease keep-alive), which
carries whatever is still unsent. `flush` runs right after each response so the
last snapshot of a lease and every failure snapshot (the token is about to be
rotated away and would never heartbeat again) are delivered too. Success
snapshots are flushed at most once per FLUSH_MIN_INTERVAL_S per token (the
backend stores at most one per 15 s per account anyway); failure snapshots are
flushed immediately.

Snapshot shape (the heartbeat body's `usage`):
    {observedAt, fiveHour?, sevenDay?: {usedPct 0-100, resetsAt ISO|None},
     source: "response"|"rate_limit"|"code_session", status: "allowed"|
     "allowed_warning"|"rejected"|None}

Absent information is never turned into zero quota: a response without usage
headers records nothing, and a rejected window is only set to 100% used when
the provider names it.

Snapshots are keyed by a credential fingerprint (never the token), popped when
sent, and bounded so the store holds at 10k concurrent agents.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Mapping, Optional, Set

UsageWindow = Dict[str, Any]
UsageSnapshot = Dict[str, Any]

MAX_TRACKED_TOKENS = 1024
# Matches the backend's per-account write throttle (USAGE_WRITE_MIN_INTERVAL_MS).
FLUSH_MIN_INTERVAL_S = 15.0
FLUSH_TIMEOUT_S = 5.0
# How long a rejected-window observation names the reason of the cooldown that
# follows it (the mark is reported a few hundred ms after the response).
_LIMIT_REASON_TTL_S = 120.0

# Codex reports each window's length; anything at most this long is the
# short (5h) window, anything at least this long is the weekly one.
_FIVE_HOUR_MAX_MINUTES = 6 * 60
_SEVEN_DAY_MIN_MINUTES = 6 * 24 * 60

_STATUSES = ("allowed", "allowed_warning", "rejected")
_CLAIM_WINDOWS = {"five_hour": "fiveHour", "5h": "fiveHour", "seven_day": "sevenDay", "7d": "sevenDay"}
_WINDOW_REASONS = {"fiveHour": "usage_window_5h", "sevenDay": "usage_window_7d"}

_lock = threading.Lock()
_snapshots: "OrderedDict[str, UsageSnapshot]" = OrderedDict()
_last_flush: "OrderedDict[str, float]" = OrderedDict()
_limit_reasons: "OrderedDict[str, tuple[str, float]]" = OrderedDict()
# Strong refs so in-flight flush tasks are not garbage-collected mid-send.
_pending: Set["asyncio.Task[Any]"] = set()


def token_fingerprint(token: str) -> str:
    """Same digest as `helpers.llm.credential_fingerprint`; the token is never stored."""
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def _format_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
    else:
        try:
            parsed = float(str(value).strip())
        except ValueError:
            return None
    return parsed if math.isfinite(parsed) else None


def _parse_epoch(value: Any) -> Optional[str]:
    parsed = _parse_float(value)
    if parsed is None:
        return None
    epoch = parsed / 1000 if parsed > 10_000_000_000 else parsed
    if epoch < 1_000_000_000:
        return None
    return _format_utc(datetime.fromtimestamp(epoch, tz=timezone.utc))


def _window(used_pct: Optional[float], resets_at: Optional[str]) -> Optional[UsageWindow]:
    if used_pct is None:
        return None
    return {"usedPct": round(min(100.0, max(0.0, used_pct)), 2), "resetsAt": resets_at}


def _bump_bounded(store: "OrderedDict[str, Any]", key: str, value: Any) -> None:
    store[key] = value
    store.move_to_end(key)
    while len(store) > MAX_TRACKED_TOKENS:
        store.popitem(last=False)


def _claude_windows(headers: Mapping[str, str]) -> Dict[str, Optional[UsageWindow]]:
    def window(key: str) -> Optional[UsageWindow]:
        utilization = _parse_float(headers.get(f"anthropic-ratelimit-unified-{key}-utilization"))
        return _window(
            None if utilization is None else utilization * 100,
            _parse_epoch(headers.get(f"anthropic-ratelimit-unified-{key}-reset")),
        )

    return {"fiveHour": window("5h"), "sevenDay": window("7d")}


def _claude_rejected_window(headers: Mapping[str, str], windows: Dict[str, Optional[UsageWindow]]) -> Optional[str]:
    """The window a `rejected` unified status names, marked 100% used in place."""
    claim = (headers.get("anthropic-ratelimit-unified-representative-claim") or "").strip().lower()
    key = _CLAIM_WINDOWS.get(claim)
    if key is None:
        exhausted = [k for k, w in windows.items() if w is not None and w["usedPct"] >= 100]
        key = exhausted[0] if len(exhausted) == 1 else None
    if key is None:
        return None
    current = windows.get(key)
    resets_at = (current or {}).get("resetsAt") or _parse_epoch(headers.get("anthropic-ratelimit-unified-reset"))
    windows[key] = {"usedPct": 100.0, "resetsAt": resets_at}
    return key


def _codex_windows(headers: Mapping[str, str], now: datetime) -> Dict[str, Optional[UsageWindow]]:
    windows: Dict[str, Optional[UsageWindow]] = {"fiveHour": None, "sevenDay": None}
    for slot, default_key in (("primary", "fiveHour"), ("secondary", "sevenDay")):
        prefix = f"x-codex-{slot}"
        resets_at = _parse_epoch(headers.get(f"{prefix}-reset-at"))
        if resets_at is None:
            after = _parse_float(headers.get(f"{prefix}-reset-after-seconds"))
            if after is not None and after >= 0:
                resets_at = _format_utc(now + timedelta(seconds=after))
        window = _window(_parse_float(headers.get(f"{prefix}-used-percent")), resets_at)
        if window is None:
            continue
        minutes = _parse_float(headers.get(f"{prefix}-window-minutes"))
        if minutes is None:
            key: Optional[str] = default_key
        elif minutes <= _FIVE_HOUR_MAX_MINUTES:
            key = "fiveHour"
        elif minutes >= _SEVEN_DAY_MIN_MINUTES:
            key = "sevenDay"
        else:
            key = None
        if key is not None:
            windows[key] = window
    return windows


def _codex_limit_reset(body: Optional[str], now: datetime) -> Optional[str]:
    """`resets_at` of a Codex `usage_limit_reached` body; None when not one."""
    if not body:
        return None
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        return None
    err = parsed.get("error") if isinstance(parsed, dict) else None
    if not isinstance(err, dict) or err.get("type") not in ("usage_limit_reached", "usage_limit_exceeded"):
        return None
    resets_at = _parse_epoch(err.get("resets_at"))
    if resets_at is not None:
        return resets_at
    resets_in = _parse_float(err.get("resets_in_seconds"))
    if resets_in is not None and resets_in >= 0:
        return _format_utc(now + timedelta(seconds=resets_in))
    return ""  # a usage-limit body without a usable reset


def _codex_rejected_window(windows: Dict[str, Optional[UsageWindow]], resets_at: Optional[str]) -> Optional[str]:
    """Which Codex window a usage-limit 429 exhausted, when the headers say."""
    exhausted = [k for k, w in windows.items() if w is not None and w["usedPct"] >= 100]
    if len(exhausted) != 1:
        return None
    key = exhausted[0]
    current = windows[key] or {}
    windows[key] = {"usedPct": 100.0, "resetsAt": resets_at or current.get("resetsAt")}
    return key


def _analyze(
    token_type: str,
    headers: Mapping[str, str],
    *,
    now: datetime,
    status_code: Optional[int],
    body: Optional[str],
) -> tuple[Optional[UsageSnapshot], Optional[str]]:
    """(snapshot or None, cooldown reason named by the provider or None)."""
    lowered = {str(name).lower(): str(value) for name, value in headers.items()}
    failed = status_code is not None and status_code >= 400
    status: Optional[str] = None
    reason: Optional[str] = None
    if token_type == "claude":
        windows = _claude_windows(lowered)
        raw_status = (lowered.get("anthropic-ratelimit-unified-status") or "").strip().lower()
        status = raw_status if raw_status in _STATUSES else None
        if status == "rejected":
            key = _claude_rejected_window(lowered, windows)
            reason = _WINDOW_REASONS.get(key or "", "usage_window")
    elif token_type == "gpt":
        windows = _codex_windows(lowered, now)
        limit_reset = _codex_limit_reset(body, now) if failed else None
        if limit_reset is not None:
            status = "rejected"
            key = _codex_rejected_window(windows, limit_reset or None)
            reason = _WINDOW_REASONS.get(key or "", "usage_window")
    else:
        return None, None
    if windows["fiveHour"] is None and windows["sevenDay"] is None:
        return None, reason
    snapshot: UsageSnapshot = {
        "observedAt": _format_utc(now),
        **windows,
        "source": "rate_limit" if failed or status == "rejected" else "response",
        "status": status,
    }
    return snapshot, reason


def parse_usage_headers(
    token_type: str,
    headers: Mapping[str, str],
    now: Optional[datetime] = None,
    *,
    status_code: Optional[int] = None,
    body: Optional[str] = None,
) -> Optional[UsageSnapshot]:
    """Usage snapshot from one provider response (headers, plus a failure body), or None when absent."""
    snapshot, _ = _analyze(
        token_type,
        headers,
        now=now or datetime.now(timezone.utc),
        status_code=status_code,
        body=body,
    )
    return snapshot


def observe(
    token_type: str,
    token: Optional[str],
    headers: Mapping[str, str],
    *,
    status_code: Optional[int] = None,
    body: Optional[str] = None,
) -> None:
    """Record the latest usage a response reported for this token. Never raises."""
    if not token:
        return
    try:
        snapshot, reason = _analyze(
            token_type,
            headers,
            now=datetime.now(timezone.utc),
            status_code=status_code,
            body=body,
        )
    except Exception:
        return
    key = token_fingerprint(token)
    with _lock:
        if reason is not None:
            _bump_bounded(_limit_reasons, key, (reason, time.monotonic()))
        if snapshot is not None:
            _bump_bounded(_snapshots, key, snapshot)


def record(token: Optional[str], snapshot: Optional[UsageSnapshot]) -> None:
    """Store an already-built snapshot (e.g. from a code session's rate_limit_event)."""
    if not token or not snapshot:
        return
    with _lock:
        _bump_bounded(_snapshots, token_fingerprint(token), snapshot)


def take(token: Optional[str]) -> Optional[UsageSnapshot]:
    """Pop the unsent snapshot for this token (None when nothing new was observed)."""
    if not token:
        return None
    with _lock:
        return _snapshots.pop(token_fingerprint(token), None)


def restore(token: Optional[str], snapshot: Optional[UsageSnapshot]) -> None:
    """Put back a snapshot whose delivery failed, unless a newer observation already replaced it."""
    if not token or not snapshot:
        return
    key = token_fingerprint(token)
    with _lock:
        if key not in _snapshots:
            _bump_bounded(_snapshots, key, snapshot)


def has_pending(token: Optional[str]) -> bool:
    if not token:
        return False
    with _lock:
        return token_fingerprint(token) in _snapshots


def limit_reason(token: Optional[str]) -> Optional[str]:
    """The window a recent rejected response named for this token (usage_window_5h/_7d/usage_window)."""
    if not token:
        return None
    key = token_fingerprint(token)
    with _lock:
        entry = _limit_reasons.get(key)
        if entry is None:
            return None
        reason, seen = entry
        if time.monotonic() - seen > _LIMIT_REASON_TTL_S:
            _limit_reasons.pop(key, None)
            return None
        return reason


_STALL_MARKERS = ("stall", "timeout")
_AUTH_REASONS = (
    "auth_error",
    "auth",
    "authentication_failed",
    "invalid_grant",
    "revoked",
    "expired",
    "unauthorized",
    "forbidden",
)


def cooldown_reason(token: Optional[str], failure_reason: Optional[str]) -> str:
    """Contract `cooldown.reason` for a mark: stall | auth | usage_window[_5h|_7d] | rate_limit."""
    failure = (failure_reason or "").strip().lower()
    if any(marker in failure for marker in _STALL_MARKERS):
        return "stall"
    if failure in _AUTH_REASONS:
        return "auth"
    return limit_reason(token) or "rate_limit"


def usage_from_rate_limit_event(info: Mapping[str, Any], now: Optional[datetime] = None) -> Optional[UsageSnapshot]:
    """Claude Code SDK `rate_limit_event.rate_limit_info` → usage snapshot, for every status.

    `rateLimitType` five_hour → fiveHour, seven_day → sevenDay (model-specific
    weekly and overage limits are not the account's bars); `utilization` is a
    0-1 fraction; `resetsAt` is epoch seconds. A rejected window without a
    utilization is 100% used; any other window without one is not reported.
    """
    if not isinstance(info, Mapping):
        return None
    raw_status = str(info.get("status") or "").strip().lower()
    status = raw_status if raw_status in _STATUSES else None
    key = _CLAIM_WINDOWS.get(str(info.get("rateLimitType") or "").strip().lower())
    if key is None:
        return None
    utilization = _parse_float(info.get("utilization"))
    used_pct = utilization * 100 if utilization is not None else (100.0 if status == "rejected" else None)
    window = _window(used_pct, _parse_epoch(info.get("resetsAt")))
    if window is None:
        return None
    observed = now or datetime.now(timezone.utc)
    return {
        "observedAt": _format_utc(observed),
        "fiveHour": window if key == "fiveHour" else None,
        "sevenDay": window if key == "sevenDay" else None,
        "source": "code_session",
        "status": status,
    }


def flush(auth: Any, *, urgent: bool = False) -> None:
    """Deliver this token's unsent snapshot now, without blocking the caller.

    Schedules `auth.heartbeat_lease(auth)` (which pops the snapshot) as a
    background task bounded by FLUSH_TIMEOUT_S. Success snapshots are flushed at
    most once per FLUSH_MIN_INTERVAL_S per token; `urgent` (a failure the token
    is about to be rotated away on) always flushes. Never raises.
    """
    try:
        heartbeat = getattr(auth, "heartbeat_lease", None)
        token = getattr(auth, "token", None)
        if heartbeat is None or not token or not getattr(auth, "lineage_key", None):
            return
        key = token_fingerprint(token)
        now = time.monotonic()
        with _lock:
            if key not in _snapshots:
                return
            last = _last_flush.get(key)
            if not urgent and last is not None and now - last < FLUSH_MIN_INTERVAL_S:
                return
            _bump_bounded(_last_flush, key, now)
        loop = asyncio.get_running_loop()
    except Exception:
        return

    async def _send() -> None:
        with contextlib.suppress(Exception, asyncio.CancelledError):
            await asyncio.wait_for(heartbeat(auth), timeout=FLUSH_TIMEOUT_S)

    with contextlib.suppress(Exception):
        task = loop.create_task(_send())
        _pending.add(task)
        task.add_done_callback(_pending.discard)


def tracked_count() -> int:
    with _lock:
        return len(_snapshots)


def clear() -> None:
    with _lock:
        _snapshots.clear()
        _last_flush.clear()
        _limit_reasons.clear()
