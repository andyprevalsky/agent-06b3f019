#!/usr/bin/env python3
"""Borrow only the existing controller payload transfer; retain its original owner."""

import argparse
import base64
import fcntl
import gzip
import json
import os
import re
import runpy
import shlex
import signal
import stat
import subprocess
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = runpy.run_path(str(HERE / "cloudbench-original600-runner.py"))
need, read, save, sha = (R[key] for key in ("need", "read", "save", "sha"))


def object_file(path):
    return json.loads(read(path))


def git(root, *args):
    return subprocess.check_output(
        ["git", "--no-replace-objects", "-C", str(root), *args], text=True
    ).strip()


def process_identity(pid):
    before = R["birth"](pid)
    root = Path("/proc") / str(pid)
    argv = (root / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
    need(argv and sum(map(len, argv)) < 65536, "bounded live owner argv required")
    value = {
        "pid": pid,
        "birth": before,
        "argv": [os.fsdecode(arg) for arg in argv],
        "cwd": str((root / "cwd").resolve(strict=True)),
    }
    need(R["birth"](pid) == before, "owner PID changed while inspected")
    return value


def fingerprint(path):
    path = Path(path)
    try:
        value = path.lstat()
        return (
            value.st_dev,
            value.st_ino,
            value.st_size,
            value.st_mtime_ns,
            value.st_ctime_ns,
        )
    except FileNotFoundError:
        return None


def source_identity(root, ref, paths):
    need(git(root, "rev-parse", "HEAD") == ref, "source HEAD changed")
    result = {}
    for relative, digest in paths.items():
        path = Path(root) / "scripts" / relative
        need(path.resolve(strict=True) == path.absolute(), "physical source required")
        raw = path.read_bytes()
        need(
            sha(raw) == digest
            and raw
            == subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "-C",
                    str(root),
                    "show",
                    ref + ":scripts/" + relative,
                ]
            ),
            "source bytes changed: " + relative,
        )
        result[str(path)] = fingerprint(path)
    head = Path(git(root, "rev-parse", "--path-format=absolute", "--git-path", "HEAD"))
    result[str(head)] = fingerprint(head)
    text = head.read_text().strip()
    if text.startswith("ref: "):
        target = Path(
            git(root, "rev-parse", "--path-format=absolute", "--git-path", text[5:])
        )
        result[str(target)] = fingerprint(target)
    packed = Path(
        git(root, "rev-parse", "--path-format=absolute", "--git-path", "packed-refs")
    )
    result[str(packed)] = fingerprint(packed)
    return result


def gate_program_identity(gate, host_gate, source_root, authority, digest):
    """Bind either the checked-in gate or its canonical private self-copy."""
    argv = gate["argv"]
    need(
        len(argv) >= 6
        and Path(argv[0]).name == "bash"
        and argv[2:5] == ["--disposable-controller", str(authority), "--"]
        and gate["cwd"] == str(Path(source_root).resolve(strict=True)),
        "original gate command/cwd differs",
    )
    program = Path(argv[1])
    need(program.is_absolute(), "absolute original gate program required")
    before = fingerprint(program)
    if program == host_gate:
        need(program.resolve(strict=True) == program, "physical original gate required")
        raw = program.read_bytes()
    else:
        need(
            re.fullmatch(r"cloudbench-gate-self\.[A-Za-z0-9]{6}", program.name),
            "canonical gate self-copy required",
        )
        raw = read(program)
    need(
        sha(raw) == digest and before == fingerprint(program),
        "original gate program bytes changed",
    )
    return {str(program): before}


def parent_pid(pid):
    return int(
        Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()[1]
    )


