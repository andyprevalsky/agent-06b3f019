#!/usr/bin/env python3
"""Verify completed retained successors without releasing their ownership records."""

import argparse
import hashlib
import json
import math
import os
import re
import stat
from pathlib import Path


def need(value, message):
    if not value:
        raise ValueError(message)


def read(path):
    path = Path(path).absolute()
    need(path.resolve(strict=True) == path, "redirected retained evidence")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        need(
            stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_size <= 2 * 1024 * 1024,
            "invalid retained evidence file",
        )
        raw = stream.read(info.st_size + 1)
        after = os.fstat(stream.fileno())
        keys = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        need(
            len(raw) == info.st_size and all(getattr(after, key) == getattr(info, key) for key in keys),
            "retained evidence changed",
        )
    return raw


def obj(path):
    return json.loads(read(path))


def fields(path):
    pairs = [line.split("=", 1) for line in read(path).decode().splitlines()]
    need(all(len(pair) == 2 for pair in pairs), "invalid retained metadata")
    value = dict(pairs)
    need(len(value) == len(pairs), "duplicate retained metadata")
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: str(item.relative_to(root))):
        need(not path.is_symlink() and (path.is_dir() or path.is_file()), "unsafe retained audit tree")
        if path.is_file() and path.name != "source-audit":
            relative = str(path.relative_to(root)).encode()
            raw = read(path)
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            digest.update(len(raw).to_bytes(8, "big"))
            digest.update(raw)
    return digest.hexdigest()


def files(root):
    need(root.resolve(strict=True) == root and root.is_dir(), "invalid retained directory")
    values = {path.name: path for path in root.iterdir()}
    need(values and all(re.fullmatch(r"[0-9a-f]{14}\.json", name) for name in values), "invalid retained evidence set")
    return values


def terminal(proof, value):
    need(
        proof.get("schema") == "cloudbench-archived-reuse-v1"
        and proof.get("storage_mode") == "retained-volume-fresh-generation",
        "invalid retained proof",
    )
    need(
        value.get("schema") == proof["schema"]
        and value.get("proof") == proof
        and value.get("machine_retained") is True
        and value.get("volume_retained") is True
        and value.get("source") == "archived-reuse",
        "retained terminal proof mismatch",
    )
    claim = proof["claim_id"]
    need(
        re.fullmatch("[0-9a-f]{32}", claim)
        and proof.get("generation_id") == claim
        and proof.get("guest")
        == {
            "data_dir": "/data/.cloudbench-generations/" + claim,
            "repo_dir": "/data/.cloudbench-generations/" + claim + "/repo",
        },
        "retained generation binding changed",
    )
    native = value["native"]
    need(
        native.get("state") in ("stopped", "created")
        and native.get("instance_id")
        and native.get("id") == proof["machine_id"]
        and native.get("name") == proof["native_name"]
        and native.get("created_at") == proof["created_at"]
        and native.get("region") == proof["region"],
        "retained native identity is not inactive",
    )
    config = native["config"]
    need(
        [(mount.get("volume"), mount.get("path")) for mount in config.get("mounts", [])]
        == [(proof["volume_id"], "/data")],
        "retained native volume changed",
    )
    marker = proof["native_marker"]
    need(
        config.get("metadata", {}).get("cloudbench_archived_reuse") == canonical(marker).decode()
        and hashlib.sha256(canonical(marker)).hexdigest() == proof["native_marker_sha256"]
        and marker.get("successor") == proof["successor"]
        and marker.get("claim_id") == proof["claim_id"]
        and marker.get("machine_id") == proof["machine_id"]
        and marker.get("volume_id") == proof["volume_id"],
        "retained native successor changed",
    )


