#!/usr/bin/env python3
"""Prove an exact canceled cohort never passed its controller boot barrier.

Pool-only prestart recovery and the recognized historical fresh-configured
phase have separate admission contracts. Neither grants benchmark credit or
substitutes a stopped Machine for a guest cleanup acknowledgement.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import runpy
import socket
import signal
import stat
import subprocess
from datetime import datetime
from pathlib import Path


MACHINE = re.compile(r"[0-9a-f]{14}\Z")
OWNER = re.compile(r"[0-9a-f]{32}\Z")
SAFE = re.compile(r"[A-Za-z0-9._-]+\Z")
VOLUME = re.compile(r"vol_[A-Za-z0-9]+\Z")
FRESH_SCHEMA = "cloudbench-fresh-configured-no-start-v1"
FRESH_PROOF = "fresh-prestart-recovery.json"
FRESH_ADMISSION_MARKERS = (
    "status-proxy.port", "cloudbench-boot-start.log", "post-config-start.accepted", "cloudbench-run.json",
    "worker-runtime-evidence", "worker-clones.ids", "runtime-evidence.owner.json", "runtime-evidence.pending",
    "boot-config-unapplied", "boot-config-host-replaced", "guest-shutdown.confirmed",
)
# Reviewed historical startup protocol. Accepting an arbitrary Git object with
# a few matching blocks would miss extra launch paths elsewhere in that object.
FRESH_SOURCE_PROTOCOL = {
    "run-bench-fleet": "21c75125329daef872a824204210fbd853b551f82d1c358642c2b5aaab31e9a1",
    "run-bench-cloud": "56cccd65d8059268ae8a00a63076bc7e5bb8dc86c8fe31790e78b5559f4fe820",
    "cloudbench-boot.sh": "66ce198f59bc8f6c32e4667e11151dcec5fb81631ddafb86624a69540464fa9c",
    "cloudbench-run.sh": "1958de1798e8fdc46bd2081c1d530e9574c0957db80857d367802904f5ad5521",
}
FRESH_CANCEL_PROTOCOL = {
    "deploy_test_cloud.py": "edc9fc221e3b04e897f492b725fb0cc237624adf8fe3db0279ca3b6746b16cee",
    "deploy_test_process.py": "7774f01419e4318ad451565b40a5025c9ac4bcaa9bc84ada9123b94e7773818b",
    "deploy_test_supervisor.py": "fd292e7d18a197e31e19dd7c66d625db5ddaa8677f3d74dffe8c4af6369c236e",
}


def bounded_read(path: Path, limit: int = 8 * 1024 * 1024) -> bytes:
    if path.resolve(strict=True) != path:
        raise ValueError("linked prestart evidence")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError("unsafe prestart evidence")
        data = stream.read(before.st_size + 1)
        after = path.stat()
        if len(data) != before.st_size or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("changed prestart evidence")
        return data


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def fresh_layout(registry: Path, audit_root: Path) -> tuple[dict, Path, list[dict]]:
    """Local allocation census, not a claim that a guest never ran."""
    require(registry.is_absolute() and registry.resolve() == registry
            and directory(registry) and bool(OWNER.fullmatch(registry.name)), "unsafe fresh owner")
    meta = fields(registry / "meta")
    require(meta.get("version") == "2" and meta.get("fleet_owner_token") == registry.name
            and meta.get("cleanup_policy") in {"retain", "reap"}
            and meta.get("host") == socket.gethostname(), "foreign fresh owner")
    require(meta.get("pid", "").isdigit() and int(meta["pid"]) > 1
            and str(int(meta["pid"])) == meta["pid"] and bool(meta.get("pid_start")), "missing owner birth")
    # The canonical caller owns the recovery lock and process-group join guard.
    # Refuse even a reused PID here; absence is the narrow safe case.
    try:
        os.kill(int(meta["pid"]), 0)
    except ProcessLookupError:
        pass
    else:
        raise ValueError("fresh owner PID is still present")
    run = Path(meta.get("runs_root", "")) / meta.get("run_id", "")
    audit = audit_root / registry.name
    require(run.is_absolute() and run.resolve() == run and directory(run)
            and audit.is_absolute() and audit.resolve() == audit and directory(audit)
            and bool(SAFE.fullmatch(meta.get("run_id", "")))
            and meta.get("audit_dir") == str(audit), "unbound fresh run")
    require(all(fields(audit / "meta").get(k) == meta[k] for k in ("fleet_owner_token", "run_id", "app")), "foreign fresh audit")
    tasks = json.loads(bounded_read(run / "_batch/benches.json", 65536))
    require(isinstance(tasks, list) and 0 < len(tasks) <= 32, "unsafe fresh cohort size")
    rows = []
    for index, task in enumerate(tasks):
        bench = task.get("name", "") if isinstance(task, dict) else ""
        require(bool(SAFE.fullmatch(bench)) and bench not in {".", ".."}, "unsafe fresh task")
        output = run / bench
        require(directory(output) and output.resolve() == output, "unsafe fresh output")
        parts = bounded_read(output / ".cid", 256).decode().split()
        require(len(parts) == 2 and parts[0] == "clone" and bool(MACHINE.fullmatch(parts[1])), "not an exact fresh primary")
        machine = parts[1]
        clone = bounded_read(audit / "by-machine-id" / machine, 256).decode().strip()
        require(bool(SAFE.fullmatch(clone)), "unsafe fresh clone name")
        row = fields(audit / "fresh" / clone)
        require(row.get("version") == "1" and all(row.get(k) == meta[k] for k in ("fleet_owner_token", "run_id", "app"))
                and row.get("source") == "fresh-clone" and row.get("disposition") == "owned"
                and row.get("machine_id") == machine and row.get("clone_name") == clone
                and bool(MACHINE.fullmatch(row.get("source_machine_id", "")))
                and bool(VOLUME.fullmatch(row.get("volume_id", ""))), "unbound fresh allocation")
        require(fields(audit / "expected-fresh" / clone) == {"clone_name": clone, "source_machine_id": row["source_machine_id"]}, "unbound clone intent")
        require(fields(registry / "clones" / clone) == {"name": clone, "id": machine, "volume_id": row["volume_id"]}, "unbound clone registry")
        require(bounded_read(output / "primary.ids", 256).decode().split() == [machine]
                and not bounded_read(output / "primary.names", 256), "ambiguous primary ledger")
        rows.append({**row, "bench": bench, "ordinal": index})
    require(len({r["machine_id"] for r in rows}) == len(rows)
            and len({r["bench"] for r in rows}) == len(rows)
            and len({r["volume_id"] for r in rows}) == len(rows), "duplicate fresh allocation")
    clones = {r["clone_name"] for r in rows}
    machines = {r["machine_id"] for r in rows}
    for directory_path, expected in ((registry / "clones", clones), (audit / "fresh", clones),
                                     (audit / "expected-fresh", clones), (audit / "by-machine-id", machines)):
        require(directory(directory_path) and {p.name for p in directory_path.iterdir()} == expected, "unaccounted fresh allocation or worker")
    for name in ("pool", "archived-reuse", "volume-migrations"):
        p = audit / name
        require(absent(p) or (directory(p) and not list(p.iterdir())), "mixed fresh cohort")
    return meta, run, rows


def fresh_sources(meta: dict, run: Path, scripts: Path) -> tuple[dict, dict[str, bytes]]:
    provenance = json.loads(bounded_read(run / "execution-provenance.json", 65536))
    contract = runpy.run_path(str(scripts / "cloudbench_execution_provenance.py"))
    require(not contract["validate_provenance"](provenance), "invalid source provenance")
    require(provenance["workspace_patch_sha256"] == "none"
            and provenance["config"]["values"].get("boot_launch") == "1"
            and provenance["config"]["values"].get("requested_boot_transport") == "config", "unsupported source or boot transport")
    sources = {}
    for name in ("run-bench-fleet", "run-bench-cloud", "cloudbench-boot.sh", "cloudbench-run.sh"):
        sources[name] = subprocess.check_output(["git", "--no-optional-locks", "-C", meta["workspace_root"],
                                               "show", provenance["base_sha"] + ":scripts/" + name], timeout=10)
    require({name: hashlib.sha256(data).hexdigest() for name, data in sources.items()}
            == FRESH_SOURCE_PROTOCOL, "unrecognized full historical startup protocol")
    return provenance, sources


def verify_cancellation(meta: dict, run: Path, provenance: dict) -> dict:
    """Bind the original native waitpid receipt, never a reconstructed exit."""
    require(bool(re.fullmatch(r"proc-start:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-9][0-9]*",
                              meta["pid_start"])), "unbound owner birth")
    source_hashes = {}
    for name in FRESH_CANCEL_PROTOCOL:
        data = subprocess.check_output(["git", "--no-optional-locks", "-C", meta["workspace_root"],
                                        "show", provenance["base_sha"] + ":scripts/" + name], timeout=10)
        source_hashes[name] = hashlib.sha256(data).hexdigest()
    require(source_hashes == FRESH_CANCEL_PROTOCOL, "unrecognized cancellation producer")
    # deploy_test_cloud.launch owns <base>/runs and <base>/cli.log;
    # run_owned derives this receipt path from that exact log descriptor.
    path = run.parent.parent / "cli.log.process.json"
    raw = bounded_read(path, 1024 * 1024)
    value = json.loads(raw)
    require(isinstance(value, dict) and value.get("cancelled") is True
            and value.get("timed_out") is False and value.get("quiescent") is True
            and value.get("remaining") == [] and value.get("error") is None
            and type(value.get("orphaned_children")) is bool
            and type(value.get("native_exit")) is int and value["native_exit"] == -signal.SIGKILL,
            "original cancellation did not close its process tree")
    supervisor, child = value.get("supervisor_pid"), value.get("child_pid")
    require(type(supervisor) is int and type(child) is int and supervisor > 1 and child > 1
            and supervisor != child, "invalid original supervisor identity")
    rows, terms, kills = (value.get(k) for k in ("reaped", "term_sent", "kill_sent"))
    require(isinstance(rows, list) and 1 < len(rows) <= 4096
            and all(isinstance(r, dict) and set(r) == {"pid", "status"}
                    and type(r["pid"]) is int and r["pid"] > 1 and r["pid"] != supervisor
                    and type(r["status"]) is int and 0 <= r["status"] <= 65535
                    and (os.WIFEXITED(r["status"]) or os.WIFSIGNALED(r["status"])) for r in rows),
            "invalid native wait records")
    reaped = {r["pid"]: r["status"] for r in rows}
    require(len(reaped) == len(rows) and isinstance(terms, list) and isinstance(kills, list)
            and all(type(pid) is int and pid > 1 and pid in reaped for pid in terms + kills)
            and len(set(terms)) == len(terms) and len(set(kills)) == len(kills)
            and set(kills) <= set(terms) and os.waitstatus_to_exitcode(reaped.get(child, 0)) == value["native_exit"],
            "unjoined or mismatched cancellation")
    owner_pid = int(meta["pid"])
    require(owner_pid in terms and owner_pid in reaped
            and os.WIFSIGNALED(reaped[owner_pid]) and os.WTERMSIG(reaped[owner_pid]) in {signal.SIGTERM, signal.SIGKILL},
            "exact owner was not natively joined after cancellation")
    return {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "owner_pid": owner_pid,
            "owner_pid_start": meta["pid_start"], "owner_wait_status": reaped[owner_pid],
            "supervisor_pid": supervisor, "child_pid": child, "source_sha256": source_hashes}


def verify_worker_channels(meta: dict, run: Path, rows: list[dict]) -> dict:
    """Missing primary ledger does not erase borrowed or shared worker custody."""
    for row in rows:
        out = run / row["bench"]
        require(not any(p.name.startswith("worker") for p in out.iterdir()), "worker ownership channel exists")
    common = Path(meta["audit_dir"]).parent.parent
    owner = meta["fleet_owner_token"]
    owned = {owner, meta["run_id"], *(row["machine_id"] for row in rows)}
    def belongs(value):
        if isinstance(value, dict):
            if (str(value.get("pid")) == meta["pid"] and value.get("pid_start") == meta["pid_start"]
                    and value.get("host") == meta["host"]):
                return True
            return any(belongs(v) for v in value.values())
        if isinstance(value, list):
            return any(belongs(v) for v in value)
        return isinstance(value, str) and (value in owned or value.startswith(owner + "-"))
    total, count = 0, 0
    for directory_path in (common / "cloudbench-pool-claims", common / "cloudbench-worker-reuse/imported"):
        if absent(directory_path):
            continue
        require(directory(directory_path) and directory_path.resolve() == directory_path, "unsafe shared worker ownership directory")
        for path in directory_path.iterdir():
            if path.name == ".locks" and directory(path):
                continue
            count += 1
            require(count <= 4096, "worker ownership census exceeds bound")
            data = bounded_read(path, 65536)
            total += len(data)
            require(total <= 8 * 1024 * 1024, "worker ownership census exceeds byte bound")
            if data.lstrip().startswith(b"{"):
                claim = json.loads(data)
            else:
                pairs = [line.split("=", 1) for line in data.decode().splitlines()]
                require(all(len(p) == 2 for p in pairs) and len(dict(pairs)) == len(pairs), "malformed worker claim")
                claim = dict(pairs)
            require(not belongs(claim), "shared worker ownership still belongs to this cohort")
    return {"ledger": "absent", "output_channels": "absent", "matching_shared_claims": []}


def verify_native_pair(row, owner, meta, provenance, sources, payload, pair, history_pair):
    payload_hash = hashlib.sha256(payload).hexdigest()
    require(pair[0] == pair[1], "fresh native identity changed during proof")
    native = pair[0]
    require(native.get("id") == row["machine_id"] and native.get("name") == row["clone_name"]
            and native.get("state") == "stopped" and native.get("version")
            and native.get("version") == native.get("instance_id"), "unsafe fresh native identity")
    events = native.get("events", [])
    require(history_pair[0] == history_pair[1] == events, "native event history differs or changed")
    require(len(events) == 3 and sorted((e.get("type", ""), e.get("status", "")) for e in events)
            == [("launch", "created"), ("launch", "pending"), ("update", "stopped")], "native history does not prove initial stopped configuration")
    require(all(isinstance(e.get("id"), str) and bool(SAFE.fullmatch(e["id"]))
                and type(e.get("timestamp")) is int and e["timestamp"] > 0 for e in events)
            and len({e["id"] for e in events}) == 3, "invalid native event identity or clock")
    ordered = sorted(events, key=lambda e: e["timestamp"])
    require([(e["type"], e["status"], e.get("source")) for e in ordered] == [
        ("launch", "pending", "flyd"), ("launch", "created", "user"), ("update", "stopped", "flyd")]
        and ordered[0]["timestamp"] < ordered[1]["timestamp"] <= ordered[2]["timestamp"], "invalid native event order")
    def epoch_ms(value):
        require(isinstance(value, str) and (value.endswith("Z") or value.endswith("+00:00")), "invalid native timestamp")
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    created, updated = epoch_ms(native.get("created_at")), epoch_ms(native.get("updated_at"))
    require(0 < created <= ordered[0]["timestamp"]
            and updated <= ordered[-1]["timestamp"] < updated + 1000, "native creation/update clock mismatch")
    config = native.get("config", {})
    # Machines API service autostart defaults to false (unlike fly.toml):
    # https://fly.io/docs/machines/api/machines-resource/
    services = config.get("services", [])
    require(isinstance(services, list) and all(isinstance(s, dict)
            and all(type(s.get(k, False)) is bool and not s.get(k, False)
                    for k in ("autostart", "auto_start_machines")) for s in services), "unsafe service autostart")
    require(config.get("init") == {"cmd": ["bash", "/cloudbench-boot.sh"]}
            and len(config.get("mounts", [])) == 1
            and config["mounts"][0].get("volume") == row["volume_id"]
            and config.get("restart") == {"policy": "no"}, "unsafe fresh boot config")
    env = config.get("env", {})
    require(all(env.get(k) == v for k, v in {
        "CLOUDBENCH_BOOT": "1", "CLOUDBENCH_RUN_TOKEN": f'{owner}-{row["ordinal"]}',
        "CLOUDBENCH_START_BARRIER": meta["run_id"], "REF": provenance["base_sha"],
        "CLOUDBENCH_BOOT_PAYLOAD_SHA256": payload_hash}.items()), "unbound native boot payload")
    files = config.get("files", [])
    require(len({f.get("guest_path") for f in files}) == len(files), "duplicate native files")
    decoded = {f["guest_path"]: base64.b64decode(f["raw_value"], validate=True) for f in files}
    require(decoded.get("/cloudbench-boot.sh") == sources["cloudbench-boot.sh"]
            and decoded.get("/cloudbench-boot-payload.json.gz") == payload, "native payload differs from original")
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
        expanded = stream.read(8 * 1024 * 1024 + 1)
    require(len(expanded) <= 8 * 1024 * 1024, "oversized boot payload")
    envelope = json.loads(expanded)
    require(envelope.get("version") == 1 and base64.b64decode(envelope["files"]["cloudbench-run.sh"], validate=True)
            == sources["cloudbench-run.sh"], "unbound original driver")


def validate_fresh(registry: Path, audit_root: Path, native_dir: Path, scripts: Path) -> list[tuple[Path, bytes]]:
    meta, run, rows = fresh_layout(registry, audit_root)
    provenance, sources = fresh_sources(meta, run, scripts)
    cancellation = verify_cancellation(meta, run, provenance)
    worker_ownership = verify_worker_channels(meta, run, rows)
    barrier = run / ".boot-config-barrier"
    require(directory(barrier) and directory(barrier / "ready") and not list((barrier / "ready").iterdir())
            and absent(barrier / "release"), "fresh boot barrier is not unreleased")
    natives, histories, receipts, originals = {}, {}, [], {}
    total_native_bytes = 0
    for row in rows:
        out = run / row["bench"]
        for name in FRESH_ADMISSION_MARKERS:
            require(absent(out / name), "fresh prestart conflicts with admission evidence")
        payload = bounded_read(out / "cloudbench-boot-payload.json.gz", 2 * 1024 * 1024)
        originals[row["bench"]] = hashlib.sha256(payload).hexdigest()
        pair, history_pair = [], []
        for phase in ("before", "after"):
            for suffix, target in (("json", pair), ("events.json", history_pair)):
                data = bounded_read(native_dir / f'{row["machine_id"]}.{phase}.{suffix}')
                total_native_bytes += len(data)
                require(total_native_bytes <= 6 * 1024 * 1024, "oversized fresh native cohort")
                target.append(json.loads(data))
        verify_native_pair(row, registry.name, meta, provenance, sources, payload, pair, history_pair)
        natives[row["machine_id"]] = pair
        histories[row["machine_id"]] = history_pair
        receipt = {"version": 1, "kind": "no-guest-start", "phase": FRESH_SCHEMA, "proof_credit": 0,
                   "fleet_owner_token": registry.name, "run_id": meta["run_id"], "bench": row["bench"],
                   "machine_id": row["machine_id"], "volume_id": row["volume_id"], "provider_state": "stopped", "barrier": "unreleased"}
        receipts.append((out / "guest-never-started.confirmed", (json.dumps(receipt, sort_keys=True) + "\n").encode()))
    proof = {"schema": FRESH_SCHEMA, "owner": registry.name, "run_id": meta["run_id"], "proof_credit": 0,
             "registry_path": str(registry),
             "owner_metadata": {k: v for k, v in meta.items() if k != "cleanup_policy"},
             "allocations": rows, "native": natives, "events": histories, "payload_sha256": originals,
             "cancellation": cancellation, "worker_ownership": worker_ownership,
             "source_sha256": {k: hashlib.sha256(v).hexdigest() for k, v in sources.items()}}
    serialized = (json.dumps(proof, sort_keys=True) + "\n").encode()
    require(len(serialized) <= 8 * 1024 * 1024, "oversized fresh proof")
    receipts.insert(0, (run / "_batch" / FRESH_PROOF, serialized))
    return receipts


def verify_fresh(registry: Path, audit_root: Path, scripts: Path) -> set[str]:
    """Reverify every original and the sealed native pair before latch release."""
    meta, run, rows = fresh_layout(registry, audit_root)
    proof_path = run / "_batch" / FRESH_PROOF
    proof = json.loads(bounded_read(proof_path))
    require(proof.get("schema") == FRESH_SCHEMA, "unsupported fresh proof")
    # Validation uses the immutable native records sealed by the producer. No
    # provider mutation or fresh guest execution is needed by this consumer.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="cloudbench-prestart-verify-") as temporary:
        root = Path(temporary).resolve(strict=True)
        for machine, pair in proof["native"].items():
            require(bool(MACHINE.fullmatch(machine)) and len(pair) == 2, "unsafe sealed native pair")
            for phase, value in zip(("before", "after"), pair):
                (root / f"{machine}.{phase}.json").write_text(json.dumps(value))
            for phase, value in zip(("before", "after"), proof["events"][machine]):
                (root / f"{machine}.{phase}.events.json").write_text(json.dumps(value))
        expected = validate_fresh(registry, audit_root, root, scripts)
    for path, value in expected:
        require(bounded_read(path) == value, "fresh recovery receipt or originals changed")
    return {r["bench"] for r in rows}


def verify_fresh_machine(registry: Path, machine: str, native_dir: Path, scripts: Path) -> None:
    """Reaper fence after whole-cohort proof, including partial-reap retries."""
    require(bool(MACHINE.fullmatch(machine)), "unsafe reaper Machine")
    meta = fields(registry / "meta")
    run = Path(meta["runs_root"]) / meta["run_id"]
    proof = json.loads(bounded_read(run / "_batch" / FRESH_PROOF))
    require(proof.get("schema") == FRESH_SCHEMA and proof.get("owner") == registry.name
            and proof.get("run_id") == meta["run_id"] and proof.get("proof_credit") == 0, "unbound reaper proof")
    provenance, sources = fresh_sources(meta, run, scripts)
    require(proof["source_sha256"] == {k: hashlib.sha256(v).hexdigest() for k, v in sources.items()}, "reaper source changed")
    require(proof["cancellation"] == verify_cancellation(meta, run, provenance), "reaper cancellation evidence changed")
    require(proof["worker_ownership"] == verify_worker_channels(meta, run, proof["allocations"]), "worker ownership changed")
    original = proof["native"][machine][1]
    require(original["id"] == machine and original["state"] == "stopped", "unsafe original reaper state")
    audit = Path(meta["audit_dir"])
    row = fields(audit / "fresh" / original["name"])
    require(row.get("machine_id") == machine and row.get("volume_id") == original["config"]["mounts"][0]["volume"]
            and row.get("fleet_owner_token") == registry.name and row.get("disposition") == "owned", "reaper allocation changed")
    for phase in ("before", "after"):
        require(json.loads(bounded_read(native_dir / f"{machine}.{phase}.json")) == original,
                "fresh Machine changed after no-start proof")
        require(json.loads(bounded_read(native_dir / f"{machine}.{phase}.events.json")) == proof["events"][machine][1],
                "fresh Machine history changed after no-start proof")


def verify_released_fresh(audit: Path, run: Path, scripts: Path) -> dict:
    """Read-only post-release evidence verification; never rebuild a registry."""
    proof_path = run / "_batch" / FRESH_PROOF
    raw = bounded_read(proof_path)
    proof = json.loads(raw)
    owner = audit.name
    require(audit.is_absolute() and audit.resolve() == audit and bool(OWNER.fullmatch(owner))
            and run.is_absolute() and run.resolve() == run, "unsafe released evidence paths")
    meta = proof["owner_metadata"]
    require(proof.get("schema") == FRESH_SCHEMA and proof.get("owner") == owner
            and proof.get("proof_credit") == 0 and proof.get("run_id") == run.name
            and meta.get("fleet_owner_token") == owner and meta.get("audit_dir") == str(audit)
            and Path(meta["runs_root"]) / meta["run_id"] == run, "released proof identity mismatch")
    registry = Path(proof["registry_path"])
    require(registry == audit.parent.parent / "cloudbench-fleet-ownership" / owner, "released registry path mismatch")
    require(absent(registry), "owner registry has not been released")
    actual_meta = fields(audit / "meta")
    require(all(actual_meta.get(k) == meta[k] for k in ("app", "run_id", "fleet_owner_token"))
            and actual_meta.get("status") == "provider-teardown-verified", "missing canonical final audit")
    require(bounded_read(audit / "provider-teardown-verified.epoch", 32).strip().isdigit()
            and int(bounded_read(audit / "provider-teardown-verified.epoch", 32)) > 0, "missing final audit clock")
    provenance, sources = fresh_sources(meta, run, scripts)
    require(proof["source_sha256"] == FRESH_SOURCE_PROTOCOL, "released source authority changed")
    require(proof["cancellation"] == verify_cancellation(meta, run, provenance), "released cancellation evidence changed")
    allocations = proof["allocations"]
    require(isinstance(allocations, list) and 0 < len(allocations) <= 32, "invalid released cohort")
    # These canonical audit ledgers are historical allocation evidence; only
    # the registry is consumed. Require the complete exact history, not erasure.
    for name, field in (("owned-clones.ids", "machine_id"), ("owned-clones.names", "clone_name")):
        recorded = bounded_read(audit / name, 65536).decode().splitlines()
        expected = [row[field] for row in allocations]
        require(len(recorded) == len(set(recorded)) == len(expected)
                and set(recorded) == set(expected), "released historical allocation ledger differs")
    require(proof["worker_ownership"] == verify_worker_channels(meta, run, allocations), "released worker evidence changed")
    tasks = json.loads(bounded_read(run / "_batch/benches.json", 65536))
    require([r["bench"] for r in allocations] == [t["name"] for t in tasks]
            and [r["ordinal"] for r in allocations] == list(range(len(allocations)))
            and len({r["machine_id"] for r in allocations}) == len(allocations)
            and {p.name for p in (audit / "fresh").iterdir()} == {r["clone_name"] for r in allocations}, "released cohort mismatch")
    for row in allocations:
        actual = fields(audit / "fresh" / row["clone_name"])
        require(actual.get("disposition") in {"destroyed-verified-absent", "destroyed-provider-retained"}
                and {k: v for k, v in actual.items() if k != "disposition"}
                == {k: v for k, v in row.items() if k not in {"disposition", "bench", "ordinal"}}, "nonterminal or changed final allocation")
        out = run / row["bench"]
        require(all(absent(out / name) for name in FRESH_ADMISSION_MARKERS), "released no-start phase changed")
        require(bounded_read(out / ".cid", 256).decode().split() == ["clone", row["machine_id"]], "released output changed")
        receipt = json.loads(bounded_read(out / "guest-never-started.confirmed", 4096))
        require(receipt == {"version": 1, "kind": "no-guest-start", "phase": FRESH_SCHEMA, "proof_credit": 0,
                           "fleet_owner_token": owner, "run_id": run.name, "bench": row["bench"],
                           "machine_id": row["machine_id"], "volume_id": row["volume_id"],
                           "provider_state": "stopped", "barrier": "unreleased"}, "released no-start receipt changed")
        payload = bounded_read(out / "cloudbench-boot-payload.json.gz", 2 * 1024 * 1024)
        require(hashlib.sha256(payload).hexdigest() == proof["payload_sha256"][row["bench"]], "released payload changed")
        verify_native_pair(row, owner, meta, provenance, sources, payload,
                           proof["native"][row["machine_id"]], proof["events"][row["machine_id"]])
    return {"schema": "cloudbench-released-fresh-no-start-verified-v1", "owner": owner, "run_id": run.name,
            "proof_credit": 0, "provider_teardown_verified": True,
            "proof_sha256": hashlib.sha256(raw).hexdigest(), "machine_ids": [r["machine_id"] for r in allocations]}


def regular(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size <= 65_536


def directory(path: Path) -> bool:
    try:
        return stat.S_ISDIR(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def fields(path: Path) -> dict[str, str]:
    if not regular(path):
        raise ValueError(f"missing or unsafe metadata: {path}")
    result: dict[str, str] = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if not separator or not key or key in result:
            raise ValueError(f"malformed metadata: {path}")
        result[key] = value
    return result


def absent(path: Path) -> bool:
    return not path.exists() and not path.is_symlink()


def receipt_payload(owner: str, run_id: str, bench: str, machine: str, volume: str) -> bytes:
    return (
        json.dumps(
            {
                "version": 1,
                "kind": "no-guest-start",
                "fleet_owner_token": owner,
                "run_id": run_id,
                "bench": bench,
                "machine_id": machine,
                "volume_id": volume,
                "provider_state": "stopped",
                "barrier": "unreleased",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode()


def validate(
    registry: Path, audit_root: Path, claims_root: Path, machines_file: Path, app: str
) -> list[tuple[Path, bytes]]:
    if not directory(registry) or not OWNER.fullmatch(registry.name):
        raise ValueError("unsafe exact owner registry")
    meta = fields(registry / "meta")
    owner = registry.name
    run_id = meta.get("run_id", "")
    if (
        meta.get("version") != "2"
        or meta.get("fleet_owner_token") != owner
        or meta.get("app") != app
        or not SAFE.fullmatch(run_id)
        or meta.get("cleanup_policy") != "retain"
        or not regular(registry / "guest-cleanup-unconfirmed")
    ):
        raise ValueError("owner identity or cleanup latch is unsafe")
    runs_root = Path(meta.get("runs_root", ""))
    run = runs_root / run_id
    audit = audit_root / owner
    if (
        not runs_root.is_absolute()
        or not directory(run)
        or run.resolve() != run
        or meta.get("audit_dir") != str(audit)
        or not directory(audit)
        or fields(audit / "meta").get("fleet_owner_token") != owner
    ):
        raise ValueError("run and audit are not bound to exact owner")
    if not directory(registry / "clones") or any((registry / "clones").iterdir()):
        raise ValueError("prestart proof requires pool-only ownership")
    for name in ("fresh", "expected-fresh", "by-machine-id"):
        target = audit / name
        if not directory(target) or any(target.iterdir()):
            raise ValueError("prestart proof has fresh clone ownership")
    for name in ("owned-clones.ids", "owned-clones.names"):
        target = audit / name
        if not regular(target) or target.read_bytes():
            raise ValueError("prestart proof has fresh clone ledger")
    barrier = run / ".boot-config-barrier"
    ready = barrier / "ready"
    if not directory(barrier) or not directory(ready) or not absent(barrier / "release"):
        raise ValueError("guest boot barrier was released or is unsafe")
    batch = run / "_batch" / "benches.json"
    if not regular(batch):
        raise ValueError("missing exact task list")
    tasks = json.loads(batch.read_text())
    if not isinstance(tasks, list) or not tasks or len(tasks) > 32:
        raise ValueError("invalid exact task list")
    if not regular(machines_file):
        # The provider inventory is larger than the small owner metadata.
        info = machines_file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 67_108_864:
            raise ValueError("unsafe provider inventory")
    machines = json.loads(machines_file.read_text())
    if not isinstance(machines, list):
        raise ValueError("invalid provider inventory")
    provider = {item.get("id"): item for item in machines if isinstance(item, dict)}
    pool_dir = audit / "pool"
    if not directory(pool_dir):
        raise ValueError("missing exact pool audit")
    pool = {path.name: fields(path) for path in pool_dir.iterdir()}
    receipts: list[tuple[Path, bytes]] = []
    seen_names: set[str] = set()
    seen_machines: set[str] = set()
    for index, task in enumerate(tasks):
        if not isinstance(task, dict) or not isinstance(task.get("name"), str):
            raise ValueError("invalid task entry")
        bench = task["name"]
        if not SAFE.fullmatch(bench) or bench in seen_names:
            raise ValueError("duplicate or unsafe task name")
        seen_names.add(bench)
        output = run / bench
        cid = output / ".cid"
        if not directory(output) or not regular(cid):
            raise ValueError("missing exact guest mapping")
        parts = cid.read_text().split()
        if len(parts) != 2 or parts[0] != "pool" or not MACHINE.fullmatch(parts[1]):
            raise ValueError("invalid pool guest mapping")
        machine = parts[1]
        if machine in seen_machines:
            raise ValueError("duplicate pool Machine")
        seen_machines.add(machine)
        row = pool.get(machine)
        if row is None or not VOLUME.fullmatch(row.get("volume_id", "")):
            raise ValueError("missing exact pool volume")
        volume = row["volume_id"]
        if (
            row.get("fleet_owner_token") != owner
            or row.get("run_id") != run_id
            or row.get("app") != app
            or row.get("source") != "borrowed-pool"
            or row.get("machine_id") != machine
            or row.get("disposition") != "claimed"
        ):
            raise ValueError("pool audit does not match owner")
        claim = fields(claims_root / machine)
        if (
            claim.get("fleet_owner_token") != owner
            or claim.get("host") != meta.get("host")
            or claim.get("pid") != meta.get("pid")
            or claim.get("pid_start") != meta.get("pid_start")
            or claim.get("cleanup_state") not in ("unconfirmed", "owned")
        ):
            raise ValueError("pool claim does not match owner")
        machine_record = provider.get(machine)
        mounts = (machine_record or {}).get("config", {}).get("mounts", [])
        if (
            not isinstance(machine_record, dict)
            or machine_record.get("state") != "stopped"
            or not isinstance(mounts, list)
            or len(mounts) != 1
            or mounts[0].get("volume") != volume
        ):
            raise ValueError("provider Machine is not stopped on exact volume")
        if any(
            not absent(output / name)
            for name in (
                "post-config-start.accepted",
                "status-proxy.port",
                "cloudbench-boot-start.log",
                "cloudbench-run.json",
                "worker-runtime-evidence",
                "guest-shutdown.confirmed",
            )
        ):
            raise ValueError("guest may have started or emitted runtime evidence")
        worker_ids = output / "worker-clones.ids"
        owner_file = output / "runtime-evidence.owner.json"
        pending_file = output / "runtime-evidence.pending"
        expected_owner = {
            "version": 1,
            "machine_id": machine,
            "run_token": f"{owner}-{index}",
        }
        if (
            not regular(worker_ids)
            or worker_ids.read_bytes()
            or not regular(owner_file)
            or not regular(pending_file)
            or owner_file.read_bytes() != pending_file.read_bytes()
            or json.loads(owner_file.read_text()) != expected_owner
        ):
            raise ValueError("preallocated runtime ownership is not exact or has workers")
        unapplied = output / "boot-config-unapplied"
        ready_marker = ready / machine
        if not (
            (regular(unapplied) and unapplied.read_text().strip() == machine and absent(ready_marker))
            or (absent(unapplied) and regular(ready_marker) and not ready_marker.read_bytes())
        ):
            raise ValueError("guest boot state is not exactly accounted")
        receipts.append(
            (
                output / "guest-never-started.confirmed",
                receipt_payload(owner, run_id, bench, machine, volume),
            )
        )
    if seen_machines != set(pool) or {path.name for path in ready.iterdir()} - seen_machines:
        raise ValueError("pool or barrier has an unmapped Machine")
    return receipts


def publish(receipts: list[tuple[Path, bytes]]) -> None:
    for path, payload in receipts:
        if not absent(path):
            if bounded_read(path) != payload:
                raise ValueError("existing prestart receipt differs")
            continue
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        try:
            os.replace(temporary, path)
            parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--audit-root", type=Path)
    parser.add_argument("--claims-root", type=Path)
    parser.add_argument("--machines-json", type=Path)
    parser.add_argument("--app")
    fresh = parser.add_mutually_exclusive_group()
    fresh.add_argument("--fresh-plan", action="store_true")
    fresh.add_argument("--fresh-native-dir", type=Path)
    fresh.add_argument("--verify-fresh", action="store_true")
    fresh.add_argument("--verify-fresh-machine")
    fresh.add_argument("--verify-released-fresh", type=Path, metavar="AUDIT")
    parser.add_argument("--native-dir", type=Path)
    parser.add_argument("--run", type=Path)
    args = parser.parse_args()
    scripts = Path(__file__).resolve().parent
    if args.verify_released_fresh:
        if not args.run:
            parser.error("--verify-released-fresh requires --run")
        print(json.dumps(verify_released_fresh(args.verify_released_fresh, args.run, scripts), sort_keys=True))
        return
    if not args.registry or not args.audit_root:
        parser.error("recovery requires --registry and --audit-root")
    if args.verify_fresh_machine:
        if not args.native_dir:
            parser.error("--verify-fresh-machine requires --native-dir")
        verify_fresh_machine(args.registry, args.verify_fresh_machine, args.native_dir, scripts)
        return
    if args.fresh_plan:
        _, _, rows = fresh_layout(args.registry, args.audit_root)
        for row in rows:
            print(row["machine_id"])
        return
    if args.verify_fresh:
        verify_fresh(args.registry, args.audit_root, scripts)
        return
    if args.fresh_native_dir:
        receipts = validate_fresh(args.registry, args.audit_root, args.fresh_native_dir, scripts)
        publish(receipts)
        verify_fresh(args.registry, args.audit_root, scripts)
        print("verified whole fresh cohort never crossed the boot-config barrier; zero execution credit")
        return
    if not args.claims_root or not args.machines_json or not args.app:
        parser.error("pool proof requires --claims-root, --machines-json and --app")
    receipts = validate(
        args.registry, args.audit_root, args.claims_root, args.machines_json, args.app
    )
    publish(receipts)
    print(f"verified no guest start for {len(receipts)} exact pool Machines")


if __name__ == "__main__":
    main()