def transfer_unwound(state):
    """Bind the captured exception print to the live caller's actual tee pipe."""
    path = state["out"] / "payload-transfer.interruption.json"
    proof = object_file(path)
    identities = [
        process_identity(state["caller"]["pid"]),
        process_identity(proof["parent"]["pid"]),
    ]
    for key, identity in zip(("caller", "parent"), identities):
        recorded = proof[key]
        need(
            all(recorded[name] == identity[name] for name in ("pid", "birth", "cwd")),
            "interruption process identity differs",
        )
        command = b"\0".join(os.fsencode(arg) for arg in identity["argv"]) + b"\0"
        need(
            sha(command) == recorded["cmdline_sha256"],
            "interruption process argv differs",
        )
    need(
        identities[0]["birth"] == state["caller"]["birth"]
        and parent_pid(identities[0]["pid"])
        == proof["caller"]["ppid"]
        == identities[1]["pid"],
        "interruption parent ownership differs",
    )
    pipe = proof["caller_fd1"]
    need(
        re.fullmatch(r"pipe:\[\d+\]", pipe)
        and os.readlink(f"/proc/{identities[0]['pid']}/fd/1") == pipe,
        "interruption caller stdout differs",
    )
    log = Path(proof["log_path"])
    links = proof["parent_matching_fds"]
    need(
        set(links.values()) == {pipe, str(log)} and len(links) == 2,
        "interruption tee descriptors differ",
    )
    for fd, target in links.items():
        need(
            fd.isdigit()
            and os.readlink(f"/proc/{identities[1]['pid']}/fd/{fd}") == target,
            "interruption tee descriptor changed",
        )
    wrapper = Path(proof["wrapper_path"])
    need(
        str(wrapper) in identities[1]["argv"]
        and wrapper.resolve(strict=True) == wrapper,
        "interruption tee source differs",
    )
    before = fingerprint(wrapper)
    info = wrapper.lstat()
    need(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.geteuid()
        and info.st_nlink == 1
        and sha(wrapper.read_bytes()) == proof["wrapper_sha256"]
        and fingerprint(wrapper) == before,
        "interruption tee source changed",
    )
    raw = read(log)
    need(sha(raw) == proof["log_sha256"], "interruption stream changed")
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    need(
        rows
        == [
            {
                "status": "CONTINUING_ORIGINAL_ADMISSION",
                "admission_directory": str(state["out"].parent.parent),
                "source_ref": state["source_ref"],
                "host_operator_source_ref": state["host_ref"],
                "config_path": state["config"],
                "run_directory": str(state["out"]),
            },
            {
                "status": "PENDING_EXTERNAL_OWNER_LIVE",
                "error": "Deadline",
                "gate_pid": state["caller"]["gate_pid"],
                "no_gate_or_vm_kill": True,
            },
        ],
        "positive original transfer unwind print required",
    )
    need(
        log.parent == state["out"].parent.parent.parent
        and state["epoch"] <= proof["observed_epoch"] <= time.time(),
        "interruption stream scope or capture time differs",
    )
    state["pins"].update({str(p): fingerprint(p) for p in (path, log, wrapper)})
    return {
        "receipt_sha256": sha(read(path)),
        "log_sha256": sha(raw),
        "wrapper_sha256": proof["wrapper_sha256"],
        "capture_kind": "live tee pipe and exception print",
    }


