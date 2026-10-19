#!/usr/bin/env python3
"""Offline closure controls; only the test's own disposable local process is signalled."""

import argparse
import base64
import json
import os
import runpy
import signal
import subprocess
import sys
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
    def test_probe_echild_is_read_pending_after_raw_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            journal = Path(name)
            machine = {
                "id": "a" * 14,
                "instance_id": "v1",
                "config": {},
                "name": "original",
                "region": "ord",
            }
            payload = {
                "machine": machine["id"],
                "source_ref": "b" * 40,
                "epoch": 1,
                "identity_path": "/tmp/gate/repo/.context/identity.json",
                "action": "PROBE",
            }
            response = {
                "exit_code": 0,
                "exit_signal": 0,
                "stderr": "No child process (os error 10)\n",
                "stdout": "",
            }

            class Transport:
                def api(self, method, path, body, timeout, observer):
                    value = machine if method == "GET" else response
                    observer(method, path, 200, json.dumps(value).encode())
                    return value

            state = {
                "machine_id": machine["id"],
                "machine": machine,
                "source_ref": payload["source_ref"],
                "epoch": payload["epoch"],
                "caller": {"identity_path": payload["identity_path"]},
            }
            api = M["RecordedAPI"](Transport(), state, journal)
            with self.assertRaises(OSError):
                M["R"]["machine_control"](api, machine["id"], payload)
            raw = M["obj"](journal / "wire-000002.raw.json")
            self.assertEqual(json.loads(base64.b64decode(raw["body_b64"])), response)
            self.assertEqual(M["obj"](journal / "wire-000002.decoded.json"), response)

    def test_resume_validates_readonly_history_and_preserves_originals(self):
        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            journal = out / "payload-finalization"
            prior_source = b"old source"
            hashes = {
                "cloudbench-controller-payload-finalization.py": M["sha"](prior_source)
            }
            source = out / "old/scripts/cloudbench-controller-payload-finalization.py"
            source.parent.mkdir(parents=True)
            source.write_bytes(prior_source)
            state = {
                "out": str(out),
                "machine_id": "a" * 14,
                "source_ref": "b" * 40,
                "epoch": 1,
                "deadline": 5401,
                "operator_ref": "c" * 40,
                "finalizer_operator_hashes": hashes,
                "pins": {str(source): M["B"]["fingerprint"](source)},
                "first_borrow_operator_ref": "d" * 40,
                "caller": {"identity_path": "exact"},
            }
            write(out / "payload-finalizer.identities.private.json", state)
            intent = {
                "identity_sha256": M["sha"](
                    M["read"](out / "payload-finalizer.identities.private.json")
                ),
                "first_borrow_operator_ref": state["first_borrow_operator_ref"],
                "original_deadline": 5401,
                "pid": 99999999,
                "birth": "proc-start:00000000-0000-0000-0000-000000000000:1",
                "finalizer_operator_ref": state["operator_ref"],
            }
            write(journal / "intent.json", intent)
            write(
                journal / "wire-000001.request.json",
                {
                    "method": "GET",
                    "path": "/machines/" + state["machine_id"],
                    "body": None,
                },
            )
            payload = {
                "machine": state["machine_id"],
                "source_ref": state["source_ref"],
                "epoch": 1,
                "identity_path": "exact",
                "action": "PROBE",
            }
            body = {
                "cmd": M["R"]["exec_command"](M["R"]["REMOTE_CONTROL"], payload),
                "timeout": 20,
                "machine": True,
            }
            request = {
                "method": "POST",
                "path": "/machines/" + state["machine_id"] + "/exec",
                "body": body,
            }
            write(journal / "wire-000002.request.json", request)
            args = argparse.Namespace(
                config="config",
                config_sha256="digest",
                run_directory=out,
                operator_ref="e" * 40,
                resume_journal=journal,
            )
            before = {p.name: p.read_bytes() for p in journal.iterdir()}
            with (
                mock.patch.dict(
                    G, validate=lambda *_: True, operator=lambda *_: (hashes, {})
                ),
                mock.patch.object(
                    subprocess, "check_output", return_value=prior_source
                ),
            ):
                resumed = M["prepare_resume"](state, args)
                self.assertTrue(
                    resumed["_resume"]["journal_name"].startswith(
                        "payload-finalization-resume-"
                    )
                )
                self.assertEqual(
                    {p.name: p.read_bytes() for p in journal.iterdir()}, before
                )
                self.assertTrue(M["validate_args"](resumed, args))
                write(journal / "cleanup.intent.json", {"effect": True})
                with self.assertRaisesRegex(ValueError, "effect or unknown"):
                    M["prepare_resume"](state, args)
                with self.assertRaisesRegex(ValueError, "membership changed"):
                    M["validate_args"](resumed, args)
                (journal / "cleanup.intent.json").unlink()
                request["body"] = {"cmd": "foreign mutation"}
                (journal / "wire-000002.request.json").write_text(json.dumps(request))
                with self.assertRaisesRegex(ValueError, "read-only"):
                    M["prepare_resume"](state, args)

    def test_echild_from_term_or_other_stderr_remains_hard_failure(self):
        with tempfile.TemporaryDirectory() as name:
            machine = {
                "id": "a" * 14,
                "instance_id": "v",
                "config": {},
                "name": "n",
                "region": "ord",
            }
            state = {
                "machine_id": machine["id"],
                "machine": machine,
                "source_ref": "b" * 40,
                "epoch": 1,
                "caller": {"identity_path": "exact"},
            }
            transport = mock.Mock()
            response = {
                "exit_code": 0,
                "exit_signal": 0,
                "stderr": "No child process (os error 10)\n",
                "stdout": "",
            }
            transport.api.side_effect = [machine, response]
            api = M["RecordedAPI"](transport, state, Path(name))
            payload = {
                "machine": machine["id"],
                "source_ref": state["source_ref"],
                "epoch": 1,
                "identity_path": "exact",
                "action": "TERM",
                "identity_sha256": "c" * 64,
            }
            with self.assertRaisesRegex(ValueError, "exact supervisor exec failed"):
                M["R"]["machine_control"](api, machine["id"], payload)

    def test_prior_finalizer_requires_absence_or_different_kernel_birth(self):
        import os

        pid = os.getpid()
        birth = M["R"]["birth"](pid)
        self.assertFalse(M["prior_finalizer_dead"]({"pid": pid, "birth": birth}))
        self.assertTrue(M["prior_finalizer_dead"]({"pid": pid, "birth": birth + "0"}))
        with self.assertRaises(ValueError):
            M["prior_finalizer_dead"]({"pid": pid, "birth": "unbound"})

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
        self._monitor_case(resumed=False)

    def test_resumed_monitor_preserves_prior_journal_and_cannot_restart(self):
        self._monitor_case(resumed=True)

    def test_joined_supervisor_waits_for_export_without_reprobing_pid(self):
        self._monitor_case(resumed=True, delayed_gate=True)

    def test_resumed_joined_supervisor_never_reprobes_retired_pid(self):
        self._monitor_case(resumed=True, prior_joined=True)

    def test_prior_joined_requires_raw_native_and_terminal_identity(self):
        with tempfile.TemporaryDirectory() as name:
            journal = Path(name)
            machine = {
                "id": "a" * 14,
                "instance_id": "old-instance",
                "config": {},
                "name": "n",
                "region": "ord",
            }
            state = {
                "machine_id": machine["id"],
                "machine": machine,
                "source_ref": "b" * 40,
                "epoch": 1,
            }
            identity = {
                "schema": "original600-supervisor-identity-v1",
                "machine": machine["id"],
                "source_ref": state["source_ref"],
                "epoch": 1,
                "pid": 849,
                "birth": "proc-start:00000000-0000-0000-0000-000000000000:8291",
            }
            terminal = dict(
                identity,
                supervisor_joined=True,
                parent_joined=True,
                parent_pid=3061,
                parent_birth=identity["birth"],
                supervisor_exit_code=-9,
                epoch_finished=2,
            )
            joined = {
                "state": "JOINED",
                "identity": identity,
                "terminal": terminal,
                "identity_sha256": M["sha"](
                    (json.dumps(identity, sort_keys=True) + "\n").encode()
                ),
            }
            requests = {
                "wire-000001": {
                    "method": "GET",
                    "path": "/machines/" + machine["id"],
                    "body": None,
                },
                "wire-000002": {
                    "method": "POST",
                    "path": "/machines/" + machine["id"] + "/exec",
                    "body": {},
                },
            }
            response = {
                "exit_code": 0,
                "exit_signal": 0,
                "stderr": "",
                "stdout": json.dumps(joined),
            }
            for stem, value in (("wire-000001", machine), ("wire-000002", response)):
                raw = json.dumps(value).encode()
                write(journal / (stem + ".decoded.json"), value)
                write(
                    journal / (stem + ".raw.json"),
                    {
                        "status": 200,
                        "body_b64": base64.b64encode(raw).decode(),
                        "sha256": M["sha"](raw),
                        "bytes": len(raw),
                    },
                )
            write(journal / "probe-000259.json", joined)
            files = {p.name: M["sha"](p.read_bytes()) for p in journal.iterdir()}
            self.assertEqual(
                M["prior_joined_probe"](state, journal, requests, files), joined
            )
            for change in ({"parent_joined": False}, {"machine": "c" * 14}):
                damaged = dict(joined, terminal=dict(terminal, **change))
                (journal / "probe-000259.json").write_text(json.dumps(damaged))
                with self.assertRaises(ValueError):
                    M["prior_joined_probe"](state, journal, requests, files)
            (journal / "probe-000259.json").write_text(json.dumps(joined))
            (journal / "wire-000001.decoded.json").write_text(
                json.dumps(dict(machine, instance_id="foreign"))
            )
            with self.assertRaises(ValueError):
                M["prior_joined_probe"](state, journal, requests, files)

    def test_cleanup_refusal_continuation_preserves_old_intent_and_binds_child_token(
        self,
    ):
        self._monitor_case(resumed=True, cleanup_refusal=True)

    def test_selected_child_credential_comes_only_from_bound_agents_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "agents.env"
            path.write_text('FLY_API_TOKEN="FlyV1 bound-token"\n')
            path.chmod(0o600)
            state = {
                "authority": {
                    "env_files": {
                        "agents": {
                            "path": str(path),
                            "sha256": M["sha"](path.read_bytes()),
                        }
                    }
                }
            }
            with mock.patch.dict(os.environ, FLY_API_TOKEN="wrong-ambient-token"):
                self.assertEqual(M["selected_token"](state), "FlyV1 bound-token")
            path.write_text("FLY_API_TOKEN=changed\n")
            with self.assertRaisesRegex(ValueError, "authority env changed"):
                M["selected_token"](state)

    def test_original_cleanup_main_receives_explicit_selected_token(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / "scripts").mkdir()
            source = (
                b"class Refusal(Exception): pass\n"
                b'def resolve_token(_): raise Refusal("no Fly credential is available")\n'
                b"class Fly:\n"
                b" def __init__(self, app, token):\n"
                b'  assert app == "test-app" and token == "FlyV1 bound-token"\n'
            )
            (root / "scripts/cloudbench-original-volume-capture.py").write_bytes(source)
            script = """import runpy, sys
from pathlib import Path
m = runpy.run_path(sys.argv[1])
g = m["main"].__globals__
root = Path(sys.argv[2])
g["authority"] = lambda *a, **k: ({"app": "test-app", "source_ref": "ref", "output_directory": str(root)}, "digest")
g["subprocess"].check_output = lambda *a, **k: (root / "scripts/cloudbench-original-volume-capture.py").read_bytes()
g["cleanup"] = lambda *a: print("SELECTED_CREDENTIAL_RECEIVED_NO_PROVIDER")
sys.argv = [sys.argv[1], "cleanup", "--authority", str(root/"authority"), "--root", str(root), "--directory", str(root), "--workspace", str(root/"workspace")]
m["main"]()
"""
            command = [
                sys.executable,
                "-S",
                "-c",
                script,
                str(ROOT / "scripts/cloudbench-disposable-controller.py"),
                str(root),
            ]
            env = dict(os.environ)
            env.pop("FLY_API_TOKEN", None)
            before = subprocess.run(command, env=env, capture_output=True, check=False)
            self.assertEqual(before.returncode, 1)
            self.assertIn(b"Refusal: no Fly credential is available", before.stderr)
            agents = root / "agents.env"
            agents.write_text('FLY_API_TOKEN="FlyV1 bound-token"\n')
            agents.chmod(0o600)
            state = {
                "authority": {
                    "env_files": {
                        "agents": {
                            "path": str(agents),
                            "sha256": M["sha"](agents.read_bytes()),
                        }
                    }
                }
            }
            env["FLY_API_TOKEN"] = M["selected_token"](state)
            after = subprocess.run(command, env=env, capture_output=True, check=False)
            self.assertEqual(after.returncode, 0, after.stderr)
            self.assertEqual(
                after.stdout, b"SELECTED_CREDENTIAL_RECEIVED_NO_PROVIDER\n"
            )

    def test_exact_preclient_refusal_requires_source_join_and_no_native_intent(self):
        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            journal = out / "payload-finalization-resume-0123456789abcdef"
            # The recognizer pins the original operator's exact helper bytes
            # (operator 447bf65e8), not whatever the live checkout holds now.
            source = out / "original-source"
            for relative in (
                "cloudbench-disposable-controller.py",
                "cloudbench-original-volume-capture.py",
                "lib/cloudbench-inventory.sh",
            ):
                target = source / "scripts" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(
                    subprocess.check_output(
                        ["git", "-C", str(ROOT), "show", "447bf65e8:scripts/" + relative]
                    )
                )
            for command in (
                ["init", "-q"],
                ["add", "scripts"],
                ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "original operator sources"],
            ):
                subprocess.run(["git", "-C", str(source), *command], check=True)
            state = {
                "out": str(out),
                "source_root": str(source),
                "machine_id": "a" * 14,
                "source_ref": M["B"]["git"](source, "rev-parse", "HEAD"),
            }
            helper = str(source / "scripts/cloudbench-disposable-controller.py")
            transport = str(source / "scripts/cloudbench-original-volume-capture.py")
            log = (
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
            journal.mkdir(mode=0o700)
            (journal / "cleanup.log").write_text(log)
            (journal / "cleanup.log").chmod(0o600)
            write(
                journal / "cleanup.intent.json",
                {
                    "argv": M["cleanup_command"](state),
                    "gate_exit_code": None,
                    "gate_reap": "OBSERVED_ORIGINAL_PARENT_REAP",
                },
            )
            write(
                journal / "cleanup.child.json",
                {
                    "pid": 99999999,
                    "birth": "proc-start:00000000-0000-0000-0000-000000000000:1",
                },
            )
            write(journal / "cleanup.joined.json", {"exit_code": 1, "owned_join": True})
            write(
                out / "cleanup-call.intent.json", M["cleanup_closure"](state, "sealed")
            )
            intent = {
                "finalizer_operator_ref": "447bf65e8e4f5b3faf8e02c695ac5f7411d24c39"
            }
            with mock.patch.dict(G, verified_export=lambda _: "sealed"):
                closure, pins = M["credential_refusal"](state, journal, intent)
                self.assertEqual(closure, out / "cleanup-call.intent.json")
                self.assertIn(str(source / "scripts/lib/cloudbench-inventory.sh"), pins)
                write(out / "export/disposable-delete-machine.intent.json", {})
                with self.assertRaisesRegex(
                    ValueError, "native cleanup already entered"
                ):
                    M["credential_refusal"](state, journal, intent)
                (out / "export/disposable-delete-machine.intent.json").unlink()
                (journal / "cleanup.log").write_text(log + "unexpected output\n")
                with self.assertRaisesRegex(ValueError, "exact pre-client"):
                    M["credential_refusal"](state, journal, intent)

    def _monitor_case(
        self, resumed, cleanup_refusal=False, delayed_gate=False, prior_joined=False
    ):
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
            journal_name = "payload-finalization"
            if resumed:
                write(out / journal_name / "intent.json", {"prior": "immutable"})
                journal_name = "payload-finalization-resume-" + "a" * 16
                state["_resume"] = {"journal_name": journal_name, "operator_hashes": {}}
                if prior_joined:
                    state["_resume"]["joined_probe"] = {"state": "JOINED"}
                if cleanup_refusal:
                    state["_resume"]["cleanup_credential_refusal"] = True
                    write(
                        out / "cleanup-call.intent.json",
                        M["cleanup_closure"](state, "exportsha"),
                    )
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
                "selected_token": lambda _: "FlyV1 exact-bound-token",
            }
            if resumed:
                checks = []

                def validate_args(*_):
                    checks.append(1)
                    return not delayed_gate or len(checks) >= 5

                replacements["validate_args"] = validate_args
            with (
                mock.patch.dict(G, replacements),
                mock.patch.dict(
                    M["R"],
                    machine_control=monitor,
                    birth=lambda _: "birth",
                    reconciled_release=release,
                ),
                mock.patch.object(subprocess, "Popen", return_value=child) as popen,
                mock.patch("time.sleep", return_value=None),
            ):
                result = M["finalize"](state, args, api_factory=lambda _: object())
                self.assertEqual(
                    popen.call_args.kwargs["env"]["FLY_API_TOKEN"],
                    "FlyV1 exact-bound-token",
                )
            self.assertEqual(
                events,
                ([] if prior_joined else ["term"]) + ["joined", "release", "retired"],
            )
            self.assertEqual(
                (out / "payload-finalizer.cancelled.json").exists(), not prior_joined
            )
            self.assertEqual(
                bool(list((out / journal_name).glob("read-pending-*.json"))),
                not prior_joined,
            )
            if resumed:
                self.assertEqual(
                    M["obj"](out / "payload-finalization/intent.json"),
                    {"prior": "immutable"},
                )
            self.assertFalse(result["benchmark_success_inferred"])
            self.assertIsNone(result["gate_exit_code"])
            with self.assertRaises(ValueError), mock.patch.dict(G, replacements):
                M["finalize"](state, args, api_factory=lambda _: object())


if __name__ == "__main__":
    unittest.main()
