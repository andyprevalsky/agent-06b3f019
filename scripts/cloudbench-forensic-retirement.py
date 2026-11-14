#!/usr/bin/env python3
"""Verify an exact failed fleet's original files before retiring its evidence latch.

This is an ownership recovery path, never a benchmark result or proof credit.
The caller supplies two fresh, successful native provider inventories.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import runpy
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


def verify_quiesced_provider_archive(
    out: Path, row: dict[str, object], owner: str, run_id: str,
) -> dict[str, object]:
    """Bind a canceled guest's original files to its exact recovery receipt.

    A driver may exit without its normal ACK while exact guest recovery still
    quiesces the stack and releases every logged provider session. That leaves
    services.json stopped, not failed. The original run/backend bytes, the
    quiescence receipt, and the provider cleanup receipt must all agree.
    """
    helper = runpy.run_path(str(Path(__file__).with_name("cloudbench-exact-session-cleanup.py")))
    args = argparse.Namespace(
        owner=owner, fleet_run_id=run_id, bench=row["task"],
        machine_id=row["machine_id"], output_dir=str(out),
        guest_run_token=row["run_token"],
        run_json=str(out / "guest-cleanup.run.json"),
        backend_log=str(out / "guest-cleanup.backend.log"),
        quiescence_receipt=str(out / "guest-cleanup.quiescence.json"),
    )
    provider = object_file(out / "guest-cleanup.provider-manifest.json")
    receipt = object_file(out / "guest-cleanup.recovery-receipt.json")
    if provider["kind"] in {"provider-exact-manifest", "provider-rootless-sms-zero-manifest"}:
        assert provider == helper["provider_manifest"](args)
        assert helper["validate_provider_receipt"](receipt, provider, None)
    elif provider["kind"] == "provider-zero-manifest":
        # A task can complete real LLM work without allocating a browser
        # session. The recovery path then proves zero allocation with the
        # guest's exact database/query receipt, not a provider DELETE list.
        # Recompute that proof against the captured run, backend, quiescence,
        # and zero-query files before the interrupted archive can release its
        # resource latch. This remains zero benchmark-proof credit.
        args.zero_query_proof = str(out / "guest-cleanup.zero-allocation.json")
        assert provider == helper["zero_provider_manifest"](args)
        assert helper["validate_zero_receipt"](receipt, provider)
    else:
        raise AssertionError("unrecognized exact provider cleanup manifest")
    originals = row["files"]
    assert originals["original/repo/.context/cloudbench/run.json"]["sha256"] == (
        provider["evidence"]["run_json_sha256"])
    assert originals["original/repo/.context/cloudbench/logs/backend.log"]["sha256"] == (
        provider["evidence"]["backend_log_sha256"])
    return provider


def verify_failed_stack_provider_archive(
    out: Path, row: dict[str, object], owner: str, run_id: str,
    originals: dict[str, bytes],
) -> None:
    """Retire a stopped Machine only after its exact provider cleanup is verified.

    Original services.json bytes remain retained. A stale running status also
    requires an exact supervisor exit; both paths require stopped-Machine proof
    and an exact provider cleanup receipt before zero-credit retirement.
    """
    services = json.loads(originals["repo/.context/cloudbench/services.json"])
    assert services["status"] in {"running", "failed"}
    if services["status"] == "running":
        backends = [service for service in services["services"]
                    if service.get("name") == "back-end"]
        assert len(backends) == 1 and type(backends[0].get("pid")) is int
        stack = originals["repo/.context/cloudbench/stack.log"].decode("utf-8")
        fatal = (f"back-end (PID {backends[0]['pid']}) exited with code 137 "
                 "— shutting down all services.")
        assert fatal in stack and stack.find("Stopping all services...") > stack.find(fatal)
        assert "original/repo/.context/cloudbench/run.json" in row["files"]
        run = json.loads(originals["repo/.context/cloudbench/run.json"])
        assert len(run["tasks"]) == 1
        assert run["tasks"][0]["name"] == row["task"]
        assert run["tasks"][0]["status"] == "ERROR"

    verify_stopped_provider_archive(
        out, row, owner, run_id,
        hashlib.sha256(originals["repo/.context/cloudbench/logs/backend.log"]).hexdigest(),
        original_backend=originals["repo/.context/cloudbench/logs/backend.log"],
    )


def verify_stopped_provider_archive(
    out: Path, row: dict[str, object], owner: str, run_id: str,
    original_backend_sha256: str, *, original_backend: bytes | None = None,
) -> None:
    """A stopped guest still owns every provider session in its original log."""
    helper = runpy.run_path(str(Path(__file__).with_name("cloudbench-exact-session-cleanup.py")))
    provider = object_file(out / "guest-cleanup.provider-manifest.json")
    stopped = object_file(out / "guest-cleanup.machine-stopped.json")
    receipt = object_file(out / "guest-cleanup.recovery-receipt.json")
    assert provider["kind"] == "provider-active-exact-manifest"
    backend = regular_bytes(out / "guest-cleanup.backend.log", 64 * 1024 * 1024)
    if hashlib.sha256(backend).hexdigest() != original_backend_sha256:
        assert original_backend is not None and original_backend.startswith(backend)
        assert hashlib.sha256(original_backend).hexdigest() == original_backend_sha256
        before = helper["ANSI"].sub("", backend.decode("utf-8"))
        after = helper["ANSI"].sub("", original_backend.decode("utf-8"))
        tail = helper["ANSI"].sub("", original_backend[len(backend):].decode("utf-8"))
        assert helper["collect_session_evidence"](after) == helper["collect_session_evidence"](before)
        assert helper["parse_active_root_agent"](after) == helper["parse_active_root_agent"](before)
        assert after.count("[HTTP] POST /api/agents -> 201") == before.count("[HTTP] POST /api/agents -> 201")
        assert helper["collect_session_evidence"](tail) == ({"kernel": [], "steel": []}, 0, 0)
        assert helper["payment_mutation_count"](tail) == 0
    args = argparse.Namespace(
        owner=owner, fleet_run_id=run_id, bench=row["task"],
        machine_id=row["machine_id"], output_dir=str(out),
        guest_run_token=row["run_token"],
        backend_log=str(out / "guest-cleanup.backend.log"),
        clone_name=stopped["clone_name"],
        machine_status=str(out / "guest-cleanup.machine-status.txt"),
        manifest=str(out / "guest-cleanup.provider-manifest.json"),
        stopped_proof=str(out / "guest-cleanup.machine-stopped.json"),
    )
    assert provider == helper["active_provider_manifest"](args)
    stopped_sha = helper["validate_stopped_machine_proof"](args, provider)
    assert helper["validate_provider_receipt"](receipt, provider, stopped_sha)


def verify_capture_payload(capture: dict, raw: bytes, originals: dict[str, bytes]) -> None:
    """Bind the unchanged nested archive to its declared original files."""
    captured = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            assert member.isfile() and safe_name(member.name) and member.name not in captured
            assert member.size <= 64 * 1024 * 1024
            stream = archive.extractfile(member)
            assert stream is not None
            data = stream.read(member.size + 1)
            assert len(data) == member.size and originals[member.name] == data
            captured[member.name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    assert captured == capture["files"]


def verify_original_volume_provenance(meta: dict, row: dict, originals: dict[str, bytes]) -> dict:
    """Consume the inert collector's own receipt, without inventing legacy proof."""
    proof = json.loads(originals["original-capture-provenance.json"])
    expected = {
        "schema": "cloudbench-original-volume-capture-v1", "version": 1,
        "kind": "original-volume-inert-capture", "direct_original_volume": True,
        "proof_credit": 0, "native_release_verified": False,
        "fleet_owner_token": meta["fleet_owner_token"], "run_id": meta["run_id"],
        "app": meta["app"], "bench": row["task"], "ordinal": row["ordinal"],
        "allocation_kind": "clone", "guest_run_token": row["run_token"],
        "machine_id": row["machine_id"], "source_machine_id": row["machine_id"],
        "volume_id": row["volume_id"], "source_volume_id": row["volume_id"],
        "archive_name": row["machine_id"] + ".tar.gz",
        "native_final_volume_state": "created", "inert_command": ["sleep", "infinity"],
        "guest_inert_sleepers": 1,
        "provider_mutations": ["config-inert", "start", "stop", "config-restore"],
    }
    assert all(type(proof.get(key)) is type(value) and proof[key] == value
               for key, value in expected.items())
    assert proof["native_final_state"] in {"stopped", "created"}
    raw = originals["original-volume-capture.tar.gz"]
    assert type(proof["archive_bytes"]) is int and proof["archive_bytes"] == len(raw)
    assert proof["archive_sha256"] == hashlib.sha256(raw).hexdigest()
    config = json.loads(originals["original-native-config.json"])
    # The collector hashes canonical JSON, while its saved file has a newline.
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    assert proof["native_original_config_sha256"] == hashlib.sha256(canonical).hexdigest()
    missing = proof["missing"]
    assert isinstance(missing, list) and len(missing) == len(set(missing))
    assert all(isinstance(name, str) and safe_name(name) for name in missing)
    assert missing == row["missing"] and set(missing).isdisjoint(proof["files"])
    verify_capture_payload(proof, raw, originals)
    return proof


