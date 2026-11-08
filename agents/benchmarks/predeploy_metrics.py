"""Scheduling and wall-time history for the local pre-deploy smoke gate."""

from __future__ import annotations

import argparse
import json
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

try:
    from benchmarks import history_ledger
except ImportError:  # loaded by file path: run as a script, or through importlib by a tool
    import importlib.util

    _spec = importlib.util.spec_from_file_location(
        "benchmark_history_ledger", Path(__file__).resolve().with_name("history_ledger.py")
    )
    assert _spec and _spec.loader
    history_ledger = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(history_ledger)

DEFAULT_WINDOW = 10


@dataclass(frozen=True)
class PredeploySchedule:
    tasks: list[str]
    estimated_seconds: dict[str, float]


def _load_task_durations(history_file: Path) -> dict[str, list[float]]:
    durations: dict[str, list[float]] = {}
    for raw_line in history_ledger.read_lines(history_file):  # base file + per-writer shards
        try:
            row = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        task = row.get("task")
        duration = row.get("duration_seconds")
        if not isinstance(task, str):
            continue
        if not isinstance(duration, (int, float)) or duration <= 0:
            continue
        durations.setdefault(task, []).append(float(duration))
    return durations


def schedule_longest_first(
    tasks: Sequence[str],
    *,
    history_file: Path,
    window: int = DEFAULT_WINDOW,
) -> PredeploySchedule:
    """Order known tasks by recent median duration, leaving unknowns stable."""
    if window < 1:
        raise ValueError("window must be at least 1")
    original = list(tasks)
    histories = _load_task_durations(history_file)
    estimates = {
        task: float(statistics.median(histories[task][-window:]))
        for task in original
        if histories.get(task)
    }
    positions = {task: index for index, task in enumerate(original)}
    ordered = sorted(
        original,
        key=lambda task: (
            task not in estimates,
            -estimates.get(task, 0.0),
            positions[task],
        ),
    )
    return PredeploySchedule(tasks=ordered, estimated_seconds=estimates)


def estimate_makespan(
    tasks: Sequence[str],
    estimated_seconds: dict[str, float],
    *,
    concurrency: int,
) -> float:
    """Estimate FIFO semaphore makespan using greedy lane assignment."""
    if concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    lane_ends = [0.0] * concurrency
    for task in tasks:
        lane = min(range(concurrency), key=lane_ends.__getitem__)
        lane_ends[lane] += estimated_seconds.get(task, 0.0)
    return round(max(lane_ends, default=0.0), 1)


def write_run_summary(
    output: Path,
    *,
    run_id: str,
    started_at: str,
    finished_at: str,
    started_epoch: float,
    finished_epoch: float,
    exit_code: int,
    concurrency: int,
    tasks: Sequence[str],
    schedule: Sequence[str],
    git_sha: str,
    runner_log: str,
) -> None:
    summary = {
        "schema_version": 1,
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": round(max(0.0, finished_epoch - started_epoch), 1),
        "status": "passed" if exit_code == 0 else "failed",
        "exit_code": exit_code,
        "concurrency": concurrency,
        "tasks": list(tasks),
        "schedule": list(schedule),
        "git_sha": git_sha,
        "runner_log": runner_log,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(summary, indent=2) + "\n")
    temporary.replace(output)


def _nearest_rank(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, int((percentile / 100.0 * len(ordered)) + 0.999999))
    return ordered[min(rank - 1, len(ordered) - 1)]


def _load_run_summaries(run_root: Path) -> list[dict]:
    summaries: list[dict] = []
    if not run_root.exists():
        return summaries
    for path in run_root.glob("*/summary.json"):
        try:
            row = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(row.get("duration_seconds"), (int, float)):
            summaries.append(row)
    return sorted(summaries, key=lambda row: str(row.get("started_at", "")))


