#!/usr/bin/env python3
"""Capture original identities locally, then observe closure and finalize one borrower."""

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import runpy
import select
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
B = runpy.run_path(str(HERE / "cloudbench-resume-controller-payload.py"))
R = B["R"]
need, read, save, sha = (R[key] for key in ("need", "read", "save", "sha"))


def obj(path):
    return json.loads(read(path))


def normalized(value):
    return json.loads(json.dumps(value, default=str, sort_keys=True, allow_nan=False))


def operator(ref, root=HERE.parent):
    names = (
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original600-runner.py",
        "run-original600-controller.py",
        "cloudbench-original-volume-capture.py",
    )
    hashes = {name: sha((root / "scripts" / name).read_bytes()) for name in names}
    return hashes, B["source_identity"](root, ref, hashes)


def borrow_binding(state, intent):
    expected = {
        "config_sha256": state["config_sha256"],
        "machine": state["machine_id"],
        "instance": state["machine"]["instance_id"],
        "envelope_sha256": state["envelope_sha256"],
        "caller_pid": state["caller"]["pid"],
        "caller_birth": state["caller"]["birth"],
        "original_epoch": state["epoch"],
        "original_deadline": state["deadline"],
    }
    need(
        all(intent.get(key) == value for key, value in expected.items()),
        "original borrow binding differs",
    )
    need(
        intent.get("old_recovery") == state["old_recovery"],
        "borrow rejection proof differs",
    )
    for name, digest in intent["operator_hashes"].items():
        raw = subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                intent["operator_ref"] + ":scripts/" + name,
            ]
        )
        need(sha(raw) == digest, "first borrower Git blob differs")
    return expected


def capture(config, config_sha256, directory, ref):
    """No API, signal, or transfer: preserve live local proof in an exclusive receipt."""
    state = B["check"](config, config_sha256, directory, ref)
    hashes, pins = operator(ref)
    state["pins"].update(pins)
    intent_path = state["out"] / "payload-borrow.intent.json"
    intent = obj(intent_path)
    borrow_binding(state, intent)
    need(B["owner_unchanged"](state), "original live identities changed")
    state["gate_snapshot_paths"] = [
        path
        for path in state["pins"]
        if Path(path).name.startswith("cloudbench-gate-self.")
    ]
    state["finalizer_operator_hashes"] = hashes
    state["first_borrow_intent_sha256"] = sha(read(intent_path))
    state["first_borrow_operator_ref"] = intent["operator_ref"]
    state["captured_at_epoch"] = time.time()
    state["schema"] = "controller-payload-finalizer-identities-v1"
    value = normalized(state)
    path = state["out"] / "payload-finalizer.identities.private.json"
    need(
        not path.exists(), "identity capture already exists; preserve original receipt"
    )
    save(path, value)
    return {
        "status": "LOCAL_IDENTITIES_CAPTURED",
        "path": str(path),
        "sha256": sha(read(path)),
        "provider_calls": 0,
        "original_deadline": state["deadline"],
    }


def gate_gone(state):
    """Absence, never a zombie or a reused PID, with the original parent still live."""
    need(
        B["process_identity"](state["caller"]["pid"]) == state["owner"],
        "original caller changed",
    )
    path = Path("/proc") / str(state["caller"]["gate_pid"])
    if not path.exists():
        return True
    try:
        raw = (path / "stat").read_text().rsplit(") ", 1)[1].split()
        if raw[0] == "Z":
            birth = (
                "proc-start:"
                + Path("/proc/sys/kernel/random/boot_id").read_text().strip()
                + ":"
                + raw[19]
            )
            need(birth == state["caller"]["gate_birth"], "zombie gate PID reused")
            return False
        need(
            B["process_identity"](state["caller"]["gate_pid"]) == state["gate"],
            "gate reused or not reaped",
        )
        return False
    except FileNotFoundError:
        need(
            B["process_identity"](state["caller"]["pid"]) == state["owner"],
            "caller changed during reap",
        )
        need(not path.exists(), "gate identity read failed while still present")
        return True


