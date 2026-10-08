#!/usr/bin/env python3
"""Run repeated benchmark tasks through bounded, isolated fleet controllers."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import time
from collections import deque
from collections.abc import Callable
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


def publish_campaign_group(
    root: Path,
    campaign_dir: Path,
    state: dict[str, object],
    *,
    live: bool,
    stop_requested: Callable[[], bool],
) -> bool:
    """The schedule is a real Hub resource; task results remain child-owned."""
    record = {
        "run_id": state["campaign_id"],
        "timestamp": state["started_at"],
        "source": "benchmark-campaign",
        "suite": "cloud-fleet",
        "tasks": [],
        "run_group": {
            "status": state["status"],
            "finished_at": state.get("finished_at"),
            "wall_clock_seconds": state.get("wall_clock_seconds"),
            "outcomes": {
                str(job["job_id"]): {
                    "status": job["status"],
                    "controller_exit_code": job["controller_exit_code"],
                }
                for job in state["jobs"]
            },
            "members": [
                {
                    "member_id": job["job_id"],
                    "name": job["task"],
                    "run_number": job["run"],
                }
                for job in state["jobs"]
            ],
        },
    }
    target = campaign_dir / "hub-group.json"
    write_json_atomic(target, record)
    if stop_requested():
        return False
    environment = os.environ.copy()
    environment.pop("BENCHMARK_HUB_GROUP_RUN_ID", None)
    if not environment.get("BENCHMARK_HUB_API_KEY") and not environment.get(
        "BACKEND_API_KEY"
    ):
        try:
            from dotenv import dotenv_values

            key = dotenv_values(root / "back-end/.env").get("BACKEND_API_KEY")
            if key:
                environment["BACKEND_API_KEY"] = key
        except ImportError:
            pass
    # Load the existing exact auxiliary-session drain before allocating its
    # publisher. A setup exception must never leave a child without an owner.
    spec = importlib.util.spec_from_file_location(
        "campaign_publication_cleanup",
        Path(__file__).with_name("cloudbench-campaign-seed.py"),
    )
    cleanup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cleanup)
    log = campaign_dir / "hub-group-publication.private.log"
    acknowledgement = campaign_dir / "hub-group-publication-ack.private.json"
    publication_token = secrets.token_hex(16)
    completed = False
    with log.open("a") as stream:
        os.chmod(log, 0o600)
        result = subprocess.Popen(
            [
                sys.executable,
                str(root / "agents/benchmarks/hub_upload.py"),
                "--register-starting" if live else "--upload-final",
                str(target),
                "--source",
                "benchmark-campaign",
                "--follow-record-on-cancel",
                "--publication-ack",
                str(acknowledgement),
                "--publication-token",
                publication_token,
            ],
            cwd=root,
            env=environment,
            stdout=stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            while result.returncode is None:
                if stop_requested():
                    break
                try:
                    result.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            try:
                try:
                    if (
                        not live
                        and result.returncode == 0
                        and acknowledgement.is_file()
                    ):
                        ack = json.loads(acknowledgement.read_text())
                        native = subprocess.check_output(
                            ["ps", "-ax", "-o", "pid=,pgid=,stat="], text=True
                        )
                        group_alive = any(
                            int(row.split()[1]) == result.pid
                            and not row.split()[2].startswith("Z")
                            for row in native.splitlines()
                        )
                        completed = not group_alive and ack == {
                            "pid": result.pid,
                            "token": publication_token,
                            "record_sha256": hashlib.sha256(
                                json.dumps(record, sort_keys=True).encode()
                            ).hexdigest(),
                        }
                except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                    # An unavailable or malformed observation cannot commit the
                    # terminal publication or skip cancellation reconciliation.
                    completed = False
                if stop_requested() and not completed:
                    # Give the already-owned publisher the terminal projection
                    # before its existing session drain delivers cancellation.
                    record["run_group"]["status"] = "cancelled"
                    record["run_group"]["finished_at"] = utc_now()
                    if live:
                        for outcome in record["run_group"]["outcomes"].values():
                            if outcome["status"] == "queued":
                                outcome["status"] = "cancelled"
                    write_json_atomic(target, record)
            finally:
                if result.returncode is None:
                    # Keep the leader waitable until its exact session closes,
                    # including exceptional exits. Reuse existing generous cleanup
                    # headroom; no fleet process or new stage deadline is involved.
                    cleanup.stop_get(result)
    if result.returncode:
        print(
            "Warning: campaign Hub schedule publication is pending; child results and cleanup retain their owners"
        )
    elif not live and not completed:
        print(
            "Warning: campaign Hub terminal acknowledgement was not verified; publication remains pending"
        )
    return completed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--runs", type=int, required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--forward-arg", action="append", default=[])
    parser.add_argument("--retry-infra", type=int, default=0)
    parser.add_argument("--e2e-timeout", type=float)
    parser.add_argument("--e2e-started-at", type=float)
    return parser.parse_args()


def released_attempt(root: Path, job: dict[str, object]) -> dict[str, object]:
    """Read the existing physical result and full-release seal, without regrading."""
    try:
        fleet = None
        with Path(str(job["log"])).open(errors="replace") as stream:
            for line in stream:
                if "/scripts/run-bench monitor " not in line:
                    continue
                fields = shlex.split(line.strip())
                if len(fields) >= 3 and fields[0] == str(root / "scripts/run-bench") and fields[1] == "monitor":
                    fleet = Path(fields[2]).resolve()
                    break
        if fleet is None or not fleet.is_relative_to(root / ".context"):
            return {"resources_released": False, "retry_blocked": "physical run handle unavailable"}
        record = json.loads((fleet / "_batch/run.json").read_text())
        lifecycle = json.loads((fleet / "_batch/lifecycle.json").read_text())
        tasks = record.get("tasks") or []
        if len(tasks) != 1 or tasks[0].get("name") != job["task"]:
            raise ValueError("terminal task binding changed")
        task = tasks[0]
        status = str(task.get("benchmark_status") or task.get("status") or "").upper()
        run_id = fleet.name
        owner = lifecycle["fleet_owner_token"]
        audit = Path((fleet / "teardown-ownership.path").read_text().strip()).resolve()
        meta_bytes = (audit / "meta").read_bytes()
        meta = dict(line.split("=", 1) for line in meta_bytes.decode().splitlines())
        epoch_bytes = (audit / "provider-teardown-verified.epoch").read_bytes()
        registry = audit.parent.parent / "cloudbench-fleet-ownership" / owner
        closed = (
            lifecycle.get("run_id") == record.get("run_id") == meta.get("run_id") == run_id
            and lifecycle.get("workspace_root") == meta.get("workspace_root") == str(root)
            and meta.get("fleet_owner_token") == owner == audit.name
            and audit.parent.name == "cloudbench-fleet-audits"
            and meta.get("status") == "provider-teardown-verified"
            and (fleet / "teardown-ownership/meta").read_bytes() == meta_bytes
            and (fleet / "teardown-ownership/provider-teardown-verified.epoch").read_bytes() == epoch_bytes
            and math.isfinite(float(epoch_bytes)) and float(epoch_bytes) > 0
            and not registry.exists() and not registry.is_symlink()
            and lifecycle.get("hub_publication_failed") is False
            and task.get("lifecycle_stage") == "released"
        )
        return {"run_id": run_id, "fleet_dir": str(fleet), "fleet_owner_token": owner,
                "task_status": status, "resources_released": closed,
                "infra_failure": status in {"INFRA_ERROR", "ERROR"} and (task.get("passed") is False or task.get("passed") is None),
                "terminal_task": isinstance(task.get("passed"), bool) and status in {
                    "PASSED", "FAILED", "SUCCEEDED", "SUCCESS", "FAILURE", "TIMED_OUT", "TIMEOUT", "WINDOW_FAILED"},
                "released_at_epoch": float(epoch_bytes) if closed else None}
    except (OSError, ValueError, KeyError, TypeError):
        return {"resources_released": False, "retry_blocked": "terminal result or release remains unverified"}


def terminate_owned_children(active: dict[int, dict[str, object]]) -> None:
    for process_id, job in active.items():
        process = job["_process"]
        assert isinstance(process, subprocess.Popen)
        if process.poll() is None:
            try:
                os.killpg(process_id, signal.SIGTERM)
                job["_terminated_by_campaign"] = True
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
                job["_terminated_by_campaign"] = True
            except ProcessLookupError:
                pass


def start_shared_inventory(
    root: Path, campaign_dir: Path
) -> tuple[subprocess.Popen, object, Path]:
    refresh = int(os.environ.get("CLOUDBENCH_SNAPSHOT_REFRESH_TIMEOUT_SECONDS", "30"))
    lock_wait = int(
        os.environ.get("CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS", str(refresh * 3 + 5))
    )
    seconds = int(os.environ.get("CLOUDBENCH_CHILD_TERM_SECONDS", "30"))
    if refresh < 1 or lock_wait < 1 or seconds < 1:
        raise ValueError("inventory section budgets must be positive")
    directory = campaign_dir / "shared-inventory"
    directory.mkdir(mode=0o700)
    source = directory / "scripts"
    source.mkdir(mode=0o700)
    for name, relative in (
        (
            "cloudbench-campaign-inventory.sh",
            "scripts/cloudbench-campaign-inventory.sh",
        ),
        ("cloudbench-inventory.sh", "scripts/lib/cloudbench-inventory.sh"),
        ("cloudbench-env.sh", "scripts/lib/cloudbench-env.sh"),
        ("cloudbench-machine-readiness.py", "scripts/cloudbench-machine-readiness.py"),
    ):
        shutil.copyfile(root / relative, source / name)
    log = (directory / "publisher.private.log").open("w")
    os.chmod(log.name, 0o600)
    environment = os.environ.copy()
    environment.pop("CLOUDBENCH_CAMPAIGN_INVENTORY_DIR", None)
    process = subprocess.Popen(
        [
            "bash",
            str(source / "cloudbench-campaign-inventory.sh"),
            str(root),
            str(directory),
            str(os.getpid()),
        ],
        cwd=root,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.monotonic() + refresh * 2 + lock_wait
    while not (directory / "owner").is_file():
        if process.poll() is not None or time.monotonic() >= deadline:
            stop_shared_inventory(process, log, directory)
            raise RuntimeError(
                "campaign inventory did not initialize; see private publisher log"
            )
        time.sleep(0.1)
    return process, log, directory


def stop_shared_inventory(
    process: subprocess.Popen, log: object, directory: Path
) -> bool:
    (directory / "stop").touch()
    seconds = int(os.environ.get("CLOUDBENCH_CHILD_TERM_SECONDS", "30"))
    try:
        process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            # This isolated, waitable auxiliary group owns only read-only API
            # processes. Never signal a borrowed fleet or provider resource.
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    finally:
        log.close()
    return process.returncode == 0


def main() -> int:
    args = parse_args()
    if args.runs < 1 or args.concurrency < 1 or not args.task:
        raise SystemExit("runs, concurrency, and at least one task are required")
    if args.retry_infra < 0:
        raise SystemExit("--retry-infra must be a nonnegative integer")
    if args.e2e_timeout is not None and (not math.isfinite(args.e2e_timeout) or args.e2e_timeout <= 0):
        raise SystemExit("--e2e-timeout must be positive finite seconds")
    if args.e2e_started_at is not None and (not math.isfinite(args.e2e_started_at) or args.e2e_started_at > time.time()):
        raise SystemExit("--e2e-started-at must be the original past epoch")
    if args.e2e_started_at is not None and args.e2e_timeout is None:
        raise SystemExit("--e2e-started-at requires --e2e-timeout")
    e2e_started_at = args.e2e_started_at if args.e2e_started_at is not None else time.time()
    e2e_deadline = time.monotonic() + args.e2e_timeout - (time.time() - e2e_started_at) if args.e2e_timeout is not None else None

    def deadline_expired() -> bool:
        return e2e_deadline is not None and time.monotonic() >= e2e_deadline

    root = args.root.resolve()
    requested_id = os.environ.get("RUN_BENCH_CAMPAIGN_ID")
    campaign_id = (
        requested_id
        or datetime.now(timezone.utc).strftime("campaign-%Y%m%d-%H%M%S")
        + f"-{os.getpid()}"
    )
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
                    "attempt": 1,
                    "attempts": [],
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
        "retry_infra": args.retry_infra,
        "e2e_started_at_epoch": e2e_started_at,
        "e2e_timeout_seconds": args.e2e_timeout,
        "e2e_timeout_exceeded": False,
    }
    strict_start = (
        "--strict-barrier" in args.forward_arg
        or os.environ.get("CLOUDBENCH_STRICT_BARRIER") == "1"
    )
    cohorts: list[dict[str, object]] = []
    parent_lock = None
    if strict_start:
        if os.environ.get("CLOUDBENCH_SYNCHRONIZED_START", "1") != "1":
            raise SystemExit(
                "strict campaign startup requires synchronized fleet start"
            )
        barrier_root = campaign_dir / "startup-cohorts"
        barrier_root.mkdir(mode=0o700)
        parent_lock = (barrier_root / "parent.lock").open("w")
        fcntl.flock(parent_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for offset in range(0, len(jobs), args.concurrency):
            cohort_id = f"c{len(cohorts) + 1:03d}"
            members = jobs[offset : offset + args.concurrency]
            directory = barrier_root / cohort_id
            (directory / "ready").mkdir(parents=True, mode=0o700)
            cohort = {
                "cohort_id": cohort_id,
                "status": "queued",
                "ready_count": 0,
                "expected_count": len(members),
                "failed_count": 0,
                "released_count": 0,
                "released_at": None,
                "_directory": directory,
                "_jobs": members,
                "_manifest": {
                    "cohort_id": cohort_id,
                    "jobs": {str(job["job_id"]): None for job in members},
                },
            }
            cohorts.append(cohort)
            write_json_atomic(directory / "manifest.json", cohort["_manifest"])
            for job in members:
                job["startup_cohort"] = cohort_id
                job["startup_ready_at"] = None
                job["_cohort"] = cohort
        state["startup_cohorts"] = cohorts
    write_json_atomic(summary_path, state)
    print(
        f"🧪 benchmark campaign: tasks={len(args.task)} runs={args.runs} "
        f"jobs={len(jobs)} concurrency={args.concurrency}"
    )
    print(f"   summary: {summary_path}")
    if strict_start:
        print(
            f"   strict startup: {len(cohorts)} cohort(s), "
            f"up to {args.concurrency} copies each; every surviving eligible member "
            "must be ready before its cohort releases."
        )
        print(
            "   ordinary terminal member failures stay failed; healthy peers and later "
            "cohorts continue. Keep requested/released/failed counts; partial release "
            "never earns full-width credit."
        )
        print(
            "   native capacity includes existing/stopped Machines and worker "
            "headroom; controller count does not prove task execution overlap."
        )
    print(
        "   monitor every 30s: python3 -m json.tool " + shlex.quote(str(summary_path))
    )
    print(
        "   follow each job log's exact printed fleet-monitor command; "
        "the campaign directory is not a fleet-monitor handle."
    )
    print(
        "   controller status/exit is separate from monitor.task_outcomes; retain genuine task FAIL."
    )
    if args.retry_infra:
        print(f"   INFRA-only retry: at most {args.retry_infra} fresh attempt(s) per task, after original full release and terminal publication; healthy peers continue.")
        print("   attempts keep separate logs/evidence within the original Hub group; genuine task FAIL is not retried and the E2E clock never resets.")
    if args.e2e_timeout is not None:
        print(f"   whole-experiment limit: {args.e2e_timeout:g}s from epoch {e2e_started_at:g}, including image handoff, retries, evidence and full release.")
    print(
        "   keep the original owner on stale cards or retryable startup/publication warnings; reconcile native birth/log growth read-only."
    )
    print(
        "   preserve actual fatal/terminal status; transient observations do not authorize cancellation, restart, or a clock reset."
    )
    print(
        "   continue through required terminal publication and exact browser/provider/local-process release; outcome ACK alone is not completion."
    )
    print(
        "   follow each fleet's _batch/lifecycle.json and teardown-ownership.path; provider-teardown-verified.epoch follows the full release audit."
    )
    print(
        "   for the documented cached 50-copy diagnostic only: execution 300s, allocation-to-full-release hard 1200s per copy; use original native/claim epochs, or the conservative before-claim marker."
    )
    print(
        "   at an explicitly requested hard cutoff, verify release and birth-check before TERM of only the exact owner; otherwise continue unless catastrophic or explicitly cancelled."
    )
    print(
        "   when that original birth is absent with resources retained: scripts/run-bench --recover-stale-owner <exact-token>; keep original receipts, interruption/recovery has zero acceptance credit."
    )

    pending = deque(jobs)
    active: dict[int, dict[str, object]] = {}
    stop_signal = 0
    stop_requests = 0
    termination_requested = False

    def request_stop(signum: int, _frame: object) -> None:
        nonlocal stop_signal, stop_requests
        stop_signal = signum
        stop_requests += 1

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    started = time.monotonic()
    next_heartbeat = started + 10
    first_failure = 0
    barrier_failure = False
    current_cohort: dict[str, object] | None = None

    def abort_startup_cohort(cohort: dict[str, object], reason: str) -> None:
        if cohort["status"] == "released":
            return
        cohort["status"] = "aborted"
        write_json_atomic(
            cohort["_directory"] / "abort.json",
            {
                "cohort_id": cohort["cohort_id"],
                "reason": reason,
                "aborted_at": utc_now(),
            },
        )
        # Waiting fleets observe the marker and exit through their existing
        # owned teardown. Booting fleets do the same on reaching the gate. Do
        # not turn an ordinary cohort startup failure into the user's explicit
        # signal-cancellation path, which can escalate to SIGKILL after 30s.
        for job in cohort["_jobs"]:
            if "_process" in job:
                job["_aborted_by_campaign"] = True

    def release_ready_cohort(cohort: dict[str, object]) -> None:
        if cohort["status"] != "waiting":
            return
        ready_count = 0
        failed_count = 0
        survivors = []
        for job in cohort["_jobs"]:
            if job.get("startup_failed_before_release"):
                failed_count += 1
                continue
            process = job.get("_process")
            if not isinstance(process, subprocess.Popen) or process.poll() is not None:
                return
            survivors.append(job)
            ready = cohort["_directory"] / "ready" / f"{job['job_id']}.json"
            if not ready.is_file():
                continue
            receipt = json.loads(ready.read_text())
            if (
                receipt.get("cohort_id") != cohort["cohort_id"]
                or receipt.get("job_id") != job["job_id"]
                or receipt.get("controller_pid") != process.pid
            ):
                raise ValueError(
                    "startup readiness does not belong to this campaign job"
                )
            ready_count += 1
            job["startup_ready_at"] = receipt["ready_at"]
        if (
            cohort["ready_count"] != ready_count
            or cohort["failed_count"] != failed_count
        ):
            cohort["ready_count"] = ready_count
            cohort["failed_count"] = failed_count
            print(
                f"⏸️ campaign startup {cohort['cohort_id']}: {ready_count}/{cohort['expected_count']} copies ready"
            )
            write_json_atomic(summary_path, state)
        if not survivors:
            cohort["status"] = "failed"
            write_json_atomic(summary_path, state)
            return
        if ready_count != len(survivors):
            return
        cohort["released_at"] = utc_now()
        cohort["released_count"] = ready_count
        write_json_atomic(
            cohort["_directory"] / "release.json",
            {
                "cohort_id": cohort["cohort_id"],
                "released_at": cohort["released_at"],
                "jobs": {str(job["job_id"]): job["_process"].pid for job in survivors},
            },
        )
        cohort["status"] = "released"
        print(
            f"🚦 campaign startup {cohort['cohort_id']}: releasing all {ready_count} ready copies"
        )
        write_json_atomic(summary_path, state)

    classifier = root / "scripts/cloudbench-production-only-tasks.py"
    all_production_only = False
    if classifier.is_file():
        classified = subprocess.run(
            [str(Path(os.sys.executable)), str(classifier), *args.task],
            cwd=root,
            capture_output=True,
        )
        if classified.returncode not in {0, 1}:
            raise SystemExit("campaign production-only classification failed")
        all_production_only = classified.returncode == 0
    inventory_process = None
    inventory_log = None
    inventory_directory = None
    inventory_failure_signalled = False
    try:
        if not os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID") and not os.environ.get(
            "BENCHMARK_HUB_PARENT_RUN_ID"
        ):
            publish_campaign_group(
                root,
                campaign_dir,
                state,
                live=True,
                stop_requested=lambda: bool(stop_signal) or deadline_expired(),
            )
        if (
            not stop_signal
            and not deadline_expired()
            and args.concurrency > 1
            and not all_production_only
            and os.environ.get("CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY", "1") == "1"
        ):
            try:
                inventory_process, inventory_log, inventory_directory = (
                    start_shared_inventory(root, campaign_dir)
                )
                print(
                    "Campaign inventory: one parent-owned native feed for all cloud controllers; capacity and resource mutation checks remain live"
                )
                state["shared_inventory"] = {
                    "directory": str(inventory_directory),
                    "publisher_pid": inventory_process.pid,
                }
            except (OSError, ValueError, RuntimeError):
                first_failure = 1
                barrier_failure = True
                state["shared_inventory_failed"] = True
                print(
                    "Campaign inventory did not initialize; see private publisher log"
                )
            write_json_atomic(summary_path, state)
        while pending or active:
            if deadline_expired() and not state["e2e_timeout_exceeded"]:
                state["e2e_timeout_exceeded"] = True
                request_stop(signal.SIGTERM, None)
                print("Whole-experiment limit reached; no new attempt admitted, exact controllers continue through owned cleanup.")
            if inventory_process is not None and inventory_process.poll() is not None:
                barrier_failure = True
                first_failure = first_failure or 1
                if current_cohort:
                    abort_startup_cohort(
                        current_cohort, "campaign inventory publisher stopped"
                    )
                if not inventory_failure_signalled:
                    # Abort rendezvous first, then signal these exact waitable
                    # controller roots. Their existing EXIT cleanup owns the
                    # resource release. Add no short KILL escalation or new
                    # harness timeout; poll/join cleanup before stopping feed.
                    for job in active.values():
                        process = job["_process"]
                        if process.poll() is None:
                            process.terminate()
                            job["_aborted_by_campaign"] = True
                    inventory_failure_signalled = True
            if strict_start and not active and not barrier_failure and not (pending and pending[0].get("_independent_retry")):
                current_cohort = pending[0]["_cohort"] if pending else None
                if current_cohort:
                    current_cohort["status"] = "waiting"
                    if inventory_directory is not None:
                        try:
                            log = (
                                current_cohort["_directory"]
                                / "seed-preflight.private.log"
                            )
                            with log.open("w") as stream:
                                log.chmod(0o600)
                                result = subprocess.Popen(
                                    [
                                        sys.executable,
                                        str(
                                            root / "scripts/cloudbench-campaign-seed.py"
                                        ),
                                        "prepare",
                                        "--root",
                                        str(root),
                                        "--inventory",
                                        str(inventory_directory),
                                        "--barrier",
                                        str(current_cohort["_directory"]),
                                    ],
                                    cwd=root,
                                    stdout=stream,
                                    stderr=subprocess.STDOUT,
                                )
                                # Keep the original campaign cancellation and
                                # inventory authority live while its owned GET
                                # runs. The helper drains its exact child session.
                                interrupted = False
                                try:
                                    while result.poll() is None:
                                        if not interrupted and (
                                            stop_signal
                                            or deadline_expired()
                                            or inventory_process.poll() is not None
                                        ):
                                            result.terminate()
                                            interrupted = True
                                        try:
                                            result.wait(timeout=0.2)
                                        except subprocess.TimeoutExpired:
                                            pass
                                finally:
                                    if result.poll() is None:
                                        result.terminate()
                                        result.wait()
                            if result.returncode:
                                raise ValueError("canonical fixture preflight failed")
                            current_cohort["_seed_proof"] = (
                                current_cohort["_directory"] / "seed-proof.private.json"
                            )
                        except (OSError, ValueError):
                            first_failure = first_failure or 1
                            barrier_failure = True
                            abort_startup_cohort(
                                current_cohort,
                                "canonical fixture full GET failed before child admission",
                            )
                            print(
                                "Campaign canonical fixture preflight failed; no cohort controller admitted"
                            )
                        write_json_atomic(summary_path, state)
            while (
                pending
                and len(active) < args.concurrency
                and not stop_signal
                and not barrier_failure
                and not deadline_expired()
                and (not strict_start or pending[0].get("_independent_retry") or pending[0]["_cohort"] is current_cohort)
            ):
                job = pending.popleft()
                environment = os.environ.copy()
                # Group membership is distinct from publication ownership. Each
                # child still registers, publishes and acknowledges its own run;
                # the Hub projects these durable members as one campaign.
                environment.update(
                    {
                        "BENCHMARK_HUB_GROUP_RUN_ID": environment.get(
                            "BENCHMARK_HUB_GROUP_RUN_ID"
                        )
                        or safe_id,
                        "RUN_BENCH_CAMPAIGN_STARTED_AT": str(state["started_at"]),
                        "RUN_BENCH_CAMPAIGN_TOTAL_JOBS": str(len(jobs)),
                        "RUN_BENCH_CAMPAIGN_CHILD": "1",
                        "RUN_BENCH_CAMPAIGN_JOB_ID": str(job["job_id"]),
                        "RUN_BENCH_CAMPAIGN_RUN": str(job["run"]),
                        "RUN_BENCH_CAMPAIGN_TASK": str(job["task"]),
                        "CLOUDBENCH_CONTROLLER_LOCK_NAME": str(job["controller_lock"]),
                    }
                )
                if args.retry_infra:
                    environment["RUN_BENCH_CAMPAIGN_ATTEMPT"] = str(job["attempt"])
                else:
                    environment.pop("RUN_BENCH_CAMPAIGN_ATTEMPT", None)
                if inventory_directory is not None:
                    environment["CLOUDBENCH_CAMPAIGN_INVENTORY_DIR"] = str(
                        inventory_directory
                    )
                else:
                    environment.pop("CLOUDBENCH_CAMPAIGN_INVENTORY_DIR", None)
                environment.pop("CLOUDBENCH_CAMPAIGN_SEED_PROOF", None)
                if strict_start and not job.get("_independent_retry"):
                    if current_cohort.get("_seed_proof"):
                        environment["CLOUDBENCH_CAMPAIGN_SEED_PROOF"] = str(
                            current_cohort["_seed_proof"]
                        )
                    environment.update(
                        {
                            "RUN_BENCH_CAMPAIGN_BARRIER_DIR": str(
                                current_cohort["_directory"]
                            ),
                            "RUN_BENCH_CAMPAIGN_COHORT": str(
                                current_cohort["cohort_id"]
                            ),
                        }
                    )
                else:
                    # A new ordinary campaign must not inherit a prior child's
                    # diagnostic rendezvous from the calling shell.
                    environment.pop("RUN_BENCH_CAMPAIGN_BARRIER_DIR", None)
                    environment.pop("RUN_BENCH_CAMPAIGN_COHORT", None)
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
                job["controller_pid"] = process.pid
                job["_log_handle"] = log_handle
                job["_started_monotonic"] = time.monotonic()
                job["started_at"] = utc_now()
                job["status"] = "running"
                active[process.pid] = job
                if strict_start and not job.get("_independent_retry"):
                    current_cohort["_manifest"]["jobs"][str(job["job_id"])] = (
                        process.pid
                    )
                    write_json_atomic(
                        current_cohort["_directory"] / "manifest.json",
                        current_cohort["_manifest"],
                    )
                state["peak_concurrency"] = max(
                    int(state["peak_concurrency"]), len(active)
                )
                print(
                    f"▶ {job['job_id']} task={job['task']} run={job['run']} pid={process.pid}"
                )
                write_json_atomic(summary_path, state)

            if stop_signal and not termination_requested:
                termination_requested = True
                if current_cohort:
                    abort_startup_cohort(current_cohort, "user cancelled campaign")
                if state["e2e_timeout_exceeded"]:
                    # The explicit outer cutoff stops only the known controller
                    # leader. Its EXIT ownership path retains generous cleanup;
                    # no short internal KILL deadline is added.
                    for job in active.values():
                        if job["_process"].poll() is None:
                            job["_process"].terminate()
                            job["_terminated_by_campaign"] = True
                else:
                    terminate_owned_children(active)

            for process_id, job in list(active.items()):
                process = job["_process"]
                assert isinstance(process, subprocess.Popen)
                exit_code = process.poll()
                if exit_code is None:
                    continue
                if exit_code < 0:
                    exit_code = 128 - exit_code
                handle = job.pop("_log_handle")
                handle.close()
                job.pop("_process")
                exited_before_release = strict_start and not job.get("_independent_retry") and job["_cohort"][
                    "status"
                ] not in {"released", "aborted"}
                if exited_before_release:
                    if not args.retry_infra:
                        first_failure = first_failure or exit_code or 1
                    # Keep the failed member and its original custody manifest.
                    # Only release eligibility changes; healthy peers and later
                    # cohorts can still complete, while the campaign stays failed.
                    job["startup_failed_before_release"] = True
                job["status"] = (
                    "cancelled"
                    if job.pop("_terminated_by_campaign", False)
                    or job.pop("_aborted_by_campaign", False)
                    else "failed"
                    if exited_before_release
                    else "passed"
                    if exit_code == 0
                    else "failed"
                )
                job["controller_exit_code"] = exit_code
                job["finished_at"] = utc_now()
                job["wall_clock_seconds"] = round(
                    time.monotonic() - float(job.pop("_started_monotonic")), 3
                )
                active.pop(process_id)
                if args.retry_infra:
                    disposition = released_attempt(root, job)
                    for key in ("run_id", "fleet_dir", "fleet_owner_token", "task_status",
                                "resources_released", "infra_failure", "terminal_task",
                                "released_at_epoch", "retry_blocked"):
                        job.pop(key, None)
                    job.update(disposition)
                    job["attempts"].append({key: job.get(key) for key in (
                        "attempt", "log", "controller_pid", "started_at", "finished_at", "wall_clock_seconds",
                        "controller_exit_code", "status", "run_id", "fleet_dir", "fleet_owner_token", "task_status",
                        "resources_released", "infra_failure", "terminal_task", "released_at_epoch", "retry_blocked")})
                    if disposition.get("resources_released") and disposition.get("terminal_task") and job["status"] != "cancelled":
                        job["status"] = "passed"  # infrastructure health; task verdict is retained separately
                    elif (disposition.get("resources_released") and disposition.get("infra_failure")
                          and job["attempt"] <= args.retry_infra and not stop_signal and not barrier_failure and not deadline_expired()):
                        job["attempt"] += 1
                        job["status"] = "queued"
                        job["log"] = str(campaign_dir / f"{job['job_id']}.attempt-{job['attempt']}.log")
                        job["_independent_retry"] = True
                        pending.appendleft(job)
                        print(f"↻ {job['job_id']} INFRA attempt released; admitting fresh attempt {job['attempt']} without restarting peers")
                    else:
                        first_failure = first_failure or exit_code or 1
                elif exit_code and not first_failure:
                    first_failure = exit_code
                print(
                    f"{'✅' if exit_code == 0 else '❌'} {job['job_id']} "
                    f"task={job['task']} exit={exit_code} "
                    f"wall={job['wall_clock_seconds']}s"
                )
                write_json_atomic(summary_path, state)

            if current_cohort and not barrier_failure and not stop_signal:
                release_ready_cohort(current_cohort)

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
                    f"⏳ campaign liveness active={len(active)} pending={len(pending)} {' '.join(evidence)}"
                )
                next_heartbeat = now + (10 if now - started < 60 else 60)
            if (stop_signal or barrier_failure) and not active:
                break
            time.sleep(0.1)
    finally:
        if active and not termination_requested:
            if current_cohort:
                abort_startup_cohort(current_cohort, "campaign parent is exiting")
            terminate_owned_children(active)
        for job in active.values():
            process = job.get("_process")
            if isinstance(process, subprocess.Popen):
                process.wait()
            handle = job.get("_log_handle")
            if handle is not None:
                handle.close()
        if inventory_process is not None:
            if not stop_shared_inventory(
                inventory_process, inventory_log, inventory_directory
            ):
                first_failure = first_failure or 1
                state["shared_inventory_failed"] = True
        if parent_lock is not None:
            parent_lock.close()

    if barrier_failure:
        for job in pending:
            job["status"] = "cancelled"
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
    publication_completed = False
    if not os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID") and not os.environ.get(
        "BENCHMARK_HUB_PARENT_RUN_ID"
    ):
        # An existing cutoff/cancellation has already closed the controllers.
        # Publish that failed terminal group through the ordinary transport;
        # only a new stop during this handoff invokes its existing session drain.
        # Cleanup can exceed the outer cap, but the run still gets zero credit.
        stops_before_publication = stop_requests
        deadline_before_publication = deadline_expired()
        publication_completed = publish_campaign_group(
            root,
            campaign_dir,
            state,
            live=False,
            stop_requested=lambda: (
                stop_requests > stops_before_publication
                or (not deadline_before_publication and deadline_expired())
            )
            if args.retry_infra or args.e2e_timeout is not None
            else bool(stop_signal),
        )
    if stop_signal and not publication_completed:
        state["status"] = "cancelled"
        result = 128 + stop_signal
    if args.retry_infra and not publication_completed:
        state["status"] = "failed" if not stop_signal else "cancelled"
        result = result or 1
    # Publication is part of the campaign lifetime, including cancellation
    # during its final handoff. Preserve the original child outcomes.
    state["finished_at"] = utc_now()
    state["wall_clock_seconds"] = round(time.monotonic() - started, 3)
    state["e2e_wall_clock_seconds"] = round(time.time() - e2e_started_at, 3)
    if deadline_expired():
        state["e2e_timeout_exceeded"] = True
        state["status"] = "failed"
        result = result or 1
    write_json_atomic(summary_path, state)
    print(
        f"{'✅' if result == 0 else '❌'} campaign {state['status']} "
        f"wall={state['wall_clock_seconds']}s summary={summary_path}"
    )
    return result


if __name__ == "__main__":
    raise SystemExit(main())
