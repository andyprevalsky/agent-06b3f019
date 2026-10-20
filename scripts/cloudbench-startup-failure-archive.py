#!/usr/bin/env python3
"""Preserve a rejected startup's original terminal files for exact cleanup only."""

import argparse
import ast
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import signal
import time
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


def read_preconfig_archive(archive_path, reader=read, *, schema=PRECONFIG_SCHEMA):
    raw = reader(archive_path)
    files, fifos, total = {}, {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            total += member.size
            name = Path(member.name)
            if (member.name in files or member.name in fifos or member.size < 0
                    or name.is_absolute() or ".." in name.parts or name.as_posix() != member.name
                    or total > MAXIMUM or len(files)+len(fifos) > 1030):
                raise ValueError("unsafe pre-config archive member")
            if member.isfifo() and schema == CURRENT_COLD_SCHEMA:
                from decimal import Decimal, InvalidOperation
                try:
                    metadata=json.loads(member.pax_headers.get('cloudbench.fifo-source-stat','null'))
                    if (member.name!=FIFO_NAME or not isinstance(metadata,dict) or member.size!=0 or member.linkname
                            or member.mode!=stat.S_IMODE(metadata['mode']) or member.uid!=metadata['uid'] or member.gid!=metadata['gid']
                            or Decimal(member.pax_headers.get('mtime','NaN'))*1000000000!=metadata['mtime_ns']):
                        raise ValueError('archive FIFO metadata differs')
                except (KeyError,TypeError,InvalidOperation) as error:
                    raise ValueError('invalid archive FIFO metadata') from error
                fifos[member.name]=metadata
                continue
            if not member.isfile(): raise ValueError("unsafe pre-config archive member")
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size:
                raise ValueError("truncated pre-config original")
            files[member.name] = data
    manifest = json.loads(files.pop("capture-manifest.json"))
    expected = {"schema": schema, "machine_id": manifest.get("machine_id"),
        "run_token": manifest.get("run_token"), "proof_credit": 0,
        "files": {name: {"bytes": len(data), "sha256": digest(data)} for name, data in files.items()}}
    records=current_fifo_records(files) if schema == CURRENT_COLD_SCHEMA else {}
    if fifos or (schema == CURRENT_COLD_SCHEMA and FIFO_METADATA in files):
        if {name:row['stat'] for name,row in records.items()}!=fifos or not records:
            raise ValueError('archive FIFO inventory differs')
        expected['fifos']=records
    if type(manifest.get("proof_credit")) is not int or manifest != expected:
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


CURRENT_COLD_SCHEMA = "allocated-current-cold-v1"
# Exact 6189 capture producer. Its sealed capsules predate separate destination
# native reads; retain byte-bound compatibility without executing archived code.
CURRENT_COLD_APPROVED_CAPTURE_HELPERS = frozenset({
    "852abb705880ada9f5b6d931dd4285de3f49e2003e2ba5d479dab0e920d6b6c9",
})


def observe_current_cold_processes():
 from pathlib import Path
 import os,json,hashlib,stat,time,signal

 assert os.getuid()==0 and re.fullmatch('[0-9a-f]{14}',os.environ.get('FLY_MACHINE_ID',''))
 boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert len(boot)==36
 expected_sleep=Path('/bin/sleep').resolve(strict=True);sleep_stat=expected_sleep.stat();assert stat.S_ISREG(sleep_stat.st_mode)and sleep_stat.st_uid==0
 def stable(p,first):
  last=(p/'stat').read_text().split(') ',1)[1].split();assert last[19]==first[19]and last[0]!='Z'
  return True
 INERT_CMD=['sleep', 'infinity']
 FORBIDDEN_GUEST_MARKERS=('cloudbench-boot', 'cloudbench-run.sh', 'cloudbench-status-server', 'cloudbench-worker', '/data/repo')
 def _scan_processes(proc: Path) -> tuple[int, list[dict[str, object]]]:
     own = {os.getpid(), os.getppid()}
     sleepers = 0
     forbidden = []
     for entry in os.listdir(proc):
         if not entry.isdigit() or int(entry) in own:
             continue
         try:
             raw = (proc / entry / "cmdline").read_bytes()
         except TimeoutError:raise
         except OSError:
             continue
         argv = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
         if argv in (INERT_CMD, ["/bin/sleep", "infinity"], ["/usr/bin/sleep", "infinity"]):
             sleepers += 1
         if any(marker in arg for arg in argv for marker in FORBIDDEN_GUEST_MARKERS):
             forbidden.append({"pid": int(entry), "argv0": os.path.basename(argv[0]) if argv else ""})
     return sleepers, forbidden
 sleepers,forbidden=_scan_processes(Path('/proc'));assert sleepers>=1 and not forbidden
 ancestors={os.getpid()};pid=os.getpid()
 while pid>1:
  raw=Path('/proc',str(pid),'stat').read_text().split(') ',1)[1].split();pid=int(raw[1]);ancestors.add(pid)
 def hallpass_identity(uid,ppid,pgid,args,path,digest,birth_stable,regular,owner):
  return uid==0 and ppid==1 and pgid==0 and args==[b'/.fly/hallpass']and path=='/.fly/hallpass'and digest in {'7e42662dc2361058814d06b80bafbed13b7e8d6da4f477604001b54dc905ce52','02f70fcb946d386f697ad7fbe16d91a2f9243f85c6db583e3778582cd23b35c0'}and birth_stable is True and regular is True and owner==0
 def hallpass_binary(exe):
  if exe!=Path('/.fly/hallpass'):return 'UNMEASURED',False,-1
  fd=os.open(exe,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   a=os.fstat(fd)
   if not stat.S_ISREG(a.st_mode)or a.st_uid!=0 or a.st_size>16777216:return 'UNMEASURED',False,a.st_uid
   h=hashlib.sha256();count=0
   while count<a.st_size:
    b=os.read(fd,min(65536,a.st_size-count));assert b;count+=len(b);h.update(b)
   z=os.fstat(fd);assert(a.st_dev,a.st_ino,a.st_mode,a.st_uid,a.st_gid,a.st_nlink,a.st_size,a.st_mtime_ns)==(z.st_dev,z.st_ino,z.st_mode,z.st_uid,z.st_gid,z.st_nlink,z.st_size,z.st_mtime_ns)and stat.S_ISREG(z.st_mode)and z.st_uid==0
   return h.hexdigest(),True,a.st_uid
  finally:os.close(fd)
 entries=[p for p in Path('/proc').iterdir()if p.name.isdigit()];assert len(entries)<=4096
 unknown=[];allowed_sleep=[];idle_agents=[];platform_hallpass=[]
 for p in entries:
  if int(p.name)in ancestors:continue
  try:
   st=(p/'stat').read_text().split(') ',1)[1].split()
   if st[0]=='Z':continue
   args=[x for x in (p/'cmdline').read_bytes().split(b'\0')if x];uid=p.stat().st_uid
   if not args and uid==0 and int(st[6])&0x200000:continue
   exe=(p/'exe').resolve(strict=True)
   if args in [[b'sleep',b'infinity'],[b'/bin/sleep',b'infinity'],[b'/usr/bin/sleep',b'infinity']]and exe==expected_sleep and uid in [0,1001]and (exe.stat().st_dev,exe.stat().st_ino)==(sleep_stat.st_dev,sleep_stat.st_ino)and stable(p,st):allowed_sleep.append({'pid':int(p.name),'birth':st[19]});continue
   if uid==1001 and st[1]=='1'and args[1:]==[b'agent',b'run']and exe.name=='flyctl'and hashlib.sha256(exe.read_bytes()).hexdigest()=='5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83'and stable(p,st):idle_agents.append({'pid':int(p.name),'birth':st[19]});continue
   if uid==0 and st[1]=='1'and st[2]=='0'and args==[b'/.fly/hallpass']and exe==Path('/.fly/hallpass'):
    digest,regular,owner=hallpass_binary(exe)
    if hallpass_identity(uid,int(st[1]),int(st[2]),args,str(exe),digest,stable(p,st),regular,owner):
     assert not platform_hallpass,'multiple platform hallpass processes'
     platform_hallpass.append({'pid':int(p.name),'birth':st[19],'role':'exact-pinned-platform-hallpass'});continue
   unknown.append({'pid':int(p.name),'birth':st[19],'uid':uid})
  except FileNotFoundError:
   try:still=(p/'stat').read_text().split(') ',1)[1].split()
   except FileNotFoundError:continue
   assert still[0]=='Z','unreadable still-live process'
 assert not unknown and allowed_sleep
 return ({'kind':'exact-inert-quiescence-v1','machine':os.environ['FLY_MACHINE_ID'],'boot':boot,'unknown':unknown,'inert_sleepers':allowed_sleep,'idle_pinned_agents':idle_agents,'idle_platform_hallpass':platform_hallpass,'observed_epoch':time.time()})


def current_cold_dependencies():
    helper = Path(__file__).resolve().parent / 'lib/cloudbench-env.sh'
    raw = subprocess.check_output(['bash', '-c', 'source "$1"; cloudbench_node_dependency_fingerprint /app; cloudbench_manifest_fingerprint /app "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"', 'cold-dependencies', str(helper)], text=True, timeout=10)
    node, python = raw.splitlines()
    return dict(node=node, python=python)


def validate_current_cold_guest(value, machine, token, *, expected_collector_sha256=None):
    expected = {'schema','machine_id','run_token','collector_sha256','observation','checkout','dependencies','files','missing','contents','native_instance','capture_nonce','data_mount'}
    if (set(value) != expected or value['schema'] != CURRENT_COLD_SCHEMA or value['machine_id'] != machine
            or value['run_token'] != token or value['collector_sha256'] != (expected_collector_sha256 or digest(Path(__file__).read_bytes()))
            or value['checkout'] not in ('absent','empty') or not isinstance(value['native_instance'],str)
            or not value['native_instance'] or not re.fullmatch('[0-9a-f]{32}',value['capture_nonce'])):
        raise ValueError('current guest source/identity/checkout differs')
    mounted=value['data_mount']
    if (set(mounted)!={'device','inode','mount_device'} or any(type(mounted[k]) is not int or mounted[k]<=0 for k in ('device','inode'))
            or not re.fullmatch('[0-9]+:[0-9]+',mounted['mount_device'])):
        raise ValueError('current data mount evidence missing')
    observation = value['observation']
    if (set(observation) != {'kind','machine','boot','unknown','inert_sleepers','idle_pinned_agents','idle_platform_hallpass','observed_epoch'}
            or observation['kind'] != 'exact-inert-quiescence-v1' or observation['machine'] != machine
            or not re.fullmatch('[0-9a-f-]{36}', observation['boot']) or observation['unknown'] != []
            or not observation['inert_sleepers'] or len(observation['idle_platform_hallpass']) > 1):
        raise ValueError('current guest birth/role evidence missing')
    pids=set()
    for role in ('inert_sleepers','idle_pinned_agents','idle_platform_hallpass'):
        for row in observation[role]:
            if (type(row.get('pid')) is not int or row['pid']<=0 or row['pid'] in pids
                    or not re.fullmatch('[0-9]+',row.get('birth',''))):
                raise ValueError('current guest process identity missing')
            pids.add(row['pid'])
    if set(value['dependencies']) != {'node','python'} or any(not re.fullmatch('[0-9a-f]{64}', x) for x in value['dependencies'].values()):
        raise ValueError('current guest image dependency manifests missing')
    if (set(value['files']) != set(value['contents']) or len(value['missing'])!=len(set(value['missing']))
            or set(value['files']) & set(value['missing']) or set(value['files']) | set(value['missing']) != original_names(token)):
        raise ValueError('current original guest inventory is incomplete')
    total=0
    for name,encoded in value['contents'].items():
        raw=base64.b64decode(encoded,validate=True);total+=len(raw)
        if value['files'][name] != {'bytes':len(raw),'sha256':digest(raw)} or total>MAXIMUM:
            raise ValueError('current original guest data differs')


def current_cold_mount(data):
    data=Path(data)
    if data!=Path('/data') or data.resolve(strict=True)!=data or not data.is_dir():
        raise ValueError('current collector requires canonical mounted /data')
    entries=[row.split() for row in Path('/proc/self/mountinfo').read_text().splitlines() if len(row.split())>5 and row.split()[4]=='/data']
    info=data.stat()
    if len(entries)!=1 or info.st_dev==Path('/').stat().st_dev:
        raise ValueError('current /data is not a distinct mounted Volume')
    return dict(device=info.st_dev,inode=info.st_ino,mount_device=entries[0][2])


def capture_current_cold_guest(data, token, destination, native_instance, capture_nonce, *, observe=observe_current_cold_processes, dependencies=current_cold_dependencies, mount=current_cold_mount):
    """Read-only guest collector. Production CLI pins /data, /proc and /app."""
    data = Path(data)
    if data.resolve(strict=True) != data or not data.is_dir(): raise ValueError('redirected current data root')
    repo = data / 'repo'
    if repo.is_symlink() or (repo.exists() and (not repo.is_dir() or any(repo.iterdir()))):
        raise ValueError('current checkout must be absent or empty and unlinked')
    checkout_before = (repo.exists(), tuple(repo.iterdir()) if repo.exists() else (), repo.lstat() if repo.exists() else None)
    data_mount=mount(data)
    first = observe()
    files, missing = original_files(data, token)
    deps = dependencies()
    value = dict(schema=CURRENT_COLD_SCHEMA,machine_id=os.environ.get('FLY_MACHINE_ID'),run_token=token,
        collector_sha256=digest(Path(__file__).read_bytes()),observation=first,
        checkout='empty' if repo.exists() else 'absent',dependencies=deps,native_instance=native_instance,capture_nonce=capture_nonce,
        files={name:{'bytes':len(raw),'sha256':digest(raw)} for name,raw in files.items()},missing=missing,
        contents={name:base64.b64encode(raw).decode() for name,raw in files.items()},data_mount=data_mount)
    validate_current_cold_guest(value,value['machine_id'],token)
    last=observe()
    if repo.is_symlink() or (repo.exists() and (not repo.is_dir() or any(repo.iterdir()))):
        raise ValueError('current checkout changed during capture')
    checkout_after=(repo.exists(), tuple(repo.iterdir()) if repo.exists() else (), repo.lstat() if repo.exists() else None)
    if mount(data)!=data_mount: raise ValueError('current data mount changed during capture')
    if checkout_before != checkout_after: raise ValueError('current checkout identity changed during capture')
    if ({k:v for k,v in last.items() if k!='observed_epoch'} != {k:v for k,v in first.items() if k!='observed_epoch'}
            or original_files(data,token) != (files,missing)):
        raise ValueError('current guest changed during read-only capture')
    durable_handoff_json(destination,value)


def validate_source_latches(value,files):
    names={'guest-cleanup-unconfirmed','runtime-evidence-unconfirmed'}
    if not isinstance(value,dict) or set(value)!=names:
        raise ValueError('source latch map fields differ')
    for name,row in value.items():
        if not isinstance(row,dict) or type(row.get('present')) is not bool:
            raise ValueError('source latch presence must be boolean')
        expected=({'present':True,'sha256':digest(files['registry/'+name])}
            if 'registry/'+name in files else {'present':False})
        if row!=expected: raise ValueError('source latch presence differs from archive')
    return value


def read_outer_terminal(inputs):
    names={'summary','manifest','threshold_parent','parent_term'}
    if not isinstance(inputs,dict) or set(inputs)!=names: raise ValueError('outer terminal input set differs')
    result={}
    for name,item in inputs.items():
        if not isinstance(item,dict) or set(item)!={'path','sha256'}: raise ValueError('outer terminal descriptor differs')
        raw=read(item['path'])
        if digest(raw)!=item['sha256']: raise ValueError('outer terminal original hash differs')
        result['outer/'+name+'.json']=raw
    return result


def validate_current_source_termination(files,meta,output,token):
    from datetime import datetime
    presence=json.loads(files['source-local-presence.json'])
    prefix='run/'+Path(output).name+'/'
    expected={'batch_run':'run/_batch/run.json' in files,'worker_ledger':prefix+'worker-clones.ids' in files}
    if (not isinstance(presence,dict) or set(presence)!=set(expected)
            or any(type(value) is not bool for value in presence.values()) or presence!=expected):
        raise ValueError('local source presence differs')
    source=json.loads(files['run/execution-provenance.json'])
    if presence['batch_run']:
        batch=json.loads(files['run/_batch/run.json'])
        if (batch.get('status')!='failed' or type(batch.get('controller_exit_code'))is not int
                or not batch['controller_exit_code'] or batch.get('run_id')!=meta['run_id'] or batch.get('execution_provenance')!=source):
            raise ValueError('current allocation original batch is not terminal failure')
    if presence['worker_ledger'] and files[prefix+'worker-clones.ids']:
        raise ValueError('current original has workers')
    runtime_present='registry/runtime-evidence-unconfirmed' in files
    if not runtime_present and not all('outer/'+name+'.json' in files for name in ('summary','manifest','threshold_parent','parent_term')):
        raise ValueError('absent runtime latch requires original outer terminal evidence')
    if all(presence.values()) and runtime_present: return
    summary=json.loads(files['outer/summary.json']);manifest=json.loads(files['outer/manifest.json'])
    threshold=json.loads(files['outer/threshold_parent.json']);term=json.loads(files['outer/parent_term.json'])
    total=summary.get('total_jobs');jobs=summary.get('jobs')
    if (type(total)is not int or total<=0 or not isinstance(jobs,list) or len(jobs)!=total
            or summary.get('status') not in {'cancelled','failed'} or type(summary.get('task_count'))is not int
            or type(summary.get('runs'))is not int or summary['task_count']*summary['runs']!=total):
        raise ValueError('outer original scheduled cohort differs')
    ids=[row['job_id'] for row in jobs]
    if (len(set(ids))!=total or set(manifest['jobs'])!=set(ids) or set(threshold['members'])!=set(ids)
            or len(threshold['members'])!=total or threshold['campaign_id']!=summary['campaign_id']
            or threshold['source_ref']!=source['base_sha'] or threshold['original_epoch']!=summary['e2e_started_at_epoch']
            or threshold['e2e_deadline_monotonic']!=manifest['e2e_deadline_monotonic']):
        raise ValueError('outer original manifest/source binding differs')
    log=files['controller.log'].decode();run=Path(meta['runs_root'])/meta['run_id']
    selected=[row for row in jobs if row.get('task')==Path(output).name and row.get('controller_pid')==int(meta['pid'])
              and 'monitor '+str(run) in log and 'owner: '+meta['fleet_owner_token']+';' in log
              and 'execution provenance: '+str(run/'execution-provenance.json') in log]
    if len(selected)!=1: raise ValueError('outer terminal job lacks exact original monitor/owner binding')
    job=selected[0]
    original_log=files['controller-log.path'].decode()
    if job.get('log')!=original_log or Path(original_log).stem!=job['job_id'] or Path(original_log).parent.name!=summary['campaign_id']:
        raise ValueError('outer terminal log identity differs')
    if manifest['jobs'][job['job_id']]!=int(meta['pid']) or job['startup_cohort']!=manifest['cohort_id']:
        raise ValueError('outer initial job PID differs')
    attempts=[row for row in job['attempts'] if row.get('controller_pid')==int(meta['pid']) and row.get('log')==job.get('log')]
    if len(attempts)!=1: raise ValueError('outer terminal attempt ambiguous')
    attempt=attempts[0]
    if (attempt.get('status') not in {'cancelled','failed'} or type(attempt.get('controller_exit_code'))is not int
            or attempt['controller_exit_code']==0 or job.get('status') not in {'cancelled','failed'}
            or job.get('controller_exit_code')!=attempt['controller_exit_code']):
        raise ValueError('outer original attempt is not a terminal abort/failure')
    start=datetime.fromisoformat(attempt['started_at']);finish=datetime.fromisoformat(attempt['finished_at']);end=datetime.fromisoformat(summary['finished_at'])
    if any(value.tzinfo is None or value.year<2000 for value in (start,finish,end)) or not start<=finish<=end:
        raise ValueError('outer original terminal clocks differ')
    if (term.get('parent_pid')!=threshold['parent_pid'] or term.get('parent_birth')!=threshold['parent_birth']
            or term.get('signal')!='SIGTERM' or term.get('child_or_group_signals') is not False):
        raise ValueError('outer original parent termination differs')
    originals=[fields_bytes(raw) for name,raw in files.items() if name.startswith('audit/fresh/')]
    expected_allocations=[fields_bytes(raw) for name,raw in files.items() if name.startswith('audit/expected-fresh/')]
    if not presence['worker_ledger']:
        if (len(originals)!=1 or len(expected_allocations)!=1
                or expected_allocations[0].get('clone_name')!=originals[0].get('clone_name')
                or expected_allocations[0].get('source_machine_id')!=originals[0].get('source_machine_id')):
            raise ValueError('missing worker ledger requires complete singleton original audit')


FIFO_METADATA = 'source-fifos.json'
FIFO_NAME = 'run/.native-retirement.pipe'


def current_fifo_stat(path, uid, gid):
    """Observe the one retained run FIFO without opening an IPC endpoint."""
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError('noncanonical current FIFO path')
    value = path.lstat()
    if (not stat.S_ISFIFO(value.st_mode) or value.st_size != 0 or value.st_nlink != 1
            or value.st_uid != uid or value.st_gid != gid or value.st_mode & 0o7000):
        raise ValueError('unsafe current FIFO metadata')
    return dict(device=value.st_dev,inode=value.st_ino,bytes=value.st_size,
        mtime_ns=value.st_mtime_ns,ctime_ns=value.st_ctime_ns,mode=value.st_mode,
        uid=value.st_uid,gid=value.st_gid,nlink=value.st_nlink,allocated_bytes=value.st_blocks*512)


def current_fifo_records(files, output=None):
    """Typed custody metadata is separate from regular original-file bytes."""
    if FIFO_NAME in files: raise ValueError('current FIFO represented as regular bytes')
    records = json.loads(files[FIFO_METADATA]) if FIFO_METADATA in files else {}
    if not isinstance(records,dict) or (records and set(records)!={FIFO_NAME}):
        raise ValueError('unexpected current FIFO inventory')
    for record in records.values():
        if (not isinstance(record,dict) or set(record)!={'kind','metadata_only','path','stat'}
                or record['kind']!='fifo' or record['metadata_only'] is not True
                or not isinstance(record['path'],str) or not Path(record['path']).is_absolute()
                or Path(record['path']).name!='.native-retirement.pipe'
                or str(Path(record['path']))!=record['path'] or record['path'].startswith('//')
                or '..' in Path(record['path']).parts):
            raise ValueError('invalid current FIFO record')
        value=record['stat']
        if (not isinstance(value,dict) or set(value)!={'device','inode','bytes','mtime_ns','ctime_ns','mode','uid','gid','nlink','allocated_bytes'}
                or any(type(v) is not int or v<0 for v in value.values())
                or not stat.S_ISFIFO(value['mode']) or value['mode'] & 0o7000
                or value['bytes']!=0 or value['nlink']!=1 or value['inode']==0):
            raise ValueError('invalid current FIFO stat')
        if output is not None and record['path']!=str(Path(output).parent/'.native-retirement.pipe'):
            raise ValueError('current FIFO original path differs')
    return records


def add_current_fifo(archive, name, record):
    """Use the controller-export FIFO/PAX convention; never synthesize content."""
    value=record['stat'];member=tarfile.TarInfo(name)
    member.type=tarfile.FIFOTYPE;member.size=0;member.mode=stat.S_IMODE(value['mode'])
    member.uid=value['uid'];member.gid=value['gid']
    seconds,nanos=divmod(value['mtime_ns'],1000000000)
    member.pax_headers['mtime']=str(seconds)+'.'+str(nanos).zfill(9)
    member.pax_headers['cloudbench.fifo-source-stat']=json.dumps(value,sort_keys=True,separators=(',',':'))
    archive.addfile(member)


def current_cold_files(registry, output, machine, token, controller_log, *, outer_files=None):
    registry, output = Path(registry), Path(output)
    meta = fields(registry/'meta'); audit = Path(meta['audit_dir']); run = output.parent
    if (registry.name != meta['fleet_owner_token'] or not re.fullmatch('[0-9a-f]{32}',registry.name)
            or meta['cleanup_policy'] != 'reap' or meta.get('version') != '2'
            or run != Path(meta['runs_root'])/meta['run_id'] or output.resolve(strict=True) != output):
        raise ValueError('current allocation lacks exact REAP source identity')
    if len(list((registry/'clones').iterdir())) != 1: raise ValueError('current allocation is not singleton')
    tasks = json.loads(read(run/'_batch/benches.json',1048576))
    ordinal = next(i for i,row in enumerate(tasks) if row['name'] == output.name)
    if token != registry.name+'-'+str(ordinal): raise ValueError('current allocation task differs')
    source = json.loads(read(run/'execution-provenance.json',1048576))
    matrix = json.loads(read(run/'execution-task-matrix.json',1048576))
    contract = runpy.run_path(str(Path(__file__).with_name('cloudbench_execution_provenance.py')))
    if contract['validate_task_matrix_binding'](source,matrix): raise ValueError('current original provenance invalid')
    batch_path=run/'_batch/run.json';worker_path=output/'worker-clones.ids'
    if (not batch_path.exists() or not worker_path.exists()) and not outer_files:
        raise ValueError('missing local terminal or worker ledger requires original outer evidence')
    audit_meta = fields(audit/'meta')
    if any(meta[k] != audit_meta[k] for k in ('app','run_id','fleet_owner_token')): raise ValueError('current original audit differs')
    originals = [fields(x) for x in (audit/'fresh').iterdir()]
    matches = [x for x in originals if x.get('machine_id') == machine]
    if len(matches)!=1: raise ValueError('current original allocation ambiguous')
    original=matches[0]
    if (original.get('disposition') != 'owned' or any(original[k] != meta[k] for k in ('app','run_id','fleet_owner_token'))
            or fields(registry/'clones'/original['clone_name']) != dict(name=original['clone_name'],id=machine,volume_id=original['volume_id'])
            or any(x.get('source_machine_id') == machine and x.get('machine_id') for x in originals)):
        raise ValueError('current original allocation/worker differs')
    if read(output/'primary.ids',65536).splitlines() != [machine.encode()]: raise ValueError('current primary ledger differs')
    read(output/'primary.log')
    if worker_path.exists() or worker_path.is_symlink():
        if read(worker_path,65536): raise ValueError('current original has workers')
    # These latches remain originals and are never consumed by this policy.
    runtime_latch=registry/'runtime-evidence-unconfirmed'
    if runtime_latch.exists() or runtime_latch.is_symlink():
        read(runtime_latch,65536)
    elif not outer_files:
        raise ValueError('absent runtime latch requires original outer terminal evidence')
    guest_latch=registry/'guest-cleanup-unconfirmed'
    if guest_latch.exists() or guest_latch.is_symlink(): read(guest_latch,65536)
    paths={'capture-helper.py':Path(__file__),'controller.log':Path(controller_log)}
    for label,root in (('registry',registry),('audit',audit),('run',run)):
        for parent,dirs,names in os.walk(root,followlinks=False):
            parent=Path(parent)
            dirs[:] = [name for name in dirs if not (parent==output and name=='allocated-current-cold')]
            if parent==run and '.native-retirement.pipe' in dirs: raise ValueError('current FIFO became a directory')
            if any((parent/name).is_symlink() for name in dirs): raise ValueError('linked current original directory')
            for name in names:
                path=parent/name
                if label=='registry' and name.startswith(('.handoff-retain-','cold-handoff-outgoing')): continue
                paths[label+'/'+str(path.relative_to(root))]=path
    files={};fifos={};remaining=MAXIMUM
    owner_stat=(registry/'meta').stat()
    for name,path in paths.items():
        info=path.lstat()
        if info.st_uid != (registry/'meta').stat().st_uid or info.st_nlink != 1: raise ValueError('current original ownership changed')
        if name==FIFO_NAME:
            fifos[name]=dict(kind='fifo',metadata_only=True,path=str(path),
                stat=current_fifo_stat(path,owner_stat.st_uid,owner_stat.st_gid))
        else:
            if not stat.S_ISREG(info.st_mode): raise ValueError('unsafe original evidence file')
            files[name]=read(path,remaining);remaining-=len(files[name])
    if fifos: files[FIFO_METADATA]=json.dumps(fifos,sort_keys=True,separators=(',',':')).encode()
    files['controller-log.path']=str(Path(controller_log)).encode()
    if outer_files: files.update(outer_files)
    files['source-local-presence.json']=json.dumps({'batch_run':batch_path.exists(),'worker_ledger':worker_path.exists()},sort_keys=True).encode()
    files['source-latches.json']=json.dumps({name:({'present':True,'sha256':digest(files['registry/'+name])} if 'registry/'+name in files else {'present':False})
        for name in ('guest-cleanup-unconfirmed','runtime-evidence-unconfirmed')},sort_keys=True).encode()
    if len(files)>1030 or sum(map(len,files.values()))>MAXIMUM: raise ValueError('current originals exceed file bound')
    validate_current_source_termination(files,meta,output,token)
    return meta,original,files


def current_cold_native(machine, original, before, after, volume, reader=read):
    proof=preconfig_native_proof(machine,original,before,after,reader)
    native=json.loads(reader(before,1048576));vol=json.loads(reader(volume,1048576))
    if native['state']!='stopped' or vol.get('id')!=original['volume_id'] or vol.get('attached_machine_id')!=machine or vol.get('state')!='created':
        raise ValueError('current cold allocation is not stopped with original volume')
    guest=native['config'].get('guest',{})
    if guest.get('cpu_kind') not in ('shared','performance') or any(type(guest.get(k)) is not int or guest[k]<=0 for k in ('cpus','memory_mb')):
        raise ValueError('current native profile missing')
    return proof


def validate_recorded_current_guest(value,machine,token,collector_bytes,expected_sha):
    """Check historical guest semantics against trusted code; never execute it."""
    if (not isinstance(collector_bytes,bytes) or len(collector_bytes)>1048576
            or not isinstance(expected_sha,str) or re.fullmatch('[0-9a-f]{64}',expected_sha) is None
            or digest(collector_bytes)!=expected_sha or value.get('collector_sha256')!=expected_sha):
        raise ValueError('original guest collector source binding differs')
    # Exact executed/recovered pilot collector, independently approved before the
    # current host-only intake changes. Caller-provided digests add no authority.
    approved_historical={'6ec98ff9d0e748843da1219dba61f745830c0e2212b780e3305cbeda345914c3'} | CURRENT_COLD_APPROVED_CAPTURE_HELPERS
    if expected_sha not in approved_historical | {digest(Path(__file__).read_bytes())}:
        raise ValueError('original collector guest semantics lack approved source binding')
    names={'validate_current_cold_guest','capture_current_cold_guest','observe_current_cold_processes',
        'current_cold_mount','current_cold_dependencies','original_names','original_files',
        'read','digest','durable_handoff_json','handoff_directory'}
    class NormalizeValidator(ast.NodeTransformer):
        def visit_FunctionDef(self,node):
            if node.name=='validate_current_cold_guest':
                if len(node.args.kwonlyargs)==1 and node.args.kwonlyargs[0].arg=='expected_collector_sha256':
                    node.args.kwonlyargs=[];node.args.kw_defaults=[]
            return self.generic_visit(node)
        def visit_BoolOp(self,node):
            if (isinstance(node.op,ast.Or) and len(node.values)==2
                    and isinstance(node.values[0],ast.Name) and node.values[0].id=='expected_collector_sha256'
                    and ast.dump(node.values[1])==ast.dump(ast.parse('digest(Path(__file__).read_bytes())',mode='eval').body)):
                return node.values[1]
            return self.generic_visit(node)
    def contract(raw):
        tree=ast.parse(raw)
        result={}
        for node in tree.body:
            if isinstance(node,ast.FunctionDef) and node.name in names:
                if node.name in result: raise ValueError('duplicate original collector semantics')
                result[node.name]=ast.dump(NormalizeValidator().visit(node),include_attributes=False)
            if isinstance(node,ast.Assign):
                for target in node.targets:
                    if isinstance(target,ast.Name) and target.id in {'CURRENT_COLD_SCHEMA','MAXIMUM'}:
                        if target.id in result: raise ValueError('duplicate original collector semantics')
                        result[target.id]=ast.dump(node.value,include_attributes=False)
        if set(result)!=names|{'CURRENT_COLD_SCHEMA','MAXIMUM'}:
            raise ValueError('incomplete original collector semantics')
        return result
    try:
        matches=contract(collector_bytes)==contract(Path(__file__).read_bytes())
    except (SyntaxError,UnicodeError) as error:
        raise ValueError('unparseable original collector semantics') from error
    if not matches: raise ValueError('original collector guest semantics differ from trusted source')
    validate_current_cold_guest(value,machine,token,expected_collector_sha256=expected_sha)


def capture_current_cold(registry,output,machine,token,destination,before,after,volume,guest,controller_log,image,capture_nonce,*,guest_collector_source=None,guest_collector_sha256=None,outer_terminal=None):
    outer_files=read_outer_terminal(outer_terminal) if outer_terminal is not None else None
    meta,original,files=current_cold_files(registry,output,machine,token,controller_log,outer_files=outer_files)
    current_cold_native(machine,original,before,after,volume)
    if json.loads(read(before,1048576))['config']['image']!=image: raise ValueError('current image differs from explicit pinned image')
    guest_raw=read(guest,MAXIMUM);value=json.loads(guest_raw)
    if (guest_collector_source is None)!=(guest_collector_sha256 is None): raise ValueError('original collector path and SHA must be supplied together')
    collector_bytes=read(guest_collector_source,1048576) if guest_collector_source is not None else Path(__file__).read_bytes()
    collector_sha=guest_collector_sha256 if guest_collector_source is not None else digest(collector_bytes)
    validate_recorded_current_guest(value,machine,token,collector_bytes,collector_sha)
    if value['native_instance']!=json.loads(read(before,1048576))['instance_id'] or value['capture_nonce']!=capture_nonce:
        raise ValueError('current guest belongs to another native instance/capture')
    provenance=json.loads(files['run/execution-provenance.json'])['config']['values']
    if value['dependencies'] != dict(node=provenance['node_dependency_fingerprint'],python=provenance['python_dependency_fingerprint']):
        raise ValueError('current image dependencies differ from original source')
    shapes=set()
    for prefix in ('primary','bundled_frontend'):
        size=provenance.get(prefix+'_vm_size','');memory=provenance.get(prefix+'_vm_memory_mb','')
        match=re.fullmatch('(shared-cpu|performance)-([1-9][0-9]*)x',size)
        if match and memory.isdecimal():shapes.add(('shared' if match[1]=='shared-cpu' else 'performance',int(match[2]),int(memory)))
    guest_shape=json.loads(read(before,1048576))['config']['guest']
    if (guest_shape['cpu_kind'],guest_shape['cpus'],guest_shape['memory_mb']) not in shapes:
        raise ValueError('current primary shape differs from original provenance')
    files['current/guest.json']=guest_raw
    files['current/controller-log-path']=str(Path(controller_log)).encode()
    files['current/intent.json']=json.dumps(dict(image=image,capture_nonce=capture_nonce,guest_collector_sha256=collector_sha),sort_keys=True).encode()
    files['current/guest-collector.py']=collector_bytes
    files['current/volume.json']=read(volume,1048576)
    files['current/native-before.json']=read(before,1048576);files['current/native-after.json']=read(after,1048576)
    fifos=current_fifo_records(files,output)
    manifest=dict(schema=CURRENT_COLD_SCHEMA,machine_id=machine,run_token=token,proof_credit=0,
        files={name:dict(bytes=len(raw),sha256=digest(raw)) for name,raw in files.items()})
    if fifos: manifest['fifos']=fifos
    destination=Path(destination)
    with os.fdopen(os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
        with tarfile.open(fileobj=stream,mode='w:gz') as archive:
            for name,raw in {**files,'capture-manifest.json':json.dumps(manifest,sort_keys=True).encode()}.items():
                item=tarfile.TarInfo(name);item.size=len(raw);item.mode=0o600;archive.addfile(item,io.BytesIO(raw))
            for name,record in fifos.items():add_current_fifo(archive,name,record)
        stream.flush();os.fsync(stream.fileno())
    if current_cold_files(registry,output,machine,token,controller_log,outer_files=outer_files)[2] != {k:v for k,v in files.items() if not k.startswith('current/')}:
        raise ValueError('current originals changed during capture')


def read_current_cold_archive(path,reader=read):
    return read_preconfig_archive(path,reader,schema=CURRENT_COLD_SCHEMA)


def validate_current_cold_semantics(files,registry,output,machine,token):
    meta,original=archived_current_cold_identity(files,registry,output,machine,token)
    current_fifo_records(files,output)
    intent=json.loads(files['current/intent.json'])
    if set(intent)!={'image','capture_nonce','guest_collector_sha256'} or not re.fullmatch(r'.+@sha256:[0-9a-f]{64}',intent['image']):
        raise ValueError('current capture lacks explicit pinned image')
    guest=json.loads(files['current/guest.json']);validate_recorded_current_guest(guest,machine,token,files['current/guest-collector.py'],intent['guest_collector_sha256'])
    first=json.loads(files['current/native-before.json'])
    if first['config']['image']!=intent['image'] or guest['native_instance']!=first['instance_id'] or guest['capture_nonce']!=intent['capture_nonce']:
        raise ValueError('current guest/native capture intent differs')
    reader=lambda path,maximum=MAXIMUM: files['current/'+path+'.json']
    current_cold_native(machine,original,'native-before','native-after','volume',reader)
    values=json.loads(files['run/execution-provenance.json'])['config']['values']
    if guest['dependencies']!=dict(node=values['node_dependency_fingerprint'],python=values['python_dependency_fingerprint']):
        raise ValueError('current image dependency proof differs')
    shapes=set()
    for prefix in ('primary','bundled_frontend'):
        match=re.fullmatch('(shared-cpu|performance)-([1-9][0-9]*)x',values.get(prefix+'_vm_size',''))
        memory=values.get(prefix+'_vm_memory_mb','')
        if match and memory.isdecimal():shapes.add(('shared' if match[1]=='shared-cpu' else 'performance',int(match[2]),int(memory)))
    profile=first['config']['guest']
    if (profile['cpu_kind'],profile['cpus'],profile['memory_mb']) not in shapes:
        raise ValueError('current archived primary profile differs')
    return meta,original


def commit_current_cold(registry,output,machine,token,archive,before,after,volume,receipt):
    raw,files,manifest=read_current_cold_archive(archive)
    validate_current_cold_semantics(files,registry,output,machine,token)
    # Source original identity is rechecked without manufacturing missing terminal files.
    meta,original,expected=current_cold_files(registry,output,machine,token,Path(files['current/controller-log-path'].decode()),outer_files={k:v for k,v in files.items() if k.startswith('outer/')})
    if {k:v for k,v in files.items() if not k.startswith('current/')} != expected: raise ValueError('current custody differs')
    proof=current_cold_native(machine,original,before,after,volume)
    for name,path in [('native-before',before),('native-after',after),('volume',volume)]:
        if files['current/'+name+'.json'] != read(path,1048576): raise ValueError('current native capture changed')
    value=dict(schema=CURRENT_COLD_SCHEMA,archive_path=str(archive),archive_sha256=digest(raw),machine_id=machine,
        volume_id=original['volume_id'],run_token=token,owner=meta['fleet_owner_token'],source_ref=json.loads(files['run/execution-provenance.json'])['base_sha'],
        historical_runtime='UNKNOWN',runtime_evidence_complete=False,native_release_verified=False,proof_credit=0,
        source_latches=json.loads(files['source-latches.json']),
        current_isolation_verified=True,**proof)
    durable_handoff_json(receipt,value)
    return value


def archived_current_cold_identity(files,registry,output,machine,token):
    meta=fields_bytes(files['registry/meta'])
    candidates=[fields_bytes(v) for k,v in files.items() if k.startswith('audit/fresh/')]
    matches=[row for row in candidates if row.get('machine_id')==machine]
    if len(matches)!=1: raise ValueError('archived current primary ambiguous')
    original=matches[0]
    run=Path(meta['runs_root'])/meta['run_id'];output=Path(output)
    tasks=json.loads(files['run/_batch/benches.json'])
    ordinal=next(i for i,row in enumerate(tasks) if row['name']==output.name)
    if (meta.get('version')!='2' or meta['cleanup_policy']!='reap' or meta['fleet_owner_token']!=Path(registry).name
            or output!=run/output.name or token!=meta['fleet_owner_token']+'-'+str(ordinal)
            or original.get('disposition')!='owned' or any(original[k]!=meta[k] for k in ('app','run_id','fleet_owner_token'))
            or any(row.get('source_machine_id')==machine and row.get('machine_id') for row in candidates)):
        raise ValueError('archived current source identity differs')
    clones=[fields_bytes(v) for k,v in files.items() if k.startswith('registry/clones/')]
    if clones!=[dict(name=original['clone_name'],id=machine,volume_id=original['volume_id'])]:
        raise ValueError('archived current cohort differs')
    audit_meta=fields_bytes(files['audit/meta'])
    if any(audit_meta[k]!=meta[k] for k in ('app','run_id','fleet_owner_token')):
        raise ValueError('archived current audit differs')
    prefix='run/'+output.name+'/'
    if files[prefix+'primary.ids'].splitlines()!=[machine.encode()] or files.get(prefix+'worker-clones.ids',b''):
        raise ValueError('archived current primary/workers differ')
    files[prefix+'primary.log'];files['controller.log']
    source_latches=json.loads(files['source-latches.json'])
    expected_latches={name:({'present':True,'sha256':digest(files['registry/'+name])} if 'registry/'+name in files else {'present':False})
        for name in ('guest-cleanup-unconfirmed','runtime-evidence-unconfirmed')}
    validate_source_latches(source_latches,files)
    if source_latches!=expected_latches: raise ValueError('archived source latch presence differs')
    source=json.loads(files['run/execution-provenance.json']);matrix=json.loads(files['run/execution-task-matrix.json'])
    contract=runpy.run_path(str(Path(__file__).with_name('cloudbench_execution_provenance.py')))
    if contract['validate_task_matrix_binding'](source,matrix): raise ValueError('archived current provenance differs')
    validate_current_source_termination(files,meta,output,token)
    return meta,original


def current_recovery_overlay(registry):
    """An actual inherited locked descriptor plus live ancestor owns this overlay.

    Historical recovery-lock bytes remain in the immutable archive. A different
    lock is never ignored just because its filename looks operational.
    """
    registry=Path(registry);lock=registry/'recovery-lock'
    if not lock.exists() and not lock.is_symlink(): return False
    if lock.is_symlink() or not lock.is_dir() or {p.name for p in lock.iterdir()}!={'meta'}:
        raise ValueError('unverified current recovery lock')
    meta=fields(lock/'meta')
    if set(meta)!={'host','pid','pid_start'} or meta['host']!=os.uname().nodename:
        raise ValueError('foreign current recovery lock')
    pid=int(meta['pid']);ancestor=os.getpid();ancestors=set()
    while ancestor>0 and ancestor not in ancestors:
        ancestors.add(ancestor)
        raw=Path('/proc',str(ancestor),'stat').read_text();parts=raw[raw.rfind(')')+2:].split()
        ancestor=int(parts[1])
    raw=Path('/proc',str(pid),'stat').read_text();parts=raw[raw.rfind(')')+2:].split()
    birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+parts[19]
    if pid not in ancestors or meta['pid_start']!=birth:
        raise ValueError('current recovery lock is not the invoking live ancestor')
    descriptor=int(os.environ['CLOUDBENCH_RECOVERY_GUARD_FD'])
    guard=registry.parent.parent/'cloudbench-fleet-recovery-locks'/registry.name
    opened=os.fstat(descriptor);expected=guard.lstat()
    if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink!=1 or guard.is_symlink()
            or (opened.st_dev,opened.st_ino)!=(expected.st_dev,expected.st_ino)
            or 'FLOCK  ADVISORY  WRITE' not in Path('/proc/self/fdinfo',str(descriptor)).read_text()):
        raise ValueError('current recovery descriptor is not the held exact guard')
    return True


def verify_current_cold_receipt(registry,output,machine,token,receipt,before,after,*,originals=None):
    reader=sealed_original_reader(originals) if originals is not None else read
    phase=json.loads(reader(receipt,1048576));raw,files,manifest=read_current_cold_archive(phase['archive_path'],reader)
    if (phase.get('schema')!=CURRENT_COLD_SCHEMA or phase.get('archive_sha256')!=digest(raw)
            or phase.get('machine_id')!=machine or phase.get('run_token')!=token or phase.get('owner')!=Path(registry).name
            or phase.get('historical_runtime')!='UNKNOWN' or phase.get('runtime_evidence_complete') is not False
            or phase.get('native_release_verified') is not False or phase.get('proof_credit')!=0 or phase.get('current_isolation_verified') is not True
            or manifest['machine_id']!=machine or manifest['run_token']!=token
            or digest(files['capture-helper.py']) not in CURRENT_COLD_APPROVED_CAPTURE_HELPERS | {digest(Path(__file__).read_bytes())}):
        raise ValueError('current phase custody binding differs')
    meta,original=validate_current_cold_semantics(files,registry,output,machine,token)
    validate_source_latches(phase.get('source_latches'),files)
    if phase.get('source_latches')!=json.loads(files['source-latches.json']): raise ValueError('current receipt latch presence differs')
    if original.get('machine_id')!=machine or original.get('volume_id')!=phase['volume_id'] or meta['fleet_owner_token']!=phase['owner']:
        raise ValueError('current archived owner differs')
    guest=json.loads(files['current/guest.json'])
    values=json.loads(files['run/execution-provenance.json'])['config']['values']
    if guest['dependencies']!=dict(node=values['node_dependency_fingerprint'],python=values['python_dependency_fingerprint']):
        raise ValueError('imported current image dependencies differ')
    # The receipt's native originals belong to the source seal. Destination
    # observations never become sealed originals or fall back through its reader.
    source_native=current_cold_native(machine,original,phase['native_before_path'],phase['native_after_path'],
        phase['archive_path'],lambda p,n=MAXIMUM: files['current/volume.json'] if p==phase['archive_path'] else reader(p,n))
    if any(source_native[key]!=phase.get(key) for key in source_native):
        raise ValueError('sealed current allocated config changed')
    if Path(before).samefile(after):
        raise ValueError('fresh native observations reuse the same file')
    native=current_cold_native(machine,original,before,after,phase['archive_path'],
        lambda p,n=MAXIMUM: files['current/volume.json'] if p==phase['archive_path'] else read(p,n))
    if native['config_sha256']!=phase['config_sha256'] or native['instance_id']!=phase['instance_id']:
        raise ValueError('current allocated config changed')
    if originals is None:
        original_meta=files['registry/meta'];actual_meta=read(Path(registry)/'meta',65536)
        retained=original_meta.replace(b'cleanup_policy=reap\n',b'cleanup_policy=retain\n')
        if actual_meta!=original_meta and not ((Path(registry)/'cold-handoff-outgoing').is_file() and actual_meta==retained):
            raise ValueError('current source owner policy changed')
        overlay=current_recovery_overlay(registry)
        # Re-enumerate the complete captured namespaces, including additions.
        for label,path in [('registry',Path(registry)),('audit',Path(meta['audit_dir'])),('run',Path(output).parent)]:
            actual=set()
            for parent,dirs,names in os.walk(path,followlinks=False):
                parent=Path(parent)
                dirs[:]=[name for name in dirs if not (parent==Path(output) and name=='allocated-current-cold')
                         and not (overlay and parent==Path(registry) and name=='recovery-lock')]
                if any((parent/name).is_symlink() for name in dirs): raise ValueError('current source gained linked directory')
                for name in names:
                    if label=='registry' and (name=='cold-handoff-outgoing' or name.startswith('.handoff-retain-')): continue
                    relative=label+'/'+str((parent/name).relative_to(path));actual.add(relative)
                    fifos=current_fifo_records(files,output)
                    if relative in fifos:
                        record=fifos[relative]
                        if (str(parent/name)!=record['path'] or current_fifo_stat(parent/name,record['stat']['uid'],record['stat']['gid'])!=record['stat']):
                            raise ValueError('current preserved FIFO changed')
                    elif relative!='registry/meta':
                        if not stat.S_ISREG((parent/name).lstat().st_mode) or read(parent/name)!=files.get(relative):
                            raise ValueError('current preserved original changed')
            expected_names={name for name in set(files)|set(current_fifo_records(files,output)) if name.startswith(label+'/') and not (overlay and name.startswith('registry/recovery-lock/'))}
            if actual != expected_names:
                raise ValueError('current preserved original inventory changed')
        if read(Path(files['current/controller-log-path'].decode()))!=files['controller.log']:
            raise ValueError('current controller log changed')

    return phase


def verify_handoff_phase(registry,output,machine,token,receipt,before,after,*,originals=None):
    reader=sealed_original_reader(originals) if originals is not None else read
    if json.loads(reader(receipt,1048576)).get('schema') == CURRENT_COLD_SCHEMA:
        return verify_current_cold_receipt(registry,output,machine,token,receipt,before,after,originals=originals)
    return verify_preconfig_receipt(registry,output,machine,token,receipt,before,after,originals=originals)


def handoff_archive(phase,reader=read):
    if phase['schema']==CURRENT_COLD_SCHEMA: return read_current_cold_archive(phase['archive_path'],reader)
    return read_preconfig_archive(phase['archive_path'],reader)


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
    if (common/'cloudbench-pool-claims'/machine).exists() or (common/'cloudbench-pool-claims'/machine).is_symlink():
        raise ValueError('source allocation has a pending claim')
    for ledger in (common / 'cloudbench-pools').glob('*.ids'):
        if machine in read(ledger).decode().splitlines():
            raise ValueError('source allocation already belongs to a local pool')
    phase = verify_handoff_phase(registry, output, machine, token, receipt, before, after)
    current_phase = phase["schema"] == CURRENT_COLD_SCHEMA
    for path in (output / "runtime-evidence.pending", registry / "guest-cleanup-unconfirmed",
                 registry / "runtime-evidence-unconfirmed", output / "post-config-start.accepted",
                 output / "cloudbench-run.json", output / "worker-runtime-evidence",
                 output / "status-proxy.port", output / "cloudbench-boot-start.log", output / "guest-shutdown.confirmed"):
        if current_phase and path in (output / "runtime-evidence.pending", registry / "guest-cleanup-unconfirmed", registry / "runtime-evidence-unconfirmed"):
            continue  # The new destination inherits the archived preservation obligation.
        if path.exists() or path.is_symlink():
            raise ValueError("unconsumed, guest-quarantined or admitted handoff")
    if not current_phase and (read(output / "benchmark-child.finished", 32).strip() != b"125"
            or read(output / "boot-config-unapplied", 256).strip() != machine.encode()
            or read(output / "worker-clones.ids", 65536)):
        raise ValueError("current source phase changed after archival")
    raw, files, manifest = handoff_archive(phase)
    if current_phase:
        original = next(fields_bytes(v) for k,v in files.items() if k.startswith('audit/fresh/') and fields_bytes(v).get('machine_id')==machine)
    else:
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
    phase = verify_handoff_phase(packet["registry"], packet["output"], packet["machine_id"],
             packet["run_token"], packet["receipt"], before, after, originals=packet["originals"])
    native = handoff_native_pair(before, after, packet["machine_id"], packet["volume_id"], packet["native"]["name"])
    if native != packet["native"] or phase["owner"] != packet["owner"]:
        raise ValueError("current imported primary differs from committed allocation")
    return phase



def verify_target_source_successor(descriptor, packet, target, *, live=True):
    if not isinstance(descriptor,dict) or set(descriptor)!={'path','sha256'}:
        raise ValueError('target source successor descriptor differs')
    raw=read(descriptor['path'],1048576)
    if digest(raw)!=descriptor['sha256']:raise ValueError('target source successor receipt changed')
    value=json.loads(raw)
    verifier=runpy.run_path(str(Path(__file__).with_name('cloudbench-retained-controller-endpoint.py')))
    return verifier['verify_target_source_successor'](value,packet,target,live=live)


def successor_file_binding(path):
    path=Path(path)
    raw=read(path)
    info=path.lstat()
    if info.st_uid!=os.getuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)&0o077:
        raise ValueError('successor completion file is not private exact-owner')
    return dict(path=str(path),sha256=digest(raw),device=info.st_dev,inode=info.st_ino,
                uid=info.st_uid,mode=info.st_mode,size=info.st_size)


def complete_target_source_successor(common, packet, descriptor, verified, authority):
    # Called only after canonical audit and terminal are durably committed.
    common=Path(common);machine=packet['machine_id']
    bindings={key:successor_file_binding(common/'cloudbench-cold-handoffs'/directory/(machine+'.json'))
              for key,directory in (('terminal','imported'),('audit','audit'))}
    if any(json.loads(read(item['path']))!=authority for item in bindings.values()):
        raise ValueError('successor completion lacks exact import terminal/audit')
    value=dict(schema='cloudbench-target-source-successor-completed-v1',
               successor=successor_file_binding(descriptor['path']),packet_sha256=authority['packet_sha256'],
               original_target=packet['target'],current_target=verified['current_target'],
               continuation=verified['continuation'],root_anchors=verified['root_anchors'],bindings=bindings)
    path=common/'cloudbench-cold-handoffs/successors'/(machine+'.json')
    durable_handoff_json(path,value)


def verify_completed_target_source_successor(common, packet, descriptor, target):
    common=Path(common);machine=packet['machine_id']
    path=common/'cloudbench-cold-handoffs/successors'/(machine+'.json')
    successor_file_binding(path)
    value=json.loads(read(path))
    if set(value)!={'schema','successor','packet_sha256','original_target','current_target','continuation','root_anchors','bindings'} or value['schema']!='cloudbench-target-source-successor-completed-v1':
        raise ValueError('invalid successor completion')
    binding=successor_file_binding(descriptor['path'])
    if value['successor']!=binding or binding['sha256']!=descriptor['sha256']:
        raise ValueError('successor completion proof binding changed')
    proof=json.loads(read(descriptor['path']))
    if (value['original_target']!=packet['target'] or value['current_target']!=target
            or value['packet_sha256']!=proof['packet_sha256']
            or value['continuation']!=proof['continuation'] or value['root_anchors']!=proof['root_anchors']):
        raise ValueError('successor completion endpoint/continuation differs')
    authority=dict(schema=HANDOFF_SCHEMA,nonce=packet['nonce'],packet_sha256=value['packet_sha256'],
                   target=packet['target'],machine_id=machine,volume_id=packet['volume_id'],target_source_successor=descriptor)
    if set(value['bindings'])!={'terminal','audit'}:raise ValueError('successor completion terminal set differs')
    for key,directory in (('terminal','imported'),('audit','audit')):
        expected=common/'cloudbench-cold-handoffs'/directory/(machine+'.json')
        if value['bindings'][key]!=successor_file_binding(expected) or json.loads(read(expected))!=authority:
            raise ValueError('successor completion terminal/audit changed')
    return verify_target_source_successor(descriptor,packet,target,live=False)


def import_cold_handoff(common, target, packet_path, before, after, checkpoint=lambda stage: None, *, target_source_successor=None):
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
    if target_source_successor is not None:
        verified_successor=verify_target_source_successor(target_source_successor,packet,target)
        target=handoff_target(packet['target'])
    phase = verify_imported_cold_handoff(packet, target, before, after)
    machine, volume = packet["machine_id"], packet["volume_id"]
    claims = common / "cloudbench-pool-claims"; handoff_directory(claims)
    lockdir = claims / ".locks"; handoff_directory(lockdir)
    if claims.resolve(strict=True) != claims or lockdir.resolve(strict=True) != lockdir: raise ValueError("linked claim directory")
    with os.fdopen(os.open(lockdir / (machine + ".lock"), os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600), "wb") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        authority = {"schema": HANDOFF_SCHEMA, "nonce": packet["nonce"], "packet_sha256": digest(packet_raw),
                     "target": target, "machine_id": machine, "volume_id": volume}
        if target_source_successor is not None:authority["target_source_successor"]=target_source_successor
        terminal = common / "cloudbench-cold-handoffs/imported" / (machine + ".json")
        if terminal.exists():
            if json.loads(read(terminal)) != authority:
                raise ValueError("different handoff already owns destination MID")
            if target_source_successor is not None:
                complete_target_source_successor(common,packet,target_source_successor,verified_successor,authority)
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
        if target_source_successor is not None:proof["imported_cold"]["target_source_successor"]=target_source_successor
        # Recover the real app from immutable source archive rather than its
        # filesystem location or a fabricated destination source registry.
        reader = sealed_original_reader(packet["originals"])
        _, files, _ = handoff_archive(phase, reader)
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
        if target_source_successor is not None:
            complete_target_source_successor(common,packet,target_source_successor,verified_successor,authority)
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
    successor=imported.get('target_source_successor')
    if (str(Path(common).resolve(strict=True)) != imported["target"]["common"]
            or imported["target"]["machine"] != os.environ.get("FLY_MACHINE_ID")
            or (successor is None and imported["target"]["source_ref"] != expected_source)):
        raise ValueError("imported proof used in foreign controller/common/source")
    raw = read(imported["packet_path"])
    if digest(raw) != imported["packet_sha256"]:
        raise ValueError("imported original packet changed")
    packet = json.loads(raw)
    if successor is not None:
        current_target=dict(imported['target'],source_ref=expected_source)
        verify_completed_target_source_successor(common,packet,successor,current_target)
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
    parser.add_argument("action", choices=("eligible", "capture", "verify", "eligible-preconfig", "capture-preconfig", "verify-preconfig", "commit-preconfig", "verify-preconfig-receipt", "capture-current-cold-guest", "capture-current-cold", "commit-current-cold", "verify-current-cold"))
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
    parser.add_argument("--guest", type=Path)
    parser.add_argument("--controller-log", type=Path)
    parser.add_argument("--volume", type=Path)
    parser.add_argument("--image")
    parser.add_argument("--native-instance")
    parser.add_argument("--capture-nonce")
    parser.add_argument("--guest-collector-source",type=Path)
    parser.add_argument("--guest-collector-sha256")
    parser.add_argument("--outer-terminal",type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "capture-current-cold-guest":
        if args.root != Path('/data') or os.environ.get('FLY_MACHINE_ID') != args.machine:
            raise ValueError('current guest collector requires native /data and exact Machine')
        previous_handler=signal.getsignal(signal.SIGALRM)
        previous_timer=signal.getitimer(signal.ITIMER_REAL)
        started=time.monotonic()
        def expired(*unused): raise TimeoutError('current cold guest observation exceeded absolute deadline')
        signal.signal(signal.SIGALRM,expired)
        signal.setitimer(signal.ITIMER_REAL,min(30,previous_timer[0]) if previous_timer[0]>0 else 30)
        try:
            capture_current_cold_guest(Path('/data'),args.run_token,args.receipt,args.native_instance,args.capture_nonce)
        finally:
            signal.setitimer(signal.ITIMER_REAL,0)
            signal.signal(signal.SIGALRM,previous_handler)
            if previous_timer[0]>0:
                signal.setitimer(signal.ITIMER_REAL,max(0.000001,previous_timer[0]-(time.monotonic()-started)),previous_timer[1])
    elif args.action == "capture-current-cold":
        capture_current_cold(args.registry,args.output,args.machine,args.run_token,args.archive,
            args.native_before,args.native_after,args.volume,args.guest,args.controller_log,args.image,args.capture_nonce,
            guest_collector_source=args.guest_collector_source,guest_collector_sha256=args.guest_collector_sha256,
            outer_terminal=json.loads(read(args.outer_terminal,1048576)) if args.outer_terminal else None)
    elif args.action == "commit-current-cold":
        commit_current_cold(args.registry,args.output,args.machine,args.run_token,args.archive,
            args.native_before,args.native_after,args.volume,args.receipt)
    elif args.action == "verify-current-cold":
        print(json.dumps(verify_current_cold_receipt(args.registry,args.output,args.machine,args.run_token,args.receipt,
            args.native_before,args.native_after),sort_keys=True))
    elif args.action == "capture-preconfig":
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
