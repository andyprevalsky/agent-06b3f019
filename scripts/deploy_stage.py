"""Persist and summarize timed /deploy gate stages."""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Sequence


def _append_json_line(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(row, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(descriptor, payload)
    finally:
        os.close(descriptor)


def init_run(
    run_dir: Path,
    *,
    run_id: str,
    started_at: str,
    started_epoch: float,
    git_sha: str,
    branch: str,
) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "schema_version": 1,
        "run_id": run_id,
        "status": "active",
        "started_at": started_at,
        "started_epoch": started_epoch,
        "git_sha": git_sha,
        "branch": branch,
    }
    (run_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")


def finalize_run(
    run_dir: Path,
    *,
    finished_at: str,
    finished_epoch: float,
) -> None:
    metadata_path = run_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata.update(
        {
            "status": "completed",
            "finished_at": finished_at,
            "finished_epoch": finished_epoch,
        }
    )
    temporary = metadata_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(metadata, indent=2) + "\n")
    temporary.replace(metadata_path)


def append_stage(
    run_dir: Path,
    *,
    run_id: str,
    stage: str,
    started_at: str,
    finished_at: str,
    started_epoch: float,
    finished_epoch: float,
    exit_code: int,
    log: str,
) -> None:
    _append_json_line(
        run_dir / "stages.jsonl",
        {
            "schema_version": 1,
            "run_id": run_id,
            "stage": stage,
            "started_at": started_at,
            "finished_at": finished_at,
            "started_epoch": started_epoch,
            "finished_epoch": finished_epoch,
            "duration_seconds": round(max(0.0, finished_epoch - started_epoch), 1),
            "status": "passed" if exit_code == 0 else "failed",
            "exit_code": exit_code,
            "log": log,
        },
    )


def _load_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _nearest_rank(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile / 100.0 * len(ordered)))
    return ordered[min(rank - 1, len(ordered) - 1)]


def _timing_totals(
    rows: Sequence[dict],
    run_started: float,
    run_finished: float | None = None,
) -> tuple[float, float, float, float]:
    intervals = sorted(
        (
            float(row.get("started_epoch", 0.0)),
            float(row.get("finished_epoch", 0.0)),
        )
        for row in rows
        if float(row.get("finished_epoch", 0.0)) >= float(row.get("started_epoch", 0.0))
    )
    if not intervals:
        return 0.0, 0.0, 0.0, 0.0
    stage_seconds = sum(finished - started for started, finished in intervals)
    union_seconds = 0.0
    merged_start, merged_finish = intervals[0]
    for started, finished in intervals[1:]:
        if started <= merged_finish:
            merged_finish = max(merged_finish, finished)
        else:
            union_seconds += merged_finish - merged_start
            merged_start, merged_finish = started, finished
    union_seconds += merged_finish - merged_start
    final_epoch = run_finished or max(finished for _, finished in intervals)
    wall_seconds = max(0.0, final_epoch - run_started)
    overlap_seconds = max(0.0, stage_seconds - union_seconds)
    gap_seconds = max(0.0, wall_seconds - union_seconds)
    return wall_seconds, stage_seconds, overlap_seconds, gap_seconds


def render_summary(run_dir: Path) -> str:
    rows = sorted(
        _load_rows(run_dir / "stages.jsonl"),
        key=lambda row: float(row.get("started_epoch", 0.0)),
    )
    run_id = run_dir.name
    if not rows:
        return f"Deploy run {run_id}: no timed stages recorded"
    lines = [f"Deploy run {run_id}", "", "Stage                         Status    Duration  Log"]
    lines.append("----------------------------  --------  --------  ------------------------------")
    for row in rows:
        lines.append(
            f"{str(row.get('stage', '')):<28}  "
            f"{str(row.get('status', '')):<8}  "
            f"{float(row.get('duration_seconds', 0.0)):>7.1f}s  "
            f"{row.get('log', '')}"
        )
    metadata_path = run_dir / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text())
    except (json.JSONDecodeError, OSError):
        metadata = {}
    started = float(metadata.get("started_epoch") or min(float(row["started_epoch"]) for row in rows))
    run_finished = metadata.get("finished_epoch") if metadata.get("status") == "completed" else None
    wall_seconds, stage_seconds, overlap_seconds, gap_seconds = _timing_totals(
        rows,
        started,
        float(run_finished) if run_finished is not None else None,
    )
    lines.extend(
        [
            "",
            f"Recorded wall span: {wall_seconds:.1f}s",
            f"Summed stage time: {stage_seconds:.1f}s",
            f"Parallel overlap: {overlap_seconds:.1f}s",
            f"Unrecorded/gap time: {gap_seconds:.1f}s",
            f"Artifacts: {run_dir}",
        ]
    )
    return "\n".join(lines)


