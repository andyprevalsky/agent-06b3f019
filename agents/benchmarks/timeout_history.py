"""Per-task timeout derivation from historical pass data.

History is persisted as JSONL in `agents/benchmarks/history/task_durations.jsonl`
(tracked in git with merge=union). Each line is one passed task:

    {"task": "chat-mode", "duration_seconds": 45.2, "cost_cents": 12.3,
     "timestamp": "2026-04-16T15:30:00Z", "agent_id": "..."}

`get_timeout(task_name)` reads the last `RECENT_PASS_WINDOW` entries, computes
p95, multiplies by `SAFETY_MULTIPLIER`, and returns an integer seconds value
(clamped between `FLOOR_SECONDS` and the per-task cap). Raises
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
# A deploy's local smoke lane (scripts/run-predeploy-local on an isolated deploy
# worktree) sets this to a directory under .context: the rows it records are
# written there, byte-for-byte as they would be appended to the tracked
# ledgers, so the tracked files stay unchanged while the other gates
# fingerprint the worktree. Reads (timeout derivation, the predeploy history
# gate) keep the tracked ledgers; `scripts/benchmark-history-latest-only.py
# --apply-parked --write` replays the parked rows at publish time.
PARK_DIR_ENV = "BENCHMARK_HISTORY_PARK_DIR"

MIN_SAMPLES = 5
# Derive timeouts from p95 of the recent successful runs × a safety buffer.
# We use p95 (not max) so a short cluster of fast runs can't collapse the cap
# below normal-variance durations. Window=20 gives p95 enough samples to be
# stable while still phasing out stale outliers from months-old infra. Multiplier
# 1.5 leaves headroom above p95 — empirically ~1.2× covers normal upper-tail
# variance on smoke tasks, 1.5 absorbs occasional LLM latency spikes.
RECENT_PASS_WINDOW = 20
SAFETY_MULTIPLIER = 2.25
PERCENTILE = 95.0
FLOOR_SECONDS = 30
CEIL_SECONDS = 900


def _write_target(ledger_path: str) -> str:
    """Where a new row of ``ledger_path`` is appended: the parked copy of that
    ledger when PARK_DIR_ENV names a directory, otherwise the ledger itself."""
    park = os.environ.get(PARK_DIR_ENV, "").strip()
    if not park:
        return ledger_path
    return os.path.join(park, os.path.basename(ledger_path))


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
    target = _write_target(HISTORY_FILE)
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    entry = {
        "task": task_name,
        "duration_seconds": round(float(duration_seconds), 1),
        "cost_cents": round(float(cost_cents), 2),
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
    }
    try:
        with open(target, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


ATTEMPTS_FILE = os.path.join(HISTORY_DIR, "task_attempts.jsonl")


# Suites that must never feed predeploy history-gate eligibility. Kept in sync
# with `select_predeploy_benches.ELIGIBILITY_EXCLUDED_SUITES`.
_ELIGIBILITY_EXCLUDED_SUITES = frozenset(
    {
        "predeploy",
        "pre-deploy",
        "predeploy-local",
        "predeploy-cloud",
        "deploy-smoke",
    }
)


def _resolve_attempt_suite(suite: Optional[str]) -> Optional[str]:
    resolved = (suite if suite is not None else os.environ.get("BENCHMARK_ATTEMPT_SUITE", "")).strip()
    return resolved or None


def _resolve_counts_for_deploy_eligibility(
    *,
    suite: Optional[str],
    counts_for_deploy_eligibility: Optional[bool],
) -> bool:
    """Decide whether this attempt may affect the predeploy 3-pass canary gate.

    Predeploy / active-worktree smoke sets
    `BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY=0` (and/or
    `BENCHMARK_ATTEMPT_SUITE=predeploy`) so assigning a canary cannot be
    invalidated by the worktree run that just selected it.
    """
    # Excluded suites always win — never let an explicit True / env=1 re-poison
    # a canary streak from a predeploy / worktree attempt.
    if suite and suite.strip().lower() in _ELIGIBILITY_EXCLUDED_SUITES:
        return False
    if counts_for_deploy_eligibility is not None:
        return bool(counts_for_deploy_eligibility)
    env_flag = os.environ.get("BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY", "").strip().lower()
    if env_flag in {"0", "false", "no"}:
        return False
    if env_flag in {"1", "true", "yes"}:
        return True
    return True


def record_attempt(
    task_name: str,
    passed: bool,
    status: str,
    duration_seconds: float,
    cost_cents: float,
    agent_id: str = "",
    failure_reason: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    timestamp: Optional[str] = None,
    suite: Optional[str] = None,
    counts_for_deploy_eligibility: Optional[bool] = None,
    run_id: Optional[str] = None,
    outcome_class: Optional[str] = None,
    evaluator_evidence: Optional[dict] = None,
) -> None:
    """Append EVERY completed run (pass or fail, local or prod) to the attempts ledger.

    Unlike `record_pass` (pass-only corpus that feeds timeout derivation — a
    failure duration would poison p95), this ledger is the complete run-stats
    record: attempt counts, failure rates, and failure reasons per task. Full
    trajectories for each attempt live in `runs/*.json` (message transcripts +
    logs) and `.llm-dumps/<agent_id>/` (full LLM calls, always-on locally).

    Predeploy / active-worktree runs still append (for timing/history) but mark
    `counts_for_deploy_eligibility=false` so they cannot break a canary's
    last-3-pass streak after it is assigned into smoke.

    `run_id` groups the attempts of one benchmark run (plus the optional
    `BENCHMARK_HUB_GROUP_RUN_ID` campaign group) so factory reviews can report
    per-run task counts and per-attempt durations; `outcome_class` separates
    a passed verdict, a failed verdict and an owned-cleanup failure. Absent
    values are omitted, never guessed.

    Best-effort, O_APPEND, never raises.
    """
    target = _write_target(ATTEMPTS_FILE)
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    resolved_suite = _resolve_attempt_suite(suite)
    eligibility = _resolve_counts_for_deploy_eligibility(
        suite=resolved_suite,
        counts_for_deploy_eligibility=counts_for_deploy_eligibility,
    )
    entry = {
        "task": task_name,
        "passed": bool(passed),
        "status": status,
        "duration_seconds": round(float(duration_seconds), 1),
        "cost_cents": round(float(cost_cents), 2),
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
        "failure_reason": (failure_reason or "")[:200] or None,
        "fast_mode_cache": bool(fast_mode_cache_enabled),
        "counts_for_deploy_eligibility": eligibility,
    }
    if resolved_suite:
        entry["suite"] = resolved_suite
    if run_id:
        entry["run_id"] = str(run_id)[:128]
    group_run_id = os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID", "").strip()
    if group_run_id:
        entry["group_run_id"] = group_run_id[:128]
    if outcome_class:
        entry["outcome_class"] = outcome_class
    if evaluator_evidence:
        entry["evaluator_evidence"] = evaluator_evidence
    try:
        with open(target, "a") as f:
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
    percentile: float = PERCENTILE,
    max_seconds: Optional[int] = None,
) -> int:
    """Return the dynamic timeout for this task in seconds.

    Uses p95 (configurable via `percentile`) of the last `window` passed
    durations × `multiplier`. p95 (not max) prevents a short cluster of fast
    runs from collapsing the cap below normal-variance durations. `max_seconds`
    enforces a hard per-task cap (e.g. smoke tests); unset falls back to
    CEIL_SECONDS.

    Raises InsufficientHistoryError if fewer than min_samples passed runs exist.
    """
    durations = _load_durations(task_name)
    if len(durations) < min_samples:
        raise InsufficientHistoryError(task_name, len(durations), min_samples)
    recent = durations[-window:]
    derived = int(math.ceil(_percentile(recent, percentile) * multiplier))
    ceil = max_seconds if max_seconds is not None else CEIL_SECONDS
    return max(FLOOR_SECONDS, min(ceil, derived))


def summary(task_name: str, max_seconds: Optional[int] = None) -> dict:
    """Return {count, p50, p95, recent_p95, recent_max, derived_timeout}."""
    durations = _load_durations(task_name)
    if not durations:
        return {
            "task": task_name,
            "count": 0,
            "p50": 0,
            "p95": 0,
            "recent_p95": 0,
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
        "recent_p95": round(_percentile(recent, 95.0), 1),
        "recent_max": round(max(recent), 1),
        "derived_timeout": derived,
    }