def validate(state, config, digest, directory, ref, operator_root=HERE.parent):
    need(
        state["schema"] == "controller-payload-finalizer-identities-v1",
        "unknown identity receipt",
    )
    need(
        state["config"] == str(Path(config).absolute())
        and sha(read(config)) == digest == state["config_sha256"],
        "original config changed",
    )
    need(
        state["out"] == str(Path(directory).absolute())
        and state["operator_ref"] == ref,
        "finalizer run/operator changed",
    )
    hashes, _ = operator(ref, operator_root)
    need(hashes == state["finalizer_operator_hashes"], "finalizer runtime changed")
    out = Path(directory)
    intent = obj(out / "payload-borrow.intent.json")
    need(
        sha(read(out / "payload-borrow.intent.json"))
        == state["first_borrow_intent_sha256"],
        "borrow intent changed",
    )
    borrow_binding(state, intent)
    need(state["deadline"] == state["epoch"] + 5400, "original deadline changed")
    gone = gate_gone(state)
    # Only the exact canonical gate snapshot can disappear after its parent reaped it.
    for path, value in state["pins"].items():
        actual = B["fingerprint"](path)
        if actual is None and gone and path in state.get("gate_snapshot_paths", []):
            continue
        need(normalized(actual) == value, "source/identity file changed: " + path)
    return gone


def validate_args(state, args):
    resumed = state.get("_resume")
    if resumed:
        gone = validate(
            state,
            args.config,
            args.config_sha256,
            args.run_directory,
            state["operator_ref"],
            Path(resumed["capture_root"]),
        )
        need(args.operator_ref == resumed["operator_ref"], "resume operator changed")
        hashes, _ = operator(args.operator_ref)
        need(hashes == resumed["operator_hashes"], "resume source changed")
        need(
            {p.name for p in Path(resumed["journal"]).iterdir()}
            == set(resumed["files"]),
            "prior journal membership changed",
        )
        for path, expected in resumed["pins"].items():
            need(
                normalized(B["fingerprint"](path)) == expected,
                "resume evidence changed: " + path,
            )
        return gone
    return validate(
        state, args.config, args.config_sha256, args.run_directory, args.operator_ref
    )


def prior_finalizer_dead(intent):
    pid, expected = intent.get("pid"), intent.get("birth")
    need(
        type(pid) is int
        and pid > 1
        and isinstance(expected, str)
        and re.fullmatch(
            r"proc-start:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+", expected
        ),
        "prior finalizer identity missing",
    )
    try:
        raw = Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()
    except FileNotFoundError:
        return True
    current = (
        "proc-start:"
        + Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        + ":"
        + raw[19]
    )
    return current != expected or raw[0] == "Z"


def cleanup_command(state):
    out = Path(state["out"])
    export = out / "export"
    return [
        sys.executable,
        "-S",
        str(Path(state["source_root"]) / "scripts/cloudbench-disposable-controller.py"),
        "cleanup",
        "--authority",
        str(out / "authority.private.json"),
        "--root",
        state["source_root"],
        "--directory",
        str(export),
        "--workspace",
        str(export / "workspace-volume.ownership.json"),
    ]


def cleanup_closure(state, export_sha):
    return {
        "machine": state["machine_id"],
        "action": "cleanup",
        "gate_joined": True,
        "supervisor_joined": True,
        "export_verified_file": export_sha,
    }


