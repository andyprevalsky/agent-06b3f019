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
PRECONFIG_SCHEMA = "cloudbench-preconfig-rejection-archive-v1"


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


def identity(registry, output, machine, token, *, preconfig=False):
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
    lifecycle = json.loads(read(run / ("_batch/run.json" if preconfig else "_batch/lifecycle.json"), 1048576))
    if (lifecycle["status"] != "failed" or type(lifecycle["controller_exit_code"]) is not int
            or not lifecycle["controller_exit_code"]):
        raise ValueError("startup archive requires an originally failed controller")
    if preconfig:
        read(registry / "runtime-evidence-unconfirmed", 65536)
        if meta.get("version") != "2" or lifecycle.get("run_id") != meta["run_id"] or read(output / "boot-config-unapplied", 256).strip() != machine.encode():
            raise ValueError("pre-config rejection is not the exact original Machine")
        for name in ("status-proxy.port", "cloudbench-boot-start.log", "guest-shutdown.confirmed"):
            if (output / name).exists() or (output / name).is_symlink():
                raise ValueError("pre-config rejection conflicts with guest admission evidence")
        if read(output / "worker-clones.ids", 65536):
            raise ValueError("pre-config rejection has allocated workers")
        if (run / "_batch/lifecycle.json").exists() or (run / "_batch/lifecycle.json").is_symlink():
            previous = json.loads(read(run / "_batch/lifecycle.json", 1048576))
            if previous.get("status") != "failed" or previous.get("controller_exit_code") != lifecycle["controller_exit_code"]:
                raise ValueError("pre-config rejection conflicts with original lifecycle")
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
        or (not preconfig and read(output / "guest-shutdown.confirmed", 256).decode().strip() != meta["run_id"])):
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


def preconfig_identity(registry, output, machine, token):
    return identity(registry, output, machine, token, preconfig=True)


