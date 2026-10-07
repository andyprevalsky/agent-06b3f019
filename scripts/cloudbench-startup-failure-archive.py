#!/usr/bin/env python3
"""Preserve a rejected startup's original terminal files for exact cleanup only."""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import stat
import tarfile
import tempfile

MAXIMUM = 512 * 1024 * 1024
SCHEMA = "cloudbench-startup-failure-archive-v1"


def read(path, maximum=MAXIMUM):
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError("unsafe original evidence path")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ValueError("unsafe original evidence file")
        data = source.read(before.st_size + 1)
        after = path.stat()
        if len(data) != before.st_size or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("original evidence changed during capture")
        os.fsync(source.fileno())
        return data


def fields(path):
    pairs = [line.split("=", 1) for line in read(path, 65536).decode().splitlines()]
    if any(len(pair) != 2 for pair in pairs) or len(dict(pairs)) != len(pairs):
        raise ValueError("unsafe exact ownership fields")
    return dict(pairs)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(registry, output, machine, token):
    registry, output = Path(registry), Path(output)
    owner = registry.name
    if not re.fullmatch(r"[0-9a-f]{32}", owner) or not re.fullmatch(r"[0-9a-f]{14}", machine):
        raise ValueError("unsafe startup archive identity")
    meta = fields(registry / "meta")
    run = Path(meta["runs_root"]) / meta["run_id"]
    tasks = json.loads(read(run / "_batch/benches.json", 1048576))
    ordinal = next(i for i, row in enumerate(tasks) if row["name"] == output.name)
    if (meta["fleet_owner_token"] != owner or run.resolve() != run or output != run / output.name
        or token != f"{owner}-{ordinal}" or meta["cleanup_policy"] != "reap"):
        raise ValueError("startup archive is not the exact original output")
    lifecycle = json.loads(read(run / "_batch/lifecycle.json", 1048576))
    if lifecycle["status"] != "failed" or not lifecycle["controller_exit_code"]:
        raise ValueError("startup archive requires an originally failed controller")
    for name in ("post-config-start.accepted", "cloudbench-run.json", "worker-runtime-evidence"):
        if (output / name).exists() or (output / name).is_symlink():
            raise ValueError("accepted execution cannot use rejected startup cleanup")
    if read(output / "benchmark-child.finished", 32).strip() != b"125":
        raise ValueError("startup archive requires the original startup rejection")
    expected = {"version": 1, "machine_id": machine, "run_token": token}
    if json.loads(read(output / "runtime-evidence.owner.json", 1048576)) != expected or json.loads(read(output / "runtime-evidence.pending", 1048576)) != expected:
        raise ValueError("startup archive lost original runtime ownership")
    if read(output / ".cid", 256).decode().split() != ["clone", machine]:
        raise ValueError("startup archive requires an exact fresh original")
    if ((registry / "guest-cleanup-unconfirmed").exists() or (registry / "guest-cleanup-unconfirmed").is_symlink()
        or read(output / "guest-shutdown.confirmed", 256).decode().strip() != meta["run_id"]):
        raise ValueError("startup archive has unconfirmed guest cleanup")
    audit = Path(meta["audit_dir"])
    audit_meta = fields(audit / "meta")
    if any(audit_meta[key] != meta[key] for key in ("app", "run_id", "fleet_owner_token")):
        raise ValueError("startup archive audit differs from the original owner")
    originals = [fields(p) for p in (audit / "fresh").iterdir()]
    matches = [row for row in originals if row.get("machine_id") == machine]
    if len(matches) != 1:
        raise ValueError("startup archive has ambiguous original allocation")
    original = matches[0]
    if any(original[key] != meta[key] for key in ("app", "run_id", "fleet_owner_token")) or original["disposition"] != "owned":
        raise ValueError("startup archive is not the currently retained allocation")
    clone = fields(registry / "clones" / original["clone_name"])
    if clone != {"name": original["clone_name"], "id": machine, "volume_id": original["volume_id"]}:
        raise ValueError("startup archive clone differs from the exact original")
    if any(row.get("source_machine_id") == machine and row.get("machine_id") for row in originals):
        raise ValueError("startup archive cannot omit an allocated worker")
    return meta, original


