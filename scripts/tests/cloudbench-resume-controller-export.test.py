#!/usr/bin/env python3
"""Offline export resume ownership, canonical verification and publication ordering."""

import base64
import contextlib
import io
import json
import os
import runpy
import shlex
import signal
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-resume-controller-export.py"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    path.chmod(0o600)
    return path


class ExportResume(unittest.TestCase):
    def test_ssh_wrapped_pending_exit_requires_bound_readonly_result(self):
        pending = {
            "status": "PENDING_WRITERS",
            "machine": self.mid,
            "launch_sha256": self.binding["launch_sha256"],
            "non_hub_writers": [{"pid": 123, "birth": "fixture-birth"}],
        }
        stderr = "EXPORT_PHASE WRITERS_DONE 123\nError: ssh shell: Process exited with status 75\n"

        class API:
            def flyctl(inner, *_):
                return 1, json.dumps(pending), stderr

        journal = self.out / "ssh-wrapped-pending"
        journal.mkdir()
        result = M["remote"](API(), self.value, journal, "check", allow_pending=True)
        self.assertEqual(result, pending)
        self.assertEqual(
            json.loads((journal / "check.response.json").read_bytes())["exit_code"], 1
        )
        for index, (action, allowed, error, wrong_launch) in enumerate(
            [
                ("check", False, stderr, False),
                ("export", True, stderr, False),
                ("check", True, "Error: transport failed\n", False),
                ("check", True, stderr, True),
            ]
        ):
            with self.subTest(index=index):
                directory = self.out / f"ssh-wrapped-negative-{index}"
                directory.mkdir()
                stderr = error
                if wrong_launch:
                    pending["launch_sha256"] = "0" * 64
                with self.assertRaises(ValueError):
                    M["remote"](
                        API(), self.value, directory, action, allow_pending=allowed
                    )

    def test_remote_command_is_an_executable_without_an_implicit_shell(self):
        journal = self.out / "remote-command"
        journal.mkdir()
        program = (
            "import base64,json,os,sys\n"
            "v=json.loads(base64.b64decode(sys.argv[1]))\n"
            "assert os.getcwd()=='/'\n"
            "print(json.dumps(dict(machine=v['machine'],launch_sha256=v['launch_sha256'],non_hub_writers=[])))\n"
        )

        class API:
            def flyctl(inner, timeout, *argv):
                result = subprocess.run(
                    shlex.split(argv[-1]),
                    cwd=self.root,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    check=False,
                )
                return result.returncode, result.stdout, result.stderr

        with mock.patch.dict(M["remote"].__globals__, REMOTE=program):
            result = M["remote"](API(), self.value, journal, "check")
        self.assertEqual(result["machine"], self.mid)

    def test_phase_stderr_survives_owned_child_timeout_without_payload(self):
        journal = self.out / "phase-timeout"
        journal.mkdir()
        capture = runpy.run_path(
            str(ROOT / "scripts/cloudbench-original-volume-capture.py")
        )
        prefix = M["REMOTE"].split(
            "import ast,base64,copy,hashlib,json,os,subprocess", 1
        )[0]
        calls = []
        test = self

        class API:
            def flyctl(inner, timeout, *argv):
                test.assertEqual(timeout, 30)
                calls.append(argv)
                command = shlex.split(argv[-1])
                test.assertEqual(command[:3], ["python3", "-S", "-c"])
                rc, stdout, stderr = capture["run_bounded"](
                    command, 0.25, dict(os.environ)
                )
                return rc, stdout.decode(), stderr.decode()

        with mock.patch.dict(
            M["remote"].__globals__, REMOTE=prefix + "time.sleep(10)\n"
        ):
            with self.assertRaises(ValueError):
                M["remote"](API(), self.value, journal, "check")
        response = json.loads((journal / "check.response.json").read_text())
        self.assertEqual(response["exit_code"], 142)
        self.assertTrue(response["local_transport_joined"])
        self.assertEqual(response["stdout"], "")
        lines = [line.split() for line in response["stderr"].splitlines()]
        self.assertEqual(
            [line[:2] for line in lines],
            [["EXPORT_PHASE", "BOOTSTRAP_ENTERED"], ["EXPORT_PHASE", "REMOTE_ENTERED"]],
        )
        stamps = [int(line[2]) for line in lines]
        self.assertEqual(stamps, sorted(stamps))
        self.assertEqual(len(calls), 1)
        self.assertNotIn(self.mid, response["stderr"])
        self.assertNotIn(self.record["collector_sha256"], response["stderr"])

    def test_recorded_drain_requires_matching_original_guest_custody(self):
        identity, operator, launch = "a" * 64, "b" * 40, "c" * 64
        guest = {
            "intent.json": {"identity_sha256": identity, "operator_ref": operator},
            "plan.json": {
                "identity_sha256": identity,
                "launch_sha256": launch,
                "targets": [],
            },
        }
        files = {}
        for name, value in guest.items():
            raw = (json.dumps(value, sort_keys=True) + "\n").encode()
            files[name] = {
                "bytes": len(raw),
                "sha256": M["sha"](raw),
                "body_b64": base64.b64encode(raw).decode(),
            }
        directory = self.out / "registered-orphan-drain"
        write(
            directory / "intent.json",
            {
                "payload": {
                    "identity_sha256": identity,
                    "operator_ref": operator,
                    "launch_sha256": launch,
                }
            },
        )
        write(
            directory / "result-1.json",
            {"status": "PLANNED", "plan_sha256": files["plan.json"]["sha256"]},
        )
        pins = {}
        binding = M["local_drain_binding"](self.out, pins)
        evidence = {"present": True, "files": files}
        M["require_recorded_drain"](binding, evidence)
        self.assertEqual(len(pins), 2)
        with self.assertRaisesRegex(ValueError, "evidence missing"):
            M["require_recorded_drain"](binding, {"present": False, "files": {}})
        binding["plan_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "recorded plan"):
            M["require_recorded_drain"](binding, evidence)

    def test_recorded_relay_requires_guest_intent_even_without_result(self):
        identity, operator, launch = "a" * 64, "b" * 40, "c" * 64
        directory = self.out / "registered-orphan-drain"
        write(
            directory / "intent.json",
            {
                "payload": dict(
                    identity_sha256=identity,
                    operator_ref=operator,
                    launch_sha256=launch,
                )
            },
        )
        guest = {
            "intent.json": dict(identity_sha256=identity, operator_ref=operator),
            "plan.json": dict(identity_sha256=identity, launch_sha256=launch),
        }
        files = {}

        def encode(name, value):
            raw = (json.dumps(value, sort_keys=True) + "\n").encode()
            files[name] = dict(
                bytes=len(raw),
                sha256=M["sha"](raw),
                body_b64=base64.b64encode(raw).decode(),
            )

        for name, value in guest.items():
            encode(name, value)
        write(
            directory / "result-1.json",
            dict(status="PLANNED", plan_sha256=files["plan.json"]["sha256"]),
        )
        relay = dict(
            identity_sha256="d" * 64,
            operator_ref="e" * 40,
            launch_sha256=launch,
            relay_directory="/tmp/cb-relay-12345678",
        )
        relay_path = write(
            directory / "relay-bootstrap/intent.json", {"payload": relay}
        )
        pins = {}
        binding = M["local_drain_binding"](self.out, pins)
        self.assertIn(str(relay_path), pins)
        evidence = dict(present=True, files=files)
        with self.assertRaisesRegex(ValueError, "relay intent missing"):
            M["require_recorded_drain"](binding, evidence)
        actual = {
            key: relay[key]
            for key in ("identity_sha256", "operator_ref", "launch_sha256")
        }
        actual["owner"] = dict(relay_directory=relay["relay_directory"])
        encode("relay-bootstrap/intent.json", actual)
        M["require_recorded_drain"](binding, evidence)
        for key in ("identity_sha256", "operator_ref", "launch_sha256"):
            changed = dict(actual, **{key: "wrong"})
            encode("relay-bootstrap/intent.json", changed)
            with self.assertRaisesRegex(ValueError, "relay intent differs"):
                M["require_recorded_drain"](binding, evidence)
        encode(
            "relay-bootstrap/intent.json",
            dict(actual, owner=dict(relay_directory="/tmp/wrong")),
        )
        with self.assertRaisesRegex(ValueError, "relay intent differs"):
            M["require_recorded_drain"](binding, evidence)

    def test_relay_successor_requires_exact_pointer_manifest_and_new_intent(self):
        original = self.out / "registered-orphan-drain/relay-bootstrap/intent.json"
        old_payload = dict(
            identity_sha256="a" * 64,
            operator_ref="b" * 40,
            launch_sha256="c" * 64,
            relay_directory="/tmp/cb-relay-12345678",
        )
        write(
            original,
            {
                "payload": old_payload,
                "relay_source_pins": {"fixture-source": [1, 2, 3, 4, 5]},
            },
        )
        for index in (1, 2):
            for suffix in ("request", "raw", "decoded"):
                write(
                    original.parent / f"wire-{index:06d}.{suffix}.json",
                    {"fixture": suffix},
                )
        files = {
            path.name: M["sha"](path.read_bytes()) for path in original.parent.iterdir()
        }
        digest = M["sha"](
            json.dumps(
                files, sort_keys=True, separators=(",", ":"), allow_nan=False
            ).encode()
        )
        target = original.parent.parent / ("relay-bootstrap-pre-signal-" + digest)
        payload = dict(old_payload, identity_sha256="d" * 64, operator_ref="e" * 40)
        selected = write(
            target / "intent.json",
            dict(
                payload=payload,
                pre_signal_refusal=dict(
                    journal=str(original.parent),
                    files=files,
                    prior_journal_sha256=digest,
                    source_pins={"fixture-source": [1, 2, 3, 4, 5]},
                ),
            ),
        )
        pins = {}
        self.assertEqual(M["relay_intent_path"](original, pins), original)
        pointer = dict(
            schema="relay-pre-signal-successor-v1",
            prior_journal_sha256=digest,
            new_journal=str(target),
            intent_sha256=M["sha"](selected.read_bytes()),
            **{
                key: payload[key]
                for key in ("identity_sha256", "operator_ref", "launch_sha256")
            },
        )
        pointer_path = write(original.parent / "pre-signal-successor.json", pointer)
        self.assertEqual(M["relay_intent_path"](original, pins), selected)
        self.assertIn(str(pointer_path), pins)
        for key in (
            "intent_sha256",
            "identity_sha256",
            "new_journal",
            "prior_journal_sha256",
        ):
            write(pointer_path, dict(pointer, **{key: "wrong"}))
            with self.assertRaises(ValueError):
                M["relay_intent_path"](original, {})
        write(pointer_path, pointer)
        extra = write(original.parent / "foreign.json", {})
        with self.assertRaisesRegex(ValueError, "membership differs"):
            M["relay_intent_path"](original, {})
        extra.unlink()
        write(original.parent / "wire-000001.raw.json", {"changed": True})
        with self.assertRaises(ValueError):
            M["relay_intent_path"](original, {})

    def test_only_exact_idle_child_is_scoped_out_of_both_writer_scans(self):
        fixture = self.root / "idle-remote.py"
        fixture.write_text(M["REMOTE"])
        remote = runpy.run_path(str(fixture))
        proc = self.root / "proc"
        repo = self.root / "repo"
        repo.mkdir()
        for pid in (710, 5854):
            base = proc / str(pid)
            (base / "task" / str(pid)).mkdir(parents=True)
            (base / "fd").mkdir()
            (base / "status").write_text("Uid:\t0\t0\t0\t0\n")
            (base / "cwd").symlink_to(repo)
            for number, target in (
                ("0", "/dev/null"),
                ("1", "pipe:[4956]"),
                ("2", "pipe:[4957]"),
            ):
                (base / "fd" / number).symlink_to(target)
        child = proc / "5854"
        children = proc / "710/task/710/children"
        children.write_text("5854")
        (child / "task/5854/children").write_text("")
        (child / "stat").write_text("5854 (sleep) S 710 0 0")
        (child / "exe").symlink_to("/usr/bin/sleep")
        record = dict(driver_pid=710, driver_birth="parent-birth")
        scope = dict(
            birth=lambda pid: "parent-birth" if pid == 710 else "child-birth",
            process_argv=lambda _: ["sleep", "60"],
        )

        def validate():
            return remote["idle_children"](scope, record, repo, proc)

        self.assertEqual(validate()[0]["pid"], 5854)

        collector = runpy.run_path(str(self.collector))
        canonical_writers = collector["writers"]
        foreign = proc / "9999"
        (foreign / "fd").mkdir(parents=True)
        (foreign / "cwd").symlink_to(repo)
        for pid in (710, 5854, 9999):
            (proc / str(pid) / "maps").write_text("")

        def old(roots, permitted):
            with mock.patch.dict(
                canonical_writers.__globals__,
                Path=lambda value: proc if str(value) == "/proc" else Path(value),
                birth=lambda _: "child-birth",
            ):
                return canonical_writers([repo], permitted)

        self.assertEqual(len(old([], {710})), 2)
        scope["writers"] = old
        with mock.patch.dict(
            remote["scoped_idle_writers"].__globals__,
            idle_children=lambda *_: validate(),
        ):
            observations = remote["scoped_idle_writers"](scope, record, repo)
            collector = runpy.run_path(str(self.collector))
            with mock.patch.dict(
                collector["controller_active_writers"].__globals__,
                writers=scope["writers"],
            ):
                self.assertEqual(
                    collector["controller_active_writers"](repo, [], {710}),
                    [dict(pid=9999, birth="child-birth")],
                )
            self.assertEqual(
                scope["writers"]([], {710}), [dict(pid=9999, birth="child-birth")]
            )
            self.assertEqual(len(observations), 2)
            original = scope["writers"]

            def changed_scan(roots, permitted):
                children.write_text("")
                return old(roots, permitted)

            scope2 = dict(scope, writers=changed_scan)
            remote["scoped_idle_writers"](scope2, record, repo)
            with self.assertRaisesRegex(AssertionError, "changed during writer scan"):
                scope2["writers"]([], {710})
            scope["writers"] = original
        children.write_text("5854")
        for path, bad, good in (
            (child / "stat", "5854 (sleep) S 711 0 0", "5854 (sleep) S 710 0 0"),
            (child / "status", "Uid: 1 1 1 1", "Uid: 0 0 0 0"),
            (child / "task/5854/children", "6000", ""),
        ):
            path.write_text(bad)
            with self.assertRaises(AssertionError):
                validate()
            path.write_text(good)
        (child / "fd/9").symlink_to("/dev/null")
        with self.assertRaises(AssertionError):
            validate()
        (child / "fd/9").unlink()
        scope["process_argv"] = lambda _: ["sleep", "600"]
        with self.assertRaises(AssertionError):
            validate()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / "run"
        self.export = self.out / "export"
        self.export.mkdir(parents=True, mode=0o700)
        self.mid = "a" * 14
        self.collector = ROOT / "scripts/cloudbench-controller-export.py"
        self.caller = {"pid": 99, "birth": "fixture-gone", "host": "fixture"}
        self.record = {
            "machine_id": self.mid,
            "source_ref": "b" * 40,
            "app": M["R"]["APP"],
            "image": "fixture-image",
            "caller": self.caller,
            "collector_sha256": M["sha"](self.collector.read_bytes()),
        }
        write(self.export / "caller.json", self.caller)
        write(self.export / "launch.json", self.record)
        self.auth = write(self.out / "authority.private.json", {"fixture": "authority"})
        self.binding = {
            "fixture": "binding",
            "launch_sha256": M["sha"]((self.export / "launch.json").read_bytes()),
        }
        self.value = {
            "state": {
                "out": str(self.out),
                "source_root": str(ROOT),
                "machine_id": self.mid,
                "source_ref": "b" * 40,
                "machine": {
                    "id": self.mid,
                    "instance_id": "exact-instance",
                    "config": {},
                    "name": "old-controller",
                    "region": "iad",
                    "state": "started",
                },
            },
            "binding": self.binding,
            "record": self.record,
            "driver_sha256": "d" * 64,
            "collector_path": str(self.collector),
            "image": "fixture-image",
        }
        self.payloads = {"launch.json": (self.export / "launch.json").read_bytes()}
        archive = self.root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            data = b"actual original fixture bytes"
            entry = tarfile.TarInfo("context/original.txt")
            entry.size = len(data)
            stream.addfile(entry, io.BytesIO(data))
        self.payloads["originals.tar.gz"] = archive.read_bytes()
        self.payloads["manifest.json"] = json.dumps(
            {
                "version": 1,
                "resource_release_verified": False,
                "record": self.record,
                "archive_sha256": M["sha"](archive.read_bytes()),
                "files": {
                    "context/original.txt": {
                        "kind": "file",
                        "bytes": len(data),
                        "sha256": M["sha"](data),
                    }
                },
            }
        ).encode()

    def api(self, *, wrong=False, fail_download=False, writers=False):
        test = self

        class API:
            def __init__(self):
                self.calls = []
                self.marker = False

            def api(self, method, path, timeout, observer):
                test.assertFalse(self.marker)
                self.calls.append((method, path))
                current = dict(test.value["state"]["machine"])
                if wrong:
                    current["instance_id"] = "foreign"
                raw = json.dumps(current).encode()
                observer(method, path, 200, raw)
                return current

            def flyctl(self, seconds, *args):
                test.assertFalse(self.marker)
                self.calls.append(tuple(args[:3]))
                if args[1] == "console":
                    argv = shlex.split(args[-1])
                    payload = json.loads(base64.b64decode(argv[-1]))
                    test.assertEqual(payload["record"], test.record)
                    test.assertEqual(argv[:3], ["python3", "-S", "-c"])
                    test.assertTrue(
                        argv[3].startswith(
                            "import sys,time;print('EXPORT_PHASE BOOTSTRAP_ENTERED '"
                        )
                    )
                    test.assertIn("import os;os.chdir('/')\n", argv[3])
                    result = {
                        "machine": test.mid,
                        "launch_sha256": test.binding["launch_sha256"],
                        "non_hub_writers": [],
                        "drain_evidence": {
                            "root": "/tmp/gate/controller-host-custody/registered-orphan-drain",
                            "present": False,
                            "files": {},
                            "directories": [],
                        },
                    }
                    if writers and payload["action"] == "check":
                        return (
                            75,
                            json.dumps(
                                dict(
                                    result,
                                    status="PENDING_WRITERS",
                                    non_hub_writers=[
                                        {"pid": 123, "birth": "exact-writer"}
                                    ],
                                )
                            ),
                            "",
                        )
                    if payload["action"] == "export":
                        raw_custody = b"actual immutable TERM intent fixture\n"
                        result["drain_evidence"] = {
                            "root": "/tmp/gate/controller-host-custody/registered-orphan-drain",
                            "present": True,
                            "directories": ["per-pid"],
                            "files": {
                                "per-pid/intent.json": {
                                    "bytes": len(raw_custody),
                                    "sha256": M["sha"](raw_custody),
                                    "body_b64": base64.b64encode(raw_custody).decode(),
                                }
                            },
                        }
                        result.update(
                            canonical_export_exit=0,
                            remote_stage="/tmp/gate/controller-host-custody/export-resume-"
                            + payload["binding_sha256"][:24],
                        )
                    return 0, json.dumps(result), ""
                if fail_download:
                    return 75, "", "fixture download failure"
                destination = Path(args[-1])
                destination.write_bytes(test.payloads[destination.name])
                return 0, "", ""

        return API()

    def test_actual_old_verifier_accepts_new_staging_and_rejects_corruption(self):
        stage = self.root / "stage"
        stage.mkdir(mode=0o700)
        for name, raw in self.payloads.items():
            (stage / name).write_bytes(raw)
            (stage / name).chmod(0o600)
        hashes = M["verify_stage"](self.value, stage)
        self.assertEqual(hashes["launch.json"], self.binding["launch_sha256"])
        (stage / "originals.tar.gz").write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            M["verify_stage"](self.value, stage)

    def test_all_remote_children_join_before_canonical_marker_and_no_replay(self):
        api = self.api()

        def ready(argv, **kwargs):
            self.assertEqual(argv[3], "export-ready")
            self.assertEqual(kwargs["cwd"], "/")
            self.assertEqual(
                (
                    self.out
                    / "controller-export-recovery/registered-orphan-drain/per-pid/intent.json"
                ).read_bytes(),
                b"actual immutable TERM intent fixture\n",
            )
            self.assertEqual(
                len([call for call in api.calls if call[:2] == ("ssh", "sftp")]), 3
            )
            self.assertTrue(
                all((self.export / name).stat().st_nlink == 1 for name in self.payloads)
            )
            write(
                self.export / "disposable-export.verified.json",
                {
                    "authority_sha256": M["sha"](self.auth.read_bytes()),
                    "machine_id": self.mid,
                    "files": {
                        name: M["file_sha"](self.export / name)
                        for name in (*self.payloads, "caller.json")
                    },
                },
            )
            api.marker = True
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with (
            mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None),
            mock.patch("subprocess.run", side_effect=ready),
        ):
            result = M["execute"](self.value, api)
            self.assertEqual(result["status"], "EXPORT_VERIFIED")
            self.assertTrue(api.marker)
            self.assertEqual(
                (
                    self.out
                    / "controller-export-recovery/registered-orphan-drain/per-pid/intent.json"
                ).read_bytes(),
                b"actual immutable TERM intent fixture\n",
            )
            count = len(api.calls)
            with self.assertRaises(FileExistsError):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), count)
        self.assertTrue((self.export / "originals.tar.gz").exists())
        self.assertFalse(
            (self.out / "controller-export-recovery/download/originals.tar.gz").exists()
        )

    def test_wrong_incarnation_and_unknown_download_never_publish_or_repeat(self):
        api = self.api(wrong=True)
        with mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None):
            with self.assertRaisesRegex(ValueError, "incarnation"):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), 1)
        self.assertFalse((self.export / "disposable-export.verified.json").exists())
        # Independent owned fixture for an unknown transfer outcome.
        self.temp.cleanup()
        self.setUp()
        api = self.api(fail_download=True)
        with mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None):
            with self.assertRaisesRegex(ValueError, "download incomplete"):
                M["execute"](self.value, api)
            count = len(api.calls)
            with self.assertRaises(FileExistsError):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), count)
        self.assertFalse((self.export / "disposable-export.verified.json").exists())

    def test_readonly_old_hub_validator_keeps_finally_and_never_signals(self):
        scope = runpy.run_path(str(self.collector))
        fixture = self.root / "export-resume-fixture.py"
        fixture.write_text(M["REMOTE"])
        remote = runpy.run_path(str(fixture))
        repo = self.root / "repo"
        repo.mkdir()
        with mock.patch.object(
            signal,
            "pidfd_send_signal",
            side_effect=AssertionError("no signal in read-only validator"),
        ):
            self.assertEqual(
                remote["readonly_hubs"](
                    scope, self.collector.read_bytes(), repo, self.root
                ),
                [],
            )
        hub = repo / ".context/fleet/runs/_hub"
        hub.mkdir(parents=True)
        fields = {
            "pid": str(os.getpid()),
            "pid_start": scope["birth"](os.getpid()),
            "repo_root": str(repo),
            "root": str(hub.parent),
            "runs_root": str(hub.parent),
            "context_dir": str(hub),
            "command": str(repo / "agents/benchmarks/agent_link_server.py"),
            "status": "live-transfer-required",
            "host": "127.0.0.1",
            "owner_token": "e" * 32,
            "port": "5000",
            "argv_sha256": "f" * 64,
        }
        owner = hub / ("agent-link-server.5000." + "e" * 32 + ".owner")
        owner.write_text("\n".join(key + "=" + value for key, value in fields.items()))
        owner.chmod(0o400)
        real_close = os.close
        with (
            mock.patch.object(
                signal, "pidfd_send_signal", side_effect=AssertionError("no signal")
            ),
            mock.patch.object(os, "close", wraps=real_close) as closed,
        ):
            with self.assertRaisesRegex(ValueError, "command changed"):
                remote["readonly_hubs"](
                    scope, self.collector.read_bytes(), repo, self.root
                )
            self.assertEqual(closed.call_count, 1)

    def test_cancellation_during_owned_flyctl_joins_before_refusing_next_effect(self):
        api = self.api()
        original = api.flyctl
        joined = []

        def cancelled(seconds, *args):
            result = original(seconds, *args)
            signal.raise_signal(signal.SIGTERM)
            joined.append(True)
            return result

        api.flyctl = cancelled
        old_handler = signal.getsignal(signal.SIGTERM)
        with (
            mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None),
            self.assertRaises(M["ExportCancelled"]),
        ):
            M["execute"](self.value, api)
        self.assertEqual(joined, [True])
        self.assertEqual(len(api.calls), 2)  # one GET and the joined readonly SSH
        self.assertEqual(signal.getsignal(signal.SIGTERM), old_handler)
        receipt = json.loads(
            (self.out / "controller-export-recovery/cancelled.json").read_bytes()
        )
        self.assertTrue(receipt["owned_transport_joined"])
        self.assertFalse((self.export / "disposable-export.verified.json").exists())
        self.assertTrue(
            (self.out / "controller-export-recovery/check.response.json").exists()
        )

    def test_readonly_observation_retains_pending_without_spending_export_intent(self):
        api = self.api(writers=True)
        with mock.patch.dict(M["observe"].__globals__, unchanged=lambda _: None):
            result = M["observe"](self.value, api)
            self.assertFalse(result["ready"])
            self.assertEqual(result["non_hub_writer_count"], 1)
            self.assertEqual(len(api.calls), 2)
            self.assertFalse((self.out / "controller-export-recovery").exists())
            ready = M["observe"](self.value, self.api())
            self.assertTrue(ready["ready"])
            self.assertNotEqual(result["journal"], ready["journal"])
            self.assertFalse((self.out / "controller-export-recovery").exists())
        self.assertFalse((self.export / "disposable-export.verified.json").exists())

    def test_check_mode_has_zero_transport_or_export_calls(self):
        output = io.StringIO()
        with (
            mock.patch.dict(
                M["main"].__globals__,
                check=lambda *_: self.value,
                execute=lambda *_: (_ for _ in ()).throw(AssertionError("no effects")),
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(
                M["main"](
                    [
                        "--config",
                        "/fixture",
                        "--config-sha256",
                        "a" * 64,
                        "--run-directory",
                        str(self.out),
                        "--operator-ref",
                        "b" * 40,
                        "--check",
                    ]
                ),
                0,
            )
        self.assertEqual(json.loads(output.getvalue())["provider_calls"], 0)


if __name__ == "__main__":
    unittest.main()
