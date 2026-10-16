#!/usr/bin/env python3
"""Role-specific worker custody. No provider calls; native reads are caller inputs."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import fcntl
import shlex
import sys
import subprocess
import signal

SCHEMA = "cloudbench-worker-handoff-v1"
MAX_BYTES = 512 * 1024 * 1024


def require(value, reason):
    if not value:
        raise ValueError(reason)


def read(path, limit=MAX_BYTES):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, "linked worker custody path")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid() and before.st_size <= limit,
                "unsafe worker custody file")
        raw = stream.read(before.st_size + 1)
        after = path.stat()
        require(len(raw) == before.st_size and
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "worker custody changed")
        return raw


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def fields(raw):
    pairs = [line.split("=", 1) for line in raw.decode().splitlines()]
    require(all(len(p) == 2 for p in pairs) and len(dict(pairs)) == len(pairs), "invalid worker owner fields")
    return dict(pairs)


def sibling(name):
    return runpy.run_path(str(Path(__file__).with_name(name)))


def capture_worker_guest(instance, nonce, *, data=Path('/data'), observe=None, dependencies=None, mount=None):
    """Bounded read-only worker observation; CLI pins real /data and /proc."""
    common = sibling('cloudbench-startup-failure-archive.py')
    observe = observe or common['observe_current_cold_processes']
    mount = mount or common['current_cold_mount']
    data = Path(data); repo = data / 'repo'
    require(repo.resolve(strict=True) == repo and repo.is_dir() and (repo / '.git').is_dir(), 'worker checkout missing or linked')
    def actual_dependencies():
        helper = Path(__file__).with_name('lib') / 'cloudbench-env.sh'
        raw = subprocess.check_output(['bash', '-c',
            'source "$1"; cloudbench_node_dependency_fingerprint "$2"; cloudbench_manifest_fingerprint "$2" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"',
            'worker-dependencies', str(helper), str(repo)], text=True, timeout=10)
        node, python = raw.splitlines(); return dict(node_dependency_fingerprint=node, python_dependency_fingerprint=python)
    dependencies = dependencies or actual_dependencies
    first = observe(); mounted = mount(data)
    def clean_ref():
        ref = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True, timeout=5).strip()
        dirty = subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain=v1', '--untracked-files=all'], timeout=5)
        require(not dirty, 'worker source has tracked or untracked changes')
        return ref
    ref = clean_ref()
    deps = dependencies(); last = observe()
    require(clean_ref() == ref, 'worker source changed during dependency observation')
    require({k:v for k,v in first.items() if k != 'observed_epoch'} ==
            {k:v for k,v in last.items() if k != 'observed_epoch'} and mount(data) == mounted,
            'worker changed during observation')
    return dict(schema='cloudbench-worker-observation-v1', machine_id=os.environ.get('FLY_MACHINE_ID'),
                native_instance=instance, nonce=nonce, collector_sha256=sha(Path(__file__).read_bytes()),
                observer_sha256=sha(Path(__file__).with_name('cloudbench-startup-failure-archive.py').read_bytes()),
                env_helper_sha256=sha((Path(__file__).with_name('lib')/'cloudbench-env.sh').read_bytes()),
                observation=first, data_mount=mounted, source_ref=ref, dependencies=deps)


def validate_guest_observation(value, packet):
    require(value['schema'] == 'cloudbench-worker-observation-v1' and value['machine_id'] == packet['machine_id']
            and value['native_instance'] == packet['native']['instance_id'] and re.fullmatch('[0-9a-f]{32}', value['nonce'])
            and value['collector_sha256'] == sha(Path(__file__).read_bytes())
            and value['observer_sha256'] == sha(Path(__file__).with_name('cloudbench-startup-failure-archive.py').read_bytes())
            and value['env_helper_sha256'] == sha((Path(__file__).with_name('lib')/'cloudbench-env.sh').read_bytes())
            and value['source_ref'] == packet['source_ref'] and value['dependencies'] == packet['dependencies'],
            'worker observation source/native/dependencies mismatch')
    scan = value['observation']
    require(scan['kind'] == 'exact-inert-quiescence-v1' and scan['machine'] == packet['machine_id']
            and re.fullmatch('[0-9a-f-]{36}', scan['boot']) and scan['unknown'] == [] and scan['inert_sleepers'],
            'worker is not observed idle')
    identities=[]
    for role in ('inert_sleepers','idle_pinned_agents','idle_platform_hallpass'):
        for row in scan[role]:
            require(type(row['pid']) is int and row['pid'] > 0 and re.fullmatch('[0-9]+',row['birth']), 'worker process identity missing')
            identities.append(row['pid'])
    require(len(identities)==len(set(identities)) and len(scan['idle_platform_hallpass'])<=1, 'worker process identity collision')
    mount=value['data_mount']
    require(type(mount['device']) is int and mount['device']>0 and type(mount['inode']) is int and mount['inode']>0
            and re.fullmatch('[0-9]+:[0-9]+',mount['mount_device']), 'worker data mount missing')


def originals(packet):
    result, total = {}, 0
    for name, row in packet["originals"].items():
        require(not name.startswith("/") and ".." not in Path(name).parts, "unsafe worker original name")
        raw = base64.b64decode(row["data"], validate=True)
        total += len(raw)
        require(total <= MAX_BYTES and row["bytes"] == len(raw) and row["sha256"] == sha(raw),
                "worker original digest mismatch")
        result[name] = raw
    require(len(result) <= 1030, "worker original count")
    return result


def native_pair(before, after, volume, machine, name, volume_id):
    require(before == after and before["id"] == machine and before["name"] == name and
            before["state"] == "stopped" and isinstance(before["instance_id"], str) and before["instance_id"], "worker native pair drift")
    config = before["config"]
    require(config.get("init") == {"cmd": ["sleep", "infinity"]} and
            config.get("env") in (None, {}) and config.get("restart") == {"policy": "no"} and
            (config.get("auto_destroy") is None or config.get("auto_destroy") is False) and
            not any(config.get(k) for k in ("containers", "processes", "standbys", "schedule")),
            "worker is not inert")
    require(re.fullmatch(r".+@sha256:[0-9a-f]{64}", config.get("image", "")), "worker image unpinned")
    guest=config.get('guest',{})
    require(guest.get('cpu_kind') in ('shared','performance') and type(guest.get('cpus')) is int
            and guest['cpus']>0 and type(guest.get('memory_mb')) is int and guest['memory_mb']>0,
            'worker native profile invalid')
    mounts = config.get("mounts", [])
    require(len(mounts) == 1 and mounts[0]["volume"] == volume_id and mounts[0]["path"] == "/data",
            "worker volume mismatch")
    require(volume["id"] == volume_id and volume["attached_machine_id"] == machine and
            volume["state"] == "created" and type(volume["size_gb"]) is int and volume["size_gb"] > 0,
            "worker volume association drift")
    return config


def validate(packet, target):
    require(len(canonical(packet)) < MAX_BYTES, 'encoded worker custody exceeds packet limit')
    require(packet["schema"] == SCHEMA and packet["role"] == "worker" and
            packet["state"] == "SOURCE_COMMITTED", "not a committed worker handoff")
    require(packet["target"] == target, "foreign worker destination")
    sibling("cloudbench-startup-failure-archive.py")["handoff_target"](target)
    f = originals(packet)
    meta, audit, record, clone = (fields(f[k]) for k in
                                  ("registry/meta", "audit/meta", "audit/worker", "registry/worker"))
    owner = packet["owner"]
    require(re.fullmatch("[0-9a-f]{32}", owner) and meta["fleet_owner_token"] == owner and
            meta["cleanup_policy"] == "reap" and meta["version"] == "2", "worker original owner mismatch")
    require(all(audit[k] == meta[k] == record[k] for k in ("app", "run_id", "fleet_owner_token")),
            "worker original audit mismatch")
    mid, vid = packet["machine_id"], packet["volume_id"]
    worker = json.loads(f["worker/owner.json"])
    require(record["machine_id"] == mid and record["volume_id"] == vid and record["disposition"] == "owned"
            and record.get('source') == 'fresh-clone'
            and clone == {"name": record["clone_name"], "id": mid, "volume_id": vid}, "worker original allocation mismatch")
    require(worker["machine_id"] == mid and worker["primary_machine_id"] == record["source_machine_id"]
            and worker["primary_machine_id"] != mid and worker["run_token"] == packet["run_token"],
            "worker role/primary mismatch")
    provenance = json.loads(f["run/execution-provenance.json"])
    require(re.fullmatch("[0-9a-f]{40}", provenance["base_sha"]) and
            provenance["base_sha"] == packet["source_ref"], "worker original source mismatch")
    matrix = json.loads(f["run/execution-task-matrix.json"])
    tasks = json.loads(f["full/batch/benches.json"])
    batch = json.loads(f["full/batch/run.json"])
    contract = sibling("cloudbench_execution_provenance.py")
    require(not contract["validate_task_matrix_binding"](provenance, matrix), 'worker original task/source contract invalid')
    names = [row["name"] for row in tasks]
    task_rows = [{"name": row["name"], "world_model_mode": "simulate" if row["mode"] == "SIM" else "real"} for row in tasks]
    primary_identity = f["primary/identity"].decode().split()
    output = Path(packet["output"])
    require(task_rows == matrix["tasks"] and len(set(names)) == len(names)
            and output.name in names and output == Path(meta["runs_root"]) / meta["run_id"] / output.name
            and packet["run_token"] == owner + "-" + str(names.index(output.name))
            and batch.get("run_id") == meta["run_id"] and batch.get("execution_provenance") == provenance
            and primary_identity in (["clone", worker["primary_machine_id"]], ["pool", worker["primary_machine_id"]]),
            'worker original owner/task ordinal/primary mismatch')
    values = provenance["config"]["values"]
    require(packet["dependencies"] == {k: values[k] for k in
            ("node_dependency_fingerprint", "python_dependency_fingerprint")}, "worker dependencies mismatch")
    evidence = sibling("cloudbench-worker-evidence.py")
    manifest = json.loads(f["capture/manifest.json"])
    expected = evidence["authority"](packet["run_token"], mid)
    evidence["validate_bundle"](manifest, json.loads(f["capture/receipts/owner.json"]),
                                 json.loads(f["capture/receipts/terminal.json"]), expected)
    for name, row in manifest["files"].items():
        raw = f["capture/" + name]
        require(len(raw) == row["bytes"] and sha(raw) == row["sha256"], "worker capture incomplete")
    native_pair(packet["native"], packet["native"], packet["native_volume"], mid, record["clone_name"], vid)
    snapshot = packet["snapshot"]
    require(snapshot["volume_id"] == vid and snapshot["request"] == {"method": "POST", "path": f"/volumes/{vid}/snapshots"}
            and snapshot['machine_id'] == mid and snapshot['native_instance'] == packet['native']['instance_id']
            and snapshot['capture_nonce'] == packet['guest_observation']['nonce']
            and snapshot["ack"]["Msg"]["backup"]["graph_id"] == snapshot["available"]["id"]
            and re.fullmatch("vs_[A-Za-z0-9]+", snapshot["available"]["id"])
            and type(snapshot["available"]["size"]) is int and snapshot["available"]["size"] > 0
            and isinstance(snapshot["available"]["digest"],str) and snapshot["available"]["digest"].strip(), "worker data snapshot unproven")
    for field in ("state", "status"):
        require(snapshot["available"].get(field, "available") in
                ("created", "complete", "completed", "ready", "available"), "worker snapshot not available")
    validate_guest_observation(packet['guest_observation'], packet)
    hold = packet["source_hold"]
    require(hold == {"schema": SCHEMA, "role": "worker", "owner": owner, "machine_id": mid,
                    "volume_id": vid, "target": target, "originals_sha256": sha(canonical(packet["originals"])),
                    "native_sha256": sha(canonical([packet['native'], packet['native_volume'], packet['snapshot'], packet['guest_observation']]))},
            "worker source exclusion mismatch")
    return packet


def verify(path, target, before, after, volume, source, node, python, size, memory, *, returning=False, importing=False):
    packet = validate(json.loads(read(path)), target)
    if not importing:
        require(Path(path) == Path(target['common']) / 'cloudbench-worker-reuse/proofs' / (packet['machine_id'] + '.json'),
                'worker proof outside imported custody')
        imported = json.loads(read(Path(path).parent.parent / 'imported' / (packet['machine_id'] + '.json')))
        require(imported['packet_sha256'] == sha(canonical(packet)) and imported['target'] == target,
                'worker proof differs from committed import')
    require(Path(before) != Path(after) and not Path(before).samefile(after), "worker native pair reused one read")
    native = json.loads(read(before)); last = json.loads(read(after)); vol = json.loads(read(volume))
    native_pair(native, last, vol, packet["machine_id"], packet["native"]["name"], packet["volume_id"])
    require(all(native.get(k) == packet["native"].get(k) for k in ("id", "name", "instance_id", "config", "image_ref"))
            and all(vol.get(k) == packet["native_volume"].get(k) for k in
                    ("id", "attached_machine_id", "size_gb", "region")), "worker changed since custody seal")
    require(target["source_ref"] == source and packet["dependencies"] ==
            {"node_dependency_fingerprint": node, "python_dependency_fingerprint": python}, "new worker source/dependencies mismatch")
    if not returning:
        state_path = Path(path).parent.parent / "states" / (packet["machine_id"] + ".json")
        if state_path.exists():
            state = json.loads(read(state_path))
            require(state["packet_sha256"] == sha(read(path)), "worker return changed source authority")
            require(native == state["native"] and vol == state["volume"], "worker changed since verified return")
            recover_return_release(state["output"], packet["machine_id"], state["primary"], state["run_token"])
            validate_return(state["output"], packet["machine_id"], state["primary"], state["run_token"], check_claim=False)
        else:
            require(native == packet["native"] and vol == packet["native_volume"], "worker changed since source handoff")
    match = re.fullmatch(r"(shared-cpu|performance)-([1-9][0-9]*)x", size)
    require(match is not None and native["config"]["guest"] ==
            {"cpu_kind": "shared" if match[1] == "shared-cpu" else "performance",
             "cpus": int(match[2]), "memory_mb": int(memory)}, "worker profile mismatch")
    return packet


def source_paths(registry, output, machine):
    """Canonical bounded originals, including every original latch and sibling audit."""
    registry, output = Path(registry), Path(output)
    meta = fields(read(registry / "meta"))
    audit = Path(meta["audit_dir"])
    run = Path(meta["runs_root"]) / meta["run_id"]
    require(output.parent == run, "worker output outside owner run")
    clone_name = read(audit / "by-machine-id" / machine, 4096).decode().strip()
    paths = {"registry/meta": registry / "meta", "registry/worker": registry / "clones" / clone_name,
             "audit/meta": audit / "meta", "audit/worker": audit / "fresh" / clone_name,
             "run/execution-provenance.json": run / "execution-provenance.json",
             "run/execution-task-matrix.json": run / "execution-task-matrix.json",
             "worker/owner.json": output / "worker-runtime-evidence" / machine / "owner.json",
             "primary/identity": output / ".cid"}
    capture = output / "worker-runtime-evidence" / machine / "capture"
    for prefix, root in (("capture", capture), ("full/registry", registry),
                         ("full/audit", audit), ("full/output", output), ("full/batch", run / "_batch")):
        require(root.resolve(strict=True) == root and root.is_dir(), "unsafe worker original directory")
        for p in root.rglob("*"):
            require(not p.is_symlink(), "linked worker original")
            if p.is_dir():
                continue
            if root == registry and p.name in (f"worker-handoff-{machine}.json", f".worker-retain-{machine}"):
                continue  # the exact immutable exporter receipt is checked separately
            if root == registry and p.name == 'cold-handoff-outgoing':
                hold=json.loads(read(p))
                require(hold.get('schema')==SCHEMA and hold.get('role')=='workers', 'foreign source handoff')
                continue
            paths[prefix + "/" + str(p.relative_to(root))] = p
            require(len(paths) <= 1030, "worker original inventory too large")
    return paths


def collect_packet(registry, output, machine, before, after, volume, snapshot, target, observation):
    """Read source-owned originals directly; caller cannot supply substitute bytes."""
    paths = source_paths(registry, output, machine)
    encoded, total = {}, 0
    source_meta=read(Path(registry)/'meta')
    original_meta=source_meta
    if fields(source_meta)['cleanup_policy']=='retain':
        hold=json.loads(read(Path(registry)/'cold-handoff-outgoing'))
        require(hold['target']==target and hold['owner']==Path(registry).name, 'foreign retained worker owner')
        original_meta=base64.b64decode(hold['original_meta'],validate=True)
        require(sha(original_meta)==hold['original_meta_sha256'] and
                original_meta.replace(b'cleanup_policy=reap\n',b'cleanup_policy=retain\n')==source_meta,
                'retained worker source metadata changed')
    for name, path in paths.items():
        raw = original_meta if path == Path(registry)/'meta' else read(path, MAX_BYTES - total)
        total += len(raw)
        require(total<=MAX_BYTES,'worker original aggregate too large')
        encoded[name] = dict(bytes=len(raw), sha256=sha(raw), data=base64.b64encode(raw).decode())
    # Re-enumerate and re-read before any source authority changes.
    require(source_paths(registry, output, machine) == paths, "worker inventory changed during capture")
    for name, path in paths.items():
        current=read(path)
        unchanged=current==source_meta if path==Path(registry)/'meta' else sha(current)==encoded[name]['sha256']
        require(unchanged,"worker original changed during capture")
    f = {name: base64.b64decode(row["data"]) for name, row in encoded.items()}
    meta = fields(f["registry/meta"]); original = fields(f["audit/worker"])
    worker = json.loads(f["worker/owner.json"])
    require(f["primary/identity"].decode().split() in
            (["clone", original["source_machine_id"]], ["pool", original["source_machine_id"]]),
            "worker original primary identity differs")
    provenance = json.loads(f["run/execution-provenance.json"])
    first, last, vol = (json.loads(read(p)) for p in (before, after, volume))
    require(Path(before) != Path(after) and not Path(before).samefile(after), "worker native pair reused one read")
    native_pair(first, last, vol, machine, original["clone_name"], original["volume_id"])
    packet = dict(schema=SCHEMA, role="worker", state="SOURCE_COMMITTED", target=target,
                  owner=meta["fleet_owner_token"], machine_id=machine, volume_id=original["volume_id"],
                  run_token=worker["run_token"], output=str(output), source_ref=provenance["base_sha"],
                  dependencies={k: provenance["config"]["values"][k] for k in
                                ("node_dependency_fingerprint", "python_dependency_fingerprint")},
                  originals=encoded, native=first, native_volume=vol, snapshot=json.loads(read(snapshot)),
                  guest_observation=json.loads(read(observation)))
    packet["source_hold"] = dict(schema=SCHEMA, role="worker", owner=packet["owner"], machine_id=machine,
                                 volume_id=packet["volume_id"], target=target, originals_sha256=sha(canonical(encoded)),
                                 native_sha256=sha(canonical([first, vol, packet['snapshot'],packet['guest_observation']])))
    return validate(packet, target)


def export(packet, common, registry, destination):
    """Serialize with the existing source recovery inode before fencing ownership."""
    common, registry = Path(common), Path(registry)
    fd = sibling("cloudbench-original-volume-capture.py")["_billing_lock"](
        common / "cloudbench-fleet-recovery-locks" / registry.name)
    try:
        return _export_locked(packet, common, registry, destination)
    finally:
        os.close(fd)


def _export_locked(packet, common, registry, destination):
    """Commit existing dead-owner worker custody before publishing any packet."""
    packet = validate(packet, packet["target"])
    common, registry = Path(common), Path(registry)
    require(registry == common / "cloudbench-fleet-ownership" / packet["owner"], "foreign worker source registry")
    require(not (common / "cloudbench-pool-claims" / packet["machine_id"]).exists(), "worker still claimed at source")
    source = originals(packet)
    meta_raw = source["registry/meta"]
    meta = fields(meta_raw)
    output = Path(packet["output"])
    run = Path(meta["runs_root"]) / meta["run_id"]
    require(output.parent == run and output.resolve(strict=True) == output, "worker output outside original run")
    require(not any(Path(destination).is_relative_to(p) for p in (registry, output, Path(meta['audit_dir']))),
            'worker packet cannot overwrite its original inventory')
    paths = source_paths(registry, output, packet["machine_id"])
    require(set(paths) == set(source), "worker source archive inventory mismatch")
    for name, path in paths.items():
        if path != registry / "meta":
            require(read(path) == source[name], "worker source original changed")
    require(meta["host"] == os.uname().nodename, "worker export must execute on source host")
    birth = re.fullmatch(r"proc-start:([0-9a-f-]{36}):([0-9]+)", meta["pid_start"])
    require(birth is not None, "worker owner birth missing")
    if birth[1] == Path("/proc/sys/kernel/random/boot_id").read_text().strip():
        process = Path("/proc") / meta["pid"] / "stat"
        require(not process.exists() or process.read_text().rsplit(") ", 1)[1].split()[19] != birth[2],
                "worker original owner still live")
    retained = meta_raw.replace(b"cleanup_policy=reap\n", b"cleanup_policy=retain\n")
    require(retained != meta_raw and read(registry / "meta") in (meta_raw, retained), "worker source meta changed")
    helper = sibling("cloudbench-startup-failure-archive.py")
    hold = packet["source_hold"]
    helper["durable_handoff_json"](registry / "cold-handoff-outgoing",
        {"schema": SCHEMA, "role": "workers", "owner": packet["owner"], "target": packet["target"],
         'original_meta':base64.b64encode(meta_raw).decode(), 'original_meta_sha256':sha(meta_raw)})
    # Old consumers recognize RETAIN; new ones also see global MID/Volume fences.
    for key in (packet["machine_id"], packet["volume_id"]):
        helper["durable_handoff_json"](common / "cloudbench-cold-handoffs/outgoing" / key, hold)
    helper["durable_handoff_json"](registry / ("worker-handoff-" + packet["machine_id"] + ".json"), hold)
    if read(registry / "meta") != retained:
        temporary = registry / (".worker-retain-" + packet["machine_id"])
        if temporary.exists():
            require(read(temporary)==retained,'conflicting worker source retention retry')
        else:
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as out:
                out.write(retained); out.flush(); os.fsync(out.fileno())
        os.replace(temporary, registry / "meta")
        fd = os.open(registry, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    helper["durable_handoff_json"](destination, packet)


def import_packet(packet, common, target):
    """Same claim-first/ledger/audit/terminal/release order as cold handoff."""
    validate(packet, target)
    common = Path(common)
    require(str(common.resolve(strict=True)) == target["common"], "foreign worker common")
    helper = sibling("cloudbench-startup-failure-archive.py")
    mid = packet["machine_id"]
    require(not (common / "cloudbench-cold-handoffs/outgoing" / mid).exists(), "worker delegated outward")
    claims = common / "cloudbench-pool-claims"
    helper["handoff_directory"](claims)
    helper["handoff_directory"](claims / ".locks")
    fd=sibling('cloudbench-original-volume-capture.py')['_billing_lock'](claims / '.locks' / (mid+'.lock'))
    with os.fdopen(fd, 'r+') as lock:
        authority = {"schema": SCHEMA, "role": "worker", "packet_sha256": sha(canonical(packet)),
                     "target": target, "machine_id": mid, "volume_id": packet["volume_id"]}
        terminal = common / "cloudbench-worker-reuse/imported" / (mid + ".json")
        if terminal.exists():
            require(json.loads(read(terminal)) == authority, "worker already imported by another owner")
            if (claims / mid).exists():
                require(json.loads(read(claims / mid)) == authority, 'worker import cannot release foreign claim')
                (claims / mid).unlink()
                directory=os.open(claims,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:os.fsync(directory)
                finally:os.close(directory)
            return
        helper["durable_handoff_json"](claims / mid, authority)
        helper["durable_handoff_json"](common / "cloudbench-worker-reuse/proofs" / (mid + ".json"), packet)
        ledger = common / "cloudbench-worker-pools" / target["pool_name"]
        helper["handoff_directory"](ledger.parent)
        with helper["cold_handoff_ledger_lock"](Path(str(ledger) + ".lock")):
            baseline = {"role": "worker", "target": target, "dependencies": packet["dependencies"]}
            helper["durable_handoff_json"](Path(str(ledger) + ".deps"), baseline)
            rows = read(ledger).decode().splitlines() if ledger.exists() else []
            require(len(rows) == len(set(rows)), "duplicate worker pool IDs")
            if mid not in rows:
                with os.fdopen(os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600), "a") as out:
                    out.write(mid + "\n"); out.flush(); os.fsync(out.fileno())
            directory=os.open(ledger.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(directory)
            finally:os.close(directory)
        helper["durable_handoff_json"](terminal, authority)
        require(json.loads(read(claims / mid)) == authority, "worker import claim changed")
        (claims / mid).unlink()
        fd = os.open(claims, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def idle_command(machine, nonce):
    require(re.fullmatch("[0-9a-f]{8,32}", machine) and re.fullmatch("[0-9a-f]{32}", nonce), "bad idle identity")
    code = "TARGET=" + repr(machine) + ";NONCE=" + repr(nonce) + "\n"
    code += sibling("cloudbench-original-volume-capture.py")["BILLING_GUEST"]
    return "python3 -I -S -B -c " + shlex.quote(code)


def validate_idle(value, machine, nonce):
    require(value["kind"] == "exact-inert-quiescence-v1" and value["machine"] == machine and
            value["nonce"] == nonce and value["unknown"] == [] and value["inert_sleepers"], "worker not strictly idle")
    require(re.fullmatch("[0-9a-f-]{36}", value["boot"]), "worker idle boot identity missing")


def ready_command(machine, token, primary_host, workspace, ready_file):
    require(re.fullmatch("[0-9a-f]{8,32}", machine) and re.fullmatch("[A-Za-z0-9_.-]+", token), "bad ready identity")
    code = """import json,os,runpy
