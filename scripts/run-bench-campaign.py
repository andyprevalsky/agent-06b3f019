#!/usr/bin/env python3
"""Run repeated benchmark tasks through bounded, isolated fleet controllers."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def public_value(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: public_value(item)
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, list):
        return [public_value(item) for item in value]
    return value


def write_json_atomic(path: Path, value: dict[str, object]) -> None:
    temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(public_value(value), indent=2) + "\n")
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--runs", type=int, required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--forward-arg", action="append", default=[])
    return parser.parse_args()


def terminate_owned_children(active: dict[int, dict[str, object]]) -> None:
    for process_id, job in active.items():
        process = job["_process"]
        assert isinstance(process, subprocess.Popen)
        if process.poll() is None:
            try:
                os.killpg(process_id, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if all(
            isinstance(job["_process"], subprocess.Popen)
            and job["_process"].poll() is not None
            for job in active.values()
        ):
            return
        time.sleep(0.1)
    for process_id, job in active.items():
        process = job["_process"]
        assert isinstance(process, subprocess.Popen)
        if process.poll() is None:
            try:
                os.killpg(process_id, signal.SIGKILL)
            except ProcessLookupError:
                pass


def main() -> int:
    args = parse_args()
    if args.runs < 1 or args.concurrency < 1 or not args.task:
        raise SystemExit("runs, concurrency, and at least one task are required")

    root = args.root.resolve()
    requested_id = os.environ.get("RUN_BENCH_CAMPAIGN_ID")
    campaign_id = requested_id or datetime.now(timezone.utc).strftime(
        "campaign-%Y%m%d-%H%M%S"
    ) + f"-{os.getpid()}"
    safe_id = "".join(
        character if character.isalnum() or character in "._-" else "-"
        for character in campaign_id
    ).strip(".-")
    if not safe_id:
        raise SystemExit("campaign id has no safe characters")
    campaign_root = Path(
        os.environ.get(
            "RUN_BENCH_CAMPAIGN_ROOT",
            root / ".context" / "benchmarks" / "campaigns",
        )
    )
    campaign_dir = campaign_root / safe_id
    campaign_dir.mkdir(parents=True, exist_ok=False)
    summary_path = campaign_dir / "summary.json"
    lock_prefix = hashlib.sha256(safe_id.encode()).hexdigest()[:12]

    jobs: list[dict[str, object]] = []
    index = 0
    for run_number in range(1, args.runs + 1):
        for task in args.task:
            index += 1
            job_id = f"r{run_number:03d}-j{index:04d}"
            jobs.append(
                {
                    "index": index,
                    "job_id": job_id,
                    "task": task,
                    "run": run_number,
                    "status": "queued",
                    "controller_exit_code": None,
                    "started_at": None,
                    "finished_at": None,
                    "wall_clock_seconds": None,
                    "controller_lock": (
                        f"cloudbench-controller-campaign-{lock_prefix}-{index}.lock"
                    ),
                    "log": str(campaign_dir / f"{job_id}.log"),
                }
            )

    state: dict[str, object] = {
        "campaign_id": safe_id,
        "started_at": utc_now(),
        "finished_at": None,
        "status": "running",
        "runs": args.runs,
        "concurrency": args.concurrency,
        "task_count": len(args.task),
        "total_jobs": len(jobs),
        "peak_concurrency": 0,
        "jobs": jobs,
    }
    write_json_atomic(summary_path, state)
    print(
        f"🧪 benchmark campaign: tasks={len(args.task)} runs={args.runs} "
        f"jobs={len(jobs)} concurrency={args.concurrency}"
    )
    print(f"   summary: {summary_path}")

    pending = deque(jobs)
    active: dict[int, dict[str, object]] = {}
    stop_signal = 0

    def request_stop(signum: int, _frame: object) -> None:
        nonlocal stop_signal
        stop_signal = signum

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    started = time.monotonic()
    next_heartbeat = started + 10
    first_failure = 0

    try:
        while pending or active:
            while pending and len(active) < args.concurrency and not stop_signal:
                job = pending.popleft()
                environment = os.environ.copy()
                environment.update(
                    {
                        "RUN_BENCH_CAMPAIGN_CHILD": "1",
                        "RUN_BENCH_CAMPAIGN_JOB_ID": str(job["job_id"]),
                        "RUN_BENCH_CAMPAIGN_RUN": str(job["run"]),
                        "RUN_BENCH_CAMPAIGN_TASK": str(job["task"]),
                        "CLOUDBENCH_CONTROLLER_LOCK_NAME": str(
                            job["controller_lock"]
                        ),
                        "BENCHMARK_HUB_PARENT_RUN_ID": safe_id,
                    }
                )
                command = [
                    "bash",
                    str(root / "scripts" / "run-bench"),
                    str(job["task"]),
                    *args.forward_arg,
                    "--foreground",
                ]
                log_handle = open(str(job["log"]), "w", encoding="utf-8")
                process = subprocess.Popen(
                    command,
                    cwd=root,
                    env=environment,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                job["_process"] = process
                job["_log_handle"] = log_handle
                job["_started_monotonic"] = time.monotonic()
                job["started_at"] = utc_now()
                job["status"] = "running"
                active[process.pid] = job
                state["peak_concurrency"] = max(
                    int(state["peak_concurrency"]), len(active)
                )
                print(
                    f"▶ {job['job_id']} task={job['task']} run={job['run']} "
                    f"pid={process.pid}"
                )
                write_json_atomic(summary_path, state)

            if stop_signal:
                terminate_owned_children(active)

            for process_id, job in list(active.items()):
                process = job["_process"]
                assert isinstance(process, subprocess.Popen)
                exit_code = process.poll()
                if exit_code is None:
                    continue
                handle = job.pop("_log_handle")
                handle.close()
                job.pop("_process")
                job["status"] = "passed" if exit_code == 0 else "failed"
                job["controller_exit_code"] = exit_code
                job["finished_at"] = utc_now()
                job["wall_clock_seconds"] = round(
                    time.monotonic() - float(job.pop("_started_monotonic")), 3
                )
                active.pop(process_id)
                if exit_code and not first_failure:
                    first_failure = exit_code
                print(
                    f"{'✅' if exit_code == 0 else '❌'} {job['job_id']} "
                    f"task={job['task']} exit={exit_code} "
                    f"wall={job['wall_clock_seconds']}s"
                )
                write_json_atomic(summary_path, state)

            now = time.monotonic()
            if active and now >= next_heartbeat:
                evidence = []
                for process_id, job in active.items():
                    try:
                        output_bytes = Path(str(job["log"])).stat().st_size
                    except OSError:
                        output_bytes = -1
                    evidence.append(
                        f"{job['job_id']}:pid={process_id}:bytes={output_bytes}"
                    )
                print(
                    f"⏳ campaign liveness active={len(active)} "
                    f"pending={len(pending)} {' '.join(evidence)}"
                )
                next_heartbeat = now + (10 if now - started < 60 else 60)
            if stop_signal and not active:
                break
            time.sleep(0.1)
    finally:
        if active:
            terminate_owned_children(active)
        for job in active.values():
            handle = job.get("_log_handle")
            if handle is not None:
                handle.close()

    if stop_signal:
        for job in pending:
            job["status"] = "cancelled"
        state["status"] = "cancelled"
        result = 128 + stop_signal
    else:
        state["status"] = "passed" if first_failure == 0 else "failed"
        result = first_failure
    state["finished_at"] = utc_now()
    state["wall_clock_seconds"] = round(time.monotonic() - started, 3)
    write_json_atomic(summary_path, state)
    print(
        f"{'✅' if result == 0 else '❌'} campaign {state['status']} "
        f"wall={state['wall_clock_seconds']}s summary={summary_path}"
    )
    return result


if __name__ == "__main__":
    raise SystemExit(main())
