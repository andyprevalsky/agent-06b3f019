#!/usr/bin/env python3
"""Offline closure controls; only the test's own disposable local process is signalled."""

import argparse
import base64
import json
import runpy
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-controller-payload-finalization.py"))
G = M["finalize"].__globals__


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    M["save"](path, value)


class Finalizer(unittest.TestCase):
    def test_capture_is_local_and_preserves_first_operator_and_gate_snapshot(self):
        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            intent = {"operator_ref": "a" * 40}
            write(out / "payload-borrow.intent.json", intent)
            state = {
                "out": out,
                "pins": {"/tmp/cloudbench-gate-self.Abc123": (1, 2)},
                "deadline": 20,
                "owner": {"pid": 12},
                "gate": {"pid": 13},
            }
            with (
                mock.patch.dict(
                    M["B"],
                    check=mock.Mock(return_value=state),
                    owner_unchanged=lambda _: True,
                ),
                mock.patch.dict(
                    G,
                    operator=lambda _: ({"helper": "digest"}, {}),
                    borrow_binding=lambda *_: {},
                ),
            ):
                result = M["capture"]("config", "digest", out, "b" * 40)
                stored = M["obj"](result["path"])
                self.assertEqual(stored["first_borrow_operator_ref"], "a" * 40)
                self.assertEqual(
                    stored["gate_snapshot_paths"], ["/tmp/cloudbench-gate-self.Abc123"]
                )
                self.assertEqual(stored["owner"], {"pid": 12})
                self.assertEqual(result["provider_calls"], 0)
                with self.assertRaises(ValueError):
                    M["capture"]("config", "digest", out, "b" * 40)

    def test_raw_observer_precedes_decode_and_no_foreign_exec(self):
        with tempfile.TemporaryDirectory() as name:
            journal = Path(name)
            machine = {
                "id": "abc",
                "instance_id": "v1",
                "config": {"image": "same"},
                "name": "old",
                "region": "iad",
            }

            class Transport:
                def api(self, method, path, body, timeout, observer):
                    raw = (
                        json.dumps(machine).encode() if method == "GET" else b"not-json"
                    )
                    observer(method, path, 200, raw)
                    return json.loads(raw)

            api = M["RecordedAPI"](
                Transport(), {"machine_id": "abc", "machine": machine}, journal
            )
            with self.assertRaises(json.JSONDecodeError):
                api.api("POST", "/machines/abc/exec", {})
            raw = M["obj"](journal / "wire-000002.raw.json")
            self.assertEqual(base64.b64decode(raw["body_b64"]), b"not-json")
            with self.assertRaises(ValueError):
                api.api("DELETE", "/machines/abc")

    def test_native_version_mismatch_blocks_exec(self):
        with tempfile.TemporaryDirectory() as name:
            transport = mock.Mock()
            transport.api.return_value = {"id": "abc", "instance_id": "foreign"}
            api = M["RecordedAPI"](
                transport,
                {"machine_id": "abc", "machine": {"id": "abc", "instance_id": "v1"}},
                Path(name),
            )
            with self.assertRaises(ValueError):
                api.api("POST", "/machines/abc/exec", {})
            self.assertEqual(transport.api.call_count, 1)

    def test_full_export_hash_and_membership_are_required(self):
        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            write(out / "authority.private.json", {"authority": True})
            files = {}
            for item in (
                "originals.tar.gz",
                "manifest.json",
                "launch.json",
                "caller.json",
            ):
                path = out / "export" / item
                write(path, {"original": item})
                files[item] = M["sha"](path.read_bytes())
            marker = {
                "authority_sha256": M["sha"](
                    (out / "authority.private.json").read_bytes()
                ),
                "machine_id": "abc",
                "files": files,
            }
            write(out / "export/disposable-export.verified.json", marker)
            state = {"out": str(out), "machine_id": "abc"}
            self.assertEqual(
                M["verified_export"](state),
                M["sha"]((out / "export/disposable-export.verified.json").read_bytes()),
            )
            (out / "export/originals.tar.gz").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                M["verified_export"](state)

    def test_original_parent_must_be_live_and_exact_for_observed_reap(self):
        state = {
            "caller": {"pid": 100, "gate_pid": 99999999},
            "owner": {"pid": 100},
            "gate": {"pid": 99999999},
        }
        with mock.patch.dict(M["B"], process_identity=lambda _: {"pid": 100}):
            self.assertTrue(M["gate_gone"](state))
        with (
            mock.patch.dict(M["B"], process_identity=lambda _: {"pid": 101}),
            self.assertRaises(ValueError),
        ):
            M["gate_gone"](state)

    def test_shared_term_intent_race_is_observation_only_and_exact(self):
        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            state = {"out": str(out), "machine_id": "abc"}
            payload = {"identity_path": "exact"}
            probe = {"identity": {"pid": 20, "birth": "old"}, "identity_sha256": "sha"}
            expected = {
                "machine": "abc",
                "pid": 20,
                "birth": "old",
                "identity_sha256": "sha",
                "signal": "SIGTERM",
                "path": "exact",
            }

            def raced(*_):
                write(out / "supervisor-term.intent.json", expected)
                raise FileExistsError("other original owner saved first")

            with mock.patch.dict(M["R"], request_term=raced):
                M["term_once"](None, state, payload, probe)
            with mock.patch.dict(
                M["R"],
                request_term=mock.Mock(side_effect=AssertionError("must not replay")),
            ):
                M["term_once"](None, state, payload, probe)
                with self.assertRaises(ValueError):
                    M["term_once"](None, state, {"identity_path": "foreign"}, probe)

    def test_pidfd_signal_requires_closure_then_observes_only_own_test_child(self):
        child = subprocess.Popen(["sleep", "30"])
        try:
            owner = M["B"]["process_identity"](child.pid)
            state = {"owner": owner}
            with tempfile.TemporaryDirectory() as name:
                with self.assertRaisesRegex(ValueError, "not closed"):
                    M["retire_caller"](
                        state,
                        Path(name),
                        lambda: (_ for _ in ()).throw(ValueError("not closed")),
                    )
                self.assertIsNone(child.poll())
                self.assertEqual(list(Path(name).iterdir()), [])
                closure = mock.Mock()
                result = M["retire_caller"](state, Path(name), closure)
                self.assertIn(result, ("EXITED_PIDFD_OBSERVED_NOT_OWNED_JOIN",))
                self.assertEqual(closure.call_count, 1)
                self.assertFalse((Path(name) / "SIGKILL.intent.json").exists())
                child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)

    def test_monitor_cancel_and_transient_read_drain_cleanup_before_retirement(self):
        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            state = {
                "out": str(out),
                "machine_id": "abc",
                "source_ref": "s",
                "epoch": 1,
                "deadline": 99999999999,
                "source_root": str(out),
                "caller": {"identity_path": "identity"},
                "first_borrow_operator_ref": "old",
            }
            write(
                out / "payload-borrow.complete.json",
                {"status": "TRANSFER_ONLY_COMPLETE"},
            )
            write(out / "payload-finalizer.identities.private.json", {})
            write(out / "export/disposable-export.verified.json", {})
            args = argparse.Namespace(
                config=out / "config",
                config_sha256="digest",
                run_directory=out,
                operator_ref="new",
            )
            events = []
            child = mock.Mock(pid=1234)
            child.wait.side_effect = lambda: events.append("joined") or 0

            def release(*_):
                self.assertIn("joined", events)
                events.append("release")
                return {"released": True}

            def retire(*_):
                self.assertIn("release", events)
                events.append("retired")
                return "ABSENT_OBSERVED"

            probes = [OSError("transient read"), {"state": "LIVE"}, {"state": "JOINED"}]

            def monitor(*_):
                value = probes.pop(0)
                if isinstance(value, Exception):
                    raise value
                if value["state"] == "LIVE":
                    signal.raise_signal(signal.SIGTERM)
                return value

            replacements = {
                "term_once": lambda *_: events.append("term"),
                "validate": lambda *_: True,
                "borrow_binding": lambda *_: {},
                "verified_export": lambda _: "exportsha",
                "RecordedAPI": lambda api, *_: api,
                "retire_caller": retire,
            }
            with (
                mock.patch.dict(G, replacements),
                mock.patch.dict(
                    M["R"],
                    machine_control=monitor,
                    birth=lambda _: "birth",
                    reconciled_release=release,
                ),
                mock.patch.object(subprocess, "Popen", return_value=child),
                mock.patch("time.sleep", return_value=None),
            ):
                result = M["finalize"](state, args, api_factory=lambda _: object())
            self.assertEqual(events, ["term", "joined", "release", "retired"])
            self.assertTrue((out / "payload-finalizer.cancelled.json").exists())
            self.assertTrue(
                list((out / "payload-finalization").glob("read-pending-*.json"))
            )
            self.assertFalse(result["benchmark_success_inferred"])
            self.assertIsNone(result["gate_exit_code"])
            with self.assertRaises(ValueError), mock.patch.dict(G, replacements):
                M["finalize"](state, args, api_factory=lambda _: object())


if __name__ == "__main__":
    unittest.main()