def acknowledged_read_timeout(state):
    """First borrow after an incomplete identity GET; every write remains proved."""
    unwound = transfer_unwound(state)
    old = runpy.run_path(
        str(Path(state["host"]) / "scripts/cloudbench-original600-runner.py")
    )
    directory = state["out"] / "payload-transfer"
    before = {p.name: fingerprint(p) for p in directory.iterdir()}
    need(
        all(p.is_file() and not p.is_symlink() for p in directory.iterdir()),
        "physical old transfer files required",
    )
    descriptors = {
        row["sha256"]: row
        for row in object_file(state["out"] / "controller-sidecars.private.json")
    }
    requests = sorted(directory.glob("[0-9][0-9][0-9][0-9]-*.request.json"))
    need(requests, "old transfer request history missing")
    allowed, hashes, writes = set(), {}, 0

    def load(name):
        allowed.add(name)
        raw = read(directory / name)
        hashes[name] = sha(raw)
        return json.loads(raw)

    def expected(payload):
        need(
            payload["machine"] == state["machine_id"]
            and payload["source_ref"] == state["source_ref"]
            and payload["envelope_sha256"] == state["envelope_sha256"],
            "old sidecar target differs",
        )
        descriptor = descriptors[payload["sha256"]]
        data = read(descriptor["path"])
        need(
            sha(data) == payload["sha256"] and len(data) == descriptor["bytes"],
            "old sidecar bytes differ",
        )
        action = payload["action"]
        if action in ("commit", "observe-ready"):
            need(
                set(payload)
                == {"machine", "source_ref", "envelope_sha256", "sha256", "action"},
                "unexpected ready payload",
            )
            return {"state": "READY", "bytes": len(data), "sha256": sha(data)}, payload[
                "sha256"
            ] + "-commit"
        index = payload["index"]
        need(
            type(index) is int and 0 <= index < (len(data) + 32767) // 32768,
            "old chunk index differs",
        )
        chunk = data[index * 32768 : (index + 1) * 32768]
        label = payload["sha256"] + f"-{index:05d}"
        if action in ("fragment", "observe-fragment"):
            offset = payload["offset"]
            need(
                type(offset) is int and offset % 2048 == 0 and 0 <= offset < len(chunk),
                "old fragment offset differs",
            )
            content = chunk[offset : offset + 2048]
            result = {
                "state": "FRAGMENT",
                "index": index,
                "offset": offset,
                "bytes": len(content),
                "sha256": sha(content),
            }
            label += f"-{offset:05d}"
        else:
            need(
                action in ("assemble", "observe-chunk"),
                "unsupported old sidecar action",
            )
            content = chunk
            result = {
                "state": "CHUNK",
                "index": index,
                "bytes": len(chunk),
                "sha256": sha(chunk),
            }
        if action == "fragment":
            need(
                base64.b64decode(payload["data"], validate=True) == content,
                "old fragment data differs",
            )
        else:
            need(
                payload["chunk_sha256"] == sha(content),
                "old observation digest differs",
            )
        return result, label

    for index, path in enumerate(requests, 1):
        prefix = path.name.removesuffix(".request.json")
        need(prefix.startswith(f"{index:04d}-"), "old request sequence differs")
        request = load(path.name)
        final = index == len(requests)
        if final:
            need(
                prefix.endswith("-identity")
                and request
                == {
                    "method": "GET",
                    "path": "/machines/" + state["machine_id"],
                    "body": None,
                },
                "only final identity GET may lack a response",
            )
            need(
                not (directory / (prefix + ".wire.json")).exists()
                and not (directory / (prefix + ".response.json")).exists(),
                "final GET is not the retained incomplete read",
            )
            continue
        wire = load(prefix + ".wire.json")
        raw = base64.b64decode(wire["body_b64"], validate=True)
        need(
            wire["sha256"] == sha(raw)
            and wire["status"] == 200
            and wire["method"] == request["method"]
            and wire["path"] == request["path"],
            "old raw response binding differs",
        )
        response = load(prefix + ".response.json")
        need(json.loads(raw) == response, "old decoded response differs")
        if request["method"] == "GET":
            need(
                prefix.endswith("-identity")
                and request
                == {
                    "method": "GET",
                    "path": "/machines/" + state["machine_id"],
                    "body": None,
                }
                and all(
                    response[key] == state["machine"][key]
                    for key in ("id", "instance_id", "config")
                )
                and response.get("state") in ("created", "starting", "started"),
                "old native identity differs",
            )
            continue
        need(
            request["method"] == "POST"
            and request["path"] == "/machines/" + state["machine_id"] + "/exec",
            "unknown old transfer effect",
        )
        body = request["body"]
        argv = shlex.split(body["cmd"])
        need(
            len(argv) == 4 and argv[:2] == ["python3", "-c"], "old sidecar argv differs"
        )
        source, payload = json.loads(
            gzip.decompress(base64.b64decode(argv[3], validate=True))
        )
        need(
            source == old["REMOTE_SIDECAR"]
            and body["cmd"] == old["sidecar_command"](payload)
            and set(body) == {"cmd", "timeout", "machine"}
            and body["machine"] is True
            and type(body["timeout"]) is int
            and 1 <= body["timeout"] <= 20,
            "old source-bound command differs",
        )
        wanted, label = expected(payload)
        need(
            response.get("exit_code") == 0
            and response.get("exit_signal", 0) == 0
            and response.get("stderr") in (None, ""),
            "old exec response failed",
        )
        ack = json.loads(response["stdout"])
        if prefix.endswith("-write"):
            need(
                payload["action"] in ("fragment", "assemble", "commit")
                and ack == wanted,
                "old write lacks exact positive acknowledgement",
            )
            intent = load(label + ".intent.json")
            need(
                intent
                == {
                    "machine": state["machine_id"],
                    "instance": state["machine"]["instance_id"],
                    "request_sha256": sha(body["cmd"].encode()),
                    "expected": wanted,
                }
                and load(label + ".response.json") == response,
                "old write intent/response differs",
            )
            writes += 1
        else:
            need(
                prefix.endswith("-observe-existing")
                and payload["action"].startswith("observe-")
                and ack in (wanted, {"state": "ABSENT"}),
                "unknown old observation",
            )
    need(
        writes and set(before) == allowed,
        "unaccounted old transfer artifact or no writes",
    )
    need(
        before == {p.name: fingerprint(p) for p in directory.iterdir()},
        "old transfer history changed",
    )
    state["pins"].update(
        {str(directory / name): value for name, value in before.items()}
    )
    state["pins"][str(directory)] = fingerprint(directory)
    return {
        "kind": "ACKNOWLEDGED_WRITES_FINAL_IDENTITY_GET_INCOMPLETE",
        "acknowledged_writes": writes,
        "history_sha256": sha(json.dumps(hashes, sort_keys=True).encode()),
        "inputs": hashes,
        "old_response_unknown": "read-only GET",
        "unwound": unwound,
    }