def credential_refusal(state, journal, intent):
    """Recognize only the known joined pre-client refusal, never a failed API call."""
    need(
        intent["finalizer_operator_ref"] == "447bf65e8e4f5b3faf8e02c695ac5f7411d24c39",
        "credential recovery requires the known original operator",
    )
    root = Path(state["source_root"])
    sources = {
        "cloudbench-disposable-controller.py": "452488443699467881d2a68b17305867f98539540ddb4602e338caf732721ea8",
        "cloudbench-original-volume-capture.py": "4006c6ca65a89285614669b747c0d1d01100b5c04f35c36dc89acc84cd5bf49b",
        "lib/cloudbench-inventory.sh": "6c4483401a301a909cac89757a862e6e7a2bb2dee1562a45cd9309556b261db0",
    }
    source_pins = B["source_identity"](root, state["source_ref"], sources)
    helper = str(root / "scripts/cloudbench-disposable-controller.py")
    transport = str(root / "scripts/cloudbench-original-volume-capture.py")
    expected = (
        "Traceback (most recent call last):\n"
        f'  File "{helper}", line 221, in <module>\n'
        "    if __name__=='__main__':main()\n"
        "                            ^^^^^^\n"
        f'  File "{helper}", line 205, in main\n'
        "    client=scope['Fly'](a['app'],os.environ.get('FLY_API_TOKEN')or scope['resolve_token']({'workspace':str(args.root)}))\n"
        "                                                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n"
        f'  File "{transport}", line 936, in resolve_token\n'
        '    raise Refusal("no Fly credential is available")\n'
        "disposable_controller_transport.Refusal: no Fly credential is available\n"
    )
    need(
        read(journal / "cleanup.log") == expected.encode(),
        "not the exact pre-client credential refusal",
    )
    need(
        obj(journal / "cleanup.intent.json")
        == {
            "argv": cleanup_command(state),
            "gate_reap": "OBSERVED_ORIGINAL_PARENT_REAP",
            "gate_exit_code": None,
        },
        "prior cleanup command differs",
    )
    child = obj(journal / "cleanup.child.json")
    need(prior_finalizer_dead(child), "prior cleanup child still live or unknown")
    need(
        obj(journal / "cleanup.joined.json") == {"exit_code": 1, "owned_join": True},
        "prior cleanup was not positively joined with refusal",
    )
    out = Path(state["out"])
    need(
        obj(out / "cleanup-call.intent.json")
        == cleanup_closure(state, verified_export(state)),
        "prior cleanup closure differs",
    )
    for name in (
        "disposable-delete-machine.intent.json",
        "disposable-delete-volume.intent.json",
        "disposable-controller.release.json",
    ):
        need(
            not os.path.lexists(out / "export" / name),
            "native cleanup already entered; no credential retry",
        )
    return out / "cleanup-call.intent.json", source_pins


def prior_joined_probe(state, journal, requests, files):
    """Use a prior terminal observation only with its exact raw transport proof."""
    joined = None

    def recorded(stem):
        values = []
        for suffix in ("raw", "decoded"):
            name = stem + "." + suffix + ".json"
            need(name in files, "prior JOINED transport proof missing")
            raw = read(journal / name)
            need(sha(raw) == files[name], "prior JOINED transport proof changed")
            values.append(json.loads(raw))
        wire, value = values
        raw = base64.b64decode(wire["body_b64"], validate=True)
        need(
            wire["status"] == 200
            and wire["bytes"] == len(raw)
            and wire["sha256"] == sha(raw)
            and json.loads(raw) == value,
            "prior JOINED raw response differs",
        )
        return value

    for name in sorted(files):
        if not re.fullmatch(r"probe-[0-9]{6}\.json", name):
            continue
        raw = read(journal / name)
        value = json.loads(raw)
        if value.get("state") != "JOINED":
            continue
        need(sha(raw) == files[name], "prior JOINED observation changed")
        identity, terminal = value["identity"], value["terminal"]
        need(
            identity.get("schema") == "original600-supervisor-identity-v1"
            and identity.get("machine") == state["machine_id"]
            and identity.get("source_ref") == state["source_ref"]
            and identity.get("epoch") == state["epoch"]
            and type(identity.get("pid")) is int
            and identity["pid"] > 1
            and isinstance(identity.get("birth"), str)
            and re.fullmatch(r"proc-start:[0-9a-f-]{36}:[0-9]+", identity["birth"])
            and value["identity_sha256"]
            == sha((json.dumps(identity, sort_keys=True) + "\n").encode())
            and all(terminal.get(key) == item for key, item in identity.items())
            and terminal.get("supervisor_joined") is True
            and terminal.get("parent_joined") is True
            and type(terminal.get("parent_pid")) is int
            and terminal["parent_pid"] > 1
            and type(terminal.get("supervisor_exit_code")) is int
            and isinstance(terminal.get("epoch_finished"), (int, float))
            and terminal["epoch_finished"] >= state["epoch"],
            "prior JOINED terminal identity differs",
        )
        matches = []
        observations = []
        for stem, request in requests.items():
            if request["method"] != "POST" or stem + ".decoded.json" not in files:
                continue
            response = recorded(stem)
            if (
                not isinstance(response, dict)
                or response.get("exit_code", 0) != 0
                or response.get("exit_signal", 0) != 0
                or response.get("stderr") not in (None, "")
            ):
                continue
            try:
                observed = json.loads(response.get("stdout", ""))
            except (TypeError, ValueError):
                continue
            if isinstance(observed, dict):
                observations.append((stem, observed))
                if observed.get("identity") is not None:
                    need(
                        observed["identity"] == identity,
                        "conflicting supervisor identity in prior history",
                    )
                if observed.get("state") == "JOINED":
                    need(observed == value, "conflicting prior terminal observation")
            if observed != value:
                continue
            previous = "wire-" + str(int(stem[5:]) - 1).zfill(6)
            need(
                requests.get(previous)
                == {
                    "method": "GET",
                    "path": "/machines/" + state["machine_id"],
                    "body": None,
                },
                "prior JOINED native observation missing",
            )
            native = recorded(previous)
            need(
                all(
                    native.get(key) == state["machine"].get(key)
                    for key in ("id", "instance_id", "config", "name", "region")
                ),
                "prior JOINED native incarnation differs",
            )
            matches.append(stem)
        need(matches, "prior JOINED has no matching raw PROBE")
        need(
            all(
                stem <= min(matches) or item.get("state") == "JOINED"
                for stem, item in observations
            ),
            "prior supervisor became live after JOINED",
        )
        need(joined is None or joined == value, "conflicting prior JOINED observations")
        joined = value
    return joined


