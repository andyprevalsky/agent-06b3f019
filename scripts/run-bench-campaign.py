#!/usr/bin/env python3
"""Run repeated benchmark tasks through bounded, isolated fleet controllers."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import inspect
import json
import math
import os
import re
import runpy
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import time
import tempfile
from collections import deque
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType


def native_hub_owner_retired(owner, runs, root):
    """Recognize current absence, never synthesize a historical Hub termination."""
    import stat
    if owner.is_symlink() or owner.resolve(strict=True) != owner or not owner.is_file():
        raise ValueError('native Hub owner path changed')
    info = owner.stat()
    rows = [line.split('=', 1) for line in owner.read_text().splitlines()]
    fields = dict(rows)
    required = {'version','pid','pid_start','pgid','owner_token','command','argv_sha256',
                'root','runs_root','repo_root','context_dir','host','port','status'}
    if len(rows) != len(fields) or set(fields) != required:
        raise ValueError('native Hub owner fields')
    pid, pgid, port = (int(fields[key]) for key in ('pid','pgid','port'))
    token = fields['owner_token']
    expected = {'root':runs,'runs_root':runs,'repo_root':root,'context_dir':runs/'_hub',
                'command':root/'agents/benchmarks/agent_link_server.py'}
    if (info.st_uid != os.getuid() or pid <= 1 or pgid != pid or not 1 <= port <= 65535
            or fields['version'] != '1' or fields['host'] != '127.0.0.1'
            or fields['status'] not in {'starting','live-transfer-required'}
            or not re.fullmatch('[0-9a-f]{32}', token)
            or not re.fullmatch('[0-9a-f]{64}', fields['argv_sha256'])
            or any(fields[key] != str(value) for key,value in expected.items())
            or owner.parent != runs/'_hub'
            or owner.name != f'agent-link-server.{port}.{token}.owner'
            or stat.S_IMODE(info.st_mode) != (0o644 if fields['status']=='starting' else 0o444)):
        raise ValueError('native Hub owner binding')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not re.fullmatch('proc-start:'+re.escape(boot)+':[0-9]+', fields['pid_start']):
        raise ValueError('native Hub owner boot identity')
    try:
        (Path('/proc')/str(pid)/'stat').read_text()
    except FileNotFoundError:
        pass
    else:
        return False  # Live or reused PID must satisfy the existing live protocol.
    groups = subprocess.check_output(['ps','-ax','-o','pgid='],text=True)
    if any(int(value) == pgid for value in groups.split()):
        return False  # Never skip a remaining or reused group.
    return True


def join_native_hubs(root, campaign):
    """Join only this native request's Hub through its existing exact-owner protocol."""
    if os.environ.get('DEPLOY_NATIVE_HUB_JOIN') != '1':
        return True
    runs = Path(os.environ.get('CLOUDBENCH_RUNS_ROOT', ''))
    # deploy_test_cloud.launch owns <request>/ (first attempt) and <request>/rerun/ (its single rerun).
    base = runs.parent
    rerun = base.name == 'rerun'
    request = base.parent if rerun else base
    if (not runs.is_absolute() or runs.resolve() != runs
            or not re.fullmatch('[0-9a-f]{64}', request.name)
            or request != root/'.context/deploy-cloud'/request.name or runs != base/'runs'
            or campaign != base/'campaigns'/('deploy-'+request.name+('-rerun' if rerun else ''))):
        raise ValueError('native Hub join root is not request-owned')
    hub = runs/'_hub'
    if hub.is_symlink():
        raise ValueError('native Hub root is a symlink')
    failures = []
    for owner in sorted(hub.glob('agent-link-server.*.owner')):
        try:
            if owner.is_symlink() or owner.resolve().parent != hub:
                raise ValueError('native Hub owner path changed')
            rows = [line.split('=', 1) for line in owner.read_text().splitlines()]
            fields = dict(rows)
            if len(rows) != len(fields):
                raise ValueError('duplicate native Hub owner fields')
            if native_hub_owner_retired(owner, runs, root):
                continue
            subprocess.run(['bash', '-c', 'source "$1"; cloudbench_terminate_central_hub_owner "$2" "$3" "$4" "$5" 10',
                            'native-hub-join', str(root/'scripts/lib/cloudbench-env.sh'), fields['port'],
                            str(runs), str(root), str(owner)], check=True)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failures.append(f'{owner.name}: {type(error).__name__}')
    if failures:
        raise ValueError('native Hub join incomplete: ' + '; '.join(failures))
    return True


def startup_deadline_monotonic(env, e2e_started_at, e2e_timeout, *, now_epoch, now_monotonic):
    """Translate the supervisor's source-bound absolute startup fence once."""
    value = env.get("RUN_BENCH_CAMPAIGN_STARTUP_DEADLINE_EPOCH")
    if value is None:
        return None
    deadline = float(value)
    if not math.isfinite(deadline) or e2e_timeout is None or not e2e_started_at < deadline < e2e_started_at + e2e_timeout:
        raise ValueError("invalid bound startup deadline")
    return now_monotonic + deadline - now_epoch


def rejoin_required_cohort(job):
    """A released failed attempt may retry, but never bypass its original barrier."""
    ready = job["_cohort"]["_directory"] / "ready" / (str(job["job_id"]) + ".json")
    if ready.exists():
        receipt = json.loads(ready.read_text())
        if ready.is_symlink() or receipt.get("controller_pid") != job["controller_pid"] or receipt.get("job_id") != job["job_id"]:
            raise ValueError("retry readiness does not belong to previous attempt")
        # Preserve prior readiness as evidence; publish a fresh PID receipt on retry.
        archived = ready.with_name(str(job["job_id"]) + ".attempt-" + str(job["attempt"] - 1) + ".json")
        os.link(ready, archived)
        ready.unlink()
    job.pop("startup_failed_before_release", None)
    job["_independent_retry"] = False
    job["startup_ready_at"] = None


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


# Sharded campaigns: an operator runs K campaigns that form one Hub group and
# one externally released startup cohort. Unset variables keep the original
# single-campaign behaviour; children and nested canaries never inherit them.
CAMPAIGN_SHARD_VARIABLES = (
    "RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER",
    "RUN_BENCH_CAMPAIGN_TASK_INDEXES",
    "RUN_BENCH_CAMPAIGN_GROUP_TOTAL",
    "RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT",
)
EXTERNAL_BARRIER_READY_SCHEMA = "campaign-external-barrier-ready-v1"
EXTERNAL_BARRIER_RELEASE_SCHEMA = "campaign-external-barrier-release-v1"
EXTERNAL_BARRIER_ABORT_SCHEMA = "campaign-external-barrier-abort-v1"
HUB_GROUP_MAX_MEMBERS = 100000  # The Hub's own schedule/member bound.
# The Hub schedule contract (back-end benchmarkHubRunProjection.runGroupSchedule).
# It rejects any other value permanently, so a producer must never publish one.
HUB_GROUP_STATUSES = ("running", "passed", "failed", "cancelled")
HUB_GROUP_OUTCOME_STATUSES = ("queued", "running", "passed", "failed", "cancelled")


def campaign_jobs(
    tasks: list[str],
    runs: int,
    task_indexes: list[int] | None = None,
    task_total: int | None = None,
) -> list[dict[str, object]]:
    """The exact ordered schedule a campaign admits: every task, run by run.

    With task_indexes (each task's 0-based position in the full manifest of
    task_total names), job IDs are the ones a single controller would assign
    to those tasks for the whole manifest, so shards never collide.
    """
    if type(runs) is not int or runs < 1:
        raise ValueError("campaign runs must be a positive integer")
    if (
        not isinstance(tasks, (list, tuple))
        or not tasks
        or any(not isinstance(task, str) for task in tasks)
    ):
        raise ValueError("campaign tasks must be a nonempty list of names")
    if task_indexes is None:
        if task_total is not None:
            raise ValueError("campaign task total requires task indexes")
        positions, width = list(range(len(tasks))), len(tasks)
    else:
        if type(task_total) is not int or task_total < 1:
            raise ValueError("campaign task indexes require the manifest task total")
        positions, width = list(task_indexes), task_total
        if (
            len(positions) != len(tasks)
            or any(type(value) is not int or not 0 <= value < width for value in positions)
            or len(set(positions)) != len(positions)
        ):
            raise ValueError(
                "campaign task indexes must be distinct manifest positions, one per task"
            )
    jobs: list[dict[str, object]] = []
    for run_number in range(1, runs + 1):
        for task, position in zip(tasks, positions):
            index = (run_number - 1) * width + position + 1
            jobs.append(
                {
                    "index": index,
                    "job_id": f"r{run_number:03d}-j{index:04d}",
                    "task": task,
                    "run": run_number,
                }
            )
    return jobs


def sharded_campaign_jobs(
    shards: list[dict[str, object]], task_total: int
) -> list[dict[str, object]]:
    """All shard schedules as one group, in single-controller job order."""
    combined: list[dict[str, object]] = []
    for shard in shards:
        combined.extend(
            campaign_jobs(shard["tasks"], shard["runs"], shard["task_indexes"], task_total)
        )
    identifiers = [job["job_id"] for job in combined]
    if not combined or len(identifiers) > HUB_GROUP_MAX_MEMBERS:
        raise ValueError("sharded campaign member count is outside the Hub bound")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("sharded campaign job IDs are not unique")
    return sorted(combined, key=lambda job: job["index"])


def campaign_group_timestamp(epoch: object) -> str:
    """The one Hub group timestamp derived from the operator's shared epoch."""
    if (
        isinstance(epoch, bool)
        or not isinstance(epoch, (int, float))
        or not math.isfinite(epoch)
        or epoch <= 0
    ):
        raise ValueError("campaign group start must be a positive finite epoch")
    return datetime.fromtimestamp(float(epoch), timezone.utc).isoformat()


def campaign_group_state(
    group_run_id: str,
    group_started_at: float,
    jobs: list[dict[str, object]],
    *,
    status: str = "running",
    finished_at: str | None = None,
    wall_clock_seconds: float | None = None,
) -> dict[str, object]:
    """State accepted by publish_campaign_group for an operator-owned group."""
    if not isinstance(group_run_id, str) or not re.fullmatch(
        r"[A-Za-z0-9._-]+", group_run_id
    ):
        raise ValueError("invalid campaign group identity")
    identifiers = [job["job_id"] for job in jobs]
    if not jobs or len(set(identifiers)) != len(identifiers):
        raise ValueError("campaign group members must be nonempty and unique")
    return {
        "campaign_id": group_run_id,
        "started_at": campaign_group_timestamp(group_started_at),
        "status": status,
        "finished_at": finished_at,
        "wall_clock_seconds": wall_clock_seconds,
        "jobs": [
            {
                "job_id": job["job_id"],
                "task": job["task"],
                "run": job["run"],
                "status": job.get("status", "queued"),
                "controller_exit_code": job.get("controller_exit_code"),
            }
            for job in jobs
        ],
    }


def campaign_shard_settings(
    environment: Mapping[str, str],
    *,
    tasks: list[str],
    runs: int,
    concurrency: int,
    strict: bool,
) -> dict[str, object]:
    """Validate the shard environment before any campaign artifact exists."""
    job_count = len(tasks) * runs
    settings: dict[str, object] = {
        "external_barrier": None,
        "task_indexes": None,
        "task_total": None,
        "group_total": None,
        "group_started_at": None,
    }
    raw_barrier = environment.get("RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER")
    if raw_barrier is not None:
        directory = Path(raw_barrier)
        if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER must be an existing absolute directory"
            )
        if not strict or job_count > concurrency:
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER requires --strict-barrier with exactly one startup cohort"
            )
        settings["external_barrier"] = directory
    raw_total = environment.get("RUN_BENCH_CAMPAIGN_GROUP_TOTAL")
    raw_started = environment.get("RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT")
    if (raw_total is not None or raw_started is not None) and not environment.get(
        "BENCHMARK_HUB_GROUP_RUN_ID"
    ):
        # Without a preset group this campaign would publish its own schedule,
        # which can never match a total or timestamp shared with other shards.
        raise ValueError(
            "RUN_BENCH_CAMPAIGN_GROUP_TOTAL/STARTED_AT require a preset BENCHMARK_HUB_GROUP_RUN_ID"
        )
    if raw_total is not None:
        if not re.fullmatch(r"[1-9][0-9]{0,5}", raw_total) or not (
            job_count <= int(raw_total) <= HUB_GROUP_MAX_MEMBERS
        ):
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_GROUP_TOTAL must be an integer group size covering this shard"
            )
        settings["group_total"] = int(raw_total)
    if raw_started is not None:
        try:
            settings["group_started_at"] = campaign_group_timestamp(float(raw_started))
        except ValueError:
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT must be a positive finite epoch"
            ) from None
    raw_indexes = environment.get("RUN_BENCH_CAMPAIGN_TASK_INDEXES")
    if raw_indexes is not None:
        total = settings["group_total"]
        if total is None or total % runs:
            # Single-controller IDs need the whole manifest width: total / runs.
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_TASK_INDEXES requires RUN_BENCH_CAMPAIGN_GROUP_TOTAL as a multiple of --runs"
            )
        fields = raw_indexes.split(",")
        if any(not re.fullmatch(r"0|[1-9][0-9]{0,5}", field) for field in fields):
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_TASK_INDEXES must be comma-separated non-negative integers"
            )
        indexes = [int(field) for field in fields]
        try:
            campaign_jobs(tasks, runs, indexes, total // runs)
        except ValueError:
            raise ValueError(
                "RUN_BENCH_CAMPAIGN_TASK_INDEXES must be distinct manifest positions, one per --task"
            ) from None
        settings["task_indexes"] = indexes
        settings["task_total"] = total // runs
    return settings


def external_barrier_release_id(directory: Path) -> str | None:
    """A valid coordinator release; an incompletely written file is not yet one."""
    path = directory / "release.json"
    if path.is_symlink():
        raise ValueError("external barrier release is not a regular file")
    try:
        raw = path.read_text()
    except FileNotFoundError:
        return None
    try:
        receipt = json.loads(raw)
    except ValueError:
        return None
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != EXTERNAL_BARRIER_RELEASE_SCHEMA
        or not isinstance(receipt.get("release_id"), str)
        or not re.fullmatch(r"[0-9a-f]{8,128}", receipt["release_id"])
    ):
        raise ValueError("external barrier release is invalid")
    return receipt["release_id"]


