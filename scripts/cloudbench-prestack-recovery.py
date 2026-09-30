#!/usr/bin/env python3
"""Attest a cloud guest rejected by a platform preflight before stack startup.

The exact stopped original volume must be captured first. This receipt can
retire runtime ownership with zero benchmark credit; it is never a run result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile


MISSING_STACK = {
    "cloudbench-driver.pid",
    "repo/.context/cloudbench/services.json",
    "repo/.context/cloudbench/stack.log",
    "repo/.context/cloudbench/logs/backend.log",
    "repo/.context/cloudbench/logs/worker.log",
    "repo/.context/cloudbench/run.json",
}


def regular(path: Path, maximum: int = 64 * 1024 * 1024) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise ValueError(f"missing or unsafe regular file: {path}")
    return path.read_bytes()


def fields(path: Path) -> dict[str, str]:
    pairs = [line.split("=", 1) for line in regular(path, 65536).decode().splitlines()]
    if any(len(pair) != 2 for pair in pairs):
        raise ValueError("malformed owner metadata")
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate owner metadata")
    return result


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify(registry: Path, bench: str, capture_dir: Path,
           machines_file: Path, volumes_file: Path) -> tuple[Path, dict[str, object]]:
    owner = registry.name
    if not re.fullmatch(r"[0-9a-f]{32}", owner) or bench != "message-person":
        raise ValueError("unsupported prestack owner or task")
    meta = fields(registry / "meta")
    if (meta.get("version") != "2" or meta.get("fleet_owner_token") != owner
            or meta.get("cleanup_policy") != "reap"
            or (registry / "guest-cleanup-unconfirmed").exists()
            or not (registry / "runtime-evidence-unconfirmed").is_file()):
        raise ValueError("exact owner cleanup and runtime latches are not ready")
    run_id = meta["run_id"]
    run = Path(meta["runs_root"]) / run_id
    if not run.is_absolute() or run.resolve() != run:
        raise ValueError("unsafe original run path")
    lifecycle = json.loads(regular(run / "_batch/lifecycle.json", 1048576))
    tasks = json.loads(regular(run / "_batch/benches.json", 1048576))
    if (lifecycle.get("status") != "failed"
            or lifecycle.get("fleet_owner_token") != owner
            or len([task for task in tasks if task.get("name") == bench]) != 1):
        raise ValueError("failed fleet and task identity are not exact")
    ordinal = next(index for index, task in enumerate(tasks) if task["name"] == bench)
    token = f"{owner}-{ordinal}"
    out = run / bench
    kind, machine = regular(out / ".cid", 256).decode().split()
    if kind != "pool" or not re.fullmatch(r"[0-9a-f]{14}", machine):
        raise ValueError("task is not bound to one pool Machine")
    audit = Path(meta["audit_dir"])
    pool = fields(audit / "pool" / machine)
    volume = pool.get("volume_id", "")
    if (pool.get("fleet_owner_token") != owner or pool.get("run_id") != run_id
            or pool.get("app") != meta["app"] or pool.get("source") != "borrowed-pool"
            or pool.get("disposition") != "claimed"
            or not re.fullmatch(r"vol_[A-Za-z0-9]+", volume)):
        raise ValueError("original pool claim is not exact")
    record = {"version": 1, "machine_id": machine, "run_token": token}
    if (json.loads(regular(out / "runtime-evidence.owner.json", 4096)) != record
            or json.loads(regular(out / "runtime-evidence.pending", 4096)) != record):
        raise ValueError("runtime evidence is not bound to the original guest")
    if (regular(out / "guest-shutdown.confirmed", 256) != (run_id + "\n").encode()
            or regular(out / "post-config-start.accepted", 256) != (machine + "\n").encode()
            or regular(out / "worker-clones.ids", 4096)
            or regular(out / "benchmark-child.finished", 256).strip() == b"0"
            or (out / "cloudbench-run.json").exists()
            or (out / "remote-logs/runtime-evidence/manifest.json").exists()):
        raise ValueError("guest was not a failed, cleaned prestack start")
    child = regular(out / "fleet-child.log", 1048576).decode()
    if ("Live message-person benchmark requires a macOS controller for Apple Messages"
            not in child or "Original exit code: 70" not in child):
        raise ValueError("controller did not reject the unsupported platform")
    machines = json.loads(regular(machines_file, 128 * 1024 * 1024))
    volumes = json.loads(regular(volumes_file, 128 * 1024 * 1024))
    native = next((value for value in machines if value.get("id") == machine), None)
    native_volume = next((value for value in volumes if value.get("id") == volume), None)
    if (native is None or native.get("state") != "stopped"
            or (native.get("config") or {}).get("mounts", [{}])[0].get("volume") != volume
            or (native.get("config") or {}).get("init", {}).get("cmd")
            != ["bash", "/cloudbench-boot.sh"]
            or native_volume is None
            or native_volume.get("attached_machine_id") != machine):
        raise ValueError("original Machine and volume are not stopped and attached")
    capture_path = capture_dir / f"{machine}.tar.gz"
    capture = regular(capture_path, 512 * 1024 * 1024)
    provenance = json.loads(regular(capture_dir / f"{machine}.provenance.json", 65536))
    if (provenance.get("direct_original_volume") is not True
            or provenance.get("source_machine_id") != machine
            or provenance.get("source_volume_id") != volume
            or provenance.get("archive_sha256") != sha(capture)
            or provenance.get("archive_bytes") != len(capture)
            or provenance.get("proof_credit") != 0):
        raise ValueError("original-volume capture provenance is not exact")
    original: dict[str, bytes] = {}
    with tarfile.open(capture_path, "r:gz") as archive:
        for member in archive:
            if (not member.isfile() or member.name in original
                    or ".." in Path(member.name).parts):
                raise ValueError("unsafe original-volume member")
            stream = archive.extractfile(member)
            assert stream is not None
            original[member.name] = stream.read(member.size + 1)
            if len(original[member.name]) != member.size:
                raise ValueError("truncated original-volume member")
    clean_ack = f"cloudbench-driver-clean-{token}.ack"
    if (set(provenance.get("files", [])) != set(original)
            or not {"bench.log", "cloudbench-driver.state", clean_ack} <= set(original)
            or MISSING_STACK & set(original)
            or original["cloudbench-driver.state"].strip() != b"exited"
            or original[clean_ack] != (token + "\n").encode()):
        raise ValueError("original guest did not stop before stack startup")
    bench_log = original["bench.log"].decode()
    if (owner not in bench_log or "git-syncing + verifying" not in bench_log
            or "guest shutdown requested" not in bench_log
            or "driver exited rc=143" not in bench_log
            or "stack healthy" in bench_log or "running benchmark" in bench_log):
        raise ValueError("original driver crossed the prestack boundary")
    return out, {
        "version": 1, "kind": "unsupported-platform-prestack-zero",
        "fleet_owner_token": owner, "run_id": run_id, "bench": bench,
        "machine_id": machine, "volume_id": volume, "run_token": token,
        "provider_state": "stopped", "proof_credit": 0,
        "capture_sha256": sha(capture), "capture_provenance": provenance,
        "original_file_sha256": {name: sha(data) for name, data in sorted(original.items())},
    }


def publish(out: Path, receipt: dict[str, object]) -> None:
    path = out / "guest-prestack.confirmed"
    payload = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if path.exists() or path.is_symlink():
        if regular(path, 65536) != payload:
            raise ValueError("existing prestack receipt changed")
        return
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--bench", required=True)
    parser.add_argument("--capture-dir", required=True, type=Path)
    parser.add_argument("--machines-json", required=True, type=Path)
    parser.add_argument("--volumes-json", required=True, type=Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    out, receipt = verify(args.registry, args.bench, args.capture_dir,
                          args.machines_json, args.volumes_json)
    if args.publish:
        publish(out, receipt)
    print(json.dumps({"verified": True, "published": args.publish,
                      "machine_id": receipt["machine_id"], "proof_credit": 0}))


if __name__ == "__main__":
    main()