def original_files(root, token):
    root = Path(root)
    context = root / "repo/.context/cloudbench"
    names = {"bench.log", "cloudbench-driver.state", "cloudbench-driver.pid",
             f"cloudbench-driver-clean-{token}.ack", f"cloudbench-shutdown-{token}.request",
             "repo/.context/cloudbench/services.json", "repo/.context/cloudbench/stack.log",
             "repo/.context/cloudbench/run.json", "repo/.context/cloudbench/logs/backend.log",
             "repo/.context/cloudbench/logs/worker.log",
             f"repo/.context/cloudbench/cloudbench-stack-cleanup-{token}.status"}
    if (context / "logs").exists():
        for path in (context / "logs").iterdir():
            if path.name.endswith(".log"):
                if not re.fullmatch(r"[A-Za-z0-9._-]+\.log", path.name):
                    raise ValueError("unsafe original log name")
                names.add(str(path.relative_to(root)))
    files, missing = {}, []
    for name in sorted(names):
        if any(parent.is_symlink() for parent in (root / name).parents if parent.is_relative_to(root)):
            raise ValueError("original evidence has a symlinked parent")
        try:
            files[name] = read(root / name)
        except FileNotFoundError:
            if (root / name).is_symlink():
                raise ValueError("missing original is a symlink") from None
            missing.append(name)
    if sum(map(len, files.values())) > MAXIMUM:
        raise ValueError("startup original archive exceeds existing evidence ceiling")
    return files, missing


def terminal_files(files, missing, token):
    if (files.get("cloudbench-driver.state") != b"exited\n"
        or files.get(f"cloudbench-driver-clean-{token}.ack") != (token + "\n").encode()
        or files.get("bench.log", b"").splitlines()[:1] != [("RUNSTAMP-" + token).encode()]
        or "cloudbench-driver.pid" not in missing):
        raise ValueError("startup originals lack exact exited cleanup acknowledgement")
    services = "repo/.context/cloudbench/services.json"
    if services not in files:
        return "pre-service"
    data = json.loads(files[services])
    count = data["env"]["worker_processes"]
    if data["status"] != "stopped" or type(count) is not int or not 1 <= count <= 1024:
        raise ValueError("startup stack is not completely stopped")
    expected = {"repo/.context/cloudbench/stack.log", "repo/.context/cloudbench/logs/backend.log",
                *(f"repo/.context/cloudbench/logs/worker{'.' + str(i) if i else ''}.log" for i in range(count))}
    actual = {name for name in files if re.fullmatch(r"repo/.context/cloudbench/logs/worker(?:\.[1-9][0-9]*)?\.log", name)}
    if not expected <= files.keys() or actual != {name for name in expected if "/worker" in name}:
        raise ValueError("startup archive lacks full configured worker inventory")
    cleanup = fields_bytes(files[f"repo/.context/cloudbench/cloudbench-stack-cleanup-{token}.status"])
    if cleanup.get("state") != "clean" or cleanup.get("token") != token:
        raise ValueError("startup stack cleanup is not exact")
    return "stopped-stack"


def fields_bytes(data):
    pairs = [line.split("=", 1) for line in data.decode().splitlines()]
    if any(len(pair) != 2 for pair in pairs) or len(dict(pairs)) != len(pairs):
        raise ValueError("unsafe original cleanup receipt")
    return dict(pairs)