def preconfig_files(registry, output, machine, token):
    """Read exact controller originals; no guest result or ACK is synthesized."""
    meta, original = preconfig_identity(registry, output, machine, token)
    registry, output, audit = Path(registry), Path(output), Path(meta["audit_dir"])
    if read(output / "boot-config-unapplied", 256).strip() != machine.encode():
        raise ValueError("missing original pre-config rejection")
    run = output.parent
    paths = {"capture-helper.py": Path(__file__).resolve(), "registry/meta": registry / "meta", "audit/meta": audit / "meta",
             "registry/runtime-evidence-unconfirmed": registry / "runtime-evidence-unconfirmed",
             "registry/clone": registry / "clones" / original["clone_name"],
             "audit/fresh": audit / "fresh" / original["clone_name"]}
    for path in (audit / "fresh").iterdir():
        paths["audit/fresh-records/" + path.name] = path
    for label, directory in (("output", output), ("batch", run / "_batch")):
        for parent, directories, names in os.walk(directory, followlinks=False):
            parent = Path(parent)
            if parent == output:
                directories[:] = [name for name in directories if name != "failed-preconfig-runtime-archive"]
            for name in directories:
                if (parent / name).is_symlink():
                    raise ValueError("pre-config originals contain a linked directory")
            for name in names:
                paths[label + "/" + str((parent / name).relative_to(directory))] = parent / name
    for label, directory in (("registry", registry), ("audit", audit)):
        path = directory / "source-manifest.json"
        if path.exists() or path.is_symlink():
            paths[label + "/source-manifest.json"] = path
    provenance = run / "execution-provenance.json"
    paths["run/execution-provenance.json"] = provenance
    if (run / "execution-task-matrix.json").exists():
        paths["run/execution-task-matrix.json"] = run / "execution-task-matrix.json"
    if len(paths) > 1030:
        raise ValueError("pre-config originals exceed existing evidence file ceiling")
    uid = (registry / "meta").stat().st_uid
    files, remaining = {}, MAXIMUM
    for name, path in paths.items():
        info = path.lstat()
        if info.st_uid != uid or info.st_nlink != 1:
            raise ValueError("pre-config original owner or link count changed")
        if info.st_size > remaining:
            raise ValueError("pre-config originals exceed remaining aggregate evidence ceiling")
        files[name] = read(path, remaining)
        remaining -= len(files[name])
        after = path.lstat()
        if any(getattr(info, key) != getattr(after, key) for key in
               ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns")):
            raise ValueError("pre-config original identity changed during read")
    if sum(map(len, files.values())) > MAXIMUM:
        raise ValueError("pre-config originals exceed existing evidence ceiling")
    if any(type(json.loads(files["output/" + name]).get("version")) is not int
           for name in ("runtime-evidence.owner.json", "runtime-evidence.pending")):
        raise ValueError("pre-config original runtime ownership is not typed")
    source = json.loads(files["run/execution-provenance.json"])
    batch = json.loads(files["batch/run.json"])
    if (not re.fullmatch(r"[0-9a-f]{40}", str(source.get("base_sha", "")))
            or source.get("workspace_patch_sha256") != "none"
            or batch.get("execution_provenance") != source):
        raise ValueError("pre-config originals have inconsistent original provenance")
    return meta, original, files


def capture_preconfig(registry, output, machine, token, destination):
    _, _, files = preconfig_files(registry, output, machine, token)
    manifest = {"schema": PRECONFIG_SCHEMA, "machine_id": machine, "run_token": token,
                "proof_credit": 0, "files": {name: {"bytes": len(data), "sha256": digest(data)}
                                             for name, data in files.items()}}
    destination = Path(destination)
    parent = destination.parent.stat()
    if destination.parent.resolve(strict=True) != destination.parent or parent.st_mode & 0o077:
        raise ValueError("pre-config archive parent is not private")
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as stream:
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for name, data in {**files, "capture-manifest.json": json.dumps(manifest, sort_keys=True).encode()}.items():
                member = tarfile.TarInfo(name)
                member.size, member.mode = len(data), 0o600
                archive.addfile(member, io.BytesIO(data))
        stream.flush()
        os.fsync(stream.fileno())
    if preconfig_files(registry, output, machine, token)[2] != files:
        raise ValueError("pre-config originals changed during capture")


def read_preconfig_archive(archive_path):
    raw = read(archive_path)
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            total += member.size
            name = Path(member.name)
            if (not member.isfile() or member.name in files or member.size < 0
                    or name.is_absolute() or ".." in name.parts or name.as_posix() != member.name
                    or total > MAXIMUM or len(files) > 1030):
                raise ValueError("unsafe pre-config archive member")
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size:
                raise ValueError("truncated pre-config original")
            files[member.name] = data
    manifest = json.loads(files.pop("capture-manifest.json"))
    if type(manifest.get("proof_credit")) is not int or manifest != {"schema": PRECONFIG_SCHEMA, "machine_id": manifest.get("machine_id"),
            "run_token": manifest.get("run_token"), "proof_credit": 0,
            "files": {name: {"bytes": len(data), "sha256": digest(data)} for name, data in files.items()}}:
        raise ValueError("pre-config archive manifest differs from original bytes")
    return raw, files, manifest


def preconfig_native_proof(machine, original, native_before, native_after):
    if native_before is None or native_after is None:
        raise ValueError("pre-config native proof requires both original reads")
    if Path(native_before).samefile(native_after):
        raise ValueError("pre-config native proof reused the same read file")
    before, after = read(native_before, 1048576), read(native_after, 1048576)
    first, last = json.loads(before), json.loads(after)
    if not isinstance(first, dict) or not isinstance(last, dict):
        raise ValueError("invalid native pre-config Machine record")
    config = first.get("config")
    if (first != last or first.get("id") != machine or first.get("name") != original["clone_name"]
            or first.get("state") not in {"started", "stopped"}
            or not isinstance(first.get("instance_id"), str) or not first["instance_id"]
            or not isinstance(config, dict) or config.get("init") != {"cmd": ["sleep", "infinity"]}
            or config.get("env") not in (None, {}) or config.get("restart") != {"policy": "no"}
            or (config.get("auto_destroy") is not None and config.get("auto_destroy") is not False)
            or any(config.get(key) for key in ("containers", "processes", "standbys", "schedule"))
            or not re.fullmatch(r".+@sha256:[0-9a-f]{64}", str(config.get("image", "")))
            or not isinstance(config.get("mounts"), list) or len(config["mounts"]) != 1
            or not isinstance(config["mounts"][0], dict)
            or config["mounts"][0].get("volume") != original["volume_id"]
            or config["mounts"][0].get("path") != "/data"
            or not isinstance(config.get("files", []), list)
            or any(not isinstance(row, dict) or row.get("guest_path") != "/cloudbench-status-server.py"
                   for row in config.get("files", []))):
        raise ValueError("native pre-config Machine is not unchanged original inert allocation")
    return {"native_before_sha256": digest(before), "native_after_sha256": digest(after),
            "native_before_path": str(native_before), "native_after_path": str(native_after),
            "instance_id": first["instance_id"],
            "config_sha256": digest(json.dumps(config, sort_keys=True, separators=(",", ":")).encode())}


def verify_preconfig(registry, output, machine, token, archive_path, native_before=None, native_after=None):
    meta, original, expected = preconfig_files(registry, output, machine, token)
    raw, files, manifest = read_preconfig_archive(archive_path)
    if files != expected or manifest["machine_id"] != machine or manifest["run_token"] != token:
        raise ValueError("pre-config original archive differs from source")
    proof = None
    if native_before is not None or native_after is not None:
        proof = preconfig_native_proof(machine, original, native_before, native_after)
    native_verified = proof is not None
    descriptor = os.open(Path(archive_path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if preconfig_files(registry, output, machine, token)[2] != expected:
        raise ValueError("pre-config originals changed during verification")
    return {"schema": PRECONFIG_SCHEMA, "phase": "pre-config", "owner": meta["fleet_owner_token"],
            "run_id": meta["run_id"], "bench": Path(output).name, "machine_id": machine,
            "volume_id": original["volume_id"], "run_token": token, "proof_credit": 0,
            "archive_path": str(archive_path), "archive_sha256": digest(raw), "archive_bytes": len(raw),
            "original_file_count": len(expected), "original_bytes": sum(map(len, expected.values())),
            "source_ref": json.loads(expected["run/execution-provenance.json"])["base_sha"],
            "native_inert_verified": native_verified, **(proof or {}),
            "helper_sha256": digest(expected["capture-helper.py"]),
            "evidence_only": not native_verified, "no_guest_admission_verified": native_verified,
            "preconfig_evidence_verified": native_verified,
            "fresh_native_required_for_mutation": True,
            "native_release_verified": False, "runtime_evidence_complete": False}


def archived_preconfig_identity(files, registry, output, machine, token):
    """Validate initial originals without requiring consumed live ownership files."""
    meta, original = fields_bytes(files["registry/meta"]), fields_bytes(files["audit/fresh"])
    tasks = json.loads(files["batch/benches.json"])
    names = [row["name"] for row in tasks]
    owner = Path(registry).name
    expected = {"version": 1, "machine_id": machine, "run_token": token}
    batch, source = json.loads(files["batch/run.json"]), json.loads(files["run/execution-provenance.json"])
    if (not re.fullmatch(r"[0-9a-f]{32}", owner) or meta.get("version") != "2"
            or len(files["registry/runtime-evidence-unconfirmed"]) > 65536
            or meta.get("fleet_owner_token") != owner or meta.get("cleanup_policy") != "reap"
            or len(set(names)) != len(names) or Path(output).name not in names
            or Path(output) != Path(meta["runs_root"]) / meta["run_id"] / Path(output).name
            or token != f"{owner}-{names.index(Path(output).name)}"
            or batch.get("run_id") != meta["run_id"] or batch.get("status") != "failed"
            or type(batch.get("controller_exit_code")) is not int or not batch["controller_exit_code"]
            or files["output/benchmark-child.finished"].strip() != b"125"
            or files["output/boot-config-unapplied"].strip() != machine.encode()
            or files["output/.cid"].decode().split() != ["clone", machine]
            or files["output/worker-clones.ids"]
            or files["output/runtime-evidence.owner.json"] != files["output/runtime-evidence.pending"]
            or json.loads(files["output/runtime-evidence.owner.json"]) != expected
            or type(json.loads(files["output/runtime-evidence.owner.json"])["version"]) is not int
            or batch.get("execution_provenance") != source
            or not re.fullmatch(r"[0-9a-f]{40}", str(source.get("base_sha", "")))
            or source.get("workspace_patch_sha256") != "none"):
        raise ValueError("archived pre-config admission is not exact original failed ownership")
    forbidden = ("output/status-proxy.port", "output/cloudbench-boot-start.log", "output/post-config-start.accepted",
                 "output/cloudbench-run.json", "output/guest-shutdown.confirmed", "output/worker-runtime-evidence")
    if any(key == name or key.startswith(name + "/") for name in forbidden for key in files):
        raise ValueError("archived pre-config originals include admitted guest evidence")
    audit = fields_bytes(files["audit/meta"])
    clone = fields_bytes(files["registry/clone"])
    records = [fields_bytes(data) for name, data in files.items() if name.startswith("audit/fresh-records/")]
    if (any(audit.get(key) != meta[key] or original.get(key) != meta[key]
            for key in ("app", "run_id", "fleet_owner_token"))
            or original.get("disposition") != "owned" or original.get("machine_id") != machine
            or clone != {"name": original["clone_name"], "id": machine, "volume_id": original["volume_id"]}
            or sum(row == original for row in records) != 1
            or any(row.get("source_machine_id") == machine and row.get("machine_id") for row in records)):
        raise ValueError("archived pre-config allocation is foreign or has workers")
    return meta, original, source


def commit_preconfig(registry, output, machine, token, archive_path, native_before, native_after, receipt_path):
    """Fsync proof BEFORE the fleet consumer may change pending or its ledger."""
    receipt_path = Path(receipt_path)
    if (receipt_path.parent != Path(output) / "failed-preconfig-runtime-archive"
            or receipt_path.parent.resolve(strict=True) != receipt_path.parent
            or receipt_path.parent.stat().st_uid != Path(output).stat().st_uid
            or receipt_path.parent.stat().st_mode & 0o077):
        raise ValueError("pre-config consumption receipt has no private exact output binding")
    if receipt_path.exists() or receipt_path.is_symlink():
        return verify_preconfig_receipt(registry, output, machine, token, receipt_path, native_before, native_after)
    proof = verify_preconfig(registry, output, machine, token, archive_path, native_before, native_after)
    if proof["preconfig_evidence_verified"] is not True:
        raise ValueError("evidence-only archive cannot authorize phase consumption")
    proof["consumption_ready"] = True
    with os.fdopen(os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as stream:
        stream.write(json.dumps(proof, sort_keys=True).encode() + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(receipt_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return proof


def verify_preconfig_receipt(registry, output, machine, token, receipt_path, native_before=None, native_after=None):
    """Historical phase evidence only; every native mutation still needs fresh guards."""
    receipt_path = Path(receipt_path)
    if receipt_path.parent != Path(output) / "failed-preconfig-runtime-archive":
        raise ValueError("pre-config consumption receipt is outside exact output")
    proof = json.loads(read(receipt_path, 1048576))
    if (proof.get("schema") != PRECONFIG_SCHEMA or proof.get("phase") != "pre-config"
            or proof.get("consumption_ready") is not True or proof.get("preconfig_evidence_verified") is not True
            or proof.get("native_inert_verified") is not True or proof.get("no_guest_admission_verified") is not True
            or proof.get("evidence_only") is not False or proof.get("native_release_verified") is not False
            or proof.get("runtime_evidence_complete") is not False
            or proof.get("fresh_native_required_for_mutation") is not True
            or type(proof.get("proof_credit")) is not int or proof["proof_credit"] != 0):
        raise ValueError("pre-config consumption receipt is not exact verified zero-credit evidence")
    raw, files, manifest = read_preconfig_archive(proof["archive_path"])
    meta, original, source = archived_preconfig_identity(files, registry, output, machine, token)
    native = preconfig_native_proof(machine, original, proof["native_before_path"], proof["native_after_path"])
    expected = {"owner": meta["fleet_owner_token"], "run_id": meta["run_id"], "bench": Path(output).name,
                "machine_id": machine, "volume_id": original["volume_id"], "run_token": token,
                "archive_sha256": digest(raw), "archive_bytes": len(raw), "source_ref": source["base_sha"],
                "helper_sha256": digest(files["capture-helper.py"]), "original_file_count": len(files),
                "original_bytes": sum(map(len, files.values())), **native}
    if (manifest["machine_id"] != machine or manifest["run_token"] != token
            or any(proof.get(key) != value for key, value in expected.items())):
        raise ValueError("pre-config receipt differs from original archive or native proof")
    if native_before is not None or native_after is not None:
        current = preconfig_native_proof(machine, original, native_before, native_after)
        if any(current[key] != proof[key] for key in ("instance_id", "config_sha256")):
            raise ValueError("current pre-config native identity changed after phase commitment")
    return proof


def original_names(token):
    """Fixed original guest files; logs/*.log are enumerated in addition."""
    return {"bench.log", "cloudbench-driver.state", "cloudbench-driver.pid",
            f"cloudbench-driver-clean-{token}.ack", f"cloudbench-shutdown-{token}.request",
            "repo/.context/cloudbench/services.json", "repo/.context/cloudbench/stack.log",
            "repo/.context/cloudbench/run.json", "repo/.context/cloudbench/logs/backend.log",
            "repo/.context/cloudbench/logs/worker.log",
            f"repo/.context/cloudbench/cloudbench-stack-cleanup-{token}.status"}


def original_files(root, token, extra=()):
    root = Path(root)
    context = root / "repo/.context/cloudbench"
    names = original_names(token) | set(extra)
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
    if (Path(output) / "boot-config-unapplied").exists():
        raise ValueError("pre-config originals require phase-specific verification")
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
    parser.add_argument("action", choices=("eligible", "capture", "verify", "eligible-preconfig", "capture-preconfig", "verify-preconfig", "commit-preconfig", "verify-preconfig-receipt"))
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--machine", required=True)
    parser.add_argument("--run-token", required=True)
    parser.add_argument("--root", type=Path, default=Path("/data"))
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--config-after", type=Path)
    parser.add_argument("--native-before", type=Path)
    parser.add_argument("--native-after", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "capture-preconfig":
        capture_preconfig(args.registry, args.output, args.machine, args.run_token, args.archive)
    elif args.action == "capture":
        capture(args.root, args.machine, args.run_token, args.archive)
    elif args.action == "eligible":
        identity(args.registry, args.output, args.machine, args.run_token)
    elif args.action == "eligible-preconfig":
        preconfig_identity(args.registry, args.output, args.machine, args.run_token)
    elif args.action in {"commit-preconfig", "verify-preconfig-receipt"}:
        if args.action == "commit-preconfig":
            result = commit_preconfig(args.registry, args.output, args.machine, args.run_token, args.archive,
                                      args.native_before, args.native_after, args.receipt)
        else:
            result = verify_preconfig_receipt(args.registry, args.output, args.machine, args.run_token, args.receipt,
                                              args.native_before, args.native_after)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    else:
        if args.action == "verify-preconfig":
            result = verify_preconfig(args.registry, args.output, args.machine, args.run_token,
                                     args.archive, args.native_before, args.native_after)
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
