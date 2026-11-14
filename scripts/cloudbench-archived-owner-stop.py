#!/usr/bin/env python3
"""Stop only archived exact-owned guests after their disposable controller joined.

Default prepares an immutable plan from supplied evidence; --execute sends at
most one stop per identity. Never deletes, edits config, detaches volumes,
releases ownership, or certifies benchmark/guest/provider-session cleanup.
"""
import argparse
import ast
import base64
from datetime import datetime
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import tarfile
import time

HERE = Path(__file__).resolve().parent
BASE = runpy.run_path(str(HERE/'cloudbench-stop-all.py'))
need, save, until, call, same_machine = (BASE[k] for k in ('need','save','until','call','same_machine'))


def raw(path, limit=16*1024*1024):
    path=Path(path).absolute()
    need(path.resolve(strict=True)==path, 'physical input required')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        s=os.fstat(f.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and not s.st_mode&0o077 and s.st_size<=limit,
             'private regular current-owner input required')
        data=f.read(limit+1)
    need(len(data)<=limit,'oversized input')
    return data


def sha(data): return hashlib.sha256(data).hexdigest()
def obj(path): return json.loads(raw(path))


def manifest_bytes(path):
    """Read export metadata separately from the 16 MiB operational inputs."""
    path = Path(path).absolute()
    need(
        path.name == "manifest.json" and path.parent.name == "export",
        "export manifest required",
    )
    return raw(path, 64 * 1024 * 1024)


def archive_digest(path):
    """Recheck the full export on one private stable descriptor, in bounded memory."""
    path = Path(path).absolute()
    need(
        path.name == "originals.tar.gz" and path.parent.name == "export",
        "export archive required",
    )
    need(path.resolve(strict=True) == path, "physical archive required")

    def stable(s):
        return (
            s.st_dev,
            s.st_ino,
            s.st_mode,
            s.st_uid,
            s.st_gid,
            s.st_nlink,
            s.st_size,
            s.st_mtime_ns,
            s.st_ctime_ns,
        )

    digest = hashlib.sha256()
    with os.fdopen(
        os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
    ) as stream:
        before = os.fstat(stream.fileno())
        need(
            stat.S_ISREG(before.st_mode)
            and before.st_uid == os.getuid()
            and not before.st_mode & 0o077
            and before.st_nlink == 1,
            "private regular current-owner archive required",
        )
        remaining = before.st_size
        while remaining:
            block = stream.read(min(1024 * 1024, remaining))
            need(bool(block), "archive shortened during hashing")
            digest.update(block)
            remaining -= len(block)
        need(
            not stream.read(1)
            and stable(before)
            == stable(os.fstat(stream.fileno()))
            == stable(path.lstat())
            and path.resolve(strict=True) == path,
            "archive changed during hashing",
        )
    return digest.hexdigest()


def digest_file(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''): h.update(block)
    return h.hexdigest()

def fields(data):
    pairs=[line.split('=',1) for line in data.decode().splitlines()]
    need(all(len(p)==2 for p in pairs),'invalid ownership fields')
    value=dict(pairs);need(len(value)==len(pairs),'duplicate ownership fields')
    return value


