#!/usr/bin/env python3
"""Reuse the existing complete host seed GET within one owned strict cohort."""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True


def digest(value):
    return hashlib.sha256(value).hexdigest()


_identity_spec = importlib.util.spec_from_file_location(
    "campaign_seed_identity", Path(__file__).with_name("cloudbench-port-lease.py")
)
_identity = importlib.util.module_from_spec(_identity_spec)
_identity_spec.loader.exec_module(_identity)


def birth(pid):
    return _identity._process_start_identity(pid)


def owner(inventory, barrier):
    if (
        inventory.is_symlink()
        or barrier.is_symlink()
        or inventory.parent.resolve() != barrier.parent.parent.resolve()
        or (barrier / "abort.json").exists()
    ):
        raise ValueError("foreign or aborted campaign scope")
    source = inventory / "owner"
    if source.is_symlink() or not source.is_file():
        raise ValueError("missing campaign inventory owner")
    fields = {}
    for line in source.read_text().splitlines():
        key, value = line.split("=", 1)
        if key in fields:
            raise ValueError("duplicate owner field")
        fields[key] = value
    if set(fields) != {
        "app",
        "pid",
        "pid_start",
        "token",
        "parent_pid",
        "parent_start",
    }:
        raise ValueError("invalid campaign owner fields")
    if fields["app"] != "navi-whisper-lux-bench" or not fields["token"]:
        raise ValueError("foreign campaign owner")
    for pid, stamp in (("pid", "pid_start"), ("parent_pid", "parent_start")):
        if not _identity._process_start_matches(int(fields[pid]), " ".join(fields[stamp].split())):
            raise ValueError("campaign process birth changed")
    with (barrier.parent / "parent.lock").open() as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise ValueError("campaign barrier parent has exited")
    return fields


def manifest(barrier):
    path = barrier / "manifest.json"
    if path.is_symlink():
        raise ValueError("symlinked cohort manifest")
    value = json.loads(path.read_text())
    required = {"cohort_id", "jobs"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {"e2e_deadline_monotonic"} or not value["jobs"]:
        raise ValueError("invalid cohort manifest")
    if "e2e_deadline_monotonic" in value:
        deadline = value["e2e_deadline_monotonic"]
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline) or deadline <= 0:
            raise ValueError("invalid cohort deadline")
    return value


