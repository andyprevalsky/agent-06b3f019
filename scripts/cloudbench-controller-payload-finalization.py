#!/usr/bin/env python3
"""Capture original identities locally, then observe closure and finalize one borrower."""

import argparse
import base64
import fcntl
import hashlib
import json
import os
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


def operator(ref):
    names = (
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original600-runner.py",
        "run-original600-controller.py",
        "cloudbench-original-volume-capture.py",
    )
    hashes = {name: sha((HERE / name).read_bytes()) for name in names}
    return hashes, B["source_identity"](HERE.parent, ref, hashes)


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


def validate(state, config, digest, directory, ref):
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
    hashes, _ = operator(ref)
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
    return validate(
        state, args.config, args.config_sha256, args.run_directory, args.operator_ref
    )


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


def api_for(state):
    agents = state["authority"]["env_files"]["agents"]
    need(sha(read(agents["path"])) == agents["sha256"], "authority env changed")
    public = runpy.run_path(str(HERE / "run-original600-controller.py"))
    token = public["token_from_agents"](read(agents["path"]))
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
        return self.request(method, path, body, timeout)


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
        journal = out / "payload-finalization"
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
        while True:
            gone = validate_args(state, args)
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
        closure = {
            "machine": state["machine_id"],
            "action": "cleanup",
            "gate_joined": True,
            "supervisor_joined": True,
            "export_verified_file": export_sha,
        }
        path = out / "cleanup-call.intent.json"
        need(
            not path.exists(),
            "prior cleanup invocation exists: observe exact release, never relaunch helper",
        )
        save(path, closure)
        validate_args(state, args)
        export = out / "export"
        command = [
            sys.executable,
            "-S",
            str(
                Path(state["source_root"])
                / "scripts/cloudbench-disposable-controller.py"
            ),
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
                command, cwd=state["source_root"], stdout=log, stderr=subprocess.STDOUT
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
    parser.add_argument("--operator-ref", required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--run-directory", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.capture:
        result = capture(
            args.config, args.config_sha256, args.run_directory, args.operator_ref
        )
    else:
        state = obj(args.run_directory / "payload-finalizer.identities.private.json")
        validate_args(state, args)
        result = (
            finalize(state, args)
            if args.finalize
            else {"status": "CHECKED_FINALIZER", "provider_calls": 0}
        )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