def external_barrier_abort(directory: Path) -> dict[str, object] | None:
    """Any abort request before release aborts; its contents are evidence only."""
    path = directory / "abort.json"
    if not path.exists() and not path.is_symlink():
        return None
    try:
        request = json.loads(path.read_text())
    except (OSError, ValueError):
        return {"reason": "unreadable external abort request", "release_id": None}
    if (
        not isinstance(request, dict)
        or request.get("schema") != EXTERNAL_BARRIER_ABORT_SCHEMA
        or not isinstance(request.get("reason"), str)
    ):
        return {"reason": "invalid external abort request", "release_id": None}
    release_id = request.get("release_id")
    return {
        "reason": request["reason"] or "external abort requested",
        "release_id": release_id if isinstance(release_id, str) else None,
    }


def campaign_group_record(state: dict[str, object]) -> dict[str, object]:
    """The Hub schedule record; members carry no task results.

    Every producer builds its record here, so a value the Hub contract would
    reject permanently fails before any write or upload, naming the value.
    """
    if state["status"] not in HUB_GROUP_STATUSES:
        raise ValueError(
            f"campaign group status {state['status']!r} is not a Hub group status {HUB_GROUP_STATUSES}"
        )
    for job in state["jobs"]:
        if job.get("status", "queued") not in HUB_GROUP_OUTCOME_STATUSES:
            raise ValueError(
                f"campaign job {job['job_id']} status {job.get('status')!r} is not a Hub "
                f"outcome status {HUB_GROUP_OUTCOME_STATUSES}"
            )
    return {
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
                    "status": job.get("status", "queued"),
                    "controller_exit_code": job.get("controller_exit_code"),
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


def publish_campaign_group(
    root: Path,
    campaign_dir: Path,
    state: dict[str, object],
    *,
    live: bool,
    stop_requested: Callable[[], bool],
) -> bool:
    """The schedule is a real Hub resource; task results remain child-owned."""
    record = campaign_group_record(state)
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
                # hub_upload's tree helpers need the agents venv (httpx); an
                # operator on system Python names that interpreter explicitly.
                os.environ.get("RUN_BENCH_HUB_PYTHON") or sys.executable,
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
                    # The live schedule and the terminal record share one
                    # commit point: the exact publisher's acknowledgement.
                    if result.returncode == 0 and acknowledgement.is_file():
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
    elif not completed:
        print(
            "Warning: campaign Hub schedule acknowledgement was not verified; publication remains pending"
            if live else
            "Warning: campaign Hub terminal acknowledgement was not verified; publication remains pending"
        )
    return completed


# Largest Fly shared-cpu guest size; the conservative count for a configless Machine.
UNREACHABLE_HOST_SHARED_CPU_ALLOWANCE = 8


def stress_default_requirements(root: Path, rows: list[dict[str, object]], *, peak: int,
                                baseline: list[dict[str, object]] | None, autoscale_max: int = 15, repetitions: int = 1) -> dict[str, object]:
    """Derive opt-in operator defaults; unknown native quotas never grant admission."""
    if type(repetitions) is not int or repetitions < 1:
        raise ValueError("invalid stress repetitions")
    if type(peak) is not int or peak < 1 or peak > len(rows) * repetitions:
        raise ValueError("invalid stress peak")
    if type(autoscale_max) is not int or autoscale_max < 2:
        raise ValueError("invalid per-task worker ceiling")
    names = [row["name"] for row in rows]
    if len(set(names)) != len(names) or any(not isinstance(name, str) for name in names):
        raise ValueError("invalid distinct stress tasks")
    if any(type(row.get("requires_browser_agent", False)) is not bool for row in rows):
        raise ValueError("invalid browser profile")
    source_path = root / "scripts/run-bench-fleet"
    source_bytes = source_path.read_bytes()
    ref = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if source_bytes != subprocess.check_output(["git", "-C", str(root), "show", ref + ":scripts/run-bench-fleet"]):
        raise ValueError("stress VM profile source differs from immutable Git bytes")
    source = source_bytes.decode()
    assignments = []
    for key in ("FLEET_PRIMARY_VM_SIZE", "FLEET_PRIMARY_VM_MEMORY",
                "FLEET_BUNDLED_FRONTEND_VM_SIZE", "FLEET_BUNDLED_FRONTEND_VM_MEMORY",
                "FLEET_SIM_VM_SIZE", "FLEET_SIM_VM_MEMORY",
                "FLEET_FANOUT_MIN_AGENT_COUNT", "FLEET_FANOUT_VM_SIZE", "FLEET_FANOUT_VM_MEMORY"):
        matches = [line for line in source.splitlines() if line.startswith(key + "=")]
        if len(matches) != 1:
            raise ValueError("ambiguous actual VM profile")
        assignments.extend(matches)
    functions = [next(line for line in source.splitlines() if line.startswith("is_sim_on() {"))]
    for name in ("bench_simulates", "bench_needs_large_primary", "bench_declares_fanout", "primary_vm_size_for_bench",
                 "primary_vm_memory_for_bench"):
        start = source.index(name + "() {")
        functions.append(source[start:source.index("\n}\n", start) + 3])
    browser_names = [row["name"] for row in rows if row.get("requires_browser_agent")]
    fanout_threshold = int(next(a for a in assignments if a.startswith("FLEET_FANOUT_MIN_AGENT_COUNT=")).split("=", 1)[1])
    fanout_names = [row["name"] for row in rows
                    if type(row.get("min_agent_count")) is int and row["min_agent_count"] >= fanout_threshold]
    # A catalog simulate task serves the native WMH on a large guest; plan it so.
    modes = ["simulate" if str(row.get("world_model_mode") or "").lower() == "simulate" else "real" for row in rows]
    script = "set -euo pipefail\nINFRA_PROBE=0\nSIM_ON_CSV=\n" + "\n".join(assignments + functions)
    script += "\nCATALOG_BROWSER_REQUIRED_TASKS=(" + " ".join(shlex.quote(name) for name in browser_names) + ")\n"
    script += "CATALOG_FANOUT_TASKS=(" + " ".join(shlex.quote(name) for name in fanout_names) + ")\n"
    script += "BENCHES=(" + " ".join(shlex.quote(name) for name in names) + ")\n"
    script += "CATALOG_MODES=(" + " ".join(modes) + ")\n"
    for name in names:
        script += "printf '%s\\t%s\\n' \"$(primary_vm_size_for_bench " + shlex.quote(name) + ")\" \"$(primary_vm_memory_for_bench " + shlex.quote(name) + ")\"\n"
    profiles = subprocess.check_output(["bash", "-s"], input=script, text=True).splitlines()
    shared, memory, perf = [], [], []
    for profile in profiles:
        size, ram = profile.split("\t")
        if size.startswith("shared-cpu-") and size.endswith("x"):
            shared.append(int(size.removeprefix("shared-cpu-").removesuffix("x"))); perf.append(0)
        elif size.startswith("performance-") and size.endswith("x"):
            shared.append(0); perf.append(int(size.removeprefix("performance-").removesuffix("x")))
        else:
            raise ValueError("unknown actual primary CPU shape")
        memory.append(int(ram))
    # Count each simultaneously admitted copy; queued repetitions add no width.
    shared *= repetitions
    perf *= repetitions
    memory *= repetitions
    planned_shared = sum(sorted(shared, reverse=True)[:peak])
    planned_perf = sum(sorted(perf, reverse=True)[:peak])
    result = {"planned_peak": peak, "planned_shared_cpu_units": planned_shared,
              "planned_performance_cpu_units": planned_perf,
              "planned_memory_mib": sum(sorted(memory, reverse=True)[:peak]),
              "local_shared_cpu_governor_minimum": None, "local_machine_ceiling_minimum": None,
              "worker_slots": "dynamically-serialized-under-global-ceiling",
              "per_task_autoscale_max": autoscale_max, "worker_reservation_slots": peak * (autoscale_max - 1), "disk_floor_mib": peak * (256 + 32),
              "admission": "withheld-unknown-native-capacity", "native_org_quota_proven": False}
    if baseline is None:
        return result
    if not isinstance(baseline, list) or any(not isinstance(machine, dict) for machine in baseline):
        raise ValueError("invalid native baseline")
    headroom = int(os.environ.get("CLOUDBENCH_SHARED_CPU_HEADROOM", "20"))
    if headroom < 0:
        raise ValueError("invalid shared CPU headroom")
    ids = [machine.get("id") for machine in baseline]
    if any(not isinstance(identifier, str) or not identifier for identifier in ids) or len(set(ids)) != len(ids):
        raise ValueError("invalid native baseline identity")
    baseline_shared = 0
    for machine in baseline:
        if machine.get("state") in ("stopped", "destroyed"):
            continue
        config = machine.get("config")
        if config is None and machine.get("host_status") == "unreachable":
            # Fly omits the config of a Machine on an unreachable host. Reserve the
            # largest shared size so the governor never under-counts it.
            baseline_shared += UNREACHABLE_HOST_SHARED_CPU_ALLOWANCE
            continue
        if not isinstance(config, dict) or not isinstance(config.get("guest"), dict):
            raise ValueError("unknown native baseline configuration")
        guest = config["guest"]
        if type(guest.get("cpus")) is not int or guest["cpus"] < 1 or guest.get("cpu_kind") not in ("shared", "performance"):
            raise ValueError("unknown native baseline CPU")
        if guest["cpu_kind"] == "shared":
            baseline_shared += guest["cpus"]
    result.update(local_shared_cpu_governor_minimum=planned_shared + baseline_shared + headroom,
                  # Narrow campaign controllers each reserve their own one replacement.
                  local_machine_ceiling_minimum=len(baseline) + peak + peak + peak * (autoscale_max - 1),
                  admission="local-defaults-derived-native-guards-required")
    return result


def stress_default_environment(requirements: dict[str, object], environment: dict[str, str]) -> dict[str, str]:
    """Operator limits only: actual native guards and provider refusals remain authoritative."""
    if requirements["local_shared_cpu_governor_minimum"] is None or requirements["local_machine_ceiling_minimum"] is None:
        raise ValueError("unknown native baseline cannot admit stress defaults")
    result = dict(environment)
    result.setdefault("CLOUDBENCH_SHARED_CPU_GOVERNOR", str(max(1000, int(requirements["local_shared_cpu_governor_minimum"]))))
    result.setdefault("CLOUDBENCH_APP_MACHINE_CEILING", str(max(300, int(requirements["local_machine_ceiling_minimum"]))))
    result.setdefault("CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION", "1")
    return result


def controller_identity() -> dict | None:
    """This campaign controller's PID and birth, in the form cloudbench-scorecard's process_birth reads.

    The shared-inventory owner file records them only when that inventory runs (concurrency > 1),
    so summary.json carries them too; a concurrency-1 campaign can then prove liveness.
    """
    pid = os.getpid()
    try:
        if Path("/proc/self/stat").exists():
            fields = Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            return {"pid": pid, "birth": f"proc-start:{boot}:{fields[19]}"}
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True,
                                timeout=10, check=False)
        return {"pid": pid, "birth": result.stdout.strip()} if result.returncode == 0 and result.stdout.strip() else None
    except (OSError, IndexError, subprocess.TimeoutExpired):
        return None


def cleanup_ticket_module(root: Path) -> ModuleType:
    """Bind and execute the exact immutable helper once in the campaign parent."""
    cached = getattr(cleanup_ticket_module, "_checked", None)
    if cached is not None:
        if cached[0] != root:
            raise ValueError("cleanup ticket control root changed")
        return cached[1]
    helper = root / "scripts/cloudbench-cleanup-tickets.py"
    ref = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    checked = subprocess.check_output(["git", "-C", str(root), "show", ref + ":scripts/cloudbench-cleanup-tickets.py"])
    if helper.read_bytes() != checked:
        raise ValueError("cleanup ticket interpreter differs from immutable controller source")
    module = ModuleType("cleanup_parent_identity")
    module.__file__ = str(helper)
    exec(compile(checked, str(helper), "exec"), module.__dict__)
    cleanup_ticket_module._checked = (root, module)
    return module


def cleanup_ticket_command(root: Path, action: str, cohort: dict[str, object],
                           *arguments: str) -> object:
    """Cohort-wide work runs once; assigning one selected job is constant-size."""
    module = cleanup_ticket_module(root)
    args = module.parse([action, "--cohort", str(cohort["_directory"]),
                         "--cohort-id", str(cohort["cohort_id"]), *map(str, arguments)])
    return getattr(module, action)(args)


def cleanup_ticket_failure_detail(error: BaseException) -> dict[str, object]:
    """Keep bounded diagnostic identity without exception payloads or paths."""
    reasons = {
        "cleanup parent identity changed": "parent_identity_changed",
        "invalid cleanup ticket policy": "invalid_policy",
        "invalid cleanup cohort membership": "invalid_membership",
        "invalid cleanup member": "invalid_member",
        "cleanup parent lock not held": "parent_lock_not_held",
        "changed incomplete cleanup grant": "incomplete_grant_changed",
        "insufficient physical cleanup cohort floors": "insufficient_physical_floors",
        "cleanup member ticket changed": "member_ticket_changed",
    }
    category = next((kind.__name__ for kind in (
        subprocess.CalledProcessError, subprocess.TimeoutExpired,
        subprocess.SubprocessError, OSError, ValueError,
    ) if isinstance(error, kind)), "Exception")
    message = error.args[0] if error.args and type(error.args[0]) is str else ""
    if isinstance(error, OSError) and type(error.strerror) is str:
        message = error.strerror
    reason = reasons.get(message) if type(error) is ValueError else None
    detail: dict[str, object] = {"error_class": category, "reason_code": reason or "unknown"}
    number = getattr(error, "errno", None)
    if isinstance(error, OSError) and type(number) is int and 0 < number < 4096:
        detail["errno"] = number
    if reason is None:
        detail["message_prefix_sha256"] = hashlib.sha256(
            message[:4096].encode("utf-8", errors="replace")
        ).hexdigest()
    return detail