def verify_pre_service_archive(meta: dict, row: dict, originals: dict[str, bytes], *, config_preserved: bool = False) -> None:
    """Verify the original pre-service endpoint without inventing a runtime receipt."""
    token, machine, volume = (row[key] for key in ("run_token", "machine_id", "volume_id"))
    ack = f"cloudbench-driver-clean-{token}.ack"
    absent = {
        "cloudbench-driver.pid", "repo/.context/cloudbench/services.json",
        "repo/.context/cloudbench/stack.log", "repo/.context/cloudbench/run.json",
        "repo/.context/cloudbench/logs/backend.log", "repo/.context/cloudbench/logs/worker.log",
    }
    assert row["services_status"] is None and row["runtime_evidence_complete"] is False
    assert absent <= set(row["missing"]) and absent.isdisjoint(originals)
    assert originals["cloudbench-driver.state"] == b"exited\n"
    assert originals[ack] == (token + "\n").encode()
    assert originals["bench.log"].splitlines()[0] == ("RUNSTAMP-" + token).encode()
    config_bytes = originals["original-native-config.json"]
    config = json.loads(config_bytes)
    raw = originals["original-volume-capture.tar.gz"]
    if "original-capture-provenance.json" in originals:
        assert not config_preserved
        assert {"original-capture-manifest.json", "original-capture-receipt.json"}.isdisjoint(originals)
        capture = verify_original_volume_provenance(meta, row, originals)
    else:
        capture = json.loads(originals["original-capture-manifest.json"])
        receipt = json.loads(originals["original-capture-receipt.json"])
        raw = originals["original-volume-capture.tar.gz"]
        assert capture["machine_id"] == capture["source_machine_id"] == machine
        assert capture["source_volume_id"] == volume and capture["run_token"] == token
        assert capture["proof_credit"] == 0
        assert receipt["machine_id"] == machine and receipt["volume_id"] == volume
        assert receipt["owner"] == meta["fleet_owner_token"] and receipt["proof_credit"] == 0
        assert receipt["capture_complete"] is True
        if config_preserved:
            assert receipt["capture_mode"] == "authenticated-terminal-read"
            assert receipt["original_config_unchanged"] is True
            assert receipt["before_config_sha256"] == receipt["after_config_sha256"] == hashlib.sha256(config_bytes).hexdigest()
        else:
            assert receipt["restored_original_config"] is True
        assert receipt["original_config_sha256"] == hashlib.sha256(config_bytes).hexdigest()
        for proof in (capture, receipt):
            assert proof["archive_bytes"] == len(raw)
            assert proof["archive_sha256"] == hashlib.sha256(raw).hexdigest()
        assert capture["missing"] == row["missing"]
    verify_capture_payload(capture, raw, originals)
    assert absent.isdisjoint(capture["files"])
    assert config["env"]["CLOUDBENCH_RUN_TOKEN"] == token
    assert config["env"]["CLOUDBENCH_FRESH_VOLUME"] == "1"
    assert config["env"]["BENCH_TASKS_B64"] == base64.b64encode(row["task"].encode()).decode()
    assert config["init"]["cmd"] == ["bash", "/cloudbench-boot.sh"]
    assert isinstance(config["mounts"], list) and len(config["mounts"]) == 1
    assert config["mounts"][0]["volume"] == volume and config["mounts"][0]["path"] == "/data"
    source = runpy.run_path(str(Path(__file__).with_name("cloudbench-prestack-recovery.py")))
    _, _, fingerprint = source["native_recipe"](meta, config)
    assert "before-stack-launch" in source["trusted_source_review_policy"]().get(fingerprint, [])


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


