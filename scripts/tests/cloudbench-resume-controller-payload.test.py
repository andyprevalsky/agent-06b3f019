#!/usr/bin/env python3
"""Offline transfer borrower boundaries; no native API or credential refresh."""

import base64
import fcntl
import json
import os
import runpy
import shlex
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-resume-controller-payload.py"))
R = M["R"]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    path.chmod(0o600)
    return path


class Borrower(unittest.TestCase):
    def test_canonical_gate_private_self_copy_is_bound_to_original_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            host_gate = root / "run-cloudbench-controller-gate"
            host_gate.write_bytes(b"#!/bin/bash\nexit 0\n")
            snapshot = root / "cloudbench-gate-self.8n7mHA"
            snapshot.write_bytes(host_gate.read_bytes())
            snapshot.chmod(0o600)
            authority = root / "authority.private.json"
            gate = {
                "cwd": str(root),
                "argv": [
                    "bash",
                    str(snapshot),
                    "--disposable-controller",
                    str(authority),
                    "--",
                    "true",
                ],
            }
            digest = R["sha"](host_gate.read_bytes())
            pins = M["gate_program_identity"](gate, host_gate, root, authority, digest)
            self.assertEqual(pins, {str(snapshot): M["fingerprint"](snapshot)})
            direct = dict(gate, argv=["bash", str(host_gate), *gate["argv"][2:]])
            self.assertIn(
                str(host_gate),
                M["gate_program_identity"](direct, host_gate, root, authority, digest),
            )
            snapshot.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                M["gate_program_identity"](gate, host_gate, root, authority, digest)

    def test_gate_self_copy_refuses_unsafe_path_mode_or_authority(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            host_gate = root / "run-cloudbench-controller-gate"
            host_gate.write_bytes(b"original")
            snapshot = root / "cloudbench-gate-self.Abc123"
            snapshot.write_bytes(host_gate.read_bytes())
            authority = root / "authority.private.json"
            gate = {
                "cwd": str(root),
                "argv": [
                    "bash",
                    str(snapshot),
                    "--disposable-controller",
                    str(authority),
                    "--",
                    "true",
                ],
            }
            digest = R["sha"](host_gate.read_bytes())
            snapshot.chmod(0o644)
            with self.assertRaises(ValueError):
                M["gate_program_identity"](gate, host_gate, root, authority, digest)
            snapshot.chmod(0o600)
            gate["argv"][3] = str(root / "foreign-authority")
            with self.assertRaises(ValueError):
                M["gate_program_identity"](gate, host_gate, root, authority, digest)
            gate["argv"][3] = str(authority)
            snapshot.unlink()
            snapshot.symlink_to(host_gate)
            with self.assertRaises(ValueError):
                M["gate_program_identity"](gate, host_gate, root, authority, digest)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / "run"
        self.out.mkdir(mode=0o700)
        self.env = self.root / "agents.env"
        self.env.write_text("FLY_API_TOKEN=fixture-literal\n")
        self.env.chmod(0o600)
        self.state = {
            "operator_ref": "7" * 40,
            "operator_hashes": {"fixture": "8" * 64},
            "out": self.out,
            "config_sha256": "1" * 64,
            "machine_id": "a" * 14,
            "machine": {"instance_id": "original-instance"},
            "envelope_sha256": "2" * 64,
            "caller": {"pid": os.getpid(), "birth": R["birth"](os.getpid())},
            "epoch": time.time() - 10,
            "deadline": time.time() + 100,
            "authority": {
                "env_files": {
                    "agents": {
                        "path": str(self.env),
                        "sha256": R["sha"](self.env.read_bytes()),
                    }
                }
            },
            "old_recovery": {"rejection_wire_sha256": "3" * 64},
        }

    def test_transfer_unwind_requires_exact_caller_pipe_and_pending_print(self):
        base = self.root / "base"
        out = base / "admission" / "launch" / "run"
        out.mkdir(parents=True)
        wrapper = base / "wrapper.py"
        wrapper.write_bytes(b"known tee wrapper")
        wrapper.chmod(0o600)
        config = out.parent / "config.private.json"
        owner = {
            "pid": 11,
            "birth": "caller-birth",
            "cwd": str(base),
            "argv": ["python3", "caller.py"],
        }
        parent = {
            "pid": 12,
            "birth": "parent-birth",
            "cwd": str(base),
            "argv": ["python3", str(wrapper)],
        }
        state = {
            "out": out,
            "config": str(config),
            "source_ref": "a" * 40,
            "host_ref": "b" * 40,
            "epoch": time.time() - 10,
            "caller": {"pid": 11, "birth": "caller-birth", "gate_pid": 13},
            "pins": {},
        }
        first = {
            "status": "CONTINUING_ORIGINAL_ADMISSION",
            "admission_directory": str(out.parent.parent),
            "source_ref": state["source_ref"],
            "host_operator_source_ref": state["host_ref"],
            "config_path": str(config),
            "run_directory": str(out),
        }
        pending = {
            "status": "PENDING_EXTERNAL_OWNER_LIVE",
            "error": "Deadline",
            "gate_pid": 13,
            "no_gate_or_vm_kill": True,
        }
        log = base / "stream.log"
        log.write_text(json.dumps(first) + "\n" + json.dumps(pending) + "\n")
        log.chmod(0o600)

        def captured(value):
            return {key: value[key] for key in ("pid", "birth", "cwd")} | {
                "cmdline_sha256": R["sha"](
                    b"\0".join(os.fsencode(arg) for arg in value["argv"]) + b"\0"
                )
            }

        proof = {
            "observed_epoch": time.time(),
            "caller": captured(owner) | {"ppid": 12},
            "parent": captured(parent),
            "caller_fd1": "pipe:[123]",
            "parent_matching_fds": {"3": str(log), "4": "pipe:[123]"},
            "log_path": str(log),
            "log_sha256": R["sha"](log.read_bytes()),
            "wrapper_path": str(wrapper),
            "wrapper_sha256": R["sha"](wrapper.read_bytes()),
        }
        receipt = write(out / "payload-transfer.interruption.json", proof)
        globals_ = M["transfer_unwound"].__globals__
        links = {
            "/proc/11/fd/1": "pipe:[123]",
            "/proc/12/fd/3": str(log),
            "/proc/12/fd/4": "pipe:[123]",
        }
        with (
            mock.patch.dict(
                globals_,
                process_identity=lambda pid: {11: owner, 12: parent}[pid],
                parent_pid=lambda pid: 12,
            ),
            mock.patch.object(
                os, "readlink", side_effect=lambda path: links[str(path)]
            ),
        ):
            result = M["transfer_unwound"](state)
            self.assertEqual(result["receipt_sha256"], R["sha"](receipt.read_bytes()))
            self.assertIn(str(log), state["pins"])
            links["/proc/12/fd/4"] = "pipe:[999]"
            with self.assertRaises(ValueError):
                M["transfer_unwound"](state)
            links["/proc/12/fd/4"] = "pipe:[123]"
            pending["gate_pid"] = 99
            log.write_text(json.dumps(first) + "\n" + json.dumps(pending) + "\n")
            proof["log_sha256"] = R["sha"](log.read_bytes())
            write(receipt, proof)
            with self.assertRaises(ValueError):
                M["transfer_unwound"](state)

    def test_acknowledged_writes_allow_only_final_incomplete_identity_get(self):
        state = dict(self.state, host=ROOT, source_ref="a" * 40, pins={})
        state["machine"] = {
            "id": state["machine_id"],
            "instance_id": "original-instance",
            "config": {},
        }
        data = b"actual fixture sidecar bytes"
        digest = R["sha"](data)
        sidecar = self.out / "sidecar.gz"
        sidecar.write_bytes(data)
        sidecar.chmod(0o600)
        write(
            self.out / "controller-sidecars.private.json",
            [{"path": str(sidecar), "sha256": digest, "bytes": len(data)}],
        )
        directory = self.out / "payload-transfer"
        directory.mkdir(mode=0o700)
        payload = {
            "machine": state["machine_id"],
            "source_ref": state["source_ref"],
            "envelope_sha256": state["envelope_sha256"],
            "sha256": digest,
            "action": "fragment",
            "index": 0,
            "offset": 0,
            "data": base64.b64encode(data).decode(),
        }
        command = R["sidecar_command"](payload)
        wanted = {
            "state": "FRAGMENT",
            "index": 0,
            "offset": 0,
            "bytes": len(data),
            "sha256": digest,
        }
        response = {
            "exit_code": 0,
            "exit_signal": 0,
            "stderr": "",
            "stdout": json.dumps(wanted),
        }
        request = {
            "method": "POST",
            "path": "/machines/" + state["machine_id"] + "/exec",
            "body": {"cmd": command, "timeout": 20, "machine": True},
        }
        raw = json.dumps(response).encode()
        write(directory / "0001-write.request.json", request)
        write(
            directory / "0001-write.wire.json",
            {
                "method": "POST",
                "path": request["path"],
                "status": 200,
                "sha256": R["sha"](raw),
                "body_b64": base64.b64encode(raw).decode(),
            },
        )
        write(directory / "0001-write.response.json", response)
        label = digest + "-00000-00000"
        write(
            directory / (label + ".intent.json"),
            {
                "machine": state["machine_id"],
                "instance": "original-instance",
                "request_sha256": R["sha"](command.encode()),
                "expected": wanted,
            },
        )
        write(directory / (label + ".response.json"), response)
        write(
            directory / "0002-identity.request.json",
            {"method": "GET", "path": "/machines/" + state["machine_id"], "body": None},
        )
        with self.assertRaises(ValueError):
            M["old_rejection"](
                state
            )  # Same positive history was not previously eligible.
        with self.assertRaises(FileNotFoundError):
            M["acknowledged_read_timeout"](state)
        with mock.patch.dict(
            M["acknowledged_read_timeout"].__globals__,
            transfer_unwound=lambda state: {"fixture": "unwound"},
        ):
            result = M["acknowledged_read_timeout"](state)
            self.assertEqual(result["acknowledged_writes"], 1)
            self.assertIn(str(directory), state["pins"])
            # Unknown write, unaccounted effect, and wrong ACK never permit borrowing.
            for name, value in [
                ("0003-write.request.json", request),
                (label + ".pending.json", {"unknown": True}),
                ("0002-identity.wire.json", {"status": 499}),
            ]:
                path = write(directory / name, value)
                with self.assertRaises((ValueError, OSError)):
                    M["acknowledged_read_timeout"](state)
                path.unlink()
            bad = dict(wanted, sha256="0" * 64)
            altered = dict(response, stdout=json.dumps(bad))
            write(directory / "0001-write.response.json", altered)
            with self.assertRaises(ValueError):
                M["acknowledged_read_timeout"](state)

    def test_one_borrow_closes_without_replay_or_cleanup_claim(self):
        calls = []

        def transfer(api, mid, machine, out, envelope, deadline, cancelled, *, journal):
            self.assertFalse(journal.exists())
            self.assertFalse(cancelled())
            self.assertEqual(deadline, self.state["deadline"])
            journal.mkdir(mode=0o700)
            R["save"](journal / "complete.json", {"envelope_sha256": envelope})
            calls.append(mid)

        with (
            mock.patch.dict(
                M["execute"].__globals__, owner_unchanged=lambda state: True
            ),
            mock.patch.dict(R, transfer_sidecars=transfer),
        ):

            def factory(app, token):
                return app, token

            first = M["execute"](self.state, factory)
            second = M["execute"](self.state, factory)
        self.assertEqual(first, second)
        self.assertEqual(calls, ["a" * 14])
        self.assertEqual(first["status"], "TRANSFER_ONLY_COMPLETE")
        self.assertFalse(first["cleanup_complete"])
        self.assertFalse(first["benchmark_success_inferred"])
        self.assertTrue(first["original_owner_retained"])

    def test_unknown_borrow_never_gets_new_journal_or_second_transfer(self):
        calls = []

        def fail(*args, **kwargs):
            calls.append(1)
            raise TimeoutError("unknown write")

        with (
            mock.patch.dict(
                M["execute"].__globals__, owner_unchanged=lambda state: True
            ),
            mock.patch.dict(R, transfer_sidecars=fail),
        ):
            with self.assertRaises(TimeoutError):
                M["execute"](self.state, lambda *args: None)
            before = (self.out / "payload-borrow.intent.json").read_bytes()
            with self.assertRaises(ValueError):
                M["execute"](self.state, lambda *args: None)
        self.assertEqual(calls, [1])
        self.assertEqual(before, (self.out / "payload-borrow.intent.json").read_bytes())

    def test_single_borrower_lock_and_changed_owner_fail_before_dispatch(self):
        lock = os.open(self.out / "payload-borrow.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                M["execute"](
                    self.state, lambda *args: self.fail("native factory called")
                )
        finally:
            os.close(lock)
        with (
            mock.patch.dict(
                M["execute"].__globals__, owner_unchanged=lambda state: False
            ),
            self.assertRaises(ValueError),
        ):
            M["execute"](self.state, lambda *args: self.fail("native factory called"))
        self.assertFalse((self.out / "payload-borrow.intent.json").exists())

    def rejection_fixture(self):
        host = self.root / "host"
        (host / "scripts").mkdir(parents=True)
        (host / "scripts/cloudbench-original600-runner.py").write_text(
            'REMOTE_SIDECAR="fixture-old-source"\n'
        )
        sidecar = self.out / "sidecar.gz"
        sidecar.write_bytes(b"actual-first-chunk" * 3000)
        sidecar.chmod(0o600)
        transfer_sha = R["sha"](sidecar.read_bytes())
        write(
            self.out / "controller-sidecars.private.json",
            [{"sha256": transfer_sha, "path": str(sidecar)}],
        )
        state = dict(self.state, host=str(host), source_ref="b" * 40)
        base = {
            "machine": state["machine_id"],
            "source_ref": state["source_ref"],
            "envelope_sha256": state["envelope_sha256"],
            "sha256": transfer_sha,
            "index": 0,
        }
        journal = self.out / "payload-transfer"
        journal.mkdir(mode=0o700)
        for prefix, payload, result in [
            (
                "0010-write",
                dict(
                    base,
                    action="chunk",
                    data=base64.b64encode(sidecar.read_bytes()[:32768]).decode(),
                ),
                {
                    "stdout": "",
                    "stderr": "Unhandled rejection: Rejection([PayloadTooLarge, MethodNotAllowed])",
                    "exit_code": 0,
                },
            ),
            (
                "0012-observe",
                dict(base, action="observe-chunk"),
                {
                    "stdout": "",
                    "stderr": "FileNotFoundError: /tmp/controller-sidecar-"
                    + transfer_sha,
                    "exit_code": 1,
                },
            ),
        ]:
            command = shlex.join(
                [
                    "python3",
                    "-c",
                    "fixture-old-source",
                    base64.b64encode(json.dumps(payload).encode()).decode(),
                ]
            )
            write(
                journal / (prefix + ".request.json"),
                {
                    "method": "POST",
                    "path": "/machines/" + state["machine_id"] + "/exec",
                    "body": {"cmd": command},
                },
            )
            raw = json.dumps(result).encode()
            write(
                journal / (prefix + ".wire.json"),
                {
                    "method": "POST",
                    "path": "/machines/" + state["machine_id"] + "/exec",
                    "status": 200,
                    "body_b64": base64.b64encode(raw).decode(),
                    "sha256": R["sha"](raw),
                },
            )
            write(journal / (prefix + ".response.json"), result)
        return state

    def test_raw_nested200_rejection_and_later_absence_are_required(self):
        state = self.rejection_fixture()
        proof = M["old_rejection"](state)
        self.assertEqual(
            set(proof),
            {"failed_request_sha256", "rejection_wire_sha256", "absence_wire_sha256"},
        )
        path = self.out / "payload-transfer/0010-write.wire.json"
        value = json.loads(path.read_bytes())
        value["sha256"] = "f" * 64
        write(path, value)
        with self.assertRaises(ValueError):
            M["old_rejection"](state)

    def test_absence_alone_never_authorizes_unknown_oldwrite(self):
        state = self.rejection_fixture()
        path = self.out / "payload-transfer/0010-write.response.json"
        value = json.loads(path.read_bytes())
        value["stderr"] = "unknown transport timeout"
        write(path, value)
        raw = json.dumps(value).encode()
        wire = self.out / "payload-transfer/0010-write.wire.json"
        record = json.loads(wire.read_bytes())
        record.update(body_b64=base64.b64encode(raw).decode(), sha256=R["sha"](raw))
        write(wire, record)
        with self.assertRaises(ValueError):
            M["old_rejection"](state)

    def test_exact_git_source_and_pure_help_or_bad_config(self):
        repo = self.root / "repo"
        (repo / "scripts").mkdir(parents=True)
        path = repo / "scripts/source.py"
        path.write_text("original-source\n")
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        ref = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
        ).strip()
        pins = {"source.py": R["sha"](path.read_bytes())}
        self.assertIn(str(path), M["source_identity"](repo, ref, pins))
        path.write_text("modified-source\n")
        with self.assertRaises(ValueError):
            M["source_identity"](repo, ref, pins)
        config = write(self.root / "config.json", {})
        with self.assertRaises(ValueError):
            M["check"](config, "0" * 64, self.out, "0" * 40)
        subprocess.run(
            [
                "python3",
                "-S",
                str(ROOT / "scripts/cloudbench-resume-controller-payload.py"),
                "--help",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        self.assertFalse((self.out / "payload-borrow.intent.json").exists())


if __name__ == "__main__":
    unittest.main()
