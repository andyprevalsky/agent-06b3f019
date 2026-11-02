#!/usr/bin/env python3
"""Record and analyze durable per-step timings for /descend runs."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import statistics
import subprocess
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from factory_detail import parse_event_detail
from record_factory_event import factory_event_payload


SCHEMA_VERSION = 1
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
STEP_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
VALID_STATUSES = ("completed", "failed", "blocked", "interrupted")
TAIL_DEDUPE_BYTES = 1024 * 1024


def git_value(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def repo_root() -> Path:
    root = git_value("rev-parse", "--show-toplevel")
    return Path(root) if root else Path.cwd()


def default_history() -> Path:
    return repo_root() / "agents/benchmarks/history/descend_steps.jsonl"


def default_state_root() -> Path:
    return repo_root() / ".context/descend"


def validate_run_id(value: str) -> str:
    if not RUN_ID_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "run ID must contain only letters, numbers, dot, underscore, or dash"
        )
    return value


def validate_step(value: str) -> str:
    if not STEP_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "step must be an uppercase state name using letters, numbers, and underscore"
        )
    return value


def validate_dimension(value: str, label: str) -> str:
    if not value or len(value) > 128 or any(ord(char) < 32 for char in value):
        raise argparse.ArgumentTypeError(f"{label} must be 1-128 printable characters")
    return value


def parse_time(value: str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"invalid ISO-8601 timestamp: {value}") from error
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp must include a timezone: {value}")
    return parsed.astimezone(timezone.utc)


def iso_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def lane_state_path(state_root: Path, run_id: str, lane: str) -> Path:
    lane_hash = hashlib.sha256(lane.encode()).hexdigest()[:20]
    return state_root / run_id / "timing" / f"{lane_hash}.json"


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    try:
        with temporary.open("w") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_state(path: Path, run_id: str, lane: str) -> dict[str, Any]:
    if not path.exists():
        raise ValueError(f"no active timing lane {lane!r} for run {run_id!r}")
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid timing state at {path}: {error}") from error
    if payload.get("run_id") != run_id or payload.get("lane") != lane:
        raise ValueError(f"timing state identity mismatch at {path}")
    return payload


def record_id(record: dict[str, Any]) -> str:
    identity = {
        key: record[key]
        for key in (
            "workflow",
            "event",
            "value",
            "run_id",
            "lane",
            "epoch",
            "recorded_at",
        )
    }
    encoded = json.dumps(identity, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode()).hexdigest()[:24]


def append_records(path: Path, records: Sequence[dict[str, Any]]) -> list[bool]:
    """Append fsynced lines under one lock, deduplicating safe retries."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        size = os.lseek(descriptor, 0, os.SEEK_END)
        tail_start = max(0, size - TAIL_DEDUPE_BYTES)
        os.lseek(descriptor, tail_start, os.SEEK_SET)
        tail = os.read(descriptor, size - tail_start)
        appended = []
        for record in records:
            marker = f'"record_id":"{record["record_id"]}"'.encode()
            if marker in tail:
                appended.append(False)
                continue
            encoded = (
                json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
            ).encode()
            os.lseek(descriptor, 0, os.SEEK_END)
            written = 0
            while written < len(encoded):
                written += os.write(descriptor, encoded[written:])
            tail = (tail + encoded)[-TAIL_DEDUPE_BYTES:]
            appended.append(True)
        os.fsync(descriptor)
        return appended
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def start_state(
    args: argparse.Namespace, started: datetime, history: Path
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": args.run_id,
        "slice": args.slice,
        "task_count": args.task_count,
        "lane": args.lane,
        "step": args.step,
        "epoch": args.epoch,
        "started_at": iso_time(started),
        "started_epoch": started.timestamp(),
        "started_git_sha": git_value("rev-parse", "HEAD"),
        "branch": git_value("branch", "--show-current"),
        "workspace": os.environ.get("CONDUCTOR_WORKSPACE_NAME", Path.cwd().name),
        "history_file": str(history.resolve()),
    }


def event_metadata(state: dict[str, Any], status: str) -> dict[str, object]:
    return {
        "record_type": "factory_event",
        "run_id": state["run_id"],
        "slice": state["slice"],
        "task_count": state["task_count"],
        "lane": state["lane"],
        "step": state["step"],
        "epoch": state["epoch"],
        "status": status,
    }