def capture(root, machine, token, destination):
    if os.environ.get("FLY_MACHINE_ID") != machine or os.environ.get("CLOUDBENCH_RUN_TOKEN") != token:
        raise ValueError("capture is not running on the exact original guest")
    files, missing = original_files(root, token)
    phase = terminal_files(files, missing, token)
    guest = runpy.run_path(str(Path(__file__).with_name("cloudbench-guest-recovery.py")))
    args = argparse.Namespace(machine_id=machine, guest_run_token=token,
        run_json=str(Path(root) / "repo/.context/cloudbench/run.json"),
        backend_log=str(Path(root) / "repo/.context/cloudbench/logs/backend.log"))
    state = guest["state_snapshot"](args, Path(root), Path(root) / "repo")
    if state["state"] != "exited" or state["driver_pid"] is not None or state["driver_descendants"]:
        raise ValueError("original startup guest is not quiescent")
    if phase == "stopped-stack":
        services, _ = guest["parse_services"](Path(root) / "repo/.context/cloudbench/services.json", Path(root) / "repo")
        pids = guest["service_pids"](services)
        state.update(services_status=services["status"], stopped_service_pids=pids,
            live_service_pids=[pid for pid in pids if guest["process_state"](pid) is not None],
            backend_port=guest["backend_port"](services), backend_closed=guest["backend_is_closed"](guest["backend_port"](services)))
        if state["live_service_pids"] or not state["backend_closed"]:
            raise ValueError("original startup stack remains live")
    state_bytes = json.dumps(state, sort_keys=True).encode()
    destination = Path(destination)
    with destination.open("xb") as output:
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size, member.mode = len(data), 0o600
                archive.addfile(member, io.BytesIO(data))
            member = tarfile.TarInfo("capture-guest-state.json")
            member.size, member.mode = len(state_bytes), 0o600
            archive.addfile(member, io.BytesIO(state_bytes))
            manifest = json.dumps({"schema": SCHEMA, "machine_id": machine, "run_token": token,
                "proof_credit": 0, "missing": missing,
                "files": {name: {"bytes": len(data), "sha256": digest(data)} for name, data in {**files, "capture-guest-state.json": state_bytes}.items()}}, sort_keys=True).encode()
            member = tarfile.TarInfo("capture-manifest.json")
            member.size, member.mode = len(manifest), 0o600
            archive.addfile(member, io.BytesIO(manifest))
        output.flush()
        os.fsync(output.fileno())
    if original_files(root, token) != (files, missing):
        raise ValueError("original inventory changed after capture")