def stress_inventory_baseline(root: Path, authority: str) -> tuple[int, list[dict[str, object]] | None]:
    """Borrow the exact parent feed with existing checks; temporary absence never fans out."""
    expected = json.loads(authority)
    directory = Path(expected["directory"])
    owner = directory / "owner"
    if owner.is_symlink() or not owner.is_file():
        raise ValueError("stress inventory owner unavailable")
    pairs = [line.split("=", 1) for line in owner.read_text().splitlines()]
    if len(dict(pairs)) != len(pairs) or dict(pairs) != expected["owner"]:
        raise ValueError("stress inventory authority changed")
    checked = []
    ref = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    for relative in ("scripts/lib/cloudbench-env.sh", "scripts/lib/cloudbench-inventory.sh"):
        bound = subprocess.check_output(["git", "-C", str(root), "show", ref + ":" + relative])
        if (root / relative).read_bytes() != bound:
            raise ValueError("stress inventory interpreter differs from immutable source")
        checked.append(bound.decode())
    environment = {**os.environ, "CLOUDBENCH_CAMPAIGN_INVENTORY_DIR": str(directory)}
    script = ('set -euo pipefail\nAPP=navi-whisper-lux-bench\nFLEET_DIR=' + shlex.quote(str(directory))
              + '\nFLEET_OWNER_HOST="$(hostname)"\n' + "\n".join(checked)
              + '\nstart_machines_snapshot_loop\nfleet_machines_json\n')
    result = subprocess.run(["bash", "-s"], input=script, text=True, env=environment, capture_output=True)
    if result.returncode == 75:
        return 75, None
    if result.returncode:
        raise ValueError("stress parent inventory admission refused")
    return 0, json.loads(result.stdout)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--runs", type=int, required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--forward-arg", action="append", default=[])
    parser.add_argument("--retry-infra", type=int, default=0)
    parser.add_argument("--stress-defaults", action="store_true", help="derive local capacity defaults for the authorized 200-distinct-task k3 profile at peak200 or peak600; native quotas remain unknown")
    parser.add_argument("--stress-defaults-plan", action="store_true", help="derive opt-in stress defaults without launching controllers")
    parser.add_argument("--e2e-timeout", type=float)
    parser.add_argument("--e2e-started-at", type=float)
    return parser.parse_args()


def terminal_task(root: Path, job: dict[str, object]) -> tuple[Path, dict, dict] | None:
    """The job's physical fleet handle, run record and its one task row, without regrading."""
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
        return None
    record = json.loads((fleet / "_batch/run.json").read_text())
    tasks = record.get("tasks") or []
    if len(tasks) != 1 or tasks[0].get("name") != job["task"]:
        raise ValueError("terminal task binding changed")
    return fleet, record, tasks[0]


def task_verdict(task: dict) -> dict[str, object]:
    """The recorded task status and whether it is a confirmed infrastructure failure."""
    status = str(task.get("benchmark_status") or task.get("status") or "").upper()
    return {"task_status": status,
            "infra_failure": status in {"INFRA_ERROR", "ERROR"} and (task.get("passed") is False or task.get("passed") is None),
            "terminal_task": isinstance(task.get("passed"), bool) and status in {
                "PASSED", "FAILED", "SUCCEEDED", "SUCCESS", "FAILURE", "TIMED_OUT", "TIMEOUT", "WINDOW_FAILED",
                "SKIPPED"}}


def unverified_reason(error: Exception) -> str:
    """Why a recorded result or release seal could not be verified (bounded)."""
    return f"terminal result or release remains unverified ({type(error).__name__}: {error})"[:240]


def released_attempt(root: Path, job: dict[str, object]) -> dict[str, object]:
    """Read the existing physical result and full-release seal, without regrading.

    Any unreadable, looping or malformed receipt is an unverified release, never a
    campaign failure: every exited attempt runs this check, including healthy peers'."""
    try:
        found = terminal_task(root, job)
        if found is None:
            return {"resources_released": False, "retry_blocked": "physical run handle unavailable"}
        fleet, record, task = found
        verdict = task_verdict(task)
    except Exception as error:
        return {"resources_released": False, "retry_blocked": unverified_reason(error)}
    try:
        run_id = fleet.name
        lifecycle = json.loads((fleet / "_batch/lifecycle.json").read_text())
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
            and ((not registry.exists() and not registry.is_symlink()) or runpy.run_path(
                str(Path(__file__).with_name("cloudbench-retained-successor.py"))
            )["released"](registry, audit, fleet, owner, run_id))
            and lifecycle.get("hub_publication_failed") is False
            and task.get("lifecycle_stage") == "released"
        )
        # The fleet's lifecycle verdict also covers execution completion, the
        # mandatory autoscaler and the controller exit; release alone does not.
        return {"run_id": run_id, "fleet_dir": str(fleet), "fleet_owner_token": owner,
                **verdict, "resources_released": closed,
                "lifecycle_verified": closed and lifecycle.get("status") == "verified",
                "released_at_epoch": float(epoch_bytes) if closed else None}
    except Exception as error:
        # The recorded verdict stands; only release remains unverified.
        return {**verdict, "resources_released": False, "retry_blocked": unverified_reason(error)}


def infra_stop_policy() -> str:
    """The explicit infrastructure-stop policy (operator override); enabled by default."""
    policy = os.environ.get("CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP") or "enabled"
    if policy not in ("enabled", "disabled"):
        raise ValueError("invalid infrastructure early-stop policy")
    return policy


def infra_stop_predicate() -> Callable[[int, int], bool]:
    """The one fixed-total infra stop predicate, shared with the sharded operator."""
    coordinator = runpy.run_path(str(Path(__file__).with_name("cloudbench-shard-coordinator.py")))
    return coordinator["infra_stop_reached"]


def infra_stop_receipt(jobs: list[dict[str, object]], scheduled_total: int, policy: str,
                       reached: Callable[[int, int], bool] | None = None) -> dict[str, object] | None:
    """The fixed-total infra stop breach, or None.

    Each scheduled job counts once when one of its own terminal, non-cancelled
    attempts is a confirmed infrastructure failure. Unknown verdicts and
    cancellations never count, and the denominator is the frozen schedule.
    """
    if policy == "disabled":
        return None
    infra = sorted(
        str(job["job_id"]) for job in jobs
        if any(attempt.get("infra_failure") is True and attempt.get("status") != "cancelled"
               for attempt in (job.get("attempts") or [job]))
    )
    if not (reached or infra_stop_predicate())(len(infra), scheduled_total):
        return None
    return {"policy": policy, "infra_jobs": len(infra), "scheduled_total": scheduled_total,
            "infra_job_ids": infra}


FLEET_INFRA_STOP_SCHEMA = "fleet-infra-stop-v1"
# run_fleet_child_supervised records a forwarded HUP/INT/TERM as the child's exit.
FLEET_CANCELLED_EXIT_CODES = {"129", "130", "143"}


def fleet_attempt(directory: Path, task: str) -> dict[str, object]:
    """One physical fleet attempt's verdict, read from its own receipts without regrading.

    Only a finished child is terminal. A forwarded signal is a cancellation. A
    finished child without a run record is the fleet aggregate's INFRA_ERROR row
    ("no current run artifact produced"); otherwise the recorded task row decides.
    """
    try:
        code = (directory / "benchmark-child.finished").read_text().strip()
    except FileNotFoundError:
        return {"status": "running"}
    if code in FLEET_CANCELLED_EXIT_CODES:
        return {"status": "cancelled", "exit_code": code}
    record = directory / "cloudbench-run.json"
    if not record.is_file():
        return {"status": "failed", "exit_code": code, "task_status": "INFRA_ERROR",
                "infra_failure": True, "terminal_task": False}
    try:
        rows = [row for row in json.loads(record.read_text()).get("tasks") or []
                if isinstance(row, dict) and row.get("name") == task]
    except (OSError, ValueError, AttributeError):
        rows = []
    if len(rows) != 1:
        return {"status": "unknown", "exit_code": code}
    return {"status": "finished", "exit_code": code, **task_verdict(rows[0])}


def fleet_infra_jobs(fleet_dir: Path, benches: list[str]) -> list[dict[str, object]]:
    """One scheduled job per requested bench, with every physical attempt.

    A host-replaced attempt (``host-replaced-*``) is retained but never counts:
    it has no task row, and the job's verdict comes from its current attempt,
    as the campaign and sharded paths read the same fleet's task row.
    """
    jobs = []
    for bench in dict.fromkeys(benches):
        out = fleet_dir / bench
        attempts: list[dict[str, object]] = [
            {"attempt_dir": str(path), "status": "replaced"}
            for path in sorted(out.glob("host-replaced-*")) if path.is_dir()
        ]
        attempts.append({"attempt_dir": str(out), **fleet_attempt(out, bench)})
        jobs.append({"job_id": bench, "task": bench, "attempts": attempts})
    return jobs


def fleet_infra_stop(fleet_dir: Path, benches: list[str], receipt: Path) -> dict[str, object] | None:
    """The plain fleet's fixed-total infra breach, using the campaign's counting.

    The frozen schedule is the fleet's requested benches. The first breach is
    written once and returned unchanged on every later evaluation.
    """
    scheduled = list(dict.fromkeys(benches))
    try:
        return json.loads(receipt.read_text())
    except FileNotFoundError:
        pass
    except ValueError as error:
        # Only a breach writes the receipt, so an unreadable one still records a breach: keep
        # stopping (never continue past it), with the current count when it still breaches.
        current = infra_stop_receipt(fleet_infra_jobs(fleet_dir, scheduled), len(scheduled), infra_stop_policy())
        return current or {"infra_jobs": "recorded", "scheduled_total": len(scheduled),
                           "infra_job_ids": [f"unreadable breach receipt {receipt}: {error}"]}
    jobs = fleet_infra_jobs(fleet_dir, scheduled)
    breach = infra_stop_receipt(jobs, len(scheduled), infra_stop_policy())
    if breach is None:
        return None
    breach.update(schema=FLEET_INFRA_STOP_SCHEMA, observed_at=utc_now(), breached_at_epoch=time.time(),
                  fleet_dir=str(fleet_dir), jobs=jobs)
    temporary = receipt.with_name(f".{receipt.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(breach, indent=2, sort_keys=True) + "\n")
    try:
        os.link(temporary, receipt)  # never replaces an earlier breach
    except FileExistsError:
        breach = json.loads(receipt.read_text())
    finally:
        temporary.unlink(missing_ok=True)
    return breach


def fleet_infra_stop_main(argv: list[str]) -> int:
    """``<fleet-dir> <receipt> <bench>...``: print one summary line on a breach, else nothing."""
    if len(argv) < 3:
        print("usage: fleet_infra_stop_main <fleet-dir> <receipt> <bench>...", file=sys.stderr)
        return 2
    breach = fleet_infra_stop(Path(argv[0]), argv[2:], Path(argv[1]))
    if breach is not None:
        print(f"{breach['infra_jobs']}/{breach['scheduled_total']} scheduled jobs confirmed INFRA "
              f"({', '.join(map(str, breach['infra_job_ids']))})")
    return 0


def terminate_owned_children(active: dict[int, dict[str, object]]) -> None:
    """Send one cancellation TERM to each live controller's process group.

    Each fleet controller releases its own guests and provider resources in its
    EXIT cleanup, whose phases carry their own bounds (guest acknowledgement,
    native stop, evidence, destroy). Callers keep joining every controller and
    record its real exit. Never SIGKILL a controller: KILL cannot run that
    cleanup, so started guests would stay allocated without an owner acting.
    """
    for process_id, job in active.items():
        process = job["_process"]
        assert isinstance(process, subprocess.Popen)
        if process.poll() is None:
            try:
                os.killpg(process_id, signal.SIGTERM)
                job["_terminated_by_campaign"] = True
            except ProcessLookupError:
                pass


def start_shared_inventory(
    root: Path, campaign_dir: Path, workspace: Path | None = None
) -> tuple[subprocess.Popen, object, Path]:
    workspace = workspace or root
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
        ("cloudbench-campaign-machines.py", "scripts/cloudbench-campaign-machines.py"),
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
            str(workspace),
            str(directory),
            str(os.getpid()),
        ],
        cwd=workspace,
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


def archive_shared_relay(directory: Path, archive: Path) -> None:
    """A crashed control socket is evidence metadata, not an exportable file."""
    import stat
    def non_records(parent: str, names: list[str]) -> list[str]:
        return [name for name in names if not (stat.S_ISREG((Path(parent) / name).lstat().st_mode) or stat.S_ISDIR((Path(parent) / name).lstat().st_mode))]
    shutil.copytree(directory, archive, dirs_exist_ok=True, ignore=non_records)