def acknowledged_create_proofs(
    selected,
    extra,
    claimed,
    requested,
    native,
    terminal,
    protected,
    protected_volumes,
    owned,
):
    """Positive creation ACKs authorize STOP only; never repair archived ownership."""
    proofs = {}
    acknowledgments = {}
    for path, data in extra.items():
        if not path.endswith("/primary.log"):
            continue
        text = data.decode()
        for mid in re.findall(
            r"^\s*Machine ([0-9a-f]{14}) has been created\.\.\.$", text, re.M
        ):
            acknowledgments.setdefault(mid, []).append(path)
    for path, row in selected.items():
        match = re.fullmatch(
            r"(git-common/cloudbench-fleet-ownership/([0-9a-f]{32}))/clones/(cloudbench-[0-9a-f]{24})",
            path,
        )
        if not match or row.get("id"):
            continue
        prefix, owner, name = match.groups()
        meta = selected.get(prefix + "/meta", {})
        need(row == {"name": name}, "ambiguous unsealed creation record")
        run_id = meta.get("run_id", "")
        workspace = meta.get("workspace_root", "")
        need(
            re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9]+", run_id)
            and workspace.startswith("/")
            and meta.get("runs_root") == workspace + "/.context/fleet/runs"
            and meta.get("audit_dir")
            == workspace + "/.git/cloudbench-fleet-audits/" + owner,
            "unsealed creation owner paths differ",
        )
        audit = "git-common/cloudbench-fleet-audits/" + owner
        expected_path = audit + "/expected-fresh/" + name
        fresh_path = audit + "/fresh/" + name
        if expected_path not in extra or fresh_path not in extra:
            continue
        expected, fresh = fields(extra[expected_path]), fields(extra[fresh_path])
        source = expected.get("source_machine_id", "")
        need(
            expected == {"clone_name": name, "source_machine_id": source}
            and re.fullmatch("[0-9a-f]{14}", source)
            and fresh
            == {
                "version": "1",
                "fleet_owner_token": owner,
                "run_id": run_id,
                "app": meta["app"],
                "clone_name": name,
                "source": "fresh-clone",
                "source_machine_id": source,
                "machine_id": "",
                "volume_id": "",
                "disposition": "ownership-pending",
            },
            "unsealed creation audit differs",
        )
        for log, data in extra.items():
            if not re.fullmatch(
                re.escape("context/fleet/runs/" + run_id + "/") + r"[^/]+/primary\.log",
                log,
            ):
                continue
            text = data.decode()
            headers = list(
                re.finditer(
                    r"^clone name=(\S+) source=(\S+) status=([0-9]+) attempt=([1-9][0-9]*)/([1-9][0-9]*)$",
                    text,
                    re.M,
                )
            )
            for index, header in enumerate(headers):
                if header[1] != name:
                    continue
                end = (
                    headers[index + 1].start()
                    if index + 1 < len(headers)
                    else len(text)
                )
                block = text[header.end() : end]
                ids = re.findall(
                    r"^\s*Machine ([0-9a-f]{14}) has been created\.\.\.$", block, re.M
                )
                if not requested.intersection(ids):
                    continue
                need(
                    header[2] == source and header[3] == "0" and len(ids) == 1,
                    "creation ACK is not a unique successful invocation",
                )
                mid = ids[0]
                need(
                    mid not in proofs
                    and acknowledgments[mid] == [log]
                    and mid not in owned
                    and mid not in claimed,
                    "creation ACK conflicts with another allocation or claim",
                )
                names = log.removesuffix(".log") + ".names"
                need(
                    names in extra
                    and extra[names].decode().splitlines().count(name) == 1,
                    "creation name ledger differs",
                )
                machine = native.get(mid)
                need(machine is not None, "acknowledged Machine absent from inventory")
                config = machine.get("config", {})
                mounts = config.get("mounts", [])
                region = re.findall(
                    r"^Cloning Machine " + re.escape(source) + r" into region (\S+)$",
                    block,
                    re.M,
                )
                images = re.findall(
                    r"^Provisioning a new Machine with image (\S+@sha256:[0-9a-f]{64})\.\.\.$",
                    block,
                    re.M,
                )
                volume_names = re.findall(
                    r"^Volume '([^']+)' will start empty$", block, re.M
                )
                need(
                    machine.get("name") == name
                    and len(region) == 1
                    and machine.get("region") == region[0]
                    and len(images) == 1
                    and config.get("image") == images[0]
                    and config.get("init") == {"cmd": ["sleep", "infinity"]}
                    and not config.get("metadata", {}).get("cloudbench_archived_reuse"),
                    "acknowledged native identity/configuration changed",
                )
                need(
                    len(mounts) == 1
                    and mounts[0].get("path") == "/data"
                    and len(volume_names) == 1
                    and mounts[0].get("name") == volume_names[0]
                    and re.fullmatch(r"vol_[A-Za-z0-9]+", mounts[0].get("volume", "")),
                    "acknowledged current volume differs",
                )
                timestamp = datetime.fromisoformat(
                    machine["created_at"].replace("Z", "+00:00")
                )
                need(timestamp.tzinfo is not None, "creation timestamp lacks timezone")
                created = timestamp.timestamp()
                need(
                    terminal["started_at_epoch"]
                    <= created
                    <= terminal["original_deadline"],
                    "creation outside original run",
                )
                volume = mounts[0]["volume"]
                need(
                    mid not in protected
                    and volume not in protected_volumes
                    and sum(
                        any(
                            m.get("volume") == volume
                            for m in n.get("config", {}).get("mounts", [])
                        )
                        for n in native.values()
                    )
                    == 1,
                    "protected or shared acknowledged volume",
                )
                bindings = [
                    path,
                    prefix + "/meta",
                    expected_path,
                    fresh_path,
                    log,
                    names,
                ]
                proofs[mid] = {
                    "kind": "acknowledged-create-stop-only",
                    "id": mid,
                    "name": name,
                    "owner_token": owner,
                    "current_volume_id": volume,
                    "sealed_clone_identity": False,
                    "reuse_credit": False,
                    "ack_log": log,
                    "archive_member_sha256": {p: sha(extra[p]) for p in bindings},
                }
    need(
        set(proofs) == requested,
        "requested creation lacks complete positive archived ACK proof",
    )
    return proofs


def native_owned_target(machine, ownership):
    """Validate current native custody against one fully verified archive owner."""
    config = machine.get("config")
    need(
        machine.get("id") == ownership["id"]
        and machine.get("name") == ownership["name"]
        and isinstance(machine.get("instance_id"), str)
        and bool(machine["instance_id"])
        and isinstance(machine.get("created_at"), str)
        and bool(machine["created_at"])
        and isinstance(config, dict),
        "native identity/config incomplete",
    )
    need(
        [v.get("volume") for v in config.get("mounts", [])] == [ownership["volume_id"]],
        "native owned volume mismatch",
    )
    marker = config.get("metadata", {}).get("cloudbench_archived_reuse")
    reuse = ownership.get("archived_reuse_proof")
    expected = (
        json.dumps(reuse["native_marker"], sort_keys=True, separators=(",", ":"))
        if reuse
        else None
    )
    need(marker == expected, "predecessor superseded by archived successor")
    return dict(machine=machine, ownership=ownership)


STARTUP_OPERATOR = "2a4624e8388c526b290cf9cbfe21f5f2143cf007"
STARTUP_SOURCE = "59ab01b35aa91521e105a3d48e1587007aa347ad"
STARTUP_PRODUCER_SHA = (
    "6335250eb296ae7be79d65f4fed1f8d8dfaaf8791aa25f7f05d7d57a9004f421"
)


