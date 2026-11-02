"""Persist and summarize timed /deploy gate stages."""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import math
import os
import re
import statistics
import sys
import time
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Sequence

# File-spec callers do not add this script's directory to module search paths.
_METADATA_PATH = Path(__file__).resolve().with_name("factory_metadata.py")
_METADATA_SPEC = importlib.util.spec_from_file_location(
    "rose_factory_metadata", _METADATA_PATH
)
if _METADATA_SPEC is None or _METADATA_SPEC.loader is None:
    raise ImportError(f"could not load factory metadata module: {_METADATA_PATH}")
_METADATA_MODULE = importlib.util.module_from_spec(_METADATA_SPEC)
_METADATA_SPEC.loader.exec_module(_METADATA_MODULE)
factory_metadata = _METADATA_MODULE
load_metadata = factory_metadata.load_metadata
ROOT = Path(__file__).resolve().parents[1]

ACTIVE_STATUSES = {"active", "finishing"}


class LifecycleError(RuntimeError):
    """Raised when a deploy timing lifecycle transition is invalid."""


def _validate_identifier(value: str, label: str) -> None:
    allowed = value not in {"", ".", ".."} and re.fullmatch(r"[A-Za-z0-9._-]+", value)
    if not allowed:
        raise LifecycleError(f"invalid {label}: {value}")


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.replace(path)


@contextmanager
def _lifecycle_lock(run_root: Path) -> Iterator[None]:
    run_root.mkdir(parents=True, exist_ok=True)
    lock_path = run_root / ".lifecycle.lock"
    with lock_path.open("a+") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def _read_metadata(run_dir: Path) -> dict:
    metadata_path = run_dir / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text())
    except (json.JSONDecodeError, OSError) as error:
        message = f"could not read deploy metadata for {run_dir.name}: {error}"
        raise LifecycleError(message) from error
    if not isinstance(metadata, dict):
        raise LifecycleError(f"invalid deploy metadata for {run_dir.name}")
    return metadata


def _read_current_run_id(run_root: Path) -> str:
    current_path = run_root / "current"
    try:
        run_id = current_path.read_text().splitlines()[0]
    except (IndexError, OSError) as error:
        raise LifecycleError("no active deploy timing run") from error
    _validate_identifier(run_id, "active deploy run id")
    return run_id


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
        "telemetry": load_metadata(),
        "run_id": run_id,
        "status": "active",
        "started_at": started_at,
        "started_epoch": started_epoch,
        "git_sha": git_sha,
        "branch": branch,
    }
    _write_json_atomic(run_dir / "metadata.json", metadata)


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
    _write_json_atomic(metadata_path, metadata)


def start_lifecycle(
    run_root: Path,
    *,
    run_id: str,
    started_at: str,
    started_epoch: float,
    git_sha: str,
    branch: str,
) -> dict:
    """Initialize a run and publish it only after the metadata is durable.

    The selected factory telemetry snapshot is re-stamped first with this
    launch's head (``observed_at``, ``validation.source_sha``), so the run
    defaults and every stage row carry the head actually launched; the
    returned refresh report says whether and why not. An invalid snapshot
    refuses the run before anything is written.
    """

    _validate_identifier(run_id, "deploy run id")
    with _lifecycle_lock(run_root):
        current_path = run_root / "current"
        stale_pointer = False
        if current_path.exists():
            current_id = _read_current_run_id(run_root)
            current_metadata = _read_metadata(run_root / current_id)
            if current_metadata.get("status") in ACTIVE_STATUSES:
                raise LifecycleError(f"deploy timing run already active: {current_id}")
            stale_pointer = True

        run_dir = run_root / run_id
        metadata_path = run_dir / "metadata.json"
        if metadata_path.exists():
            raise LifecycleError(f"deploy timing run already exists: {run_id}")
        # Only a start that will actually publish this run re-stamps the
        # snapshot: a refused start (run already active) leaves it untouched.
        # A snapshot that cannot be read or rewritten is reported (status
        # "error") and the run still starts; only an invalid one refuses it.
        try:
            refresh = factory_metadata.refresh_selected_snapshot(
                git_sha, producer="run-deploy-stage --start", checkout=ROOT)
        except ValueError as error:
            raise LifecycleError(f"factory metadata snapshot rejected, run not started: {error}") from error
        if stale_pointer:
            current_path.unlink()
        (run_dir / "logs").mkdir(parents=True, exist_ok=True)
        init_run(
            run_dir,
            run_id=run_id,
            started_at=started_at,
            started_epoch=started_epoch,
            git_sha=git_sha,
            branch=branch,
        )
        pointer = current_path.with_name(f".{current_path.name}.{os.getpid()}.tmp")
        pointer.write_text(f"{run_id}\n")
        pointer.replace(current_path)
    return refresh