def old_rejection(state):
    """Only the retained typed pre-exec old-router rejection permits first borrow."""
    old = runpy.run_path(
        str(Path(state["host"]) / "scripts/cloudbench-original600-runner.py")
    )
    directory = state["out"] / "payload-transfer"
    descriptors = {
        row["sha256"]: row
        for row in object_file(state["out"] / "controller-sidecars.private.json")
    }
    rejected = []

    def record(path):
        request = object_file(path)
        prefix = path.name.removesuffix(".request.json")
        wire = object_file(directory / (prefix + ".wire.json"))
        raw = base64.b64decode(wire["body_b64"], validate=True)
        need(
            wire["sha256"] == sha(raw)
            and wire["status"] == 200
            and wire["method"] == request["method"] == "POST"
            and wire["path"]
            == request["path"]
            == "/machines/" + state["machine_id"] + "/exec",
            "old transfer raw identity differs",
        )
        value = json.loads(raw)
        need(
            object_file(directory / (prefix + ".response.json")) == value,
            "old transfer decoded response differs",
        )
        argv = shlex.split(request["body"]["cmd"])
        need(
            len(argv) == 4
            and argv[:2] == ["python3", "-c"]
            and argv[2] == old["REMOTE_SIDECAR"],
            "old source command differs",
        )
        payload = json.loads(base64.b64decode(argv[3], validate=True))
        need(
            payload["machine"] == state["machine_id"]
            and payload["source_ref"] == state["source_ref"]
            and payload["envelope_sha256"] == state["envelope_sha256"],
            "old transfer target/envelope differs",
        )
        return payload, value, sha(raw), sha(read(path))

    for path in sorted(directory.glob("*-write.request.json")):
        payload, value, raw_sha, request_sha = record(path)
        stderr = value.get("stderr", "")
        if stderr.startswith(
            "Unhandled rejection: Rejection([PayloadTooLarge, MethodNotAllowed"
        ):
            need(
                value.get("stdout") == ""
                and value.get("exit_code") == 0
                and payload["action"] == "chunk"
                and payload["index"] == 0,
                "unsupported old rejection",
            )
            descriptor = descriptors[payload["sha256"]]
            need(
                base64.b64decode(payload["data"], validate=True)
                == read(descriptor["path"])[:32768],
                "rejected old chunk bytes differ",
            )
            rejected.append((path, payload, raw_sha, request_sha))
        else:
            need(
                value.get("exit_code") == 0 and value.get("stderr") in ("", None),
                "unresolved old transfer write",
            )
            ack = json.loads(value["stdout"])
            need(
                ack.get("state") in ("CHUNK", "READY"),
                "old transfer write did not acknowledge",
            )
    need(
        len(rejected) == 1, "exactly one retained old pre-execution rejection required"
    )
    failed, payload, failed_sha, request_sha = rejected[0]
    for path in sorted(directory.glob("*-observe.request.json")):
        if path.name <= failed.name:
            continue
        probe, value, raw_sha, _ = record(path)
        if (
            probe.get("action") == "observe-chunk"
            and probe.get("sha256") == payload["sha256"]
            and probe.get("index") == 0
        ):
            need(
                value.get("stdout") == ""
                and value.get("exit_code") == 1
                and "FileNotFoundError" in value.get("stderr", "")
                and "/tmp/controller-sidecar-" + payload["sha256"] in value["stderr"],
                "old chunk absence is not positively observed",
            )
            return {
                "failed_request_sha256": request_sha,
                "rejection_wire_sha256": failed_sha,
                "absence_wire_sha256": raw_sha,
            }
    raise ValueError("no retained post-rejection read-only missing-chunk proof")