def historical_source(ref, name):
    return subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(HERE.parent),
            "show",
            ref + ":scripts/" + name,
        ]
    )


STARTUP_RELEASE_SHA = "f3c8d493b8713e71132e262feebd832f7b663cad65c1dc04d0dc02f47d45b796"


def startup_release_observation(run, terminal, operator, proof):
    """Read the explicit GET-only successor; the original cleanup is not replayed."""
    old = run / "startup-finalization"
    new = run / "startup-release-observation"
    names = {
        "intent.json",
        "failure-proof.json",
        "cleanup.intent.json",
        "cleanup.child.json",
        "cleanup.joined.json",
        "cleanup.log",
    } | {
        f"wire-{n:06d}.{kind}.json"
        for n in (1, 2)
        for kind in ("request", "raw", "decoded")
    }
    need(
        {p.name for p in old.iterdir()} == names,
        "startup prior journal membership differs",
    )
    files = {name: sha(raw(old / name)) for name in sorted(names)}
    successor = obj(new / "intent.json")
    ref = terminal["finalizer_operator_ref"]
    need(
        re.fullmatch("[0-9a-f]{40}", ref)
        and sha(historical_source(ref, "cloudbench-startup-finalization.py"))
        == STARTUP_RELEASE_SHA,
        "unknown startup release producer",
    )
    need(
        set(successor) == {"operator_ref", "operator_pins", "prior", "no_effect_replay"}
        and successor["operator_ref"] == ref
        and successor["no_effect_replay"] is True
        and terminal.get("no_effect_replay") is True
        and terminal["prior_finalizer_operator_ref"] == STARTUP_OPERATOR
        and obj(new / "complete.json") == terminal,
        "startup release completion differs",
    )
    for name, digest in operator["operator_hashes"].items():
        if name != "cloudbench-startup-finalization.py":
            need(sha(historical_source(ref, name)) == digest, "startup release dependency differs")
    need({Path(path).name for path in successor["operator_pins"] if "/scripts/" in path} == set(operator["operator_hashes"]), "startup release source set differs")
    prior = successor["prior"]
    need(
        set(prior)
        == {"files", "operator_ref", "proof", "source_root", "operator_hashes"}
        and prior["files"] == files
        and prior["proof"] == proof
        and prior["operator_ref"] == operator["operator_ref"] == STARTUP_OPERATOR
        and prior["operator_hashes"] == operator["operator_hashes"],
        "startup prior proof differs",
    )
    roots = [
        str(Path(path).parent.parent)
        for path in operator["operator_pins"]
        if path.endswith("/scripts/cloudbench-startup-finalization.py")
    ]
    need(roots == [prior["source_root"]], "startup prior operator root differs")
    required = {"intent.json", "complete.json", "SIGTERM.intent.json"} | {
        f"wire-{n:06d}.{kind}.json" for n in (1, 2) for kind in ("request", "raw")
    }
    allowed = required | {
        "SIGKILL.intent.json",
        "wire-000001.decoded.json",
        "wire-000002.decoded.json",
    }
    present = {p.name for p in new.iterdir()}
    need(required <= present <= allowed, "startup release journal membership differs")
    ownership = run / "export/disposable-controller.ownership.json"
    machine = obj(ownership)["machine"]
    identity = ("id", "instance_id", "config", "name", "region")

    def observation(directory, n, path, statuses):
        request = obj(directory / f"wire-{n:06d}.request.json")
        response = obj(directory / f"wire-{n:06d}.raw.json")
        body = base64.b64decode(response["body_b64"], validate=True)
        need(
            request == {"method": "GET", "path": path, "body": None}
            and response["method"] == "GET"
            and response["path"] == path
            and response["status"] in statuses
            and response["bytes"] == len(body)
            and response["sha256"] == sha(body),
            "startup release raw GET differs",
        )
        decoded = directory / f"wire-{n:06d}.decoded.json"
        if response["status"] == 404:
            need(not decoded.exists(), "404 has fabricated decoded success")
            return None
        value = json.loads(body)
        need(
            isinstance(value, dict) and obj(decoded) == value,
            "startup release decoded GET differs",
        )
        return value

    path = "/machines/" + terminal["machine"]
    first = observation(old, 1, path, (200,))
    tombstone = observation(old, 2, path, (200,))
    need(
        all(first.get(k) == machine.get(k) for k in identity)
        and tombstone.get("state") == "destroyed"
        and all(tombstone.get(k) == machine.get(k) for k in identity),
        "startup prior tombstone differs",
    )
    fresh = observation(new, 1, path, (200, 404))
    need(
        fresh is None
        or fresh.get("state") == "destroyed"
        and all(fresh.get(k) == machine.get(k) for k in identity),
        "startup release Machine remains live",
    )
    volume = terminal["release"]["volume_id"]
    fresh = observation(new, 2, "/volumes/" + volume, (200, 404))
    need(
        fresh is None
        or fresh.get("id") == volume
        and fresh.get("state") in ("pending_destroy", "destroyed"),
        "startup release volume remains live",
    )
    for name in present & {"SIGTERM.intent.json", "SIGKILL.intent.json"}:
        need(
            obj(new / name)
            == {
                "pid": proof["caller"]["pid"],
                "birth": proof["caller"]["birth"],
                "signal": name.split(".")[0],
                "resources_release_verified": True,
            },
            "startup caller retirement differs",
        )
    return [
        ownership,
        *[old / name for name in sorted(names)],
        *[new / name for name in sorted(present)],
    ]


