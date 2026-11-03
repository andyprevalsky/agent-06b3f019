"""Historical span-duration baselines for benchmark latency diagnosis."""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import subprocess
from datetime import datetime, timezone
from glob import glob
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

HISTORY_DIR = os.path.join(os.path.dirname(__file__), "history")
HISTORY_FILE = os.path.join(HISTORY_DIR, "span_durations.jsonl")
# Same contract as timeout_history.PARK_DIR_ENV: a deploy's smoke lane parks
# new span rows under .context (one unsegmented file; the publish step replays
# them through the normal segmented append). Reads keep the tracked ledgers.
PARK_DIR_ENV = "BENCHMARK_HISTORY_PARK_DIR"
# Leave headroom below GitHub's 100 MiB blob ceiling. The original ledger remains
# immutable once it reaches this size and new rows roll into dated segments.
MAX_HISTORY_FILE_BYTES = 90 * 1024 * 1024

RECENT_WINDOW = 100
MIN_SAMPLES = 20
REGRESSION_MULTIPLIER = 1.5
MIN_REGRESSION_DELTA_MS = 1000


def _percentile(values: Sequence[float], pct: float) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(sorted_values)))
    return sorted_values[min(rank - 1, len(sorted_values) - 1)]


def _history_paths(history_file: Optional[str] = None) -> List[str]:
    """Return the primary ledger plus ordered rollover segments.

    Explicit paths preserve the historical single-file contract used by tests and
    one-off diagnostics. Only the repository default is segmented.
    """
    configured = history_file or os.environ.get("SPAN_HISTORY_FILE")
    if configured:
        return [configured]
    segments = sorted(
        glob(os.path.join(HISTORY_DIR, "span_durations.*.jsonl")),
        key=lambda path: re.sub(r"(\.\d{8})\.jsonl$", r"\1.01.jsonl", path),
    )
    return [HISTORY_FILE, *segments]


def _parked_history_file() -> Optional[str]:
    park = os.environ.get(PARK_DIR_ENV, "").strip()
    return os.path.join(park, os.path.basename(HISTORY_FILE)) if park else None