def check(config, config_sha256, run_directory, operator_ref):
    raw = read(config)
    need(sha(raw) == config_sha256, "original derived config checksum changed")
    value = json.loads(raw)
    need(
        re.fullmatch("[0-9a-f]{40}", operator_ref or ""),
        "explicit reviewed borrower operator ref required",
    )
    operator_hashes = {
        name: sha((HERE / name).read_bytes())
        for name in (
            "cloudbench-resume-controller-payload.py",
            "cloudbench-original600-runner.py",
            "run-original600-controller.py",
            "cloudbench-original-volume-capture.py",
        )
    }
    operator_pins = source_identity(HERE.parent, operator_ref, operator_hashes)
    need(
        value.get("schema") == "original600-controller-runner-v1"
        and value.get("allowed") is True,
        "explicit original runner config required",
    )
    out = Path(run_directory).absolute()
    need(
        out.resolve(strict=True) == out
        and out.is_dir()
        and not out.stat().st_mode & 0o077,
        "private physical original run required",
    )
    caller = object_file(out / "caller.json")
    authority_raw = read(out / "authority.private.json")
    authority = json.loads(authority_raw)
    need(caller["authority_sha256"] == sha(authority_raw), "caller authority differs")
    epoch = value["started_at_epoch"]
    need(
        type(epoch) in (int, float)
        and epoch > 0
        and caller["epoch"] == epoch
        and caller["deadline"] == epoch + 5400
        and time.time() < epoch + 5400,
        "original clock expired or changed",
    )
    ref = value["source_ref"]
    need(
        re.fullmatch("[0-9a-f]{40}", ref)
        and caller["source_ref"] == ref
        and caller["task_ref"] == R["TASK_REF"],
        "original source/task differs",
    )
    template = object_file(value["authority_template"])
    expected = dict(
        template,
        cleanup_owner_pid=caller["pid"],
        cleanup_owner_birth=caller["birth"],
        output_directory=str(out / "export"),
    )
    need(
        authority == expected
        and authority["allowed"] is True
        and authority["app"] == R["APP"]
        and authority["source_ref"] == ref,
        "original cleanup authority differs",
    )
    owner = process_identity(caller["pid"])
    gate = process_identity(caller["gate_pid"])
    need(
        owner["birth"] == caller["birth"] and gate["birth"] == caller["gate_birth"],
        "original owner/gate birth differs",
    )
    gate_stat = (
        Path("/proc", str(caller["gate_pid"]), "stat")
        .read_text()
        .rsplit(") ", 1)[1]
        .split()
    )
    need(int(gate_stat[1]) == caller["pid"], "original gate is not owned by caller")
    public = [
        Path(arg) if Path(arg).is_absolute() else Path(owner["cwd"]) / arg
        for arg in owner["argv"]
        if arg.endswith(
            (
                "/scripts/run-original600-controller.py",
                "/scripts/cloudbench-original600-runner.py",
            )
        )
        or arg
        in (
            "scripts/run-original600-controller.py",
            "scripts/cloudbench-original600-runner.py",
        )
    ]
    need(
        len(public) == 1 and public[0].resolve(strict=True) == public[0],
        "live original caller command is not canonical",
    )
    host = public[0].parent.parent
    provenance = value.get("host_operator_provenance", {})
    host_ref = provenance.get("host_operator_source_ref", ref)
    host_runner = host / "scripts/cloudbench-original600-runner.py"
    host_gate = host / "scripts/run-cloudbench-controller-gate"
    host_pins = {
        "cloudbench-original600-runner.py": provenance.get(
            "host_runner_sha256",
            value["source_files"]["cloudbench-original600-runner.py"],
        ),
        "run-cloudbench-controller-gate": provenance.get(
            "host_gate_sha256", value["source_files"]["run-cloudbench-controller-gate"]
        ),
        public[0].name: sha(public[0].read_bytes()),
    }
    gate_pins = gate_program_identity(
        gate,
        host_gate,
        value["source_root"],
        out / "authority.private.json",
        host_pins["run-cloudbench-controller-gate"],
    )
    pins = source_identity(Path(value["source_root"]), ref, value["source_files"])
    pins.update(source_identity(host, host_ref, host_pins))
    pins.update(gate_pins)
    pins.update(operator_pins)
    need(
        sha(host_runner.read_bytes()) == host_pins["cloudbench-original600-runner.py"],
        "old host runner changed",
    )
    ownership_raw = read(out / "export/disposable-controller.ownership.json")
    ownership = json.loads(ownership_raw)
    machine = ownership["machine"]
    need(
        ownership["authority_sha256"] == sha(authority_raw)
        and ownership["workspace_sha256"]
        == sha(read(out / "export/workspace-volume.ownership.json")),
        "sealed controller custody differs",
    )
    mid = machine["id"]
    identity = object_file(out / "controller.identity.json")
    need(
        identity
        == {
            "machine": mid,
            "instance": machine["instance_id"],
            "source_ref": ref,
            "authority_sha256": sha(authority_raw),
        },
        "controller identity differs",
    )
    need(
        mid not in authority["protected_machines"]
        and machine["config"]["env"]["GATE_REF"] == ref,
        "wrong/protected controller",
    )
    envelope_raw = read(out / "controller-launch-payload.private.json.gz")
    envelope = json.loads(gzip.decompress(envelope_raw))
    tasks = object_file(value["tasks_path"])
    need(
        envelope["source_ref"] == ref
        and envelope["epoch"] == epoch
        and envelope["tasks"] == tasks
        and envelope["campaign_argv"] == R["campaign_argv"](tasks, epoch),
        "original launch semantics differ",
    )
    need(
        envelope["supervisor_sha256"]
        == value["source_files"]["cloudbench-original600-supervisor.py"]
        and caller["identity_path"]
        == "/tmp/gate/repo/.context/" + envelope["identity_name"],
        "supervisor identity differs",
    )
    for key, item in value.get("remote_env", {}).items():
        need(envelope["remote_env"].get(key) == item, "original remote env differs")
    sealed = [
        row
        for row in machine["config"]["files"]
        if row["guest_path"] == "/tmp/controller-launch-payload.json.gz"
    ]
    need(
        len(sealed) == 1
        and base64.b64decode(sealed[0]["raw_value"], validate=True) == envelope_raw,
        "sealed native envelope differs",
    )
    descriptors = object_file(out / "controller-sidecars.private.json")
    by_sha = {row["sha256"]: row for row in descriptors}
    need(len(by_sha) == len(descriptors), "duplicate sidecar descriptor")
    sources = {row["relative_path"]: row for row in value["remote_files"]}
    need(
        set(sources) == {row["relative_path"] for row in envelope["remote_files"]},
        "remote metadata membership differs",
    )
    for item in envelope["remote_files"]:
        need(
            item["encoding"] == "external-gzip" and item["transfer_sha256"] in by_sha,
            "sidecar envelope differs",
        )
        descriptor = by_sha[item["transfer_sha256"]]
        path = Path(descriptor["path"])
        need(
            path.parent == out
            and path.name
            == "controller-sidecar-" + descriptor["sha256"] + ".private.gz",
            "sidecar path differs",
        )
        data = read(path)
        source = sources[item["relative_path"]]
        original = read(source["source_path"])
        need(
            len(data) == descriptor["bytes"] == item["transfer_bytes"]
            and sha(data) == descriptor["sha256"]
            and gzip.decompress(data) == original
            and sha(original) == source["sha256"] == item["sha256"],
            "sidecar source/hash differs",
        )
    for entry in authority["env_files"].values():
        need(
            sha(read(entry["path"])) == entry["sha256"],
            "authoritative credential env changed",
        )
    state = {
        "operator_ref": operator_ref,
        "operator_hashes": operator_hashes,
        "config": str(Path(config).absolute()),
        "config_sha256": config_sha256,
        "out": out,
        "caller": caller,
        "owner": owner,
        "gate": gate,
        "authority": authority,
        "machine": machine,
        "machine_id": mid,
        "envelope_sha256": sha(envelope_raw),
        "epoch": epoch,
        "deadline": epoch + 5400,
        "pins": pins,
        "source_root": value["source_root"],
        "source_ref": ref,
        "host": str(host),
        "host_ref": host_ref,
    }
    requests = sorted(
        (out / "payload-transfer").glob("[0-9][0-9][0-9][0-9]-*.request.json")
    )
    last = requests[-1] if requests else None
    if (
        last
        and last.name.endswith("-identity.request.json")
        and not last.with_name(
            last.name.removesuffix(".request.json") + ".wire.json"
        ).exists()
    ):
        state["old_recovery"] = acknowledged_read_timeout(state)
    else:
        state["old_recovery"] = old_rejection(state)
    return state


