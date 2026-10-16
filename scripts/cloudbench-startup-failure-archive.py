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
import subprocess
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


def read_preconfig_archive(archive_path, reader=read):
    raw = reader(archive_path)
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


def preconfig_native_proof(machine, original, native_before, native_after, reader=read):
    if native_before is None or native_after is None:
        raise ValueError("pre-config native proof requires both original reads")
    if (reader is read and Path(native_before).samefile(native_after)) or str(native_before) == str(native_after):
        raise ValueError("pre-config native proof reused the same read file")
    before, after = reader(native_before, 1048576), reader(native_after, 1048576)
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


def verify_preconfig_receipt(registry, output, machine, token, receipt_path, native_before=None, native_after=None, *, originals=None):
    """Historical phase evidence only; every native mutation still needs fresh guards."""
    # Imported originals use an explicit sealed path->bytes resolver. No local
    # path fallback or rewriting of the original receipt is permitted.
    reader = read if originals is None else sealed_original_reader(originals)
    receipt_path = Path(receipt_path)
    if receipt_path.parent != Path(output) / "failed-preconfig-runtime-archive":
        raise ValueError("pre-config consumption receipt is outside exact output")
    proof = json.loads(reader(receipt_path, 1048576))
    if (proof.get("schema") != PRECONFIG_SCHEMA or proof.get("phase") != "pre-config"
            or proof.get("consumption_ready") is not True or proof.get("preconfig_evidence_verified") is not True
            or proof.get("native_inert_verified") is not True or proof.get("no_guest_admission_verified") is not True
            or proof.get("evidence_only") is not False or proof.get("native_release_verified") is not False
            or proof.get("runtime_evidence_complete") is not False
            or proof.get("fresh_native_required_for_mutation") is not True
            or type(proof.get("proof_credit")) is not int or proof["proof_credit"] != 0):
        raise ValueError("pre-config consumption receipt is not exact verified zero-credit evidence")
    raw, files, manifest = read_preconfig_archive(proof["archive_path"], reader)
    meta, original, source = archived_preconfig_identity(files, registry, output, machine, token)
    native = preconfig_native_proof(machine, original, proof["native_before_path"], proof["native_after_path"], reader)
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


HANDOFF_SCHEMA = "cloudbench-cold-controller-handoff-v1"


def sealed_original_reader(originals):
    if not isinstance(originals, dict) or not 1 <= len(originals) <= 8:
        raise ValueError("unsafe imported original path map")
    values, total = {}, 0
    for path, item in originals.items():
        if (not isinstance(path, str) or not Path(path).is_absolute()
                or set(item) != {"sha256", "bytes", "data"}
                or type(item["bytes"]) is not int or not 0 <= item["bytes"] <= MAXIMUM - total):
            raise ValueError("unsafe imported original path identity")
        data = base64.b64decode(item["data"], validate=True)
        if len(data) != item["bytes"] or digest(data) != item["sha256"]:
            raise ValueError("imported original bytes changed")
        total += len(data); values[path] = data
    def original(path, maximum=MAXIMUM):
        data = values[str(path)]  # Missing path is fatal, never local fallback.
        if len(data) > maximum:
            raise ValueError("imported original exceeds original read bound")
        return data
    return original