def render_history(run_root: Path) -> str:
    runs: list[tuple[Path, list[dict]]] = []
    for path in sorted(run_root.glob("*/stages.jsonl")):
        rows = _load_rows(path)
        if rows:
            runs.append((path.parent, rows))
    if not runs:
        return f"Deploy timing history: no runs recorded under {run_root}"

    durations: dict[str, list[float]] = defaultdict(list)
    passed_durations: dict[str, list[float]] = defaultdict(list)
    passes: dict[str, int] = defaultdict(int)
    for _, rows in runs:
        for row in rows:
            stage = str(row.get("stage", ""))
            duration = row.get("duration_seconds")
            if stage and isinstance(duration, (int, float)):
                durations[stage].append(float(duration))
                passes[stage] += int(row.get("status") == "passed")
                if row.get("status") == "passed":
                    passed_durations[stage].append(float(duration))

    lines = [f"Deploy timing history ({len(runs)} runs)", ""]
    lines.append("Stage                         Runs  Pass    p50(pass)  p90(pass)")
    lines.append("----------------------------  ----  ------  ---------  ---------")
    for stage in sorted(durations):
        values = durations[stage]
        successful = passed_durations[stage]
        pass_rate = passes[stage] / len(values) * 100.0
        if successful:
            timing = (
                f"{statistics.median(successful):>8.1f}s  "
                f"{_nearest_rank(successful, 90.0):>8.1f}s"
            )
        else:
            timing = f"{'n/a':>9}  {'n/a':>9}"
        lines.append(f"{stage:<28}  {len(values):>4}  {pass_rate:>5.1f}%  {timing}")

    run_spans: list[float] = []
    completed_names: list[str] = []
    incomplete_count = 0
    for run_dir, rows in runs:
        try:
            metadata = json.loads((run_dir / "metadata.json").read_text())
        except (json.JSONDecodeError, OSError):
            metadata = {}
        if metadata.get("status") != "completed":
            incomplete_count += 1
            continue
        started = float(metadata.get("started_epoch") or min(float(row["started_epoch"]) for row in rows))
        finished = float(metadata.get("finished_epoch") or max(float(row["finished_epoch"]) for row in rows))
        run_spans.append(max(0.0, finished - started))
        completed_names.append(run_dir.name)
    lines.append("")
    if run_spans:
        lines.append(
            f"Completed run-span p50={statistics.median(run_spans):.1f}s "
            f"p90={_nearest_rank(run_spans, 90.0):.1f}s"
        )
        lines.append("Completed runs: " + ", ".join(completed_names[-10:]))
    else:
        lines.append("Completed run-span history: none yet")
    lines.append(f"Active/incomplete runs excluded from run spans: {incomplete_count}")
    lines.append(f"Artifacts: {run_root}")
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--run-dir", type=Path, required=True)
    init.add_argument("--run-id", required=True)
    init.add_argument("--started-at", required=True)
    init.add_argument("--started-epoch", type=float, required=True)
    init.add_argument("--git-sha", required=True)
    init.add_argument("--branch", required=True)

    append = commands.add_parser("append")
    append.add_argument("--run-dir", type=Path, required=True)
    append.add_argument("--run-id", required=True)
    append.add_argument("--stage", required=True)
    append.add_argument("--started-at", required=True)
    append.add_argument("--finished-at", required=True)
    append.add_argument("--started-epoch", type=float, required=True)
    append.add_argument("--finished-epoch", type=float, required=True)
    append.add_argument("--exit-code", type=int, required=True)
    append.add_argument("--log", required=True)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--run-dir", type=Path, required=True)
    finalize.add_argument("--finished-at", required=True)
    finalize.add_argument("--finished-epoch", type=float, required=True)

    summary = commands.add_parser("summary")
    summary.add_argument("--run-dir", type=Path, required=True)
    history = commands.add_parser("history")
    history.add_argument("--run-root", type=Path, required=True)
    return parser


def main() -> None:
    args = _parser().parse_args()
    values = vars(args).copy()
    values.pop("command")
    if args.command == "init":
        init_run(**values)
    elif args.command == "append":
        append_stage(**values)
    elif args.command == "finalize":
        finalize_run(**values)
    elif args.command == "summary":
        print(render_summary(**values))
    else:
        print(render_history(**values))


if __name__ == "__main__":
    main()
