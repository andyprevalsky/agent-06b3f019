#!/usr/bin/env python3
"""Supplemental Machine-only recovery receipts; all volumes/ledgers stay owned.

This helper never clears a fleet latch or supplies benchmark credit. The caller
holds the exact stale-owner recovery lock and verifies native Machine absence.
"""
import argparse
import hashlib
import json
import os
import re
import runpy
import shlex
import stat
import sys
import time
from pathlib import Path

SCHEMA = "cloudbench-sealed-machine-retirement-v1"
NATIVE_INVENTORY_LIMIT = 128 * 1024 * 1024
REFUSAL_STAGE = "source-binding"


def read(path, limit=1048576):
    path = Path(path)
    assert path.resolve(strict=True) == path
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        before = os.fstat(stream.fileno())
        assert stat.S_ISREG(before.st_mode) and before.st_size <= limit
        data = stream.read(before.st_size + 1)
        assert len(data) == before.st_size
        after = path.stat()
        assert (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)
        os.fsync(stream.fileno())
        return data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def fields(path):
    pairs = [line.split("=", 1) for line in read(path, 65536).decode().splitlines()]
    assert all(len(pair) == 2 for pair in pairs)
    result = dict(pairs)
    assert len(result) == len(pairs)
    return result


def obj(path, limit=1048576):
    return json.loads(read(path, limit))