def verify_pool_worker_evidence(
    registry: Path, run: Path, meta: dict, audit: Path, tasks: list, rows: list,
    machines_path: Path, volumes_path: Path, *, allow_unallocated: bool = False,
    fresh_names: set[str] | None = None,
):
    """Apply the same exact worker capture contract to sealed and interrupted primaries."""
    owner = meta["fleet_owner_token"]
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
    subset = fresh_names is not None
    if subset:
        assert fresh_names <= names
        names = fresh_names
        clone_names &= names
    machines = object_file(machines_path, 128 * 1024 * 1024)
    volumes = object_file(volumes_path, 128 * 1024 * 1024)
    assert isinstance(machines, list) and isinstance(volumes, list)
    native_machines = {row["id"]: row for row in machines}
    native_volumes = {row["id"]: row for row in volumes}
    assert len(native_machines) == len(machines)
    assert len(native_volumes) == len(volumes)
    fresh_records = {}
    unallocated = 0
    for name in names:
        original = fields(fresh / name)
        expected = fields(expected_fresh / name)
        machine = original["machine_id"]
        volume = original["volume_id"]
        if original.get("disposition") == "not-allocated-verified":
            assert allow_unallocated and not machine and not volume
            assert name not in clone_names
            assert original["version"] == "1" and original["fleet_owner_token"] == meta["fleet_owner_token"]
            assert original["run_id"] == meta["run_id"] and original["app"] == meta["app"]
            assert original["clone_name"] == name and original["source"] == "fresh-clone"
            assert expected == {"clone_name": name, "source_machine_id": original["source_machine_id"]}
            assert original["source_machine_id"] in {row["machine_id"] for row in rows}
            assert not any(value["name"] == name for value in machines + volumes)
            unallocated += 1
            continue
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
    indexed = {path.name for path in by_machine.iterdir()}
    assert set(fresh_records) <= indexed if subset else indexed == set(fresh_records)
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
    return fresh_records, worker_hashes, native_machines, native_volumes, unallocated


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
    fresh_records, worker_hashes, native_machines, native_volumes, _ = verify_pool_worker_evidence(
        registry, run, meta, audit, tasks, rows, machines_path, volumes_path,
    )
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
    archived_backends = {}
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
            if member.name.endswith("/repo/.context/cloudbench/logs/backend.log"):
                archived_backends[member.name.split("/", 1)[0]] = hashlib.sha256(data).hexdigest()
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
            verify_stopped_provider_archive(
                out, row, owner, meta["run_id"], archived_backends[name],
            )
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

    This path cannot yield benchmark credit. Allocated workers retain the same
    exact terminal capture and provider-inventory checks as sealed primaries.
    Never-allocated attempts require their durable audit and native absence.
    Interrupted guest files remain explicitly incomplete; no result or driver
    exit is inferred from a stopped VM.
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

    fresh_records, worker_hashes, _, _, unallocated = verify_pool_worker_evidence(
        registry, run, meta, audit, tasks, rows, machines_path, volumes_path, allow_unallocated=True,
    )
    pool = audit / "pool"
    assert pool.is_dir() and not pool.is_symlink()
    assert {path.name for path in pool.iterdir()} == {
        row["machine_id"] for row in rows}
    assert archive_path.stat().st_size == manifest["archive_bytes"] <= 512 * 1024 * 1024
    assert hashlib.sha256(regular_bytes(archive_path, 512 * 1024 * 1024)).hexdigest() == manifest["archive_sha256"]
    expected_files = {}
    rejected_names = {
        row["task"] for row in rows
        if (run / row["task"] / "guest-start-rejected.confirmed").is_file()
    }
    prestack_names = {
        row["task"] for row in rows
        if (run / row["task"] / "guest-prestack.confirmed").is_file()
    }
    assert not rejected_names & prestack_names
    incomplete = 0
    for ordinal, (task, row) in enumerate(zip(tasks, rows, strict=True)):
        name = row["task"]
        assert re.fullmatch(r"[A-Za-z0-9._-]+", name) and name not in (".", "..")
        assert task["name"] == name and row["ordinal"] == ordinal
        assert row["run_token"] == f"{owner}-{ordinal}"
        assert row["proof_credit"] == 0 and row["kind"] in {"sealed", "interrupted"}
        assert isinstance(row["files"], dict) and isinstance(row["missing"], list)
        assert len(row["missing"]) == len(set(row["missing"]))
        assert set(row["files"]).isdisjoint(row["missing"])
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
            required_original = {"original/bench.log", "original/cloudbench-driver.state"}
            if name in prestack_names:
                assert {
                    "original/repo/.context/cloudbench/services.json",
                    "original/repo/.context/cloudbench/stack.log",
                    "original/repo/.context/cloudbench/logs/backend.log",
                    "original/repo/.context/cloudbench/logs/worker.log",
                } <= set(row["missing"])
            else:
                required_original |= {
                    "original/repo/.context/cloudbench/services.json",
                    "original/repo/.context/cloudbench/stack.log",
                    "original/repo/.context/cloudbench/logs/backend.log",
                    "original/repo/.context/cloudbench/logs/worker.log",
                }
            assert required_original <= set(row["files"])
            assert "original/cloudbench-driver.pid" in row["files"] or (
                "original/cloudbench-driver.pid" in row["missing"])
            assert "original/repo/.context/cloudbench/run.json" in row["files"] or (
                "original/repo/.context/cloudbench/run.json" in row["missing"])
            stopped_path = out / "guest-cleanup.machine-stopped.json"
            receipt_path = out / "guest-cleanup.recovery-receipt.json"
            if name in prestack_names:
                assert not stopped_path.exists() and not receipt_path.exists()
                assert regular_bytes(out / "post-config-start.accepted", 256) == (machine + "\n").encode()
                assert regular_bytes(out / "worker-clones.ids", 4096) == b""
                assert not (out / "cloudbench-run.json").exists()
            elif (out / "guest-start-rejected.confirmed").is_file():
                assert not stopped_path.exists() and not receipt_path.exists()
                assert not (out / "post-config-start.accepted").exists()
                assert not (out / "status-proxy.port").exists()
                assert not (out / "cloudbench-run.json").exists()
                assert regular_bytes(out / "worker-clones.ids", 4096) == b""
            elif stopped_path.is_file():
                assert receipt_path.is_file()
                stopped = object_file(stopped_path)
                receipt = object_file(receipt_path)
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
            elif receipt_path.is_file():
                verify_quiesced_provider_archive(out, row, owner, meta["run_id"])
            else:
                # A confirmed normal shutdown may finish before the driver
                # writes run.json. Preserve its exact original clean ACK and
                # stack-clean status; native inventory independently proves
                # this owner's source Machine is stopped. This is still an
                # interrupted archive and can never receive proof credit.
                token = row["run_token"]
                assert "original/cloudbench-driver.pid" in row["missing"]
                assert "original/repo/.context/cloudbench/run.json" in row["missing"]
                assert f"original/cloudbench-driver-clean-{token}.ack" in row["files"]
                assert (f"original/repo/.context/cloudbench/"
                        f"cloudbench-stack-cleanup-{token}.status") in row["files"]
        for rel, info in row["files"].items():
            assert safe_name(rel) and set(info) == {"bytes", "sha256"}
            assert type(info["bytes"]) is int and 0 <= info["bytes"] <= 64 * 1024 * 1024
            assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
            member = f"{name}/{rel}"
            assert member not in expected_files
            expected_files[member] = info
    # Controller collection can be interrupted after every guest seals. The
    # failed lifecycle and zero-credit manifest govern retirement, independently
    # of whether any original guest capture is incomplete.
    seen = set()
    archived = {}
    failed_stack_names = {
        row["task"] for row in rows if row["kind"] == "interrupted"
        and (run / row["task"] / "guest-cleanup.machine-stopped.json").is_file()
        and object_file(run / row["task"] / "guest-cleanup.provider-manifest.json")
            .get("kind") == "provider-active-exact-manifest"
    }
    captured_originals = {name: {} for name in rejected_names | prestack_names | failed_stack_names}
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
            task_name, _, original_relative = member.name.partition("/original/")
            if task_name in captured_originals and original_relative:
                captured_originals[task_name][original_relative] = data
            if member.name.endswith("/sealed/run.json") or member.name.endswith(
                    "/original/repo/.context/cloudbench/run.json"):
                archived[member.name] = json.loads(data)
            if member.name.endswith("/original/repo/.context/cloudbench/services.json"):
                archived[member.name] = json.loads(data)
            if member.name.endswith("/original/cloudbench-driver.state"):
                archived[member.name] = data.strip()
            if member.name.endswith("/original/repo/.context/cloudbench/logs/backend.log"):
                archived[member.name] = data
            if "/original/cloudbench-driver-clean-" in member.name and member.name.endswith(".ack"):
                archived[member.name] = data
            if "/original/repo/.context/cloudbench/cloudbench-stack-cleanup-" in member.name and member.name.endswith(".status"):
                archived[member.name] = data
            seen.add(member.name)
    assert seen == set(expected_files)
    for row in rows:
        path = f"{row['task']}/" + (
            "sealed/run.json" if row["kind"] == "sealed"
            else "original/repo/.context/cloudbench/run.json")
        if row["kind"] == "interrupted":
            prefix = f"{row['task']}/original/"
            state = archived[prefix + "cloudbench-driver.state"]
            services = archived.get(prefix + "repo/.context/cloudbench/services.json")
            if "original/cloudbench-driver.pid" in row["missing"]:
                assert state == b"exited"
                if row["task"] in prestack_names:
                    verify_prestack_archive(
                        run / row["task"], row, owner, meta["run_id"],
                        captured_originals[row["task"]],
                    )
                elif row["task"] in rejected_names:
                    verify_rejected_start_archive(
                        run / row["task"], row, owner, meta["run_id"],
                        captured_originals[row["task"]],
                    )
                elif (run / row["task"] / "guest-cleanup.recovery-receipt.json").is_file():
                    out = run / row["task"]
                    provider = object_file(out / "guest-cleanup.provider-manifest.json")
                    if provider["kind"] == "provider-prestart-zero-manifest":
                        assert services["status"] == "stopped"
                        assert "original/repo/.context/cloudbench/run.json" in row["missing"]
                        verify_prestart_provider_archive(
                            out, row, provider,
                            archived[prefix + "repo/.context/cloudbench/logs/backend.log"])
                    elif provider["kind"] in {
                        "provider-exact-manifest", "provider-zero-manifest",
                        "provider-rootless-sms-zero-manifest",
                    }:
                        assert services["status"] == "stopped"
                        assert "original/repo/.context/cloudbench/run.json" in row["files"]
                        verify_quiesced_provider_archive(
                            out, row, owner, meta["run_id"])
                    else:
                        assert provider["kind"] == "provider-active-exact-manifest"
                        verify_failed_stack_provider_archive(
                            out, row, owner, meta["run_id"],
                            captured_originals[row["task"]],
                        )
                else:
                    assert services["status"] == "stopped"
                    token = row["run_token"]
                    assert archived[prefix + f"cloudbench-driver-clean-{token}.ack"] == (token + "\n").encode()
                    status = archived[prefix + f"repo/.context/cloudbench/cloudbench-stack-cleanup-{token}.status"]
                    verify_clean_stack_status(status, token)
            else:
                assert state == b"running" and services["status"] == "running"
                verify_stopped_provider_archive(
                    run / row["task"], row, owner, meta["run_id"],
                    hashlib.sha256(
                        archived[prefix + "repo/.context/cloudbench/logs/backend.log"]
                    ).hexdigest(),
                )
        if path in archived and row["task"] not in rejected_names | prestack_names:
            results = archived[path].get("tasks")
            assert isinstance(results, list) and len(results) == 1
            assert results[0]["name"] == row["task"]
    return {"schema": "cloudbench-interrupted-pool-evidence-verified-v1",
            "owner": owner, "run_id": meta["run_id"], "tasks": len(rows),
            "incomplete_tasks": incomplete, "unallocated_workers": unallocated,
            "verified_workers": len(fresh_records),
            "worker_manifests_sha256": hashlib.sha256(
                "".join(sorted(worker_hashes)).encode()).hexdigest(),
            "files": len(seen), "archive_sha256": manifest["archive_sha256"],
            "proof_credit": 0}


