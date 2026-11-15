#!/usr/bin/env python3
"""Stale smoke guests: archive evidence to R2 with read-back, then destroy; retain on failure.

Provider boundaries are local fakes: an in-memory Machines API whose flyctl
SSH/SFTP runs the real guest collector against a fixture /data volume, and an
in-memory R2 bucket. Covers capture-then-destroy, capture failure -> retain and
the protected warm donor left untouched.
"""
from __future__ import annotations

import copy
import datetime
import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import runpy

SCRIPTS = Path(__file__).resolve().parents[1]
H = runpy.run_path(str(SCRIPTS / "cloudbench-evidence-archive.py"))
CAP = H["sibling"]("cloudbench-original-volume-capture.py")
APP = "fixture-app"
MID = "0123456789abcd"
VOL = "vol_0123456789abcdef"
TOKEN = "f" * 32 + "-0"
NOW = datetime.datetime(2026, 11, 14, tzinfo=datetime.timezone.utc)
PREFIX = f"smoke-evidence/{MID}/20261114T000000Z"


class ClientError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self, events: list, fail_put: bool = False) -> None:
        self.objects: dict[str, bytes] = {}
        self.racing: set[str] = set()  # created by a concurrent run after this run's HEAD check
        self.events, self.fail_put = events, fail_put

    def head_object(self, Bucket, Key):
        if Key not in self.objects or Key in self.racing:
            raise ClientError("404")
        return {}

    def put_object(self, Bucket, Key, Body, ContentType, Metadata, IfNoneMatch=None):
        if self.fail_put:
            raise RuntimeError("R2 unavailable")
        assert IfNoneMatch == "*", "R2 object creation must be conditional"
        if Key in self.objects:
            raise ClientError("PreconditionFailed")
        assert Metadata["sha256"] == hashlib.sha256(Body).hexdigest()
        self.events.append(("PUT", Key))
        self.objects[Key] = bytes(Body)

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.objects[Key])}


class FakeFly:
    """Machines API state machine plus a flyctl that emulates SSH/SFTP on a local guest root."""

    def __init__(self, root: Path, events: list, machine: dict, volume: dict) -> None:
        self.root, self.events = root, events
        self.machines = {machine["id"]: machine}
        self.volumes = {volume["id"]: volume}
        self.proc = root / "proc"

    def machine(self, ident):
        self.events.append(("GET", f"/machines/{ident}"))
        if ident not in self.machines:
            raise CAP["NotFound"](ident)
        return copy.deepcopy(self.machines[ident])

    def volume(self, ident):
        self.events.append(("GET", f"/volumes/{ident}"))
        if ident not in self.volumes:
            raise CAP["NotFound"](ident)
        return copy.deepcopy(self.volumes[ident])

    def api(self, method, path, body=None, **_):
        self.events.append((method, path))
        parts = path.strip("/").split("/")
        if parts[0] == "machines":
            machine = self.machines[parts[1]]
            if method == "POST" and len(parts) == 2:
                assert machine["state"] in ("stopped", "created") and body["skip_launch"] is True
                machine["config"] = copy.deepcopy(body["config"])
            elif method == "POST" and parts[2] == "start":
                machine["state"] = "started"
            elif method == "POST" and parts[2] == "stop":
                machine["state"] = "stopped"
            elif method == "DELETE":
                assert machine["state"] == "stopped", "destroying a live Machine"
                machine["state"] = "destroyed"
                for volume in self.volumes.values():
                    if volume["attached_machine_id"] == parts[1]:
                        volume["attached_machine_id"] = None
            return {}
        if parts[0] == "volumes" and method == "DELETE":
            volume = self.volumes[parts[1]]
            if volume["attached_machine_id"]:
                raise CAP["CaptureFailure"]("volume is attached")
            volume["state"] = "pending_destroy"
            return {}
        raise AssertionError(f"unexpected API call {method} {path}")

    def local(self, remote: str) -> str:
        return str(self.root) + remote if remote.startswith(("/tmp/", "/data")) else remote

    def flyctl(self, seconds, *args):
        self.events.append(("FLYCTL",) + args[:3])
        machine = self.machines[args[args.index("--machine") + 1]]
        if machine["state"] != "started":
            return 1, "", "machine is not started"
        if args[:2] == ("ssh", "console"):
            command = shlex.split(args[args.index("-C") + 1])
            if command[:3] == ["mkdir", "-m", "700"]:
                os.makedirs(self.local(command[3]), mode=0o700)
                return 0, "", ""
            assert command[:3] == ["python3", "-I", "-B"], command
            argv = [sys.executable, "-I", "-B"] + [self.local(token) for token in command[3:]] + ["--proc", str(self.proc)]
            done = subprocess.run(argv, capture_output=True, text=True, timeout=60)
            return done.returncode, done.stdout, done.stderr
        if args[:3] == ("ssh", "sftp", "put"):
            shutil.copyfile(args[-2], self.local(args[-1]))
            return 0, "", ""
        if args[:3] == ("ssh", "sftp", "get"):
            shutil.copyfile(self.local(args[-2]), args[-1])
            return 0, "", ""
        raise AssertionError(f"unexpected flyctl {args}")