def started_record(state: dict[str, Any]) -> dict[str, Any]:
    record = factory_event_payload(
        "descend",
        "stage-start",
        state["step"],
        recorded_epoch=float(state["started_epoch"]),
        metadata=event_metadata(state, "running"),
    )
    record["record_id"] = record_id(record)
    return record


def completed_record(
    state: dict[str, Any],
    finished: datetime,
    status: str,
    *,
    run_terminal: bool,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    duration = finished.timestamp() - float(state["started_epoch"])
    if duration < 0:
        raise ValueError(
            f"finish timestamp {iso_time(finished)} precedes step start "
            f"{state['started_at']}"
        )
    metadata = {
        **event_metadata(state, status),
        "started_at": state["started_at"],
        "finished_at": iso_time(finished),
        "duration_seconds": round(duration, 3),
        "started_git_sha": state["started_git_sha"],
        "finished_git_sha": git_value("rev-parse", "HEAD"),
        "run_terminal": run_terminal,
    }
    record = factory_event_payload(
        "descend",
        "stage-finish",
        state["step"],
        recorded_epoch=finished.timestamp(),
        metadata=metadata,
        detail=detail,
    )
    record["record_id"] = record_id(record)
    return record


def outcome_record(
    state: dict[str, Any],
    finished: datetime,
    status: str,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = event_metadata(state, status)
    record = factory_event_payload(
        "descend",
        "outcome",
        status,
        recorded_epoch=finished.timestamp(),
        metadata=metadata,
        detail=detail,
    )
    record["record_id"] = record_id(record)
    return record


def print_events(records: Sequence[dict[str, Any]]) -> None:
    for record in records:
        print("FACTORY_EVENT " + json.dumps(record, separators=(",", ":")))


def resolve_history(
    args: argparse.Namespace, state: dict[str, Any] | None = None
) -> Path:
    if args.history:
        path = Path(args.history).expanduser().resolve()
        if state is not None and path != Path(state["history_file"]):
            raise ValueError(
                f"history path differs from active lane: {path} != {state['history_file']}"
            )
        return path
    if state is not None:
        return Path(state["history_file"])
    return default_history()


def start(args: argparse.Namespace) -> int:
    state_root = Path(args.state_root).expanduser()
    path = lane_state_path(state_root, args.run_id, args.lane)
    if path.exists():
        raise ValueError(
            f"timing lane {args.lane!r} is already active for run {args.run_id!r}"
        )
    history = resolve_history(args)
    state = start_state(args, parse_time(args.at), history)
    event = started_record(state)
    append_records(history, [event])
    atomic_write_json(path, state)
    print_events([event])
    return 0


def transition(args: argparse.Namespace) -> int:
    state_root = Path(args.state_root).expanduser()
    path = lane_state_path(state_root, args.run_id, args.lane)
    state = load_state(path, args.run_id, args.lane)
    if args.task_count is not None:
        state["task_count"] = args.task_count
    history = resolve_history(args, state)
    boundary = parse_time(args.at)
    record = completed_record(
        state,
        boundary,
        args.status,
        run_terminal=False,
        detail=parse_event_detail(args.detail),
    )

    next_args = argparse.Namespace(
        run_id=args.run_id,
        slice=state["slice"],
        task_count=state["task_count"],
        lane=args.lane,
        step=args.step,
        epoch=args.epoch,
    )
    next_state = start_state(next_args, boundary, history)
    next_event = started_record(next_state)
    append_records(history, [record, next_event])
    atomic_write_json(path, next_state)
    print_events([record, next_event])
    return 0


def remove_finished_state(path: Path) -> None:
    path.unlink()
    timing_dir = path.parent
    try:
        timing_dir.rmdir()
    except OSError:
        pass


def finish(args: argparse.Namespace) -> int:
    state_root = Path(args.state_root).expanduser()
    path = lane_state_path(state_root, args.run_id, args.lane)
    state = load_state(path, args.run_id, args.lane)
    history = resolve_history(args, state)
    finished = parse_time(args.at)
    detail = parse_event_detail(args.detail)
    record = completed_record(
        state,
        finished,
        args.status,
        run_terminal=args.run_terminal,
        detail=detail,
    )
    records = [record]
    if args.run_terminal:
        records.append(outcome_record(state, finished, args.status, detail))
    append_records(history, records)
    remove_finished_state(path)
    print_events(records)
    return 0


def load_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: dict[str, dict[str, Any]] = {}
    for line_number, line in enumerate(
        path.read_text(errors="replace").splitlines(), 1
    ):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"invalid JSONL at {path}:{line_number}: {error}"
            ) from error
        if (
            record.get("record_type") != "factory_event"
            or record.get("workflow") != "descend"
            or record.get("event") != "stage-finish"
        ):
            continue
        identifier = record.get("record_id")
        duration = record.get("duration_seconds")
        if not isinstance(identifier, str) or not isinstance(duration, (int, float)):
            raise ValueError(f"invalid descend step record at {path}:{line_number}")
        records.setdefault(identifier, record)
    return sorted(records.values(), key=lambda record: record["finished_at"])


def percentage_change(recent: float | None, previous: float | None) -> float | None:
    if recent is None or previous is None or previous == 0:
        return None
    return round((recent - previous) / previous * 100, 1)


def trend(values: Sequence[float], window: int) -> dict[str, Any]:
    recent_values = values[-window:]
    previous_values = values[-2 * window : -window]
    recent = round(statistics.median(recent_values), 3) if recent_values else None
    previous = round(statistics.median(previous_values), 3) if previous_values else None
    return {
        "samples": len(values),
        "latest_seconds": round(values[-1], 3) if values else None,
        "recent_median_seconds": recent,
        "previous_median_seconds": previous,
        "change_percent": percentage_change(recent, previous),
    }


def analyze(
    records: Sequence[dict[str, Any]],
    *,
    slice_name: str,
    lane: str,
    task_count: int | None,
    status: str,
    window: int,
) -> dict[str, Any]:
    run_records = [
        record
        for record in records
        if (not slice_name or record["slice"] == slice_name)
        and (not lane or record["lane"] == lane)
        and (task_count is None or record["task_count"] == task_count)
    ]
    selected = [
        record
        for record in run_records
        if status == "all" or record["status"] == status
    ]
    by_step: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in selected:
        by_step[record["step"]].append(record)
    for record in run_records:
        by_run[record["run_id"]].append(record)

    steps = []
    for step, step_records in by_step.items():
        step_records.sort(key=lambda record: record["finished_at"])
        values = [float(record["duration_seconds"]) for record in step_records]
        steps.append({"step": step, **trend(values, window)})
    steps.sort(
        key=lambda row: (
            row["change_percent"] is None,
            -(row["change_percent"] or 0),
            row["step"],
        )
    )

    completed_runs = []
    for run_id, run_records in by_run.items():
        terminal_records = [
            record
            for record in run_records
            if record.get("run_terminal") is True
            and (status == "all" or record["status"] == status)
        ]
        if not terminal_records:
            continue
        terminal = max(terminal_records, key=lambda record: record["finished_at"])
        started = min(parse_time(record["started_at"]) for record in run_records)
        finished = parse_time(terminal["finished_at"])
        completed_runs.append(
            {
                "run_id": run_id,
                "slice": terminal["slice"],
                "status": terminal["status"],
                "finished_at": terminal["finished_at"],
                "duration_seconds": round((finished - started).total_seconds(), 3),
            }
        )
    completed_runs.sort(key=lambda run: run["finished_at"])
    wall_clock = trend(
        [float(run["duration_seconds"]) for run in completed_runs], window
    )
    wall_clock["completed_runs"] = len(completed_runs)

    return {
        "schema_version": SCHEMA_VERSION,
        "history_file": "agents/benchmarks/history/descend_steps.jsonl",
        "slice": slice_name or "all",
        "lane": lane or "all",
        "task_count": task_count if task_count is not None else "all",
        "status": status,
        "window": window,
        "step_records": len(selected),
        "run_wall_clock": wall_clock,
        "steps": steps,
        "runs": completed_runs,
    }


def format_seconds(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 60:
        return f"{value / 60:.1f}m"
    return f"{value:.1f}s"


def format_report(payload: dict[str, Any]) -> str:
    wall = payload["run_wall_clock"]
    change = wall["change_percent"]
    change_text = "—" if change is None else f"{change:+.1f}%"
    lines = [
        f"/descend timing: slice={payload['slice']} lane={payload['lane']} "
        f"tasks={payload['task_count']} status={payload['status']} "
        f"window={payload['window']}",
        "run wall clock: "
        f"{wall['completed_runs']} completed | "
        f"recent {format_seconds(wall['recent_median_seconds'])} | "
        f"previous {format_seconds(wall['previous_median_seconds'])} | "
        f"change {change_text}",
        "",
        f"{'step':42} {'n':>4} {'latest':>10} {'recent':>10} "
        f"{'previous':>10} {'change':>9}",
    ]
    for row in payload["steps"]:
        step_change = row["change_percent"]
        step_change_text = "—" if step_change is None else f"{step_change:+.1f}%"
        lines.append(
            f"{row['step'][:42]:42} {row['samples']:>4} "
            f"{format_seconds(row['latest_seconds']):>10} "
            f"{format_seconds(row['recent_median_seconds']):>10} "
            f"{format_seconds(row['previous_median_seconds']):>10} "
            f"{step_change_text:>9}"
        )
    return "\n".join(lines)


def report(args: argparse.Namespace) -> int:
    history = Path(args.history).expanduser() if args.history else default_history()
    payload = analyze(
        load_records(history),
        slice_name=args.slice,
        lane=args.lane,
        task_count=args.task_count,
        status=args.status,
        window=args.window,
    )
    payload["history_file"] = str(history)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(format_report(payload))
    return 0


def add_storage_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--history", help="override the tracked JSONL history path")
    parser.add_argument(
        "--state-root",
        default=str(default_state_root()),
        help="override the in-progress timing state root",
    )


def add_lane_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--run-id", required=True, type=validate_run_id)
    parser.add_argument(
        "--lane",
        default="main",
        type=lambda value: validate_dimension(value, "lane"),
    )


def add_detail_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--detail",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="allowlisted step outcome detail, e.g. infra_failed=2 scheduled_total=600",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_parser = subparsers.add_parser("start", help="start a timing lane")
    add_lane_args(start_parser)
    start_parser.add_argument(
        "--slice", required=True, type=lambda value: validate_dimension(value, "slice")
    )
    start_parser.add_argument("--task-count", type=int, default=0)
    start_parser.add_argument("--step", required=True, type=validate_step)
    start_parser.add_argument(
        "--epoch",
        required=True,
        type=lambda value: validate_dimension(value, "epoch"),
    )
    start_parser.add_argument("--at", help="explicit ISO-8601 boundary timestamp")
    add_storage_args(start_parser)
    start_parser.set_defaults(handler=start)

    transition_parser = subparsers.add_parser(
        "transition", help="finish the active step and start the next one"
    )
    add_lane_args(transition_parser)
    transition_parser.add_argument("--step", required=True, type=validate_step)
    transition_parser.add_argument(
        "--epoch",
        required=True,
        type=lambda value: validate_dimension(value, "epoch"),
    )
    transition_parser.add_argument(
        "--task-count",
        type=int,
        help="set the resolved task count on the active and next step",
    )
    transition_parser.add_argument(
        "--status", choices=VALID_STATUSES, default="completed"
    )
    transition_parser.add_argument("--at", help="explicit ISO-8601 boundary timestamp")
    add_detail_arg(transition_parser)
    add_storage_args(transition_parser)
    transition_parser.set_defaults(handler=transition)

    finish_parser = subparsers.add_parser("finish", help="finish a timing lane")
    add_lane_args(finish_parser)
    finish_parser.add_argument("--status", choices=VALID_STATUSES, default="completed")
    finish_parser.add_argument(
        "--run-terminal",
        action="store_true",
        help="mark this lane closure as the terminal boundary for the run",
    )
    finish_parser.add_argument("--at", help="explicit ISO-8601 boundary timestamp")
    add_detail_arg(finish_parser)
    add_storage_args(finish_parser)
    finish_parser.set_defaults(handler=finish)

    report_parser = subparsers.add_parser("report", help="compare recent timing trends")
    report_parser.add_argument("--slice", default="")
    report_parser.add_argument("--lane", default="")
    report_parser.add_argument("--task-count", type=int)
    report_parser.add_argument(
        "--status", choices=("all", *VALID_STATUSES), default="completed"
    )
    report_parser.add_argument("--window", type=int, default=5)
    report_parser.add_argument("--json", action="store_true")
    add_storage_args(report_parser)
    report_parser.set_defaults(handler=report)

    args = parser.parse_args()
    task_count = getattr(args, "task_count", None)
    if task_count is not None and task_count < 0:
        parser.error("--task-count must be non-negative")
    if getattr(args, "window", 1) <= 0:
        parser.error("--window must be positive")
    return args


def main() -> int:
    args = parse_args()
    try:
        return args.handler(args)
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f"descend step logging failed: {error}") from error


if __name__ == "__main__":
    raise SystemExit(main())