def verify_prestack_archive(
    out: Path, row: dict[str, object], owner: str, run_id: str,
    originals: dict[str, bytes],
) -> None:
    """A Mac-only task rejected before stack startup has no run to seal."""
    receipt = object_file(out / "guest-prestack.confirmed")
    machine, volume, token = row["machine_id"], row["volume_id"], row["run_token"]
    assert row["task"] == "message-person"
    assert receipt["version"] == 1 and receipt["kind"] == "unsupported-platform-prestack-zero"
    assert receipt["fleet_owner_token"] == owner and receipt["run_id"] == run_id
    assert receipt["bench"] == row["task"] and receipt["run_token"] == token
    assert receipt["machine_id"] == machine and receipt["volume_id"] == volume
    assert receipt["provider_state"] == "stopped" and receipt["proof_credit"] == 0
    provenance = receipt["capture_provenance"]
    assert provenance["direct_original_volume"] is True
    assert provenance["source_machine_id"] == machine
    assert provenance["source_volume_id"] == volume
    assert provenance["archive_sha256"] == receipt["capture_sha256"]
    assert provenance["proof_credit"] == 0 and set(provenance["files"]) == set(originals)
    assert receipt["original_file_sha256"] == {
        name: hashlib.sha256(data).hexdigest() for name, data in sorted(originals.items())
    }
    missing_stack = {
        "cloudbench-driver.pid", "repo/.context/cloudbench/services.json",
        "repo/.context/cloudbench/stack.log",
        "repo/.context/cloudbench/logs/backend.log",
        "repo/.context/cloudbench/logs/worker.log",
        "repo/.context/cloudbench/run.json",
    }
    clean_ack = f"cloudbench-driver-clean-{token}.ack"
    assert not missing_stack & set(originals)
    assert {"bench.log", "cloudbench-driver.state", clean_ack} <= set(originals)
    assert originals["cloudbench-driver.state"].strip() == b"exited"
    assert originals[clean_ack] == (token + "\n").encode()
    bench_log = originals["bench.log"].decode()
    assert owner in bench_log and "git-syncing + verifying" in bench_log
    assert "guest shutdown requested" in bench_log and "driver exited rc=143" in bench_log
    assert "stack healthy" not in bench_log and "running benchmark" not in bench_log
    child = regular_bytes(out / "fleet-child.log", 1048576).decode()
    assert "Live message-person benchmark requires a macOS controller for Apple Messages" in child
    assert "Original exit code: 70" in child
    assert regular_bytes(out / "guest-shutdown.confirmed", 256) == (run_id + "\n").encode()
    assert regular_bytes(out / "post-config-start.accepted", 256) == (machine + "\n").encode()
    assert regular_bytes(out / "worker-clones.ids", 4096) == b""
    assert regular_bytes(out / "benchmark-child.finished", 256).strip() != b"0"
    assert not (out / "cloudbench-run.json").exists()