def startup_closure(run, terminal, intent, authority, verified, manifest, record):
    """A typed failure before publication is never a joined supervisor."""
    journal = run / "startup-finalization"
    paths = [
        journal / name
        for name in ("intent.json", "failure-proof.json", "cleanup.joined.json")
    ]
    producer = historical_source(STARTUP_OPERATOR, "cloudbench-startup-finalization.py")
    need(sha(producer) == STARTUP_PRODUCER_SHA, "unknown startup closure producer")
    step = ast.literal_eval(
        next(
            n.value
            for n in ast.parse(producer).body
            if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "STEP" for t in n.targets)
        )
    )
    proof_raw = raw(journal / "failure-proof.json")
    proof = json.loads(proof_raw)
    operator = obj(journal / "intent.json")
    need(
        terminal["status"] == "FAILED_BEFORE_SUPERVISOR"
        and operator["operator_ref"] == proof["operator_ref"] == STARTUP_OPERATOR,
        "startup completion/operator differs",
    )
    continuation = terminal.get("no_effect_replay") is True
    if continuation:
        paths.extend(startup_release_observation(run, terminal, operator, proof))
    else:
        need(
            obj(journal / "complete.json") == terminal
            and terminal["finalizer_operator_ref"] == STARTUP_OPERATOR
            and not (run / "startup-release-observation").exists(),
            "startup completion/operator differs",
        )
        paths.extend([journal / "complete.json", journal / "release.verified.json"])
    need(
        terminal["failure_proof_path"]
        == intent["failure_proof_path"]
        == str(journal / "failure-proof.json")
        and terminal["failure_proof_sha256"]
        == intent["failure_proof_sha256"]
        == sha(proof_raw),
        "startup proof bytes differ",
    )
    need(
        proof["schema"] == "expired-before-supervisor-proof-v1"
        and proof["source_ref"]
        == terminal["source_ref"]
        == authority["source_ref"]
        == record["source_ref"]
        == STARTUP_SOURCE,
        "startup source differs",
    )
    need(
        all(
            value.get("supervisor_joined") is False
            and value.get("supervisor_published") is False
            for value in (terminal, intent, proof)
        )
        and terminal["gate_reap"]
        == proof["gate_reap"]
        == "OBSERVED_ORIGINAL_PARENT_REAP"
        and intent["gate_joined"] is True,
        "startup supervisor disposition differs",
    )
    need(
        terminal["machine"] == intent["machine"] == record["machine_id"]
        and intent["action"] == "cleanup"
        and terminal["controller_cleanup_exit_code"] == 0
        and terminal["benchmark_success_inferred"] is False
        and terminal["caller_disposition"] == "EXITED_PIDFD_OBSERVED_NOT_OWNED_JOIN",
        "startup cleanup disposition differs",
    )
    need(
        obj(journal / "cleanup.joined.json")
        == {"exit_code": 0, "owned_join": True, "cancelled_signals": []},
        "startup cleanup child not joined",
    )
    config_path = Path(proof["config_path"])
    need(
        config_path.is_absolute() and config_path.parent / "run" == run,
        "startup config path differs",
    )
    config_raw = raw(config_path)
    config = json.loads(config_raw)
    need(
        sha(config_raw) == proof["config_sha256"]
        and config["source_ref"] == STARTUP_SOURCE
        and config["source_root"] == proof["source_root"],
        "startup config/source binding differs",
    )
    public_source = historical_source(STARTUP_SOURCE, "run-original600-controller.py")
    source_names = ast.literal_eval(
        next(
            n.value
            for n in ast.parse(public_source).body
            if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "PINS" for t in n.targets)
        )
    )
    need(
        set(config["source_files"]) == set(source_names),
        "incomplete historical startup source set",
    )
    for name, digest in config["source_files"].items():
        need(
            sha(historical_source(STARTUP_SOURCE, name)) == digest,
            "historical startup source differs",
        )
    expected_names = {
        "cloudbench-startup-finalization.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original600-runner.py",
        "cloudbench-original-volume-capture.py",
        "run-original600-controller.py",
    }
    need(
        set(operator["operator_hashes"]) == expected_names
        and operator["operator_pins"] == proof["operator_pins"],
        "startup operator source set differs",
    )
    for name, digest in operator["operator_hashes"].items():
        need(
            sha(historical_source(STARTUP_OPERATOR, name)) == digest,
            "historical startup operator differs",
        )
    caller_path = run / "caller.json"
    capture_path = run / "threshold-owner.identity.private.json"
    caller, capture = obj(caller_path), obj(capture_path)
    need(
        caller == proof["caller"] == capture["caller"]
        and sha(raw(caller_path)) == proof["caller_sha256"]
        and sha(raw(capture_path)) == proof["owner_capture_sha256"]
        and capture["config_sha256"] == proof["config_sha256"]
        and capture["owner"] == operator["owner"],
        "startup caller capture differs",
    )
    need(
        caller["authority_sha256"]
        == proof["authority_sha256"]
        == sha(raw(run / "authority.private.json"))
        and authority["cleanup_owner_pid"] == caller["pid"]
        and authority["cleanup_owner_birth"] == caller["birth"]
        and authority["output_directory"] == str(run / "export"),
        "startup authority differs",
    )
    need(
        caller["source_ref"] == STARTUP_SOURCE
        and caller["epoch"]
        == config["started_at_epoch"]
        == proof["started_at_epoch"]
        == terminal["started_at_epoch"]
        and caller["deadline"]
        == caller["epoch"] + 5400
        == proof["original_deadline"]
        == terminal["original_deadline"],
        "startup original clock differs",
    )
    need(
        record["caller"] == obj(run / "export/caller.json")
        and record["caller"]["pid"] == caller["gate_pid"]
        and record["caller"]["birth"] == caller["gate_birth"],
        "startup gate capture differs",
    )
    export = run / "export"
    release_path, workspace_path = (
        export / "disposable-controller.release.json",
        export / "workspace-volume.ownership.json",
    )
    release, workspace = obj(release_path), obj(workspace_path)
    need(
        release == terminal["release"]
        and (continuation or release == obj(journal / "release.verified.json"))
        and release["machine_id"] == record["machine_id"]
        and release["machine_deleted"] is True
        and release["volume_id"] == workspace["volume_id"]
        and release["volume_disposition"] in ("ABSENT", "pending_destroy", "destroyed"),
        "startup canonical release differs",
    )
    hashes = {
        "export_marker_sha256": export / "disposable-export.verified.json",
        "manifest_sha256": export / "manifest.json",
        "launch_sha256": export / "launch.json",
        "gate_log_sha256": run / "gate.private.log",
        "remote_gate_log_sha256": Path(proof["remote_gate_log_path"]),
    }
    for key, path in hashes.items():
        need(
            sha(raw(path, 64 * 1024 * 1024)) == proof[key],
            "startup closure input changed: " + key,
        )
    need(
        proof["export_marker_sha256"] == intent["export_verified_file"]
        and proof["archive_sha256"] == manifest["archive_sha256"]
        and proof["step1_sha256"] == sha(step),
        "startup archive binding differs",
    )
    paths.extend(
        [
            config_path,
            caller_path,
            capture_path,
            release_path,
            workspace_path,
            export / "caller.json",
            *hashes.values(),
        ]
    )
    metadata = {
        "schema": proof["schema"],
        "operator_ref": STARTUP_OPERATOR,
        "producer_sha256": STARTUP_PRODUCER_SHA,
        "failure_proof_sha256": sha(proof_raw),
        "supervisor_joined": False,
        "supervisor_published": False,
        "owned_job_authority": False,
        "reuse_credit": False,
    }
    return metadata, paths, step