def render_history(
    tasks: Sequence[str],
    *,
    history_file: Path,
    run_root: Path,
    concurrency: int,
    window: int = DEFAULT_WINDOW,
) -> str:
    histories = _load_task_durations(history_file)
    schedule = schedule_longest_first(tasks, history_file=history_file, window=window)
    lines = [f"Pre-deploy smoke history (recent pass window: {window})", ""]
    lines.append(
        "Task timings come from the shared successful benchmark ledger; "
        "it is environment-agnostic and not an end-to-end local baseline."
    )
    lines.append("")
    lines.append("Task                              Runs   p50      p90")
    lines.append("--------------------------------  -----  -------  -------")
    for task in tasks:
        recent = histories.get(task, [])[-window:]
        p50 = statistics.median(recent) if recent else 0.0
        p90 = _nearest_rank(recent, 90.0)
        lines.append(f"{task:<32}  {len(histories.get(task, [])):>5}  {p50:>6.1f}s  {p90:>6.1f}s")

    current = estimate_makespan(tasks, schedule.estimated_seconds, concurrency=concurrency)
    optimized = estimate_makespan(
        schedule.tasks,
        schedule.estimated_seconds,
        concurrency=concurrency,
    )
    lines.extend(
        [
            "",
            f"Schedule ({concurrency} lanes): {' -> '.join(schedule.tasks)}",
            f"Counterfactual task-only estimated makespan: {optimized:.1f}s "
            f"(catalog order {current:.1f}s, savings {max(0.0, current - optimized):.1f}s)",
            "Estimated opportunity assumes reordering does not change task durations; "
            "it excludes isolated-stack startup and teardown.",
        ]
    )

    completed = _load_run_summaries(run_root)
    comparable = [
        row
        for row in completed
        if row.get("tasks") == list(tasks) and row.get("concurrency") == concurrency
    ]
    passed = [float(row["duration_seconds"]) for row in comparable if row.get("status") == "passed"]
    failed_count = sum(row.get("status") != "passed" for row in comparable)
    lines.append("")
    if passed:
        lines.append(
            "Comparable end-to-end local runs: "
            f"{len(comparable)} ({len(passed)} passed, {failed_count} failed), "
            f"passed p50={statistics.median(passed):.1f}s p90={_nearest_rank(passed, 90.0):.1f}s"
        )
        lines.append(f"Artifacts: {run_root}")
    elif comparable:
        lines.append(
            "Comparable end-to-end local runs: "
            f"{len(comparable)} (0 passed, {failed_count} failed); no passing baseline yet"
        )
        lines.append(f"Artifacts: {run_root}")
    else:
        lines.append(
            "Comparable end-to-end local runs: none yet for this exact task set and "
            f"concurrency={concurrency} (future artifacts: {run_root})"
        )
    return "\n".join(lines)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    order = subparsers.add_parser("order")
    order.add_argument("--history-file", type=Path, required=True)
    order.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    order.add_argument("tasks", nargs="+")

    history = subparsers.add_parser("history")
    history.add_argument("--history-file", type=Path, required=True)
    history.add_argument("--run-root", type=Path, required=True)
    history.add_argument("--concurrency", type=int, required=True)
    history.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    history.add_argument("tasks", nargs="+")

    record = subparsers.add_parser("record")
    record.add_argument("--output", type=Path, required=True)
    record.add_argument("--run-id", required=True)
    record.add_argument("--started-at", required=True)
    record.add_argument("--finished-at", required=True)
    record.add_argument("--started-epoch", type=float, required=True)
    record.add_argument("--finished-epoch", type=float, required=True)
    record.add_argument("--exit-code", type=int, required=True)
    record.add_argument("--concurrency", type=int, required=True)
    record.add_argument("--task", action="append", default=[])
    record.add_argument("--schedule-task", action="append", default=[])
    record.add_argument("--git-sha", required=True)
    record.add_argument("--runner-log", required=True)
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    if args.command == "order":
        schedule = schedule_longest_first(
            args.tasks,
            history_file=args.history_file,
            window=args.window,
        )
        print("\n".join(schedule.tasks))
    elif args.command == "history":
        print(
            render_history(
                args.tasks,
                history_file=args.history_file,
                run_root=args.run_root,
                concurrency=args.concurrency,
                window=args.window,
            )
        )
    else:
        write_run_summary(
            args.output,
            run_id=args.run_id,
            started_at=args.started_at,
            finished_at=args.finished_at,
            started_epoch=args.started_epoch,
            finished_epoch=args.finished_epoch,
            exit_code=args.exit_code,
            concurrency=args.concurrency,
            tasks=args.task,
            schedule=args.schedule_task,
            git_sha=args.git_sha,
            runner_log=args.runner_log,
        )


if __name__ == "__main__":
    main()