def publish(path, value):
    assert path.parent.resolve() == path.parent and not path.parent.is_symlink()
    if path.exists() or path.is_symlink():
        assert obj(path) == value
        return
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("xb") as stream:
        os.chmod(temporary, 0o600)
        stream.write(canonical(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def binding(registry, machine, app, *, completed_original=False, native_config=None, native_machines=None):
    assert re.fullmatch(r"[0-9a-f]{32}", registry.name)
    assert re.fullmatch(r"[0-9a-f]+", machine)
    assert registry.resolve() == registry and not registry.is_symlink()
    meta = fields(registry / "meta")
    owner = registry.name
    assert meta["version"] == "2" and meta["fleet_owner_token"] == owner
    assert meta["app"] == app
    # Read-only recognition runs before the normal ACK consumer changes a
    # quarantined retain policy. Retirement commands still require reap.
    assert meta["cleanup_policy"] == "reap" or (completed_original and meta["cleanup_policy"] == "retain")
    run = Path(meta["runs_root"]) / meta["run_id"]
    audit = Path(meta["audit_dir"])
    assert run.resolve() == run and audit.resolve() == audit and audit.name == owner
    ameta = fields(audit / "meta")
    assert all(ameta[k] == meta[k] for k in ("fleet_owner_token", "run_id", "app"))
    tasks = obj(run / "_batch/benches.json")
    assert isinstance(tasks, list) and 1 <= len(tasks) <= 4096
    names = [t["name"] for t in tasks]
    assert len(names) == len(set(names)) and all(re.fullmatch(r"[A-Za-z0-9._-]+", n) and n not in (".", "..") for n in names)
    lifecycle = obj(run / "_batch/lifecycle.json")
    assert lifecycle["version"] == 1 and lifecycle["status"] == "failed"
    assert type(lifecycle["controller_exit_code"]) is int and lifecycle["controller_exit_code"] != 0
    assert lifecycle["fleet_owner_token"] == owner and lifecycle["run_id"] == meta["run_id"]
    source_files = {str(p): digest(read(p)) for p in (registry / "meta", audit / "meta", run / "_batch/benches.json", run / "_batch/lifecycle.json", run / "execution-provenance.json")}
    if "source_manifest_sha256" in meta or "source_manifest_sha256" in ameta:
        for p in (registry / "source-manifest.json", audit / "source-manifest.json"):
            source_files[str(p)] = digest(read(p, 65536))
            assert source_files[str(p)] == meta["source_manifest_sha256"] == ameta["source_manifest_sha256"]
    fresh, clones = {}, {}
    for directory, target in ((audit / "fresh", fresh), (registry / "clones", clones)):
        assert directory.resolve() == directory and not directory.is_symlink()
        for p in sorted(directory.iterdir()):
            target[p.name] = fields(p)
            source_files[str(p)] = digest(read(p, 65536))
    mids, volumes = set(), set()
    matches = []
    for row in fresh.values():
        assert row["fleet_owner_token"] == owner and row["run_id"] == meta["run_id"] and row["app"] == app
        mid, volume = row.get("machine_id", ""), row.get("volume_id", "")
        if mid:
            assert re.fullmatch(r"[0-9a-f]+", mid) and mid not in mids
            mids.add(mid)
        if volume:
            assert re.fullmatch(r"vol_[A-Za-z0-9]+", volume) and volume not in volumes
            volumes.add(volume)
        if mid == machine:
            matches.append(row)
    assert len(matches) == 1
    original = matches[0]
    assert original["source"] == "fresh-clone" and original["disposition"] == "owned"
    assert machine not in {row.get("source_machine_id") for row in fresh.values()}
    assert clones[original["clone_name"]] == {"name": original["clone_name"], "id": machine, "volume_id": original["volume_id"]}
    if completed_original:
        assert original["version"] == "1"
        clone = original["clone_name"]
        intent = fields(audit / "expected-fresh" / clone)
        source = original["source_machine_id"]
        assert intent == {"clone_name": clone, "source_machine_id": source}
        assert re.fullmatch(r"[0-9a-f]+", source)
        assert read(audit / "by-machine-id" / machine, 256) == (clone + "\n").encode()
        source_index = audit / "by-machine-id" / source
        assert not source_index.exists() and not source_index.is_symlink()
    outputs = [run / n for n in names if (run / n / ".cid").exists() and read(run / n / ".cid", 256).decode().split() == ["clone", machine]]
    assert len(outputs) == 1
    out = outputs[0]
    ordinal = names.index(out.name)
    token = f"{owner}-{ordinal}"
    assert obj(out / "runtime-evidence.owner.json") == {"version": 1, "machine_id": machine, "run_token": token}
    assert read(out / "guest-shutdown.confirmed", 256).decode().strip() in (token, meta["run_id"])
    if completed_original:
        assert read(out / "guest-shutdown.confirmed", 256) == (meta["run_id"] + "\n").encode()
    assert not (out / "runtime-evidence.pending").exists() and not (out / "runtime-evidence.pending").is_symlink()
    assert read(out / "worker-clones.ids", 65536).strip() == b""
    assert not any(row.get("source_machine_id") == machine and row.get("machine_id") for row in fresh.values())
    root = out / "remote-logs/runtime-evidence"
    manifest = obj(root / "manifest.json")
    assert manifest["version"] == 1 and manifest["machine_id"] == machine and manifest["run_token"] == token
    services = obj(root / "services.json")
    count = services["env"]["worker_processes"]
    assert services["status"] == "stopped" and type(count) is int and 1 <= count <= 1024
    cleanup_name = f"cloudbench-stack-cleanup-{token}.status"
    expected = {"services.json", "run.json", "stack.log", cleanup_name, "logs/backend.log", "logs/worker.log", *(f"logs/worker.{i}.log" for i in range(1, count))}
    # The served WMH log is optional evidence, present only for simulated runs.
    assert set(manifest["files"]) - {"wmh-serve-log.txt"} == expected
    cleanup = fields(root / cleanup_name)
    assert cleanup["state"] == "clean" and cleanup["token"] == token
    total = 0
    for name, info in manifest["files"].items():
        assert type(info["bytes"]) is int and info["bytes"] >= 0
        data = read(root / name, 512 * 1024 * 1024)
        total += len(data)
        assert total <= 512 * 1024 * 1024 and info == {"bytes": len(data), "sha256": digest(data)}
        source_files[str(root / name)] = digest(data)
    assert read(out / "cloudbench-run.json", 64 * 1024 * 1024) == read(root / "run.json", 64 * 1024 * 1024)
    validator = runpy.run_path(str(Path(__file__).with_name("cloudbench_result.py")))
    provenance = validator["load_provenance"](run / "execution-provenance.json")
    contract = runpy.run_path(str(Path(__file__).with_name("cloudbench_execution_provenance.py")))
    matrix = contract["load_task_matrix"](run / "execution-task-matrix.json")
    assert [row["name"] for row in matrix["tasks"]] == names
    assert not contract["validate_task_matrix_binding"](provenance, matrix)
    mode = next(row["world_model_mode"] for row in matrix["tasks"] if row["name"] == out.name)
    assert not validator["validate_run_file"](root / "run.json", [out.name], expected_execution_provenance=provenance, expected_world_model_mode=mode)
    terminal = json.loads(read(root / "run.json", 64 * 1024 * 1024))["tasks"][0]
    assert terminal["benchmark_status"] in ("PASSED", "FAILED")
    if native_config is not None or native_machines is not None:
        assert completed_original and native_config is not None and native_machines is not None
        config = obj(native_config)
        assert config["env"]["CLOUDBENCH_RUN_TOKEN"] == token
        assert config["env"]["REF"] == provenance["base_sha"]
        assert (config["env"].get("LOCAL_PATCH_SHA256") or "none") == provenance["workspace_patch_sha256"]
        assert [mount["volume"] for mount in config["mounts"]] == [original["volume_id"]]
        inventory = obj(native_machines, NATIVE_INVENTORY_LIMIT)
        assert isinstance(inventory, list) and all(isinstance(row, dict) and isinstance(row.get("id"), str) for row in inventory)
        assert machine not in {row["id"] for row in inventory}
    for p in (run / "execution-task-matrix.json", out / ".cid", out / "runtime-evidence.owner.json", root / "manifest.json", out / "guest-shutdown.confirmed", out / "cloudbench-run.json", out / "worker-clones.ids"):
        source_files[str(p)] = digest(read(p, 64 * 1024 * 1024))
    return {"schema": SCHEMA, "owner": owner, "run_id": meta["run_id"], "app": app, "task": out.name, "ordinal": ordinal, "run_token": token, "machine_id": machine, "clone_name": original["clone_name"], "volume_id": original["volume_id"], "full_task_count": len(tasks), "proof_credit": 0, "source_files_sha256": source_files}


def retained_volume(path, expected, attached):
    volume = obj(path)
    assert volume["id"] == expected["volume_id"] and volume["state"] == "created"
    assert volume["attached_machine_id"] == attached
    return digest(canonical({k: volume[k] for k in ("id", "name", "region", "size_gb", "created_at")}))


def destroyed_unlisted(args, intent):
    """A native destroyed tombstone grants no authority over a live/reused ID."""
    lines = [re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line) for line in read(args.status_file, 65536).decode().splitlines()]
    assert [line.split(":", 1)[1].strip() for line in lines if line.startswith("Machine ID:")] == [args.machine_id]
    assert [line.split(":", 1)[1].strip() for line in lines if line.startswith("State:")] == ["destroyed"]
    headers = [i for i, line in enumerate(lines) if line.strip() == "VM"]
    assert len(headers) == 1
    end = next((i for i in range(headers[0] + 1, len(lines)) if lines[i].strip() == "Event Logs"), len(lines))
    pairs, separators = {}, set()
    for line in lines[headers[0] + 1:end]:
        if not line.strip():
            continue
        match = re.fullmatch(r"\s*([^=│]+?)\s*(=|│)\s*(.*?)\s*", line)
        assert match and match[1] not in pairs
        pairs[match[1]] = match[3]
        separators.add(match[2])
    assert len(separators) == 1 and pairs["State"] == "destroyed"
    assert {k: pairs[label] for k, label in (("id", "ID"), ("name", "Name"), ("created_at", "Created"), ("instance_id", "Instance ID"))} == intent["native_identity"]
    assert digest(canonical(obj(args.config_json))) == intent["config_sha256"]
    machines = obj(args.machines_json, NATIVE_INVENTORY_LIMIT)
    assert isinstance(machines, list) and all(isinstance(row, dict) and isinstance(row.get("id"), str) for row in machines)
    assert args.machine_id not in {row["id"] for row in machines}


def main():
    global REFUSAL_STAGE
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("probe-command", "prepare", "verify-present-intent", "complete", "verify"))
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--machine-id", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--config-json", type=Path)
    parser.add_argument("--machines-json", type=Path)
    parser.add_argument("--guest-proof-json", type=Path)
    parser.add_argument("--volume-json", type=Path)
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--native-absence-kind", choices=("exact-native-not-found", "exact-native-destroyed-unlisted"), default="exact-native-not-found")
    args = parser.parse_args()
    expected = binding(args.registry, args.machine_id, args.app)
    if args.command == "probe-command":
        manifest_path = next(p for p in expected["source_files_sha256"] if p.endswith("/remote-logs/runtime-evidence/manifest.json"))
        manifest = obj(Path(manifest_path))
        code = '''import hashlib,json,os,stat
from pathlib import Path
def read(p,limit):
 p=Path(p); assert p.resolve(strict=True)==p
 with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
  s=os.fstat(f.fileno()); assert stat.S_ISREG(s.st_mode) and s.st_size<=limit
  data=f.read(s.st_size+1); assert len(data)==s.st_size
  return data
assert os.environ['FLY_MACHINE_ID']==machine and os.environ['CLOUDBENCH_RUN_TOKEN']==token
root=Path('/data'); context=root/'repo/.context/cloudbench'
assert read(root/'bench.log',512*1024*1024).splitlines()[0]==('RUNSTAMP-'+token).encode()
ack=read(root/('cloudbench-driver-clean-'+token+'.ack'),256).decode().strip()
driver=read(root/'cloudbench-driver.state',256).decode().strip()
runner=dict(line.split('=',1) for line in read(root/('cloudbench-interrupt-cleanup-'+token+'.status'),65536).decode().splitlines())
assert ack==token and driver=='exited' and runner=={'version':'1','state':'clean','token':token}
files={}
for name in expected_manifest['files']:
 data=read(context/name,512*1024*1024)
 files[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
manifest={'version':1,'run_token':token,'machine_id':machine,'files':files}
assert manifest==expected_manifest
print(json.dumps({'machine_id':machine,'run_token':token,'driver_state':driver,'ack':ack,'root_cleanup':runner,'runtime_manifest':manifest},sort_keys=True))
'''
        prefix = "machine=" + repr(args.machine_id) + ";token=" + repr(expected["run_token"]) + ";expected_manifest=" + repr(manifest) + ";\n"
        print("python3 -c " + shlex.quote(prefix + code))
        return
    directory = args.registry / "sealed-machine-retirements"
    intent_path = directory / (args.machine_id + ".intent.json")
    receipt_path = directory / (args.machine_id + ".json")
    if args.command in ("prepare", "verify-present-intent"):
        config = obj(args.config_json)
        assert config["env"]["CLOUDBENCH_RUN_TOKEN"] == expected["run_token"]
        run = Path(fields(args.registry / "meta")["runs_root"]) / expected["run_id"]
        provenance = obj(run / "execution-provenance.json")
        assert config["env"]["REF"] == provenance["base_sha"]
        assert (config["env"].get("LOCAL_PATCH_SHA256") or "none") == provenance["workspace_patch_sha256"]
        assert [m["volume"] for m in config["mounts"]] == [expected["volume_id"]]
        REFUSAL_STAGE = "native-inventory-input"
        matches = [row for row in obj(args.machines_json, NATIVE_INVENTORY_LIMIT) if row["id"] == args.machine_id]
        REFUSAL_STAGE = "selected-native-identity"
        assert len(matches) == 1
        native = matches[0]
        assert native["name"] == expected["clone_name"] and native["state"] in ("started", "stopped")
        assert native["config"] == config
        assert isinstance(native["created_at"], str) and native["created_at"]
        assert isinstance(native["instance_id"], str) and native["instance_id"]
        expected["native_identity"] = {k: native[k] for k in ("id", "name", "created_at", "instance_id")}
        expected.update(config_sha256=digest(canonical(config)), volume_identity_sha256=retained_volume(args.volume_json, expected, args.machine_id))
        if args.command == "verify-present-intent":
            intent = obj(intent_path)
            assert set(intent) == set(expected) | {"guest_proof_sha256"}
            assert all(intent[k] == value for k, value in expected.items())
            return
        proof = obj(args.guest_proof_json)
        assert proof["machine_id"] == args.machine_id and proof["run_token"] == expected["run_token"]
        assert proof["driver_state"] == "exited" and proof["ack"] == expected["run_token"]
        assert proof["root_cleanup"] == {"version": "1", "token": expected["run_token"], "state": "clean"}
        assert proof["runtime_manifest"] == obj(Path(next(p for p in expected["source_files_sha256"] if p.endswith("/remote-logs/runtime-evidence/manifest.json"))))
        expected["guest_proof_sha256"] = digest(canonical(proof))
        directory.mkdir(mode=0o700, exist_ok=True)
        publish(intent_path, expected)
    else:
        intent = obj(intent_path)
        assert all(intent[k] == value for k, value in expected.items())
        assert set(intent) == set(expected) | {"config_sha256", "guest_proof_sha256", "volume_identity_sha256", "native_identity"}
        assert intent["native_identity"]["id"] == args.machine_id and intent["native_identity"]["name"] == expected["clone_name"]
        if args.native_absence_kind == "exact-native-destroyed-unlisted":
            REFUSAL_STAGE = "destroyed-native-identity"
            destroyed_unlisted(args, intent)
        assert retained_volume(args.volume_json, expected, None) == intent["volume_identity_sha256"]
        if args.command == "complete":
            receipt = {**intent, "machine_absence": args.native_absence_kind, "volume_retained": True}
            if receipt_path.exists() or receipt_path.is_symlink():
                existing = obj(receipt_path)
                assert {k: existing[k] for k in receipt} == receipt
            else:
                publish(receipt_path, dict(receipt, verified_epoch=time.time()))
        else:
            receipt = obj(receipt_path)
            assert set(receipt) == set(intent) | {"machine_absence", "volume_retained", "verified_epoch"}
            assert all(receipt[k] == value for k, value in intent.items())
            assert receipt["machine_absence"] in ("exact-native-not-found", "exact-native-destroyed-unlisted") and receipt["volume_retained"] is True
            # The receipt describes the original observation. The caller has
            # just verified the current native endpoint; a destroyed tombstone
            # may later become exact not-found without invalidating ownership.
            # Expose a difference without making history an extra release gate.
            if receipt["machine_absence"] != args.native_absence_kind:
                print("SEALED_RETIREMENT_ABSENCE_TRANSITION=" + receipt["machine_absence"] + "->" + args.native_absence_kind, file=sys.stderr)
        print(json.dumps({"machine_id": args.machine_id, "volume_id": expected["volume_id"], "proof_credit": 0, "full_release": False}))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, ValueError, KeyError, StopIteration):
        raise SystemExit("SEALED_RETIREMENT_REFUSAL_STAGE=" + REFUSAL_STAGE)
