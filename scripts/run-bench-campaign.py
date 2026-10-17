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
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType


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
                "FLEET_BUNDLED_FRONTEND_VM_SIZE", "FLEET_BUNDLED_FRONTEND_VM_MEMORY"):
        matches = [line for line in source.splitlines() if line.startswith(key + "=")]
        if len(matches) != 1:
            raise ValueError("ambiguous actual VM profile")
        assignments.extend(matches)
    functions = []
    for name in ("bench_needs_large_primary", "primary_vm_size_for_bench", "primary_vm_memory_for_bench"):
        start = source.index(name + "() {")
        functions.append(source[start:source.index("\n}\n", start) + 3])
    browser_names = [row["name"] for row in rows if row.get("requires_browser_agent")]
    script = "set -euo pipefail\nINFRA_PROBE=0\n" + "\n".join(assignments + functions)
    script += "\nCATALOG_BROWSER_REQUIRED_TASKS=(" + " ".join(shlex.quote(name) for name in browser_names) + ")\n"
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
    result.setdefault("CLOUDBENCH_SHARED_CPU_GOVERNOR", str(max(160, int(requirements["local_shared_cpu_governor_minimum"]))))
    result.setdefault("CLOUDBENCH_APP_MACHINE_CEILING", str(max(56, int(requirements["local_machine_ceiling_minimum"]))))
    result.setdefault("CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION", "1")
    return result


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
            and ((not registry.exists() and not registry.is_symlink()) or runpy.run_path(
                str(Path(__file__).with_name("cloudbench-retained-successor.py"))
            )["released"](registry, audit, fleet, owner, run_id))
            and lifecycle.get("hub_publication_failed") is False
            and task.get("lifecycle_stage") == "released"
        )
        # The fleet's lifecycle verdict also covers execution completion, the
        # mandatory autoscaler and the controller exit; release alone does not.
        return {"run_id": run_id, "fleet_dir": str(fleet), "fleet_owner_token": owner,
                "task_status": status, "resources_released": closed,
                "lifecycle_verified": closed and lifecycle.get("status") == "verified",
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


def start_shared_relay(root: Path, campaign_dir: Path, workspace: Path,
                       inventory: Path, deadline: float | None) -> dict:
    """Own one canonical Fly bootstrap and one relay until all children join."""
    ref = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    checked = {}
    for relative in ['scripts/cloudbench-shared-relay.py', 'scripts/lib/cloudbench-inventory.sh', 'scripts/run-bench-cloud', 'scripts/run-bench-fleet']:
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
    metadata = subprocess.run(['flyctl', 'status', '-a', app, '--json'], cwd=workspace,
                              env=environment, capture_output=True, timeout=30)
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
                                              stderr=subprocess.STDOUT, start_new_session=True)
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
                                    CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH=ready['agent']['birth'])
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
        write_json_atomic(directory / 'startup-cleanup.json', {
            'bootstrap_joined': value['bootstrap'] is not None and value['bootstrap'].returncode is not None,
            'broker_joined': value['process'] is not None and value['process'].returncode is not None,
            'agent_shutdown_verified': False, 'agent_retirement_pending': value['bootstrap'] is not None})
        log.close(); bootstrap_log.close()
        try: archive_shared_relay(directory, archive)
        except OSError: pass  # Preserve the original startup failure and records.
        raise


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
    identity = cleanup_ticket_module(Path(value['module']).parent.parent)
    agent = value['agent']
    while identity.birth(agent['pid']) == agent['birth']:
        try: state = Path('/proc', str(agent['pid']), 'stat').read_text().rsplit(') ', 1)[1].split()[0]
        except FileNotFoundError: break
        if state in ('Z', 'X'): break
        time.sleep(.1)
    value['log'].close(); value['bootstrap_log'].close()
    archive_shared_relay(value['directory'], value['archive'])
    return acknowledged and process.returncode == 0


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
    workspace, workspace_binding = campaign_workspace(root, args.forward_arg)
    if args.stress_defaults and (args.concurrency not in (200, 600) or args.runs != 3 or len(args.task) != 200 or len(set(args.task)) != 200):
        raise SystemExit("--stress-defaults requires 200 distinct tasks, k3, peak200 or peak600")
    if args.stress_defaults_plan:
        from cloudbench_catalog import get_task_metadata
        rows = get_task_metadata(root / "agents/benchmarks/tasks.json", args.task)
        print(json.dumps(stress_default_requirements(root, rows, peak=args.concurrency, baseline=None, repetitions=args.runs if args.concurrency == 600 else 1), indent=2))
        return 2  # Planning only: baseline unknown, no campaign/provider mutation.
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
    strict_start = (
        "--strict-barrier" in args.forward_arg
        or os.environ.get("CLOUDBENCH_STRICT_BARRIER") == "1"
    )
    cleanup_identity_module = cleanup_ticket_module(root) if strict_start else None
    cleanup_parent_birth = cleanup_identity_module.birth(os.getpid()) if strict_start else ""
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
                    **({"e2e_deadline_monotonic": e2e_deadline} if e2e_deadline is not None else {}),
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
            and args.concurrency > 1
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
                        common = subprocess.check_output(["git", "-C", str(workspace), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True).strip()
                        reserve_root = Path(common) / "cloudbench-fleet-ownership"
                        reserve_root.mkdir(mode=0o700, exist_ok=True)
                        policy = stress_environment if stress_environment is not None else os.environ
                        cleanup_ticket_command(root, "prepare", current_cohort,
                            "--manifest", str(current_cohort["_directory"] / "manifest.json"),
                            "--reserve-root", str(reserve_root),
                            "--parent-pid", str(os.getpid()), "--parent-start", cleanup_parent_birth,
                            "--preferred", policy.get("CLOUDBENCH_CLEANUP_DISK_RESERVE_MB", "512"),
                            "--minimum", policy.get("CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB", "32"),
                            "--headroom", policy.get("CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB", "256"),
                            "--canary-script", str(root / "scripts/cloudbench-infra-canary-preflight.py"),
                            "--canary-lock", policy.get("FLEET_INFRA_CANARY_LOCK", str(workspace / ".context/fleet-infra-canary-preflight.transaction.lock")),
                            "--canary-source-ref", subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip())
                        current_cohort["_cleanup_tickets_prepared"] = True
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
                                            or inventory_process is not None
                                            and inventory_process.poll() is not None
                                        ):
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
                            if child.returncode or stop_signal or deadline_expired():
                                raise ValueError("parent infrastructure canary did not pass")
                            receipt = current_cohort["_directory"] / "infra-canary-preflight.pass.json"
                            current_cohort["_canary_proof"] = {
                                "path": str(receipt),
                                "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
                            }
                        except (OSError, ValueError, subprocess.SubprocessError):
                            first_failure = first_failure or 1
                            barrier_failure = True
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
                for key in ("CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT", "CLOUDBENCH_COHORT_PREFLIGHT_SHA256", "CLOUDBENCH_CAMPAIGN_PARENT_PREFLIGHT"):
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
                if mutation_authority is not None:
                    environment["CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY"] = mutation_authority
                else:
                    environment.pop("CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY", None)
                if shared_relay is not None:
                    environment.update(shared_relay['environment'])
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
                if strict_start:
                    environment["RUN_BENCH_CLEANUP_COHORT_DIR"] = str(job["_cohort"]["_directory"])
                    environment["RUN_BENCH_CLEANUP_COHORT_ID"] = str(job["_cohort"]["cohort_id"])
                    environment["RUN_BENCH_CLEANUP_JOB"] = str(job["job_id"])
                    environment["RUN_BENCH_CLEANUP_GENERATION"] = str(job.get("attempt", 1))
                command = [
                    "bash",
                    str(root / "scripts" / "run-bench"),
                    str(job["task"]),
                    *args.forward_arg,
                    "--foreground",
                ]
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
                job["started_at"] = utc_now()
                job["status"] = "running"
                active[process.pid] = job
                if strict_start:
                    cleanup_ticket_command(root, "assign", job["_cohort"],
                        "--job", str(job["job_id"]), "--owner-pid", str(process.pid),
                        "--owner-start", cleanup_identity_module.birth(process.pid),
                        "--generation", str(job.get("attempt", 1)))
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
                    disposition = released_attempt(workspace, job)
                    for key in ("run_id", "fleet_dir", "fleet_owner_token", "task_status",
                                "resources_released", "lifecycle_verified", "infra_failure", "terminal_task",
                                "released_at_epoch", "retry_blocked"):
                        job.pop(key, None)
                    job.update(disposition)
                    job["attempts"].append({key: job.get(key) for key in (
                        "attempt", "log", "controller_pid", "started_at", "finished_at", "wall_clock_seconds",
                        "controller_exit_code", "status", "run_id", "fleet_dir", "fleet_owner_token", "task_status",
                        "resources_released", "lifecycle_verified", "infra_failure", "terminal_task", "released_at_epoch",
                        "retry_blocked")})
                    if (disposition.get("lifecycle_verified") and disposition.get("terminal_task")
                            and job["status"] != "cancelled"):
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