def prepare_resume(state, args, cleanup_refusal=False):
    """Authorize a new reader only from a stopped, exclusively read-only journal."""
    out = Path(state["out"])
    roots = {
        str(Path(path).parent.parent)
        for path in state["pins"]
        if Path(path).name == "cloudbench-controller-payload-finalization.py"
    }
    need(len(roots) == 1, "captured finalizer root is ambiguous")
    capture_root = Path(roots.pop())
    validate(
        state, args.config, args.config_sha256, out, state["operator_ref"], capture_root
    )
    journal = Path(args.resume_journal).absolute()
    need(
        journal.parent == out
        and re.fullmatch(
            r"payload-finalization(?:-resume-[0-9a-f]{16})?", journal.name
        ),
        "exact prior finalizer journal required",
    )
    need(
        journal.resolve(strict=True) == journal and journal.is_dir(),
        "physical prior journal required",
    )
    info = journal.stat()
    need(
        info.st_uid == os.geteuid() and not info.st_mode & 0o077,
        "private prior journal required",
    )
    need(
        (cleanup_refusal or not os.path.lexists(out / "cleanup-call.intent.json"))
        and not os.path.lexists(out / "terminal.json"),
        "cleanup or terminal already exists; reconcile without replay",
    )
    intent = obj(journal / "intent.json")
    need(
        intent.get("identity_sha256")
        == sha(read(out / "payload-finalizer.identities.private.json"))
        and intent.get("first_borrow_operator_ref")
        == state["first_borrow_operator_ref"]
        and intent.get("original_deadline") == state["deadline"],
        "prior finalizer binding differs",
    )
    need(
        prior_finalizer_dead(intent),
        "prior finalizer still live or unknown",
    )
    prior_hashes = intent.get("operator_hashes", state["finalizer_operator_hashes"])
    prior_ref = intent.get("finalizer_operator_ref")
    need(
        isinstance(prior_ref, str) and re.fullmatch("[0-9a-f]{40}", prior_ref),
        "prior operator unbound",
    )
    need(
        set(prior_hashes) == set(state["finalizer_operator_hashes"]),
        "incomplete prior operator pins",
    )
    if journal.name == "payload-finalization":
        need(
            prior_ref == state["operator_ref"]
            and prior_hashes == state["finalizer_operator_hashes"],
            "initial finalizer differs from capture",
        )
    for name, digest in prior_hashes.items():
        raw = subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                prior_ref + ":scripts/" + name,
            ]
        )
        need(sha(raw) == digest, "prior operator source differs")
    closure_path, cleanup_pins = (
        credential_refusal(state, journal, intent) if cleanup_refusal else (None, {})
    )
    expected_probe = {
        "cmd": R["exec_command"](
            R["REMOTE_CONTROL"],
            {
                "machine": state["machine_id"],
                "source_ref": state["source_ref"],
                "epoch": state["epoch"],
                "identity_path": state["caller"]["identity_path"],
                "action": "PROBE",
            },
        ),
        "timeout": 20,
        "machine": True,
    }
    files = {}
    pins = {}
    requests = {}
    total = 0
    entries = list(journal.iterdir())
    need(len(entries) < 10000, "prior journal exceeds bounded membership")
    for path in entries:
        need(
            path.name == "intent.json"
            or (
                cleanup_refusal
                and path.name
                in {
                    "cleanup.intent.json",
                    "cleanup.child.json",
                    "cleanup.joined.json",
                    "cleanup.log",
                }
            )
            or re.fullmatch(r"(?:probe|read-pending)-[0-9]{6}\.json", path.name)
            or re.fullmatch(r"wire-[0-9]{6}\.(?:request|raw|decoded)\.json", path.name),
            "prior journal contains an effect or unknown member",
        )
        before = B["fingerprint"](path)
        raw = read(path)
        total += len(raw)
        need(
            before is not None and before == B["fingerprint"](path),
            "prior journal changed during read",
        )
        need(total < 256 * 1024 * 1024, "prior journal exceeds bounded bytes")
        value = None if path.name == "cleanup.log" else json.loads(raw)
        files[path.name] = sha(raw)
        pins[str(path)] = normalized(before)
        if path.name.endswith(".request.json"):
            base = "/machines/" + state["machine_id"]
            need(
                value == {"method": "GET", "path": base, "body": None}
                or value
                == {"method": "POST", "path": base + "/exec", "body": expected_probe},
                "prior request is not an exact read-only observation",
            )
            requests[path.name[:-13]] = value
    need(requests, "prior journal has no read-only requests")
    for path in entries:
        if path.name.endswith((".raw.json", ".decoded.json")):
            suffix = ".raw.json" if path.name.endswith(".raw.json") else ".decoded.json"
            stem = path.name[: -len(suffix)]
            need(stem in requests, "orphan prior response")
            if suffix == ".decoded.json":
                need(
                    (journal / (stem + ".raw.json")).is_file(),
                    "decoded prior response lacks raw receipt",
                )
            if suffix == ".raw.json":
                value = obj(path)
                raw = base64.b64decode(value["body_b64"], validate=True)
                need(
                    value["method"] == requests[stem]["method"]
                    and value["path"] == requests[stem]["path"]
                    and type(value["status"]) is int
                    and value["bytes"] == len(raw)
                    and value["sha256"] == sha(raw),
                    "prior raw response binding differs",
                )
                decoded = journal / (stem + ".decoded.json")
                if decoded.exists():
                    need(
                        obj(decoded) == (json.loads(raw) if raw.strip() else {}),
                        "prior response decode differs",
                    )
    hashes, new_pins = operator(args.operator_ref)
    pins.update({path: normalized(value) for path, value in new_pins.items()})
    pins.update({path: normalized(value) for path, value in cleanup_pins.items()})
    if closure_path:
        pins[str(closure_path)] = normalized(B["fingerprint"](closure_path))
    manifest = {
        "journal": str(journal),
        "files": files,
        "operator_ref": args.operator_ref,
        "cleanup_credential_refusal": cleanup_refusal,
    }
    identity = sha(json.dumps(manifest, sort_keys=True).encode())
    value = dict(state)
    value["_resume"] = dict(
        manifest,
        capture_root=str(capture_root),
        pins=pins,
        operator_hashes=hashes,
        journal_name="payload-finalization-resume-" + identity[:16],
        prior_manifest_sha256=identity,
        cleanup_credential_refusal=cleanup_refusal,
        joined_probe=prior_joined_probe(state, journal, requests, files),
    )
    return value