def prepare(run, inventory_path, excluded_machines=(), acknowledged_creates=()):
    run=Path(run).absolute(); export=run/'export'
    terminal=obj(run/'terminal.json'); intent=obj(run/'cleanup-call.intent.json')
    authority=obj(run/'authority.private.json'); verified=obj(export/'disposable-export.verified.json')
    manifest=json.loads(manifest_bytes(export/'manifest.json')); record=obj(export/'launch.json')
    app=record['app']; host=record['machine_id']
    need(app=='navi-whisper-lux-bench' and record['host']==host,'original app/controller mismatch')
    startup = None
    startup_paths, startup_step = [], None
    if terminal['status'] == 'FAILED_BEFORE_SUPERVISOR':
        need(not acknowledged_creates, 'startup failure cannot own created jobs')
        startup, startup_paths, startup_step = startup_closure(run, terminal, intent, authority, verified, manifest, record)
    else:
        need(terminal['status']=='CONTROLLER_RELEASE_VERIFIED' and terminal['machine']==host
             and terminal['source_ref']==record['source_ref'] and terminal['release']['machine_deleted'] is True,
             'joined released original controller required')
        need(intent['gate_joined'] is True and intent['supervisor_joined'] is True and intent['machine']==host
             and intent['export_verified_file']==sha(raw(export/'disposable-export.verified.json')),'joined export receipt mismatch')
    need(verified['machine_id']==host and verified['authority_sha256']==sha(raw(run/'authority.private.json')),
         'export authority mismatch')
    need(authority['app']==app and authority['source_ref']==record['source_ref'],'source authority mismatch')
    protected=set(authority['protected_machines']); protected_volumes=set(authority['protected_volumes'])
    need(len(protected)>=4 and host not in protected,'explicit protected cohort required')
    excluded=set(excluded_machines)
    need(all(isinstance(mid,str) and re.fullmatch('[0-9a-f]{14}',mid) for mid in excluded), 'invalid excluded Machine')
    need(not excluded & protected, 'protected Machine cannot be hidden by exclusion')
    acknowledged=set(acknowledged_creates)
    need(len(acknowledged)==len(acknowledged_creates) and all(re.fullmatch('[0-9a-f]{14}',mid) for mid in acknowledged)
         and not acknowledged&(excluded|protected),'invalid/protected/duplicate acknowledged creation')
    if acknowledged: need(not manifest.get('excluded'),'incomplete archive cannot prove unsealed creation authority')
    need(manifest['version']==1 and manifest['resource_release_verified'] is False and manifest['record']==record,
         'original archive manifest mismatch')
    for name,digest in verified['files'].items():
        need(name in ('caller.json','launch.json','manifest.json','originals.tar.gz'),'unexpected export receipt key')
        need(digest_file(export/name)==digest,'verified export artifact changed')
    need(set(verified['files'])=={'caller.json','launch.json','manifest.json','originals.tar.gz'},'incomplete export receipt')
    need(digest_file(export/'originals.tar.gz')==manifest['archive_sha256'],'archive digest mismatch')
    selected={}; extra={}; claimed=set(); seen=set(); joined=False
    startup_step_seen=False
    # Never extract paths from the archive; read only hash-bound regular records.
    with tarfile.open(export/'originals.tar.gz','r:gz') as archive:
        for member in archive:
            need(member.name not in seen and not member.name.startswith('/') and '..' not in Path(member.name).parts,
                 'unsafe archive membership')
            seen.add(member.name)
            if startup is not None:
                need(not member.name.startswith(('context/original600-supervisor.', 'context/fleet/', 'context/benchmarks/campaigns/', 'git-common/cloudbench-fleet-ownership', 'git-common/cloudbench-fleet-audit', 'git-common/cloudbench-archived-reuse/current/', 'git-common/cloudbench-native-effect-fences/')), 'startup archive has runtime publication')
                if member.name == 'controller-output/step-1.log':
                    expected_step=manifest['files'].get(member.name,{})
                    need(member.isfile() and member.size==len(startup_step) and expected_step.get('bytes')==len(startup_step) and expected_step.get('sha256')==sha(startup_step), 'startup archive step differs')
                    need(archive.extractfile(member).read(len(startup_step)+1)==startup_step, 'startup archive step bytes differ')
                    startup_step_seen=True
            owner_record=re.fullmatch(r'git-common/cloudbench-fleet-ownership/[0-9a-f]{32}/(?:meta|clones/[^/]+|archived-reuse/[0-9a-f]{14}\.json)',member.name)
            supervisor=member.name.startswith('context/original600-supervisor.') and member.name.endswith('.terminal.json')
            sensitive=bool(acknowledged) and (member.name.startswith(('git-common/cloudbench-archived-reuse/current/','git-common/cloudbench-native-effect-fences/'))
                or '/archived-reuse/' in member.name or '/archived-reuse-journal/' in member.name
                or member.name.endswith(('/.cid','/archived-reuse-proof.json','/archived-successor.json')))
            ack_record=bool(acknowledged) and (re.fullmatch(r'git-common/cloudbench-fleet-audits/[0-9a-f]{32}/(?:expected-fresh|fresh)/[^/]+',member.name)
                or re.fullmatch(r'context/fleet/runs/[^/]+/[^/]+/primary\.(?:log|names)',member.name))
            if acknowledged and member.name.startswith(('context/fleet/','git-common/cloudbench-fleet-ownership/','git-common/cloudbench-fleet-audits/','git-common/cloudbench-archived-reuse/','git-common/cloudbench-native-effect-fences/')):
                need(not member.issym() and not member.islnk(),'creation/claim namespace contains alias')
            if sensitive:
                claimed.update(part.removesuffix('.json') for part in Path(member.name).parts if re.fullmatch(r'[0-9a-f]{14}(?:\.json)?',part))
            if sensitive and member.isdir(): continue
            wanted=owner_record or supervisor or ack_record or sensitive
            if not wanted: continue
            expected=manifest['files'].get(member.name,{})
            limit=16*1048576 if acknowledged and (ack_record or sensitive) else 1048576
            need(member.isfile() and member.size<=limit and expected.get('kind')=='file'
                 and expected.get('bytes')==member.size,'unsafe archived ownership record')
            data=archive.extractfile(member).read(limit+1)
            need(sha(data)==expected['sha256'],'archived ownership bytes changed')
            if acknowledged: extra[member.name]=data
            if sensitive:
                claimed.update(m.decode() for m in re.findall(rb'(?<![0-9a-f])[0-9a-f]{14}(?![0-9a-f])',data))
            if owner_record:
                selected[member.name]=json.loads(data) if '/archived-reuse/' in member.name else fields(data)
            elif supervisor:
                proof=json.loads(data)
                need(proof['machine']==host and proof['source_ref']==record['source_ref']
                     and proof['supervisor_joined'] is True and proof['parent_joined'] is True,
                     'archived original supervisor not joined')
                joined=True
    need(seen==set(manifest['files']) and (joined if startup is None else startup_step_seen and not joined), 'archive membership/typed closure incomplete')
    owned={}; skipped=0
    for name,row in selected.items():
        match=re.fullmatch(r'(git-common/cloudbench-fleet-ownership/([0-9a-f]{32}))/clones/([^/]+)',name)
        if not match: continue
        meta=selected.get(match[1]+'/meta',{})
        need(meta.get('host')==host and meta.get('app')==app and meta.get('fleet_owner_token')==match[2],
             'archived registry host/app/token mismatch')
        need(meta.get('cleanup_policy') in ('retain','reap'),'unknown archived cleanup policy')
        if not row.get('id'):
            skipped+=1; continue  # Unsealed create intent is never a target.
        need(set(row)=={'name','id','volume_id'} and row['name']==match[3]
             and re.fullmatch('[0-9a-f]{8,32}',row['id']) and row['volume_id'].startswith('vol_'),
             'unsafe sealed clone identity')
        need(row['id'] not in protected and row['volume_id'] not in protected_volumes,'protected archived resource')
        need(row['id'] not in owned,'duplicate archived machine identity')
        reuse=selected.get(match[1]+'/archived-reuse/'+row['id']+'.json')
        if reuse:
            need(reuse.get('schema')=='cloudbench-archived-reuse-v1' and reuse['machine_id']==row['id'] and reuse['volume_id']==row['volume_id']
                 and reuse['successor']['owner_token']==match[2] and reuse['successor']['controller_id']==host
                 and reuse['successor']['run_id']==meta['run_id'], 'archived successor owner mismatch')
        owned[row['id']]=dict(row,owner_token=match[2],archive_path=name,archived_reuse_proof=reuse)
    # Successor allocations have honest reuse records, not fictional new clone rows.
    for name,reuse in selected.items():
        match=re.fullmatch(r'(git-common/cloudbench-fleet-ownership/([0-9a-f]{32}))/archived-reuse/([0-9a-f]{14})\.json',name)
        if not match: continue
        meta=selected.get(match[1]+'/meta',{});mid=match[3]
        need(reuse.get('schema')=='cloudbench-archived-reuse-v1' and reuse['machine_id']==mid
             and reuse['successor']['owner_token']==match[2] and reuse['successor']['controller_id']==host
             and reuse['successor']['run_id']==meta.get('run_id') and meta.get('host')==host,
             'archived retained successor is not owned by this controller')
        need(mid not in protected and reuse['volume_id'] not in protected_volumes,'protected successor resource')
        if mid in owned:
            need(owned[mid].get('archived_reuse_proof')==reuse,'conflicting clone/reuse owner')
        else:
            owned[mid]=dict(id=mid,name=reuse['native_name'],volume_id=reuse['volume_id'],owner_token=match[2],archive_path=name,archived_reuse_proof=reuse)
    native=BASE['inventory'](json.loads(raw(inventory_path,256*1024*1024))); targets=[]; unrelated=0
    proofs=acknowledged_create_proofs(selected,extra,claimed,acknowledged,{m['id']:m for m in native},terminal,protected,protected_volumes,owned) if acknowledged else {}
    for machine in native:
        mid=machine['id']
        if mid in protected: continue
        if acknowledged:
            if mid in proofs:
                need(isinstance(machine.get('instance_id'),str) and bool(machine['instance_id']),'missing acknowledged instance')
                targets.append(dict(machine=machine,ownership=proofs[mid]))
            else: unrelated+=1
            continue
        if mid not in owned:
            unrelated+=1
            continue  # Other retained cohorts never become this archive's stop authority.
        # Archive integrity remains fully verified; excluded native identities
        # receive no reuse/stop authority and remain in the measured inventory.
        if mid in excluded: continue
        targets.append(native_owned_target(machine, owned[mid]))
    need(protected<={m['id'] for m in native},'protected native cohort missing')
    paths=[run/'terminal.json',run/'cleanup-call.intent.json',run/'authority.private.json',
           export/'disposable-export.verified.json',export/'manifest.json',export/'launch.json',export/'originals.tar.gz',Path(inventory_path).absolute()]
    paths.extend(startup_paths)
    plan=dict(schema='cloudbench-archived-owner-stop-plan-v1',app=app,controller=host,
                source_ref=record['source_ref'],protected_machines=sorted(protected),
                protected_volumes=sorted(protected_volumes),inputs={str(p):digest_file(p) for p in paths},
                archived_ownership=owned,
                targets=targets,unsealed_intents_skipped=skipped,unrelated_native_machines_skipped=unrelated,no_delete=True,no_volume_change=True,
                no_claim_release=True,benchmark_success_inferred=False)
    if startup is not None:
        need(not owned and not targets, 'startup failure has no owned job authority')
        plan['startup_closure']=startup
    if acknowledged: plan.update(acknowledged_create_only=sorted(acknowledged),reuse_credit=False)
    return plan


