#!/usr/bin/env python3
"""Reuse the existing complete host seed GET within one owned strict cohort."""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
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
    if set(fields) != {"app", "pid", "pid_start", "token", "parent_pid", "parent_start"}:
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
    if set(value) != {"cohort_id", "jobs"} or not value["jobs"]:
        raise ValueError("invalid cohort manifest")
    return value


def fixture(root, helpers):
    from dotenv import dotenv_values

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
        for key in ("R2_ACCOUNT_ID", "R2_ENDPOINT", "R2_BUCKET_TRACE_ARCHIVE", "R2_ACCESS_KEY_ID")
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


def get(root, helpers, identity, directory):
    started = time.time()
    handle, name = tempfile.mkstemp(prefix="seed-probe-", dir=directory)
    os.close(handle)
    path = Path(name)
    log = directory / "seed-get.private.log"
    try:
        with log.open("ab") as stream:
            log.chmod(0o600)
            result = subprocess.run(
                ["bash", str(helpers / "cloudbench-seed-get.sh"), str(root), identity["token"], str(path)],
                stdout=stream,
                stderr=subprocess.STDOUT,
            )
        size = path.stat().st_size
        if result.returncode or size <= 0:
            raise ValueError("canonical fixture full GET failed")
        payload_digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                payload_digest.update(chunk)
        return {
            "exit_code": 0,
            "bytes": size,
            "sha256": payload_digest.hexdigest(),
            "started_epoch": started,
            "finished_epoch": time.time(),
        }
    finally:
        path.unlink(missing_ok=True)


def prepare(root, helpers, inventory, barrier):
    authority = owner(inventory, barrier)
    if int(authority["parent_pid"]) not in (os.getpid(), os.getppid()):
        raise ValueError("fixture publisher does not belong to campaign parent")
    cohort = manifest(barrier)
    identity = fixture(root, helpers)
    transfer = get(root, helpers, identity, barrier)
    if owner(inventory, barrier) != authority:
        raise ValueError("campaign owner changed during full GET")
    current = manifest(barrier)
    if current["cohort_id"] != cohort["cohort_id"] or sorted(current["jobs"]) != sorted(cohort["jobs"]):
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
        prepare(args.root, helpers, args.inventory, args.barrier)
    elif args.mode == "consume":
        consume(
            args.root, helpers, args.inventory, args.barrier, args.proof, args.job, args.controller_pid, args.deadline
        )
    else:
        get(args.root, helpers, fixture(args.root, helpers), args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
