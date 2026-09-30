#!/usr/bin/env python3
"""Attest a pooled guest whose provider rejected every post-config start.

This is a zero-credit cleanup receipt, never a benchmark result. The original
stopped volume must be captured through an inert read-only boot first. A failed
CLI start alone is not sufficient to release ownership.
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


OWNER = re.compile(r"[0-9a-f]{32}\Z")
MACHINE = re.compile(r"[0-9a-f]{14}\Z")
SAFE = re.compile(r"[A-Za-z0-9._-]+\Z")
START_ERROR = re.compile(
    r"Error: could not start machine due to lack of capacity\. "
    r"Try 'flyctl machine clone ([0-9a-f]{14}) -a ([A-Za-z0-9._-]+)'"
)
ORIGINAL_FILES = {
    "bench.log",
    "cloudbench-driver.state",
    "repo/.context/cloudbench/services.json",
    "repo/.context/cloudbench/logs/backend.log",
    "repo/.context/cloudbench/run.json",
}


def regular(path: Path, maximum: int = 64 * 1024 * 1024) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise ValueError(f"missing or unsafe regular file: {path}")
    return path.read_bytes()


def fields(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in regular(path, 65536).decode().splitlines():
        key, sep, value = line.partition("=")
        if not sep or not key or key in result:
            raise ValueError("malformed exact owner metadata")
        result[key] = value
    return result


def absent(path: Path) -> bool:
    return not path.exists() and not path.is_symlink()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify(
    registry: Path,
    bench: str,
    capture_dir: Path,
    machines_file: Path,
    volumes_file: Path,
) -> tuple[Path, dict[str, object]]:
    owner = registry.name
    if not OWNER.fullmatch(owner) or not SAFE.fullmatch(bench):
        raise ValueError("unsafe owner or bench")
    meta = fields(registry / "meta")
    if (
        meta.get("version") != "2"
        or meta.get("fleet_owner_token") != owner
        or meta.get("cleanup_policy") != "retain"
        or not (registry / "guest-cleanup-unconfirmed").is_file()
        or not (registry / "runtime-evidence-unconfirmed").is_file()
    ):
        raise ValueError("exact owner is not retained with both cleanup latches")
    run_id = meta["run_id"]
    run = Path(meta["runs_root"]) / run_id
    if not run.is_absolute() or run.resolve() != run:
        raise ValueError("unsafe run path")
    lifecycle = json.loads(regular(run / "_batch/lifecycle.json", 1048576))
    tasks = json.loads(regular(run / "_batch/benches.json", 1048576))
    if (
        lifecycle.get("status") != "failed"
        or lifecycle.get("fleet_owner_token") != owner
        or not isinstance(tasks, list)
        or len([task for task in tasks if task.get("name") == bench]) != 1
    ):
        raise ValueError("failed fleet and task identity are not exact")
    ordinal = next(index for index, task in enumerate(tasks) if task["name"] == bench)
    out = run / bench
    cid = regular(out / ".cid", 256).decode().split()
    if len(cid) != 2 or cid[0] != "pool" or not MACHINE.fullmatch(cid[1]):
        raise ValueError("bench is not bound to one claimed pool Machine")
    machine = cid[1]
    token = f"{owner}-{ordinal}"
    audit = Path(meta["audit_dir"])
    row = fields(audit / "pool" / machine)
    volume = row.get("volume_id", "")
    if (
        row.get("fleet_owner_token") != owner
        or row.get("run_id") != run_id
        or row.get("app") != meta.get("app")
        or row.get("source") != "borrowed-pool"
        or row.get("disposition") != "claimed"
        or not re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
    ):
        raise ValueError("pool audit is not exact")
    owner_record = {"version": 1, "machine_id": machine, "run_token": token}
    if json.loads(regular(out / "runtime-evidence.owner.json", 4096)) != owner_record:
        raise ValueError("runtime owner is not exact")
    if json.loads(regular(out / "runtime-evidence.pending", 4096)) != owner_record:
        raise ValueError("runtime latch is not exact")
    if regular(out / "worker-clones.ids", 4096):
        raise ValueError("start-rejected guest allocated worker clones")
    for name in (
        "post-config-start.accepted",
        "status-proxy.port",
        "cloudbench-run.json",
        "guest-shutdown.confirmed",
        "worker-runtime-evidence",
    ):
        if not absent(out / name):
            raise ValueError(f"start-rejected guest has runtime evidence: {name}")
    start_log = regular(out / "cloudbench-boot-start.log", 65536)
    lines = start_log.decode().splitlines()
    if len(lines) != 4 or any(
        (match := START_ERROR.fullmatch(line)) is None
        or match.group(1) != machine
        or match.group(2) != meta["app"]
        for line in lines
    ):
        raise ValueError("provider did not reject every bounded start")
    child_log = regular(out / "fleet-child.log", 1048576).decode()
    if (
        "provider did not accept the required post-config start" not in child_log
        or "Original exit code: 125" not in child_log
        or "post-config start accepted" in child_log
    ):
        raise ValueError("child did not terminate at the rejected-start boundary")
    machines = json.loads(regular(machines_file, 128 * 1024 * 1024))
    volumes = json.loads(regular(volumes_file, 128 * 1024 * 1024))
    native = next((item for item in machines if item.get("id") == machine), None)
    native_volume = next((item for item in volumes if item.get("id") == volume), None)
    if (
        native is None
        or native.get("state") != "stopped"
        or (native.get("config") or {}).get("mounts", [{}])[0].get("volume") != volume
        or (native.get("config") or {}).get("init", {}).get("cmd")
        != ["bash", "/cloudbench-boot.sh"]
        or native_volume is None
        or native_volume.get("attached_machine_id") != machine
    ):
        raise ValueError("exact original Machine and volume are not stopped and attached")
    capture = capture_dir / f"{machine}.tar.gz"
    provenance = json.loads(regular(capture_dir / f"{machine}.provenance.json", 65536))
    capture_bytes = regular(capture, 512 * 1024 * 1024)
    if (
        provenance.get("direct_original_volume") is not True
        or provenance.get("source_machine_id") != machine
        or provenance.get("source_volume_id") != volume
        or provenance.get("archive_sha256") != sha(capture_bytes)
        or provenance.get("archive_bytes") != len(capture_bytes)
        or provenance.get("proof_credit") != 0
    ):
        raise ValueError("direct original-volume capture provenance is not exact")
    original: dict[str, bytes] = {}
    with tarfile.open(capture, "r:gz") as archive:
        for member in archive:
            if not member.isfile() or member.name in original or ".." in Path(member.name).parts:
                raise ValueError("unsafe original-volume capture")
            stream = archive.extractfile(member)
            assert stream is not None
            original[member.name] = stream.read(member.size + 1)
            if len(original[member.name]) != member.size:
                raise ValueError("truncated original-volume capture")
    if set(provenance.get("files", [])) != set(original) or not ORIGINAL_FILES <= set(original):
        raise ValueError("original-volume capture is incomplete")
    if original["cloudbench-driver.state"].strip() != b"exited":
        raise ValueError("original volume has a live driver")
    services = json.loads(original["repo/.context/cloudbench/services.json"])
    prior_run = json.loads(original["repo/.context/cloudbench/run.json"])
    if services.get("status") != "stopped" or prior_run.get("run_id") == run_id:
        raise ValueError("original volume is not a stopped prior run")
    for data in original.values():
        if owner.encode() in data or run_id.encode() in data:
            raise ValueError("current owner appeared on the original volume")
    receipt = {
        "version": 1,
        "kind": "provider-rejected-no-guest-start",
        "fleet_owner_token": owner,
        "run_id": run_id,
        "bench": bench,
        "machine_id": machine,
        "volume_id": volume,
        "run_token": token,
        "provider_state": "stopped",
        "proof_credit": 0,
        "start_log_sha256": sha(start_log),
        "capture_sha256": sha(capture_bytes),
        "capture_provenance": provenance,
        "original_file_sha256": {key: sha(value) for key, value in sorted(original.items())},
    }
    return out, receipt


def publish(out: Path, receipt: dict[str, object]) -> None:
    path = out / "guest-start-rejected.confirmed"
    payload = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if not absent(path):
        if regular(path, 65536) != payload:
            raise ValueError("existing rejected-start receipt changed")
    else:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    shutdown = out / "guest-shutdown.confirmed"
    marker = (str(receipt["run_id"]) + "\n").encode()
    if absent(shutdown):
        temporary = shutdown.with_name(f".{shutdown.name}.{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(marker)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, shutdown)
    elif regular(shutdown, 256) != marker:
        raise ValueError("existing guest shutdown marker changed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--bench", required=True)
    parser.add_argument("--capture-dir", type=Path, required=True)
    parser.add_argument("--machines-json", type=Path, required=True)
    parser.add_argument("--volumes-json", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    out, receipt = verify(
        args.registry, args.bench, args.capture_dir, args.machines_json, args.volumes_json
    )
    if args.publish:
        publish(out, receipt)
    print(json.dumps({"machine_id": receipt["machine_id"], "verified": True, "published": args.publish, "proof_credit": 0}))


if __name__ == "__main__":
    main()
