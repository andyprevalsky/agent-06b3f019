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
from types import SimpleNamespace
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
        for public in (
            self.root / "bootstrap-owner.json",
            self.root / "broker-owner.json",
            campaign / "shared-relay-location.json",
        ):
            public.chmod(0o644)
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
            public = self.root / "bootstrap-owner.json"
            public.chmod(0o664)
            with self.assertRaisesRegex(ValueError, "public relay evidence"):
                self.ns["relay_state"](value, self.repo, self.custody)
            public.chmod(0o644)
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

    def test_exact_presignal_refusal_and_closed_namespace(self):
        old = self.root / "registered-orphan-drain/relay-bootstrap"
        old.mkdir(parents=True)
        args = SimpleNamespace(
            pre_signal_refusal_journal=old,
            relay_directory=Path("/tmp/cb-relay-iw84qnlh"),
            operator_ref="f" * 40,
        )
        state = {
            "out": str(self.root),
            "source_root": str(ROOT),
            "source_ref": M["OLD_OPERATOR"],
            "machine_id": "84ed412b11d168",
            "epoch": 1,
            "deadline": 2,
            "machine": {
                "id": "84ed412b11d168",
                "instance_id": "original",
                "config": {},
                "name": "controller",
                "region": "iad",
            },
            "_drain": {
                "joined": {},
                "launch_sha256": "a" * 64,
                "joined_files": {},
                "joined_journal": "exact",
                "pending_path": "pending",
                "pending_sha256": "b" * 64,
            },
        }
        payload = M["make_payload"](args, state)
        payload["operator_ref"] = M["OLD_OPERATOR"]
        payload.pop("identity_sha256")
        payload["identity_sha256"] = M["sha"](
            json.dumps(payload, sort_keys=True).encode()
        )
        pins = {
            str(ROOT / "scripts/cloudbench-controller-relay-retire.py"): (1, 2, 3, 4, 5)
        }

        def put(name, value):
            p = old / name
            p.write_text(json.dumps(value, sort_keys=True))
            p.chmod(0o600)

        put(
            "intent.json",
            {
                "payload": payload,
                "operator": state["_drain"],
                "relay_source_pins": pins,
            },
        )
        historical = subprocess.check_output(
            [
                "git",
                "-C",
                str(ROOT),
                "show",
                M["OLD_OPERATOR"] + ":scripts/cloudbench-controller-relay-retire.py",
            ]
        )
        original_drain = subprocess.check_output(
            [
                "git",
                "-C",
                str(ROOT),
                "show",
                M["OLD_OPERATOR"] + ":scripts/cloudbench-controller-orphan-drain.py",
            ]
        )
        import ast

        def literal(raw, name):
            return ast.literal_eval(
                next(
                    n.value
                    for n in ast.parse(raw).body
                    if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)
                )
            )

        guest = literal(original_drain, "GUEST") + literal(historical, "RELAY")
        package = base64.b64encode(
            gzip.compress(
                json.dumps([guest, dict(payload, action="signal")]).encode(), mtime=0
            )
        ).decode()
        loader = "import base64,gzip,json,sys;s,v=json.loads(gzip.decompress(base64.b64decode(sys.argv[1])));exec(s);print(json.dumps(execute(v),sort_keys=True))"
        body = {
            "cmd": shlex.join(["python3", "-S", "-c", loader, package]),
            "timeout": 18,
            "machine": True,
        }
        refusal = {
            "exit_code": 1,
            "exit_signal": 0,
            "stdout": "",
            "stderr": M["REFUSAL_STDERR"],
        }
        for i, method, path, request_body, result in (
            (1, "GET", "/machines/" + state["machine_id"], None, state["machine"]),
            (2, "POST", "/machines/" + state["machine_id"] + "/exec", body, refusal),
        ):
            put(
                f"wire-{i:06d}.request.json",
                {"method": method, "path": path, "body": request_body},
            )
            raw = json.dumps(result).encode()
            put(
                f"wire-{i:06d}.raw.json",
                {
                    "method": method,
                    "path": path,
                    "status": 200,
                    "body_b64": base64.b64encode(raw).decode(),
                    "bytes": len(raw),
                    "sha256": M["sha"](raw),
                },
            )
            put(f"wire-{i:06d}.decoded.json", result)
        with patch.dict(M["B"], {"source_identity": lambda *_a: pins}):
            proof = M["validate_refusal"](args, state)
            self.assertEqual(len(proof["files"]), 7)
            self.assertEqual(proof["source_pins"], json.loads(json.dumps(pins)))
            changed_pins = {
                path: (*value[:-1], value[-1] + 1) for path, value in pins.items()
            }
            with patch.dict(M["B"], {"source_identity": lambda *_a: changed_pins}):
                with self.assertRaisesRegex(ValueError, "fingerprint differs"):
                    M["validate_refusal"](args, state)
            self.assertEqual(
                proof["prior_journal_sha256"],
                M["sha"](
                    json.dumps(
                        proof["files"],
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode()
                ),
            )
            put("unexpected.json", {})
            with self.assertRaisesRegex(ValueError, "membership"):
                M["validate_refusal"](args, state)
            (old / "unexpected.json").unlink()
            put("wire-000002.decoded.json", dict(refusal, stderr="different failure"))
            with self.assertRaisesRegex(ValueError, "raw response differs"):
                M["validate_refusal"](args, state)
            put("wire-000002.decoded.json", refusal)
            put("pre-signal-successor.json", {})
            self.assertEqual(
                M["validate_refusal"](args, state)["files"], proof["files"]
            )
            pointer = M["successor_value"](
                proof,
                old.parent
                / ("relay-bootstrap-pre-signal-" + proof["prior_journal_sha256"]),
                M["make_payload"](args, state),
                "c" * 64,
            )
            self.assertEqual(pointer["schema"], "relay-pre-signal-successor-v1")

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