def term_once(api, state, payload, probe):
    out = Path(state["out"])
    expected = {
        "machine": state["machine_id"],
        "pid": probe["identity"]["pid"],
        "birth": probe["identity"]["birth"],
        "identity_sha256": probe["identity_sha256"],
        "signal": "SIGTERM",
        "path": payload["identity_path"],
    }
    path = out / "supervisor-term.intent.json"
    if not path.exists():
        try:
            R["request_term"](api, state["machine_id"], payload, probe, out)
        except FileExistsError:
            pass
    need(obj(path) == expected, "existing supervisor TERM identity differs")


def verified_export(state):
    export = Path(state["out"]) / "export"
    marker = obj(export / "disposable-export.verified.json")
    need(
        marker["authority_sha256"]
        == sha(read(Path(state["out"]) / "authority.private.json"))
        and marker["machine_id"] == state["machine_id"],
        "export authority differs",
    )
    required = {"originals.tar.gz", "manifest.json", "launch.json", "caller.json"}
    need(set(marker["files"]) == required, "full canonical export membership required")
    for name, digest in marker["files"].items():
        path = export / name
        need(
            path.resolve(strict=True) == path.absolute(),
            "physical export file required",
        )
        h = hashlib.sha256()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            need(
                stat.S_ISREG(before.st_mode)
                and before.st_uid == os.geteuid()
                and before.st_nlink == 1
                and not before.st_mode & 0o077,
                "private regular export required",
            )
            for block in iter(lambda: stream.read(1048576), b""):
                h.update(block)
            after = os.fstat(stream.fileno())
            need(
                (
                    before.st_dev,
                    before.st_ino,
                    before.st_size,
                    before.st_mtime_ns,
                    before.st_ctime_ns,
                )
                == (
                    after.st_dev,
                    after.st_ino,
                    after.st_size,
                    after.st_mtime_ns,
                    after.st_ctime_ns,
                ),
                "export changed during read",
            )
        need(h.hexdigest() == digest, "verified export bytes changed")
    return sha(read(export / "disposable-export.verified.json"))


