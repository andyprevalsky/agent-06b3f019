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
        for number in range(1, worker_count):
            assert f"repo/.context/cloudbench/logs/worker.{number}.log" in row["files"]
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
    result = verify(args.registry, args.run, args.manifest, args.archive,
                    args.machines, args.volumes)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
