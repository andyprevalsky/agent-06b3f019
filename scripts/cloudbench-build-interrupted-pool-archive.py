#!/usr/bin/env python3
"""Preserve original files of a failed pool or fresh owner without proof credit.

Sealed bundles come from the normal status-plane collector. Unsealed guests
must be captured separately from their exact stopped volumes and supplied as
<machine-id>.tar.gz. This helper never changes ownership or provider state.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import tarfile


def fields(path: Path) -> dict[str, str]:
    pairs = [line.split("=", 1) for line in path.read_text().splitlines()]
    assert all(len(pair) == 2 for pair in pairs)
    result = dict(pairs)
    assert len(result) == len(pairs)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--capture-dir", type=Path, required=True)
    args = parser.parse_args()
    registry = args.registry.resolve()
    owner = registry.name
    assert re.fullmatch(r"[0-9a-f]{32}", owner)
    meta = fields(registry / "meta")
    assert meta["fleet_owner_token"] == owner
    run = Path(meta["runs_root"]) / meta["run_id"]
    assert run.resolve() == run
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    assert (registry / "runtime-evidence-unconfirmed").is_file()
    lifecycle = json.loads((run / "_batch/lifecycle.json").read_text())
    assert lifecycle["status"] == "failed" and lifecycle["controller_exit_code"] != 0
    tasks = json.loads((run / "_batch/benches.json").read_text())
    audit = Path(meta["audit_dir"])
    kinds = {(run / task["name"] / ".cid").read_text().split()[0] for task in tasks}
    assert len(kinds) == 1 and kinds <= {"pool", "clone"}
    fresh = kinds == {"clone"}
    original_fresh = {}
    if fresh:
        for path in (audit / "fresh").iterdir():
            original = fields(path)
            assert original["fleet_owner_token"] == owner and original["run_id"] == meta["run_id"]
            assert original["app"] == meta["app"]
            if original.get("machine_id"):
                assert original["machine_id"] not in original_fresh
                original_fresh[original["machine_id"]] = original
    runtime = runpy.run_path(str(Path(__file__).with_name("cloudbench-status-server.py")))
    read = runtime["read_runtime_metadata"]
    forensic = runpy.run_path(str(Path(__file__).with_name("cloudbench-forensic-retirement.py")))
    destination = run / "_forensic"
    destination.mkdir(mode=0o700, exist_ok=False)
    archive_path = destination / "originals.tar.gz"
    rows = []
    normal_workers = []
    uncompressed = 0
    preserved = {}
    try:
        with tarfile.open(archive_path, "w:gz") as archive:
            for ordinal, task in enumerate(tasks):
                name = task["name"]
                assert re.fullmatch(r"[A-Za-z0-9._-]+", name)
                out = run / name
                kind, machine = (out / ".cid").read_text().split()
                assert kind in kinds and re.fullmatch(r"[0-9a-f]+", machine)
                volume = (original_fresh[machine] if fresh else fields(audit / "pool" / machine))["volume_id"]
                run_token = f"{owner}-{ordinal}"
                entry = {
                    "task": name, "ordinal": ordinal, "run_token": run_token,
                    "machine_id": machine, "volume_id": volume,
                    "proof_credit": 0, "files": {}, "missing": [],
                }

                def add(relative: str, data: bytes) -> None:
                    nonlocal uncompressed
                    assert relative not in entry["files"]
                    entry["files"][relative] = {
                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    info = tarfile.TarInfo(f"{name}/{relative}")
                    info.size = len(data)
                    info.mode = 0o600
                    info.mtime = 0
                    archive.addfile(info, io.BytesIO(data))
                    uncompressed += len(data)

                sealed = out / "remote-logs/runtime-evidence"
                if (sealed / "manifest.json").is_file():
                    entry["kind"] = "sealed"
                    manifest_bytes = read(sealed / "manifest.json", 1048576)
                    manifest = json.loads(manifest_bytes)
                    assert manifest["machine_id"] == machine
                    assert manifest["run_token"] == run_token
                    if fresh:
                        assert manifest == runtime["runtime_evidence_context_manifest"](sealed, run_token, machine)
                    add("normal-primary/manifest.json" if fresh else "sealed/manifest.json", manifest_bytes)
                    for relative, info in sorted(manifest["files"].items()):
                        data = read(sealed / relative, 512 * 1024 * 1024)
                        assert len(data) == info["bytes"]
                        assert hashlib.sha256(data).hexdigest() == info["sha256"]
                        add(("repo/.context/cloudbench/" if fresh else "sealed/") + relative, data)
                    if fresh:
                        add("bench.log", read(out / "remote-logs/cloudbench-driver.log", 512 * 1024 * 1024))
                        entry["missing"].append(f"cloudbench-driver-clean-{run_token}.ack")
                        entry["services_status"] = "stopped"
                else:
                    entry["kind"] = "interrupted"
                    capture = args.capture_dir / f"{machine}.tar.gz"
                    assert capture.is_file() and not capture.is_symlink()
                    with tarfile.open(capture, "r:gz") as original:
                        seen = set()
                        for member in original:
                            assert member.isfile()
                            assert member.name not in seen
                            assert re.fullmatch(r"[A-Za-z0-9._/-]+", member.name)
                            assert ".." not in Path(member.name).parts
                            stream = original.extractfile(member)
                            assert stream is not None
                            add(("" if fresh else "original/") + member.name,
                                stream.read(member.size + 1))
                            assert entry["files"][("" if fresh else "original/") + member.name]["bytes"] == member.size
                            seen.add(member.name)
                    run_json = "repo/.context/cloudbench/run.json"
                    if run_json not in seen:
                        entry["missing"].append(("" if fresh else "original/") + run_json)
                    # An interrupted driver removes its PID file when it
                    # exits, even if stack cleanup subsequently fails. Keep
                    # that absence explicit; the verifier binds it to the
                    # original exited/failed state and exact stop receipt.
                    driver_pid = "cloudbench-driver.pid"
                    if driver_pid not in seen:
                        entry["missing"].append(("" if fresh else "original/") + driver_pid)
                    if (out / "guest-prestack.confirmed").is_file():
                        for relative in (
                            "repo/.context/cloudbench/services.json",
                            "repo/.context/cloudbench/stack.log",
                            "repo/.context/cloudbench/logs/backend.log",
                            "repo/.context/cloudbench/logs/worker.log",
                        ):
                            if relative not in seen:
                                entry["missing"].append("original/" + relative)
                    if fresh:
                        services_name = "repo/.context/cloudbench/services.json"
                        if services_name in seen:
                            with tarfile.open(capture, "r:gz") as original:
                                service_stream = original.extractfile(services_name)
                                assert service_stream is not None
                                services = json.loads(service_stream.read(1048577))
                            entry["services_status"] = services["status"]
                            count = services["env"]["worker_processes"]
                            assert type(count) is int and 1 <= count <= 1024
                            absent_logs = []
                            for number in range(count):
                                relative = "repo/.context/cloudbench/logs/worker" + (f".{number}" if number else "") + ".log"
                                if relative not in seen:
                                    entry["missing"].append(relative)
                                    if number:
                                        absent_logs.append(relative)
                            if absent_logs and "worker-log-absence-original.json" not in seen:
                                add("worker-log-absence-original.json", json.dumps({
                                    "version": 1, "machine_id": machine,
                                    "services_status": entry["services_status"],
                                    "missing": absent_logs,
                                }, sort_keys=True).encode())
                        else:
                            entry["services_status"] = None
                            # Preserve the actual collector sidecars and nested
                            # capture bytes. Never synthesize legacy receipts.
                            wrappers = {
                                "original-native-config.json": read(args.capture_dir / f"{machine}.original-config.private.json", 1048576),
                                "original-capture-provenance.json": read(args.capture_dir / f"{machine}.provenance.json", 1048576),
                                "original-volume-capture.tar.gz": read(capture, 64 * 1024 * 1024),
                            }
                            proof = json.loads(wrappers["original-capture-provenance.json"])
                            assert proof["files"] == entry["files"]
                            entry["missing"] = proof["missing"]
                            originals = dict(wrappers)
                            with tarfile.open(fileobj=io.BytesIO(wrappers["original-volume-capture.tar.gz"]), mode="r:gz") as source:
                                for member in source:
                                    assert member.isfile() and member.name not in originals
                                    assert 0 <= member.size <= 64 * 1024 * 1024
                                    stream = source.extractfile(member)
                                    assert stream is not None
                                    originals[member.name] = stream.read(member.size + 1)
                            forensic["verify_original_volume_provenance"](meta, entry, originals)
                            for relative, data in wrappers.items():
                                add(relative, data)
                            for relative in (services_name, "repo/.context/cloudbench/stack.log",
                                             "repo/.context/cloudbench/logs/backend.log", "repo/.context/cloudbench/logs/worker.log"):
                                assert relative not in seen and relative in entry["missing"]
                        ack = f"cloudbench-driver-clean-{run_token}.ack"
                        if ack not in seen:
                            entry["missing"].append(ack)
                if fresh:
                    entry["runtime_evidence_complete"] = False
                rows.append(entry)
            if fresh:
                primary_ids = {row["machine_id"] for row in rows}
                primary_by_id = {row["machine_id"]: row for row in rows}
                for machine, original in original_fresh.items():
                    if machine in primary_ids:
                        continue
                    parent = primary_by_id[original["source_machine_id"]]
                    base = run / parent["task"] / "worker-runtime-evidence" / machine
                    worker_manifest = json.loads(read(base / "capture/manifest.json", 1048576))
                    worker = {"machine_id": machine, "volume_id": original["volume_id"],
                              "primary_machine_id": parent["machine_id"], "task": parent["task"],
                              "run_token": parent["run_token"], "proof_credit": 0, "files": {}}
                    for relative in ("owner.json", "capture/manifest.json", *("capture/" + name for name in worker_manifest["files"])):
                        data = read(base / relative, 512 * 1024 * 1024)
                        worker["files"][relative] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                        info = tarfile.TarInfo(f"_normal_workers/{machine}/{relative}")
                        info.size, info.mode, info.mtime = len(data), 0o600, 0
                        archive.addfile(info, io.BytesIO(data))
                        uncompressed += len(data)
                    normal_workers.append(worker)
                for name in ("execution-provenance.json", "execution-task-matrix.json"):
                    data = read(run / name, 1048576)
                    member = "_" + name
                    preserved[member] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    info = tarfile.TarInfo(member)
                    info.size, info.mode, info.mtime = len(data), 0o600, 0
                    archive.addfile(info, io.BytesIO(data))
                    uncompressed += len(data)
        os.chmod(archive_path, 0o600)
        with archive_path.open("rb") as original:
            os.fsync(original.fileno())
        archive_bytes = archive_path.stat().st_size
        assert archive_bytes <= 512 * 1024 * 1024
        manifest = {
            "schema": "cloudbench-forensic-retirement-v1" if fresh else "cloudbench-interrupted-pool-evidence-v1",
            "owner": owner, "run_id": meta["run_id"], "proof_credit": 0,
            "archive_bytes": archive_bytes,
            "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            "tasks": rows,
            **({"uncompressed_bytes": uncompressed, "normal_workers": normal_workers,
                "preserved_files": preserved} if fresh else {}),
        }
        with (destination / "manifest.json").open("x") as output:
            json.dump(manifest, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        print(json.dumps({"run_id": meta["run_id"], "tasks": len(rows),
                          "incomplete": sum(x["kind"] == "interrupted" for x in rows),
                          "archive_bytes": archive_bytes, "proof_credit": 0}))
    except BaseException:
        # Keep any partial archive for diagnosis; never publish a manifest that
        # could authorize release of the ownership latch.
        raise


if __name__ == "__main__":
    main()