def selected_token(state):
    agents = state["authority"]["env_files"]["agents"]
    raw = read(agents["path"])
    need(sha(raw) == agents["sha256"], "authority env changed")
    public = runpy.run_path(str(HERE / "run-original600-controller.py"))
    return public["token_from_agents"](raw)


def api_for(state):
    token = selected_token(state)
    factory = runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["Fly"]
    return factory(R["APP"], token)


class RecordedAPI:
    """Bounded original target only; raw status/body persisted before decoding."""

    def __init__(self, api, state, journal):
        self.transport, self.state, self.journal = api, state, journal
        self.sequence = 0

    def request(self, method, path, body=None, timeout=20):
        self.sequence += 1
        prefix = self.journal / f"wire-{self.sequence:06d}"
        save(
            Path(str(prefix) + ".request.json"),
            {"method": method, "path": path, "body": body},
        )

        def observe(actual_method, actual_path, status, raw):
            save(
                Path(str(prefix) + ".raw.json"),
                {
                    "method": actual_method,
                    "path": actual_path,
                    "status": status,
                    "body_b64": base64.b64encode(raw).decode(),
                    "sha256": sha(raw),
                    "bytes": len(raw),
                },
            )

        with R["bounded"](timeout):
            result = self.transport.api(
                method, path, body, timeout=timeout, observer=observe
            )
        save(Path(str(prefix) + ".decoded.json"), result)
        return result

    def api(self, method, path, body=None, timeout=20):
        base = "/machines/" + self.state["machine_id"]
        need(
            method == "POST" and path == base + "/exec",
            "only bound supervisor exec allowed",
        )
        current = self.request("GET", base, timeout=timeout)
        original = self.state["machine"]
        need(
            all(
                current.get(key) == original.get(key)
                for key in ("id", "instance_id", "config", "name", "region")
            ),
            "controller native identity/config changed",
        )
        result = self.request(method, path, body, timeout)
        probe = {
            "machine": self.state["machine_id"],
            "source_ref": self.state.get("source_ref"),
            "epoch": self.state.get("epoch"),
            "identity_path": self.state.get("caller", {}).get("identity_path"),
            "action": "PROBE",
        }
        expected = {
            "cmd": R["exec_command"](R["REMOTE_CONTROL"], probe),
            "timeout": 20,
            "machine": True,
        }
        if (
            body == expected
            and isinstance(result, dict)
            and set(result) == {"exit_code", "exit_signal", "stderr", "stdout"}
            and type(result["exit_code"]) is int
            and result["exit_code"] == 0
            and type(result["exit_signal"]) is int
            and result["exit_signal"] == 0
            and result["stdout"] == ""
            and result["stderr"]
            in ("No child process (os error 10)", "No child process (os error 10)\n")
        ):
            raise OSError(
                "read-only supervisor exec unavailable: No child process (os error 10)"
            )
        return result


def retire_caller(state, directory, closure_check, timeout=5):
    """Only after a validated release, use a pinned pidfd; never signal a recycled PID."""
    need(
        hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"),
        "pidfd support required",
    )
    owner = state["owner"]
    need(
        B["process_identity"](owner["pid"]) == owner, "original caller identity changed"
    )
    fd = os.pidfd_open(owner["pid"])
    try:
        need(
            B["process_identity"](owner["pid"]) == owner,
            "caller changed before pidfd binding",
        )
        for sig in (signal.SIGTERM, signal.SIGKILL):
            closure_check()
            path = directory / (sig.name + ".intent.json")
            need(not path.exists(), "prior caller signal unresolved; observe only")
            save(
                path,
                {
                    "pid": owner["pid"],
                    "birth": owner["birth"],
                    "signal": sig.name,
                    "resources_release_verified": True,
                },
            )
            signal.pidfd_send_signal(fd, sig)
            poller = select.poll()
            poller.register(fd, select.POLLIN)
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if poller.poll(100):
                    return "EXITED_PIDFD_OBSERVED_NOT_OWNED_JOIN"
                need(
                    B["process_identity"](owner["pid"]) == owner,
                    "caller identity changed while pidfd live",
                )
        raise ValueError("original caller exit still unconfirmed")
    finally:
        os.close(fd)