def owner_unchanged(state):
    try:
        return (
            process_identity(state["caller"]["pid"]) == state["owner"]
            and process_identity(state["caller"]["gate_pid"]) == state["gate"]
            and all(fingerprint(path) == value for path, value in state["pins"].items())
        )
    except (OSError, ValueError):
        return False


def execute(state, api_factory=None):
    """One borrowed transfer. An incomplete prior borrow is never replay authority."""
    out = state["out"]
    lock_fd = os.open(
        out / "payload-borrow.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    try:
        info = os.fstat(lock_fd)
        need(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077,
            "private borrower lock required",
        )
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        intent = out / "payload-borrow.intent.json"
        complete = out / "payload-borrow.complete.json"
        binding = {
            "operator_ref": state["operator_ref"],
            "operator_hashes": state["operator_hashes"],
            "old_recovery": state["old_recovery"],
            "config_sha256": state["config_sha256"],
            "machine": state["machine_id"],
            "instance": state["machine"]["instance_id"],
            "envelope_sha256": state["envelope_sha256"],
            "caller_pid": state["caller"]["pid"],
            "caller_birth": state["caller"]["birth"],
            "original_epoch": state["epoch"],
            "original_deadline": state["deadline"],
        }
        if intent.exists():
            previous = object_file(intent)
            need(
                all(previous.get(key) == item for key, item in binding.items()),
                "prior borrower identity differs",
            )
            need(
                complete.exists(),
                "incomplete prior borrower: observation/reconciliation only; do not retry",
            )
            result = object_file(complete)
            need(
                all(result.get(key) == item for key, item in binding.items()),
                "completed borrower identity differs",
            )
            return result
        need(
            owner_unchanged(state) and time.time() < state["deadline"],
            "original owner/source changed",
        )
        journal = out / ("payload-borrow-" + uuid.uuid4().hex)
        save(
            intent,
            dict(
                binding,
                journal=str(journal),
                borrower_pid=os.getpid(),
                borrower_birth=R["birth"](os.getpid()),
            ),
        )
        stopped = [False]

        def cancel(*unused):
            stopped[0] = True

        handlers = {
            sig: signal.signal(sig, cancel) for sig in (signal.SIGINT, signal.SIGTERM)
        }
        try:
            agents = state["authority"]["env_files"]["agents"]
            need(
                sha(read(agents["path"])) == agents["sha256"],
                "original auth env changed",
            )
            public = runpy.run_path(str(HERE / "run-original600-controller.py"))
            token = public["token_from_agents"](read(agents["path"]))
            factory = (
                api_factory
                or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))[
                    "Fly"
                ]
            )
            api = factory(R["APP"], token)
            R["transfer_sidecars"](
                api,
                state["machine_id"],
                state["machine"],
                out,
                state["envelope_sha256"],
                state["deadline"],
                lambda: stopped[0] or not owner_unchanged(state),
                journal=journal,
            )
            need(
                not stopped[0] and owner_unchanged(state),
                "original owner/source changed during transfer",
            )
            need(
                object_file(journal / "complete.json")["envelope_sha256"]
                == state["envelope_sha256"],
                "transfer did not close",
            )
            result = dict(
                binding,
                status="TRANSFER_ONLY_COMPLETE",
                transfer_journal=str(journal),
                original_owner_retained=True,
                benchmark_success_inferred=False,
                cleanup_complete=False,
            )
            save(complete, result)
            return result
        except BaseException as error:
            save(
                out / "payload-borrow.failed.json",
                dict(
                    binding,
                    error=type(error).__name__,
                    journal=str(journal),
                    no_automatic_retry=True,
                ),
            )
            raise
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check",
        action="store_true",
        help="pure local validation; no locks, journals, or provider calls",
    )
    mode.add_argument(
        "--run",
        action="store_true",
        help="one borrowed payload transfer; original owner retains cleanup authority",
    )
    parser.add_argument(
        "--operator-ref",
        required=True,
        help="exact reviewed new borrower commit, distinct from unchanged old workload/host",
    )
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--run-directory", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    state = check(
        args.config, args.config_sha256, args.run_directory, args.operator_ref
    )
    result = (
        execute(state)
        if args.run
        else {
            "status": "CHECKED_TRANSFER_ONLY",
            "machine": state["machine_id"],
            "instance": state["machine"]["instance_id"],
            "original_deadline": state["deadline"],
            "provider_calls": 0,
        }
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
