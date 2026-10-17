#!/usr/bin/env python3
"""Local kernel/process controls for the registered-owner drain; no provider calls."""

import base64
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
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-controller-orphan-drain.py"))


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
        self.script.write_text(
            "trap 'exit 0' TERM\nwhile :; do read -r -t .1 ignored || true; done\n"
        )
        self.token = "a" * 32
        self.registry = self.common / "cloudbench-fleet-ownership" / self.token
        self.registry.mkdir(parents=True)
        self.audit = self.common / "cloudbench-fleet-audits" / self.token
        self.audit.mkdir(parents=True)
        self.seed = (
            self.repo
            / ".context/benchmarks/campaigns/exact/startup-cohorts/c001/seed-proof.private.json"
        )
        self.seed.parent.mkdir(parents=True)
        self.ref = "b" * 40
        self.taskref = "570830dbf17635e13d16a6f03b4d705f6b6443b1"
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
        jobs = {
            "r001-j" + str(i).zfill(4): self.child.pid if i == 1 else 100000 + i
            for i in range(1, 601)
        }
        (self.seed.parent / "manifest.json").write_text(
            json.dumps({"cohort_id": "c001", "jobs": jobs})
        )
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
        self.pending = {
            "writers": [{"pid": self.child.pid, "birth": self.process["birth"]}]
        }
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
        (self.registry / "meta").write_text(
            "".join(k + "=" + v + "\n" for k, v in self.meta.items())
        )

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
        self.assertEqual(
            repeat["results"][0]["state"], "INTENT_EXISTS_UNKNOWN_NO_REPLAY"
        )
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
        self.assertEqual(
            list((self.custody / "registered-orphan-drain").glob("term-*")), []
        )

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
        self.assertEqual(
            list((self.custody / "registered-orphan-drain").glob("term-*")), []
        )

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
        actual = runpy.run_path(str(self.root / "orphan-guest.py"))[
            "execute"
        ].__globals__
        actual["pwd"] = SimpleNamespace(
            getpwnam=lambda name: SimpleNamespace(pw_uid=os.geteuid())
        )
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
            self.assertEqual(
                actual["prerequisites"](payload, self.repo, self.custody)[0], self.repo
            )
            with self.assertRaisesRegex(ValueError, "clock"):
                actual["prerequisites"](
                    dict(payload, deadline=time.time() + 60), self.repo, self.custody
                )
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


if __name__ == "__main__":
    unittest.main()