def finalize(state, args, api_factory=api_for):
    out = Path(state["out"])
    lock = os.open(
        out / "payload-finalizer.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    cancelled = []
    handlers = {
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig))
        for sig in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        info = os.fstat(lock)
        need(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077,
            "private finalizer lock required",
        )
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate_args(state, args)
        complete = obj(out / "payload-borrow.complete.json")
        borrow_binding(state, complete)
        need(
            complete["status"] == "TRANSFER_ONLY_COMPLETE",
            "borrow transfer not complete",
        )
        journal = out / state.get("_resume", {}).get(
            "journal_name", "payload-finalization"
        )
        need(
            not journal.exists(),
            "prior finalizer exists: reconcile receipts, never relaunch effects",
        )
        journal.mkdir(mode=0o700)
        save(
            journal / "intent.json",
            {
                "first_borrow_operator_ref": state["first_borrow_operator_ref"],
                "finalizer_operator_ref": args.operator_ref,
                "identity_sha256": sha(
                    read(out / "payload-finalizer.identities.private.json")
                ),
                "original_deadline": state["deadline"],
                "pid": os.getpid(),
                "birth": R["birth"](os.getpid()),
                "operator_hashes": state.get("_resume", {}).get(
                    "operator_hashes", state.get("finalizer_operator_hashes")
                ),
                "resume_from": state.get("_resume", {}).get("prior_manifest_sha256"),
                "prior_journal_files": state.get("_resume", {}).get("files"),
            },
        )
        api = RecordedAPI(api_factory(state), state, journal)
        payload = {
            "machine": state["machine_id"],
            "source_ref": state["source_ref"],
            "epoch": state["epoch"],
            "identity_path": state["caller"]["identity_path"],
            "action": "PROBE",
        }
        attempt = 0
        probe = state.get("_resume", {}).get("joined_probe")
        while True:
            gone = validate_args(state, args)
            if probe is None or probe["state"] != "JOINED":
                attempt += 1
                try:
                    probe = R["machine_control"](api, state["machine_id"], payload)
                except (Exception, R["Deadline"]) as error:
                    if (
                        not isinstance(error, (OSError, R["Deadline"]))
                        and type(error).__name__ != "CaptureFailure"
                    ):
                        raise
                    save(
                        journal / f"read-pending-{attempt:06d}.json",
                        {"error": type(error).__name__, "write_retry": False},
                    )
                    time.sleep(5)
                    continue
                save(journal / f"probe-{attempt:06d}.json", probe)
            if (cancelled or time.time() >= state["deadline"]) and probe[
                "state"
            ] == "LIVE":
                term_once(api, state, payload, probe)
            if (
                gone
                and probe["state"] == "JOINED"
                and (out / "export/disposable-export.verified.json").exists()
            ):
                break
            time.sleep(5)
        export_sha = verified_export(state)
        closure = cleanup_closure(state, export_sha)
        path = out / "cleanup-call.intent.json"
        if state.get("_resume", {}).get("cleanup_credential_refusal"):
            need(obj(path) == closure, "original cleanup closure changed")
        else:
            need(
                not os.path.lexists(path),
                "prior cleanup invocation exists: observe exact release, never relaunch helper",
            )
            save(path, closure)
        validate_args(state, args)
        export = out / "export"
        command = cleanup_command(state)
        child_env = dict(os.environ, FLY_API_TOKEN=selected_token(state))
        save(
            journal / "cleanup.intent.json",
            {
                "argv": command,
                "gate_reap": "OBSERVED_ORIGINAL_PARENT_REAP",
                "gate_exit_code": None,
            },
        )
        with (journal / "cleanup.log").open("xb") as log:
            child = subprocess.Popen(
                command,
                cwd=state["source_root"],
                env=child_env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                birth = R["birth"](child.pid) if child.poll() is None else None
                save(journal / "cleanup.child.json", {"pid": child.pid, "birth": birth})
            finally:
                code = child.wait()
        save(journal / "cleanup.joined.json", {"exit_code": code, "owned_join": True})
        release = R["reconciled_release"](
            out,
            export,
            out / "authority.private.json",
            state["machine_id"],
            "cleanup",
            True,
            probe,
        )
        save(journal / "release.verified.json", release)
        validate_args(state, args)

        def closure_check():
            validate_args(state, args)
            need(
                verified_export(state) == export_sha,
                "export changed before caller signal",
            )
            need(
                R["reconciled_release"](
                    out,
                    export,
                    out / "authority.private.json",
                    state["machine_id"],
                    "cleanup",
                    True,
                    probe,
                )
                == release,
                "release changed before caller signal",
            )

        disposition = retire_caller(state, journal, closure_check)
        terminal = {
            "status": "CONTROLLER_RELEASE_VERIFIED",
            "machine": state["machine_id"],
            "source_ref": state["source_ref"],
            "started_at_epoch": state["epoch"],
            "original_deadline": state["deadline"],
            "gate_exit_code": None,
            "gate_reap": "OBSERVED_ORIGINAL_PARENT_REAP",
            "controller_cleanup_exit_code": code,
            "release": release,
            "benchmark_success_inferred": False,
            "finalizer_operator_ref": args.operator_ref,
        }
        need(
            not (out / "terminal.json").exists(),
            "original terminal already exists; do not overwrite",
        )
        save(out / "terminal.json", terminal)
        result = terminal | {
            "status": "CONTROLLER_RELEASE_VERIFIED_CALLER_RETIRED",
            "caller_disposition": disposition,
            "first_borrow_operator_ref": state["first_borrow_operator_ref"],
            "terminal_sha256": sha(read(out / "terminal.json")),
        }
        save(journal / "complete.json", result)
        return result
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        if cancelled:
            save(
                out / "payload-finalizer.cancelled.json",
                {"signals": cancelled, "no_effect_retry": True},
            )
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--capture", action="store_true", help="Local capture only.")
    modes.add_argument("--check", action="store_true", help="Local validation only.")
    modes.add_argument("--finalize", action="store_true", help="Observe and finalize.")
    modes.add_argument(
        "--resume-finalize",
        action="store_true",
        help="Resume a proven read-only finalizer journal.",
    )
    modes.add_argument(
        "--resume-cleanup",
        action="store_true",
        help="Continue only a proven pre-client credential refusal.",
    )
    parser.add_argument("--resume-journal", type=Path)
    parser.add_argument("--cleanup-refusal-journal", type=Path)
    parser.add_argument("--operator-ref", required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--run-directory", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    need(
        not (args.resume_journal and args.cleanup_refusal_journal),
        "select one exact prior journal",
    )
    need(
        not args.capture or not (args.resume_journal or args.cleanup_refusal_journal),
        "capture cannot resume a journal",
    )
    if args.capture:
        result = capture(
            args.config, args.config_sha256, args.run_directory, args.operator_ref
        )
    else:
        state = obj(args.run_directory / "payload-finalizer.identities.private.json")
        if args.cleanup_refusal_journal:
            need(
                args.check or args.resume_cleanup,
                "credential refusal requires check or resume-cleanup",
            )
            args.resume_journal = args.cleanup_refusal_journal
            state = prepare_resume(state, args, cleanup_refusal=True)
        elif args.resume_journal:
            need(
                args.check or args.resume_finalize,
                "resume journal requires check or resume-finalize",
            )
            state = prepare_resume(state, args)
        else:
            need(
                not (args.resume_finalize or args.resume_cleanup),
                "resume requires exact prior journal",
            )
        validate_args(state, args)
        result = (
            finalize(state, args)
            if args.finalize or args.resume_finalize or args.resume_cleanup
            else {
                "status": "CHECKED_PRECLIENT_CREDENTIAL_CONTINUATION"
                if args.cleanup_refusal_journal
                else (
                    "CHECKED_READ_ONLY_FINALIZER_RESUME"
                    if args.resume_journal
                    else "CHECKED_FINALIZER"
                ),
                "provider_calls": 0,
            }
        )
        if args.check and args.resume_journal:
            result.update(
                journal=str(args.run_directory / state["_resume"]["journal_name"]),
                prior_journal_sha256=state["_resume"]["prior_manifest_sha256"],
            )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
