"""Latest provider usage-window snapshot per subscription token.

Claude and Codex report how much of the account's 5-hour and 7-day windows a
token has used on every response (headers). We record the latest snapshot per
token here and the existing fire-and-forget lineage heartbeat
(`helpers/llm.py:heartbeat_compute_token_lineage_activity`) carries it to the
backend, so the compute screen's per-account usage bars stay current without
any extra HTTP roundtrip.

The heartbeat fires before each attempt, so it reports the usage observed on an
earlier response of the same token in this process. Snapshots are keyed by a
credential fingerprint (never the token), popped when sent, and bounded so the
store holds at 10k concurrent agents.
"""

from __future__ import annotations

import hashlib
import math
import threading
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Mapping, Optional

UsageWindow = Dict[str, Any]
UsageSnapshot = Dict[str, Any]

MAX_TRACKED_TOKENS = 1024

# Codex reports each window's length; anything at most this long is the
# short (5h) window, anything at least this long is the weekly one.
_FIVE_HOUR_MAX_MINUTES = 6 * 60
_SEVEN_DAY_MIN_MINUTES = 6 * 24 * 60

_lock = threading.Lock()
_snapshots: "OrderedDict[str, UsageSnapshot]" = OrderedDict()


def token_fingerprint(token: str) -> str:
    """Same digest as `helpers.llm.credential_fingerprint`; the token is never stored."""
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def _format_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_float(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value.strip())
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _parse_epoch(value: Optional[str]) -> Optional[str]:
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


def _claude_windows(headers: Mapping[str, str]) -> Dict[str, Optional[UsageWindow]]:
    def window(key: str) -> Optional[UsageWindow]:
        utilization = _parse_float(headers.get(f"anthropic-ratelimit-unified-{key}-utilization"))
        return _window(
            None if utilization is None else utilization * 100,
            _parse_epoch(headers.get(f"anthropic-ratelimit-unified-{key}-reset")),
        )

    return {"fiveHour": window("5h"), "sevenDay": window("7d")}


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


def parse_usage_headers(
    token_type: str,
    headers: Mapping[str, str],
    now: Optional[datetime] = None,
) -> Optional[UsageSnapshot]:
    """Usage snapshot from one provider response's headers, or None when absent."""
    observed = now or datetime.now(timezone.utc)
    lowered = {str(name).lower(): str(value) for name, value in headers.items()}
    if token_type == "claude":
        windows = _claude_windows(lowered)
    elif token_type == "gpt":
        windows = _codex_windows(lowered, observed)
    else:
        return None
    if windows["fiveHour"] is None and windows["sevenDay"] is None:
        return None
    return {"observedAt": _format_utc(observed), **windows}


def observe(token_type: str, token: Optional[str], headers: Mapping[str, str]) -> None:
    """Record the latest usage a response reported for this token. Never raises."""
    if not token:
        return
    try:
        snapshot = parse_usage_headers(token_type, headers)
    except Exception:
        return
    if snapshot is None:
        return
    key = token_fingerprint(token)
    with _lock:
        _snapshots[key] = snapshot
        _snapshots.move_to_end(key)
        while len(_snapshots) > MAX_TRACKED_TOKENS:
            _snapshots.popitem(last=False)


def take(token: Optional[str]) -> Optional[UsageSnapshot]:
    """Pop the unsent snapshot for this token (None when nothing new was observed)."""
    if not token:
        return None
    with _lock:
        return _snapshots.pop(token_fingerprint(token), None)


def tracked_count() -> int:
    with _lock:
        return len(_snapshots)


def clear() -> None:
    with _lock:
        _snapshots.clear()
