"""Per-task timeout derivation from historical pass data.

History is persisted as JSONL in `agents/benchmarks/history/task_durations.jsonl`
(tracked in git with merge=union). Each line is one passed task:

    {"task": "chat-mode", "duration_seconds": 45.2, "cost_cents": 12.3,
     "timestamp": "2026-04-16T15:30:00Z", "agent_id": "..."}

`get_timeout(task_name)` reads recent entries, computes p95, multiplies by a
safety factor, and returns an integer seconds value. Raises
`InsufficientHistoryError` when the corpus is too small — deploy must bootstrap
first (see `bootstrap_timeouts.py`).
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from typing import List, Optional

HISTORY_DIR = os.path.join(os.path.dirname(__file__), "history")
HISTORY_FILE = os.path.join(HISTORY_DIR, "task_durations.jsonl")

MIN_SAMPLES = 5
# Derive timeouts from the last N successful runs × a safety buffer.
# Window=5 absorbs short-term variance (LLM latency spikes, preflight overhead)
# without inheriting stale outliers (p95 from months-old slow runs). Multiplier
# 1.5 leaves enough headroom for runs that land at the upper end of variance
# observed across window=5 (empirically ~1.3–1.4× p50 on smoke tasks).
RECENT_PASS_WINDOW = 5
SAFETY_MULTIPLIER = 1.5
FLOOR_SECONDS = 30
CEIL_SECONDS = 900


class InsufficientHistoryError(Exception):
    """Raised when a task has fewer than MIN_SAMPLES passed runs in history."""

    def __init__(self, task_name: str, have: int, need: int):
        self.task_name = task_name
        self.have = have
        self.need = need
        super().__init__(
            f"Task '{task_name}' has only {have} passed-run(s) in history "
            f"(need {need}). Bootstrap the corpus:\n"
            f"    cd agents && python benchmarks/bootstrap_timeouts.py --suite smoke\n"
            f"This will rerun smoke until every task reaches {need} passes, then "
            f"commit the updated history."
        )


def record_pass(
    task_name: str,
    duration_seconds: float,
    cost_cents: float,
    agent_id: str = "",
    timestamp: Optional[str] = None,
) -> None:
    """Append a passed-task record to the history JSONL.

    Writes with O_APPEND — atomic for lines under PIPE_BUF, safe for parallel
    task execution. Never raises on write failure (history is best-effort).
    """
    os.makedirs(HISTORY_DIR, exist_ok=True)
    entry = {
        "task": task_name,
        "duration_seconds": round(float(duration_seconds), 1),
        "cost_cents": round(float(cost_cents), 2),
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
    }
    try:
        with open(HISTORY_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def _load_durations(task_name: str) -> List[float]:
    """Read all duration_seconds values for this task from history."""
    if not os.path.exists(HISTORY_FILE):
        return []
    durations: List[float] = []
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("task") != task_name:
                continue
            d = entry.get("duration_seconds")
            if isinstance(d, (int, float)) and d > 0:
                durations.append(float(d))
    return durations


def _percentile(values: List[float], pct: float) -> float:
    """Nearest-rank percentile (pct in 0..100)."""
    if not values:
        return 0.0
    s = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(s)))
    return s[min(rank - 1, len(s) - 1)]


def get_timeout(
    task_name: str,
    min_samples: int = MIN_SAMPLES,
    multiplier: float = SAFETY_MULTIPLIER,
    window: int = RECENT_PASS_WINDOW,
    max_seconds: Optional[int] = None,
) -> int:
    """Return the dynamic timeout for this task in seconds.

    Uses the max of the last `window` passed durations × `multiplier` to
    absorb short-term variance without inheriting stale outliers. `max_seconds`
    enforces a hard per-task cap (e.g. smoke tests); unset falls back to
    CEIL_SECONDS.

    Raises InsufficientHistoryError if fewer than min_samples passed runs exist.
    """
    durations = _load_durations(task_name)
    if len(durations) < min_samples:
        raise InsufficientHistoryError(task_name, len(durations), min_samples)
    recent = durations[-window:]
    derived = int(math.ceil(max(recent) * multiplier))
    ceil = max_seconds if max_seconds is not None else CEIL_SECONDS
    return max(FLOOR_SECONDS, min(ceil, derived))


def summary(task_name: str, max_seconds: Optional[int] = None) -> dict:
    """Return {count, p50, p95, recent_max, derived_timeout} for introspection."""
    durations = _load_durations(task_name)
    if not durations:
        return {
            "task": task_name,
            "count": 0,
            "p50": 0,
            "p95": 0,
            "recent_max": 0,
            "derived_timeout": None,
        }
    recent = durations[-RECENT_PASS_WINDOW:]
    try:
        derived = get_timeout(task_name, max_seconds=max_seconds)
    except InsufficientHistoryError:
        derived = None
    return {
        "task": task_name,
        "count": len(durations),
        "p50": round(_percentile(durations, 50.0), 1),
        "p95": round(_percentile(durations, 95.0), 1),
        "recent_max": round(max(recent), 1),
        "derived_timeout": derived,
    }
