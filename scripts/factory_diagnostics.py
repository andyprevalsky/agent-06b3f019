"""Explain factory gap time, reruns and failures from the factory ledgers.

`factory_review.py` reports how long each step took. This module answers the
follow-up questions an optimizer needs: which gates fail and why, why each
rerun happened, how much was queue/setup versus execution, how often exact
reuse hit, where idle gaps sit between recorded activities, and how long
reviews, approvals, external deploys and benchmark runs waited.

Inputs are the rows `factory_review.load_ledger_rows` returns plus the
benchmark attempts ledger. Rows without `detail` (older history) still count
toward attempts and gaps; detail-only metrics state their coverage instead of
treating missing data as zero.
"""

from __future__ import annotations

import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence

GAP_THRESHOLD_SECONDS = 60.0
TOP = 5
PAIRED_EVENTS = {
    ("approval-request", "approval-decision"): "approval",
    ("review-request", "review-arrival"): "review",
    ("production-start", "production-finish"): "external-deploy",
    ("stage-start", "stage-finish"): "stage",
}


def _history_ledger():
    """agents/benchmarks/history_ledger.py: a ledger is its base file plus per-writer shards."""
    import importlib.util

    source = Path(__file__).resolve().parents[1] / "agents" / "benchmarks" / "history_ledger.py"
    spec = importlib.util.spec_from_file_location("benchmark_history_ledger", source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



def valid_ledger_row(row: dict[str, Any]) -> bool:
    if not isinstance(row, dict):
        return False
    fields = (
        ("started_epoch", "finished_epoch") if row.get("kind") == "deploy-stage"
        else ("recorded_epoch",) if row.get("kind") == "factory-event" else ()
    )
    if not fields:
        return False
    try:
        return all(not isinstance(row[field], bool) and math.isfinite(float(row[field])) for field in fields)
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _finite_number(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _median(values: Sequence[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def _detail(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("detail")
    return value if isinstance(value, dict) else {}


def _obj(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _label(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _top(counter: Counter, limit: int = TOP) -> list[dict[str, Any]]:
    return [{"name": name, "count": count} for name, count in counter.most_common(limit)]


def gate_diagnostics(stages: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    by_gate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in stages:
        by_gate[str(row.get("stage") or "")].append(row)
    out = []
    for gate, rows in by_gate.items():
        executed = [row for row in rows if row.get("status") != "reused"]
        failed = [row for row in executed if row.get("status") == "failed"]
        detailed = [row for row in executed if _detail(row)]
        classes: Counter = Counter()
        names: Counter = Counter()
        causes: Counter = Counter()
        setup, queue, execute = [], [], []
        load_peak: list[float] = []
        mem_min: list[float] = []
        for row in detailed:
            detail = _detail(row)
            outcome = _obj(detail.get("outcome"))
            if row.get("status") == "failed":
                classes[_label(outcome.get("failure_class")) or "unclassified"] += 1
                failing = outcome.get("failing")
                if isinstance(failing, list):
                    names.update(name for name in failing if isinstance(name, str))
            cause = _label(_obj(detail.get("attempt")).get("retry_cause"))
            if cause:
                causes[cause] += 1
            timing = _obj(detail.get("timing"))
            for key, bucket in (("setup_seconds", setup), ("queue_seconds", queue), ("exec_seconds", execute)):
                if _finite_number(timing.get(key)):
                    bucket.append(float(timing[key]))
            host = _obj(detail.get("host"))
            if _finite_number(host.get("load1_peak")):
                load_peak.append(float(host["load1_peak"]))
            if _finite_number(host.get("mem_available_min_mb")):
                mem_min.append(float(host["mem_available_min_mb"]))
        reruns = sum(
            max(0, count - 1)
            for count in Counter(str(row.get("run_id")) for row in executed).values()
        )
        out.append(
            {
                "gate": gate,
                "executed": len(executed),
                "failed": len(failed),
                "reruns": reruns,
                "reused": len(rows) - len(executed),
                "detail_coverage": len(detailed),
                "failure_classes": _top(classes),
                "failing_names": _top(names),
                "retry_causes": _top(causes),
                "median_setup_seconds": _median(setup),
                "median_queue_seconds": _median(queue),
                "median_exec_seconds": _median(execute),
                "max_load1": max(load_peak) if load_peak else None,
                "min_mem_available_mb": min(mem_min) if mem_min else None,
            }
        )
    return sorted(out, key=lambda row: (-row["failed"], -row["reruns"], row["gate"]))


def _activity_label(row: dict[str, Any]) -> str:
    if row.get("kind") == "deploy-stage":
        return f"{row.get('stage')}({row.get('status')})"
    return f"{row.get('event')}:{row.get('value')}"


def _wait_windows(events: Sequence[dict[str, Any]]) -> list[tuple[float, float, str, str]]:
    """Paired request/finish windows: (start, end, kind, value)."""
    windows = []
    open_starts: dict[tuple[str, str, str], float] = {}
    starts = {start: (finish, kind) for (start, finish), kind in PAIRED_EVENTS.items()}
    finishes = {finish: (start, kind) for (start, finish), kind in PAIRED_EVENTS.items()}
    for row in sorted(events, key=lambda value: float(value["recorded_epoch"])):
        event, value = str(row.get("event")), str(row.get("value"))
        epoch = float(row["recorded_epoch"])
        if event in starts:
            # approval decisions carry approved/rejected, not the request value.
            key = (str(row.get("branch", "")), event, "" if event == "approval-request" else value)
            open_starts[key] = epoch
        elif event in finishes:
            start_event, kind = finishes[event]
            key = (str(row.get("branch", "")), start_event, "" if start_event == "approval-request" else value)
            started = open_starts.pop(key, None)
            if started is not None and epoch >= started:
                windows.append((started, epoch, kind, value))
    return windows


def run_gaps(stages: Sequence[dict[str, Any]], events: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Idle spans between recorded activities in one deploy run, attributed."""
    activities = [
        (float(row["started_epoch"]), float(row["finished_epoch"]), row) for row in stages
    ] + [(float(row["recorded_epoch"]),) * 2 + (row,) for row in events]
    windows = _wait_windows(events)
    activities.extend(
        (start, end, {"kind": "factory-event", "event": "stage", "value": value})
        for start, end, kind, value in windows
        if kind == "stage"
    )
    activities.sort(key=lambda item: (item[0], item[1]))
    gaps = []
    covered_until: float | None = None
    previous: dict[str, Any] | None = None
    for start, finish, row in activities:
        if covered_until is not None and start - covered_until >= GAP_THRESHOLD_SECONDS:
            kinds = sorted(
                {
                    f"{kind}:{value}"
                    for window_start, window_end, kind, value in windows
                    if window_start <= covered_until and window_end >= start and kind != "stage"
                }
            )
            if kinds:
                cause = "wait:" + ",".join(kinds)
            elif (
                previous is not None
                and previous.get("kind") == "deploy-stage"
                and previous.get("status") == "failed"
                and row.get("kind") == "deploy-stage"
                and row.get("stage") == previous.get("stage")
            ):
                cause = "fix-before-retry"
            elif previous is not None and previous.get("kind") == "deploy-stage" and previous.get("status") == "failed":
                cause = "after-failure"
            else:
                cause = "unattributed"
            gaps.append(
                {
                    "seconds": round(start - covered_until, 1),
                    "after": _activity_label(previous or {}),
                    "before": _activity_label(row),
                    "cause": cause,
                }
            )
        if covered_until is None or finish >= covered_until:
            covered_until = max(covered_until or finish, finish)
            previous = row
    return gaps


def wait_diagnostics(events: Sequence[dict[str, Any]]) -> dict[str, Any]:
    by_kind: dict[str, list[float]] = defaultdict(list)
    for start, finish, kind, value in _wait_windows(events):
        if kind == "stage":
            continue
        label = kind if kind == "approval" else f"{kind}:{value}"
        by_kind[label].append(finish - start)
    return {
        label: {"count": len(values), "median_seconds": _median(values), "total_seconds": round(sum(values), 1)}
        for label, values in sorted(by_kind.items())
    }


def rca_diagnostics(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    repro: Counter = Counter()
    classes: Counter = Counter()
    for row in rows:
        if row.get("kind") != "factory-event" or row.get("workflow") != "rca":
            continue
        if row.get("event") == "repro-attempt":
            repro[str(row.get("value"))] += 1
        if row.get("event") == "outcome":
            classes[_label(_detail(row).get("outcome_class")) or _label(_detail(row).get("failure_class")) or "unrecorded"] += 1
    return {"repro_attempts": dict(repro), "outcome_classes": _top(classes)}


def benchmark_diagnostics(attempts_path: Path, limit: int = TOP) -> dict[str, Any]:
    runs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    without_run = 0
    for line in _history_ledger().read_lines(attempts_path):  # base file + per-writer shards
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        run_id = row.get("run_id")
        if not run_id:
            without_run += 1
            continue
        runs[str(run_id)].append(row)
    summaries = []
    for run_id, rows in runs.items():
        statuses = Counter(str(row.get("status")) for row in rows)
        outcomes = Counter(str(row.get("outcome_class") or "unrecorded") for row in rows)
        durations = [float(row["duration_seconds"]) for row in rows if _finite_number(row.get("duration_seconds"))]
        summaries.append(
            {
                "run_id": run_id,
                "first": min(str(row.get("timestamp")) for row in rows),
                "attempts": len(rows),
                "tasks": len({row["task"] for row in rows if _label(row.get("task"))}),
                "passed": sum(1 for row in rows if row.get("passed")),
                "statuses": dict(statuses),
                "outcome_classes": dict(outcomes),
                "median_seconds": _median(durations),
                "max_seconds": round(max(durations), 1) if durations else None,
            }
        )
    summaries.sort(key=lambda row: row["first"])
    return {"runs": summaries[-limit:], "attempts_without_run_id": without_run}


def descend_diagnostics(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: dict[str, dict[str, Any]] = {}
    for record in records:
        detail = _detail(record)
        if not detail:
            continue
        run = runs.setdefault(str(record.get("run_id")), {"run_id": str(record.get("run_id"))})
        for key in ("task_count", "scheduled_total", "infra_failed", "failed_count", "passed_count"):
            if isinstance(detail.get(key), int):
                run[key] = detail[key]
    return list(runs.values())[-TOP:]


def analyze_ledger(
    rows: Sequence[dict[str, Any]],
    *,
    attempts_path: Path | None = None,
    descend_records: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    valid = [row for row in rows if valid_ledger_row(row)]
    rejected = getattr(rows, "rejected_rows", 0) + len(rows) - len(valid)
    rows = valid
    stages = [row for row in rows if row.get("kind") == "deploy-stage"]
    deploy_events = [
        row for row in rows if row.get("kind") == "factory-event" and row.get("workflow") == "deploy"
    ]
    by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in stages:
        by_run[str(row.get("run_id"))].append(row)
    gap_causes: Counter = Counter()
    gap_seconds: Counter = Counter()
    largest: list[dict[str, Any]] = []
    sources = []
    run_starts = {
        run_id: min(float(row["started_epoch"]) for row in run_stages)
        for run_id, run_stages in by_run.items()
    }
    for run_id, run_stages in by_run.items():
        start = run_starts[run_id]
        finish = max(float(row["finished_epoch"]) for row in run_stages)
        branch = run_stages[0].get("branch")
        next_start = min(
            (other_start for other, other_start in run_starts.items()
             if other != run_id and by_run[other][0].get("branch") == branch and other_start > start),
            default=float("inf"),
        )
        run_events = [
            row
            for row in deploy_events
            if row.get("branch") == branch
            and start <= float(row["recorded_epoch"]) <= finish + 6 * 3600
            and float(row["recorded_epoch"]) < next_start
        ]
        for gap in run_gaps(run_stages, run_events):
            gap_causes[gap["cause"]] += 1
            gap_seconds[gap["cause"]] += gap["seconds"]
            largest.append({"run_id": run_id, **gap})
        source = next(
            (_obj(_detail(row).get("source")) for row in run_stages if _obj(_detail(row).get("source"))), None
        )
        if source:
            sources.append(
                {
                    "run_id": run_id,
                    "sha": str(source.get("sha", ""))[:12],
                    "files_changed": source.get("files_changed"),
                    "insertions": source.get("insertions"),
                    "deletions": source.get("deletions"),
                    "lanes": source.get("lanes"),
                }
            )
    largest.sort(key=lambda gap: -gap["seconds"])
    reuse = Counter()
    for row in stages:
        info = _obj(_detail(row).get("reuse"))
        if info.get("requested"):
            reuse["hit" if info.get("hit") else f"miss:{info.get('miss_reason') or 'unknown'}"] += 1
    detailed = sum(1 for row in stages if _detail(row))
    return {
        "schema_version": 1,
        "coverage": {"stage_rows": len(stages), "stage_rows_with_detail": detailed, "deploy_runs": len(by_run), "rejected_rows": rejected},
        "gates": gate_diagnostics(stages),
        "retry_causes": _top(
            Counter(
                _label(_obj(_detail(row).get("attempt")).get("retry_cause"))
                for row in stages
                if _label(_obj(_detail(row).get("attempt")).get("retry_cause"))
            ),
            limit=10,
        ),
        "reuse": dict(reuse),
        "gap_causes": [
            {"cause": cause, "count": gap_causes[cause], "seconds": round(gap_seconds[cause], 1)}
            for cause, _ in gap_seconds.most_common()
        ],
        "largest_gaps": largest[:10],
        "waits": wait_diagnostics(deploy_events),
        "sources": sources[-TOP:],
        "rca": rca_diagnostics(rows),
        "benchmarks": benchmark_diagnostics(attempts_path) if attempts_path else {"runs": [], "attempts_without_run_id": 0},
        "descend": descend_diagnostics(descend_records),
    }


def _minutes(seconds: float | None) -> str:
    return "—" if seconds is None else f"{seconds / 60:.1f}m"


def render_text(diagnostics: dict[str, Any]) -> list[str]:
    coverage = diagnostics["coverage"]
    lines = [
        f"Diagnostics: {coverage['stage_rows_with_detail']}/{coverage['stage_rows']} stage rows carry detail "
        f"across {coverage['deploy_runs']} deploy runs"
    ]
    if coverage.get("rejected_rows"):
        lines.append(f"Rejected malformed ledger rows: {coverage['rejected_rows']}")
    gates = [gate for gate in diagnostics["gates"] if gate["failed"] or gate["reruns"] or gate["reused"]]
    if gates:
        lines.append("Gate                         Exec  Fail  Rerun  Reuse  Exec p50  Top failure")
        for gate in gates[:10]:
            top = gate["failure_classes"][0]["name"] if gate["failure_classes"] else "—"
            if gate["failing_names"]:
                top += f" ({gate['failing_names'][0]['name'][:40]})"
            lines.append(
                f"{gate['gate'][:28]:<28} {gate['executed']:>5} {gate['failed']:>5} {gate['reruns']:>6} "
                f"{gate['reused']:>6}  {_minutes(gate['median_exec_seconds']):>8}  {top}"
            )
    if diagnostics["retry_causes"]:
        lines.append(
            "Rerun causes: " + ", ".join(f"{row['name']}={row['count']}" for row in diagnostics["retry_causes"])
        )
    if diagnostics["reuse"]:
        lines.append("Reuse: " + ", ".join(f"{key}={value}" for key, value in sorted(diagnostics["reuse"].items())))
    if diagnostics["gap_causes"]:
        lines.append(
            "Idle gaps >=1m: "
            + ", ".join(f"{row['cause']} {row['count']}x {_minutes(row['seconds'])}" for row in diagnostics["gap_causes"])
        )
    for gap in diagnostics["largest_gaps"][:3]:
        lines.append(f"  {_minutes(gap['seconds'])} {gap['cause']}: {gap['after']} → {gap['before']}")
    if diagnostics["waits"]:
        lines.append(
            "Waits: "
            + ", ".join(
                f"{label} {row['count']}x p50 {_minutes(row['median_seconds'])}"
                for label, row in diagnostics["waits"].items()
            )
        )
    for run in diagnostics["benchmarks"]["runs"]:
        lines.append(
            f"Benchmark {run['run_id'][:24]}: {run['passed']}/{run['attempts']} passed, "
            f"{run['tasks']} tasks, p50 {_minutes(run['median_seconds'])}, outcomes {run['outcome_classes']}"
        )
    return lines
