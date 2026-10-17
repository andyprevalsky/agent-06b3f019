#!/usr/bin/env python3
"""Local relay custody and pidfd controls; no provider calls."""

import base64
import gzip
import hashlib
import json
import os
import runpy
import shlex
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-controller-relay-retire.py"))


class Relay(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cb-relay-")
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.custody = self.root / "custody"
        (self.custody / "registered-orphan-drain").mkdir(parents=True)
        p = self.root / "guest.py"
        p.write_text(M["GUEST"])
        self.ns = runpy.run_path(str(p))["execute"].__globals__
        self.uid = os.geteuid()
        self.ns["ROSE_UID"] = self.uid
        self.ns["PARENT_PID"] = 99999991
        self.child = subprocess.Popen(
            [
                "bash",
                "-c",
                "trap 'exit 0' TERM; while :; do read -r -t .05 x || true; done",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=self.repo,
        )
        for _ in range(200):
            try:
                self.identity = self.ns["process"](self.child.pid)
                break
            except ValueError:
                time.sleep(0.005)
        else:
            self.fail("child did not arm TERM")
        self.expected = {
            "pid": self.child.pid,
            "birth": self.identity["birth"],
            "uid": self.uid,
            "agent": {"pid": 99999992, "birth": "retired"},
            "process": {k: v for k, v in self.identity.items() if k != "argv"},
        }
        self.value = {
            "action": "signal",
            "identity_sha256": "a" * 64,
            "operator_ref": "b" * 40,
            "launch_sha256": "c" * 64,
        }
        self.ns["prerequisites"] = lambda _v: (self.repo, self.repo, self.custody, {})

    def tearDown(self):
        if self.child.poll() is None:
            self.child.terminate()
        self.child.wait(timeout=3)
        self.tmp.cleanup()

    def test_exact_pidfd_term_once_and_readonly_observe(self):
        self.ns["relay_state"] = lambda *_a: self.expected
        result = self.ns["execute"](self.value)
        self.assertEqual(result["status"], "BOOTSTRAP_EXIT_OBSERVED")
        self.child.wait(timeout=3)
        with self.assertRaisesRegex(ValueError, "already attempted"):
            self.ns["execute"](self.value)
        with patch.object(
            signal, "pidfd_send_signal", side_effect=AssertionError("observe signaled")
        ):
            result = self.ns["execute"](dict(self.value, action="observe"))
        self.assertTrue(result["no_signal"])
        self.assertEqual(result["status"], "BOOTSTRAP_EXIT_OBSERVED")

    def test_unknown_signal_intent_is_not_replayed(self):
        self.ns["relay_state"] = lambda *_a: self.expected
        with (
            patch.object(signal, "pidfd_send_signal", side_effect=OSError("uncertain")),
            self.assertRaisesRegex(OSError, "uncertain"),
        ):
            self.ns["execute"](self.value)
        self.assertIsNone(self.child.poll())
        with self.assertRaisesRegex(ValueError, "already attempted"):
            self.ns["execute"](self.value)
        observed = self.ns["execute"](dict(self.value, action="observe"))
        self.assertEqual(observed["status"], "INTENT_PRESENT_NO_REPLAY")
        self.assertIsNone(observed["result"])

    def test_result_write_failure_never_resignals(self):
        self.ns["relay_state"] = lambda *_a: self.expected
        original = self.ns["save"]

        def fail_result(p, v):
            if p.name == "result.json":
                raise OSError("result storage failed")
            original(p, v)

        self.ns["save"] = fail_result
        with self.assertRaisesRegex(OSError, "storage failed"):
            self.ns["execute"](self.value)
        self.child.wait(timeout=3)
        with patch.object(
            signal, "pidfd_send_signal", side_effect=AssertionError("replayed")
        ):
            with self.assertRaisesRegex(ValueError, "already attempted"):
                self.ns["execute"](self.value)
            observed = self.ns["execute"](dict(self.value, action="observe"))
        self.assertEqual(observed["status"], "BOOTSTRAP_EXIT_OBSERVED")
        self.assertIsNone(observed["result"])

    def test_custody_requires_dead_routes_and_matching_raw_authority(self):
        source = b"immutable relay"

        def digest(b):
            return hashlib.sha256(b).hexdigest()

        campaign = self.repo / ".context/benchmarks/campaigns/exact"
        campaign.mkdir(parents=True)
        auth = {
            "schema": "shared-relay-authority-v1",
            "app": "navi-whisper-lux-bench",
            "parent_pid": 99999991,
            "parent_start": "oldparent",
            "source_sha256": digest(source),
            "inventory_directory": str(campaign / "shared-inventory"),
            "agent_socket": str(self.root / "fly-agent.sock"),
        }

        def write(p, v):
            p.write_text(json.dumps(v))
            p.chmod(0o600)

        write(self.root / "authority.private.json", auth)
        ah = digest((self.root / "authority.private.json").read_bytes())
        write(
            self.root / "bootstrap-owner.json",
            {
                "pid": 99999993,
                "birth": "oldbootstrap",
                "parent_pid": auth["parent_pid"],
                "parent_start": auth["parent_start"],
            },
        )
        write(
            self.root / "broker-owner.json",
            {
                "pid": 99999994,
                "birth": "oldbroker",
                "parent_pid": auth["parent_pid"],
                "parent_start": auth["parent_start"],
            },
        )
        ready = {
            "pid": 99999994,
            "birth": "oldbroker",
            "authority_sha256": ah,
            "socket": str(self.root / "control.sock"),
            "agent": {"pid": 99999992, "birth": "oldagent"},
        }
        write(self.root / "ready.json", ready)
        write(
            self.root / "serve.once.json",
            {k: ready[k] for k in ("pid", "birth", "authority_sha256")},
        )
        write(campaign / "shared-relay-location.json", {"directory": str(self.root)})
        leases = self.root / "leases"
        leases.mkdir()
        lease = leases / ("d" * 32 + ".json")
        row = {
            "lease": "d" * 32,
            "authority_sha256": ah,
            "owner_pid": 99999995,
            "owner_start": "oldroute",
        }
        write(lease, row)
        value = {
            "relay_directory": str(self.root),
            "source_ref": "e" * 40,
            "relay_source_sha256": digest(source),
            "joined": {"terminal": {"parent_birth": "oldparent"}},
        }
        with patch.object(subprocess, "check_output", return_value=source):
            checked = self.ns["relay_state"](value, self.repo, self.custody)
            self.assertNotIn("process", checked)
            for name, item in checked["evidence"].items():
                raw = base64.b64decode(item["body_b64"], validate=True)
                self.assertEqual(len(raw), item["bytes"])
                self.assertEqual(
                    hashlib.sha256(raw).hexdigest(), checked["records"][name]
                )
            self.assertEqual(len(checked["evidence"]), 7)
            row.update(owner_pid=self.child.pid, owner_start=self.identity["birth"])
            write(lease, row)
            with self.assertRaisesRegex(ValueError, "route owner remains live"):
                self.ns["relay_state"](value, self.repo, self.custody)
            row.update(
                owner_pid=99999995, owner_start="oldroute", authority_sha256="wrong"
            )
            write(lease, row)
            with self.assertRaisesRegex(ValueError, "invalid relay route owner"):
                self.ns["relay_state"](value, self.repo, self.custody)
            row["authority_sha256"] = ah
            write(lease, row)
            lease.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "public relay evidence"):
                self.ns["relay_state"](value, self.repo, self.custody)

    def test_process_uid_and_guest_command_are_bound(self):
        with self.assertRaisesRegex(ValueError, "UID differs"):
            self.ns["process"](self.child.pid, self.uid + 1)
        body = M["command"](self.value)
        self.assertLessEqual(len(json.dumps(body).encode()), 16384)
        source, value = json.loads(
            gzip.decompress(base64.b64decode(shlex.split(body["cmd"])[-1]))
        )
        self.assertEqual(source, M["GUEST"])
        self.assertEqual(value, self.value)


if __name__ == "__main__":
    unittest.main()