def reconcile(api,row,out,end):
    # Resume is observation ONLY, even if the previous POST response was lost.
    current=call(api,'GET','/machines/'+row['id'],end)
    same_machine(row,current)
    return dict(machine=row['id'],status='STOPPED_CONFIRMED' if current.get('state')=='stopped' else 'PENDING',
                stop_attempted=(out/'stop-intent.json').exists(),observation_only=True)


def stop_owned(api,row,output,end,adapter_factory=None):
    mid=row['id']; out=output/mid
    try:
        with until(end):
            if out.exists(): return reconcile(api,row,out,end)
            helper=runpy.run_path(str(HERE/'cloudbench-archived-machine-reuse.py'))
            adapter=(adapter_factory or helper['NativeAdapter'])(api,output/(mid+'.wire'))
            with adapter.lease(mid):
                current=adapter.request('GET','/machines/'+mid)
                same_machine(row,current)
                need(current.get('created_at')==row['created_at'],'Machine creation identity changed')
                # The exact planned full config (including successor marker)
                # must still hold under the SAME lease as the STOP effect.
                save(output/(mid+'.exact-before.json'),current)
                if current.get('state')=='stopped':
                    out.mkdir(mode=0o700)
                    value=dict(machine=mid,status='STOPPED_CONFIRMED',stop_attempted=False)
                    save(out/'terminal.json',value); return value
                need(current.get('state') in BASE['ACTIVE'],'native Machine not stoppable')
                class LeasedAPI:
                    def api(self,method,path,body=None,timeout=20):
                        return adapter.request(method,path,body)
                BASE['stop_one'](LeasedAPI(),current,out,min(end,time.monotonic()+60))
                return json.loads(raw(out/'terminal.json'))
    except Exception as error:
        return dict(machine=mid,status='PENDING',error=type(error).__name__)