def claim_home_wireguard_peer(campaign_dir: Path) -> int:
    """Claim this HOME's single Fly WireGuard peer for one campaign agent.

    Every flyctl agent started in one HOME loads the same wire_guard_state peer.
    A second campaign's private agent opens another session on that peer and
    stalls both tunnels (descend-full69-20261023: lost guest /shutdown replies,
    retained Machines). The claim is an open file lock, so a dead holder releases
    it; the caller hands it to the agent's bootstrap so it ends with that agent.

    flyctl keeps its config, agent socket and wire_guard_state in FLY_CONFIG_DIR
    (default ~/.fly), so the peer and this claim belong to that directory: a
    campaign launched with its own FLY_CONFIG_DIR gets its own peer and can run
    beside another campaign in the same HOME.
    """
    directory = Path(os.environ.get('FLY_CONFIG_DIR') or Path(os.environ.get('HOME') or Path.home()) / '.fly')
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / 'rose-campaign-wireguard-peer.lock'
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        holder = os.read(descriptor, 4096).decode(errors='replace').strip() or 'unknown holder'
        os.close(descriptor)
        raise ValueError(f'another campaign already owns this Fly config dir\'s WireGuard peer ({holder}); '
                         'a second Fly agent on that peer stalls both tunnels. Run these tasks in that '
                         'campaign, wait for it to finish, launch with its own FLY_CONFIG_DIR, or use a '
                         'sharded campaign') from None
    except BaseException:
        os.close(descriptor)
        raise
    os.ftruncate(descriptor, 0)
    os.pwrite(descriptor, f'pid={os.getpid()} campaign={campaign_dir}\n'.encode(), 0)
    return descriptor


RELAY_METADATA_TIMEOUT = 30
RELAY_METADATA_ATTEMPTS = 3


def read_relay_app_metadata(app: str, workspace: Path, environment: dict,
                            deadline: float | None, *, source_root: Path | None = None) -> subprocess.CompletedProcess:
    """Read only the native App identity, with bounded retries within the campaign deadline."""
    reader = (source_root or workspace) / "scripts/cloudbench-campaign-machines.py"
    for attempt in range(1, RELAY_METADATA_ATTEMPTS + 1):
        timeout = RELAY_METADATA_TIMEOUT
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise ValueError('shared transport app metadata unavailable before the campaign deadline')
        try:
            metadata = subprocess.run([sys.executable, '-S', str(reader), app, str(timeout), '--app-metadata'],
                                      cwd=workspace, env=environment, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            if attempt == RELAY_METADATA_ATTEMPTS:
                raise
            print(f'[campaign] App metadata read timed out after {timeout:.0f}s; retry {attempt}/{RELAY_METADATA_ATTEMPTS - 1}',
                  file=sys.stderr)
            continue
        if metadata.returncode == 0 or attempt == RELAY_METADATA_ATTEMPTS:
            return metadata
        print(f'[campaign] App metadata read exited {metadata.returncode}; retry {attempt}/{RELAY_METADATA_ATTEMPTS - 1}',
              file=sys.stderr)
    raise AssertionError('unreachable')


def start_shared_relay(root: Path, campaign_dir: Path, workspace: Path,
                       inventory: Path, deadline: float | None) -> dict:
    """Own one canonical Fly bootstrap and one relay until all children join."""
    peer_claim = claim_home_wireguard_peer(campaign_dir)
    try:
        value = _start_shared_relay(root, campaign_dir, workspace, inventory, deadline, peer_claim)
    except BaseException:
        os.close(peer_claim)
        raise
    value['peer_claim'] = peer_claim
    return value


def _start_shared_relay(root: Path, campaign_dir: Path, workspace: Path,
                        inventory: Path, deadline: float | None, peer_claim: int) -> dict:
    """Start a request-owned relay only after provider preflight succeeds."""
    ref = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    checked = {}
    for relative in ['scripts/cloudbench-shared-relay.py', 'scripts/cloudbench-campaign-machines.py', 'scripts/lib/cloudbench-inventory.sh', 'scripts/run-bench-cloud', 'scripts/run-bench-fleet']:
        raw = subprocess.check_output(['git', '-C', str(root), 'show', ref + ':' + relative])
        if (root / relative).read_bytes() != raw:
            raise ValueError('shared relay source differs from reviewed controller')
        checked[relative] = raw
    # Unix sockets have a short pathname limit; campaign identifiers can be long.
    directory = Path(tempfile.mkdtemp(prefix='cb-relay-', dir='/tmp'))
    archive = campaign_dir / 'shared-relay'
    write_json_atomic(campaign_dir / 'shared-relay-location.json', {'directory': str(directory)})
    owner = dict(line.split('=', 1) for line in (inventory / 'owner').read_text().splitlines())
    app = owner['app']
    identity = cleanup_ticket_module(root)
    parent_start = identity.birth(os.getpid())
    environment = os.environ.copy()
    # Resolve the same complete bench-token precedence as existing native reads.
    token = subprocess.check_output(['bash', '-c', 'source "$1"; resolve_fly_token',
                                    'relay', str(root / 'scripts/lib/cloudbench-inventory.sh')],
                                   cwd=workspace, env=environment, timeout=20, text=True).strip()
    if not token: raise ValueError('missing shared transport credential')
    environment['FLY_API_TOKEN'] = token
    # One private agent belongs to the singleton bootstrap, never to a route.
    # Official flyctl isolated mode ties its child agent to bootstrap stdin EOF.
    agent_socket = directory / 'fly-agent.sock'
    environment['FLY_AGENT_SOCKET_PATH'] = str(agent_socket)
    environment['FLY_AGENT_ISOLATED'] = '1'
    environment['CLOUDBENCH_INVENTORY_PHASE_FILE'] = str(directory / 'app-metadata-phase.private')
    metadata = read_relay_app_metadata(app, workspace, environment, deadline, source_root=root)
    metadata_path = directory / 'app-metadata.private.json'
    metadata_path.write_bytes(metadata.stdout); metadata_path.chmod(0o600)
    if metadata.returncode: raise ValueError('shared transport app metadata unavailable')
    native = json.loads(metadata.stdout)
    organization = native['Organization']
    org = organization.get('Slug', organization.get('slug'))
    network = native.get('Network', '')
    if native.get('Name') != app or not isinstance(org, str) or not org or not isinstance(network, str):
        raise ValueError('shared transport app metadata identity invalid')
    if network == 'default': network = ''
    ports = []
    for relative, name in [('scripts/run-bench-cloud', 'REMOTE_STATUS_PORT'), ('scripts/run-bench-cloud', 'REMOTE_BACKEND_PORT'), ('scripts/run-bench-fleet', 'BOX_HEALTH_PORT')]:
        import re
        match = re.search(rb'^' + name.encode() + rb'="([0-9]+)"', checked[relative], re.M)
        if not match or not 1 <= int(match[1]) <= 65535: raise ValueError('invalid configured relay port')
        ports.append(int(match[1]))
    authority = dict(schema='shared-relay-authority-v1', app=app, org_slug=org,
                     network=network, parent_pid=os.getpid(), parent_start=parent_start,
                     source_sha256=hashlib.sha256(checked['scripts/cloudbench-shared-relay.py']).hexdigest(),
                     agent_socket=str(agent_socket), inventory_directory=str(inventory.resolve()),
                     inventory_owner=owner, allowed_remote_ports=sorted(set(ports)), deadline=deadline if deadline is not None else sys.float_info.max)
    authority_path = directory / 'authority.private.json'
    authority_path.write_text(json.dumps(authority) + '\n'); authority_path.chmod(0o600)
    log = (directory / 'broker.private.log').open('w'); os.chmod(log.name, 0o600)
    bootstrap_log = (directory / 'bootstrap.private.log').open('w'); os.chmod(bootstrap_log.name, 0o600)
    value = dict(directory=directory, archive=archive, authority=authority_path, parent_start=parent_start,
                 module=root / 'scripts/cloudbench-shared-relay.py', log=log,
                 bootstrap_log=bootstrap_log, process=None, bootstrap=None)
    try:
        value['bootstrap'] = subprocess.Popen(['flyctl', 'proxy', '0:1', '::1', '-a', app,
                                               '--bind-addr', '127.0.0.1', '-q'],
                                              cwd=workspace, env=environment, stdout=bootstrap_log,
                                              stderr=subprocess.STDOUT, start_new_session=True,
                                              pass_fds=(peer_claim,))
        write_json_atomic(directory / 'bootstrap-owner.json', {'pid': value['bootstrap'].pid, 'birth': identity.birth(value['bootstrap'].pid), 'parent_pid': os.getpid(), 'parent_start': parent_start})
        bootstrap_deadline = min(deadline or math.inf, time.monotonic() + 180)
        while True:
            if value['bootstrap'].poll() is not None or time.monotonic() >= bootstrap_deadline:
                raise ValueError('shared transport bootstrap did not initialize')
            bootstrap_log.flush()
            if agent_socket.is_socket() and 'Proxying localhost:' in Path(bootstrap_log.name).read_text(): break
            time.sleep(.1)
        value['process'] = subprocess.Popen([sys.executable, str(value['module']), 'serve',
                                            '--authority', str(authority_path), '--directory', str(directory)],
                                           cwd=workspace, env=environment, stdout=log,
                                           stderr=subprocess.STDOUT, start_new_session=True)
        write_json_atomic(directory / 'broker-owner.json', {'pid': value['process'].pid, 'birth': identity.birth(value['process'].pid), 'parent_pid': os.getpid(), 'parent_start': parent_start})
        while not (directory / 'ready.json').is_file():
            if value['process'].poll() is not None or time.monotonic() >= bootstrap_deadline:
                raise ValueError('shared transport broker did not initialize')
            time.sleep(.1)
        ready = json.loads((directory / 'ready.json').read_text())
        if ready['pid'] != value['process'].pid or identity.birth(ready['pid']) != ready['birth']:
            raise ValueError('shared transport broker identity changed')
        value['agent'] = ready['agent']
        value['environment'] = dict(CLOUDBENCH_SHARED_RELAY_AUTHORITY=str(authority_path),
                                    CLOUDBENCH_SHARED_RELAY_DIRECTORY=str(directory),
                                    CLOUDBENCH_SHARED_RELAY_PID=str(ready['pid']),
                                    CLOUDBENCH_SHARED_RELAY_BIRTH=ready['birth'],
                                    CLOUDBENCH_SHARED_RELAY_AGENT_PID=str(ready['agent']['pid']),
                                    CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH=ready['agent']['birth'],
                                    # Every agent in this HOME loads the same single
                                    # WireGuard peer. A child ssh/sftp call that
                                    # starts the default agent opens a second session
                                    # on it and stalls this relay's CONNECTs; so
                                    # children reuse this one agent and tunnel.
                                    FLY_AGENT_SOCKET_PATH=str(agent_socket))
        return value
    except BaseException:
        # No task child has been dispatched yet; these exact local children
        # cannot own a route. Join them before propagating the startup failure.
        for name in ['process', 'bootstrap']:
            process = value[name]
            if process is not None:
                if process.poll() is None: process.terminate()
                process.wait()
        # Joining the bootstrap delivers EOF to its private agent, but before
        # broker readiness there is no sealed agent identity to verify retirement.
        peer = directory / 'startup-agent.json'
        # Keep a missing capture explicit. A later read-only reconciliation may
        # use a captured exact peer, but cannot infer it from a vanished socket.
        try:
            peer_hash = hashlib.sha256(peer.read_bytes()).hexdigest() if peer.is_file() else None
        except OSError:
            peer_hash = None  # Preserve the original startup exception; proof stays incomplete.
        write_json_atomic(directory / 'startup-cleanup.json', {
            'schema': 'shared-relay-startup-cleanup-v1',
            'producer_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'parent': {'pid': os.getpid(), 'birth': parent_start},
            'bootstrap_joined': value['bootstrap'] is not None and value['bootstrap'].returncode is not None,
            'broker_joined': value['process'] is not None and value['process'].returncode is not None,
            'bootstrap_exit': value['bootstrap'].returncode if value['bootstrap'] is not None else None,
            'broker_exit': value['process'].returncode if value['process'] is not None else None,
            'agent_identity_sha256': peer_hash,
            'agent_shutdown_verified': False, 'agent_retirement_pending': value['bootstrap'] is not None})
        log.close(); bootstrap_log.close()
        try: archive_shared_relay(directory, archive)
        except OSError: pass  # Preserve the original startup failure and records.
        raise


RELAY_AGENT_EXIT_SECONDS = 60  # the private agent exits on its bootstrap's EOF within seconds


def stop_shared_relay(value: dict) -> bool:
    """Called only after all campaign task controllers have been joined."""
    process = value['process']
    acknowledged = False
    while process.poll() is None:
        result = subprocess.run([sys.executable, str(value['module']), 'shutdown',
                                 '--authority', str(value['authority']), '--directory', str(value['directory']),
                                 '--owner-pid', str(os.getpid()), '--owner-start', value['parent_start'],
                                 '--token', 'campaign-shutdown'], stdout=value['log'], stderr=subprocess.STDOUT)
        acknowledged = acknowledged or result.returncode == 0
        try: process.wait(timeout=1)
        except subprocess.TimeoutExpired: pass
    process.wait()
    bootstrap = value['bootstrap']
    if bootstrap.poll() is None: bootstrap.terminate()
    bootstrap.wait()
    # The private agent is the bootstrap's own isolated child. Keep the parent
    # alive through its EOF shutdown; never signal a shared/default daemon.
    # The wait is bounded: an agent that outlives its bootstrap's EOF is reported as unverified
    # cleanup (the caller marks shared transport cleanup pending), never awaited forever or signalled.
    identity = cleanup_ticket_module(Path(value['module']).parent.parent)
    agent = value['agent']
    agent_deadline = time.monotonic() + RELAY_AGENT_EXIT_SECONDS
    agent_exited = False
    while time.monotonic() < agent_deadline:
        if identity.birth(agent['pid']) != agent['birth']:
            agent_exited = True; break
        try: state = Path('/proc', str(agent['pid']), 'stat').read_text().rsplit(') ', 1)[1].split()[0]
        except FileNotFoundError:
            agent_exited = True; break
        if state in ('Z', 'X'):
            agent_exited = True; break
        time.sleep(.1)
    if not agent_exited:
        print(f"[campaign] shared relay private agent pid={agent['pid']} still live "
              f"{RELAY_AGENT_EXIT_SECONDS}s after bootstrap exit; cleanup unverified", file=sys.stderr)
    os.close(value['peer_claim'])
    value['log'].close(); value['bootstrap_log'].close()
    archive_shared_relay(value['directory'], value['archive'])
    return acknowledged and process.returncode == 0 and agent_exited


def mutation_inventory_authority(directory: Path, publisher: subprocess.Popen) -> str:
    """Mint the expected feed identity in its actual owning campaign parent."""
    source_root = Path(__file__).resolve().parent.parent
    source_ref = subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True).strip()
    hashes = {}
    checked = {}
    for name in ("cloudbench-campaign-mutation.py", "cloudbench-script-snapshot.py", "run-bench-campaign.py", "cloudbench-port-lease.py", "cloudbench-cleanup-tickets.py", "cloudbench-cohort-reconcile.py", "lib/cloudbench-env.sh"):
        bound = subprocess.check_output(["git", "-C", str(source_root), "show", source_ref + ":scripts/" + name])
        if (source_root / "scripts" / name).read_bytes() != bound:
            raise ValueError("mutation authority differs from immutable controller source")
        hashes[name] = hashlib.sha256(bound).hexdigest()
        checked[name] = bound
    # Interpret only the immutable bytes just compared, never a reopened file
    # or import cache that could execute a substituted identity implementation.
    identity_path = source_root / "scripts/cloudbench-port-lease.py"
    identity = ModuleType("mutation_parent_identity")
    identity.__file__ = str(identity_path)
    exec(compile(checked["cloudbench-port-lease.py"], str(identity_path), "exec"), identity.__dict__)
    source = directory / "owner"
    if source.is_symlink() or not source.is_file():
        raise ValueError("unsafe mutation inventory owner")
    pairs = [line.split("=", 1) for line in source.read_text().splitlines()]
    fields = dict(pairs)
    if len(fields) != len(pairs) or set(fields) != {"app", "pid", "pid_start", "token", "parent_pid", "parent_start"}:
        raise ValueError("invalid mutation inventory owner")
    if fields["app"] != "navi-whisper-lux-bench" or not fields["token"]:
        raise ValueError("foreign mutation inventory app")
    if int(fields["parent_pid"]) != os.getpid() or not identity._process_start_matches(os.getpid(), fields["parent_start"]):
        raise ValueError("mutation inventory belongs to another parent")
    pid = int(fields["pid"])
    if publisher.poll() is not None or os.getpgid(pid) != publisher.pid or not identity._process_start_matches(pid, fields["pid_start"]):
        raise ValueError("mutation inventory belongs to another publisher session")
    return json.dumps({"directory": str(directory.resolve()), "owner": fields,
                       "source": {"ref": source_ref, "sha256": hashes}}, sort_keys=True)