def verify_rejected_start_archive(
    out: Path, row: dict[str, object], owner: str, run_id: str,
    originals: dict[str, bytes],
) -> None:
    """A provider-rejected start preserves the prior pool contents, not a run."""
    receipt = object_file(out / "guest-start-rejected.confirmed")
    machine = row["machine_id"]
    volume = row["volume_id"]
    assert receipt["version"] == 1
    assert receipt["kind"] == "provider-rejected-no-guest-start"
    assert receipt["fleet_owner_token"] == owner and receipt["run_id"] == run_id
    assert receipt["bench"] == row["task"]
    assert receipt["machine_id"] == machine and receipt["volume_id"] == volume
    assert receipt["run_token"] == row["run_token"]
    assert receipt["provider_state"] == "stopped" and receipt["proof_credit"] == 0
    provenance = receipt["capture_provenance"]
    assert provenance["direct_original_volume"] is True
    assert provenance["source_machine_id"] == machine
    assert provenance["source_volume_id"] == volume
    assert provenance["archive_sha256"] == receipt["capture_sha256"]
    assert provenance["proof_credit"] == 0
    assert set(provenance["files"]) == set(originals)
    assert receipt["original_file_sha256"] == {
        name: hashlib.sha256(data).hexdigest() for name, data in sorted(originals.items())
    }
    start = regular_bytes(out / "cloudbench-boot-start.log", 65536)
    assert receipt["start_log_sha256"] == hashlib.sha256(start).hexdigest()
    lines = start.decode().splitlines()
    assert len(lines) == 4
    error = re.compile(
        rf"Error: could not start machine due to lack of capacity\. "
        rf"Try 'flyctl machine clone {re.escape(machine)} -a [A-Za-z0-9._-]+'"
    )
    assert all(error.fullmatch(line) for line in lines)
    child = regular_bytes(out / "fleet-child.log", 1048576).decode()
    assert "provider did not accept the required post-config start" in child
    assert "Original exit code: 125" in child
    assert "post-config start accepted" not in child
    assert originals["cloudbench-driver.state"].strip() == b"exited"
    services = json.loads(originals["repo/.context/cloudbench/services.json"])
    prior = json.loads(originals["repo/.context/cloudbench/run.json"])
    assert services["status"] == "stopped" and prior["run_id"] != run_id
    assert all(owner.encode() not in data and run_id.encode() not in data
               for data in originals.values())
    assert regular_bytes(out / "guest-shutdown.confirmed", 256) == (run_id + "\n").encode()