def admit_stage(run_root: Path, *, token: str, pid: int) -> str:
    """Admit one stage while the current run is active and return its run ID."""

    _validate_identifier(token, "stage admission token")
    if pid <= 0:
        raise LifecycleError(f"invalid stage admission pid: {pid}")
    with _lifecycle_lock(run_root):
        run_id = _read_current_run_id(run_root)
        run_dir = run_root / run_id
        metadata = _read_metadata(run_dir)
        if metadata.get("status") != "active":
            raise LifecycleError(f"deploy timing run is not accepting stages: {run_id}")
        admission_path = run_dir / "admissions" / f"{token}.json"
        if admission_path.exists():
            raise LifecycleError(f"stage admission already exists: {token}")
        _write_json_atomic(
            admission_path,
            {"schema_version": 1, "run_id": run_id, "token": token, "pid": pid},
        )
        return run_id


def release_stage(run_root: Path, *, run_id: str, token: str) -> None:
    """Release a stage admission after its timing record has been appended."""

    _validate_identifier(run_id, "deploy run id")
    _validate_identifier(token, "stage admission token")
    with _lifecycle_lock(run_root):
        admission_path = run_root / run_id / "admissions" / f"{token}.json"
        try:
            admission_path.unlink()
        except FileNotFoundError:
            return