def bind_shared_relay(environment, relay):
    """Use only the relay already owned by this campaign for every consumer."""
    for key in (
        "CLOUDBENCH_SHARED_RELAY_AUTHORITY",
        "CLOUDBENCH_SHARED_RELAY_DIRECTORY",
        "CLOUDBENCH_SHARED_RELAY_PID",
        "CLOUDBENCH_SHARED_RELAY_BIRTH",
        "CLOUDBENCH_SHARED_RELAY_AGENT_PID",
        "CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH",
    ):
        environment.pop(key, None)
    if relay is not None:
        # The campaign agent is the only agent; isolated mode would start another.
        environment.pop("FLY_AGENT_ISOLATED", None)
        environment.update(relay["environment"])


def bind_mutation_inventory(environment, inventory_directory, mutation_authority):
    """Pass the same parent-minted feed authority to every owned consumer."""
    for key, value in (
        ("CLOUDBENCH_CAMPAIGN_INVENTORY_DIR", inventory_directory),
        ("CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY", mutation_authority),
    ):
        if value is None:
            environment.pop(key, None)
        else:
            environment[key] = str(value)


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


def campaign_workspace(root: Path, forward_args: list[str]) -> tuple[Path, dict[str, str] | None]:
    """Bind an existing borrowed fleet snapshot to its admitted task workspace."""
    requested = os.environ.get("CLOUDBENCH_FLEET_ROOT")
    if not requested or Path(requested).resolve() == root:
        return root, None
    if Path(__file__).resolve() != root / "scripts/run-bench-campaign.py":
        raise ValueError("campaign interpreter differs from control root")
    workspace = Path(requested).resolve(strict=True)
    snapshot = Path(os.environ.get("CLOUDBENCH_SCRIPT_SNAPSHOT", "")).resolve(strict=True)
    if os.environ.get("CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE") != "borrow" or not snapshot.is_dir():
        raise ValueError("separate campaign workspace requires a borrowed snapshot")
    def git(path: Path, *args: str) -> str:
        return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()
    source_ref = git(root, "rev-parse", "HEAD")
    if os.environ.get("CLOUDBENCH_PRESTACK_CONTROLLER_REF") != source_ref:
        raise ValueError("campaign control source differs from borrowed snapshot binding")
    refs = [forward_args[i + 1] for i, arg in enumerate(forward_args[:-1]) if arg == "--ref"]
    if len(refs) != 1 or any(arg.startswith("--ref=") for arg in forward_args):
        raise ValueError("separate campaign workspace requires one exact task ref")
    task_ref = refs[0]
    if len(task_ref) != 40 or any(c not in "0123456789abcdef" for c in task_ref) or git(workspace, "rev-parse", "HEAD") != task_ref:
        raise ValueError("campaign task workspace differs from exact task ref")
    common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common != git(workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"):
        raise ValueError("campaign source and task workspace have different common Git")
    checked = {}
    for relative in ("scripts/run-bench", "scripts/run-bench-campaign.py", "scripts/run-bench-fleet",
                     "scripts/cloudbench-script-snapshot.py", "scripts/cloudbench_execution_provenance.py"):
        raw = subprocess.check_output(["git", "-C", str(root), "show", source_ref + ":" + relative])
        if (root / relative).read_bytes() != raw:
            raise ValueError("campaign control source changed: " + relative)
        checked[Path(relative).name] = raw
    for name in ("run-bench-fleet", "cloudbench-script-snapshot.py", "cloudbench_execution_provenance.py"):
        if (snapshot / name).read_bytes() != checked[name]:
            raise ValueError("campaign borrowed snapshot source changed: " + name)
    owner = ModuleType("campaign_snapshot_owner")
    exec(compile(checked["cloudbench-script-snapshot.py"], str(root / "scripts/cloudbench-script-snapshot.py"), "exec"), owner.__dict__)
    token = snapshot.name.removeprefix("cloudbench-scripts.")
    owner._validate_path(snapshot, Path(os.environ.get("TMPDIR", "/tmp")), token)
    marker = owner._read_marker(snapshot, token)
    if marker["state"] != "armed" or not owner._process_matches(int(marker["owner_pid"]), marker["owner_pid_start"]):
        raise ValueError("campaign borrowed snapshot owner is not live and armed")
    manifest = snapshot / "cloudbench-controller-snapshot-manifest.json"
    subprocess.run([sys.executable, "-I", "-S", "-B", str(snapshot / "cloudbench_execution_provenance.py"),
                    "verify-snapshot", "--snapshot-dir", str(snapshot), "--manifest", str(manifest)],
                   check=True, capture_output=True)
    for name in ("tasks.json", "polar_tasks.json"):
        if (root / "agents/benchmarks" / name).read_bytes() != (workspace / "agents/benchmarks" / name).read_bytes():
            raise ValueError("campaign task catalogs differ across source and workspace")
    return workspace, {"control_root": str(root), "control_ref": source_ref,
                       "workspace_root": str(workspace), "task_ref": task_ref,
                       "snapshot": str(snapshot), "snapshot_manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()}


PROVIDER_GLOBAL_BENCHES_ENV = "CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES"


def campaign_simultaneous_benches(concurrency: int, job_count: int, group_total: int | None) -> int:
    """Global simultaneous benches: this campaign's width, or the whole sharded group's."""
    if concurrency < 1 or job_count < 1:
        raise ValueError("campaign width requires positive concurrency and jobs")
    # A shard's own --concurrency is only its slice of one externally released
    # group; every shard's members run at the same time.
    return max(min(concurrency, job_count), group_total or 0)


def provider_capacity_refusal(benches: int, tasks: list[str] | None = None) -> int:
    """0 when the provider rate-limit cap admits `benches`; else its refusal exit code.

    The helper and its reviewed registry ship beside this control script, so a
    separate task workspace cannot substitute other limits. `tasks` selects a
    measured demand profile only when every task is in its catalog group.
    """
    capacity = runpy.run_path(str(Path(__file__).resolve().with_name("cloudbench-provider-capacity.py")))
    try:
        return capacity["check"](benches, tasks=tasks)
    except capacity["RegistryError"] as error:
        raise SystemExit(f"❌ {error}; no campaign controller admitted") from None


def delegating_ceiling_refusal(benches: int, tasks: list[str] | None = None) -> int:
    """0 when the app delegating-guest ceiling can admit `benches` simultaneous REAL/SIM copies.

    Fleet admission refuses live REAL/SIM primaries + requested above
    CLOUDBENCH_DELEGATING_PRIMARY_CEILING after its admission wait, recording
    INFRA; a campaign (or sharded group) wider than the ceiling can never fit.
    """
    capacity = runpy.run_path(str(Path(__file__).resolve().with_name("cloudbench-provider-capacity.py")))
    try:
        return capacity["delegating_check"](benches, tasks=tasks)
    except capacity["RegistryError"] as error:
        raise SystemExit(f"❌ {error}; no campaign controller admitted") from None


# scripts/run-bench run_bench_secret_like_setting, re-applied here because a
# recorded name list is untrusted input (parity regression in
# cloudbench_campaign_inventory_test.py).
SECRET_LIKE_SETTING_NAME = re.compile(
    r"TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|AUTH_HEADER|AUTH_CONFIG|AUTH_SOCK|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE|OTP|SIGNATURE"
    r"|(_KEY|_B64|_AUTH|_DSN|_PAT|_PASS|_PWD|_JWT|_PAN|_CVV|_CVC|_PIN|_EXPIRY)\Z"
)
SECRET_LIKE_SETTING_VALUE = re.compile(
    r"://[^/]*@|://[^/]*:[^@]*@|Bearer |FlyV1 |-----BEGIN|ghp_|github_pat_|X-Amz-Signature"
)
SWITCH_VALUES = frozenset(("", "0", "1", "true", "false", "yes", "no", "on", "off"))
ASCII_SPACE = " \t\n\v\f\r"
OPERATOR_SETTING_VALUE_LIMIT = 1024


def secret_like_setting(name: str, value: str) -> bool:
    switch = value.strip(ASCII_SPACE)
    if switch.isascii() and switch.lower() in SWITCH_VALUES:
        return False  # read like _benchmark_env_bool: no secret in a switch
    return bool(SECRET_LIKE_SETTING_NAME.search(name) or SECRET_LIKE_SETTING_VALUE.search(value))


def bounded_setting_value(value: str) -> str:
    if len(value) <= OPERATOR_SETTING_VALUE_LIMIT:
        return value
    digest = hashlib.sha256(value.encode("utf-8", "surrogateescape")).hexdigest()
    return (value[:OPERATOR_SETTING_VALUE_LIMIT] + f"…[truncated: {OPERATOR_SETTING_VALUE_LIMIT} of "
            f"{len(value)} characters recorded; sha256={digest}]")


def banner_setting_value(value: str) -> str:
    """One shell-quoted line: control characters cannot forge banner lines."""
    return shlex.quote(re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\\\ud800-\udfff]",
                              lambda match: match.group().encode("unicode_escape").decode("ascii"), value))


def launch_operator_settings(environ: Mapping[str, str]) -> dict[str, str] | None:
    """Effective non-secret CLOUDBENCH_* settings at launch, or None when unrecorded.

    scripts/run-bench names them with its one secret-like filter (the same one
    its --durable unit forwarder applies); a direct launch has no such list.
    """
    names = environ.get("RUN_BENCH_OPERATOR_SETTING_NAMES")
    if names is None:
        return None
    return {name: bounded_setting_value(environ[name]) for name in sorted(set(names.split()))
            if name.startswith("CLOUDBENCH_") and name in environ
            and not secret_like_setting(name, environ[name])}


def scorecard_hooks() -> dict | None:
    """The CLI scorecard and experiments ledger, when this script snapshot carries them."""
    here = Path(__file__).resolve().parent
    if not (here / "cloudbench-scorecard.py").is_file() or not (here / "cloudbench_experiments.py").is_file():
        return None
    try:
        return runpy.run_path(str(here / "cloudbench-scorecard.py"))
    except Exception:  # reporting aids never block a launch
        return None


def record_experiment(hooks, event: str, campaign_dir: Path, root: Path, **fields) -> None:
    """Top-level campaigns record actual launches/ends; sharded children belong to their operator."""
    if hooks is None or os.environ.get("RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER"):
        return
    hooks["ledger_mod"].record(event, campaign_dir.name, root=root, **fields)