def _writer_key() -> str:
    """Slug of the checkout's branch, or "" when detached or outside git."""
    try:
        branch = subprocess.run(
            ["git", "symbolic-ref", "--short", "-q", "HEAD"],
            cwd=HISTORY_DIR,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    return re.sub(r"[^a-z0-9]+", "-", branch.lower()).strip("-")[:64]


def _append_history_path(history_file: Optional[str] = None, required_bytes: int = 0) -> str:
    configured = history_file or os.environ.get("SPAN_HISTORY_FILE") or _parked_history_file()
    if configured:
        return configured

    def has_room(candidate: str) -> bool:
        try:
            size = os.path.getsize(candidate)
        except OSError:
            return True
        return size == 0 or (size < MAX_HISTORY_FILE_BYTES and size + required_bytes <= MAX_HISTORY_FILE_BYTES)

    if not glob(os.path.join(HISTORY_DIR, "span_durations.*.jsonl")) and has_room(HISTORY_FILE):
        return HISTORY_FILE

    # Segments are union-merged, so two branches appending to one shared name each
    # stay under the cap while their merge does not. Each branch owns its segments.
    writer = _writer_key()
    prefix = f"span_durations.{datetime.now(timezone.utc).strftime('%Y%m%d')}"
    if writer:
        prefix = f"{prefix}.{writer}"
    latest_part = 1
    for part in range(1, 100):
        suffix = "" if part == 1 else f".{part:02d}"
        if os.path.exists(os.path.join(HISTORY_DIR, f"{prefix}{suffix}.jsonl")):
            latest_part = part
    for part in range(latest_part, 100):
        suffix = "" if part == 1 else f".{part:02d}"
        candidate = os.path.join(HISTORY_DIR, f"{prefix}{suffix}.jsonl")
        if has_room(candidate):
            return candidate
    # More than 99 full 90 MiB segments in one day is not credible, but retaining
    # a deterministic final target keeps benchmark recording best-effort.
    return os.path.join(HISTORY_DIR, f"{prefix}.99.jsonl")


def _clean_record(record: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in record.items() if v not in (None, "")}


def _record_span_observations_unlocked(
    observations: Iterable[Dict[str, Any]],
    *,
    history_file: Optional[str] = None,
) -> int:
    """Append span observations to the history JSONL.

    Each observation should already contain stable identity fields such as
    benchmark, environment, span_key, duration_ms, and timestamp. This function
    is best-effort for benchmark recording: invalid entries are skipped, and
    OSError is swallowed after any successfully written rows.
    """
    path = _append_history_path(history_file)
    if parent := os.path.dirname(path):
        os.makedirs(parent, exist_ok=True)
    written = 0
    configured = history_file or os.environ.get("SPAN_HISTORY_FILE") or _parked_history_file()
    try:
        current_size = os.path.getsize(path)
    except OSError:
        current_size = 0
    output = None
    try:
        for observation in observations:
            span_key = observation.get("span_key")
            duration_ms = observation.get("duration_ms")
            if not span_key or not isinstance(duration_ms, (int, float)) or duration_ms < 0:
                continue
            line = json.dumps(_clean_record(dict(observation)), sort_keys=True) + "\n"
            line_bytes = len(line.encode("utf-8"))
            if not configured and current_size and current_size + line_bytes > MAX_HISTORY_FILE_BYTES:
                if output is not None:
                    output.close()
                    output = None
                path = _append_history_path(required_bytes=line_bytes)
                try:
                    current_size = os.path.getsize(path)
                except OSError:
                    current_size = 0
            if output is None:
                output = open(path, "a")
            output.write(line)
            current_size += line_bytes
            written += 1
    except OSError:
        return written
    finally:
        if output is not None:
            output.close()
    return written


def record_span_observations(
    observations: Iterable[Dict[str, Any]],
    *,
    history_file: Optional[str] = None,
) -> int:
    """Append observations under one file lock so concurrent batches cannot overfill a segment."""
    lock_path = history_file or os.environ.get("SPAN_HISTORY_FILE") or _parked_history_file() or HISTORY_FILE
    try:
        if parent := os.path.dirname(lock_path):
            os.makedirs(parent, exist_ok=True)
        with open(lock_path, "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            return _record_span_observations_unlocked(observations, history_file=history_file)
    except OSError:
        return 0


def load_records(
    *,
    benchmark: str = "",
    environment: str = "",
    span_key: str = "",
    span_keys: Optional[Set[str]] = None,
    statuses: Optional[Tuple[str, ...]] = None,
    history_file: Optional[str] = None,
) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    for path in _history_paths(history_file):
        if not os.path.exists(path):
            continue
        with open(path, errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if benchmark and record.get("benchmark") != benchmark:
                    continue
                if environment and record.get("environment") != environment:
                    continue
                if span_key and record.get("span_key") != span_key:
                    continue
                if span_keys is not None and record.get("span_key") not in span_keys:
                    continue
                if statuses is not None and record.get("run_status") not in statuses:
                    continue
                if not isinstance(record.get("duration_ms"), (int, float)):
                    continue
                records.append(record)
    return records


def _in_recorded_order(records: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Order rows by when they were recorded, not by where they sit on disk.

    Segments are union-merged across branches and can hold overflow rows, so
    file order is not time order. Rows without a timestamp sort first.
    """
    return sorted(records, key=lambda record: str(record.get("timestamp") or ""))


def summarize_records(records: Sequence[Dict[str, Any]], *, window: int = RECENT_WINDOW) -> Optional[Dict[str, Any]]:
    durations = [
        float(r["duration_ms"])
        for r in _in_recorded_order(records)
        if isinstance(r.get("duration_ms"), (int, float))
    ]
    if not durations:
        return None
    recent = durations[-window:]
    return {
        "count": len(durations),
        "recent_count": len(recent),
        "p50_ms": round(_percentile(recent, 50.0), 1),
        "p90_ms": round(_percentile(recent, 90.0), 1),
        "p95_ms": round(_percentile(recent, 95.0), 1),
        "max_ms": round(max(recent), 1),
    }


def summary(
    span_key: str,
    *,
    benchmark: str = "",
    environment: str = "",
    statuses: Optional[Tuple[str, ...]] = ("passed", "observed"),
    history_file: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    return summaries(
        [span_key],
        benchmark=benchmark,
        environment=environment,
        statuses=statuses,
        history_file=history_file,
    ).get(span_key)


def summaries(
    span_keys: Iterable[str],
    *,
    benchmark: str = "",
    environment: str = "",
    statuses: Optional[Tuple[str, ...]] = ("passed", "observed"),
    history_file: Optional[str] = None,
) -> Dict[str, Dict[str, Any]]:
    """Summarize many span keys with one history-ledger scan."""
    wanted = {str(span_key) for span_key in span_keys if span_key}
    if not wanted:
        return {}
    grouped: Dict[str, List[Dict[str, Any]]] = {span_key: [] for span_key in wanted}
    for record in load_records(
        benchmark=benchmark,
        environment=environment,
        span_keys=wanted,
        statuses=statuses,
        history_file=history_file,
    ):
        span_key = str(record.get("span_key") or "")
        if span_key in grouped:
            grouped[span_key].append(record)
    return {
        span_key: stats for span_key, records in grouped.items() if (stats := summarize_records(records)) is not None
    }


def compare_observations(
    observations: Sequence[Dict[str, Any]],
    *,
    benchmark: str = "",
    environment: str = "",
    min_samples: int = MIN_SAMPLES,
    multiplier: float = REGRESSION_MULTIPLIER,
    min_delta_ms: int = MIN_REGRESSION_DELTA_MS,
    statuses: Optional[Tuple[str, ...]] = ("passed", "observed"),
    history_file: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return current observations annotated with historical stats.

    Rows are sorted by strongest regression signal first, then by current
    duration. A row is marked as a regression when current duration exceeds
    both p95 * multiplier and p95 + min_delta_ms.
    """
    span_keys = {str(observation.get("span_key") or "") for observation in observations if observation.get("span_key")}
    cache = summaries(
        span_keys,
        benchmark=benchmark,
        environment=environment,
        statuses=statuses,
        history_file=history_file,
    )
    rows: List[Dict[str, Any]] = []
    for observation in observations:
        span_key = str(observation.get("span_key") or "")
        duration_ms = observation.get("duration_ms")
        if not span_key or not isinstance(duration_ms, (int, float)):
            continue
        stats = cache.get(span_key)
        if not stats or stats["count"] < min_samples:
            continue
        p95 = float(stats["p95_ms"])
        delta = float(duration_ms) - p95
        ratio = float(duration_ms) / p95 if p95 > 0 else 0.0
        is_regression = delta >= min_delta_ms and ratio >= multiplier
        rows.append(
            {
                **observation,
                **stats,
                "delta_vs_p95_ms": round(delta, 1),
                "ratio_vs_p95": round(ratio, 2),
                "is_regression": is_regression,
            }
        )
    rows.sort(key=lambda r: (not r["is_regression"], -r["delta_vs_p95_ms"], -r["duration_ms"]))
    return rows


def make_observation(
    *,
    agent_id: str,
    benchmark: str,
    environment: str,
    span_key: str,
    span_name: str,
    duration_ms: float,
    timestamp: Optional[str] = None,
    run_status: str = "observed",
    **metadata: Any,
) -> Dict[str, Any]:
    return _clean_record(
        {
            "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
            "benchmark": benchmark,
            "environment": environment,
            "agent_id": agent_id,
            "run_status": run_status,
            "span_key": span_key,
            "span_name": span_name,
            "duration_ms": round(float(duration_ms), 1),
            **metadata,
        }
    )