def execute(api,plan,output,seconds=300,workers=16):
    need(60<=seconds<=1800 and 1<=workers<=16,'invalid bounded stop limits')
    need(plan.get('schema')=='cloudbench-archived-owner-stop-plan-v1','wrong plan')
    for path,digest in plan['inputs'].items(): need(digest_file(path)==digest,'original plan input changed')
    protected=set(plan['protected_machines'])
    rows=[t['machine'] for t in plan['targets']]
    need(len({r['id'] for r in rows})==len(rows) and not protected&{r['id'] for r in rows},'protected/duplicate target')
    end=time.monotonic()+seconds; children=[]; pending=list(rows); context=multiprocessing.get_context('fork')
    try:
        with until(end):
            while pending or children:
                for child in list(children):
                    if not child.is_alive(): child.join(); children.remove(child)
                while pending and len(children)<workers and time.monotonic()<end-20:
                    row=pending.pop(0)
                    child=context.Process(target=stop_owned,args=(api,row,output,min(end-20,time.monotonic()+65)))
                    child.start(); children.append(child)
                if not children: break
                time.sleep(.02)
            # One final app read is safe on this outside operator; never fan
            # out another serial247-call phase beyond the original deadline.
            final={}; final_error=None
            try:
                with until(end-1):
                    final={r['id']:r for r in BASE['inventory'](call(api,'GET','/machines',end-1))}
            except Exception as error:
                final_error=type(error).__name__
            results=[]
            for row in rows:
                value=dict(machine=row['id'],status='PENDING',error=final_error or 'unverified final identity')
                try:
                    current=final[row['id']]
                    same_machine(row,current)
                    need(current.get('created_at')==row['created_at'],'final creation identity changed')
                    need(current.get('state')=='stopped','final state not stopped')
                    value=dict(machine=row['id'],status='STOPPED_CONFIRMED',
                               stop_attempted=(output/row['id']/'stop-intent.json').exists())
                except Exception:
                    pass
                results.append(value)
            summary=dict(schema='cloudbench-archived-owner-stop-observation-v1',results=results,
                         all_owned_stopped=all(v['status']=='STOPPED_CONFIRMED' for v in results),
                         no_delete=True,unrelated_native_machines_skipped=plan['unrelated_native_machines_skipped'],volumes_retained=True,claims_released=False,benchmark_success_inferred=False)
            save(output/('observation-'+str(time.time_ns())+'.json'),summary)
            return summary
    finally:
        for child in children: child.join()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-dir',type=Path,required=True);p.add_argument('--inventory',type=Path,required=True)
    p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--execute',action='store_true')
    p.add_argument('--forensic-resource-closure',metavar='OWNER',help='Observe exact terminal resources; preserve claims, failed capture and original audit')
    p.add_argument('--agents-env',type=Path);p.add_argument('--timeout',type=int,default=300)
    p.add_argument('--acknowledged-create',action='append',default=[],metavar='MACHINE_ID',
                   help='STOP only these exact unsealed creations, requiring archived successful creation ACKs; never reuse authority')
    p.add_argument('--workers',type=int,default=16);a=p.parse_args();os.umask(0o077)
    output=a.out_dir.absolute();need(output.parent.resolve(strict=True)==output.parent,'physical output parent required')
    forensic = runpy.run_path(str(HERE/'cloudbench-forensic-resource-closure.py')) if a.forensic_resource_closure else None
    if forensic:
        need(not a.acknowledged_create, 'forensic mode cannot stop acknowledged creates')
        plan=forensic['prepare'](a.run_dir,a.inventory,a.forensic_resource_closure)
    else:
        plan=prepare(a.run_dir,a.inventory,acknowledged_creates=a.acknowledged_create)
    if output.exists():
        need(output.is_dir() and not output.is_symlink() and output.stat().st_uid==os.getuid()
             and not output.stat().st_mode&0o077,'private output directory required')
        need(json.loads(raw(output/'plan.json',256*1024*1024))==plan,'existing exact plan changed')
    else: output.mkdir(mode=0o700);save(output/'plan.json',plan)
    if not a.execute:
        print(json.dumps(dict(status='PLANNED_NOT_STOPPED',targets=len(plan['targets']),unrelated_native_machines_skipped=plan['unrelated_native_machines_skipped'],provider_calls=0)));return 0
    need(a.agents_env is not None,'explicit complete agents env required')
    operator=runpy.run_path(str(HERE/'run-original600-controller.py'))
    helper=runpy.run_path(str(HERE/'cloudbench-original-volume-capture.py'))
    with until(time.monotonic()+a.timeout):
        api=helper['Fly'](plan['app'],operator['token_from_agents'](raw(a.agents_env)))
        if forensic:
            receipt=forensic['observe'](api,plan,output)
            print(json.dumps(dict(status='FORENSIC_RESOURCE_TERMINAL_OBSERVED',receipt=str(receipt),claims_released=False,runtime_sealed=False,benchmark_success_inferred=False)))
            return 0
        result=execute(api,plan,output,a.timeout,a.workers)
    print(json.dumps(dict(all_owned_stopped=result['all_owned_stopped'],targets=len(result['results']),
                         unrelated_native_machines_skipped=plan['unrelated_native_machines_skipped'],volumes_retained=True,claims_released=False)))
    return 0 if result['all_owned_stopped'] else 1


if __name__=='__main__': raise SystemExit(main())