def main() -> int:
    """Run the immutable controller plan and join its owned resources before publication exits."""
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
    strict_start = (
        "--strict-barrier" in args.forward_arg
        or os.environ.get("CLOUDBENCH_STRICT_BARRIER") == "1"
    )
    try:
        shard = campaign_shard_settings(
            os.environ,
            tasks=args.task,
            runs=args.runs,
            concurrency=args.concurrency,
            strict=strict_start,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from None
    external_barrier = shard["external_barrier"]
    e2e_started_at = args.e2e_started_at if args.e2e_started_at is not None else time.time()
    e2e_deadline = time.monotonic() + args.e2e_timeout - (time.time() - e2e_started_at) if args.e2e_timeout is not None else None

    startup_deadline = startup_deadline_monotonic(os.environ, e2e_started_at, args.e2e_timeout,
                                                  now_epoch=time.time(), now_monotonic=time.monotonic())

    def startup_expired() -> bool:
        return startup_deadline is not None and time.monotonic() >= startup_deadline

    def deadline_expired() -> bool:
        return e2e_deadline is not None and time.monotonic() >= e2e_deadline

    root = args.root.resolve()
    workspace, workspace_binding = campaign_workspace(root, args.forward_arg)
    if args.stress_defaults and (args.concurrency not in (200, 600) or args.runs != 3 or len(args.task) != 200 or len(set(args.task)) != 200):
        raise SystemExit("--stress-defaults requires 200 distinct tasks, k3, peak200 or peak600")
    if args.stress_defaults_plan:
        from cloudbench_catalog import get_task_metadata
        rows = get_task_metadata(root / "agents/benchmarks/tasks.json", args.task)
        print(json.dumps(stress_default_requirements(root, rows, peak=args.concurrency, baseline=None, repetitions=args.runs if args.concurrency == 600 else 1), indent=2))
        return 2  # Planning only: baseline unknown, no campaign/provider mutation.
    global_benches = campaign_simultaneous_benches(
        args.concurrency, len(args.task) * args.runs, shard["group_total"]
    )
    if "--demo-cache" in args.forward_arg:
        # Read-only DEMO replays: each child's run-bench admits only replay
        # tasks (no browser) before provisioning; no live task-agent calls.
        print("🧊 provider rate-limit cap not applied: --demo-cache replay makes no live task-agent provider calls")
    else:
        refused = provider_capacity_refusal(global_benches, args.task)
        if refused:
            return refused
    refused = delegating_ceiling_refusal(global_benches, args.task)
    if refused:
        return refused
    controller_nice = os.environ.get("CLOUDBENCH_CAMPAIGN_CONTROLLER_NICE", "0")
    if controller_nice not in ("0", "10"):
        raise SystemExit("CLOUDBENCH_CAMPAIGN_CONTROLLER_NICE must be 0 or 10")
    controller_prefix: list[str] = []
    controller_process_options = {"start_new_session": True}
    if controller_nice == "10":
        if "process_group" not in inspect.signature(subprocess.Popen).parameters:
            raise SystemExit("controller nice10 requires process_group support; no controller admitted")
        nice_binary = shutil.which("nice")
        if nice_binary is None or not hasattr(os, "getpriority"):
            raise SystemExit("controller nice10 is unsupported; no controller admitted")
        # Probe the exact launcher before admitting any selected child. The
        # campaign and its shared publisher retain their original priority.
        try:
            probe = subprocess.run(
                [nice_binary, "-n", "10", sys.executable, "-I", "-S", "-B", "-c",
                 "import os,sys;sys.exit(0 if os.getpriority(os.PRIO_PROCESS,0)==10 else 1)"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise SystemExit("controller nice10 is unsupported; no controller admitted") from None
        if probe.returncode:
            raise SystemExit("controller nice10 is unsupported; no controller admitted")
        controller_prefix = [nice_binary, "-n", "10"]
        # Separate sessions create equal-priority Linux autogroups, defeating
        # nice10 relative to the shared publisher. Inherit the session while
        # keeping one owned process group per controller for exact killpg.
        controller_process_options = {"process_group": 0}
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
            workspace / ".context" / "benchmarks" / "campaigns",
        )
    )
    campaign_dir = campaign_root / safe_id
    campaign_dir.mkdir(parents=True, exist_ok=False)
    summary_path = campaign_dir / "summary.json"
    lock_prefix = hashlib.sha256(safe_id.encode()).hexdigest()[:12]

    jobs: list[dict[str, object]] = []
    for scheduled in campaign_jobs(
        args.task, args.runs, shard["task_indexes"], shard["task_total"]
    ):
        index = scheduled["index"]
        job_id = scheduled["job_id"]
        jobs.append(
            {
                **scheduled,
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
                "controller_command": [
                    "bash",
                    str(root / "scripts" / "run-bench"),
                    str(scheduled["task"]),
                    *args.forward_arg,
                    "--foreground",
                ],
            }
        )

    state: dict[str, object] = {
        "campaign_id": safe_id,
        **({"workspace_binding": workspace_binding} if workspace_binding else {}),
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
    identity = controller_identity()
    if identity is not None:
        state["controller"] = identity
    operator_settings = launch_operator_settings(os.environ)
    if operator_settings is not None:
        # Unset names use source defaults; a successor relaunches with exactly these.
        state["operator_settings"] = operator_settings
    for key in ("task_indexes", "group_total", "group_started_at"):
        if shard[key] is not None:
            state[key] = shard[key]
    if external_barrier is not None:
        state["external_barrier"] = {
            "directory": str(external_barrier),
            "status": None,
            "status_history": [],
            "release_id": None,
            "abort": None,
        }
    # Full-width ordinary campaigns also know every concurrently admitted owner.
    # Predeclare cleanup liability without introducing a task-start rendezvous.
    ordinary_cleanup = not strict_start and len(jobs) <= args.concurrency
    cleanup_ticketed = strict_start or ordinary_cleanup
    cleanup_identity_module = cleanup_ticket_module(root) if strict_start else None
    cleanup_parent_birth = cleanup_identity_module.birth(os.getpid()) if strict_start else ""
    cohorts: list[dict[str, object]] = []
    parent_lock = None
    if cleanup_ticketed:
        if strict_start and os.environ.get("CLOUDBENCH_SYNCHRONIZED_START", "1") != "1":
            raise SystemExit(
                "strict campaign startup requires synchronized fleet start"
            )
        barrier_root = campaign_dir / ("startup-cohorts" if strict_start else "cleanup-cohorts")
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
                    **({"e2e_deadline_monotonic": e2e_deadline} if e2e_deadline is not None else {}),
                },
            }
            cohorts.append(cohort)
            write_json_atomic(directory / "manifest.json", cohort["_manifest"])
            for job in members:
                if strict_start:
                    job["startup_cohort"] = cohort_id
                    job["startup_ready_at"] = None
                job["_cohort"] = cohort
        state["startup_cohorts" if strict_start else "cleanup_cohorts"] = cohorts
    write_json_atomic(summary_path, state)
    print(
        f"🧪 benchmark campaign: tasks={len(args.task)} runs={args.runs} "
        f"jobs={len(jobs)} concurrency={args.concurrency}"
    )
    print(f"   summary: {summary_path}")
    if operator_settings is None:
        print("   operator settings: UNRECORDED (launched without scripts/run-bench)")
    else:
        print("   operator settings: " + (" ".join(
            f"{name}={banner_setting_value(value)}" for name, value in operator_settings.items())
            or "none set (source defaults)"))
    scorecard = scorecard_hooks()
    experiment_goal = os.environ.get("RUN_BENCH_GOAL") or "campaign:" + ",".join(sorted(set(args.task)))[:120]
    record_experiment(scorecard, "launch", campaign_dir, root, goal=experiment_goal, kind="campaign",
                      slice=os.environ.get("RUN_BENCH_EXPERIMENT_LABEL") or (args.task[0] if len(args.task) == 1 else f"{len(set(args.task))} tasks"),
                      run_dir=str(campaign_dir), triggered_at=e2e_started_at, tasks=len(set(args.task)),
                      runs=args.runs, scheduled_total=len(jobs), surface="cloud")
    if scorecard is not None:
        scorecard["print_instruction"](campaign_dir)
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
        "   monitor: python3 -m json.tool " + shlex.quote(str(summary_path))
    )
    print(
        "   follow each job log's exact printed fleet-monitor command; "
        "the campaign directory is not a fleet-monitor handle."
    )
    print(
        "   controller status/exit is separate from monitor.task_outcomes; retain genuine task FAIL."
    )
    if external_barrier is not None:
        print(
            f"   external barrier: cohort readiness -> {external_barrier / 'ready.json'}; "
            "release waits for release.json there, abort.json aborts before release; "
            "each fleet keeps its own startup deadline."
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
    startup_timeout_exceeded = False

    def request_stop(signum: int, _frame: object) -> None:
        nonlocal stop_signal, stop_requests
        stop_signal = signum
        stop_requests += 1

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    started = time.monotonic()
    next_heartbeat = started + 10
    raw_margin = os.environ.get("CLOUDBENCH_CAMPAIGN_HOLDOUT_MARGIN_SECONDS", "300")
    if not raw_margin.isdigit() or int(raw_margin) < 1:
        raise ValueError("CLOUDBENCH_CAMPAIGN_HOLDOUT_MARGIN_SECONDS must be a positive integer")
    holdout_margin_seconds = float(raw_margin)
    first_failure = 0
    barrier_failure = False
    # The infra stop denominator is frozen from the schedule (the shared group
    # for a shard), never from finished attempts.
    infra_scheduled_total = int(shard["group_total"] or len(jobs))
    infra_policy = infra_stop_policy()
    # Resolved before any controller launches, so a missing predicate cannot
    # interrupt a running campaign.
    infra_reached = infra_stop_predicate()
    current_cohort: dict[str, object] | None = None

    def prepare_cleanup_tickets(cohort: dict[str, object]) -> None:
        nonlocal cleanup_identity_module, cleanup_parent_birth
        if cleanup_identity_module is None:
            # Persist the immutable dispatch plan and finish inventory admission
            # before ordinary campaigns request cleanup allocation authority.
            cleanup_identity_module = cleanup_ticket_module(root)
            cleanup_parent_birth = cleanup_identity_module.birth(os.getpid())
        common = subprocess.check_output(["git", "-C", str(workspace), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True).strip()
        reserve_root = Path(common) / "cloudbench-fleet-ownership"
        reserve_root.mkdir(mode=0o700, exist_ok=True)
        policy = stress_environment if stress_environment is not None else os.environ
        cleanup_ticket_command(root, "prepare", cohort,
            "--manifest", str(cohort["_directory"] / "manifest.json"),
            "--reserve-root", str(reserve_root),
            "--parent-pid", str(os.getpid()), "--parent-start", cleanup_parent_birth,
            "--preferred", policy.get("CLOUDBENCH_CLEANUP_DISK_RESERVE_MB", "512"),
            "--minimum", policy.get("CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB", "32"),
            "--headroom", policy.get("CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB", "256"),
            "--canary-script", str(root / "scripts/cloudbench-infra-canary-preflight.py"),
            "--canary-lock", policy.get("FLEET_INFRA_CANARY_LOCK", str(workspace / ".context/fleet-infra-canary-preflight.transaction.lock")),
            "--canary-source-ref", subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip())
        cohort["_cleanup_tickets_prepared"] = True

    def publish_external_barrier(cohort: dict[str, object], status: str) -> None:
        """Atomic coordinator projection, rewritten only on change; terminal is sticky."""
        if external_barrier is None or cohort.get("_external_terminal"):
            return
        value = {
            "schema": EXTERNAL_BARRIER_READY_SCHEMA,
            "cohort_id": cohort["cohort_id"],
            "status": status,
            "ready_count": cohort["ready_count"],
            "failed_count": cohort["failed_count"],
            "expected_count": cohort["expected_count"],
            "survivor_count": cohort["expected_count"] - cohort["failed_count"],
        }
        if cohort.get("_external_published") == value:
            return
        cohort["_external_published"] = value
        cohort["_external_terminal"] = status in ("failed", "aborted", "released")
        write_json_atomic(external_barrier / "ready.json", {**value, "updated_at": utc_now()})
        record = state["external_barrier"]
        if record["status"] != status:
            record["status"] = status
            record["status_history"].append({"status": status, "at": utc_now()})
            write_json_atomic(summary_path, state)

    def external_abort_pending() -> bool:
        return external_barrier is not None and (
            (external_barrier / "abort.json").exists()
            or (external_barrier / "abort.json").is_symlink()
        )

    def observe_external_abort() -> bool:
        """Abort the single cohort before release; later requests are ignored."""
        nonlocal barrier_failure, first_failure
        if external_barrier is None:
            return False
        cohort = cohorts[0]
        if state["external_barrier"]["abort"] is not None:
            return True
        if cohort["status"] not in ("queued", "waiting"):
            return False
        request = external_barrier_abort(external_barrier)
        if request is None:
            return False
        state["external_barrier"]["abort"] = {**request, "observed_at": utc_now()}
        barrier_failure = True
        first_failure = first_failure or 1
        abort_startup_cohort(
            cohort, "external barrier abort: " + str(request["reason"]), status="aborted"
        )
        print(
            f"🛑 campaign startup {cohort['cohort_id']}: external barrier aborted before release"
        )
        write_json_atomic(summary_path, state)
        return True

    def abort_startup_cohort(
        cohort: dict[str, object], reason: str, status: str = "failed"
    ) -> None:
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
        # signal-cancellation path, which signals every controller group.
        for job in cohort["_jobs"]:
            if "_process" in job:
                job["_aborted_by_campaign"] = True
        publish_external_barrier(cohort, status)

    def exclude_startup_holdouts(
        cohort: dict[str, object],
        survivors: list[dict[str, object]],
        ready_deadlines: list[tuple[float, float]],
    ) -> bool:
        """Exclude live never-ready members before a ready copy's deadline.

        Each fleet excludes its own holdout only after its per-box window,
        measured from its own barrier start, while a ready copy gives up at the
        same window from *its* barrier start. A member that reached its barrier
        later (a SIM clone restore, a slow allocation) is therefore excluded only
        after every ready copy has expired, failing the whole cohort (#16,
        2026-10-20: 39/40 ready, 40/40 failed). The holdout is an infrastructure
        failure; it leaves through its controller's own TERM teardown.
        """
        if not ready_deadlines:
            return False
        holdouts = [
            job
            for job in survivors
            if not (cohort["_directory"] / "ready" / f"{job['job_id']}.json").is_file()
        ]
        if not holdouts:
            return False
        earliest, started = min(ready_deadlines)
        # Never spend more than a quarter of that copy's own startup budget.
        margin = min(holdout_margin_seconds, max(0.0, (earliest - started) / 4))
        if time.time() < earliest - margin:
            return False
        excluded = cohort.setdefault("holdouts_excluded", [])
        for job in holdouts:
            job["startup_failed_before_release"] = True
            job["startup_holdout_excluded"] = True
            excluded.append(
                {
                    "job_id": job["job_id"],
                    "task": job["task"],
                    "excluded_at": utc_now(),
                    "earliest_ready_deadline": earliest,
                    "margin_seconds": margin,
                }
            )
            print(
                f"⚠️ campaign startup {cohort['cohort_id']}: excluding holdout {job['job_id']} "
                f"task={job['task']} (not ready {margin:.0f}s before the earliest ready copy's deadline)"
            )
            log = Path(str(job["log"]))
            try:
                tail = log.read_text(errors="replace").splitlines()[-15:]
            except OSError:
                tail = []
            for line in tail:
                print(f"   ┆ {job['job_id']} {line[:240]}")
            process = job["_process"]
            if isinstance(process, subprocess.Popen) and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        write_json_atomic(summary_path, state)
        return True

    def release_ready_cohort(cohort: dict[str, object]) -> None:
        nonlocal barrier_failure, first_failure
        if cohort["status"] != "waiting":
            return
        if observe_external_abort():
            return
        if startup_expired():
            barrier_failure = True
            first_failure = first_failure or 1
            abort_startup_cohort(cohort, "startup budget exhausted; full task and post-task windows reserved")
            return
        ready_count = 0
        failed_count = 0
        survivors = []
        ready_deadlines: list[tuple[float, float]] = []
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
            deadline = receipt.get("deadline")
            if isinstance(deadline, (int, float)) and not isinstance(deadline, bool) and math.isfinite(deadline):
                ready_deadlines.append((float(deadline), float(job.get("_started_epoch") or deadline)))
        if exclude_startup_holdouts(cohort, survivors, ready_deadlines):
            return
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
        if external_barrier is not None and (failed_count or len(cohort["_jobs"]) != cohort["expected_count"]):
            barrier_failure = True
            first_failure = first_failure or 1
            abort_startup_cohort(cohort, "required shard member failed before global release")
            return
        if not survivors:
            cohort["status"] = "failed"
            publish_external_barrier(cohort, "failed")
            write_json_atomic(summary_path, state)
            return
        if ready_count != (cohort["expected_count"] if external_barrier is not None else len(survivors)):
            publish_external_barrier(cohort, "waiting")
            return
        if external_barrier is not None:
            # Every survivor is ready; only the coordinator's global release
            # remains. Each fleet still fails strictly at its own deadline.
            publish_external_barrier(cohort, "ready")
            try:
                release_id = external_barrier_release_id(external_barrier)
            except (OSError, ValueError):
                barrier_failure = True
                first_failure = first_failure or 1
                state["external_barrier"]["release_error"] = "invalid release request"
                abort_startup_cohort(cohort, "external barrier release request is invalid")
                write_json_atomic(summary_path, state)
                return
            if release_id is None:
                return
            state["external_barrier"]["release_id"] = release_id
            state["external_barrier"]["released_at"] = utc_now()
        if startup_expired():
            barrier_failure = True
            first_failure = first_failure or 1
            abort_startup_cohort(cohort, "startup budget exhausted before local release")
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
        publish_external_barrier(cohort, "released")
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
    shared_relay = None
    inventory_process = None
    inventory_log = None
    inventory_directory = None
    mutation_authority = None
    stress_requirements = None
    stress_environment = None
    inventory_failure_signalled = False
    try:
        if not os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID") and not os.environ.get(
            "BENCHMARK_HUB_PARENT_RUN_ID"
        ):
            publish_campaign_group(
                workspace,
                campaign_dir,
                state,
                live=True,
                stop_requested=lambda: bool(stop_signal) or deadline_expired(),
            )
        if (
            not stop_signal
            and not deadline_expired()
            and not startup_expired()
            # A width-1 campaign normally skips the shared feed. Without the relay, its lone
            # controller's flyctl starts the unowned per-HOME `flyctl agent` daemon, which outlives
            # the campaign. Owned callers (the /deploy smoke adapter, whose single same-source rerun
            # has width 1) ask for the owned inventory, relay and private agent at any width.
            and (args.concurrency > 1 or os.environ.get("CLOUDBENCH_CAMPAIGN_OWNED_TRANSPORT") == "1")
            and not all_production_only
            and os.environ.get("CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY", "1") == "1"
        ):
            try:
                inventory_process, inventory_log, inventory_directory = (
                    start_shared_inventory(root, campaign_dir, workspace)
                )
                if args.stress_defaults or os.environ.get("CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION", "0") == "1":
                    mutation_authority = mutation_inventory_authority(inventory_directory, inventory_process)
                print(
                    "Campaign inventory: one parent-owned native feed for all cloud controllers; capacity and resource mutation checks remain live"
                )
                if os.environ.get("CLOUDBENCH_CAMPAIGN_SHARED_RELAY", "1") == "1" and sys.platform.startswith("linux"):
                    shared_relay = start_shared_relay(root, campaign_dir, workspace, inventory_directory, e2e_deadline)
                state["shared_inventory"] = {
                    "directory": str(inventory_directory),
                    "publisher_pid": inventory_process.pid,
                }
            # Startup reads (flyctl status, git show, owner records) can also
            # raise these before any controller starts; fail the campaign normally.
            except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as startup_error:
                first_failure = 1
                barrier_failure = True
                state["shared_inventory_failed"] = True
                print(
                    f"Campaign inventory did not initialize; see private publisher log ({type(startup_error).__name__}: {startup_error})"
                )
            write_json_atomic(summary_path, state)
        while pending or active:
            if not stop_signal and startup_expired() and not any(c.get("status") == "released" for c in cohorts):
                startup_timeout_exceeded = True
                state["startup_timeout_exceeded"] = True
                if current_cohort:
                    abort_startup_cohort(current_cohort, "startup budget exhausted before task launch")
                request_stop(signal.SIGTERM, None)
            if deadline_expired() and not state["e2e_timeout_exceeded"]:
                state["e2e_timeout_exceeded"] = True
                request_stop(signal.SIGTERM, None)
                print("Whole-experiment limit reached; no new attempt admitted, exact controllers continue through owned cleanup.")
            if external_barrier is not None:
                observe_external_abort()
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
            if args.stress_defaults and stress_environment is None and not barrier_failure and not stop_signal:
                try:
                    if mutation_authority is None:
                        raise ValueError("stress defaults require the existing parent-owned native inventory")
                    observation, baseline = stress_inventory_baseline(root, mutation_authority)
                    if observation == 75:
                        # Re-observe under the original whole-experiment clock, no native fallback.
                        time.sleep(0.1)
                        continue
                    from cloudbench_catalog import get_task_metadata
                    rows = get_task_metadata(root / "agents/benchmarks/tasks.json", args.task)
                    autoscale_max = 15
                    for index, argument in enumerate(args.forward_arg):
                        if argument == "--autoscale-max":
                            autoscale_max = int(args.forward_arg[index + 1])
                    stress_requirements = stress_default_requirements(root, rows, peak=args.concurrency, baseline=baseline, autoscale_max=autoscale_max, repetitions=args.runs if args.concurrency == 600 else 1)
                    stress_environment = stress_default_environment(stress_requirements, os.environ)
                    state["stress_defaults"] = stress_requirements
                    write_json_atomic(summary_path, state)
                    print("Stress local defaults derived from actual profiles and parent native baseline; org quotas remain unverified and native admission/refusal stays authoritative")
                except (OSError, ValueError, IndexError, RuntimeError):
                    barrier_failure = True
                    first_failure = first_failure or 1
                    state["stress_defaults_failed"] = True
                    write_json_atomic(summary_path, state)
            if ordinary_cleanup and not barrier_failure and not cohorts[0].get("_cleanup_tickets_prepared"):
                try:
                    prepare_cleanup_tickets(cohorts[0])
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    first_failure = first_failure or 1
                    barrier_failure = True
                    state["cleanup_ticket_failure"] = "prepare"
                    # Keep the native refusal without exposing subprocess argv,
                    # credentials, tracebacks or a file's contents in telemetry.
                    if isinstance(error, subprocess.SubprocessError):
                        message = "cleanup preparation subprocess failed"
                    elif isinstance(error, OSError):
                        message = os.strerror(error.errno) if error.errno else "cleanup preparation filesystem error"
                    else:
                        message = str(error).splitlines()[0][:400] if str(error) else "cleanup preparation validation failed"
                    state["cleanup_ticket_error"] = {"type": type(error).__name__, "message": message}
                    write_json_atomic(summary_path, state)
            if strict_start and not active and current_cohort and current_cohort.get("_cleanup_tickets_prepared") and not current_cohort.get("_cleanup_tickets_retired") and all(member["status"] not in {"queued", "running"} for member in current_cohort["_jobs"]):
                try:
                    cleanup_ticket_command(root, "retire", current_cohort)
                    current_cohort["_cleanup_tickets_retired"] = True
                except (OSError, ValueError, subprocess.SubprocessError):
                    first_failure = first_failure or 1
                    current_cohort["cleanup_budget_retirement_pending"] = True
            if strict_start and not active and not barrier_failure and not (pending and pending[0].get("_independent_retry")):
                current_cohort = pending[0]["_cohort"] if pending else None
                if current_cohort:
                    if not current_cohort.get("_cleanup_tickets_prepared"):
                        try:
                            prepare_cleanup_tickets(current_cohort)
                        except (OSError, ValueError, subprocess.SubprocessError) as error:
                            # End through normal summary/Hub finalization, never a traceback.
                            first_failure = first_failure or 1
                            barrier_failure = True
                            state["cleanup_ticket_failure"] = "prepare"
                            state["cleanup_ticket_failure_detail"] = cleanup_ticket_failure_detail(error)
                            abort_startup_cohort(current_cohort, "cleanup ticket preparation failed before child admission")
                            write_json_atomic(summary_path, state)
                            continue
                    current_cohort["status"] = "waiting"
                    publish_external_barrier(current_cohort, "waiting")
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
                                        str(workspace),
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
                                            or startup_expired()
                                            or inventory_process.poll() is not None
                                            or external_abort_pending()
                                        ):
                                            if startup_expired():
                                                startup_timeout_exceeded = True
                                                state["startup_timeout_exceeded"] = True
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
                            if not observe_external_abort():
                                abort_startup_cohort(
                                    current_cohort,
                                    "canonical fixture full GET failed before child admission",
                                )
                                print(
                                    "Campaign canonical fixture preflight failed; no cohort controller admitted"
                                )
                        write_json_atomic(summary_path, state)
                    if not barrier_failure and not current_cohort.get("_canary_proof"):
                        try:
                            policy = (
                                dict(stress_environment)
                                if stress_environment is not None
                                else os.environ.copy()
                            )
                            for key in (
                                "CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT",
                                "CLOUDBENCH_COHORT_PREFLIGHT_SHA256",
                                *CAMPAIGN_SHARD_VARIABLES,
                            ):
                                policy.pop(key, None)
                            ref = subprocess.check_output(
                                ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
                            ).strip()
                            requested_ref = next(
                                (
                                    args.forward_arg[i + 1]
                                    for i, arg in enumerate(args.forward_arg[:-1])
                                    if arg == "--ref"
                                ),
                                ref,
                            )
                            bench_ref = subprocess.check_output(
                                ["git", "-C", str(workspace), "rev-parse", requested_ref + "^{commit}"],
                                text=True,
                            ).strip()
                            bind_mutation_inventory(policy, inventory_directory, mutation_authority)
                            bind_shared_relay(policy, shared_relay)
                            policy.update(
                                RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(current_cohort["_directory"]),
                                RUN_BENCH_CAMPAIGN_COHORT=str(current_cohort["cohort_id"]),
                                RUN_BENCH_CLEANUP_COHORT_DIR=str(current_cohort["_directory"]),
                                RUN_BENCH_CLEANUP_COHORT_ID=str(current_cohort["cohort_id"]),
                                RUN_BENCH_CLEANUP_JOB="__campaign_preflight__",
                                RUN_BENCH_CLEANUP_GENERATION="1",
                                CLOUDBENCH_CAMPAIGN_PARENT_PREFLIGHT="1",
                                CLOUDBENCH_INFRA_CANARY_COLD_BOOTSTRAP="1"
                                if "--cold-primary-bootstrap" in args.forward_arg
                                else "0",
                                CLOUDBENCH_INFRA_CANARY_REF=bench_ref,
                            )
                            if e2e_deadline is not None:
                                policy["RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC"] = str(e2e_deadline)
                            for key, default in (
                                ("FLEET_INFRA_CANARY_TTL_SECONDS", "3600"),
                                ("FLEET_INFRA_CANARY_PREFLIGHT_N", "2"),
                            ):
                                if (
                                    not policy.get(key, default).isdigit()
                                    or int(policy.get(key, default)) <= 0
                                ):
                                    policy[key] = default
                            argv = [
                                sys.executable,
                                "-S",
                                str(root / "scripts/cloudbench-infra-canary-preflight.py"),
                                "--stamp",
                                policy.get(
                                    "FLEET_INFRA_CANARY_STAMP",
                                    str(workspace / ".context/fleet-infra-canary.last-pass"),
                                ),
                                "--lock",
                                policy.get(
                                    "FLEET_INFRA_CANARY_LOCK",
                                    str(
                                        workspace / ".context/fleet-infra-canary-preflight.transaction.lock"
                                    ),
                                ),
                                "--ttl-seconds",
                                policy.get("FLEET_INFRA_CANARY_TTL_SECONDS", "3600"),
                                "--width",
                                policy.get("FLEET_INFRA_CANARY_PREFLIGHT_N", "2"),
                                "--canary",
                                str(root / "scripts/run-fleet-infra-canary"),
                                "--nested-controller-lock",
                                "cloudbench-controller-infra-canary-preflight.lock",
                            ]
                            log = current_cohort["_directory"] / "infra-canary-preflight.private.log"
                            with log.open("w") as stream:
                                log.chmod(0o600)
                                child = subprocess.Popen(
                                    argv, cwd=workspace, env=policy, stdout=stream, stderr=subprocess.STDOUT
                                )
                                terminated = False
                                try:
                                    while child.poll() is None:
                                        if not terminated and (
                                            stop_signal
                                            or deadline_expired()
                                            or startup_expired()
                                            or inventory_process is not None
                                            and inventory_process.poll() is not None
                                            or external_abort_pending()
                                        ):
                                            if startup_expired():
                                                startup_timeout_exceeded = True
                                                state["startup_timeout_exceeded"] = True
                                            child.terminate()
                                            terminated = True
                                        try:
                                            child.wait(timeout=0.2)
                                        except subprocess.TimeoutExpired:
                                            pass
                                finally:
                                    if child.poll() is None:
                                        child.terminate()
                                        child.wait()
                            if child.returncode or stop_signal or deadline_expired() or external_abort_pending():
                                raise ValueError("parent infrastructure canary did not pass")
                            receipt = current_cohort["_directory"] / "infra-canary-preflight.pass.json"
                            current_cohort["_canary_proof"] = {
                                "path": str(receipt),
                                "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
                            }
                        except (OSError, ValueError, subprocess.SubprocessError):
                            first_failure = first_failure or 1
                            barrier_failure = True
                            if not observe_external_abort():
                                abort_startup_cohort(
                                    current_cohort, "canonical parent N2 failed before worker admission"
                                )
                            write_json_atomic(summary_path, state)
            launched_this_round = False
            while (
                pending
                and len(active) < args.concurrency
                and not stop_signal
                and not barrier_failure
                and not deadline_expired()
                and (not strict_start or pending[0].get("_independent_retry") or pending[0]["_cohort"] is current_cohort)
            ):
                job = pending.popleft()
                launched_this_round = True
                environment = dict(stress_environment) if stress_environment is not None else os.environ.copy()
                for key in ("CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT", "CLOUDBENCH_COHORT_PREFLIGHT_SHA256", "CLOUDBENCH_CAMPAIGN_PARENT_PREFLIGHT", *CAMPAIGN_SHARD_VARIABLES):
                    environment.pop(key, None)
                # Group membership is distinct from publication ownership. Each
                # child still registers, publishes and acknowledges its own run;
                # the Hub projects these durable members as one campaign.
                environment.update(
                    {
                        "BENCHMARK_HUB_GROUP_RUN_ID": environment.get(
                            "BENCHMARK_HUB_GROUP_RUN_ID"
                        )
                        or safe_id,
                        # A shard publishes the operator's shared group clock and size.
                        "RUN_BENCH_CAMPAIGN_STARTED_AT": str(
                            shard["group_started_at"] or state["started_at"]
                        ),
                        "RUN_BENCH_CAMPAIGN_TOTAL_JOBS": str(
                            shard["group_total"] or len(jobs)
                        ),
                        "RUN_BENCH_CAMPAIGN_CHILD": "1",
                        # Fleets pace guest Temporal visibility calls across
                        # every concurrently admitted campaign controller.
                        "CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS": str(args.concurrency),
                        # The provider rate-limit check counts the whole group.
                        PROVIDER_GLOBAL_BENCHES_ENV: str(global_benches),
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
                bind_mutation_inventory(environment, inventory_directory, mutation_authority)
                bind_shared_relay(environment, shared_relay)
                environment.pop("CLOUDBENCH_CAMPAIGN_SEED_PROOF", None)
                if strict_start and not job.get("_independent_retry"):
                    if current_cohort.get("_seed_proof"):
                        environment["CLOUDBENCH_CAMPAIGN_SEED_PROOF"] = str(
                            current_cohort["_seed_proof"]
                        )
                    proof = current_cohort["_canary_proof"]
                    environment["CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT"] = proof["path"]
                    environment["CLOUDBENCH_COHORT_PREFLIGHT_SHA256"] = proof["sha256"]
                    environment.update(
                        {
                            "RUN_BENCH_CAMPAIGN_BARRIER_DIR": str(
                                current_cohort["_directory"]
                            ),
                            "RUN_BENCH_CAMPAIGN_COHORT": str(
                                current_cohort["cohort_id"]
                            ),
                            **({"RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC": str(e2e_deadline)} if e2e_deadline is not None else {}),
                        }
                    )
                else:
                    # A new ordinary campaign must not inherit a prior child's
                    # diagnostic rendezvous from the calling shell.
                    environment.pop("RUN_BENCH_CAMPAIGN_BARRIER_DIR", None)
                    environment.pop("RUN_BENCH_CAMPAIGN_COHORT", None)
                    environment.pop("RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC", None)
                if cleanup_ticketed:
                    environment["RUN_BENCH_CLEANUP_COHORT_DIR"] = str(job["_cohort"]["_directory"])
                    environment["RUN_BENCH_CLEANUP_COHORT_ID"] = str(job["_cohort"]["cohort_id"])
                    environment["RUN_BENCH_CLEANUP_JOB"] = str(job["job_id"])
                    environment["RUN_BENCH_CLEANUP_GENERATION"] = str(job.get("attempt", 1))
                command = job["controller_command"]
                log_handle = open(str(job["log"]), "w", encoding="utf-8")
                process = subprocess.Popen(
                    controller_prefix + command,
                    cwd=workspace,
                    env=environment,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    **controller_process_options,
                )
                job["_process"] = process
                job["controller_pid"] = process.pid
                job["_log_handle"] = log_handle
                job["_started_monotonic"] = time.monotonic()
                job["_started_epoch"] = time.time()
                job["started_at"] = utc_now()
                job["status"] = "running"
                active[process.pid] = job
                if cleanup_ticketed:
                    try:
                        cleanup_ticket_command(root, "assign", job["_cohort"],
                            "--job", str(job["job_id"]), "--owner-pid", str(process.pid),
                            "--owner-start", cleanup_identity_module.birth(process.pid),
                            "--generation", str(job.get("attempt", 1)))
                    except (OSError, ValueError, subprocess.SubprocessError):
                        # The unassigned child cannot claim cleanup authority.
                        # Cancel it through its owned TERM teardown; the normal
                        # join path reaps it while the campaign finalizes failed.
                        first_failure = first_failure or 1
                        barrier_failure = True
                        job["cleanup_ticket_assignment_failed"] = True
                        state["cleanup_ticket_failure"] = "assign"
                        abort_startup_cohort(job["_cohort"], "cleanup ticket assignment failed")
                        terminate_owned_children({process.pid: job})
                if strict_start and not job.get("_independent_retry"):
                    current_cohort["_manifest"]["jobs"][str(job["job_id"])] = (
                        process.pid
                    )
                    # Keyed owner tickets authorize children immediately. Seal
                    # the complete barrier PID projection once after dispatch,
                    # rather than rewrite N-member JSON for every new child.
                state["peak_concurrency"] = max(
                    int(state["peak_concurrency"]), len(active)
                )
                print(
                    f"▶ {job['job_id']} task={job['task']} run={job['run']} pid={process.pid}"
                )
                # Dispatch does not wait for admission/allocation. Publish the
                # aggregate projection once after this natural launch loop.

            if launched_this_round:
                if strict_start and current_cohort and current_cohort.get("_cleanup_tickets_prepared"):
                    write_json_atomic(current_cohort["_directory"] / "manifest.json", current_cohort["_manifest"])
                write_json_atomic(summary_path, state)

            if stop_signal and not termination_requested:
                termination_requested = True
                if current_cohort:
                    abort_startup_cohort(current_cohort, "user cancelled campaign")
                if state["e2e_timeout_exceeded"] or startup_timeout_exceeded:
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
                    if external_barrier is not None:
                        # Withdraw stale ready status before classifying/retrying this attempt.
                        job["_cohort"]["failed_count"] = sum(bool(member.get("startup_failed_before_release")) for member in job["_cohort"]["_jobs"])
                        job["_cohort"]["ready_count"] = 0
                        publish_external_barrier(job["_cohort"], "waiting")
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
                # Every exited attempt records its verdict and release seal from the same
                # physical receipts; the scorecard and retries read them with or without retries.
                disposition = released_attempt(workspace, job)
                for key in ("run_id", "fleet_dir", "fleet_owner_token", "task_status",
                            "resources_released", "lifecycle_verified", "infra_failure", "terminal_task",
                            "released_at_epoch", "retry_blocked"):
                    job.pop(key, None)
                job.update(disposition)
                if args.retry_infra:
                    job["attempts"].append({key: job.get(key) for key in (
                        "attempt", "log", "controller_pid", "started_at", "finished_at", "wall_clock_seconds",
                        "controller_exit_code", "status", "run_id", "fleet_dir", "fleet_owner_token", "task_status",
                        "resources_released", "lifecycle_verified", "infra_failure", "terminal_task", "released_at_epoch",
                        "retry_blocked")})
                    if (disposition.get("lifecycle_verified") and disposition.get("terminal_task")
                            and job["status"] != "cancelled"):
                        job["status"] = "passed"  # infrastructure health; task verdict is retained separately
                    elif (disposition.get("resources_released") and disposition.get("infra_failure")
                          and job["attempt"] <= args.retry_infra and not stop_signal and not barrier_failure and not deadline_expired()
                          and (external_barrier is None or not exited_before_release or not startup_expired())):
                        job["attempt"] += 1
                        job["status"] = "queued"
                        job["log"] = str(campaign_dir / f"{job['job_id']}.attempt-{job['attempt']}.log")
                        if external_barrier is not None and exited_before_release:
                            rejoin_required_cohort(job)
                        else:
                            job["_independent_retry"] = True
                        pending.appendleft(job)
                        print(f"↻ {job['job_id']} INFRA attempt released; admitting fresh attempt {job['attempt']} without restarting peers")
                    else:
                        first_failure = first_failure or exit_code or 1
                elif exit_code and not first_failure:
                    first_failure = exit_code
                if "infra_stop" not in state and not stop_signal:
                    breach = infra_stop_receipt(jobs, infra_scheduled_total, infra_policy, infra_reached)
                    if breach is not None:
                        state["infra_stop"] = {
                            "job_id": job["job_id"], "task": job["task"], "attempt": job.get("attempt", 1),
                            "task_status": job.get("task_status"), **breach,
                            "observed_at": utc_now(), "breached_at_epoch": time.time(),
                        }
                        print(
                            f"🛑 INFRA STOP: {breach['infra_jobs']}/{infra_scheduled_total} scheduled jobs are "
                            f"confirmed infrastructure failures (>= 5%); breach at {job['job_id']} "
                            f"({job.get('task_status')}). Cancelling the remaining jobs through their owned teardown.",
                            file=sys.stderr, flush=True,
                        )
                        first_failure = first_failure or exit_code or 1
                        barrier_failure = True
                        if current_cohort:
                            abort_startup_cohort(current_cohort, "infrastructure stop threshold reached")
                        terminate_owned_children(active)
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
        if external_barrier is not None:
            # A coordinator must never wait on a campaign that can no longer
            # release; released and aborted projections are already terminal.
            publish_external_barrier(cohorts[0], "failed")
        for job in active.values():
            process = job.get("_process")
            if isinstance(process, subprocess.Popen):
                process.wait()
            handle = job.get("_log_handle")
            if handle is not None:
                handle.close()
        if shared_relay is not None:
            if not stop_shared_relay(shared_relay):
                first_failure = first_failure or 1
                state['shared_transport_cleanup_pending'] = True
        if inventory_process is not None:
            if not stop_shared_inventory(
                inventory_process, inventory_log, inventory_directory
            ):
                first_failure = first_failure or 1
                state["shared_inventory_failed"] = True
        for cohort in cohorts:
            if cohort.get("_cleanup_tickets_prepared") and not cohort.get("_cleanup_tickets_retired"):
                try:
                    cleanup_ticket_command(root, "retire", cohort)
                    cohort["_cleanup_tickets_retired"] = True
                except (OSError, ValueError, subprocess.SubprocessError):
                    first_failure = first_failure or 1
                    cohort["cleanup_budget_retirement_pending"] = True
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
    # A parent (for example the Hub poller) owns group publication when it
    # supplies a group or parent run ID; only an attempted publication can fail.
    publication_attempted = not os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID") and not os.environ.get(
        "BENCHMARK_HUB_PARENT_RUN_ID"
    )
    if publication_attempted:
        # An existing cutoff/cancellation has already closed the controllers.
        # Publish that failed terminal group through the ordinary transport;
        # only a new stop during this handoff invokes its existing session drain.
        # Cleanup can exceed the outer cap, but the run still gets zero credit.
        stops_before_publication = stop_requests
        deadline_before_publication = deadline_expired()
        publication_completed = publish_campaign_group(
            workspace,
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
    if args.retry_infra and publication_attempted and not publication_completed:
        state["status"] = "failed" if not stop_signal else "cancelled"
        result = result or 1
    try:
        join_native_hubs(root, campaign_dir)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        state['shared_transport_cleanup_pending'] = True
        if state['status'] == 'passed':
            state['status'] = 'failed'
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
    record_experiment(scorecard, "end", campaign_dir, root, goal=experiment_goal, ended_at=time.time(),
                      state={"passed": "COMPLETE", "failed": "FAILED", "cancelled": "ABORTED"}.get(state["status"], "ENDED"))
    if scorecard is not None:
        scorecard["print_instruction"](campaign_dir)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