def verify(registry, output, machine, token, archive_path, config_path, after_config_path):
    meta, original = identity(registry, output, machine, token)
    raw, config_bytes = read(archive_path), read(config_path, 1048576)
    if read(after_config_path, 1048576) != config_bytes:
        raise ValueError("original native config changed across capture")
    config = json.loads(config_bytes)
    source = runpy.run_path(str(Path(__file__).with_name("cloudbench-prestack-recovery.py")))
    source_ref, recipe_sha256, source_fingerprint = source["native_recipe"](meta, config)
    run = Path(meta["runs_root"]) / meta["run_id"]
    provenance = json.loads(read(run / "execution-provenance.json", 1048576))
    if provenance["base_sha"] != source_ref or provenance.get("workspace_patch_sha256") != "none":
        raise ValueError("startup archive differs from original immutable execution provenance")
    if (config["env"]["CLOUDBENCH_RUN_TOKEN"] != token or config["env"]["CLOUDBENCH_FRESH_VOLUME"] != "1"
        or config["env"]["BENCH_TASKS_B64"] != base64.b64encode(Path(output).name.encode()).decode()
        or config["init"]["cmd"] != ["bash", "/cloudbench-boot.sh"]
        or len(config["mounts"]) != 1 or config["mounts"][0]["volume"] != original["volume_id"]
        or config["mounts"][0]["path"] != "/data"):
        raise ValueError("startup capture native config is not the exact original")
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            path = Path(member.name)
            total += member.size
            if not member.isfile() or member.name in files or path.is_absolute() or path.as_posix() != member.name or ".." in path.parts or member.size > MAXIMUM or total > MAXIMUM:
                raise ValueError("unsafe startup original archive member")
            stream = archive.extractfile(member)
            data = stream.read(member.size + 1)
            if len(data) != member.size:
                raise ValueError("truncated startup original archive")
            files[member.name] = data
    manifest = json.loads(files.pop("capture-manifest.json"))
    if (manifest["schema"] != SCHEMA or manifest["machine_id"] != machine or manifest["run_token"] != token
        or manifest["proof_credit"] != 0 or manifest["files"] != {name: {"bytes": len(data), "sha256": digest(data)} for name, data in files.items()}
        or set(files) & set(manifest["missing"])):
        raise ValueError("startup original archive manifest differs")
    phase = terminal_files(files, manifest["missing"], token)
    if phase == "pre-service":
        forensic = runpy.run_path(str(Path(__file__).with_name("cloudbench-forensic-retirement.py")))
        capture_manifest = {**manifest, "source_machine_id": machine, "source_volume_id": original["volume_id"],
                            "archive_bytes": len(raw), "archive_sha256": digest(raw)}
        # Reuse the established source-bound absence verifier. The original
        # native config is read unchanged before and after this capture by CLI.
        originals = {**files, "capture-manifest.json": json.dumps(manifest, sort_keys=True).encode()}
        capture_manifest["files"] = {name: {"bytes": len(data), "sha256": digest(data)} for name, data in originals.items()}
        originals.update({"original-native-config.json": config_bytes, "original-volume-capture.tar.gz": raw,
            "original-capture-manifest.json": json.dumps(capture_manifest).encode(),
            "original-capture-receipt.json": json.dumps({"machine_id": machine, "volume_id": original["volume_id"],
                "owner": meta["fleet_owner_token"], "proof_credit": 0, "capture_complete": True,
                "capture_mode": "authenticated-terminal-read", "original_config_unchanged": True,
                "before_config_sha256": digest(config_bytes), "after_config_sha256": digest(config_bytes),
                "original_config_sha256": digest(config_bytes),
                "archive_bytes": len(raw), "archive_sha256": digest(raw)}).encode()})
        row = {"run_token": token, "machine_id": machine, "volume_id": original["volume_id"],
               "task": Path(output).name, "services_status": None, "runtime_evidence_complete": False,
               "missing": manifest["missing"]}
        forensic["verify_pre_service_archive"](meta, row, originals, config_preserved=True)
    else:
        if "repo/.context/cloudbench/run.json" in files or "repo/.context/cloudbench/run.json" not in manifest["missing"]:
            raise ValueError("prestart provider absence conflicts with captured run record")
        forensic = runpy.run_path(str(Path(__file__).with_name("cloudbench-forensic-retirement.py")))
        forensic["verify_clean_stack_status"](files[f"repo/.context/cloudbench/cloudbench-stack-cleanup-{token}.status"], token)
        cleanup = runpy.run_path(str(Path(__file__).with_name("cloudbench-exact-session-cleanup.py")))
        with tempfile.TemporaryDirectory(prefix="cloudbench-startup-verify-") as temporary:
            backend, state = Path(temporary) / "backend.log", Path(temporary) / "state.json"
            backend.write_bytes(files["repo/.context/cloudbench/logs/backend.log"])
            state.write_bytes(files["capture-guest-state.json"])
            args = argparse.Namespace(owner=meta["fleet_owner_token"], fleet_run_id=meta["run_id"],
                bench=Path(output).name, machine_id=machine, guest_run_token=token,
                output_dir=str(output), backend_log=str(backend), state_receipt=str(state))
            provider = cleanup["active_provider_manifest"](args)
            if provider["kind"] != "provider-prestart-zero-manifest":
                raise ValueError("startup capture cannot omit executed provider ownership")
    for directory in {Path(archive_path).parent, Path(config_path).parent, Path(after_config_path).parent, Path(output)}:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return {"schema": SCHEMA, "owner": meta["fleet_owner_token"], "run_id": meta["run_id"],
            "bench": Path(output).name, "machine_id": machine, "volume_id": original["volume_id"],
            "run_token": token, "phase": phase, "archive_sha256": digest(raw),
            "config_sha256": digest(config_bytes), "archive_path": str(archive_path),
            "config_path": str(config_path), "proof_credit": 0, "execution_rejected": True,
            "source_ref": source_ref, "recipe_sha256": recipe_sha256,
            "source_fingerprint": source_fingerprint, "native_release_verified": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("eligible", "capture", "verify"))
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--machine", required=True)
    parser.add_argument("--run-token", required=True)
    parser.add_argument("--root", type=Path, default=Path("/data"))
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--config-after", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "capture":
        capture(args.root, args.machine, args.run_token, args.archive)
    elif args.action == "eligible":
        identity(args.registry, args.output, args.machine, args.run_token)
    else:
        result = verify(args.registry, args.output, args.machine, args.run_token, args.archive, args.config, args.config_after)
        if args.receipt:
            if args.receipt.exists() or args.receipt.is_symlink():
                raise ValueError("existing startup capture receipt is immutable")
            cleanup = runpy.run_path(str(Path(__file__).with_name("cloudbench-exact-session-cleanup.py")))
            cleanup["atomic_json"](args.receipt, result)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