def _pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _active_admissions(run_dir: Path) -> list[str]:
    active: list[str] = []
    admissions_dir = run_dir / "admissions"
    for admission_path in admissions_dir.glob("*.json"):
        try:
            admission = json.loads(admission_path.read_text())
            pid = int(admission["pid"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
            admission_path.unlink(missing_ok=True)
            continue
        if _pid_is_alive(pid):
            active.append(admission_path.name)
        else:
            admission_path.unlink(missing_ok=True)
    return active


def finish_lifecycle(
    run_root: Path,
    *,
    run_id: str,
) -> None:
    """Stop stage admission, wait for admitted stages, and finalize atomically."""

    _validate_identifier(run_id, "deploy run id")
    run_dir = run_root / run_id
    with _lifecycle_lock(run_root):
        current_id = _read_current_run_id(run_root)
        if current_id != run_id:
            raise LifecycleError(f"active deploy run changed from {run_id} to {current_id}")
        metadata = _read_metadata(run_dir)
        status = metadata.get("status")
        if status == "active":
            metadata["status"] = "finishing"
            _write_json_atomic(run_dir / "metadata.json", metadata)
        elif status != "finishing":
            raise LifecycleError(f"deploy timing run is not active: {run_id}")

    while True:
        with _lifecycle_lock(run_root):
            active = _active_admissions(run_dir)
        if not active:
            break
        time.sleep(0.1)

    with _lifecycle_lock(run_root):
        current_id = _read_current_run_id(run_root)
        if current_id != run_id:
            raise LifecycleError(f"active deploy run changed from {run_id} to {current_id}")
        metadata = _read_metadata(run_dir)
        if metadata.get("status") != "finishing":
            raise LifecycleError(f"deploy timing run is not finishing: {run_id}")
        finalize_run(
            run_dir,
            finished_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            finished_epoch=time.time(),
        )
        current_path = run_root / "current"
        if _read_current_run_id(run_root) == run_id:
            current_path.unlink()


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
    telemetry: dict | None = None,
    detail: dict | None = None,
    status: str | None = None,
) -> None:
    row = {
        "schema_version": 1,
        "telemetry": load_metadata() if telemetry is None else telemetry,
        "run_id": run_id,
        "stage": stage,
        "started_at": started_at,
        "finished_at": finished_at,
        "started_epoch": started_epoch,
        "finished_epoch": finished_epoch,
        "duration_seconds": round(max(0.0, finished_epoch - started_epoch), 1),
        "status": status or ("passed" if exit_code == 0 else "failed"),
        "exit_code": exit_code,
        "log": log,
    }
    if detail is not None:
        row["detail"] = detail
    _append_json_line(run_dir / "stages.jsonl", row)


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
    # 13 columns fit every status, including "reused-scoped".
    lines = [f"Deploy run {run_id}", "", "Stage                         Status         Duration  Log"]
    lines.append("----------------------------  -------------  --------  ------------------------------")
    for row in rows:
        lines.append(
            f"{str(row.get('stage', '')):<28}  "
            f"{str(row.get('status', '')):<13}  "
            f"{float(row.get('duration_seconds', 0.0)):>7.1f}s  "
            f"{row.get('log', '')}"
        )
    reused_scoped = _reused_scoped_counts(rows)
    if reused_scoped[0]:
        lines.append("")
        lines.append(_reused_scoped_line(*reused_scoped))
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


def _reused_scoped_counts(rows: Sequence[dict]) -> tuple[dict[str, int], dict[str, int]]:
    """Per-stage counts of ``reused-scoped`` rows and, separately, of those
    whose provenance says the pass came from an earlier timing run."""
    reused_scoped: dict[str, int] = defaultdict(int)
    cross_run: dict[str, int] = defaultdict(int)
    for row in rows:
        if row.get("status") != "reused-scoped":
            continue
        stage = str(row.get("stage", ""))
        reused_scoped[stage] += 1
        reuse = (row.get("detail") or {}).get("reuse") or {}
        if isinstance(reuse, dict) and reuse.get("cross_run"):
            cross_run[stage] += 1
    return reused_scoped, cross_run


def _reused_scoped_line(reused_scoped: dict[str, int], cross_run: dict[str, int]) -> str:
    """The status label stays ``reused-scoped``; the suffix tells humans which
    of those passes were read from an earlier run."""
    line = (
        "Reused lane-scoped passes (inert changes only, not executed on these bytes): "
        + ", ".join(f"{stage}={count}" for stage, count in sorted(reused_scoped.items()))
    )
    if cross_run:
        line += " (cross-run: " + ", ".join(f"{stage}={count}" for stage, count in sorted(cross_run.items())) + ")"
    return line


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
    reused: dict[str, int] = defaultdict(int)
    reused_scoped, cross_run = _reused_scoped_counts([row for _, rows in runs for row in rows])
    for _, rows in runs:
        for row in rows:
            if row.get("status") == "reused":
                reused[str(row.get("stage", ""))] += 1
                continue
            if row.get("status") == "reused-scoped":
                continue
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
    if reused:
        lines.append(
            "Reused exact-input passes: "
            + ", ".join(f"{stage}={count}" for stage, count in sorted(reused.items()))
        )
    if reused_scoped:
        lines.append(_reused_scoped_line(reused_scoped, cross_run))

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
    lifecycle_start = commands.add_parser("lifecycle-start")
    lifecycle_start.add_argument("--run-root", type=Path, required=True)
    lifecycle_start.add_argument("--run-id", required=True)
    lifecycle_start.add_argument("--started-at", required=True)
    lifecycle_start.add_argument("--started-epoch", type=float, required=True)
    lifecycle_start.add_argument("--git-sha", required=True)
    lifecycle_start.add_argument("--branch", required=True)
    lifecycle_admit = commands.add_parser("lifecycle-admit")
    lifecycle_admit.add_argument("--run-root", type=Path, required=True)
    lifecycle_admit.add_argument("--token", required=True)
    lifecycle_admit.add_argument("--pid", type=int, required=True)
    lifecycle_release = commands.add_parser("lifecycle-release")
    lifecycle_release.add_argument("--run-root", type=Path, required=True)
    lifecycle_release.add_argument("--run-id", required=True)
    lifecycle_release.add_argument("--token", required=True)
    lifecycle_finish = commands.add_parser("lifecycle-finish")
    lifecycle_finish.add_argument("--run-root", type=Path, required=True)
    lifecycle_finish.add_argument("--run-id", required=True)
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


def main() -> int:
    args = _parser().parse_args()
    values = vars(args).copy()
    values.pop("command")
    try:
        if args.command == "lifecycle-start":
            started = start_lifecycle(**values)
            if started["status"] == "error":
                print(f"warning: {started['message']}", file=sys.stderr)
            else:
                print(started["message"])
        elif args.command == "lifecycle-admit":
            print(admit_stage(**values))
        elif args.command == "lifecycle-release":
            release_stage(**values)
        elif args.command == "lifecycle-finish":
            finish_lifecycle(**values)
        elif args.command == "init":
            init_run(**values)
        elif args.command == "append":
            append_stage(**values)
        elif args.command == "finalize":
            finalize_run(**values)
        elif args.command == "summary":
            print(render_summary(**values))
        else:
            print(render_history(**values))
    except LifecycleError as error:
        print(f"deploy timing lifecycle error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
