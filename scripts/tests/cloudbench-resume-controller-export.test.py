#!/usr/bin/env python3
"""Offline export resume ownership, canonical verification and publication ordering."""

import base64
import contextlib
import gzip
import io
import json
import os
import runpy
import shlex
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
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
        self.assertEqual(json.loads((journal / "check.response.json").read_bytes())["exit_code"], 1)
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
                    M["remote"](API(), self.value, directory, action, allow_pending=allowed)

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
        capture = runpy.run_path(str(ROOT / "scripts/cloudbench-original-volume-capture.py"))
        prefix = M["REMOTE"].split("import ast,base64,copy,hashlib,json,os,subprocess", 1)[0]
        calls = []
        test = self

        class API:
            def flyctl(inner, timeout, *argv):
                test.assertEqual(timeout, 30)
                calls.append(argv)
                command = shlex.split(argv[-1])
                test.assertEqual(command[:3], ["python3", "-S", "-c"])
                rc, stdout, stderr = capture["run_bounded"](command, 0.25, dict(os.environ))
                return rc, stdout.decode(), stderr.decode()

        with mock.patch.dict(M["remote"].__globals__, REMOTE=prefix + "time.sleep(10)\n"):
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
        relay_path = write(directory / "relay-bootstrap/intent.json", {"payload": relay})
        pins = {}
        binding = M["local_drain_binding"](self.out, pins)
        self.assertIn(str(relay_path), pins)
        evidence = dict(present=True, files=files)
        with self.assertRaisesRegex(ValueError, "relay intent missing"):
            M["require_recorded_drain"](binding, evidence)
        actual = {key: relay[key] for key in ("identity_sha256", "operator_ref", "launch_sha256")}
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
        files = {path.name: M["sha"](path.read_bytes()) for path in original.parent.iterdir()}
        digest = M["sha"](json.dumps(files, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
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
            **{key: payload[key] for key in ("identity_sha256", "operator_ref", "launch_sha256")},
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
            # Real /proc lists the leader under task/<tid>; the collector reads every thread.
            task = proc / str(pid) / "task" / str(pid)
            task.mkdir(parents=True, exist_ok=True)
            (task / "cwd").symlink_to(os.readlink(proc / str(pid) / "cwd"))
            for name in ("fd", "maps"):
                (task / name).symlink_to(Path("..") / ".." / name)

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
            self.assertEqual(scope["writers"]([], {710}), [dict(pid=9999, birth="child-birth")])
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

    def test_normal_owner_check_without_borrowed_capture(self):
        source = "c9d4817832720cc2b1bc6a212383973a77baf004"
        host = "a819e410264bf95c993d551d406375a8621026d2"
        epoch = time.time() - 100
        caller = dict(
            pid=123,
            birth="normal-owner",
            gate_pid=987654321,
            gate_birth="normal-gate",
            source_ref=source,
            epoch=epoch,
            deadline=epoch + 5400,
            task_ref="1387ae608e7cfb8e3f0a876daae92093f503b465",
        )
        authority = dict(
            source_ref=source,
            app=M["R"]["APP"],
            region="iad",
            cleanup_owner_pid=123,
            cleanup_owner_birth="normal-owner",
            output_directory=str(self.export),
            env_files={},
            protected_machines=[],
            protected_volumes=[],
        )
        auth = write(self.out / "authority.private.json", authority)
        auth_sha = M["sha"](auth.read_bytes())
        caller["authority_sha256"] = auth_sha
        write(self.out / "caller.json", caller)
        write(
            self.out / "controller.identity.json",
            dict(
                source_ref=source,
                authority_sha256=auth_sha,
                machine=self.mid,
                instance="native-instance",
            ),
        )
        workspace = write(
            self.export / "workspace-volume.ownership.json",
            dict(
                schema="cloudbench-controller-workspace-ownership-v1",
                app=M["R"]["APP"],
                source_ref=source,
                size_gb=256,
                volume_id="vol_fixture",
            ),
        )
        driver = b"bound_controller_export export\nwhile :; do sleep 60; done\n"
        machine = dict(
            id=self.mid,
            instance_id="native-instance",
            config={
                "env": {"GATE_REF": source},
                "guest": {"cpu_kind": "performance", "cpus": 8, "memory_mb": 32768},
                "mounts": [
                    {
                        "volume": "vol_fixture",
                        "path": "/tmp/gate",
                        "encrypted": True,
                        "size_gb": 256,
                        "name": "fixture",
                    }
                ],
                "image": "registry.example/warm@sha256:" + "1" * 64,
                "files": [
                    {
                        "guest_path": "/tmp/gate.sh",
                        "raw_value": base64.b64encode(driver).decode(),
                    }
                ],
            },
            name="normal",
            region="iad",
            state="started",
        )
        write(
            self.export / "disposable-controller.ownership.json",
            dict(
                schema="cloudbench-disposable-controller-ownership-v1",
                authority_sha256=auth_sha,
                workspace_sha256=M["sha"](workspace.read_bytes()),
                machine=machine,
                volume={
                    "id": "vol_fixture",
                    "attached_machine_id": self.mid,
                    "auto_backup_enabled": False,
                },
            ),
        )
        runner_hash = M["sha"]((ROOT / "scripts/cloudbench-original600-runner.py").read_bytes())
        gate_hash = M["sha"]((ROOT / "scripts/run-cloudbench-controller-gate").read_bytes())
        template = write(
            self.root / "authority-template.json",
            {
                key: value
                for key, value in authority.items()
                if key not in {"cleanup_owner_pid", "cleanup_owner_birth", "output_directory"}
            },
        )
        tasks_path = write(
            self.root / "tasks.json",
            json.loads((ROOT / "scripts/tests/fixtures/original600-tasks.json").read_bytes()),
        )
        supervisor_sha = M["sha"]((ROOT / "scripts/cloudbench-original600-supervisor.py").read_bytes())
        config = write(
            self.root / "normal.config.json",
            dict(
                source_ref=source,
                source_root=str(ROOT),
                source_files={"cloudbench-original600-supervisor.py": supervisor_sha},
                schema="original600-controller-runner-v1",
                allowed=True,
                authority_template=str(template),
                tasks_path=str(tasks_path),
                remote_files=[],
                remote_env={},
                started_at_epoch=epoch,
                host_operator_provenance=dict(
                    host_operator_source_ref=host,
                    workload_source_ref=source,
                    original_started_at_epoch=epoch,
                    host_runner_sha256=runner_hash,
                    host_gate_sha256=gate_hash,
                    incomplete_admission={"source_root": str(ROOT)},
                ),
            ),
        )
        caller["identity_path"] = "/tmp/gate/repo/.context/original600-supervisor.fixture.json"
        write(self.out / "caller.json", caller)
        envelope = dict(
            source_ref=source,
            epoch=epoch,
            tasks=json.loads(tasks_path.read_bytes()),
            campaign_argv=M["R"]["campaign_argv"](json.loads(tasks_path.read_bytes()), epoch),
            supervisor_sha256=supervisor_sha,
            identity_name="original600-supervisor.fixture.json",
            remote_files=[],
            remote_env={},
        )
        envelope_raw = gzip.compress(json.dumps(envelope).encode(), mtime=0)
        (self.out / "controller-launch-payload.private.json.gz").write_bytes(envelope_raw)
        (self.out / "controller-launch-payload.private.json.gz").chmod(0o600)
        write(self.out / "controller-sidecars.private.json", [])
        machine["config"]["files"].append(
            {
                "guest_path": "/tmp/controller-launch-payload.json.gz",
                "raw_value": base64.b64encode(envelope_raw).decode(),
            }
        )
        ownership = json.loads((self.export / "disposable-controller.ownership.json").read_bytes())
        ownership["machine"] = machine
        write(self.export / "disposable-controller.ownership.json", ownership)
        owner = dict(
            pid=123,
            birth="normal-owner",
            cwd=str(self.root),
            argv=[
                "python3",
                str(ROOT / "scripts/run-original600-controller.py"),
                "--source-ref",
                host,
                "--resume-incomplete-admission",
                str(self.root),
            ],
        )
        record = dict(
            self.record,
            source_ref=source,
            image=machine["config"]["image"],
            workspace_ownership_sha256=M["sha"](workspace.read_bytes()),
            caller={
                "pid": caller["gate_pid"],
                "birth": caller["gate_birth"],
                "host": "fixture",
            },
        )
        write(self.export / "caller.json", record["caller"])
        write(self.export / "launch.json", record)
        (self.out / "gate.private.log").write_text(
            "GATE_EXPORT_PENDING machine=" + self.mid + "\nGATE_RESULT exit=75\n"
        )
        real_runpy, real_git = M["runpy"].run_path, M["subprocess"].check_output

        def runpy_path(path, **kwargs):
            if str(path).endswith("cloudbench-disposable-controller.py"):
                return {"authority": lambda *_a, **_k: (authority, auth_sha)}
            return real_runpy(path, **kwargs)

        def git(command, **kwargs):
            if command[-2:-1] == ["show"]:
                name = command[-1].split(":scripts/", 1)[1]
                return (ROOT / "scripts" / name).read_bytes()
            return real_git(command, **kwargs)

        with (
            mock.patch.dict(
                M["B"],
                source_identity=lambda *_a: {},
                process_identity=lambda _pid: owner,
            ),
            mock.patch.object(M["runpy"], "run_path", side_effect=runpy_path),
            mock.patch.object(M["subprocess"], "check_output", side_effect=git),
        ):
            digest = M["sha"](config.read_bytes())
            value = M["check"](config, digest, self.out, "f" * 40)
            self.assertEqual(value["binding"]["capture_kind"], "normal-current-owner")
            self.assertFalse((self.out / "payload-finalizer.identities.private.json").exists())
            M["unchanged"](value)
            with mock.patch.object(M["time"], "time", return_value=caller["deadline"]):
                with self.assertRaisesRegex(ValueError, "clock expired"):
                    M["unchanged"](value)
            native_path = self.export / "disposable-controller.ownership.json"
            for changed_key, bad in (
                ("guest", {}),
                ("mounts", []),
                ("env", {"GATE_REF": "0" * 40}),
            ):
                modified = json.loads(native_path.read_bytes())
                modified["machine"]["config"][changed_key] = bad
                write(native_path, modified)
                with self.assertRaises(ValueError):
                    M["check"](config, digest, self.out, "f" * 40)
                write(native_path, ownership)
            for field, bad in (
                ("gate_pid", os.getpid()),
                ("authority_sha256", "0" * 64),
                ("epoch", 101.0),
            ):
                original = caller[field]
                caller[field] = bad
                write(self.out / "caller.json", caller)
                with self.assertRaises(ValueError):
                    M["check"](config, digest, self.out, "f" * 40)
                caller[field] = original
                write(self.out / "caller.json", caller)
            write(self.out / "payload-borrow.intent.json", {"borrowed": True})
            with self.assertRaisesRegex(ValueError, "borrowed owner"):
                M["check"](config, digest, self.out, "f" * 40)

    def test_remote_resumes_only_bound_pending_and_repeats_only_refused_snapshot_races(self):
        fixture = self.root / "pending-remote.py"
        fixture.write_text(M["REMOTE"])
        remote = runpy.run_path(str(fixture))
        race = {"status": "pending", "reason": "controller originals changed during export", "resource_release_verified": False}
        self.assertTrue(remote["resumable_pending"](race, "r" * 64))
        self.assertTrue(remote["resumable_pending"]({"status": "pending", "reason": "live controller writers", "record_sha256": "r" * 64}, "r" * 64))
        for bad in (dict(race, reason="controller export authority differs"), dict(race, resource_release_verified=True),
                    dict(race, extra=1), {"status": "pending", "record_sha256": "x" * 64}, dict(race, status="done")):
            self.assertFalse(remote["resumable_pending"](bad, "r" * 64))
        events = []
        args = SimpleNamespace(archive=self.root / "a.tar.gz", manifest=self.root / "m.json")

        def export(_args):
            events.append("export")
            if events.count("export") < 3:
                raise ValueError("controller originals changed during export")
            return 0

        code, races = remote["bounded_export"]({"export": export}, args, sync=lambda: events.append("sync"), sleep=events.append)
        self.assertEqual((code, len(races)), (0, 2))
        self.assertEqual(events, ["sync", "export", 10, "sync", "export", 10, "sync", "export"])
        for error in (ValueError("controller export authority differs"), OSError("io")):
            with self.assertRaises(type(error)):
                remote["bounded_export"]({"export": lambda _a, e=error: (_ for _ in ()).throw(e)}, args, sync=lambda: None, sleep=lambda _s: None)
        args.manifest.write_text("{}")
        calls = []
        with self.assertRaisesRegex(ValueError, "changed during export"):
            remote["bounded_export"]({"export": lambda _a: calls.append(1) or (_ for _ in ()).throw(ValueError("controller originals changed during export"))}, args, sync=lambda: None, sleep=lambda _s: None)
        self.assertEqual(calls, [1])
        with self.assertRaisesRegex(ValueError, "changed during export"):
            args.manifest.unlink()
            remote["bounded_export"]({"export": lambda _a: (_ for _ in ()).throw(ValueError("controller originals changed during export"))}, args, attempts=3, sync=lambda: None, sleep=lambda _s: None)

    def runner_fixture(self, owner_pid=123, owner_birth="runner-owner", gate_pid=987654321, with_pending=True,
                       log=None, owner_live=True, task_ref=None, caller_task_ref=None, shard_extra=None,
                       caller_deadline_seconds=None):
        """One sharded original600 run directory whose own runner is the bound cleanup owner.

        ``task_ref`` binds the shard's own pushed task source; ``caller_task_ref`` overrides
        the caller record's value to model a caller that disagrees with its shard."""
        log = "GATE_EXPORT_PENDING machine=" + self.mid + "\nGATE_RESULT exit=1\n" if log is None else log
        source = "a252045f5090917bb00e562b72dbacbab8261c66"
        epoch = time.time() - 100
        runner_path = ROOT / "scripts/cloudbench-original600-runner.py"
        runner = runpy.run_path(str(runner_path))
        caller = dict(pid=owner_pid, birth=owner_birth, gate_pid=gate_pid, gate_birth="gate", source_ref=source,
                      epoch=epoch, deadline=epoch + 5400, task_ref=runner["TASK_REF"],
                      identity_path="/tmp/gate/repo/.context/original600-supervisor.fixture.json")
        authority = dict(source_ref=source, app=M["R"]["APP"], region="iad", cleanup_owner_pid=owner_pid,
                         cleanup_owner_birth=owner_birth, output_directory=str(self.export), env_files={},
                         protected_machines=[], protected_volumes=[])
        auth = write(self.out / "authority.private.json", authority)
        auth_sha = M["sha"](auth.read_bytes())
        caller["authority_sha256"] = auth_sha
        write(self.out / "caller.json", caller)
        write(self.out / "controller.identity.json",
              dict(source_ref=source, authority_sha256=auth_sha, machine=self.mid, instance="native-instance"))
        workspace = write(self.export / "workspace-volume.ownership.json",
                          dict(schema="cloudbench-controller-workspace-ownership-v1", app=M["R"]["APP"],
                               source_ref=source, size_gb=256, volume_id="vol_fixture"))
        template = write(self.root / "authority-template.json", {k: v for k, v in authority.items()
                         if k not in {"cleanup_owner_pid", "cleanup_owner_birth", "output_directory"}})
        tasks = json.loads((ROOT / "scripts/tests/fixtures/original600-tasks.json").read_bytes())
        tasks_path = write(self.root / "tasks.json", tasks)
        metadata = self.root / "inventory.json"
        metadata.write_bytes(b'{"snapshot": "fixture"}\n')
        metadata.chmod(0o600)
        rel = ".git/cloudbench-warm-snapshot-inventory.fixture.json"
        names = [tasks[3], tasks[10], tasks[199]]
        shard = dict(index=0, count=20, tasks=names, tasks_sha256=M["sha"](("\n".join(names) + "\n").encode()),
                     task_indexes=[3, 10, 199], runs=3, group_run_id="campaign-group-fixture", group_total=600,
                     group_started_at=epoch)
        if task_ref is not None:
            shard["task_ref"] = task_ref
        shard.update(shard_extra or {})
        caller["deadline"] = epoch + (caller_deadline_seconds or 5400)
        caller["task_ref"] = runner["shard_task_ref"](shard) if caller_task_ref is None else caller_task_ref
        write(self.out / "caller.json", caller)
        sources = {name: M["sha"]((ROOT / "scripts" / name).read_bytes())
                   for name in ("cloudbench-original600-supervisor.py", "cloudbench-original600-runner.py")}
        config = write(self.root / "shard.config.json", dict(
            source_ref=source, source_root=str(ROOT), source_files=sources, schema="original600-controller-runner-v1",
            allowed=True, authority_template=str(template), tasks_path=str(tasks_path), started_at_epoch=epoch,
            remote_files=[dict(relative_path=rel, source_path=str(metadata), sha256=M["sha"](metadata.read_bytes()))],
            remote_env={}, shard=shard))
        digest = M["sha"](config.read_bytes())
        envelope = dict(source_ref=source, epoch=epoch, tasks=tasks, shard=shard,
                        campaign_argv=runner["campaign_argv"](tasks, epoch, shard),
                        supervisor_sha256=sources["cloudbench-original600-supervisor.py"],
                        identity_name="original600-supervisor.fixture.json", remote_env={},
                        remote_files=[runner["encode_remote_file"](dict(relative_path=rel, sha256=M["sha"](metadata.read_bytes())), metadata.read_bytes())])
        envelope_raw = gzip.compress(json.dumps(envelope).encode(), mtime=0)
        (self.out / "controller-launch-payload.private.json.gz").write_bytes(envelope_raw)
        (self.out / "controller-launch-payload.private.json.gz").chmod(0o600)
        driver = b"bound_controller_export export\nwhile :; do sleep 60; done\n"
        machine = dict(id=self.mid, instance_id="native-instance", name="cloudbench-gate-fixture-s00", region="iad", state="started", config={
            "env": {"GATE_REF": source}, "guest": {"cpu_kind": "performance", "cpus": 8, "memory_mb": 32768},
            "mounts": [{"volume": "vol_fixture", "path": "/tmp/gate"}], "image": "registry.example/warm@sha256:" + "1" * 64,
            "files": [{"guest_path": "/tmp/gate.sh", "raw_value": base64.b64encode(driver).decode()},
                      {"guest_path": "/tmp/controller-launch-payload.json.gz", "raw_value": base64.b64encode(envelope_raw).decode()}]})
        write(self.export / "disposable-controller.ownership.json", dict(
            schema="cloudbench-disposable-controller-ownership-v1", authority_sha256=auth_sha,
            workspace_sha256=M["sha"](workspace.read_bytes()), machine=machine,
            volume={"id": "vol_fixture", "attached_machine_id": self.mid, "auto_backup_enabled": False}))
        record = dict(self.record, source_ref=source, image=machine["config"]["image"],
                      workspace_ownership_sha256=M["sha"](workspace.read_bytes()),
                      caller={"pid": caller["gate_pid"], "birth": caller["gate_birth"], "host": "fixture"})
        write(self.export / "caller.json", record["caller"])
        write(self.export / "launch.json", record)
        (self.out / "gate.private.log").write_text(log)
        (self.out / "gate.private.log").chmod(0o600)
        pending = dict(status="PENDING_EXTERNAL_OWNER_LIVE", gate_exit_code=1, supervisor_state="JOINED",
                       export_verified=False, no_host_destroy=True)
        if with_pending:
            write(self.out / "gate.pending.json", pending)
        owner = dict(pid=owner_pid, birth=owner_birth, cwd=str(self.root), argv=[
            "/usr/bin/python3", str(runner_path), "--config", str(config), "--config-sha256", digest, "--output", str(self.out)])
        real_runpy = M["runpy"].run_path
        # The pinned helper's authority shape: it reads the bound cleanup owner's live birth.
        helper = {"AUTH": authority, "AUTH_SHA": auth_sha,
                  "LIVE": lambda pid: owner_birth if owner_live and pid == owner_pid else M["R"]["birth"](pid)}
        exec(compile("def birth(pid):\n    return LIVE(pid)\n\n"
                     "def authority(path, root, fresh=True):\n"
                     "    if birth(AUTH['cleanup_owner_pid']) != AUTH['cleanup_owner_birth']:\n"
                     "        raise ValueError('external cleanup owner must remain live')\n"
                     "    return AUTH, AUTH_SHA\n", "fixture-disposable-helper", "exec"), helper)

        def runpy_path(path, **kwargs):
            if str(path).endswith("cloudbench-disposable-controller.py"):
                return {"authority": helper["authority"]}
            return real_runpy(path, **kwargs)

        def git(command, **kwargs):
            name = command[-1].split(":scripts/", 1)[1]
            return (ROOT / "scripts" / name).read_bytes()

        return SimpleNamespace(source=source, epoch=epoch, caller=caller, authority=authority, auth_sha=auth_sha,
                               config=config, digest=digest, pending=pending, owner=owner, metadata=metadata,
                               runpy_path=runpy_path, git=git)

    def test_runner_owner_binds_the_runs_own_source_config_and_live_runner(self):
        # run600c: sharded original600 runner is the live cleanup owner; no host
        # provenance and no remembered commit. Small metadata rides inline.
        f = self.runner_fixture()
        source, epoch, config, digest, pending, owner, metadata = (
            f.source, f.epoch, f.config, f.digest, f.pending, f.owner, f.metadata)
        runpy_path, git = f.runpy_path, f.git
        with (
            mock.patch.dict(M["B"], source_identity=lambda *_a: {}, process_identity=lambda _pid: owner),
            mock.patch.object(M["runpy"], "run_path", side_effect=runpy_path),
            mock.patch.object(M["subprocess"], "check_output", side_effect=git),
        ):
            value = M["check"](config, digest, self.out, "f" * 40)
            self.assertEqual((value["binding"]["source_ref"], value["binding"]["capture_kind"]), (source, "normal-current-owner"))
            M["unchanged"](value)
            self.assertEqual(M["transfer_budget"](value["state"], now=epoch), 3600)
            with self.assertRaisesRegex(ValueError, "too short"):
                M["transfer_budget"](value["state"], now=epoch + 5400 - 100)
            for argv in (owner["argv"][:4] + ["0" * 64] + owner["argv"][5:], owner["argv"][:-1] + [str(self.root)]):
                with mock.patch.dict(M["B"], process_identity=lambda _pid, a=argv: dict(owner, argv=a)):
                    with self.assertRaisesRegex(ValueError, "owner source differs"):
                        M["check"](config, digest, self.out, "f" * 40)
            write(self.out / "gate.pending.json", dict(pending, export_verified=True))
            with self.assertRaisesRegex(ValueError, "unverified export"):
                M["check"](config, digest, self.out, "f" * 40)
            write(self.out / "gate.pending.json", pending)
            metadata.chmod(0o600); metadata.write_bytes(b'{"snapshot": "changed"}\n')
            with self.assertRaisesRegex(ValueError, "inline remote file differs"):
                M["check"](config, digest, self.out, "f" * 40)

    def test_shard_bound_task_ref_is_the_expected_caller_task_ref(self):
        # The runner records caller.json task_ref=shard_task_ref(shard); a shard that binds its
        # own pushed ref must verify, and a caller that kept the historical pin must not.
        pin = runpy.run_path(str(ROOT / "scripts/cloudbench-original600-runner.py"))["TASK_REF"]
        for caller_task_ref, accepted in ((None, True), (pin, False)):
            with self.subTest(accepted=accepted):
                self.setUp()
                f = self.runner_fixture(task_ref="b" * 40, caller_task_ref=caller_task_ref)
                with (
                    mock.patch.dict(M["B"], source_identity=lambda *_a: {}, process_identity=lambda _pid: f.owner),
                    mock.patch.object(M["runpy"], "run_path", side_effect=f.runpy_path),
                    mock.patch.object(M["subprocess"], "check_output", side_effect=f.git),
                ):
                    if accepted:
                        value = M["check"](f.config, f.digest, self.out, "f" * 40)
                        self.assertEqual(value["binding"]["capture_kind"], "normal-current-owner")
                    else:
                        with self.assertRaisesRegex(ValueError, "normal authority/caller differs"):
                            M["check"](f.config, f.digest, self.out, "f" * 40)

    def dead_pid(self):
        child = subprocess.Popen(["true"])
        child.wait()
        self.assertFalse(Path("/proc", str(child.pid)).exists())
        return child.pid

    def dead_window(self, f, name="dead-window.json", **overrides):
        window = dict(schema="controller-export-dead-owner-window-v1", run_directory=str(self.out), machine_id=self.mid,
                      original_epoch=f.epoch, created_at=time.time() - 10, cleanup_deadline_epoch=time.time() + 1800,
                      authorized_by="parent coordinator", reason="runner killed by a service restart", benchmark_credit=0,
                      cleanup_only=True, dead_owner_pid=f.caller["pid"], dead_owner_birth=f.caller["birth"],
                      coordinator_pid=self.dead_pid())
        window.update(overrides)
        return write(self.root / name, window)

    @contextlib.contextmanager
    def runner_patches(self, f):
        def no_live_owner(_pid):
            raise AssertionError("dead-owner recovery never reads a live owner")

        with (
            mock.patch.dict(M["B"], source_identity=lambda *_a: {}, process_identity=no_live_owner),
            mock.patch.object(M["runpy"], "run_path", side_effect=f.runpy_path),
            mock.patch.object(M["subprocess"], "check_output", side_effect=f.git),
        ):
            yield

    def test_dead_runner_owner_is_accepted_only_when_provably_gone(self):
        # polar70 19:24Z: a service restart killed the operator, all runners and their gates while the
        # gates still waited: no gate.pending.json, no GATE_EXPORT_PENDING, and the run's own helper
        # refuses every action for a dead cleanup owner.
        f = self.runner_fixture(owner_pid=self.dead_pid(), owner_birth="proc-start:fixture:1", with_pending=False,
                                log="GATE_START fixture\nGATE_STEP_START #1 supervisor\n", owner_live=False)
        window = self.dead_window(f)
        args = (f.config, f.digest, self.out, "f" * 40)
        with self.runner_patches(f):
            # Without the explicit dead-owner mode the live runner remains required.
            with self.assertRaises((ValueError, FileNotFoundError)):
                M["check"](*args)
            with self.assertRaises((ValueError, FileNotFoundError)):
                M["check"](*args, cleanup_window=window)
            (self.out / "gate.pending.json").write_text(json.dumps(f.pending))
            (self.out / "gate.pending.json").chmod(0o600)
            with self.assertRaises(FileNotFoundError):  # the pinned helper's own live-owner read of the dead runner
                M["check"](*args, cleanup_window=window)
            (self.out / "gate.pending.json").unlink()
            with self.assertRaisesRegex(ValueError, "explicit cleanup window"):
                M["check"](*args, dead_owner=True)
            value = M["check"](*args, cleanup_window=window, dead_owner=True)
            binding = value["binding"]
            self.assertEqual((binding["capture_kind"], binding["cleanup_only"]), ("dead-runner-owner", True))
            self.assertEqual(
                {k: binding["dead_owner"][k] for k in ("pid", "owner_state", "gate_state", "coordinator_state")},
                {"pid": f.caller["pid"], "owner_state": "ABSENT", "gate_state": "ABSENT", "coordinator_state": "ABSENT"},
            )
            M["unchanged"](value)
            # An ordinary cleanup window never authorizes a dead owner.
            plain = {k: v for k, v in json.loads(window.read_bytes()).items()
                     if k not in ("dead_owner_pid", "dead_owner_birth", "coordinator_pid")}
            plain = write(self.root / "plain-window.json", dict(plain, schema="controller-export-cleanup-window-v1"))
            with self.assertRaisesRegex(ValueError, "window refused"):
                M["check"](*args, cleanup_window=plain, dead_owner=True)
            # A window naming a foreign owner or a changed birth binds another runner.
            for index, overrides in enumerate(({"dead_owner_birth": "proc-start:foreign:2"},
                                               {"dead_owner_pid": f.caller["pid"] + 1})):
                foreign = self.dead_window(f, "foreign-%d.json" % index, **overrides)
                with self.assertRaisesRegex(ValueError, "another runner owner"):
                    M["check"](*args, cleanup_window=foreign, dead_owner=True)
            # A coordinator PID that may still run is never assumed gone.
            live_coordinator = self.dead_window(f, "coordinator.json", coordinator_pid=os.getpid())
            with self.assertRaisesRegex(ValueError, "coordinator PID present"):
                M["check"](*args, cleanup_window=live_coordinator, dead_owner=True)
            # A gate that verified an export is not a lost-owner recovery.
            (self.out / "gate.private.log").write_text("GATE_EXPORT_VERIFIED machine=" + self.mid + "\n")
            with self.assertRaisesRegex(ValueError, "already verified"):
                M["check"](*args, cleanup_window=window, dead_owner=True)

    def test_dead_owner_accepts_the_shards_bound_e2e_deadline_only(self):
        # 2026-10-20 Polar batch 1 (0a2470cc6): --timeout 7200 binds e2e_timeout 9300, so the
        # runner recorded caller deadline = epoch + 9300; recovery required epoch + 5400 and
        # refused the dead-owner cleanup route for every shard of the run. That run's own
        # pinned runner validates its 9300; this source binds the widened 10020 default.
        bound = dict(task_timeout=7200, e2e_timeout=10020)
        for seconds, accepted in ((10020, True), (5400, False), (10021, False)):
            with self.subTest(caller_deadline=seconds):
                self.setUp()
                f = self.runner_fixture(owner_pid=self.dead_pid(), owner_birth="proc-start:fixture:1", with_pending=False,
                                        log="GATE_START fixture\n", owner_live=False, shard_extra=bound,
                                        caller_deadline_seconds=seconds)
                args = (f.config, f.digest, self.out, "f" * 40)
                with self.runner_patches(f):
                    if accepted:
                        value = M["check"](*args, cleanup_window=self.dead_window(f), dead_owner=True)
                        self.assertEqual(value["binding"]["capture_kind"], "dead-runner-owner")
                        self.assertEqual(value["state"]["deadline"], f.epoch + 10020)
                        M["unchanged"](value)
                    else:
                        with self.assertRaisesRegex(ValueError, "normal authority/caller differs"):
                            M["check"](*args, cleanup_window=self.dead_window(f), dead_owner=True)
        # The unbound default keeps the historical epoch + 5400 and refuses a bound-looking clock.
        self.setUp()
        f = self.runner_fixture(owner_pid=self.dead_pid(), owner_birth="proc-start:fixture:1", with_pending=False,
                                log="GATE_START fixture\n", owner_live=False, caller_deadline_seconds=9300)
        with self.runner_patches(f):
            with self.assertRaisesRegex(ValueError, "normal authority/caller differs"):
                M["check"](f.config, f.digest, self.out, "f" * 40, cleanup_window=self.dead_window(f), dead_owner=True)

    def test_live_or_reused_runner_birth_never_borrows_a_live_owner(self):
        me = os.getpid()
        f = self.runner_fixture(owner_pid=me, owner_birth=M["R"]["birth"](me), with_pending=False,
                                log="GATE_START fixture\n", owner_live=False)
        args = (f.config, f.digest, self.out, "f" * 40)
        with self.runner_patches(f):
            with self.assertRaisesRegex(ValueError, "runner owner is live"):
                M["check"](*args, cleanup_window=self.dead_window(f), dead_owner=True)
        # The same PID with another birth is a reused PID: the recorded runner is gone.
        self.temp.cleanup()
        self.setUp()
        f = self.runner_fixture(owner_pid=me, owner_birth="proc-start:fixture:1", with_pending=False,
                                log="GATE_START fixture\n", owner_live=False)
        with self.runner_patches(f):
            value = M["check"](f.config, f.digest, self.out, "f" * 40, cleanup_window=self.dead_window(f),
                               dead_owner=True)
        self.assertEqual(value["binding"]["dead_owner"]["owner_state"], "PID_REUSED")
        # A live gate stays the export owner.
        self.temp.cleanup()
        self.setUp()
        f = self.runner_fixture(owner_pid=self.dead_pid(), owner_birth="proc-start:fixture:1", gate_pid=me,
                                with_pending=False, log="GATE_START fixture\n", owner_live=False)
        with self.runner_patches(f):
            with self.assertRaisesRegex(ValueError, "gate"):
                M["check"](f.config, f.digest, self.out, "f" * 40, cleanup_window=self.dead_window(f),
                           dead_owner=True)

    def test_pinned_helper_runs_unchanged_with_only_the_dead_owner_substituted(self):
        ref = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
        helper = ROOT / "scripts/cloudbench-disposable-controller.py"
        dead = self.dead_pid()
        authority = dict(schema="cloudbench-disposable-controller-authority-v1", allowed=True, single_host=True,
                         app=M["R"]["APP"], region="iad", vm_size="performance-8x", memory_mib=32768,
                         workspace_size_gb=256, output_directory=str(self.export), org_machine_limit=10,
                         verified_epoch=time.time() - 1000, cleanup_owner_pid=dead,
                         cleanup_owner_birth="proc-start:fixture:1", protected_machines=["p1", "p2", "p3", "p4"],
                         protected_volumes=[], source_ref=ref)
        auth = write(self.root / "helper-authority.json", authority)
        argv = [str(helper), "export-ready", "--authority", str(auth), "--root", str(ROOT), "--directory",
                str(self.export), "--machine", self.mid, "--image", "fixture-image"]
        direct = subprocess.run([sys.executable, "-S", *argv], cwd="/", capture_output=True)
        self.assertNotEqual(direct.returncode, 0)
        self.assertIn(b"external cleanup owner must remain live", direct.stderr)
        state = dict(source_root=str(ROOT), source_ref=ref, authority=authority,
                     owner=dict(pid=dead, birth=authority["cleanup_owner_birth"]))
        shimmed = subprocess.run(M["dead_owner_helper_argv"](state, argv), cwd="/", capture_output=True)
        # Past the owner check the helper's own export verification still runs and refuses the missing archive.
        self.assertNotEqual(shimmed.returncode, 0)
        self.assertNotIn(b"must remain live", shimmed.stderr)
        self.assertIn(b"originals.tar.gz", shimmed.stderr)
        self.assertFalse((self.export / "disposable-export.verified.json").exists())
        me = os.getpid()
        live = dict(authority, cleanup_owner_pid=me, cleanup_owner_birth=M["R"]["birth"](me))
        write(auth, live)
        refused = subprocess.run(
            M["dead_owner_helper_argv"](dict(state, authority=live, owner=dict(pid=me, birth=live["cleanup_owner_birth"])), argv),
            cwd="/", capture_output=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn(b"cleanup owner is live", refused.stderr)
        for action in ("admit", "seal", "cleanup-workspace"):
            with self.assertRaisesRegex(ValueError, "action refused"):
                M["dead_owner_helper_argv"](state, [str(helper), action, *argv[2:]])

    def dead_state(self):
        caller = dict(pid=self.dead_pid(), birth="proc-start:fixture:1", gate_pid=self.dead_pid(), gate_birth="gate",
                      epoch=time.time() - 600, identity_path="/tmp/gate/repo/.context/original600-supervisor.f.json")
        authority = dict(cleanup_owner_pid=caller["pid"], cleanup_owner_birth=caller["birth"])
        return dict(dead_owner=True, out=str(self.out), source_root=str(ROOT), source_ref="b" * 40,
                    machine_id=self.mid, machine=self.value["state"]["machine"], caller=caller, authority=authority,
                    owner=dict(pid=caller["pid"], birth=caller["birth"]), epoch=caller["epoch"],
                    deadline=caller["epoch"] + 5400, cleanup_deadline_epoch=time.time() + 1800)

    def test_dead_owner_release_requires_joined_supervisor_then_runs_the_runners_cleanup(self):
        state = self.dead_state()
        workspace = write(self.export / "workspace-volume.ownership.json", {"volume_id": "vol_fixture"})
        write(self.export / "disposable-export.verified.json", {"fixture": "marker"})
        api = self.api()
        probes, calls = [], []

        def runpy_path(path, **kwargs):
            if str(path).endswith("cloudbench-original600-runner.py"):
                def reconciled(out, export, authority, mid, action, joined, probe):
                    self.assertEqual((mid, action, joined, probe["state"]), (self.mid, "cleanup", True, "JOINED"))
                    self.assertEqual(json.loads((out / "cleanup-call.intent.json").read_bytes())["action"], "cleanup")
                    return json.loads((export / "disposable-controller.release.json").read_bytes())
                return {"machine_control": lambda _fly, mid, payload: (calls.append(payload), probes.pop(0))[1],
                        "reconciled_release": reconciled}
            return {"NotFound": KeyError}

        def cleanup(argv, **kwargs):
            self.assertEqual(argv[1:3], ["-S", "-c"])
            self.assertEqual(argv[5:7], [str(ROOT / "scripts/cloudbench-disposable-controller.py"), "cleanup"])
            self.assertIn(str(workspace), argv)
            write(self.export / "disposable-controller.release.json",
                  dict(machine_id=self.mid, volume_id="vol_fixture", volume_disposition="pending_destroy", machine_deleted=True))
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        def native_reads(fly, mid, vid):
            return dict(machine_id=mid, machine_state="ABSENT", volume_id=vid, volume_state="pending_destroy")

        patches = dict(validate_normal=lambda _s: True, native_release=native_reads,
                       F=dict(M["F"], verified_export=lambda _s: "m" * 64, selected_token=lambda _s: "fixture"))
        with (
            mock.patch.dict(M["release_dead_owner"].__globals__, patches),
            mock.patch.object(M["runpy"], "run_path", side_effect=runpy_path),
            mock.patch.object(M["subprocess"], "run", side_effect=cleanup) as run,
            mock.patch.object(M["subprocess"], "check_output", return_value=b"pinned helper"),
        ):
            probes.append({"state": "LIVE"})
            with self.assertRaisesRegex(ValueError, "supervisor not joined"):
                M["release_dead_owner"](state, api)
            self.assertEqual(run.call_count, 0)
            self.assertFalse((self.out / "cleanup-call.intent.json").exists())
            # The refused journal is never replayed; a fresh run directory recovers once.
            (self.out / "dead-owner-release").rename(self.root / "refused-release-journal")
            probes.append({"state": "JOINED"})
            terminal = M["release_dead_owner"](state, api)
            self.assertEqual(run.call_count, 1)
            self.assertEqual((terminal["status"], terminal["benchmark_credit"], terminal["benchmark_success_inferred"]),
                             ("DEAD_OWNER_CONTROLLER_RELEASE_VERIFIED", 0, False))
            self.assertEqual(json.loads((self.out / "terminal.json").read_bytes()), terminal)
            self.assertEqual([p["action"] for p in calls], ["PROBE", "PROBE"])
            with self.assertRaisesRegex(ValueError, "already dispatched"):
                M["release_dead_owner"](state, api)
            self.assertEqual(run.call_count, 1)

    def test_dead_gate_launch_record_is_fetched_once_and_bound_to_this_run(self):
        state = self.dead_state()
        (self.export / "launch.json").unlink()
        workspace = write(self.export / "workspace-volume.ownership.json", {"volume_id": "vol_fixture"})
        record = dict(self.record, image="fixture-image", workspace_ownership_sha256=M["sha"](workspace.read_bytes()),
                      caller=dict(self.caller, pid=state["caller"]["gate_pid"], birth="gate"))
        write(self.export / "caller.json", record["caller"])
        state["machine"] = dict(state["machine"], config={"image": "fixture-image"})
        self.value["state"]["machine"] = state["machine"]
        api = self.api()
        self.payloads["launch.json"] = json.dumps(record).encode()
        patches = dict(validate_normal=lambda _s: True)
        with (
            mock.patch.dict(M["fetch_launch"].__globals__, patches),
            mock.patch.object(M["subprocess"], "check_output", return_value=self.collector.read_bytes()),
        ):
            receipt = M["fetch_launch"](state, api)
            self.assertEqual(receipt["launch_sha256"], M["sha"]((self.export / "launch.json").read_bytes()))
            self.assertEqual((self.export / "launch.json").stat().st_nlink, 1)
            with self.assertRaisesRegex(ValueError, "already present"):
                M["fetch_launch"](state, api)
            (self.export / "launch.json").unlink()
            (self.out / "dead-owner-launch-fetch").rename(self.root / "first-fetch")
            self.payloads["launch.json"] = json.dumps(dict(record, machine_id="f" * 14)).encode()
            with self.assertRaisesRegex(ValueError, "differs from this run"):
                M["fetch_launch"](state, api)
            self.assertFalse((self.export / "launch.json").exists())

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

    def api(self, *, wrong=False, fail_download=False, writers=False, flaky=None):
        test = self
        flaky = dict(flaky or {})

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
                    test.assertTrue(argv[3].startswith("import sys,time;print('EXPORT_PHASE BOOTSTRAP_ENTERED '"))
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
                                    non_hub_writers=[{"pid": 123, "birth": "exact-writer"}],
                                )
                            ),
                            "",
                        )
                    if payload["action"] == "canonical":
                        test.canonical_calls = getattr(test, "canonical_calls", 0) + 1
                        result.update(canonical_export_exit=0, remote_stage="/tmp/gate/controller-host-custody")
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
                if flaky.get(destination.name):
                    flaky[destination.name] -= 1
                    destination.write_bytes(b"partial")
                    return 1, "", "Error: ssh: tunnel closed during sftp"
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
                (self.out / "controller-export-recovery/registered-orphan-drain/per-pid/intent.json").read_bytes(),
                b"actual immutable TERM intent fixture\n",
            )
            self.assertEqual(len([call for call in api.calls if call[:2] == ("ssh", "sftp")]), 3)
            self.assertTrue(all((self.export / name).stat().st_nlink == 1 for name in self.payloads))
            write(
                self.export / "disposable-export.verified.json",
                {
                    "authority_sha256": M["sha"](self.auth.read_bytes()),
                    "machine_id": self.mid,
                    "files": {name: M["file_sha"](self.export / name) for name in (*self.payloads, "caller.json")},
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
                (self.out / "controller-export-recovery/registered-orphan-drain/per-pid/intent.json").read_bytes(),
                b"actual immutable TERM intent fixture\n",
            )
            count = len(api.calls)
            with self.assertRaises(FileExistsError):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), count)
        self.assertTrue((self.export / "originals.tar.gz").exists())
        self.assertFalse((self.out / "controller-export-recovery/download/originals.tar.gz").exists())

    def test_download_only_recovers_one_lost_manifest_transfer_through_export_ready(self):
        # run600b shard-08: canonical remote export exit 0, one manifest sftp loss, host retained.
        (self.out / "gate.private.log").write_text("GATE_EXPORT_PENDING machine=" + self.mid + "\nGATE_RESULT exit=1\n")
        (self.out / "gate.private.log").chmod(0o600)
        api = self.api(flaky={"manifest.json": 1})

        def ready(argv, **kwargs):
            self.assertEqual(argv[3], "export-ready")
            write(self.export / "disposable-export.verified.json", {
                "authority_sha256": M["sha"](self.auth.read_bytes()), "machine_id": self.mid,
                "files": {name: M["file_sha"](self.export / name) for name in (*self.payloads, "caller.json")}})
            api.marker = True
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with (
            mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None),
            mock.patch("subprocess.run", side_effect=ready),
        ):
            result = M["download_verified"](self.value, api)
            self.assertEqual(result["status"], "EXPORT_VERIFIED")
            consoles = [call for call in api.calls if call[:2] == ("ssh", "console")]
            self.assertEqual((len(consoles), self.canonical_calls), (1, 1))  # one read-only check; no re-export
            journal = self.out / "controller-export-download"
            first = json.loads((journal / "manifest.json.download.json").read_bytes())
            self.assertEqual(first["exit_code"], 1)
            self.assertIn("tunnel closed", first["stderr"])
            self.assertEqual(json.loads((journal / "manifest.json.download-2.json").read_bytes())["exit_code"], 0)
            self.assertEqual((self.export / "manifest.json").read_bytes(), self.payloads["manifest.json"])
            count = len(api.calls)
            for operation in (M["download_verified"], M["execute"]):
                with self.assertRaises((FileExistsError, ValueError)):
                    operation(self.value, api)
            self.assertEqual(len(api.calls), count)

    def test_dead_owner_download_needs_no_gate_pending_marker_and_wraps_export_ready(self):
        # polar70: the killed gate logged only GATE_START; the remote canonical check binds the export.
        (self.out / "gate.private.log").write_text("GATE_START fixture\n")
        (self.out / "gate.private.log").chmod(0o600)
        self.value["state"].update(dead_owner=True, source_ref="b" * 40,
                                   authority=dict(cleanup_owner_pid=4242, cleanup_owner_birth="proc-start:fixture:1"),
                                   owner=dict(pid=4242, birth="proc-start:fixture:1"))
        api = self.api()

        def ready(argv, **kwargs):
            self.assertEqual(argv[1:3], ["-S", "-c"])
            self.assertEqual(argv[3], M["DEAD_OWNER_HELPER"])
            self.assertEqual(argv[6], "export-ready")
            write(self.export / "disposable-export.verified.json", {
                "authority_sha256": M["sha"](self.auth.read_bytes()), "machine_id": self.mid,
                "files": {name: M["file_sha"](self.export / name) for name in (*self.payloads, "caller.json")}})
            api.marker = True
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with (
            mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None),
            mock.patch("subprocess.run", side_effect=ready),
            mock.patch.object(M["subprocess"], "check_output", return_value=b"pinned helper"),
        ):
            result = M["download_verified"](self.value, api)
        self.assertEqual(result["status"], "EXPORT_VERIFIED")
        complete = json.loads((self.out / "controller-export-download/complete.json").read_bytes())
        self.assertFalse(complete["controller_cleanup_owned_elsewhere"])
        # The ordinary owner still needs its gate's own export-pending result.
        self.temp.cleanup()
        self.setUp()
        (self.out / "gate.private.log").write_text("GATE_START fixture\n")
        (self.out / "gate.private.log").chmod(0o600)
        with mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None):
            with self.assertRaisesRegex(ValueError, "did not retain"):
                M["download_verified"](self.value, self.api())

    def test_explicit_cleanup_window_binds_one_controller_clock_and_expires(self):
        epoch = time.time() - 6000
        window = dict(schema="controller-export-cleanup-window-v1", run_directory=str(self.out), machine_id=self.mid,
                      original_epoch=epoch, created_at=time.time() - 10, cleanup_deadline_epoch=time.time() + 1800,
                      authorized_by="parent coordinator", reason="retained owned controller", benchmark_credit=0,
                      cleanup_only=True)
        path = write(self.root / "window.json", window)
        proof, digest = M["cleanup_window_proof"](path, self.out)
        self.assertEqual((proof["machine_id"], digest), (self.mid, M["sha"](path.read_bytes())))
        self.assertIn(M["transfer_budget"]({"cleanup_deadline_epoch": window["cleanup_deadline_epoch"]}), (1739, 1740))
        for key, bad in (("benchmark_credit", 1), ("cleanup_only", False), ("run_directory", str(self.root)),
                         ("cleanup_deadline_epoch", window["created_at"] + 3601), ("authorized_by", ""), ("extra", 1)):
            write(path, dict(window, **{key: bad}))
            with self.assertRaises(ValueError):
                M["cleanup_window_proof"](path, self.out)
        write(path, window)
        with self.assertRaisesRegex(ValueError, "expired"):
            M["cleanup_window_proof"](path, self.out, now=window["cleanup_deadline_epoch"])

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
                remote["readonly_hubs"](scope, self.collector.read_bytes(), repo, self.root),
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
            mock.patch.object(signal, "pidfd_send_signal", side_effect=AssertionError("no signal")),
            mock.patch.object(os, "close", wraps=real_close) as closed,
        ):
            with self.assertRaisesRegex(ValueError, "command changed"):
                remote["readonly_hubs"](scope, self.collector.read_bytes(), repo, self.root)
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
        receipt = json.loads((self.out / "controller-export-recovery/cancelled.json").read_bytes())
        self.assertTrue(receipt["owned_transport_joined"])
        self.assertFalse((self.export / "disposable-export.verified.json").exists())
        self.assertTrue((self.out / "controller-export-recovery/check.response.json").exists())

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


class CleanupClock(unittest.TestCase):
    def test_separate_cleanup_window_preserves_expired_original_clock(self):
        clock = M["normal_clock"]
        epoch = M["CLEANUP_ORIGINAL_EPOCH"]
        old = epoch + 5400
        cutoff = M["CLEANUP_HOLD_DEADLINE"]
        with mock.patch.dict(clock.__globals__, time=SimpleNamespace(time=lambda: M["CLEANUP_HOLD_CREATED"] + 1)):
            with self.assertRaises(Exception):
                clock(epoch, old)
            self.assertEqual(clock(epoch, old, cutoff), cutoff)
            for e, d, c in [(epoch + 1, old + 1, cutoff), (epoch, old, cutoff + 1), (epoch, old, float("nan"))]:
                with self.assertRaises(Exception):
                    clock(e, d, c)
        with mock.patch.dict(clock.__globals__, time=SimpleNamespace(time=lambda: cutoff)):
            with self.assertRaises(Exception):
                clock(epoch, old, cutoff)


if __name__ == "__main__":
    unittest.main()