def handoff_directory(directory):
    directory = Path(directory); missing = []; parent = directory
    while not parent.exists(): missing.append(parent); parent = parent.parent
    if parent.resolve(strict=True) != parent: raise ValueError("linked handoff ancestor")
    for child in reversed(missing):
        child.mkdir(mode=0o700)
        fd = os.open(child.parent, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    if directory.resolve(strict=True) != directory or not directory.is_dir():
        raise ValueError("unsafe handoff directory")
    # A previous attempt may have died after mkdir but before its parent fsync.
    # Existing ancestors must become durable too before any COMMITTED packet.
    for current in (directory, *directory.parents):
        fd = os.open(current, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)


def durable_handoff_json(path, value):
    """Same no-clobber/fsync ordering as ownership receipts; exact retry only."""
    path = Path(path)
    handoff_directory(path.parent)
    raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if path.exists() or path.is_symlink():
        if read(path) != raw:
            raise ValueError("conflicting immutable handoff identity")
        # Complete durability after an interrupted file-fsync -> parent-fsync
        # window; exact bytes permit retry, never a conflicting replacement.
        fd = os.open(path.parent, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
        return digest(raw)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)
    return digest(raw)


def handoff_target(target):
    expected = {"machine", "volume", "workspace", "common", "source_ref", "ownership_sha256",
                "controller_config_sha256", "preservation", "pool_name"}
    if (not isinstance(target, dict) or set(target) != expected
            or not re.fullmatch("[0-9a-f]{14}", target["machine"])
            or not re.fullmatch("vol_[A-Za-z0-9_-]+", target["volume"])
            or any(not Path(target[key]).is_absolute() for key in ("workspace", "common"))
            or not re.fullmatch("[0-9a-f]{40}", target["source_ref"])
            or any(not re.fullmatch("[0-9a-f]{64}", target[key]) for key in ("ownership_sha256", "controller_config_sha256"))
            or target["preservation"] not in {"rootfs-always", "same-volume-device"}
            or not re.fullmatch("[A-Za-z0-9._-]+\\.cold\\.ids", target["pool_name"])):
        raise ValueError("unsafe explicit handoff destination")
    return target


def handoff_native_pair(before, after, machine, volume, name):
    first, last = json.loads(read(before, 1048576)), json.loads(read(after, 1048576))
    config = first.get("config", {})
    if (first != last or first.get("id") != machine or first.get("name") != name
            or first.get("state") != "stopped" or not first.get("instance_id")
            or config.get("init") != {"cmd": ["sleep", "infinity"]}
            or config.get("env") not in (None, {})
            or config.get("mounts", [{}])[0].get("volume") != volume
            or len(config.get("mounts", [])) != 1):
        raise ValueError("handoff native identity/config is not stopped unchanged inert primary")
    return first


def export_cold_handoff(common, registry, output, machine, token, receipt, before, after,
                        target, nonce, packet_path, checkpoint=lambda stage: None, *, source_endpoint):
    """Caller holds exact source-owner recovery lock and proves dead REAP host.
    Source originals remain intact; permanent outgoing tombstones delegate the
    exact allocation and block every ordinary source recovery/claimer forever.
    """
    common, registry, output = Path(common), Path(registry), Path(output)
    target = handoff_target(target); source_endpoint = handoff_target(source_endpoint)
    if source_endpoint["common"] != str(common): raise ValueError("source endpoint common differs")
    if common.resolve(strict=True) != common or not re.fullmatch("[0-9a-f]{32}", nonce):
        raise ValueError("unsafe source common or handoff nonce")
    meta = fields(registry / "meta")
    prior_hold_path = registry / "cold-handoff-outgoing"
    prior_hold = json.loads(read(prior_hold_path,1048576)) if prior_hold_path.exists() else None
    if meta["cleanup_policy"] != "reap":
        if not prior_hold or prior_hold['nonce'] != nonce or prior_hold['target'] != target or prior_hold['machine_id'] != machine:
            raise ValueError("retained source cannot hand off")
    old_birth = re.fullmatch(r"proc-start:([0-9a-f-]{36}):[0-9]+", meta.get("pid_start", ""))
    if not old_birth or old_birth[1] == Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        raise ValueError("source maintenance boot does not prove original controller descendants gone")
    if set(p.name for p in (registry / "clones").iterdir()) != {fields(registry / "clones" / p.name)["name"] for p in (registry / "clones").iterdir()}:
        raise ValueError("malformed source cohort")
    # Initial implementation is deliberately a singleton owner. No partial
    # cohort may shed its latch while an unexamined sibling remains.
    if len(list((registry / "clones").iterdir())) != 1:
        raise ValueError("cross-controller handoff requires exact singleton cohort")
    for ledger in (common / 'cloudbench-pools').glob('*.ids'):
        if machine in read(ledger).decode().splitlines():
            raise ValueError('source allocation already belongs to a local pool')
    phase = verify_preconfig_receipt(registry, output, machine, token, receipt, before, after)
    for path in (output / "runtime-evidence.pending", registry / "guest-cleanup-unconfirmed",
                 registry / "runtime-evidence-unconfirmed", output / "post-config-start.accepted",
                 output / "cloudbench-run.json", output / "worker-runtime-evidence",
                 output / "status-proxy.port", output / "cloudbench-boot-start.log", output / "guest-shutdown.confirmed"):
        if path.exists() or path.is_symlink():
            raise ValueError("unconsumed, guest-quarantined or admitted handoff")
    if (read(output / "benchmark-child.finished", 32).strip() != b"125"
            or read(output / "boot-config-unapplied", 256).strip() != machine.encode()
            or read(output / "worker-clones.ids", 65536)):
        raise ValueError("current source phase changed after archival")
    raw, files, manifest = read_preconfig_archive(phase["archive_path"])
    _, original, provenance = archived_preconfig_identity(files, registry, output, machine, token)
    native = handoff_native_pair(before, after, machine, original["volume_id"], original["clone_name"])
    hold = {"schema": HANDOFF_SCHEMA, "nonce": nonce, "machine_id": machine,
            "volume_id": original["volume_id"], "owner": registry.name, "target": target,
            "phase_sha256": digest(read(receipt, 1048576)), "source_common": str(common), "source_endpoint": source_endpoint}
    # Fsync source-wide owner exclusion first, then MID/Volume exclusions. No
    # export packet can be published before every source guard is durable.
    durable_handoff_json(registry / "cold-handoff-outgoing", hold)
    checkpoint("source-owner-held")
    for key in (machine, original["volume_id"]):
        durable_handoff_json(common / "cloudbench-cold-handoffs/outgoing" / key, hold)
    checkpoint("source-native-held")
    # Existing older recovery tools understand retain even though they do not
    # understand migration tombstones. Preserve original REAP bytes in the
    # canonical archive; current meta policy becomes a permanent source fence.
    if meta['cleanup_policy'] == 'reap':
        raw_meta = read(registry/'meta',65536)
        retained = raw_meta.replace(b'cleanup_policy=reap\n',b'cleanup_policy=retain\n')
        if retained == raw_meta: raise ValueError('source policy line is not canonical')
        temporary = registry / ('.handoff-retain-' + nonce)
        if temporary.exists() or temporary.is_symlink():
            info=temporary.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid()
                    or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600 or read(temporary,65536)!=retained):
                raise ValueError('conflicting retained-policy retry original')
        else:
            with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
                stream.write(retained);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,registry/'meta')
        fd=os.open(registry,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
    originals = {}; total = 0
    for path in (receipt, phase["archive_path"], phase["native_before_path"], phase["native_after_path"]):
        data = read(path, MAXIMUM - total); total += len(data)
        originals[str(path)] = {"bytes": len(data), "sha256": digest(data), "data": base64.b64encode(data).decode()}
    packet = {**hold, "state": "SOURCE_COMMITTED", "registry": str(registry), "output": str(output),
              "run_token": token, "receipt": str(receipt), "originals": originals,
              "native": native, "proof_credit": 0, "native_release_verified": False}
    durable_handoff_json(common / "cloudbench-cold-handoffs/sealed" / (machine + ".json"), packet)
    checkpoint("source-sealed")
    durable_handoff_json(packet_path, packet)
    return packet


def verify_imported_cold_handoff(packet, target, before, after):
    target = handoff_target(target)
    if (set(packet) != {"schema", "nonce", "machine_id", "volume_id", "owner", "target", "phase_sha256",
            "source_common", "source_endpoint", "state", "registry", "output", "run_token", "receipt", "originals", "native",
            "proof_credit", "native_release_verified"} or packet["schema"] != HANDOFF_SCHEMA
            or packet["state"] != "SOURCE_COMMITTED" or packet["target"] != target
            or packet["proof_credit"] != 0 or packet["native_release_verified"] is not False
            or not re.fullmatch("[0-9a-f]{32}", packet["nonce"])):
        raise ValueError("source handoff is not destination-bound committed original")
    source_endpoint = handoff_target(packet["source_endpoint"])
    if source_endpoint["common"] != packet["source_common"]: raise ValueError("source endpoint mismatch")
    reader = sealed_original_reader(packet["originals"])
    if digest(reader(packet["receipt"], 1048576)) != packet["phase_sha256"]:
        raise ValueError("handoff phase digest differs")
    phase = verify_preconfig_receipt(packet["registry"], packet["output"], packet["machine_id"],
             packet["run_token"], packet["receipt"], before, after, originals=packet["originals"])
    native = handoff_native_pair(before, after, packet["machine_id"], packet["volume_id"], packet["native"]["name"])
    if native != packet["native"] or phase["owner"] != packet["owner"]:
        raise ValueError("current imported primary differs from committed allocation")
    return phase


def import_cold_handoff(common, target, packet_path, before, after, checkpoint=lambda stage: None):
    """Verified source seal -> claim -> ledger -> audit -> terminal -> release last.
    The source must be contacted only through its separately authenticated exact
    export operation. This function never mutates it or rewrites its receipts.
    """
    import fcntl
    common = Path(common); target = handoff_target(target)
    if common.resolve(strict=True) != common or str(common) != target["common"]:
        raise ValueError("handoff reached a different physical destination common")
    packet_raw = read(packet_path); packet = json.loads(packet_raw)
    if (common / 'cloudbench-cold-handoffs/outgoing' / packet['machine_id']).exists():
        raise ValueError('destination already delegated this allocation outward')
    phase = verify_imported_cold_handoff(packet, target, before, after)
    machine, volume = packet["machine_id"], packet["volume_id"]
    claims = common / "cloudbench-pool-claims"; handoff_directory(claims)
    lockdir = claims / ".locks"; handoff_directory(lockdir)
    if claims.resolve(strict=True) != claims or lockdir.resolve(strict=True) != lockdir: raise ValueError("linked claim directory")
    with os.fdopen(os.open(lockdir / (machine + ".lock"), os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600), "wb") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        authority = {"schema": HANDOFF_SCHEMA, "nonce": packet["nonce"], "packet_sha256": digest(packet_raw),
                     "target": target, "machine_id": machine, "volume_id": volume}
        terminal = common / "cloudbench-cold-handoffs/imported" / (machine + ".json")
        if terminal.exists():
            if json.loads(read(terminal)) != authority:
                raise ValueError("different handoff already owns destination MID")
            if (claims / machine).exists():
                if json.loads(read(claims / machine)) != authority:
                    raise ValueError("terminal handoff cannot release foreign claim")
                (claims / machine).unlink()
                fd = os.open(claims, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try: os.fsync(fd)
                finally: os.close(fd)
            return authority
        # This migration claim is never a dead ordinary local owner claim.
        # Existing claimers/reconcilers must leave it unavailable until terminal.
        durable_handoff_json(claims / machine, authority)
        checkpoint("destination-claimed")
        evidence = common / "cloudbench-cold-handoffs/evidence" / (machine + ".json")
        durable_handoff_json(evidence, packet)
        proof = {"version": 1, "app": phase["schema"], "machine_id": machine,
                 "name": packet["native"]["name"], "volume_id": volume,
                 "instance_id": packet["native"]["instance_id"],
                 "config_sha256": phase["config_sha256"],
                 "image_digest": packet["native"]["config"]["image"].rpartition("@")[2],
                 "imported_cold": {"packet_path": str(evidence), "packet_sha256": digest(read(evidence)), "target": target}}
        # Recover the real app from immutable source archive rather than its
        # filesystem location or a fabricated destination source registry.
        reader = sealed_original_reader(packet["originals"])
        _, files, _ = read_preconfig_archive(phase["archive_path"], reader)
        proof["app"] = fields_bytes(files["registry/meta"])["app"]
        provenance = json.loads(files["run/execution-provenance.json"])
        contract = runpy.run_path(str(Path(__file__).with_name("cloudbench_execution_provenance.py")))
        matrix = json.loads(files["run/execution-task-matrix.json"])
        if contract["validate_task_matrix_binding"](provenance, matrix):
            raise ValueError("imported source dependency/task provenance invalid")
        values = provenance["config"]["values"]
        baseline = values["node_dependency_fingerprint"] + " " + values["python_dependency_fingerprint"] + " cold-image-bootstrap\n"
        if not re.fullmatch(r"[0-9a-f]{64} [0-9a-f]{64} cold-image-bootstrap\n", baseline):
            raise ValueError("cold image manifest baseline missing")
        durable_handoff_json(common / "cloudbench-pool-reuse" / (machine + ".json"), proof)
        ledger = common / "cloudbench-pools" / target["pool_name"]
        handoff_directory(ledger.parent)
        # Serialize with the existing pool ledger lock. Never replace another
        # ID list or baseline, and fsync before publishing terminal import.
        with cold_handoff_ledger_lock(Path(str(ledger) + ".lock")):
            meta = Path(str(ledger) + ".deps")
            if meta.exists() or meta.is_symlink():
                if read(meta, 4096) != baseline.encode():
                    raise ValueError("destination cold image dependency baseline differs")
            else:
                with os.fdopen(os.open(meta, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600), "wb") as stream:
                    stream.write(baseline.encode()); stream.flush(); os.fsync(stream.fileno())
            values = read(ledger, MAXIMUM).decode().splitlines() if ledger.exists() else []
            if len(values) != len(set(values)) or any(not re.fullmatch('[0-9a-f]{14}', value) for value in values):
                raise ValueError("destination pool ledger malformed")
            if machine not in values:
                with os.fdopen(os.open(ledger, os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW, 0o600), "w") as stream:
                    stream.write(machine + "\n"); stream.flush(); os.fsync(stream.fileno())
            fd = os.open(ledger.parent, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
        checkpoint("destination-ledger")
        durable_handoff_json(common / "cloudbench-cold-handoffs/audit" / (machine + ".json"), authority)
        checkpoint("destination-audit")
        durable_handoff_json(terminal, authority)
        checkpoint("destination-terminal")
        if json.loads(read(claims / machine)) != authority:
            raise ValueError("import claim identity changed before release")
        (claims / machine).unlink()
        fd = os.open(claims, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
        return authority

def cold_handoff_ledger_lock(lock):
    # Use the EXISTING pool ledger mkdir/meta lock protocol. A SIGKILL leaves
    # the exact host/PID/birth tuple for ordinary stale-lock recovery; never
    # use a different flock inode beside the normal ledger writer.
    from contextlib import contextmanager
    @contextmanager
    def held():
        try: lock.mkdir(mode=0o700)
        except FileExistsError:
            previous = fields(lock/'meta')
            birth = re.fullmatch(r'proc-start:([0-9a-f-]{36}):([0-9]+)',previous.get('pid_start',''))
            if previous.get('host') != os.uname().nodename or not birth or not previous.get('pid','').isdigit():
                raise ValueError('foreign or malformed pool ledger lock')
            current_boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            process=Path('/proc')/previous['pid']/'stat'
            try:
                state=process.read_text().split(') ',1)[1].split()
                dead=birth[1]!=current_boot or state[19]!=birth[2] or state[0]=='Z'
            except FileNotFoundError: dead=True
            if not dead: raise ValueError('live pool ledger lock')
            # Re-read exact same owner bytes immediately before sanctioned stale
            # lock retirement. The ordinary writer uses this same protocol.
            if fields(lock/'meta') != previous: raise ValueError('pool lock owner changed')
            (lock/'meta').unlink();lock.rmdir();lock.mkdir(mode=0o700)
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        ticks = Path('/proc/self/stat').read_text().split(') ',1)[1].split()[19]
        raw = ('host=' + os.uname().nodename + '\npid=' + str(os.getpid()) + '\npid_start=proc-start:' + boot + ':' + ticks + '\n').encode()
        with os.fdopen(os.open(lock/'meta',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        for directory in (lock,lock.parent):
            fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
        try: yield
        finally:
            if read(lock/'meta',65536) != raw: raise ValueError('pool ledger lock ownership changed')
            (lock/'meta').unlink();lock.rmdir()
    return held()


def capture_cold_handoff_target(workspace, common, before, after, ownership, source_ref, pool_name):
    workspace, common = Path(workspace), Path(common)
    if (workspace.resolve(strict=True) != workspace or common.resolve(strict=True) != common
            or not workspace.is_dir() or not common.is_dir()):
        raise ValueError("unsafe actual handoff endpoint paths")
    first, last = json.loads(read(before, 1048576)), json.loads(read(after, 1048576))
    config = first.get("config", {})
    mounts = config.get("mounts", [])
    if (first != last or first.get("id") != os.environ.get("FLY_MACHINE_ID")
            or first.get("state") != "started" or not first.get("instance_id")
            or len(mounts) != 1 or not config.get("init", {}).get("exec") == ["/bin/sleep", "180"]
            or config.get("restart") != {"policy": "no"} or config.get("auto_destroy") not in (None, False)):
        raise ValueError("handoff endpoint is not exact inert maintenance controller")
    # Holds and claims must survive controller reboot. Rootfs-always is an
    # explicit native preservation contract, not an inferred mount topology.
    preservation = "rootfs-always" if config.get("rootfs") == {"persist": "always", "size_gb": 50} else "same-volume-device"
    mount = Path(mounts[0]["path"])
    if preservation == "same-volume-device" and (mount.resolve(strict=True) != mount
            or not os.path.ismount(mount) or mount.stat().st_dev != common.stat().st_dev):
        raise ValueError("handoff common has no proven durable custody")
    owner_raw = read(ownership, 1048576)
    owner = json.loads(owner_raw)
    if (owner.get("schema") != "cloudbench-controller-workspace-ownership-v1"
            or owner.get("volume_id") != mounts[0]["volume"] or owner.get("app") != os.environ.get("FLY_APP_NAME")
            or owner.get("mount_path") != str(mount)):
        raise ValueError("workspace ownership receipt differs from native controller")
    actual_common = subprocess.check_output(['git','-C',str(workspace),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()
    actual_ref = subprocess.check_output(['git','-C',str(workspace),'rev-parse','HEAD'],text=True).strip()
    if Path(actual_common).resolve(strict=True) != common or actual_ref != source_ref:
        raise ValueError("handoff tool source or Gitcommon differs")
    return handoff_target(dict(machine=first["id"], volume=mounts[0]["volume"], workspace=str(workspace),
        common=str(common), source_ref=source_ref, ownership_sha256=digest(owner_raw),
        controller_config_sha256=digest(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()),
        preservation=preservation, pool_name=pool_name))


def verify_imported_pool_proof(path, common, before, after, expected_source, *, native_volume):
    proof = json.loads(read(path, 65536)); imported = proof["imported_cold"]
    if (str(Path(common).resolve(strict=True)) != imported["target"]["common"]
            or imported["target"]["machine"] != os.environ.get("FLY_MACHINE_ID")
            or imported["target"]["source_ref"] != expected_source):
        raise ValueError("imported proof used in foreign controller/common/source")
    raw = read(imported["packet_path"])
    if digest(raw) != imported["packet_sha256"]:
        raise ValueError("imported original packet changed")
    packet = json.loads(raw)
    if native_volume.get('id') != packet['volume_id'] or native_volume.get('attached_machine_id') != packet['machine_id'] or native_volume.get('state') != 'created':
        raise ValueError('imported current Volume attachment/state differs')
    phase = verify_imported_cold_handoff(packet, imported["target"], before, after)
    if (proof["machine_id"] != packet["machine_id"] or proof["volume_id"] != packet["volume_id"]
            or proof["image_digest"] != packet["native"]["config"]["image"].rpartition('@')[2]
            or proof["instance_id"] != packet["native"]["instance_id"]
            or proof["config_sha256"] != phase["config_sha256"]
            or proof["name"] != packet["native"]["name"]):
        raise ValueError("imported pool authority differs from source seal")
    return proof


def read_cold_handoff_request(request_path, expected_sha):
    raw = read(request_path, 1048576)
    info = Path(request_path).lstat()
    if info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('handoff request is not private exact-owner regular input')
    if digest(raw) != expected_sha:
        raise ValueError("handoff request differs from exact approved bytes")
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get('operation') not in {'target','export','import'}:
        raise ValueError('malformed handoff operation')
    return request


def cold_handoff_request(request_path, expected_sha, workspace, common):
    """Internal maintenance CLI. Fresh native files were obtained by the
    caller's canonical exact-Machine reader under normal process/once guards.
    The exact request SHA is explicit parent disposition, not a new auth system.
    """
    request = read_cold_handoff_request(request_path, expected_sha)
    endpoint = capture_cold_handoff_target(workspace, common, request["controller_before"],
        request["controller_after"], request["workspace_ownership"], request["tool_ref"], request["pool_name"])
    if endpoint != request["endpoint"]:
        raise ValueError("actual endpoint differs from explicit handoff identity")
    controller_volume = json.loads(read(request['controller_volume'],1048576))
    if (controller_volume.get('id') != endpoint['volume'] or controller_volume.get('attached_machine_id') != endpoint['machine'] or controller_volume.get('state') != 'created'):
        raise ValueError('actual controller Volume attachment differs')
    operation = request["operation"]
    if operation != 'target':
        volume = json.loads(read(request['native_volume'],1048576))
        if volume.get('id') != request['volume'] or volume.get('attached_machine_id') != request['machine'] or volume.get('state') != 'created':
            raise ValueError('actual child Volume attachment differs')
    if operation == "target":
        durable_handoff_json(request["target_output"], endpoint)
        return endpoint
    if operation == "export":
        registry = Path(request["registry"])
        if registry.parent != Path(common) / "cloudbench-fleet-ownership":
            raise ValueError("export registry is not this actual common")
        return export_cold_handoff(common, registry, request["output"], request["machine"], request["run_token"],
            request["receipt"], request["native_before"], request["native_after"], request["target"],
            request["nonce"], request["packet_output"], source_endpoint=endpoint)
    if operation == "import":
        if request["target"] != endpoint:
            raise ValueError("import target is not actual maintained endpoint")
        if digest(read(request["packet"])) != request["packet_sha256"]:
            raise ValueError("import packet differs from exact authorized seal")
        return import_cold_handoff(common, endpoint, request["packet"], request["native_before"], request["native_after"])
    raise ValueError("unsupported handoff operation")



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