def original_config() -> dict:
    return {
        "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
        "env": {"CLOUDBENCH_RUN_TOKEN": TOKEN, "CLOUDBENCH_BARRIER_TOKEN": "secret-barrier-xyz", "PLAIN": "kept"},
        "mounts": [{"volume": VOL, "path": "/data"}],
        "services": [{"internal_port": 8011}],
        "files": [{"guest_path": "/cloudbench-boot-payload.json.gz", "raw_value": "c2VjcmV0LXBheWxvYWQ="}],
        "image": "registry.fly.io/fixture:img",
    }


class EvidenceArchive(unittest.TestCase):
    def setUp(self) -> None:
        # Resolved: the guest collector refuses any original path that is not already canonical.
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"CLOUDBENCH_CAPTURE_POLL_SECONDS": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)
        guest = self.tmp / "guest"
        data = guest / "data"
        context = data / "repo/.context/cloudbench"
        (context / "logs").mkdir(parents=True)
        (data / "repo/front-end").mkdir(parents=True)
        (data / "repo/node_modules/pkg").mkdir(parents=True)
        (guest / "tmp").mkdir()
        (data / "bench.log").write_text(f"RUNSTAMP-{TOKEN}\nbenchmark failed at step 3\n")
        (data / "cloudbench-driver.state").write_text("exited\n")
        (context / "services.json").write_text('{"status": "stopped"}\n')
        (context / "logs/backend.log").write_text("backend 500 at /api/agents\n")
        (context / "cloudflared.log").write_text("tunnel up\n")
        (data / "repo/front-end/frontend-logs.log").write_text("vite ready\n")
        (data / "repo/node_modules/pkg/noise.log").write_text("dependency noise\n")
        # Fixture PIDs above PID_MAX_LIMIT never collide with the collector's own (skipped) PIDs.
        (guest / "proc/4194399").mkdir(parents=True)
        (guest / "proc/4194399/cmdline").write_bytes(b"sleep\0infinity\0")
        self.events: list = []
        self.original = original_config()
        machine = {"id": MID, "name": "cloudbench-0123456789abcdef0123", "state": "stopped",
                   "region": "iad", "instance_id": "i-1", "config": copy.deepcopy(self.original)}
        volume = {"id": VOL, "name": "cloudbench_data", "state": "created", "attached_machine_id": MID, "size_gb": 40}
        self.fly = FakeFly(guest, self.events, machine, volume)
        self.s3 = FakeS3(self.events)
        self.receipts = self.tmp / "receipts"

    def run_capture(self, **kwargs):
        err, out = io.StringIO(), io.StringIO()
        with redirect_stderr(err), redirect_stdout(out):
            code = H["capture_destroy"](self.fly, H["R2Store"](self.s3, "trace-bucket"), app=APP, machine_id=kwargs.pop("machine_id", MID),
                                        volume_id=kwargs.pop("volume_id", VOL), run_token=kwargs.pop("run_token", TOKEN),
                                        receipt_dir=self.receipts, attempts=1, ssh_seconds=30, wait_seconds=5,
                                        now=NOW, **kwargs)
        return code, err.getvalue(), out.getvalue()

    def mutations(self) -> list:
        return [event for event in self.events if event[0] in ("POST", "DELETE", "PUT", "FLYCTL")]

    def assert_retained_original(self) -> None:
        machine, volume = self.fly.machines[MID], self.fly.volumes[VOL]
        self.assertEqual(machine["state"], "stopped")
        self.assertEqual(machine["config"], self.original)
        self.assertEqual((volume["state"], volume["attached_machine_id"]), ("created", MID))
        self.assertNotIn("DELETE", [event[0] for event in self.events])

    def test_capture_then_destroy(self) -> None:
        code, err, _ = self.run_capture()
        self.assertEqual(code, 0, err)
        names = {"evidence.tar.gz", "inventory.json", "machine-config.redacted.json", "manifest.json", "destroy-receipt.json"}
        self.assertEqual(set(self.s3.objects), {f"{PREFIX}/{name}" for name in names})
        manifest = json.loads(self.s3.objects[f"{PREFIX}/manifest.json"])
        self.assertEqual((manifest["machine_id"], manifest["volume_id"], manifest["run_token"]), (MID, VOL, TOKEN))
        for name, row in manifest["objects"].items():
            self.assertEqual(hashlib.sha256(self.s3.objects[f"{PREFIX}/{name}"]).hexdigest(), row["sha256"])
        with tarfile.open(fileobj=io.BytesIO(self.s3.objects[f"{PREFIX}/evidence.tar.gz"])) as archive:
            members = {m.name: archive.extractfile(m).read() for m in archive.getmembers()}
        self.assertEqual(members["bench.log"], f"RUNSTAMP-{TOKEN}\nbenchmark failed at step 3\n".encode())
        self.assertIn("repo/.context/cloudbench/logs/backend.log", members)
        self.assertIn("repo/.context/cloudbench/cloudflared.log", members)
        self.assertIn("repo/front-end/frontend-logs.log", members)
        self.assertFalse(any("node_modules" in name for name in members))
        config = self.s3.objects[f"{PREFIX}/machine-config.redacted.json"]
        self.assertNotIn(b"secret-barrier-xyz", config)
        self.assertNotIn(b"c2VjcmV0LXBheWxvYWQ=", config)
        self.assertIn(b'"PLAIN": "kept"', config)
        # Destroy only after every evidence object was written and read back.
        manifest_put = self.events.index(("PUT", f"{PREFIX}/manifest.json"))
        first_delete = next(i for i, e in enumerate(self.events) if e[0] == "DELETE")
        self.assertLess(manifest_put, first_delete)
        self.assertEqual([e for e in self.events if e[0] == "DELETE"],
                         [("DELETE", f"/machines/{MID}"), ("DELETE", f"/volumes/{VOL}")])
        self.assertEqual(self.fly.machines[MID]["state"], "destroyed")
        self.assertEqual(self.fly.volumes[VOL]["state"], "pending_destroy")
        receipt = json.loads(next(self.receipts.glob(f"{MID}/*/receipt.json")).read_text())
        self.assertEqual(receipt["kind"], "archived-then-destroyed")
        self.assertEqual(receipt["final"]["volume"]["state"], "pending_destroy")

    def test_capture_only_restores_original_for_fleet_reap(self) -> None:
        code, err, _ = self.run_capture(capture_only=True)
        self.assertEqual(code, 0, err)
        self.assertIn(f"{PREFIX}/manifest.json", self.s3.objects)
        self.assertNotIn(f"{PREFIX}/destroy-receipt.json", self.s3.objects)
        self.assert_retained_original()

    def test_r2_failure_retains_stopped_original(self) -> None:
        self.s3.fail_put = True
        code, err, _ = self.run_capture()
        self.assertEqual(code, 2)
        self.assertIn("RETAINED", err)
        self.assert_retained_original()
        failure = json.loads(next(self.receipts.glob(f"{MID}/*/capture-failure.json")).read_text())
        self.assertEqual((failure["stage"], failure["restored"]), ("r2-upload", True))

    def test_guest_refusal_retains_stopped_original(self) -> None:
        (self.fly.proc / "4194400").mkdir()
        (self.fly.proc / "4194400/cmdline").write_bytes(b"bash\0/cloudbench-boot.sh\0")
        code, err, _ = self.run_capture()
        self.assertEqual(code, 2)
        self.assertIn("guest is not inert", err)
        self.assertEqual(self.s3.objects, {})
        self.assert_retained_original()

    def test_capture_deadline_retains_and_saved_original_restores(self) -> None:
        real = self.fly.flyctl

        def hung(seconds, *args):
            if args[:2] == ("ssh", "console"):
                # A hung SSH call: block until the helper's SIGALRM capture deadline interrupts it.
                # Bounded, so a missing deadline fails the assertions below instead of hanging.
                threading.Event().wait(30)
            return real(seconds, *args)

        self.fly.flyctl = hung
        code, err, _ = self.run_capture(capture_seconds=1)
        self.assertEqual(code, 2, err)
        self.assertIn("interrupted by signal", err)
        self.assert_retained_original()
        saved = next(self.receipts.glob(f"{MID}/*/original-config.private.json"))
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(saved.read_text()), self.original)
        # A SIGKILL mid-capture strands the inert config; the saved original restores it.
        self.fly.machines[MID].update(state="started", config=CAP["inert_variant"](self.original))
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(H["restore_original"](self.fly, APP, MID, saved, wait_seconds=5), 0)
        self.assert_retained_original()

    def test_existing_r2_key_is_never_overwritten(self) -> None:
        self.s3.objects[f"{PREFIX}/evidence.tar.gz"] = b"earlier capture"
        code, err, _ = self.run_capture()
        self.assertEqual(code, 2, err)
        self.assertEqual(self.s3.objects, {f"{PREFIX}/evidence.tar.gz": b"earlier capture"})
        self.assert_retained_original()

    def test_concurrent_creation_is_never_replaced(self) -> None:
        key = f"{PREFIX}/evidence.tar.gz"
        self.s3.objects[key] = b"concurrent capture"
        self.s3.racing.add(key)  # passes this run's HEAD check, then wins the create
        code, err, _ = self.run_capture()
        self.assertEqual(code, 2, err)
        self.assertIn("refusing to overwrite", err)
        self.assertEqual(self.s3.objects, {key: b"concurrent capture"})
        self.assert_retained_original()

    def test_protected_warm_donor_untouched(self) -> None:
        donor = "683e47df5094d8"
        code, err, _ = self.run_capture(machine_id=donor)
        self.assertEqual(code, 3, err)
        self.assertEqual(self.events, [])
        code, err, _ = self.run_capture(extra_protected=frozenset({MID}))
        self.assertEqual(code, 3, err)
        self.assertEqual(self.events, [])
        self.fly.machines[MID]["name"] = "cloudbench-warm-20261109"
        code, err, _ = self.run_capture()
        self.assertEqual(code, 3, err)
        self.fly.machines[MID]["name"] = "cloudbench-0123456789abcdef0123"
        for name in ("cloudbench_warm_data", "warmpool_7d466db0eb3b"):
            self.fly.volumes[VOL]["name"] = name
            code, err, _ = self.run_capture()
            self.assertEqual(code, 3, err)
            self.assertIn("protected", err)
        self.fly.volumes[VOL]["name"] = "cloudbench_data"
        code, err, _ = self.run_capture(extra_protected=frozenset({VOL}))
        self.assertEqual(code, 3, err)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.s3.objects, {})

    def test_live_foreign_or_missing_guest_is_refused_untouched(self) -> None:
        self.fly.machines[MID]["state"] = "started"
        self.assertEqual(self.run_capture()[0], 3)
        self.fly.machines[MID]["state"] = "stopped"
        self.assertEqual(self.run_capture(run_token="e" * 32 + "-0")[0], 3)
        self.assertEqual(self.run_capture(volume_id="vol_ffffffffffffffff")[0], 3)
        self.assertEqual(self.run_capture(machine_id="ffffffffffffff")[0], 3)
        self.assertEqual(self.mutations(), [])


if __name__ == "__main__":
    unittest.main()
