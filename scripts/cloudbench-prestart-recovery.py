#!/usr/bin/env python3
"""Prove that an exact, canceled pool fleet never passed its boot barrier.

This is deliberately narrower than guest cleanup recovery: it accepts only an
entire pool-only run whose Machines are stopped and whose controller never
released any guest start. It never turns a failed benchmark into a result.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
from pathlib import Path


MACHINE = re.compile(r"[0-9a-f]{14}\Z")
OWNER = re.compile(r"[0-9a-f]{32}\Z")
SAFE = re.compile(r"[A-Za-z0-9._-]+\Z")
VOLUME = re.compile(r"vol_[A-Za-z0-9]+\Z")


def regular(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size <= 65_536


def directory(path: Path) -> bool:
    try:
        return stat.S_ISDIR(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def fields(path: Path) -> dict[str, str]:
    if not regular(path):
        raise ValueError(f"missing or unsafe metadata: {path}")
    result: dict[str, str] = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if not separator or not key or key in result:
            raise ValueError(f"malformed metadata: {path}")
        result[key] = value
    return result


def absent(path: Path) -> bool:
    return not path.exists() and not path.is_symlink()


def receipt_payload(owner: str, run_id: str, bench: str, machine: str, volume: str) -> bytes:
    return (
        json.dumps(
            {
                "version": 1,
                "kind": "no-guest-start",
                "fleet_owner_token": owner,
                "run_id": run_id,
                "bench": bench,
                "machine_id": machine,
                "volume_id": volume,
                "provider_state": "stopped",
                "barrier": "unreleased",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode()


def validate(
    registry: Path, audit_root: Path, claims_root: Path, machines_file: Path, app: str
) -> list[tuple[Path, bytes]]:
    if not directory(registry) or not OWNER.fullmatch(registry.name):
        raise ValueError("unsafe exact owner registry")
    meta = fields(registry / "meta")
    owner = registry.name
    run_id = meta.get("run_id", "")
    if (
        meta.get("version") != "2"
        or meta.get("fleet_owner_token") != owner
        or meta.get("app") != app
        or not SAFE.fullmatch(run_id)
        or meta.get("cleanup_policy") != "retain"
        or not regular(registry / "guest-cleanup-unconfirmed")
    ):
        raise ValueError("owner identity or cleanup latch is unsafe")
    runs_root = Path(meta.get("runs_root", ""))
    run = runs_root / run_id
    audit = audit_root / owner
    if (
        not runs_root.is_absolute()
        or not directory(run)
        or run.resolve() != run
        or meta.get("audit_dir") != str(audit)
        or not directory(audit)
        or fields(audit / "meta").get("fleet_owner_token") != owner
    ):
        raise ValueError("run and audit are not bound to exact owner")
    if not directory(registry / "clones") or any((registry / "clones").iterdir()):
        raise ValueError("prestart proof requires pool-only ownership")
    for name in ("fresh", "expected-fresh", "by-machine-id"):
        target = audit / name
        if not directory(target) or any(target.iterdir()):
            raise ValueError("prestart proof has fresh clone ownership")
    for name in ("owned-clones.ids", "owned-clones.names"):
        target = audit / name
        if not regular(target) or target.read_bytes():
            raise ValueError("prestart proof has fresh clone ledger")
    barrier = run / ".boot-config-barrier"
    ready = barrier / "ready"
    if not directory(barrier) or not directory(ready) or not absent(barrier / "release"):
        raise ValueError("guest boot barrier was released or is unsafe")
    batch = run / "_batch" / "benches.json"
    if not regular(batch):
        raise ValueError("missing exact task list")
    tasks = json.loads(batch.read_text())
    if not isinstance(tasks, list) or not tasks or len(tasks) > 32:
        raise ValueError("invalid exact task list")
    if not regular(machines_file):
        # The provider inventory is larger than the small owner metadata.
        info = machines_file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16_777_216:
            raise ValueError("unsafe provider inventory")
    machines = json.loads(machines_file.read_text())
    if not isinstance(machines, list):
        raise ValueError("invalid provider inventory")
    provider = {item.get("id"): item for item in machines if isinstance(item, dict)}
    pool_dir = audit / "pool"
    if not directory(pool_dir):
        raise ValueError("missing exact pool audit")
    pool = {path.name: fields(path) for path in pool_dir.iterdir()}
    receipts: list[tuple[Path, bytes]] = []
    seen_names: set[str] = set()
    seen_machines: set[str] = set()
    for index, task in enumerate(tasks):
        if not isinstance(task, dict) or not isinstance(task.get("name"), str):
            raise ValueError("invalid task entry")
        bench = task["name"]
        if not SAFE.fullmatch(bench) or bench in seen_names:
            raise ValueError("duplicate or unsafe task name")
        seen_names.add(bench)
        output = run / bench
        cid = output / ".cid"
        if not directory(output) or not regular(cid):
            raise ValueError("missing exact guest mapping")
        parts = cid.read_text().split()
        if len(parts) != 2 or parts[0] != "pool" or not MACHINE.fullmatch(parts[1]):
            raise ValueError("invalid pool guest mapping")
        machine = parts[1]
        if machine in seen_machines:
            raise ValueError("duplicate pool Machine")
        seen_machines.add(machine)
        row = pool.get(machine)
        if row is None or not VOLUME.fullmatch(row.get("volume_id", "")):
            raise ValueError("missing exact pool volume")
        volume = row["volume_id"]
        if (
            row.get("fleet_owner_token") != owner
            or row.get("run_id") != run_id
            or row.get("app") != app
            or row.get("source") != "borrowed-pool"
            or row.get("machine_id") != machine
            or row.get("disposition") != "claimed"
        ):
            raise ValueError("pool audit does not match owner")
        claim = fields(claims_root / machine)
        if (
            claim.get("fleet_owner_token") != owner
            or claim.get("host") != meta.get("host")
            or claim.get("pid") != meta.get("pid")
            or claim.get("pid_start") != meta.get("pid_start")
            or claim.get("cleanup_state") not in ("unconfirmed", "owned")
        ):
            raise ValueError("pool claim does not match owner")
        machine_record = provider.get(machine)
        mounts = (machine_record or {}).get("config", {}).get("mounts", [])
        if (
            not isinstance(machine_record, dict)
            or machine_record.get("state") != "stopped"
            or not isinstance(mounts, list)
            or len(mounts) != 1
            or mounts[0].get("volume") != volume
        ):
            raise ValueError("provider Machine is not stopped on exact volume")
        if any(
            not absent(output / name)
            for name in (
                "post-config-start.accepted",
                "status-proxy.port",
                "cloudbench-boot-start.log",
                "cloudbench-run.json",
                "worker-runtime-evidence",
                "guest-shutdown.confirmed",
            )
        ):
            raise ValueError("guest may have started or emitted runtime evidence")
        worker_ids = output / "worker-clones.ids"
        owner_file = output / "runtime-evidence.owner.json"
        pending_file = output / "runtime-evidence.pending"
        expected_owner = {
            "version": 1,
            "machine_id": machine,
            "run_token": f"{owner}-{index}",
        }
        if (
            not regular(worker_ids)
            or worker_ids.read_bytes()
            or not regular(owner_file)
            or not regular(pending_file)
            or owner_file.read_bytes() != pending_file.read_bytes()
            or json.loads(owner_file.read_text()) != expected_owner
        ):
            raise ValueError("preallocated runtime ownership is not exact or has workers")
        unapplied = output / "boot-config-unapplied"
        ready_marker = ready / machine
        if not (
            (regular(unapplied) and unapplied.read_text().strip() == machine and absent(ready_marker))
            or (absent(unapplied) and regular(ready_marker) and not ready_marker.read_bytes())
        ):
            raise ValueError("guest boot state is not exactly accounted")
        receipts.append(
            (
                output / "guest-never-started.confirmed",
                receipt_payload(owner, run_id, bench, machine, volume),
            )
        )
    if seen_machines != set(pool) or {path.name for path in ready.iterdir()} - seen_machines:
        raise ValueError("pool or barrier has an unmapped Machine")
    return receipts


def publish(receipts: list[tuple[Path, bytes]]) -> None:
    for path, payload in receipts:
        if not absent(path):
            if not regular(path) or path.read_bytes() != payload:
                raise ValueError("existing prestart receipt differs")
            continue
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        try:
            os.replace(temporary, path)
            parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--audit-root", type=Path, required=True)
    parser.add_argument("--claims-root", type=Path, required=True)
    parser.add_argument("--machines-json", type=Path, required=True)
    parser.add_argument("--app", required=True)
    args = parser.parse_args()
    receipts = validate(
        args.registry, args.audit_root, args.claims_root, args.machines_json, args.app
    )
    publish(receipts)
    print(f"verified no guest start for {len(receipts)} exact pool Machines")


if __name__ == "__main__":
    main()