from pathlib import Path
h=runpy.run_path('/data/cloudbench-worker-evidence.py')
state=Path('/data')/('cloudbench-worker-evidence-'+TOKEN)
owner=h['read_json'](state/'owner.json'); child=h['read_json'](state/'child.json')
expected=h['authority'](TOKEN,MACHINE)
h['bound'](owner,expected);h['bound'](child,expected)
assert os.environ.get('FLY_MACHINE_ID')==MACHINE
assert h['same_process'](owner['supervisor']) and h['same_process'](child['child'])
assert not (state/'terminal.json').exists()
assert Path(READY).read_text().strip()==str(child['child']['pid'])
env=dict(item.split(b'=',1) for item in Path('/proc',str(child['child']['pid']),'environ').read_bytes().split(b'\\0') if b'=' in item)
assert env[b'CLOUDBENCH_WORKER_RUN_TOKEN'].decode()==TOKEN
assert env[b'WORKSPACE_NAME'].decode()==WORKSPACE and env[b'PRIMARY_HOST'].decode()==PRIMARY
"""
    prefix = f"TOKEN={token!r};MACHINE={machine!r};PRIMARY={primary_host!r};WORKSPACE={workspace!r};READY={ready_file!r}\n"
    return "python3 -I -S -B -c " + shlex.quote(prefix + code)


def validate_capture(output, machine, primary, token):
    output = Path(output)
    evidence = output / "worker-runtime-evidence" / machine
    owner = json.loads(read(evidence / "owner.json"))
    require(owner["machine_id"] == machine and owner["primary_machine_id"] == primary and owner["run_token"] == token,
            "worker evidence belongs to another assignment")
    if (evidence / "capture/manifest.json").exists():
        sibling("cloudbench-worker-evidence.py")["verify_directory"](
            evidence / "capture", {"version": 1, "machine_id": machine, "run_token": token})
        sealed = evidence / "capture/manifest.json"
    else:
        sealed = evidence / "not-launched.json"
        row = json.loads(read(sealed))
        require(all(row.get(k) == value for k, value in owner.items()) and row["worker_started"] is False
                and not (output / f"worker-{machine}.launch-attempted").exists()
                and row["stage_sha256"] == sha(read(output / f"worker-{machine}.stage.log")),
                "unlaunched worker receipt is foreign")
    return sha(read(sealed))


def validate_return(output, machine, primary, token, *, check_claim=True, require_release=True):
    output = Path(output)
    authority = json.loads(read(output / "worker-borrowed" / (machine + ".json")))
    returned = json.loads(read(output / "worker-borrowed" / (machine + ".returned.json")))
    if require_release:
        released = json.loads(read(output / "worker-borrowed" / (machine + ".released.json")))
        require(returned == released, "worker release differs from verified return")
    require(authority["machine_id"] == machine and
            authority["primary_machine_id"] == primary and authority["run_token"] == token and
            returned["machine_id"] == machine and returned["primary_machine_id"] == primary and
            returned["run_token"] == token and returned["fleet_owner_token"] == authority["fleet_owner_token"]
            and returned["claim_sha256"] == authority["claim_sha256"] and
            returned["state"] == "stopped" and returned["volume_retained"] is True,
            "worker return is not exact terminal ownership")
    proof_path = Path(authority["proof"])
    packet = json.loads(read(proof_path))
    if authority.get("origin") == "explicit-user-idle-resource":
        state=sibling("cloudbench-explicit-idle-admission.py")["returned_state"](proof_path, require_release=require_release)
        require(state is not None and state["assignment"]["sha256"] == sha(read(output / "worker-borrowed" / (machine + ".json"))), "explicit worker return assignment")
        require(validate_capture(output, machine, primary, token) == returned["evidence_sha256"], "worker terminal evidence changed")
        return returned
    validate(packet, packet["target"])
    if check_claim:
        claim = proof_path.parents[2] / "cloudbench-pool-claims" / machine
        require(not claim.exists() or sha(read(claim)) != authority["claim_sha256"], "worker claim remains held")
    require(validate_capture(output, machine, primary, token) == returned["evidence_sha256"],
            "worker terminal evidence changed")
    return returned


def recover_return_release(output, machine, primary, token):
    """Finish only the durable marker after exact old-claim release; never touch claims."""
    output = Path(output)
    released = output / "worker-borrowed" / (machine + ".released.json")
    if released.exists():
        return validate_return(output, machine, primary, token, check_claim=False)
    authority = json.loads(read(output / "worker-borrowed" / (machine + ".json")))
    explicit = authority.get("origin") == "explicit-user-idle-resource"
    common = Path(authority["proof"]).parents[1 if explicit else 2]
    lock_path = common / "cloudbench-pool-claims/.locks" / (machine + ".lock")
    fd = sibling("cloudbench-original-volume-capture.py")["_billing_lock"](lock_path)
    with os.fdopen(fd, "r+"):
        # The old generation must be gone. A later generation remains untouched.
        returned = validate_return(output, machine, primary, token, require_release=False)
        if not explicit:
            state = json.loads(read(common / "cloudbench-worker-reuse/states" / (machine + ".json")))
            require(state["output"] == str(output) and state["primary"] == primary and state["run_token"] == token
                    and state["packet_sha256"] == sha(read(authority["proof"])), "return recovery state differs")
        sibling("cloudbench-startup-failure-archive.py")["durable_handoff_json"](released, returned)
    return returned


def record_return_state(authority_path, native_path, volume_path):
    authority = json.loads(read(authority_path))
    proof = Path(authority["proof"])
    destination = proof.parent.parent / "states" / (authority["machine_id"] + ".json")
    sibling("cloudbench-startup-failure-archive.py")["handoff_directory"](destination.parent)
    state = dict(packet_sha256=sha(read(proof)), output=str(Path(authority_path).parent.parent),
                 primary=authority["primary_machine_id"], run_token=authority["run_token"],
                 native=json.loads(read(native_path)), volume=json.loads(read(volume_path)))
    temporary = destination.with_name(destination.name + "." + str(os.getpid()))
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as stream:
        stream.write(canonical(state)); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, destination)
    fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def main():
    if len(sys.argv)>1 and sys.argv[1]=='guest':
        parser=argparse.ArgumentParser(description='Read-only worker /data observation')
        parser.add_argument('--instance',required=True);parser.add_argument('--nonce',required=True)
        args=parser.parse_args(sys.argv[2:]);signal.alarm(30)
        print(json.dumps(capture_worker_guest(args.instance,args.nonce),sort_keys=True));return
    if len(sys.argv) > 1 and sys.argv[1] == "export":
        parser = argparse.ArgumentParser(description="Collect and fence one exact existing worker; no native calls")
        for name in ("registry", "output", "machine", "before", "after", "volume", "snapshot", "target", "packet", "observation"):
            parser.add_argument("--" + name, required=True)
        args = parser.parse_args(sys.argv[2:])
        target = json.loads(read(args.target))
        packet = collect_packet(Path(args.registry), Path(args.output), args.machine, args.before, args.after,
                                args.volume, args.snapshot, target, args.observation)
        export(packet, Path(args.registry).parent.parent, Path(args.registry), Path(args.packet))
        print(json.dumps({"machine_id": args.machine, "packet_sha256": sha(read(args.packet)), "native_calls": 0}))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packet")
    parser.add_argument("--target", required=True)
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--volume", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--size", required=True)
    parser.add_argument("--memory", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--import", action="store_true", dest="import_worker")
    parser.add_argument("--returning", action="store_true")
    parser.add_argument("--packet-sha256")
    args = parser.parse_args()
    require(not (args.returning and args.import_worker), "return verification cannot import capacity")
    if args.import_worker:
        require(args.packet_sha256 == sha(read(Path(args.packet).absolute())), 'worker import packet differs from explicit source seal')
    target = json.loads(read(Path(args.target).absolute()))
    if "target" in target:
        target = target["target"]
    require(target["machine"] == os.environ.get("FLY_MACHINE_ID"), "foreign worker controller")
    if not args.import_worker:
        require(target["common"] == str(Path(args.packet).absolute().parents[2]), "worker proof outside destination common")
    result = verify(Path(args.packet).absolute(), target,
                    Path(args.before).absolute(), Path(args.after).absolute(), Path(args.volume).absolute(),
                    args.source, args.node, args.python, args.size, args.memory, returning=args.returning, importing=args.import_worker)
    require(fields(originals(result)["registry/meta"])["app"] == args.app, "foreign worker application")
    if args.import_worker:
        import_packet(result, target["common"], target)
    print(result["machine_id"], result["volume_id"], sha(read(Path(args.packet).absolute())))


if __name__ == "__main__":
    main()