def fixture(root, helpers):
    try:
        from dotenv import dotenv_values
    except ModuleNotFoundError as error:
        if error.name != "dotenv":
            raise

        # System Python may have no optional dotenv package. Match the existing
        # cloudbench_env_value parser for these four non-secret selectors only.
        def dotenv_values(path):
            values = {}
            if path.is_file():
                for raw in path.read_text().splitlines():
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key, value = key.strip(), value.strip()
                    if key.startswith("export") and key[6:7].isspace():
                        key = key[6:].strip()
                    if key not in (
                        "R2_ACCOUNT_ID",
                        "R2_ENDPOINT",
                        "R2_BUCKET_TRACE_ARCHIVE",
                        "R2_ACCESS_KEY_ID",
                    ):
                        continue
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    values.setdefault(key, value)
            return values

    schema = root / "back-end/prisma/schema.prisma"
    module_path = root / "agents/benchmarks/seed_cache_path.py"
    spec = importlib.util.spec_from_file_location("seed_identity", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    pg = os.environ.get("CLOUDBENCH_GUEST_PG_MAJOR") or "15"
    token = module.seed_cache_token(schema, pg_major=pg)
    effective = dict(dotenv_values(root / "back-end/.env"))
    effective.update(os.environ)
    # Only scope identifiers/selectors are hashed. Secret material is excluded.
    selectors = {
        key: effective.get(key, "")
        for key in (
            "R2_ACCOUNT_ID",
            "R2_ENDPOINT",
            "R2_BUCKET_TRACE_ARCHIVE",
            "R2_ACCESS_KEY_ID",
        )
    }
    code = {
        path.name: digest(path.read_bytes())
        for path in (
            module_path,
            root / "back-end/scripts/seed-dump-cache.ts",
            helpers / "cloudbench-seed-get.sh",
            helpers / "cloudbench-campaign-seed.py",
            helpers / "cloudbench-port-lease.py",
        )
    }
    sha = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    return {
        "workspace": str(root.resolve()),
        "source_sha": sha,
        "schema_sha256": digest(schema.read_bytes()),
        "pg_major": pg,
        "token": token,
        "selector_sha256": digest(json.dumps(selectors, sort_keys=True).encode()),
        "code_sha256": code,
    }


def stop_get(process):
    if process.returncode is not None:
        return
    # Keep the leader waitable until its session is drained, including when it
    # has exited. Its unreaped PID cannot be reused to authorize a foreign group.
    # Birth checks also fence escalation of each retained descendant.
    output = subprocess.check_output(["ps", "-ax", "-o", "pid=,pgid=,stat="], text=True)
    members = {}
    for line in output.splitlines():
        pid_text, pgid_text, state = line.split()
        pid, pgid = int(pid_text), int(pgid_text)
        if pgid == process.pid and not state.startswith("Z"):
            stamp = birth(pid)
            if stamp:
                members[pid] = stamp
    if members:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    grace = time.monotonic() + 120
    escalated = False
    while members:
        for pid, stamp in list(members.items()):
            state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
            if not state or state.startswith("Z") or not _identity._process_start_matches(pid, stamp):
                del members[pid]
        if not members:
            break
        if time.monotonic() >= grace and not escalated:
            for pid, stamp in members.items():
                if _identity._process_start_matches(pid, stamp):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            escalated = True
        time.sleep(0.2)
    process.wait()


def get(root, helpers, identity, directory, deadline=None):
    started = time.time()
    # Reuse the generous existing startup budget; add no per-attempt GET timer.
    if deadline is None:
        deadline = started + max(
            int(os.environ.get("CLOUDBENCH_START_BARRIER_WAIT_SECONDS") or "7200"),
            int(
                os.environ.get("CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS")
                or (
                    int(os.environ.get("CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS") or "2160")
                    + int(os.environ.get("CLOUDBENCH_PRE_STACK_WAIT_SECONDS") or "600")
                )
            ),
        )
    handle, name = tempfile.mkstemp(prefix="seed-probe-", dir=directory)
    os.close(handle)
    path = Path(name)
    log = directory / "seed-get.private.log"
    process = None
    cancelled = False
    handlers = {}

    def request_stop(_signum, _frame):
        nonlocal cancelled
        cancelled = True

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            handlers[signum] = signal.signal(signum, request_stop)
        if time.time() >= deadline:
            raise ValueError("canonical fixture exhausted existing startup budget")
        with log.open("ab") as stream:
            log.chmod(0o600)
            process = subprocess.Popen(
                [
                    "bash",
                    str(helpers / "cloudbench-seed-get.sh"),
                    str(root),
                    identity["token"],
                    str(path),
                ],
                stdout=stream,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            while True:
                if cancelled or time.time() >= deadline:
                    raise ValueError("canonical fixture cancelled or exhausted existing startup budget")
                observation = subprocess.run(
                    ["ps", "-p", str(process.pid), "-o", "stat="], capture_output=True, text=True
                )
                if observation.returncode not in (0, 1):
                    print(
                        "canonical fixture process observation unavailable; retrying within existing startup budget",
                        file=sys.stderr,
                    )
                    time.sleep(0.2)
                    continue
                state = observation.stdout.strip()
                if not state or state.startswith("Z"):
                    break
                time.sleep(0.2)
            stop_get(process)
        size = path.stat().st_size
        if cancelled or process.returncode or size <= 0:
            raise ValueError("canonical fixture full GET failed")
        payload_digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                payload_digest.update(chunk)
        if cancelled or time.time() >= deadline:
            raise ValueError("canonical fixture cancelled or exhausted existing startup budget")
        return {
            "exit_code": 0,
            "bytes": size,
            "sha256": payload_digest.hexdigest(),
            "started_epoch": started,
            "finished_epoch": time.time(),
        }
    finally:
        try:
            if process is not None:
                # This fresh session contains only this owned host GET, including
                # npx/tsx descendants. Cancellation never targets a fleet or browser.
                stop_get(process)
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)
            path.unlink(missing_ok=True)
        if cancelled or time.time() >= deadline:
            raise ValueError("canonical fixture cancelled or exhausted existing startup budget")


def prepare(root, helpers, inventory, barrier, deadline=None):
    authority = owner(inventory, barrier)
    if int(authority["parent_pid"]) not in (os.getpid(), os.getppid()):
        raise ValueError("fixture publisher does not belong to campaign parent")
    cohort = manifest(barrier)
    identity = fixture(root, helpers)
    transfer = get(root, helpers, identity, barrier, deadline)
    if owner(inventory, barrier) != authority:
        raise ValueError("campaign owner changed during full GET")
    current = manifest(barrier)
    if current["cohort_id"] != cohort["cohort_id"] or sorted(current["jobs"]) != sorted(cohort["jobs"]) or current.get("e2e_deadline_monotonic") != cohort.get("e2e_deadline_monotonic"):
        raise ValueError("campaign membership changed during full GET")
    value = {
        "version": 1,
        "owner": authority,
        "cohort_id": cohort["cohort_id"],
        "members": sorted(cohort["jobs"]),
        "fixture": identity,
        "get": transfer,
    }
    path = barrier / "seed-proof.private.json"
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    with temporary.open("x") as stream:
        temporary.chmod(0o600)
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    return path


def consume(root, helpers, inventory, barrier, proof, job_id, controller_pid, deadline):
    if proof != barrier / "seed-proof.private.json" or proof.is_symlink():
        raise ValueError("foreign campaign seed proof path")
    authority = owner(inventory, barrier)
    value = json.loads(proof.read_text())
    if set(value) != {"version", "owner", "cohort_id", "members", "fixture", "get"}:
        raise ValueError("invalid campaign seed proof")
    while time.time() < deadline:
        cohort = manifest(barrier)
        assigned = cohort["jobs"].get(job_id)
        if assigned is None and job_id in cohort["jobs"]:
            owner(inventory, barrier)
            time.sleep(0.1)
            continue
        break
    else:
        raise ValueError("campaign membership exhausted existing startup budget")
    if (
        controller_pid not in (os.getpid(), os.getppid())
        or assigned != controller_pid
        or value["version"] != 1
        or value["owner"] != authority
        or value["cohort_id"] != cohort["cohort_id"]
        or value["members"] != sorted(cohort["jobs"])
        or value["fixture"] != fixture(root, helpers)
        or set(value["get"]) != {"exit_code", "bytes", "sha256", "started_epoch", "finished_epoch"}
        or value["get"]["exit_code"] != 0
        or value["get"]["bytes"] <= 0
        or len(value["get"]["sha256"]) != 64
        or any(c not in "0123456789abcdef" for c in value["get"]["sha256"])
        or not 0 < value["get"]["started_epoch"] <= value["get"]["finished_epoch"]
    ):
        raise ValueError("campaign seed proof does not own this fixture/controller")
    return value["get"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("prepare", "consume", "standalone"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--barrier", type=Path)
    parser.add_argument("--proof", type=Path)
    parser.add_argument("--job")
    parser.add_argument("--controller-pid", type=int)
    parser.add_argument("--deadline", type=float)
    parser.add_argument("--out-dir", type=Path)
    args = parser.parse_args()
    helpers = Path(__file__).resolve().parent
    if args.mode == "prepare":
        prepare(args.root, helpers, args.inventory, args.barrier, args.deadline)
    elif args.mode == "consume":
        consume(
            args.root,
            helpers,
            args.inventory,
            args.barrier,
            args.proof,
            args.job,
            args.controller_pid,
            args.deadline,
        )
    else:
        get(args.root, helpers, fixture(args.root, helpers), args.out_dir, args.deadline)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