def verify_clean_stack_status(status: bytes, token: str) -> None:
    pairs = [line.split(b"=", 1) for line in status.splitlines()]
    assert all(len(pair) == 2 for pair in pairs)
    clean = dict(pairs)
    assert len(clean) == len(pairs)
    assert clean[b"version"] == b"1" and clean[b"token"] == token.encode()
    assert clean[b"state"] == b"clean"
    assert int(clean[b"stack_pid"]) > 0 and clean[b"stack_birth"]


def verify_prestart_provider_archive(
    out: Path, row: dict[str, object], provider: dict[str, object],
    original_backend: bytes,
) -> None:
    receipt = object_file(out / "guest-cleanup.recovery-receipt.json")
    state_bytes = regular_bytes(out / "guest-cleanup.state.json", 1048576)
    state = json.loads(state_bytes)
    backend_bytes = regular_bytes(out / "guest-cleanup.backend.log", 64 * 1024 * 1024)
    evidence = provider["evidence"]
    assert backend_bytes == original_backend
    assert provider["kind"] == "provider-prestart-zero-manifest"
    assert provider["root_agent_id"] is None
    assert provider["sessions"] == {"kernel": [], "steel": []}
    assert provider["machine_id"] == row["machine_id"]
    assert provider["guest_run_token"] == row["run_token"]
    assert evidence["backend_log_sha256"] == hashlib.sha256(backend_bytes).hexdigest()
    assert evidence["guest_state_sha256"] == hashlib.sha256(state_bytes).hexdigest()
    assert all(evidence[key] == 0 for key in (
        "allocation_event_count", "browser_session_mutation_count",
        "payment_mutation_count", "root_creation_count"))
    assert state["schema_version"] == "cloudbench-guest-state-v1"
    assert state["machine_id"] == row["machine_id"]
    assert state["guest_run_token"] == row["run_token"]
    assert state["state"] == state["driver_state"] == "exited"
    assert state["driver_pid"] is None and state["driver_descendants"] == []
    assert state["services_status"] == "stopped"
    assert state["live_service_pids"] == [] and state["backend_closed"] is True
    assert state["run_json"]["exists"] is False
    assert receipt["kind"] == "provider-exact-cleanup"
    assert receipt["root_agent_id"] is None and receipt["results"] == []
    assert receipt["manifest_sha256"] == hashlib.sha256(
        json.dumps(provider, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def object_file_from_bytes(data: bytes):
    return json.loads(data)


def verify_normal_primary_capture(
    run: Path, out: Path, row: dict, original: dict, audit: Path,
    provenance: dict, mode: str, worker_ids: set[str], contracts: tuple[dict, dict],
) -> str:
    """Retain normal retirement history only with its original complete capture.

    The status producer's stopped-stack manifest and the ordinary result/source
    validator remain authoritative. This never repairs an absent ACK or gives a
    failed cohort benchmark credit.
    """
    runtime, result = contracts
    assert out.parent == run
    machine, token = row["machine_id"], row["run_token"]
    clone = original["clone_name"]
    assert original["version"] == "1" and original["source"] == "fresh-clone"
    assert re.fullmatch(r"cloudbench-[A-Za-z0-9._-]+", clone)
    assert re.fullmatch(r"[0-9a-f]+", original["source_machine_id"])
    assert fields(audit / "fresh" / clone) == original
    for directory in (audit / "expected-fresh", audit / "by-machine-id"):
        assert directory.is_dir() and directory.resolve(strict=True) == directory
    assert fields(audit / "expected-fresh" / clone) == {
        "clone_name": clone, "source_machine_id": original["source_machine_id"]}
    assert regular_bytes(audit / "by-machine-id" / machine, 256).decode().strip() == clone
    assert regular_bytes(out / ".cid", 256).decode().split() == ["clone", machine]
    assert not (out / "runtime-evidence.pending").exists()
    assert not (out / "runtime-evidence.pending").is_symlink()
    workers = out / "worker-runtime-evidence"
    captured_workers = set()
    if workers.exists() or workers.is_symlink():
        assert workers.is_dir() and workers.resolve(strict=True) == workers
        for directory in workers.iterdir():
            assert directory.is_dir() and directory.resolve(strict=True) == directory
            captured_workers.add(directory.name)
    # The existing worker verifier below still checks each capture and native
    # disposition. No unindexed worker may disappear behind a retired primary.
    assert captured_workers == worker_ids
    capture = out / "remote-logs/runtime-evidence"
    manifest_bytes = regular_bytes(capture / "manifest.json", 1048576)
    manifest = json.loads(manifest_bytes)
    assert manifest == runtime["runtime_evidence_context_manifest"](capture, token, machine)
    info = {"bytes": len(manifest_bytes), "sha256": hashlib.sha256(manifest_bytes).hexdigest()}
    assert row["files"]["normal-primary/manifest.json"] == info
    for name, capture_info in manifest["files"].items():
        assert row["files"]["repo/.context/cloudbench/" + name] == capture_info
    canonical = regular_bytes(out / "cloudbench-run.json", 64 * 1024 * 1024)
    assert canonical == regular_bytes(capture / "run.json", 64 * 1024 * 1024)
    document = json.loads(canonical)
    assert not result["validate_run_document"](
        document, [row["task"]], expected_execution_provenance=provenance,
        expected_world_model_mode=mode)
    assert document["tasks"][0]["benchmark_status"] in ("PASSED", "FAILED")
    return info["sha256"]


def verify(registry: Path, run: Path, manifest_path: Path, archive_path: Path,
           machines_path: Path, volumes_path: Path, *,
           archive_only: bool = False) -> dict[str, object]:
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
    assert len(fresh) >= max(len(clones), len(rows))
    allocated = [row for row in fresh if row.get("volume_id")]
    assert len({row["volume_id"] for row in allocated}) == len(allocated)
    by_machine = {row["machine_id"]: row for row in fresh if row.get("machine_id")}
    assert len(by_machine) == sum(bool(row.get("machine_id")) for row in fresh)
    primary_ids = {row["machine_id"] for row in rows}
    legacy_workers = {row["machine_id"] for row in unstarted_workers + started_workers}
    normal_worker_names = {
        row["clone_name"] for row in fresh
        if row.get("machine_id") and row["machine_id"] not in primary_ids | legacy_workers
    }
    normal_workers = {}
    normal_worker_hashes = []
    if normal_worker_names:
        normal_workers, normal_worker_hashes, _, _, _ = verify_pool_worker_evidence(
            registry, run, meta, audit, tasks, rows, machines_path, volumes_path,
            fresh_names=normal_worker_names,
        )
    assert set(by_machine) == primary_ids | legacy_workers | set(normal_workers)
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
    retired_workers = [row for row in normal_workers.values() if row["disposition"] != "owned"]
    retired_primaries = {
        machine: original for machine, original in by_machine.items()
        if machine in primary_ids and original["disposition"] != "owned"}
    assert len(fresh) == len(clones) + len(unallocated) + len(retired_workers) + len(retired_primaries)
    native_machines = object_file(machines_path, 128 * 1024 * 1024)
    native_volumes = object_file(volumes_path, 128 * 1024 * 1024)
    assert isinstance(native_machines, list) and isinstance(native_volumes, list)
    by_native_machine = {row["id"]: row for row in native_machines}
    by_native_volume = {row["id"]: row for row in native_volumes}
    assert len(by_native_machine) == len(native_machines) and len(by_native_volume) == len(native_volumes)
    terminal_primary_volumes = set()
    primary_hashes = []
    primary_workers = {machine: set() for machine in retired_primaries}
    for machine, original in by_machine.items():
        if original.get("source_machine_id") in primary_workers:
            primary_workers[original["source_machine_id"]].add(machine)
    contracts = None
    if retired_primaries:
        contracts = (runpy.run_path(str(Path(__file__).with_name("cloudbench-status-server.py"))),
                     runpy.run_path(str(Path(__file__).with_name("cloudbench_result.py"))))
        provenance = object_file(run / "execution-provenance.json")
        matrix = object_file(run / "execution-task-matrix.json")
        assert not contracts[1]["_PROVENANCE_MODULE"].validate_task_matrix_binding(provenance, matrix)
        assert matrix["tasks"] == [
            {"name": task["name"], "world_model_mode": "simulate" if task["mode"] == "SIM" else "real"}
            for task in tasks]
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
        assert original["volume_id"] == volume
        if original["disposition"] == "owned":
            assert by_clone[original["clone_name"]] == {
                "name": original["clone_name"], "id": machine, "volume_id": volume}
        else:
            assert original["disposition"] in ("destroyed-verified-absent", "destroyed-provider-retained")
            assert original["clone_name"] not in by_clone and machine not in by_native_machine
            if volume in by_native_volume:
                terminal = by_native_volume[volume]
                assert original["disposition"] == "destroyed-provider-retained"
                assert terminal["state"] in ("pending_destroy", "destroyed")
                assert terminal.get("attached_machine_id") in (None, "")
                terminal_primary_volumes.add(volume)
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
        if machine in retired_primaries:
            assert contracts is not None and row["services_status"] == "stopped"
            primary_hashes.append(verify_normal_primary_capture(
                run, out, row, original, audit, provenance,
                matrix["tasks"][index]["world_model_mode"], primary_workers[machine], contracts))
        files = row["files"]
        missing = row["missing"]
        assert isinstance(files, dict) and isinstance(missing, list)
        assert len(missing) == len(set(missing))
        assert set(files).isdisjoint(missing)
        mandatory = {"bench.log", "repo/.context/cloudbench/services.json",
                     "repo/.context/cloudbench/stack.log",
                     "repo/.context/cloudbench/logs/backend.log",
                     "repo/.context/cloudbench/logs/worker.log"}
        if row["services_status"] is None:
            assert "bench.log" in files and mandatory - {"bench.log"} <= set(missing)
            assert not row["runtime_evidence_complete"]
        else:
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
    normal_rows = manifest.get("normal_workers", [])
    assert isinstance(normal_rows, list)
    assert {row["machine_id"] for row in normal_rows} == set(normal_workers)
    assert len(normal_rows) == len(normal_workers)
    for worker in normal_rows:
        machine = worker["machine_id"]
        original = normal_workers[machine]
        parent = primary_by_machine[original["source_machine_id"]]
        assert worker["primary_machine_id"] == parent["machine_id"]
        assert worker["task"] == parent["task"] and worker["run_token"] == parent["run_token"]
        assert worker["volume_id"] == original["volume_id"] and worker["proof_credit"] == 0
        base = run / parent["task"] / "worker-runtime-evidence" / machine
        capture_manifest = object_file(base / "capture/manifest.json")
        required_capture = {"capture/" + name for name in capture_manifest["files"]}
        assert {"owner.json", "capture/manifest.json"} | required_capture <= set(worker["files"])
        for relative, info in worker["files"].items():
            assert safe_name(relative)
            data = regular_bytes(base / relative, 64 * 1024 * 1024)
            assert info == {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            member = f"_normal_workers/{machine}/{relative}"
            assert member not in expected_members
            expected_members[member] = info
            expected_total += info["bytes"]
    preserved = manifest.get("preserved_files", {})
    assert isinstance(preserved, dict)
    for member, info in preserved.items():
        assert safe_name(member) and member.startswith("_") and member not in expected_members
        assert type(info["bytes"]) is int and 0 <= info["bytes"] <= 512 * 1024 * 1024
        assert re.fullmatch(r"[0-9a-f]{64}", info["sha256"])
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
    phase_originals = {row["task"]: {} for row in rows if row["services_status"] in {None, "failed"}}
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            assert member.isfile() and member.name in expected_members and member.name not in seen
            info = expected_members[member.name]
            assert member.size == info["bytes"]
            stream = archive.extractfile(member)
            assert stream is not None
            digest = hashlib.sha256()
            left = member.size
            task_name, _, relative = member.name.partition("/")
            phase_buffer = None
            if relative and task_name in phase_originals:
                assert member.size <= 64 * 1024 * 1024
                phase_buffer = bytearray()
            while left:
                block = stream.read(min(left, 65536))
                assert block
                digest.update(block)
                left -= len(block)
                if phase_buffer is not None:
                    phase_buffer.extend(block)
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
            if phase_buffer is not None:
                phase_originals[task_name][relative] = bytes(phase_buffer)
            assert digest.hexdigest() == info["sha256"]
            seen.add(member.name)
    assert seen == set(expected_members)
    for row in rows:
        if row["services_status"] is None:
            verify_pre_service_archive(meta, row, phase_originals[row["task"]])
            continue
        if row["services_status"] == "failed":
            verify_failed_stack_provider_archive(
                run / row["task"], row, owner, meta["run_id"], phase_originals[row["task"]])
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
    if not archive_only:
        assert not active_machines.intersection(by_machine)
        assert not active_volumes.intersection(row["volume_id"] for row in allocated) - terminal_primary_volumes
        assert not {row.get("name") for row in machines + volumes}.intersection(unallocated)
    return {"schema": ("cloudbench-forensic-archive-verified-v1" if archive_only
                       else "cloudbench-forensic-retirement-verified-v1"),
            **({"native_release_verified": False} if archive_only else {}),
            "owner": owner, "run_id": meta["run_id"], "tasks": len(rows),
            "incomplete_tasks": incomplete, "unadmitted_clones": len(unadmitted),
            "unstarted_workers": len(unstarted_workers),
            "started_workers": len(started_workers),
            **({"normal_primary_captures": len(retired_primaries),
                "normal_primary_manifest_sha256": sorted(primary_hashes),
                "execution_provenance_sha256": hashlib.sha256(regular_bytes(
                    run / "execution-provenance.json", 1048576)).hexdigest()} if retired_primaries else {}),
            **({"normal_worker_captures": len(normal_workers),
                "normal_worker_manifest_sha256": sorted(normal_worker_hashes)} if normal_workers else {}),
            "unallocated_attempts": len(unallocated),
            "files": len(seen),
            "archive_sha256": manifest["archive_sha256"], "proof_credit": 0}


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("registry", "run", "manifest", "archive", "machines", "volumes"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--archive-only", action="store_true")
    args = parser.parse_args()
    manifest = object_file(args.manifest)
    if args.archive_only:
        assert manifest.get("schema") == "cloudbench-forensic-retirement-v1"
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
                        args.machines, args.volumes, archive_only=args.archive_only)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