def record(proof_path, terminal_path, audit):
    """Copy only the exact leased STOP/readback receipt before the audit seals."""
    proof = obj(proof_path)
    raw = read(terminal_path)
    value = json.loads(raw)
    terminal(proof, value)
    audit = Path(audit).absolute()
    meta = fields(audit / "meta")
    owner = proof["successor"]["owner_token"]
    need(
        audit.name == owner
        and meta["fleet_owner_token"] == owner
        and meta["run_id"] == proof["successor"]["run_id"]
        and obj(audit / "archived-reuse" / (proof["machine_id"] + ".json")) == proof,
        "retained audit owner mismatch",
    )
    directory = audit / "retained-successors"
    directory.mkdir(mode=0o700, exist_ok=True)
    need(directory.resolve(strict=True) == directory, "redirected retained audit")
    descriptor = os.open(audit, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    target = directory / (proof["machine_id"] + ".json")
    if target.exists():
        need(read(target) == raw, "retained terminal changed")
        return
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def released(registry, audit, fleet, owner, run):
    """Alternative to registry absence; every retained resource stays owned."""
    registry, audit, fleet = (Path(path).absolute() for path in (registry, audit, fleet))
    need(
        re.fullmatch("[0-9a-f]{32}", owner)
        and registry.name == audit.name == owner
        and audit.parent.name == "cloudbench-fleet-audits"
        and registry == audit.parent.parent / "cloudbench-fleet-ownership" / owner,
        "retained registry owner mismatch",
    )
    meta = fields(registry / "meta")
    shared = fields(audit / "meta")
    local = fleet / "teardown-ownership"
    need(
        meta.get("version") == "2"
        and meta.get("fleet_owner_token") == shared.get("fleet_owner_token") == owner
        and meta.get("run_id") == shared.get("run_id") == run == fleet.name
        and meta.get("app") == shared.get("app") == "navi-whisper-lux-bench"
        and shared.get("workspace_root") == meta.get("workspace_root")
        and meta.get("audit_dir") == str(audit)
        and meta.get("runs_root") == str(fleet.parent)
        and fleet.is_relative_to(Path(meta["workspace_root"]) / ".context")
        and shared.get("status") == "provider-teardown-verified"
        and read(local / "meta") == read(audit / "meta"),
        "retained audit is not sealed",
    )
    clones = registry / "clones"
    need(
        clones.resolve(strict=True) == clones and clones.is_dir() and not any(clones.iterdir()),
        "retained registry has unreleased clones",
    )
    for latch in ("guest-cleanup-unconfirmed", "runtime-evidence-unconfirmed"):
        need(not os.path.lexists(registry / latch), "retained cleanup is unconfirmed")
    epoch = read(audit / "provider-teardown-verified.epoch")
    need(
        epoch == read(local / "provider-teardown-verified.epoch") and math.isfinite(float(epoch)) and float(epoch) > 0,
        "retained release clock missing",
    )
    binding = fields(local / "source-audit")
    need(
        binding.get("path") == str(audit) and tree_digest(local) == tree_digest(audit) == binding.get("sha256"),
        "retained audit snapshot unbound",
    )
    entries = files(registry / "archived-reuse")
    need(
        set(entries)
        == set(files(audit / "archived-reuse"))
        == set(files(audit / "retained-successors"))
        == set(files(local / "archived-reuse"))
        == set(files(local / "retained-successors")),
        "retained successor coverage incomplete",
    )
    benches = obj(fleet / "_batch/benches.json")
    tasks = obj(fleet / "_batch/run.json")["tasks"]
    names = {row["name"] for row in benches}
    need(len(names) == len(benches), "duplicate retained task")
    statuses = {row["name"]: str(row.get("benchmark_status") or row.get("status") or "").upper() for row in tasks}
    need(len(statuses) == len(tasks) and set(statuses) == names, "retained task projection changed")
    task_names = set()
    volumes = set()
    for name, path in entries.items():
        raw_proof = read(path)
        proof = json.loads(raw_proof)
        successor = proof["successor"]
        task = successor["task"]
        need(
            name == proof["machine_id"] + ".json"
            and proof["volume_id"] not in volumes
            and successor["owner_token"] == owner
            and successor["run_id"] == run
            and successor["controller_id"] == meta.get("host")
            and task in names
            and task not in task_names
            and re.fullmatch(r"[A-Za-z0-9_.-]+", task)
            and task not in (".", ".."),
            "retained task owner changed",
        )
        task_names.add(task)
        volumes.add(proof["volume_id"])
        need(
            statuses[task]
            in {
                "PASSED",
                "FAILED",
                "SUCCEEDED",
                "SUCCESS",
                "FAILURE",
                "TIMED_OUT",
                "TIMEOUT",
                "WINDOW_FAILED",
                "INFRA_ERROR",
                "ERROR",
                "CANCELLED",
            },
            "retained task has no terminal projection",
        )
        output = fleet / task
        need(
            read(output / ".cid").decode().split() == ["archived-reuse", proof["machine_id"]]
            and read(output / "archived-reuse-proof.json") == raw_proof,
            "retained task allocation changed",
        )
        raw_terminal = read(audit / "retained-successors" / name)
        need(
            read(local / "retained-successors" / name) == raw_terminal
            and read(output / "archived-reuse-retirement/retained-terminal.json") == raw_terminal
            and read(audit / "archived-reuse" / name) == raw_proof
            and read(local / "archived-reuse" / name) == raw_proof,
            "retained snapshot changed",
        )
        terminal(proof, json.loads(raw_terminal))
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    writer = sub.add_parser("record")
    writer.add_argument("--proof", required=True, type=Path)
    writer.add_argument("--terminal", required=True, type=Path)
    writer.add_argument("--audit", required=True, type=Path)
    verifier = sub.add_parser("verify")
    for name in ("registry", "audit", "fleet"):
        verifier.add_argument("--" + name, required=True, type=Path)
    for name in ("owner", "run"):
        verifier.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.action == "record":
        record(args.proof, args.terminal, args.audit)
    else:
        released(args.registry, args.audit, args.fleet, args.owner, args.run)
