#!/usr/bin/env python3
"""Append-only benchmark experiments ledger.

Every actual launch and end appends one immutable JSON line to
``<git-common>/cloudbench-experiments.jsonl`` so the scorecard can compute the
experiment number, experiments/day and LAST 3 EXPERIMENTS instead of having an
agent type them. Recording is telemetry: it never raises into a benchmark
launch, never rewrites an earlier line and records each (event, id) once.

    python3 scripts/cloudbench_experiments.py record --event launch --id ID --goal G [--field k=v ...]
    python3 scripts/cloudbench_experiments.py backfill-original600 <admission-dir>... [--goal G]
    python3 scripts/cloudbench_experiments.py list [--goal G]
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = "cloudbench-experiment-v1"
EVENTS = ("launch", "end")
LEDGER_NAME = "cloudbench-experiments.jsonl"
# One O_APPEND write below PIPE_BUF stays a single atomic line on local filesystems.
MAX_LINE_BYTES = 3800


def ledger_path(root: Path | str | None = None) -> Path | None:
    """The shared git-common ledger; CLOUDBENCH_EXPERIMENTS_LEDGER overrides it."""
    override = os.environ.get("CLOUDBENCH_EXPERIMENTS_LEDGER")
    if override:
        return Path(override)
    base = Path(root) if root else Path(__file__).resolve().parents[1]
    try:
        common = subprocess.run(
            ["git", "-C", str(base), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return Path(common) / LEDGER_NAME if common else None


def _scalar(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value if not isinstance(value, str) else value[:300]
    if isinstance(value, dict):
        return {str(k)[:60]: _scalar(v) for k, v in list(value.items())[:24]}
    if isinstance(value, (list, tuple)):
        return [_scalar(v) for v in list(value)[:24]]
    return str(value)[:300]


# Identity and clocks the scorecard numbers and orders experiments by.
CORE_FIELDS = ("schema", "event", "id", "recorded_at", "goal", "triggered_at", "ended_at")


def _encode(entry: dict) -> bytes:
    return (json.dumps(entry, sort_keys=True, allow_nan=False) + "\n").encode()


def _fitted_line(entry: dict) -> bytes | None:
    """One complete JSON line within MAX_LINE_BYTES, never a byte-cut partial line.

    Optional fields are dropped (outcome, notes, then the largest remaining
    non-core field) until the line fits; core identity fields are never dropped.
    """
    raw = _encode(entry)
    for key in ("outcome", "notes"):
        if len(raw) <= MAX_LINE_BYTES:
            return raw
        entry.pop(key, None)
        raw = _encode(entry)
    while len(raw) > MAX_LINE_BYTES:
        optional = [k for k in entry if k not in CORE_FIELDS]
        if not optional:
            return None
        entry.pop(max(optional, key=lambda k: (len(_encode({k: entry[k]})), k)))
        raw = _encode(entry)
    return raw


def read(path: Path | None) -> list[dict]:
    """Every well-formed ledger line, in append order; malformed lines are skipped."""
    if path is None:
        return []
    try:
        raw = path.read_text(errors="replace")
    except OSError:
        return []
    entries = []
    for line in raw.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("schema") == SCHEMA and value.get("event") in EVENTS \
                and isinstance(value.get("id"), str):
            entries.append(value)
    return entries


def record(event: str, experiment_id: str, *, ledger: Path | None = None, root=None, **fields) -> dict | None:
    """Append one line for an actual launch/end; an existing (event, id) is kept unchanged.

    Returns the appended or already-recorded entry, or None when the ledger is
    unavailable. Never raises: the ledger must not block or fail a benchmark.
    """
    try:
        if event not in EVENTS or not experiment_id:
            raise ValueError("invalid experiment event")
        path = ledger or ledger_path(root)
        if path is None:
            raise OSError("no git-common ledger location")
        entry = {"schema": SCHEMA, "event": event, "id": str(experiment_id)[:200],
                 "recorded_at": round(time.time(), 3)}
        entry.update({k: _scalar(v) for k, v in fields.items() if v is not None})
        raw = _fitted_line(entry)
        if raw is None:
            raise ValueError("experiment entry cannot fit one atomic ledger line")
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            for existing in read(path):
                if existing["event"] == event and existing["id"] == entry["id"]:
                    return existing
            os.write(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        return entry
    except Exception:  # telemetry only; the scorecard shows a missing launch as UNRECORDED
        return None


def experiments(entries: list[dict], goal: str | None = None) -> list[dict]:
    """Launched experiments (oldest first) with their end merged and a per-goal number."""
    launches, ends = {}, {}
    for entry in entries:
        target = launches if entry["event"] == "launch" else ends
        target.setdefault(entry["id"], entry)
    merged = []
    for ident, launch in launches.items():
        if goal is not None and launch.get("goal") != goal:
            continue
        value = dict(launch)
        end = ends.get(ident)
        if end:
            value["end"] = {k: v for k, v in end.items() if k not in ("schema", "event", "id")}
        merged.append(value)
    merged.sort(key=lambda e: (e.get("triggered_at") or e.get("recorded_at") or 0, e["id"]))
    for number, value in enumerate(merged, 1):
        value["number"] = number
    return merged


# Keep the observed launch rate numeric even in the first goal day; the display
# marks that short observation window as warming without changing its clock.
RATE_MIN_DAYS = 1.0


def launch_rate(goal_experiments: list[dict], now: float) -> dict | None:
    """Verified launches / elapsed goal days since the first recorded trigger."""
    starts = [e.get("triggered_at") for e in goal_experiments if isinstance(e.get("triggered_at"), (int, float))]
    if not starts:
        return None
    days = max(now - min(starts), 0.0) / 86400.0
    count = len(goal_experiments)
    return {"launches": count, "days": days, "per_day": count / days if days else None, "goal_started_at": min(starts),
            "backfilled": sum(bool(e.get("backfilled")) for e in goal_experiments),
            "warming": days < RATE_MIN_DAYS}


def _json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def original600_entries(admission: Path, goal: str) -> list[tuple[str, dict]]:
    """Launch/end fields recovered from an existing sharded admission's own receipts."""
    coordination = _json(admission / "coordination.json")
    if not isinstance(coordination, dict) or coordination.get("schema") != "original600-shard-coordination-v1":
        return []
    starts = [(_json(p) or {}).get("started_at_epoch") for p in sorted(admission.glob("shard-*/attempt-start.safe.json"))]
    starts = [s for s in starts if isinstance(s, (int, float))]
    refs = {(_json(p) or {}).get("source_ref") for p in admission.glob("shard-*/attempt-start.safe.json")} - {None}
    task_refs = {(_json(p) or {}).get("task_ref") for p in admission.glob("shard-*/attempt-start.safe.json")} - {None}
    triggered = min(starts) if starts else coordination.get("started_at")
    launch = dict(goal=goal, kind="sharded", run_dir=str(admission), triggered_at=triggered,
                  scheduled_total=coordination.get("scheduled_total"), controllers=coordination.get("controllers"),
                  source_ref=next(iter(refs)) if len(refs) == 1 else None,
                  task_ref=next(iter(task_refs)) if len(task_refs) == 1 else None,
                  backfilled=True, evidence="coordination.json")
    out = [("launch", launch)]
    ended, how = coordination.get("finished_at"), "coordination.finished_at"
    if not ended:
        for name in ("manual-abort-after-operator-loss.json", "manual-abort.json", "manual-closure.json"):
            receipt = _json(admission / name)
            if isinstance(receipt, dict):
                at = receipt.get("at") or max((r.get("at") or 0 for r in receipt.get("results") or []), default=0)
                if at:
                    ended, how = at, name
                    break
    if ended:
        result = _json(admission / "result.json") or {}
        outcome = {k: result.get(k) for k in ("task_status", "infra_failures", "observed_jobs", "missing_jobs")
                   if result.get(k) is not None}
        aborted = how.startswith("manual") or coordination.get("abort_reason") or coordination.get("terminate_reason")
        out.append(("end", dict(goal=goal, ended_at=ended, state="ABORTED" if aborted else "COMPLETE",
                                outcome=outcome or None, backfilled=True, evidence=how)))
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    rec = sub.add_parser("record")
    rec.add_argument("--event", choices=EVENTS, required=True)
    rec.add_argument("--id", required=True)
    rec.add_argument("--goal")
    rec.add_argument("--field", action="append", default=[], help="key=value (JSON values accepted)")
    back = sub.add_parser("backfill-original600")
    back.add_argument("admission", nargs="+", type=Path)
    back.add_argument("--goal", default="original600")
    back.add_argument("--label", action="append", default=[], metavar="DIR=LABEL",
                      help="operator slice label for an admission directory name")
    show = sub.add_parser("list")
    show.add_argument("--goal")
    for item in (rec, back, show):
        item.add_argument("--ledger", type=Path)
    args = parser.parse_args(argv)
    ledger = args.ledger or ledger_path()
    if args.command == "record":
        fields = {}
        for pair in args.field:
            key, _, value = pair.partition("=")
            try:
                fields[key] = json.loads(value)
            except ValueError:
                fields[key] = value
        if args.goal:
            fields["goal"] = args.goal
        return 0 if record(args.event, args.id, ledger=ledger, **fields) is not None else 1
    if args.command == "backfill-original600":
        written = 0
        labels = dict(item.split("=", 1) for item in args.label if "=" in item)
        for admission in sorted(args.admission, key=lambda p: p.name):
            for event, fields in original600_entries(admission.absolute(), args.goal):
                if event == "launch" and labels.get(admission.name):
                    fields["slice"] = labels[admission.name]
                written += record(event, admission.name, ledger=ledger, **fields) is not None
        print(json.dumps({"ledger": str(ledger), "entries": written}))
        return 0
    for value in experiments(read(ledger), args.goal):
        print(json.dumps(value, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
