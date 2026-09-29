#!/usr/bin/env python3
"""Verify an exact failed fleet's original files before retiring its evidence latch.

This is an ownership recovery path, never a benchmark result or proof credit.
The caller supplies two fresh, successful native provider inventories.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import tarfile
from pathlib import Path, PurePosixPath


def regular_bytes(path: Path, limit: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_size <= limit
        data = stream.read(info.st_size + 1)
        assert len(data) == info.st_size
        return data


def fields(path: Path) -> dict[str, str]:
    lines = regular_bytes(path, 65536).decode().splitlines()
    pairs = [line.split("=", 1) for line in lines]
    assert all(len(pair) == 2 for pair in pairs)
    row = dict(pairs)
    assert len(row) == len(pairs)
    return row


def object_file(path: Path, limit: int = 1048576):
    return json.loads(regular_bytes(path, limit))


def safe_name(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not name.startswith("/") and path.as_posix() == name \
        and all(part not in ("", ".", "..") for part in path.parts)


def verify_prestart_evidence(
    registry: Path, run: Path, manifest_path: Path, archive_path: Path,
) -> dict[str, object]:
    """Release only the evidence latch for a fleet cancelled before bench start.

    Provider teardown remains owned by the exact-owner recovery caller. A pool
    machine is returned only after its separately verified guest shutdown.
    """
    owner = registry.name
    assert re.fullmatch(r"[0-9a-f]{32}", owner)
    meta = fields(registry / "meta")
    assert meta["version"] == "2" and meta["fleet_owner_token"] == owner
    assert meta["cleanup_policy"] == "reap"
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    assert (registry / "runtime-evidence-unconfirmed").is_file()
    audit = Path(meta["audit_dir"])
    assert audit.is_dir() and not audit.is_symlink() and audit.name == owner
    audit_meta = fields(audit / "meta")
    assert audit_meta["fleet_owner_token"] == owner
    assert audit_meta["run_id"] == meta["run_id"]
    assert audit_meta["app"] == meta["app"]
    assert run == Path(meta["runs_root"]) / meta["run_id"] and run.resolve() == run
    assert manifest_path == run / "_forensic/manifest.json"
    assert archive_path == run / "_forensic/originals.tar.gz"
    manifest = object_file(manifest_path)
    assert manifest["schema"] == "cloudbench-prestart-evidence-v1"
    assert manifest["owner"] == owner and manifest["run_id"] == meta["run_id"]
    assert manifest["proof_credit"] == 0
    lifecycle = object_file(run / "_batch/lifecycle.json")
    assert lifecycle["status"] == "failed" and lifecycle["controller_exit_code"] != 0
    assert lifecycle["fleet_owner_token"] == owner
    tasks = object_file(run / "_batch/benches.json")
    rows = manifest["tasks"]
    assert isinstance(tasks, list) and isinstance(rows, list)
    assert 1 <= len(tasks) == len(rows) <= 4096
    assert len({row["machine_id"] for row in rows}) == len(rows)
    assert len({row["volume_id"] for row in rows}) == len(rows)
    assert archive_path.stat().st_size == manifest["archive_bytes"] <= 512 * 1024 * 1024
    assert hashlib.sha256(regular_bytes(archive_path, 512 * 1024 * 1024)).hexdigest() == manifest["archive_sha256"]
    fresh = {value["machine_id"]: value for path in (audit / "fresh").iterdir()
             if (value := fields(path)).get("machine_id")}
    pool = {path.name: fields(path) for path in (audit / "pool").iterdir()}
    assert set(fresh).isdisjoint(pool)
    expected_files: dict[str, dict[str, object]] = {}
    for ordinal, (task, row) in enumerate(zip(tasks, rows, strict=True)):
        name = task["name"]
        assert row["task"] == name and row["ordinal"] == ordinal
        assert row["run_token"] == f"{owner}-{ordinal}"
        assert row["proof_credit"] == 0
        machine, volume, kind = row["machine_id"], row["volume_id"], row["kind"]
        assert re.fullmatch(r"[0-9a-f]+", machine)
        assert re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
        original = fresh[machine] if kind == "clone" else pool[machine]
        assert kind in {"clone", "pool"}
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"]
        assert original["app"] == meta["app"] and original["volume_id"] == volume
        assert original["disposition"] in ({"owned"} if kind == "clone" else {"claimed"})
        if kind == "clone":
            clone = fields(registry / "clones" / original["clone_name"])
            assert clone == {"name": original["clone_name"], "id": machine,
                             "volume_id": volume}
        else:
            assert original["source"] == "borrowed-pool"
        out = run / name
        assert regular_bytes(out / ".cid", 256).decode().split() == [kind, machine]
        assert regular_bytes(out / "guest-shutdown.confirmed", 256).decode().strip() == meta["run_id"]
        expected_owner = {"version": 1, "machine_id": machine,
                          "run_token": row["run_token"]}
        assert object_file(out / "runtime-evidence.owner.json") == expected_owner
        assert object_file(out / "runtime-evidence.pending") == expected_owner
        assert regular_bytes(out / "benchmark-child.finished", 256).decode().strip() != "0"
        assert not (out / "cloudbench-run.json").exists()
        assert not (out / "remote-logs/runtime-evidence/run.json").exists()
        files = row["files"]
        assert isinstance(files, dict)
        assert "repo/.context/cloudbench/run.json" not in files
        mandatory = {"bench.log", "repo/.context/cloudbench/services.json",
                     "repo/.context/cloudbench/stack.log",
                     "repo/.context/cloudbench/logs/backend.log"}
        assert mandatory <= set(files)
        for relative, info in files.items():
            assert safe_name(relative) and type(info["bytes"]) is int
            assert 0 <= info["bytes"] <= 64 * 1024 * 1024
            assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
            member = f"{name}/{relative}"
            assert member not in expected_files
            expected_files[member] = info
    seen = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            assert member.isfile() and member.name in expected_files
            assert member.name not in seen
            info = expected_files[member.name]
            assert member.size == info["bytes"]
            stream = archive.extractfile(member)
            assert stream is not None
            data = stream.read(member.size + 1)
            assert len(data) == member.size
            assert hashlib.sha256(data).hexdigest() == info["sha256"]
            if member.name.endswith("/repo/.context/cloudbench/services.json"):
                assert object_file_from_bytes(data)["status"] == "stopped"
            seen.add(member.name)
    assert seen == set(expected_files)
    return {"schema": "cloudbench-prestart-evidence-verified-v1", "owner": owner,
            "run_id": meta["run_id"], "tasks": len(rows), "files": len(seen),
            "archive_sha256": manifest["archive_sha256"], "proof_credit": 0}


def verify_started_pool_evidence(
    registry: Path, run: Path, manifest_path: Path, archive_path: Path,
    machines_path: Path, volumes_path: Path,
) -> dict[str, object]:
    """Release a failed pool run's evidence latch after exact guest cleanup.

    The receipt never makes the benchmark valid. It preserves original logs and
    results so the already-confirmed cleanup can return prewarmed pool volumes.
    """
    owner = registry.name
    assert re.fullmatch(r"[0-9a-f]{32}", owner)
    meta = fields(registry / "meta")
    assert meta["version"] == "2" and meta["fleet_owner_token"] == owner
    assert meta["cleanup_policy"] == "reap"
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    assert (registry / "runtime-evidence-unconfirmed").is_file()
    audit = Path(meta["audit_dir"])
    assert audit.is_dir() and not audit.is_symlink() and audit.name == owner
    audit_meta = fields(audit / "meta")
    assert audit_meta["fleet_owner_token"] == owner
    assert audit_meta["run_id"] == meta["run_id"] and audit_meta["app"] == meta["app"]
    assert run == Path(meta["runs_root"]) / meta["run_id"] and run.resolve() == run
    assert manifest_path == run / "_forensic/manifest.json"
    assert archive_path == run / "_forensic/originals.tar.gz"
    manifest = object_file(manifest_path)
    assert manifest["schema"] == "cloudbench-started-evidence-v1"
    assert manifest["owner"] == owner and manifest["run_id"] == meta["run_id"]
    assert manifest["proof_credit"] == 0
    lifecycle = object_file(run / "_batch/lifecycle.json")
    assert lifecycle["status"] == "failed" and lifecycle["controller_exit_code"] != 0
    assert lifecycle["fleet_owner_token"] == owner
    tasks = object_file(run / "_batch/benches.json")
    rows = manifest["tasks"]
    assert isinstance(tasks, list) and isinstance(rows, list)
    assert 1 <= len(tasks) == len(rows) <= 4096
    assert len({row["machine_id"] for row in rows}) == len(rows)
    assert len({row["volume_id"] for row in rows}) == len(rows)
    # Autoscaled workers are separate exact-owned fresh clones of the claimed
    # pool primaries. Their verified original captures stay in the run output;
    # the provider reaper consumes their durable clone ledger after this latch
    # is released. Do not require an empty fresh ledger here.
    worker_contract = __import__("runpy").run_path(
        str(Path(__file__).with_name("cloudbench-worker-evidence.py")))
    worker_hashes = []
    expected_fresh = audit / "expected-fresh"
    fresh = audit / "fresh"
    by_machine = audit / "by-machine-id"
    clones = registry / "clones"
    for directory in (expected_fresh, fresh, by_machine, clones):
        assert directory.is_dir() and not directory.is_symlink()
    names = {path.name for path in fresh.iterdir()}
    assert names == {path.name for path in expected_fresh.iterdir()}
    clone_names = {path.name for path in clones.iterdir()}
    assert clone_names <= names
    fresh_records = {}
    for name in names:
        original = fields(fresh / name)
        expected = fields(expected_fresh / name)
        machine = original["machine_id"]
        volume = original["volume_id"]
        assert re.fullmatch(r"cloudbench-[A-Za-z0-9_-]+", name)
        assert re.fullmatch(r"[0-9a-f]+", machine)
        assert re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
        assert original["version"] == "1" and original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["clone_name"] == name and original["source"] == "fresh-clone"
        assert original["disposition"] in (
            "owned", "destroyed-verified-absent", "destroyed-provider-retained")
        assert expected == {"clone_name": name,
                            "source_machine_id": original["source_machine_id"]}
        if original["disposition"] == "owned":
            assert name in clone_names
            assert fields(clones / name) == {
                "name": name, "id": machine, "volume_id": volume}
        else:
            assert name not in clone_names
        assert regular_bytes(by_machine / machine, 256).decode().strip() == name
        fresh_records[machine] = original
    assert {path.name for path in by_machine.iterdir()} == set(fresh_records)
    machines = object_file(machines_path, 128 * 1024 * 1024)
    volumes = object_file(volumes_path, 128 * 1024 * 1024)
    assert isinstance(machines, list) and isinstance(volumes, list)
    native_machines = {row["id"]: row for row in machines}
    native_volumes = {row["id"]: row for row in volumes}
    assert len(native_machines) == len(machines)
    assert len(native_volumes) == len(volumes)
    for machine, original in fresh_records.items():
        assert original["source_machine_id"] in {row["machine_id"] for row in rows}
        if original["disposition"] == "owned":
            assert original["volume_id"] in native_volumes
        else:
            assert original["volume_id"] not in native_volumes
            assert machine not in native_machines
        if machine in native_machines:
            assert native_machines[machine]["name"] == original["clone_name"]
        ordinal = next(i for i, row in enumerate(rows)
                       if row["machine_id"] == original["source_machine_id"])
        task = tasks[ordinal]["name"]
        base = run / task / "worker-runtime-evidence" / machine
        worker_owner = object_file(base / "owner.json")
        assert all(worker_owner.get(key) == value for key, value in {
            "version": 1, "machine_id": machine,
            "primary_machine_id": original["source_machine_id"],
            "run_token": f"{owner}-{ordinal}"}.items())
        capture = base / "capture"
        worker_contract["verify_directory"](
            capture, worker_contract["authority"](f"{owner}-{ordinal}", machine))
        worker_hashes.append(hashlib.sha256(regular_bytes(
            capture / "manifest.json", 1048576)).hexdigest())
    assert archive_path.stat().st_size == manifest["archive_bytes"] <= 512 * 1024 * 1024
    assert hashlib.sha256(regular_bytes(archive_path, 512 * 1024 * 1024)).hexdigest() == manifest["archive_sha256"]
    pool = audit / "pool"
    assert pool.is_dir() and not pool.is_symlink()
    assert {path.name for path in pool.iterdir()} == {row["machine_id"] for row in rows}
    expected_files: dict[str, dict[str, object]] = {}
    for ordinal, (task, row) in enumerate(zip(tasks, rows, strict=True)):
        name = task["name"]
        assert re.fullmatch(r"[A-Za-z0-9._-]+", name) and name not in (".", "..")
        assert row["task"] == name and row["ordinal"] == ordinal
        assert row["run_token"] == f"{owner}-{ordinal}"
        assert row["proof_credit"] == 0 and row["kind"] == "pool"
        machine, volume = row["machine_id"], row["volume_id"]
        assert re.fullmatch(r"[0-9a-f]+", machine)
        assert re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
        original = fields(pool / machine)
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["source"] == "borrowed-pool"
        assert original["volume_id"] == volume and original["disposition"] == "claimed"
        out = run / name
        assert regular_bytes(out / ".cid", 256).decode().split() == ["pool", machine]
        assert regular_bytes(out / "guest-shutdown.confirmed", 256).decode().strip() == meta["run_id"]
        assert object_file(out / "runtime-evidence.owner.json") == {
            "version": 1, "machine_id": machine, "run_token": row["run_token"]}
        files = row["files"]
        assert isinstance(files, dict)
        mandatory = {"bench.log", "repo/.context/cloudbench/services.json",
                     "repo/.context/cloudbench/stack.log",
                     "repo/.context/cloudbench/logs/backend.log",
                     "repo/.context/cloudbench/run.json"}
        assert mandatory <= set(files)
        for relative, info in files.items():
            assert safe_name(relative) and type(info["bytes"]) is int
            assert 0 <= info["bytes"] <= 64 * 1024 * 1024
            assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
            member = f"{name}/{relative}"
            assert member not in expected_files
            expected_files[member] = info
    seen = set()
    archived_services = {}
    archived_runs = {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            assert member.isfile() and member.name in expected_files
            assert member.name not in seen
            info = expected_files[member.name]
            assert member.size == info["bytes"]
            stream = archive.extractfile(member)
            assert stream is not None
            data = stream.read(member.size + 1)
            assert len(data) == member.size
            assert hashlib.sha256(data).hexdigest() == info["sha256"]
            if member.name.endswith("/repo/.context/cloudbench/services.json"):
                archived_services[member.name.split("/", 1)[0]] = json.loads(data)
            if member.name.endswith("/repo/.context/cloudbench/run.json"):
                archived_runs[member.name.split("/", 1)[0]] = json.loads(data)
            seen.add(member.name)
    assert seen == set(expected_files)
    for row in rows:
        name = row["task"]
        services_status = archived_services[name]["status"]
        if services_status != "stopped":
            # A forcibly stopped primary can retain its original running
            # services.json. Preserve that truth and require the independently
            # sealed exact stopped-machine cleanup proof instead.
            assert services_status == "running"
            out = run / name
            stopped = object_file(out / "guest-cleanup.machine-stopped.json")
            receipt = object_file(out / "guest-cleanup.recovery-receipt.json")
            assert stopped["version"] == 1 and stopped["state"] == "stopped"
            assert stopped["machine_id"] == row["machine_id"]
            assert stopped["fleet_owner_token"] == owner
            assert stopped["fleet_run_id"] == meta["run_id"]
            assert receipt["machine_id"] == row["machine_id"]
            assert receipt["fleet_owner_token"] == owner
            assert receipt["fleet_run_id"] == meta["run_id"]
            assert stopped["machine_status_sha256"] == hashlib.sha256(
                regular_bytes(out / "guest-cleanup.machine-status.txt", 1048576)
            ).hexdigest()
            assert receipt["stopped_machine_proof_sha256"] == hashlib.sha256(
                json.dumps(stopped, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            assert native_machines[row["machine_id"]]["state"] == "stopped"
        results = archived_runs[name].get("tasks")
        assert isinstance(results, list) and len(results) == 1
        assert results[0]["name"] == name
        # A failed archive/driver stays failed even when provider cleanup was
        # independently recovered. No evaluator verdict is synthesized here.
    return {"schema": "cloudbench-started-evidence-verified-v1", "owner": owner,
            "run_id": meta["run_id"], "tasks": len(rows), "files": len(seen),
            "archive_sha256": manifest["archive_sha256"],
            "verified_workers": len(fresh_records),
            "worker_manifests_sha256": hashlib.sha256(
                "".join(sorted(worker_hashes)).encode()).hexdigest(),
            "proof_credit": 0}


def verify_interrupted_pool_evidence(
    registry: Path, run: Path, manifest_path: Path, archive_path: Path,
    machines_path: Path, volumes_path: Path,
) -> dict[str, object]:
    """Retire a failed pool owner after preserving sealed and crash originals.

    This path cannot yield benchmark credit. It admits absent worker clones only
    when the durable audit says they were never allocated and native inventory
    independently confirms absence. Interrupted guest files remain explicitly
    incomplete; no run result or driver exit is inferred from a stopped VM.
    """
    owner = registry.name
    assert re.fullmatch(r"[0-9a-f]{32}", owner)
    meta = fields(registry / "meta")
    assert meta["version"] == "2" and meta["fleet_owner_token"] == owner
    assert meta["cleanup_policy"] == "reap"
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    assert (registry / "runtime-evidence-unconfirmed").is_file()
    audit = Path(meta["audit_dir"])
    assert audit.is_dir() and not audit.is_symlink() and audit.name == owner
    audit_meta = fields(audit / "meta")
    assert audit_meta["fleet_owner_token"] == owner
    assert audit_meta["run_id"] == meta["run_id"] and audit_meta["app"] == meta["app"]
    assert run == Path(meta["runs_root"]) / meta["run_id"] and run.resolve() == run
    assert manifest_path == run / "_forensic/manifest.json"
    assert archive_path == run / "_forensic/originals.tar.gz"
    manifest = object_file(manifest_path)
    assert manifest["schema"] == "cloudbench-interrupted-pool-evidence-v1"
    assert manifest["owner"] == owner and manifest["run_id"] == meta["run_id"]
    assert manifest["proof_credit"] == 0
    lifecycle = object_file(run / "_batch/lifecycle.json")
    assert lifecycle["status"] == "failed" and lifecycle["controller_exit_code"] != 0
    assert lifecycle["fleet_owner_token"] == owner
    tasks = object_file(run / "_batch/benches.json")
    rows = manifest["tasks"]
    assert isinstance(tasks, list) and isinstance(rows, list)
    assert 1 <= len(tasks) == len(rows) <= 4096
    assert len({row["task"] for row in rows}) == len(rows)
    assert len({row["machine_id"] for row in rows}) == len(rows)
    assert len({row["volume_id"] for row in rows}) == len(rows)

    machines = object_file(machines_path, 128 * 1024 * 1024)
    volumes = object_file(volumes_path, 128 * 1024 * 1024)
    assert isinstance(machines, list) and isinstance(volumes, list)
    native_machines = {value["id"]: value for value in machines}
    native_volumes = {value["id"]: value for value in volumes}
    assert len(native_machines) == len(machines)
    assert len(native_volumes) == len(volumes)

    # Every worker attempt in this particular failure was a name-only phantom.
    # An actual worker must use the stricter started-worker capture verifier.
    assert not list((registry / "clones").iterdir())
    assert not list((audit / "by-machine-id").iterdir())
    fresh = audit / "fresh"
    expected = audit / "expected-fresh"
    assert {p.name for p in fresh.iterdir()} == {p.name for p in expected.iterdir()}
    for path in fresh.iterdir():
        original = fields(path)
        attempt = fields(expected / path.name)
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["source"] == "fresh-clone"
        assert original["disposition"] == "not-allocated-verified"
        assert not original["machine_id"] and not original["volume_id"]
        assert attempt == {"clone_name": path.name,
                           "source_machine_id": original["source_machine_id"]}
        assert original["source_machine_id"] in {row["machine_id"] for row in rows}
        assert not any(value["name"] == path.name for value in machines + volumes)

    pool = audit / "pool"
    assert pool.is_dir() and not pool.is_symlink()
    assert {path.name for path in pool.iterdir()} == {
        row["machine_id"] for row in rows}
    assert archive_path.stat().st_size == manifest["archive_bytes"] <= 512 * 1024 * 1024
    assert hashlib.sha256(regular_bytes(archive_path, 512 * 1024 * 1024)).hexdigest() == manifest["archive_sha256"]
    expected_files = {}
    incomplete = 0
    for ordinal, (task, row) in enumerate(zip(tasks, rows, strict=True)):
        name = row["task"]
        assert re.fullmatch(r"[A-Za-z0-9._-]+", name) and name not in (".", "..")
        assert task["name"] == name and row["ordinal"] == ordinal
        assert row["run_token"] == f"{owner}-{ordinal}"
        assert row["proof_credit"] == 0 and row["kind"] in {"sealed", "interrupted"}
        machine, volume = row["machine_id"], row["volume_id"]
        assert re.fullmatch(r"[0-9a-f]+", machine)
        assert re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
        original = fields(pool / machine)
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["source"] == "borrowed-pool"
        assert original["volume_id"] == volume and original["disposition"] == "claimed"
        assert native_machines[machine]["state"] == "stopped"
        assert native_volumes[volume]["attached_machine_id"] == machine
        out = run / name
        assert regular_bytes(out / ".cid", 256).decode().split() == ["pool", machine]
        assert regular_bytes(out / "guest-shutdown.confirmed", 256).decode().strip() == meta["run_id"]
        evidence_owner = {"version": 1, "machine_id": machine,
                          "run_token": row["run_token"]}
        assert object_file(out / "runtime-evidence.owner.json") == evidence_owner
        if row["kind"] == "sealed":
            manifest_file = out / "remote-logs/runtime-evidence/manifest.json"
            sealed = object_file(manifest_file)
            assert sealed["machine_id"] == machine and sealed["run_token"] == row["run_token"]
            assert sealed["version"] == 1
            assert object_file(out / "remote-logs/runtime-evidence/services.json")["status"] == "stopped"
            assert (out / "remote-logs/runtime-evidence/run.json").is_file()
            assert "sealed/manifest.json" in row["files"]
            assert "sealed/run.json" in row["files"]
            assert set(row["files"]) == {"sealed/manifest.json"} | {
                "sealed/" + rel for rel in sealed["files"]}
            for rel, info in sealed["files"].items():
                assert row["files"]["sealed/" + rel] == info
            assert row["files"]["sealed/manifest.json"] == {
                "bytes": manifest_file.stat().st_size,
                "sha256": hashlib.sha256(regular_bytes(manifest_file, 1048576)).hexdigest()}
        else:
            incomplete += 1
            assert object_file(out / "runtime-evidence.pending") == evidence_owner
            assert not (out / "remote-logs/runtime-evidence/run.json").exists()
            assert {"original/bench.log", "original/cloudbench-driver.state",
                    "original/cloudbench-driver.pid",
                    "original/repo/.context/cloudbench/services.json",
                    "original/repo/.context/cloudbench/stack.log",
                    "original/repo/.context/cloudbench/logs/backend.log",
                    "original/repo/.context/cloudbench/logs/worker.log"} <= set(row["files"])
            assert "original/repo/.context/cloudbench/run.json" in row["files"] or (
                "original/repo/.context/cloudbench/run.json" in row["missing"])
            stopped = object_file(out / "guest-cleanup.machine-stopped.json")
            receipt = object_file(out / "guest-cleanup.recovery-receipt.json")
            assert stopped["state"] == "stopped" and stopped["machine_id"] == machine
            assert stopped["fleet_owner_token"] == owner
            assert stopped["fleet_run_id"] == meta["run_id"]
            assert receipt["machine_id"] == machine
            assert receipt["fleet_owner_token"] == owner
            assert receipt["fleet_run_id"] == meta["run_id"]
            assert stopped["machine_status_sha256"] == hashlib.sha256(
                regular_bytes(out / "guest-cleanup.machine-status.txt", 1048576)).hexdigest()
            assert receipt["stopped_machine_proof_sha256"] == hashlib.sha256(
                json.dumps(stopped, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        for rel, info in row["files"].items():
            assert safe_name(rel) and set(info) == {"bytes", "sha256"}
            assert type(info["bytes"]) is int and 0 <= info["bytes"] <= 64 * 1024 * 1024
            assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
            member = f"{name}/{rel}"
            assert member not in expected_files
            expected_files[member] = info
    assert incomplete > 0
    seen = set()
    archived = {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            assert member.isfile() and member.name in expected_files
            assert member.name not in seen
            info = expected_files[member.name]
            assert member.size == info["bytes"]
            stream = archive.extractfile(member)
            assert stream is not None
            data = stream.read(member.size + 1)
            assert len(data) == member.size
            assert hashlib.sha256(data).hexdigest() == info["sha256"]
            if member.name.endswith("/sealed/run.json") or member.name.endswith(
                    "/original/repo/.context/cloudbench/run.json"):
                archived[member.name] = json.loads(data)
            if member.name.endswith("/original/repo/.context/cloudbench/services.json"):
                assert json.loads(data)["status"] == "running"
            if member.name.endswith("/original/cloudbench-driver.state"):
                assert data.strip() == b"running"
            seen.add(member.name)
    assert seen == set(expected_files)
    for row in rows:
        path = f"{row['task']}/" + (
            "sealed/run.json" if row["kind"] == "sealed"
            else "original/repo/.context/cloudbench/run.json")
        if path in archived:
            results = archived[path].get("tasks")
            assert isinstance(results, list) and len(results) == 1
            assert results[0]["name"] == row["task"]
    return {"schema": "cloudbench-interrupted-pool-evidence-verified-v1",
            "owner": owner, "run_id": meta["run_id"], "tasks": len(rows),
            "incomplete_tasks": incomplete, "unallocated_workers": len(list(fresh.iterdir())),
            "files": len(seen), "archive_sha256": manifest["archive_sha256"],
            "proof_credit": 0}


def object_file_from_bytes(data: bytes):
    return json.loads(data)


def verify(registry: Path, run: Path, manifest_path: Path, archive_path: Path,
           machines_path: Path, volumes_path: Path) -> dict[str, object]:
    assert registry.is_dir() and not registry.is_symlink()
    assert run.is_dir() and not run.is_symlink()
    owner = registry.name
    assert re.fullmatch(r"[0-9a-f]{32}", owner)
    meta = fields(registry / "meta")
    audit = Path(meta["audit_dir"])
    assert audit.is_absolute() and audit.resolve() == audit
    assert audit.name == owner and audit.is_dir() and not audit.is_symlink()
    audit_meta = fields(audit / "meta")
    assert meta["version"] == "2" and meta["fleet_owner_token"] == owner
    assert meta["cleanup_policy"] == "reap"
    assert audit_meta["fleet_owner_token"] == owner
    assert audit_meta["run_id"] == meta["run_id"] and audit_meta["app"] == meta["app"]
    assert run == Path(meta["runs_root"]) / meta["run_id"] and run.resolve() == run
    assert manifest_path == run / "_forensic/manifest.json"
    assert archive_path == run / "_forensic/originals.tar.gz"
    assert (registry / "runtime-evidence-unconfirmed").is_file()
    assert not (registry / "runtime-evidence-unconfirmed").is_symlink()
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    manifest = object_file(manifest_path, 1048576)
    assert manifest["schema"] == "cloudbench-forensic-retirement-v1"
    assert manifest["owner"] == owner and manifest["run_id"] == meta["run_id"]
    assert manifest["proof_credit"] == 0
    tasks = object_file(run / "_batch/benches.json", 1048576)
    assert isinstance(tasks, list) and 1 <= len(tasks) <= 4096
    lifecycle = object_file(run / "_batch/lifecycle.json", 1048576)
    assert lifecycle["version"] == 1 and lifecycle["status"] == "failed"
    assert lifecycle["fleet_owner_token"] == owner and lifecycle["run_id"] == meta["run_id"]
    assert type(lifecycle["controller_exit_code"]) is int and lifecycle["controller_exit_code"] != 0
    rows = manifest["tasks"]
    assert isinstance(rows, list) and len(rows) == len(tasks)
    assert len({row["task"] for row in rows}) == len(rows)
    assert len({row["machine_id"] for row in rows}) == len(rows)
    assert len({row["volume_id"] for row in rows}) == len(rows)
    unstarted_workers = manifest.get("unstarted_workers", [])
    assert isinstance(unstarted_workers, list)
    assert len({row["machine_id"] for row in unstarted_workers}) == len(unstarted_workers)
    started_workers = manifest.get("started_workers", [])
    assert isinstance(started_workers, list)
    assert len({row["machine_id"] for row in started_workers}) == len(started_workers)
    assert not {row["machine_id"] for row in started_workers}.intersection(
        row["machine_id"] for row in unstarted_workers
    )
    fresh_dir = audit / "fresh"
    clone_dir = registry / "clones"
    assert fresh_dir.is_dir() and not fresh_dir.is_symlink()
    assert clone_dir.is_dir() and not clone_dir.is_symlink()
    fresh = [fields(path) for path in fresh_dir.iterdir()]
    clones = [fields(path) for path in clone_dir.iterdir()]
    assert len(fresh) >= len(clones) >= len(rows)
    allocated = [row for row in fresh if row.get("volume_id")]
    assert len({row["volume_id"] for row in allocated}) == len(allocated)
    by_machine = {row["machine_id"]: row for row in fresh if row.get("machine_id")}
    assert len(by_machine) == len(rows) + len(unstarted_workers) + len(started_workers)
    by_clone = {row["name"]: row for row in clones}
    assert len(by_clone) == len(clones)
    unadmitted = []
    unallocated = []
    for original in fresh:
        if original.get("machine_id"):
            continue
        assert original["version"] == "1"
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["source"] == "fresh-clone"
        assert re.fullmatch(r"[0-9a-f]+", original["source_machine_id"])
        name, volume = original["clone_name"], original["volume_id"]
        assert re.fullmatch(r"[A-Za-z0-9._-]+", name) and name not in (".", "..")
        if original["disposition"] == "not-allocated-verified":
            assert not volume and name not in by_clone
            unallocated.append(name)
            continue
        assert re.fullmatch(r"vol_[a-zA-Z0-9]+", volume)
        assert original["disposition"] == "owned"
        assert by_clone[name] == {"name": name, "volume_id": volume}
        unadmitted.append(volume)
    assert len(set(unadmitted)) == len(unadmitted)
    assert len(fresh) == len(clones) + len(unallocated)
    expected_members: dict[str, dict] = {}
    expected_total = 0
    incomplete = 0
    for index, (task, row) in enumerate(zip(tasks, rows, strict=True)):
        name = row["task"]
        machine = row["machine_id"]
        volume = row["volume_id"]
        token = f"{owner}-{index}"
        assert task["name"] == name and row["ordinal"] == index
        assert row["run_token"] == token and row["proof_credit"] == 0
        assert re.fullmatch(r"[A-Za-z0-9._-]+", name) and name not in (".", "..")
        assert re.fullmatch(r"[0-9a-f]+", machine)
        assert re.fullmatch(r"vol_[a-zA-Z0-9]+", volume)
        original = by_machine[machine]
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["volume_id"] == volume and original["disposition"] == "owned"
        clone = by_clone[original["clone_name"]]
        assert clone == {"name": original["clone_name"], "id": machine, "volume_id": volume}
        out = run / name
        assert out.is_dir() and not out.is_symlink()
        assert regular_bytes(out / ".cid", 256).decode().split()[-1] == machine
        assert regular_bytes(out / "guest-shutdown.confirmed", 256).decode().strip() == meta["run_id"]
        evidence_owner = {"version": 1, "machine_id": machine, "run_token": token}
        assert object_file(out / "runtime-evidence.owner.json") == evidence_owner
        pending = out / "runtime-evidence.pending"
        if pending.exists() or pending.is_symlink():
            assert object_file(pending) == evidence_owner
        else:
            # The normal collector clears pending only after publishing the
            # exact canonical result. A failed peer may still retain pending.
            canonical = regular_bytes(out / "cloudbench-run.json", 64 * 1024 * 1024)
            assert canonical == regular_bytes(
                out / "remote-logs/runtime-evidence/run.json", 64 * 1024 * 1024)
            assert isinstance(json.loads(canonical), dict)
        files = row["files"]
        missing = row["missing"]
        assert isinstance(files, dict) and isinstance(missing, list)
        assert len(missing) == len(set(missing))
        assert set(files).isdisjoint(missing)
        mandatory = {"bench.log", "repo/.context/cloudbench/services.json",
                     "repo/.context/cloudbench/stack.log",
                     "repo/.context/cloudbench/logs/backend.log",
                     "repo/.context/cloudbench/logs/worker.log"}
        assert mandatory <= set(files)
        assert f"cloudbench-driver-clean-{token}.ack" in files or f"cloudbench-driver-clean-{token}.ack" in missing
        assert "repo/.context/cloudbench/run.json" in files or "repo/.context/cloudbench/run.json" in missing
        complete = row["runtime_evidence_complete"]
        assert type(complete) is bool
        assert not complete or (row["services_status"] == "stopped" and not missing)
        incomplete += not complete
        for relative, info in files.items():
            assert safe_name(relative) and relative not in (".", "..")
            assert type(info["bytes"]) is int and 0 <= info["bytes"] <= 512 * 1024 * 1024
            assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
            member = f"{name}/{relative}"
            assert member not in expected_members
            expected_members[member] = info
            expected_total += info["bytes"]
        for relative in missing:
            assert safe_name(relative)
    primary_by_machine = {row["machine_id"]: row for row in rows}
    for row in unstarted_workers:
        machine = row["machine_id"]
        assert re.fullmatch(r"[0-9a-f]+", machine) and machine not in primary_by_machine
        parent = primary_by_machine[row["primary_machine_id"]]
        task = parent["task"]
        assert row["task"] == task and row["run_token"] == parent["run_token"]
        assert row["proof_credit"] == 0 and row["worker_started"] is False
        original = by_machine[machine]
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["source_machine_id"] == row["primary_machine_id"]
        assert original["volume_id"] == row["volume_id"] and original["disposition"] == "owned"
        assert by_clone[original["clone_name"]] == {
            "name": original["clone_name"], "id": machine, "volume_id": row["volume_id"]}
        out = run / task
        assert (out / f"worker-{machine}.pending").is_file()
        assert machine not in regular_bytes(out / "worker-ready.ids", 65536).decode().splitlines()
        worker_owner = object_file(out / "worker-runtime-evidence" / machine / "owner.json")
        assert all(worker_owner[k] == v for k, v in {
            "version": 1, "machine_id": machine,
            "primary_machine_id": row["primary_machine_id"],
            "run_token": row["run_token"]}.items())
        stage = regular_bytes(out / f"worker-{machine}.stage.log", 16 * 1024 * 1024)
        assert hashlib.sha256(stage).hexdigest() == row["stage_log_sha256"]
        assert b"launch worker wrapper succeeded" not in stage
        files = row["files"]
        assert set(files) == {"worker-original.json"}
        info = files["worker-original.json"]
        assert type(info["bytes"]) is int and 0 < info["bytes"] <= 1048576
        assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
        member = f"_unstarted_workers/{machine}/worker-original.json"
        expected_members[member] = info
        expected_total += info["bytes"]
    required_worker_files = {
        "cloudbench-worker-evidence/owner.json",
        "cloudbench-worker-evidence/terminal.json",
        "cloudbench-worker-evidence/stop.json",
        "cloudbench-worker-evidence/child.json",
        "worker.log",
        "worker.started-at",
    }
    for row in started_workers:
        machine = row["machine_id"]
        assert re.fullmatch(r"[0-9a-f]+", machine) and machine not in primary_by_machine
        parent = primary_by_machine[row["primary_machine_id"]]
        assert row["task"] == parent["task"] and row["run_token"] == parent["run_token"]
        assert row["proof_credit"] == 0 and row["worker_started"] is True
        original = by_machine[machine]
        assert original["fleet_owner_token"] == owner
        assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
        assert original["source_machine_id"] == row["primary_machine_id"]
        assert original["volume_id"] == row["volume_id"] and original["disposition"] == "owned"
        assert by_clone[original["clone_name"]] == {
            "name": original["clone_name"], "id": machine, "volume_id": row["volume_id"]}
        out = run / row["task"]
        assert machine in regular_bytes(out / "worker-ready.ids", 65536).decode().splitlines()
        worker_owner = object_file(out / "worker-runtime-evidence" / machine / "owner.json")
        assert all(worker_owner[k] == v for k, v in {
            "version": 1, "machine_id": machine,
            "primary_machine_id": row["primary_machine_id"],
            "run_token": row["run_token"]}.items())
        stage = regular_bytes(out / f"worker-{machine}.stage.log", 16 * 1024 * 1024)
        assert hashlib.sha256(stage).hexdigest() == row["stage_log_sha256"]
        assert b"launch worker wrapper succeeded" in stage
        files = row["files"]
        assert isinstance(files, dict) and required_worker_files <= set(files)
        assert row.get("missing", []) == []
        for relative, info in files.items():
            assert safe_name(relative)
            assert type(info["bytes"]) is int and 0 <= info["bytes"] <= 512 * 1024 * 1024
            assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
            member = f"_started_workers/{machine}/{relative}"
            assert member not in expected_members
            expected_members[member] = info
            expected_total += info["bytes"]
    assert expected_total == manifest["uncompressed_bytes"]
    assert archive_path.stat().st_size == manifest["archive_bytes"]
    assert hashlib.sha256(regular_bytes(archive_path, 512 * 1024 * 1024)).hexdigest() == manifest["archive_sha256"]
    seen = set()
    archived_services = {}
    archived_unstarted = {}
    archived_started = {}
    archived_absence = {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            assert member.isfile() and member.name in expected_members and member.name not in seen
            info = expected_members[member.name]
            assert member.size == info["bytes"]
            stream = archive.extractfile(member)
            assert stream is not None
            digest = hashlib.sha256()
            left = member.size
            while left:
                block = stream.read(min(left, 65536))
                assert block
                digest.update(block)
                left -= len(block)
                if member.name.endswith("/repo/.context/cloudbench/services.json"):
                    assert member.size <= 1048576
                    task_name = member.name.split("/", 1)[0]
                    archived_services[task_name] = archived_services.get(task_name, b"") + block
                if member.name.endswith("/worker-log-absence-original.json"):
                    assert member.size <= 1048576
                    task_name = member.name.split("/", 1)[0]
                    archived_absence[task_name] = archived_absence.get(task_name, b"") + block
                if member.name.startswith("_unstarted_workers/"):
                    archived_unstarted[member.name] = archived_unstarted.get(member.name, b"") + block
                if member.name.startswith("_started_workers/") and member.name.endswith(
                    ("/owner.json", "/terminal.json", "/stop.json", "/child.json")
                ):
                    assert member.size <= 1048576
                    archived_started[member.name] = archived_started.get(member.name, b"") + block
            assert digest.hexdigest() == info["sha256"]
            seen.add(member.name)
    assert seen == set(expected_members)
    for row in rows:
        services = json.loads(archived_services[row["task"]])
        assert services["status"] == row["services_status"]
        worker_count = services["env"]["worker_processes"]
        assert type(worker_count) is int and 1 <= worker_count <= 1024
        absent_logs = []
        for number in range(1, worker_count):
            relative = f"repo/.context/cloudbench/logs/worker.{number}.log"
            if relative not in row["files"]:
                assert not row["runtime_evidence_complete"] and relative in row["missing"]
                absent_logs.append(relative)
        if absent_logs:
            assert "worker-log-absence-original.json" in row["files"]
            assert json.loads(archived_absence[row["task"]]) == {
                "version": 1, "machine_id": row["machine_id"],
                "services_status": row["services_status"], "missing": absent_logs}
    for row in unstarted_workers:
        member = f"_unstarted_workers/{row['machine_id']}/worker-original.json"
        proof = json.loads(archived_unstarted[member])
        assert proof == {
            "version": 1, "machine_id": row["machine_id"],
            "run_token": row["run_token"], "worker_started": False,
            "worker_supervisor_present": False, "worker_script_present": False,
            "worker_helper_present": False, "worker_log_present": False,
            "worker_started_at_present": False,
        }
    for row in started_workers:
        machine = row["machine_id"]
        prefix = f"_started_workers/{machine}/cloudbench-worker-evidence/"
        originals = {name: json.loads(archived_started[prefix + name + ".json"])
                     for name in ("owner", "terminal", "stop", "child")}
        for name, value in originals.items():
            assert value["machine_id"] == machine and value["run_token"] == row["run_token"]
        terminal = originals["terminal"]
        assert terminal["worker_started"] is True
        assert terminal["quiescent"] is True and terminal["stop_requested"] is True
        assert terminal["children_reaped"] is True and terminal["streams_closed"] is True
        assert terminal["exit_code"] == 0
    machines = object_file(machines_path, 128 * 1024 * 1024)
    volumes = object_file(volumes_path, 128 * 1024 * 1024)
    assert isinstance(machines, list) and isinstance(volumes, list)
    active_machines = {row["id"] for row in machines}
    active_volumes = {row["id"] for row in volumes}
    assert not active_machines.intersection(by_machine)
    assert not active_volumes.intersection(row["volume_id"] for row in allocated)
    assert not {row.get("name") for row in machines + volumes}.intersection(unallocated)
    return {"schema": "cloudbench-forensic-retirement-verified-v1",
            "owner": owner, "run_id": meta["run_id"], "tasks": len(rows),
            "incomplete_tasks": incomplete, "unadmitted_clones": len(unadmitted),
            "unstarted_workers": len(unstarted_workers),
            "started_workers": len(started_workers),
            "unallocated_attempts": len(unallocated),
            "files": len(seen),
            "archive_sha256": manifest["archive_sha256"], "proof_credit": 0}


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("registry", "run", "manifest", "archive", "machines", "volumes"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    args = parser.parse_args()
    manifest = object_file(args.manifest)
    if manifest.get("schema") == "cloudbench-prestart-evidence-v1":
        result = verify_prestart_evidence(args.registry, args.run, args.manifest,
                                          args.archive)
    elif manifest.get("schema") == "cloudbench-started-evidence-v1":
        result = verify_started_pool_evidence(args.registry, args.run, args.manifest,
                                              args.archive, args.machines, args.volumes)
    elif manifest.get("schema") == "cloudbench-interrupted-pool-evidence-v1":
        result = verify_interrupted_pool_evidence(
            args.registry, args.run, args.manifest, args.archive,
            args.machines, args.volumes)
    else:
        result = verify(args.registry, args.run, args.manifest, args.archive,
                        args.machines, args.volumes)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
