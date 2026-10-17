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
