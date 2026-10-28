#!/usr/bin/env python3
"""Local kernel/process controls for the registered-owner drain; no provider calls."""

import runpy as _pidfd_runpy
from pathlib import Path as _PidfdPath
# Guest payloads use pidfd; run under a python3 that has it (see pidfd_interpreter.py).
_pidfd_runpy.run_path(str(_PidfdPath(__file__).resolve().with_name("pidfd_interpreter.py")))["require_pidfd_interpreter"](__file__)

import base64
import contextlib
import io
import gzip
import hashlib
import json
import os
import runpy
import shlex
import socket
import subprocess
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-controller-orphan-drain.py"))
# Every fixture here runs under the conventional umask 022 (the deploy lane's
# transient-service and macOS default). Interactive devbox shells use 077,
# which hides fixtures that only pass because the umask made them private.
FIXTURE_UMASK = 0o022
_inherited_umask: list[int] = []


def setUpModule():
    _inherited_umask.append(os.umask(FIXTURE_UMASK))


def tearDownModule():
    if _inherited_umask:
        os.umask(_inherited_umask.pop())


class Drain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.common = self.repo / ".git"
        self.custody = self.root / "custody"
        for path in (self.repo / "scripts", self.common, self.custody):
            path.mkdir(parents=True, exist_ok=True)
        self.script = self.repo / "scripts/run-bench-fleet"
        self.script.write_text("trap 'exit 0' TERM\nwhile :; do read -r -t .1 ignored || true; done\n")
        self.token = "a" * 32
        self.registry = self.common / "cloudbench-fleet-ownership" / self.token
        self.registry.mkdir(parents=True)
        self.audit = self.common / "cloudbench-fleet-audits" / self.token
        self.audit.mkdir(parents=True)
        self.seed = self.repo / ".context/benchmarks/campaigns/exact/startup-cohorts/c001/seed-proof.private.json"
        self.seed.parent.mkdir(parents=True)
        self.ref = "b" * 40
        self.taskref = "1387ae608e7cfb8e3f0a876daae92093f503b465"
        self.task = "exact-task"
        authority = {
            "source": {"ref": self.ref},
            "directory": str(self.seed.parent.parent.parent / "shared-inventory"),
            "owner": {"parent_pid": "3061"},
        }
        self.child = subprocess.Popen(
            [
                "bash",
                str(self.script),
                self.task,
                "--strict-barrier",
                "--ref",
                self.taskref,
                "--foreground",
            ],
            cwd=self.repo,
            stdin=subprocess.DEVNULL,
            env=dict(
                os.environ,
                CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY=json.dumps(authority),
                CLOUDBENCH_CAMPAIGN_SEED_PROOF=str(self.seed),
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        guest_path = self.root / "orphan-guest.py"
        guest_path.write_text(M["GUEST"])
        self.ns = runpy.run_path(str(guest_path))["execute"].__globals__
        for _ in range(100):
            try:
                self.process = self.ns["process"](self.child.pid)
                break
            except ValueError:
                time.sleep(0.01)
        else:
            self.fail("fixture did not arm TERM handler")
        self.run = "20261017-170846-" + str(self.child.pid)
        successor = {
            "controller_id": "84ed412b11d168",
            "harness_ref": self.ref,
            "task_ref": self.taskref,
            "owner_token": self.token,
            "run_id": self.run,
            "task": self.task,
            "ordinal": 0,
            "campaign_total_jobs": 600,
            "campaign_attempt": 1,
            "campaign_job_id": "r001-j0001",
        }
        path = self.repo / ".context/fleet/runs" / self.run / self.task
        path.mkdir(parents=True)
        (path / "archived-successor.json").write_text(json.dumps(successor))
        jobs = {"r001-j" + str(i).zfill(4): self.child.pid if i == 1 else 100000 + i for i in range(1, 601)}
        (self.seed.parent / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": jobs}))
        self.meta = {
            "version": "2",
            "app": "navi-whisper-lux-bench",
            "fleet_owner_token": self.token,
            "host": socket.gethostname(),
            "pid": str(self.child.pid),
            "pid_start": self.process["birth"],
            "run_id": self.run,
            "workspace_root": str(self.repo),
            "runs_root": str(self.repo / ".context/fleet/runs"),
            "audit_dir": str(self.audit),
            "owned_ids_file": str(self.audit / "owned-clones.ids"),
            "owned_names_file": str(self.audit / "owned-clones.names"),
            "cleanup_policy": "retain",
        }
        self.write_meta()
        self.old_mid = os.environ.get("FLY_MACHINE_ID")
        os.environ["FLY_MACHINE_ID"] = "84ed412b11d168"
        self.ns.update(
            PARENT_PID=3061,
            ROSE_UID=os.geteuid(),
            FLEET_SHA=hashlib.sha256(self.script.read_bytes()).hexdigest(),
            EXPECTED_FLEET_SHA=hashlib.sha256(self.script.read_bytes()).hexdigest(),
        )
        self.pending = {"writers": [{"pid": self.child.pid, "birth": self.process["birth"]}]}
        self.ns["prerequisites"] = lambda value: (
            self.repo,
            self.common,
            self.custody,
            self.pending,
        )
        self.payload = {
            "identity_sha256": "c" * 64,
            "operator_ref": "d" * 40,
            "launch_sha256": "e" * 64,
            "source_ref": self.ref,
        }

    def write_meta(self):
        (self.registry / "meta").write_text("".join(k + "=" + v + "\n" for k, v in self.meta.items()))

    def tearDown(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=2)
        if self.old_mid is None:
            os.environ.pop("FLY_MACHINE_ID", None)
        else:
            os.environ["FLY_MACHINE_ID"] = self.old_mid
        self.tmp.cleanup()

    def test_registered_owner_pidfd_term_once_and_observe(self):
        planned = self.ns["execute"](dict(self.payload, action="plan"))
        self.assertEqual(planned["targets"], 1)
        result = self.ns["execute"](
            dict(
                self.payload,
                action="signal",
                batch=0,
                plan_sha256=planned["plan_sha256"],
            )
        )
        self.assertEqual(result["results"][0]["state"], "TERM_SENT_NOT_JOINED")
        self.assertEqual(self.child.wait(timeout=3), 0)
        repeat = self.ns["execute"](
            dict(
                self.payload,
                action="signal",
                batch=0,
                plan_sha256=planned["plan_sha256"],
            )
        )
        self.assertEqual(repeat["results"][0]["state"], "INTENT_EXISTS_UNKNOWN_NO_REPLAY")
        observed = self.ns["execute"](dict(self.payload, action="observe"))
        self.assertTrue(observed["no_signal"])
        self.assertEqual(len(observed["intents"]), 1)
        with self.assertRaises(ValueError):
            self.ns["execute"](dict(self.payload, action="plan"))

    def test_foreign_meta_and_pid_birth_are_held_before_intent(self):
        self.meta["pid_start"] = self.process["birth"] + "9"
        self.write_meta()
        planned = self.ns["execute"](dict(self.payload, action="plan"))
        self.assertEqual(planned["targets"], 0)
        self.assertEqual(planned["held"], 1)
        self.assertIsNone(self.child.poll())
        self.assertEqual(list((self.custody / "registered-orphan-drain").glob("term-*")), [])

    def test_identity_change_between_plan_and_effect_denies_signal(self):
        planned = self.ns["execute"](dict(self.payload, action="plan"))
        self.meta["run_id"] = "20261017-170847-" + str(self.child.pid)
        self.write_meta()
        result = self.ns["execute"](
            dict(
                self.payload,
                action="signal",
                batch=0,
                plan_sha256=planned["plan_sha256"],
            )
        )
        self.assertEqual(result["results"][0]["state"], "HELD")
        self.assertIsNone(self.child.poll())
        self.assertEqual(list((self.custody / "registered-orphan-drain").glob("term-*")), [])

    def test_process_uid_must_match_before_pidfd_intent(self):
        with self.assertRaisesRegex(ValueError, "UID"):
            self.ns["process"](self.child.pid, os.geteuid() + 1)
        self.assertIsNone(self.child.poll())
        self.assertFalse((self.custody / "registered-orphan-drain").exists())

    def test_ignored_term_never_spends_intent(self):
        child = subprocess.Popen(
            [
                "python3",
                "-S",
                "-c",
                'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(20)',
            ],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            with self.assertRaisesRegex(ValueError, "TERM"):
                self.ns["process"](child.pid)
        finally:
            child.kill()
            child.wait(timeout=2)
            child.stdout.close()

    def test_expired_joined_driver_and_pending_proofs_before_any_intent(self):
        actual = runpy.run_path(str(self.root / "orphan-guest.py"))["execute"].__globals__
        actual["pwd"] = SimpleNamespace(getpwnam=lambda name: SimpleNamespace(pw_uid=os.geteuid()))
        launch = {
            "source_ref": self.ref,
            "machine_id": "84ed412b11d168",
            "driver_pid": self.child.pid,
            "driver_birth": self.process["birth"],
            "common_git": str(self.common),
        }
        launch_raw = json.dumps(launch).encode()
        (self.custody / "launch.json").write_bytes(launch_raw)
        pending = dict(
            self.pending,
            status="pending",
            reason="live controller writers",
            record_sha256=hashlib.sha256(launch_raw).hexdigest(),
        )
        (self.custody / "pending.json").write_text(json.dumps(pending))
        command = {"machine_id": "84ed412b11d168", "source_ref": self.ref}
        raw = json.dumps(command).encode()
        (self.root / "controller-command.json").write_bytes(raw)
        joined = {
            "command_sha256": hashlib.sha256(raw).hexdigest(),
            "driver_pid": self.child.pid,
            "driver_birth": self.process["birth"],
            "exit_code": 247,
        }
        joined_path = self.root / "controller-command.joined.json"
        joined_path.write_text(json.dumps(joined))
        payload = dict(
            self.payload,
            machine="84ed412b11d168",
            epoch=time.time() - 6000,
            deadline=time.time() - 1,
            fleet_source_sha256=hashlib.sha256(self.script.read_bytes()).hexdigest(),
            launch_sha256=hashlib.sha256(launch_raw).hexdigest(),
            joined={
                "identity": {
                    "machine": "84ed412b11d168",
                    "source_ref": self.ref,
                    "epoch": time.time() - 6000,
                },
                "terminal": {
                    "parent_joined": True,
                    "supervisor_joined": True,
                    "parent_pid": 99999999,
                },
            },
        )
        payload["joined"]["identity"]["epoch"] = payload["epoch"]
        old = os.environ.get("GATE_REF")
        os.environ["GATE_REF"] = self.ref
        cwd = Path.cwd()
        try:
            self.assertEqual(actual["prerequisites"](payload, self.repo, self.custody)[0], self.repo)
            with self.assertRaisesRegex(ValueError, "clock"):
                actual["prerequisites"](dict(payload, deadline=time.time() + 60), self.repo, self.custody)
            joined_path.unlink()
            with self.assertRaises(FileNotFoundError):
                actual["prerequisites"](payload, self.repo, self.custody)
            self.assertFalse((self.custody / "registered-orphan-drain").exists())
        finally:
            os.chdir(cwd)
            if old is None:
                os.environ.pop("GATE_REF", None)
            else:
                os.environ["GATE_REF"] = old

    def test_compressed_command_keeps_exact_source_and_bound_body(self):
        body = M["command"](dict(self.payload, action="observe"))
        self.assertLess(len(json.dumps(body).encode()), 16384)
        argv = shlex.split(body["cmd"])
        source, value = json.loads(gzip.decompress(base64.b64decode(argv[-1])))
        self.assertEqual(source, M["GUEST"])
        self.assertEqual(value, dict(self.payload, action="observe"))
        self.assertEqual(body["timeout"], 18)


class NormalAgent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        guest = self.root / "guest.py"
        guest.write_text(M["GUEST"])
        self.g = runpy.run_path(str(guest))
        self.uid = os.geteuid()
        self.mid, self.ref, self.token = "a" * 14, "b" * 40, "c" * 32
        self.epoch = time.time() - 100
        agent = dict(
            pid=321,
            birth="agent-birth",
            ppid=1,
            uid=[self.uid] * 4,
            cwd="/tmp/gate/repo",
            children=[],
            exe="/tmp/gate/bin/flyctl",
            argv=[
                "/tmp/gate/bin/flyctl",
                "agent",
                "run",
                "/home/rose/.fly/agent-logs/123.log",
            ],
            environment={
                "CLOUDBENCH_FLEET_OWNER_TOKEN": self.token,
                "REVIEWED_OPERATOR_SOURCE_REF": self.ref,
                "REVIEWED_OPERATOR_ROOT": "/tmp/gate/repo",
            },
            fds={
                "8": "/home/rose/.fly/agent-logs/123.log",
                "9": "/home/rose/.fly/flyctl.agent.lock",
                "10": "socket:[77]",
            },
        )
        listener = {
            "77": dict(
                inode=77,
                type=1,
                state=10,
                name="/home/rose/.fly/fly-agent.sock",
                uid=self.uid,
                icons=[],
                queues=[0, 4096],
            )
        }
        self.c = dict(
            complete=True,
            errors=[],
            machine=self.mid,
            source_ref=self.ref,
            agent=agent,
            agent_after=json.loads(json.dumps(agent)),
            unix_before=listener,
            unix_after=json.loads(json.dumps(listener)),
            socket_owners={"321": {"socket_fds": [{"inode": 77, "fd": "10"}]}},
            binary={"sha256": "d" * 64},
            files={},
            fleet_runs=[dict(run="20261017-234329-9999999", owner_current=None)],
        )

        def evidence(path, raw):
            self.c["files"][path] = dict(
                body_b64=base64.b64encode(raw).decode(),
                sha256=hashlib.sha256(raw).hexdigest(),
                nlink=1,
                mode=0o100600,
                uid=self.uid,
            )

        launch = dict(common_git="/tmp/gate/repo/.git", machine_id=self.mid, source_ref=self.ref)
        evidence("/tmp/gate/controller-host-custody/launch.json", json.dumps(launch).encode())
        audit = "/tmp/gate/repo/.git/cloudbench-fleet-audits/" + self.token
        evidence(
            audit + "/meta",
            (
                "version=1\nfleet_owner_token="
                + self.token
                + "\nrun_id=20261017-234329-9999999\napp=navi-whisper-lux-bench\nworkspace_root=/tmp/gate/repo\nstatus=provider-teardown-verified\n"
            ).encode(),
        )
        evidence(
            audit + "/provider-teardown-verified.epoch",
            str(int(time.time() - 10)).encode(),
        )
        for name in ("owned-clones.ids", "owned-clones.names"):
            evidence(audit + "/" + name, b"")
        for name in (
            "/home/rose/.fly/agent-logs/123.log",
            "/home/rose/.fly/flyctl.agent.lock",
        ):
            evidence(name, b"retained")
        self.c["files"]["/home/rose/.fly/fly-agent.sock"] = {
            "mode": 0o140600,
            "uid": self.uid,
        }
        self.v = dict(
            role="normal-agent",
            agent_pid=321,
            agent_birth="agent-birth",
            binary_sha256="d" * 64,
            machine=self.mid,
            source_ref=self.ref,
            epoch=self.epoch,
            deadline=self.epoch + 5400,
            operator_ref="e" * 40,
            launch_sha256=self.c["files"]["/tmp/gate/controller-host-custody/launch.json"]["sha256"],
            identity_sha256="f" * 64,
        )
        patch = mock.patch.object(self.g["pwd"], "getpwnam", return_value=SimpleNamespace(pw_uid=self.uid))
        patch.start()
        self.addCleanup(patch.stop)

    def test_real_self_fd_census_and_agent_custody_negatives(self):
        endpoint, peer = socket.socketpair()
        self.addCleanup(peer.close)
        with endpoint:
            sockets, count = self.g["process_socket_fds"](Path("/proc") / str(os.getpid()))
            inode = int(os.readlink("/proc/self/fd/" + str(endpoint.fileno()))[8:-1])
            self.assertIn(inode, {item[0] for item in sockets})
            self.assertGreater(count, 0)
        self.assertEqual(
            self.g["agent_capture_proof"](self.c, self.v)["role"],
            "closed-fleet-default-agent",
        )
        for mutation in (
            "incomplete",
            "external",
            "queued",
            "changed",
            "owner",
            "binary",
        ):
            c = json.loads(json.dumps(self.c))
            if mutation == "incomplete":
                c["complete"] = False
            elif mutation == "external":
                c["socket_owners"]["999"] = {"socket_fds": [{"inode": 77, "fd": "3"}]}
            elif mutation == "queued":
                c["unix_before"]["77"]["icons"] = [88]
                c["unix_after"]["77"]["icons"] = [88]
            elif mutation == "changed":
                c["agent_after"]["birth"] = "foreign"
            elif mutation == "owner":
                c["fleet_runs"][0]["owner_current"] = {"pid": 9999999}
            else:
                c["binary"]["sha256"] = "0" * 64
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.g["agent_capture_proof"](c, self.v)

    def test_normal_public_check_plan_signal_once_and_export_custody(self):
        out = self.root / "run"
        out.mkdir(mode=0o700)
        capture = out / "capture.json"
        capture.write_text(json.dumps(self.c))
        capture.chmod(0o600)
        identity = dict(
            schema="original600-supervisor-identity-v1",
            pid=111,
            birth="supervisor",
            machine=self.mid,
            source_ref=self.ref,
            epoch=self.epoch,
        )
        joined = dict(
            state="JOINED",
            identity=identity,
            identity_sha256=hashlib.sha256((json.dumps(identity, sort_keys=True) + "\n").encode()).hexdigest(),
            terminal=dict(identity, parent_joined=True, supervisor_joined=True, parent_pid=112),
        )
        probe = out / "supervisor-probe-000001.json"
        probe.write_text(json.dumps(joined))
        probe.chmod(0o600)
        state = dict(
            schema="controller-normal-export-identities-v1",
            out=str(out),
            machine_id=self.mid,
            source_ref=self.ref,
            source_root=str(ROOT),
            caller={"identity_path": "/tmp/gate/repo/.context/original600-supervisor.fixture.json"},
            epoch=self.epoch,
            deadline=self.epoch + 5400,
            machine={
                "id": self.mid,
                "instance_id": "native",
                "config": {},
                "name": "fixture",
                "region": "iad",
            },
        )
        value = dict(
            state=state,
            binding={"launch_sha256": self.v["launch_sha256"]},
            record={
                "collector_sha256": "a" * 64,
                "root_anchors": {"/tmp/gate/repo": {"uid": self.uid}},
            },
            driver_sha256="d" * 64,
        )
        E = runpy.run_path(str(ROOT / "scripts/cloudbench-resume-controller-export.py"))
        checks = []

        def check(*_args):
            self.assertFalse(
                (out / "registered-orphan-drain").exists(),
                "partial own intent must not cause a second E.check",
            )
            checks.append(True)
            return value

        export = dict(check=check, unchanged=lambda _value: None, REMOTE=E["REMOTE"])
        real_runpy = M["runpy"].run_path

        def load(path, *a, **k):
            return export if str(path).endswith("cloudbench-resume-controller-export.py") else real_runpy(path, *a, **k)

        args = SimpleNamespace(
            normal_agent=True,
            agent_custody=capture,
            config=self.root / "config",
            config_sha256="a" * 64,
            run_directory=out,
            operator_ref="e" * 40,
            observe=False,
        )
        custody = self.root / "guest-custody"
        custody.mkdir()
        sent = []

        def execute(payload):
            return self.g["agent_execute"](payload, custody)

        class API:
            def api(inner, method, path, body=None, timeout=20, observer=None):
                if method == "GET":
                    result = state["machine"]
                else:
                    cmd = shlex.split(body["cmd"])
                    source, payload = json.loads(gzip.decompress(base64.b64decode(cmd[-1])))
                    remote_file = self.root / "real-remote-top-level.py"
                    remote_file.write_text(E["REMOTE"])
                    diagnostic = io.StringIO()
                    with contextlib.redirect_stderr(diagnostic):
                        runpy.run_path(str(remote_file))
                    result = {
                        "exit_code": 0,
                        "exit_signal": 0,
                        "stderr": diagnostic.getvalue(),
                        "stdout": json.dumps(execute(payload)),
                    }
                raw = json.dumps(result).encode()
                if observer:
                    observer(method, path, 200, raw)
                return result

        with (
            mock.patch.object(M["runpy"], "run_path", side_effect=load),
            mock.patch.dict(M["B"], source_identity=lambda *_a: {}),
            mock.patch.object(M["subprocess"], "check_output", return_value=b"bound-fleet"),
            mock.patch.dict(M["F"], api_for=lambda _s: API()),
            mock.patch.object(self.g["os"], "chdir", lambda _p: None),
            mock.patch.dict(
                self.g["agent_execute"].__globals__,
                agent_capture=lambda _v: json.loads(json.dumps(self.c)),
                agent_closed_writer=lambda _v: {"sole": True},
                unix_dump=lambda: {int(k): v for k, v in self.c["unix_after"].items()},
                process_socket_fds=lambda _p: ([(77, "10")], 1),
                process=lambda *_a: {"birth": "agent-birth", "cwd": "/tmp/gate/repo"},
            ),
            mock.patch.object(self.g["os"], "pidfd_open", return_value=123),
            mock.patch.object(self.g["os"], "close", lambda _fd: None),
            mock.patch.object(self.g["select"], "select", side_effect=[([], [], []), ([123], [], [])]),
            mock.patch.object(
                self.g["signal"],
                "pidfd_send_signal",
                side_effect=lambda *_a: sent.append(True),
            ),
        ):
            checked = M["local_state"](args)
            result = M["run"](args, checked)
            self.assertEqual(result["status"], "REGISTERED_AGENT_TERM_REQUESTED")
            self.assertEqual(len(checks), 1)
            self.assertEqual(sent, [True])
            payload = json.loads((out / "registered-orphan-drain/intent.json").read_bytes())["payload"]
            (custody / "registered-orphan-drain" / "result-321.json").unlink()
            replay = execute(
                dict(
                    payload,
                    action="signal",
                    batch=0,
                    plan_sha256=hashlib.sha256(
                        (custody / "registered-orphan-drain/plan.json").read_bytes()
                    ).hexdigest(),
                )
            )
            self.assertEqual(replay["status"], "INTENT_EXISTS_UNKNOWN_NO_REPLAY")
            self.assertEqual(sent, [True])
        binding = E["local_drain_binding"](out, {})
        guestfiles = {
            str(p.relative_to(custody / "registered-orphan-drain")): {
                "bytes": p.stat().st_size,
                "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                "body_b64": base64.b64encode(p.read_bytes()).decode(),
            }
            for p in (custody / "registered-orphan-drain").rglob("*")
            if p.is_file()
        }
        E["require_recorded_drain"](binding, {"present": True, "files": guestfiles})

    def test_known_phase_requires_positive_plan_and_no_unknown_stderr(self):
        payload = dict(self.v)
        response = dict(
            exit_code=0,
            exit_signal=0,
            stderr="EXPORT_PHASE REMOTE_ENTERED 123\n",
            stdout=json.dumps(dict(status="PLANNED", targets=1, held=0, plan_sha256="a" * 64)),
        )
        self.assertEqual(M["successful_agent_response"](response, payload, "plan")["targets"], 1)
        for text in (
            "foreign\n",
            "EXPORT_PHASE REMOTE_ENTERED 123\nextra\n",
            "EXPORT_PHASE REMOTE_ENTERED 123\nEXPORT_PHASE REMOTE_ENTERED 124\n",
        ):
            with self.assertRaises(ValueError):
                M["successful_agent_response"](dict(response, stderr=text), payload, "plan")
        with self.assertRaises(ValueError):
            M["successful_agent_response"](
                dict(
                    response,
                    stdout=json.dumps(dict(status="PLANNED", targets=2, held=0, plan_sha256="a" * 64)),
                ),
                payload,
                "plan",
            )

    def test_saved_plan_run_keeps_old_identity_and_never_replans(self):
        out = self.root / "continuation-run"
        old = out / "registered-orphan-drain"
        old.mkdir(parents=True, mode=0o700)
        payload = dict(self.v, operator_ref="1" * 40, fleet_source_sha256="a" * 64)
        original = json.dumps({"payload": payload}).encode()
        (old / "intent.json").write_bytes(original)
        (old / "intent.json").chmod(0o600)
        plan = dict(status="PLANNED", targets=1, held=0, plan_sha256="b" * 64)
        state = dict(
            out=str(out),
            machine_id=self.mid,
            machine={
                "id": self.mid,
                "instance_id": "native",
                "config": {},
                "name": "fixture",
                "region": "iad",
            },
            cleanup_deadline_epoch=1792286550.425,
            cleanup_hold_id="w986k6vhvhm3sftz2y0a0tambs8ghw4d",
            cleanup_only=True,
            _drain={},
            _saved_plan={
                "payload": payload,
                "plan": plan,
                "inputs": {str(old / "wire-000002.raw.json"): "c" * 64},
            },
        )
        args = SimpleNamespace(normal_agent=False, observe=False, operator_ref="2" * 40)
        actions = []

        class API:
            def api(inner, method, path, body=None, timeout=20, observer=None):
                if method == "GET":
                    result = state["machine"]
                else:
                    _, value = json.loads(gzip.decompress(base64.b64decode(shlex.split(body["cmd"])[-1])))
                    actions.append(value["action"])
                    self.assertEqual(value["operator_ref"], "1" * 40)
                    self.assertEqual(value["cleanup_deadline_epoch"], state["cleanup_deadline_epoch"])
                    self.assertEqual(value["execution_operator_ref"], args.operator_ref)
                    result = dict(
                        exit_code=0,
                        exit_signal=0,
                        stderr="EXPORT_PHASE REMOTE_ENTERED 123\n",
                        stdout=json.dumps(dict(status="BATCH_FINISHED", results=[{"pid": 321}])),
                    )
                raw = json.dumps(result).encode()
                if observer:
                    observer(method, path, 200, raw)
                return result

        with (
            mock.patch.dict(M["_run"].__globals__, local_state=lambda _args: state),
            mock.patch.dict(M["F"], api_for=lambda _state: API()),
        ):
            M["_run"](args, state)
        self.assertEqual(actions, ["signal"])
        continuation = json.loads((out / "registered-orphan-drain-plan-continuation/intent.json").read_bytes())
        self.assertEqual(continuation["payload"], payload)
        self.assertEqual(continuation["cleanup_deadline_epoch"], state["cleanup_deadline_epoch"])
        self.assertEqual((old / "intent.json").read_bytes(), original)
        adopted = json.loads((old / "result-adopted-plan.json").read_bytes())
        self.assertEqual(adopted["observed_under_operator_ref"], "2" * 40)

    def test_saved_positive_plan_parser_binds_old_raw_and_source(self):
        out = self.root / "saved-parser"
        journal = out / "registered-orphan-drain"
        journal.mkdir(parents=True)
        producer = self.root / "old-producer"
        producer.mkdir()
        old_source = subprocess.check_output(
            [
                "git",
                "-C",
                str(ROOT),
                "show",
                "30eb08e7ead85d03a44edf06cc557c8888ba4267:scripts/cloudbench-controller-orphan-drain.py",
            ]
        )
        old_path = producer / "cloudbench-controller-orphan-drain.py"
        # saved_positive_plan reads this through the private-file reader
        # (owner-only mode); create it 0600 explicitly rather than through
        # the inherited umask, which is 022 under the deploy lane's service.
        with os.fdopen(os.open(old_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(old_source)
        for path in (ROOT / "scripts").iterdir():
            if path.is_file() and path.name != old_path.name:
                (producer / path.name).symlink_to(path)
        old_module = runpy.run_path(str(old_path))
        old_hashes = {
            name: hashlib.sha256(
                subprocess.check_output(
                    [
                        "git",
                        "-C",
                        str(ROOT),
                        "show",
                        "30eb08e7ead85d03a44edf06cc557c8888ba4267:scripts/" + name,
                    ]
                )
            ).hexdigest()
            for name in (
                "cloudbench-controller-orphan-drain.py",
                "cloudbench-resume-controller-export.py",
                "cloudbench-controller-payload-finalization.py",
                "cloudbench-original600-runner.py",
                "cloudbench-resume-controller-payload.py",
                "cloudbench-original-volume-capture.py",
            )
        }
        record = dict(
            machine_id=self.mid,
            source_ref=self.ref,
            caller={"pid": 456, "birth": "gate"},
        )
        (out / "export").mkdir()
        launch = out / "export/launch.json"
        launch.write_text(json.dumps(record))
        launch.chmod(0o600)
        payload = dict(
            self.v,
            operator_ref="30eb08e7ead85d03a44edf06cc557c8888ba4267",
            export_probe={"record": record, "driver_sha256": "a" * 64},
        )
        payload["launch_sha256"] = hashlib.sha256(launch.read_bytes()).hexdigest()
        payload.pop("identity_sha256")
        payload["identity_sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        intent = {
            "payload": payload,
            "operator": {
                "role": "normal-agent",
                "source_hashes": old_hashes,
                "source_pins": {str(old_path): M["F"]["normalized"](M["B"]["fingerprint"](old_path))},
            },
        }

        def write_json(path, value):
            path.write_text(json.dumps(value))
            path.chmod(0o600)

        write_json(journal / "intent.json", intent)
        machine = {
            "id": self.mid,
            "instance_id": "native",
            "config": {},
            "name": "fixture",
            "region": "iad",
        }
        result = {
            "exit_code": 0,
            "exit_signal": 0,
            "stderr": "EXPORT_PHASE REMOTE_ENTERED 123\n",
            "stdout": json.dumps(dict(status="PLANNED", targets=1, held=0, plan_sha256="a" * 64)),
        }
        for i, (request, decoded) in enumerate(
            (
                (
                    {"method": "GET", "path": "/machines/" + self.mid, "body": None},
                    machine,
                ),
                (
                    {
                        "method": "POST",
                        "path": "/machines/" + self.mid + "/exec",
                        "body": old_module["command"](dict(payload, action="plan")),
                    },
                    result,
                ),
            ),
            1,
        ):
            raw = json.dumps(decoded).encode()
            stem = journal / ("wire-00000" + str(i))
            for suffix, value in (
                (".request.json", request),
                (".decoded.json", decoded),
                (
                    ".raw.json",
                    dict(
                        status=200,
                        method=request["method"],
                        path=request["path"],
                        bytes=len(raw),
                        sha256=hashlib.sha256(raw).hexdigest(),
                        body_b64=base64.b64encode(raw).decode(),
                    ),
                ),
            ):
                write_json(Path(str(stem) + suffix), value)
        state = dict(
            machine_id=self.mid,
            source_ref=self.ref,
            epoch=self.epoch,
            deadline=self.epoch + 5400,
            machine=machine,
            caller={"gate_pid": 456, "gate_birth": "gate"},
        )
        args = SimpleNamespace(
            run_directory=out,
            config=self.root / "config",
            config_sha256="b" * 64,
            operator_ref="c" * 40,
        )
        export = {"normal_state": lambda *_a: state}
        self.assertEqual(M["saved_positive_plan"](args, export)["plan"]["targets"], 1)
        extra = journal / "foreign.json"
        extra.write_text("{}")
        with self.assertRaises(ValueError):
            M["saved_positive_plan"](args, export)
        extra.unlink()
        raw_path = journal / "wire-000002.raw.json"
        original = raw_path.read_bytes()
        wire = json.loads(original)
        wire["sha256"] = "0" * 64
        write_json(raw_path, wire)
        with self.assertRaises(ValueError):
            M["saved_positive_plan"](args, export)
        raw_path.write_bytes(original)
        old_path.write_bytes(old_source + b"\n# changed old source\n")
        with self.assertRaises(ValueError):
            M["saved_positive_plan"](args, export)


class CleanupExecution(unittest.TestCase):
    def test_guest_cutoff_is_separate_from_saved_plan_identity(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "guest.py"
            p.write_text(M["GUEST"])
            guest = runpy.run_path(str(p))
        clock = guest["agent_cleanup_deadline"]
        payload = dict(epoch=1792279176.5459259, deadline=1792284576.5459259)
        self.assertEqual(clock(payload), payload["deadline"])
        execution = dict(
            payload, cleanup_deadline_epoch=1792286550.425, cleanup_hold_id="w986k6vhvhm3sftz2y0a0tambs8ghw4d"
        )
        with mock.patch.dict(clock.__globals__, time=SimpleNamespace(time=lambda: 1792285351)):
            self.assertEqual(clock(execution), execution["cleanup_deadline_epoch"])
            self.assertNotIn("cleanup_deadline_epoch", payload)
            for delta in [dict(epoch=1), dict(cleanup_deadline_epoch=1792286551), dict(cleanup_hold_id="foreign")]:
                with self.assertRaises(Exception):
                    clock(dict(execution, **delta))
        with mock.patch.dict(clock.__globals__, time=SimpleNamespace(time=lambda: 1792286550.425)):
            with self.assertRaises(Exception):
                clock(execution)


class SavedEnvelope(unittest.TestCase):
    def test_sorted_intent_roundtrip_preserves_exact_semantics(self):
        original = dict(z=1, machine="a" * 14, action="plan", a=2)
        saved = json.loads(json.dumps(original, sort_keys=True))
        actual, expected = M["command"](original), M["command"](saved)
        self.assertNotEqual(actual, expected)
        validate = M["saved_command_matches"]
        self.assertTrue(validate(actual, expected, M["GUEST"], saved))
        for changed in [
            dict(actual, timeout=19),
            dict(actual, machine=False),
            dict(actual, extra=True),
            M["command"](dict(saved, action="signal")),
        ]:
            with self.assertRaises(Exception):
                validate(changed, expected, M["GUEST"], saved)
        argv = shlex.split(actual["cmd"])
        for pos, value in [
            (0, "python"),
            (3, "foreign loader"),
            (-1, base64.b64encode(gzip.compress(json.dumps(["foreign", saved]).encode())).decode()),
        ]:
            altered = list(argv)
            altered[pos] = value
            with self.assertRaises(Exception):
                validate(dict(actual, cmd=shlex.join(altered)), expected, M["GUEST"], saved)


if __name__ == "__main__":
    unittest.main()
