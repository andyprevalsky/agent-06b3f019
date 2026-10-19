#!/usr/bin/env python3
"""Local positive startup/export proof and cleanup ownership controls; no provider."""

import io
import json
import os
import runpy
import signal
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-startup-finalization.py"))


class Startup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.export = self.out / "export"
        self.export.mkdir()
        self.caller = {
            "gate_pid": 12345,
            "gate_birth": "exactgate",
            "identity_path": "/tmp/gate/repo/.context/original600-supervisor."
            + "a" * 24
            + ".json",
        }
        self.state = {
            "out": str(self.out),
            "machine_id": "8349d1c7914048",
            "caller": self.caller,
            "source_root": str(ROOT),
            "config_sha256": "c" * 64,
            "epoch": 1,
            "deadline": 5401,
            "source_hashes": {
                "cloudbench-original600-runner.py": M["sha"](
                    (ROOT / "scripts/cloudbench-original600-runner.py").read_bytes()
                )
            },
        }
        self.state.update(
            config_path="exact-config",
            source_pins={},
            operator_ref="f" * 40,
            operator_pins={},
        )
        self.put(self.out / "threshold-owner.identity.private.json", {})
        self.put(self.out / "caller.json", self.caller)
        self.put(self.out / "authority.private.json", {"source_ref": M["SOURCE"]})
        self.record = {
            "source_ref": M["SOURCE"],
            "machine_id": self.state["machine_id"],
            "app": "navi-whisper-lux-bench",
            "image": "immutable",
            "caller": {"pid": 12345, "birth": "exactgate"},
            "collector_sha256": M["sha"](
                (ROOT / "scripts/cloudbench-controller-export.py").read_bytes()
            ),
        }
        self.put(self.export / "launch.json", self.record)
        self.put(self.export / "caller.json", self.record["caller"])
        (self.out / "gate.private.log").write_text(
            "GATE_EXPORT exit=0\nGATE_EXPORT_VERIFIED machine="
            + self.state["machine_id"]
            + " directory="
            + str(self.export)
            + " resource_release_verified=false\n"
        )
        (self.out / "gate.private.log").chmod(0o600)
        remote = self.out / "remote-gate.private.log"
        remote.write_text(
            "timestamp app[" + self.state["machine_id"] + "] GATE_EXPORT exit=0\n"
        )
        remote.chmod(0o600)
        self.state["remote_gate_log_path"] = str(remote)
        self.build()

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, p, v):
        p.write_text(json.dumps(v, sort_keys=True))
        p.chmod(0o600)

    def build(self, extra=None, step=None):
        payload = {"controller-output/step-1.log": M["STEP"] if step is None else step}
        payload.update(extra or {})
        with tarfile.open(self.export / "originals.tar.gz", "w:gz") as t:
            for name, raw in payload.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                t.addfile(info, io.BytesIO(raw))
        (self.export / "originals.tar.gz").chmod(0o600)
        manifest = {
            "version": 1,
            "resource_release_verified": False,
            "record": self.record,
            "archive_sha256": M["sha"]((self.export / "originals.tar.gz").read_bytes()),
            "files": {
                n: {"kind": "file", "bytes": len(raw), "sha256": M["sha"](raw)}
                for n, raw in payload.items()
            },
            "excluded": {},
        }
        self.put(self.export / "manifest.json", manifest)
        self.put(
            self.export / "disposable-export.verified.json",
            {
                "authority_sha256": M["sha"](
                    (self.out / "authority.private.json").read_bytes()
                ),
                "machine_id": self.state["machine_id"],
                "files": {
                    n: M["sha"]((self.export / n).read_bytes())
                    for n in (
                        "originals.tar.gz",
                        "manifest.json",
                        "launch.json",
                        "caller.json",
                    )
                },
            },
        )

    def test_full_canonical_archive_and_truthful_absence(self):
        proof = M["archive_proof"](self.state)
        self.assertFalse(proof["supervisor_published"])
        self.assertFalse(proof["supervisor_joined"])
        self.assertEqual(proof["step1_sha256"], M["sha"](M["STEP"]))
        self.build({"context/" + Path(self.caller["identity_path"]).name: b"{}"})
        with self.assertRaisesRegex(ValueError, "runtime publication"):
            M["archive_proof"](self.state)

    def test_unknown_failure_and_mutated_export_rejected(self):
        self.build(step=b"unknown crash")
        with self.assertRaisesRegex(ValueError, "failure record differs"):
            M["archive_proof"](self.state)
        self.build()
        p = self.export / "originals.tar.gz"
        p.write_bytes(p.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "export bytes changed"):
            M["archive_proof"](self.state)

    def test_release_requires_truthful_failure_closure(self):
        self.state["source_pins"] = {"/exact/source": (1, 2, 3, 4, 5)}
        proof = M["archive_proof"](self.state)
        self.assertEqual(proof["source_pins"]["/exact/source"], [1, 2, 3, 4, 5])
        proof_path = self.out / "failure-proof.json"
        self.put(proof_path, proof)
        self.put(
            self.out / "cleanup-call.intent.json",
            {
                "failure_proof_sha256": M["sha"](proof_path.read_bytes()),
                "failure_proof_path": str(proof_path),
                "supervisor_published": False,
                "supervisor_joined": False,
                "gate_joined": True,
            },
        )
        self.put(
            self.export / "workspace-volume.ownership.json", {"volume_id": "vol_exact"}
        )
        self.put(
            self.export / "disposable-controller.release.json",
            {
                "machine_id": self.state["machine_id"],
                "volume_id": "vol_exact",
                "machine_deleted": True,
                "volume_disposition": "ABSENT",
            },
        )
        self.assertTrue(M["release_check"](self.state, proof)["machine_deleted"])
        closure = M["obj"](self.out / "cleanup-call.intent.json")
        closure["supervisor_joined"] = True
        self.put(self.out / "cleanup-call.intent.json", closure)
        with self.assertRaisesRegex(ValueError, "startup closure differs"):
            M["release_check"](self.state, proof)

    def test_cleanup_owned_join_and_cancel_prevents_retirement(self):
        self.state.update(
            operator_ref="f" * 40,
            operator_hashes={},
            operator_pins={},
            source_pins={},
            input_pins={},
            machine={"id": self.state["machine_id"]},
            owner={"pid": 12345},
        )
        self.state["proof"] = M["archive_proof"](self.state)
        self.put(
            self.export / "workspace-volume.ownership.json", {"volume_id": "vol_exact"}
        )
        calls = []

        class API:
            def __init__(self, *_a):
                self.transport = SimpleNamespace(api=lambda: None)

            def request(self, method, path, *_a, **_kw):
                calls.append((method, path))
                return self_state["machine"]

        self_state = self.state

        class Child:
            pid = os.getpid()

            def poll(self):
                return 0

            def wait(self):
                signal.raise_signal(signal.SIGTERM)
                return 0

        with (
            patch.dict(M["finalize"].__globals__, {"check": lambda _a: self.state}),
            patch.dict(
                M["F"],
                {
                    "RecordedAPI": API,
                    "api_for": lambda _s: None,
                    "cleanup_command": lambda _s: ["canonical-old-cleanup"],
                    "selected_token": lambda _s: "private-token",
                    "retire_caller": lambda *_a: self.fail("cancelled caller signaled"),
                },
            ),
            patch.object(M["subprocess"], "Popen", return_value=Child()),
            self.assertRaisesRegex(ValueError, "cancellation"),
        ):
            M["finalize"](SimpleNamespace(operator_ref="f" * 40), self.state)
        self.assertEqual(calls, [("GET", "/machines/" + self.state["machine_id"])])
        joined = M["obj"](self.out / "startup-finalization/cleanup.joined.json")
        self.assertTrue(joined["owned_join"])
        self.assertEqual(joined["cancelled_signals"], [signal.SIGTERM])
        with (
            self.assertRaises(FileExistsError),
            patch.dict(M["finalize"].__globals__, {"check": lambda _a: self.state}),
        ):
            M["finalize"](SimpleNamespace(operator_ref="f" * 40), self.state)

    def normal_release(self, observation="ABSENT", error=None):
        self.state.update(
            operator_hashes={},
            input_pins={},
            machine={"id": self.state["machine_id"]},
            owner={"pid": 12345},
        )
        self.state["proof"] = M["archive_proof"](self.state)
        self.put(
            self.export / "workspace-volume.ownership.json", {"volume_id": "vol_exact"}
        )
        calls = []

        class NotFound(Exception):
            pass

        def api(method, path, body=None, timeout=20, observer=None):
            calls.append((method, path))
            if len(calls) == 1:
                raw = json.dumps(self.state["machine"]).encode()
                observer(method, path, 200, raw)
                return self.state["machine"]
            if len(calls) == 2 and observation != "ABSENT":
                observer(method, path, 200, json.dumps(observation).encode())
                return observation
            observer(method, path, 404, b"not found")
            raise NotFound()

        api.__globals__["NotFound"] = NotFound
        fixture = self

        class Child:
            pid = os.getpid()

            def poll(self):
                return 0

            def wait(self):
                fixture.put(
                    fixture.export / "disposable-controller.release.json",
                    {
                        "machine_id": fixture.state["machine_id"],
                        "volume_id": "vol_exact",
                        "machine_deleted": True,
                        "volume_disposition": "ABSENT",
                    },
                )
                return 0

        def retire(state, journal, closed):
            closed()
            self.assertEqual(len(calls), 3)
            for number in (2, 3):
                self.assertEqual(
                    M["obj"](journal / f"wire-{number:06d}.raw.json")["status"],
                    200 if number == 2 and observation != "ABSENT" else 404,
                )
            return "PIDFD_EXIT_OBSERVED"

        with (
            patch.dict(M["finalize"].__globals__, {"check": lambda _a: self.state}),
            patch.dict(
                M["F"],
                {
                    "api_for": lambda _s: SimpleNamespace(api=api),
                    "cleanup_command": lambda _s: ["canonical-old-cleanup"],
                    "selected_token": lambda _s: "private-token",
                    "retire_caller": retire,
                    "gate_gone": lambda _s: True,
                },
            ),
            patch.object(M["subprocess"], "Popen", return_value=Child()),
        ):
            if error:
                with self.assertRaisesRegex(ValueError, error):
                    M["finalize"](SimpleNamespace(operator_ref="f" * 40), self.state)
                self.assertFalse((self.out / "terminal.json").exists())
                return
            terminal = M["finalize"](SimpleNamespace(operator_ref="f" * 40), self.state)
        self.assertEqual(terminal["status"], "FAILED_BEFORE_SUPERVISOR")
        self.assertFalse(terminal["supervisor_joined"])
        self.assertEqual(
            terminal["failure_proof_sha256"],
            M["sha"](
                (self.out / "startup-finalization/failure-proof.json").read_bytes()
            ),
        )

    def test_success_records_raw_absence_then_retires_caller(self):
        self.normal_release()

    def test_normal_destroyed_tombstone_retires_after_raw_observation(self):
        self.normal_release({"id": self.state["machine_id"], "state": "destroyed"})

    def test_normal_http200_null_is_not_absence(self):
        self.normal_release(None, "non404 native observation")

    def test_normal_foreign_tombstone_does_not_retire(self):
        self.normal_release(
            {"id": "foreign", "state": "destroyed"}, "resource release still pending"
        )

    def test_release_continuation_never_spawns_cleanup(self):
        self.state.update(
            operator_hashes={},
            input_pins={},
            machine={"id": self.state["machine_id"]},
            owner={"pid": 12345},
        )
        self.state["proof"] = M["archive_proof"](self.state)
        self.put(
            self.export / "workspace-volume.ownership.json", {"volume_id": "vol_exact"}
        )
        original_proof = self.out / "startup-finalization/failure-proof.json"
        original_proof.parent.mkdir()
        self.put(original_proof, self.state["proof"])
        self.state["prior_release"] = {
            "proof": self.state["proof"],
            "operator_ref": "oldoperator",
            "files": {"failure-proof.json": M["sha"](original_proof.read_bytes())},
        }
        self.put(
            self.out / "cleanup-call.intent.json",
            {
                "failure_proof_path": str(original_proof),
                "failure_proof_sha256": M["sha"](original_proof.read_bytes()),
                "supervisor_published": False,
                "supervisor_joined": False,
                "gate_joined": True,
            },
        )
        self.put(
            self.export / "disposable-controller.release.json",
            {
                "machine_id": self.state["machine_id"],
                "volume_id": "vol_exact",
                "machine_deleted": True,
                "volume_disposition": "ABSENT",
            },
        )
        (self.out / "payload-finalizer.lock").touch(mode=0o600)
        calls = []

        class NotFound(Exception):
            pass

        def api(method, path, body=None, timeout=20, observer=None):
            calls.append((method, path))
            observer(method, path, 404, b"not found")
            raise NotFound()

        api.__globals__["NotFound"] = NotFound
        fixture = self

        class Child:
            pid = os.getpid()

            def poll(self):
                return 0

            def wait(self):
                fixture.put(
                    fixture.export / "disposable-controller.release.json",
                    {
                        "machine_id": fixture.state["machine_id"],
                        "volume_id": "vol_exact",
                        "machine_deleted": True,
                        "volume_disposition": "ABSENT",
                    },
                )
                return 0

        def retire(state, journal, closed):
            closed()
            self.assertEqual(len(calls), 2)
            for number in (1, 2):
                self.assertEqual(
                    M["obj"](journal / f"wire-{number:06d}.raw.json")["status"], 404
                )
            return "PIDFD_EXIT_OBSERVED"

        with (
            patch.dict(
                M["resume_release"].__globals__,
                {
                    "check": lambda _a: self.state,
                    "prior_release": lambda _s: self.state["prior_release"],
                },
            ),
            patch.dict(
                M["F"],
                {
                    "api_for": lambda _s: SimpleNamespace(api=api),
                    "cleanup_command": lambda _s: ["canonical-old-cleanup"],
                    "selected_token": lambda _s: "private-token",
                    "retire_caller": retire,
                    "gate_gone": lambda _s: True,
                },
            ),
            patch.object(
                M["subprocess"], "Popen", side_effect=AssertionError("cleanup replay")
            ),
        ):
            terminal = M["resume_release"](
                SimpleNamespace(operator_ref="f" * 40), self.state
            )
        self.assertTrue(terminal["no_effect_replay"])
        self.assertEqual(terminal["status"], "FAILED_BEFORE_SUPERVISOR")
        self.assertFalse(terminal["supervisor_joined"])
        self.assertEqual(
            terminal["failure_proof_sha256"],
            M["sha"](
                (self.out / "startup-finalization/failure-proof.json").read_bytes()
            ),
        )

    def test_destroyed_tombstone_requires_exact_incarnation_and_config(self):
        native = {
            "id": self.state["machine_id"],
            "instance_id": "original",
            "config": {"secret": "bound"},
            "name": "exact",
            "region": "iad",
            "state": "destroyed",
        }
        self.state["machine"] = dict(native)
        self.assertTrue(
            M["released_native"](native, self.state, "machines", native["id"])
        )
        for key in ("id", "instance_id", "config", "name", "region", "state"):
            changed = dict(native, **{key: "foreign"})
            self.assertFalse(
                M["released_native"](changed, self.state, "machines", native["id"])
            )

    def test_evidence_pin_change_blocks_caller_signal(self):
        path = self.out / "caller.json"
        self.state.update(
            source_pins={},
            operator_pins={},
            input_pins={
                str(path): {
                    "fingerprint": M["B"]["fingerprint"](path),
                    "sha256": M["sha"](path.read_bytes()),
                }
            },
        )
        M["pin_check"](self.state)
        self.put(path, {"different": "owner"})
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            M["pin_check"](self.state)


if __name__ == "__main__":
    unittest.main()
