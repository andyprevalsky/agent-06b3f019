#!/usr/bin/env python3
"""Recover a quarantined owner whose stopped guest never received its shutdown.

When the controller cannot deliver the authenticated guest shutdown, it stops
the guest natively and writes ``guest-native-stop.json`` (delivery_receipt
"absent"). The owner is then quarantined (``cleanup_policy=retain`` plus
``guest-cleanup-unconfirmed``) and the guest's provider-session log exists only
on the stopped volume. Exact-owner recovery refused it ("stopped exact Machine
has no sealed provider-state proof") and the original-volume capture refused
the quarantined owner ("owner cleanup policy is not reap"), so the owner could
never be released.

``cloudbench-original-volume-capture.py --undelivered-native-stop`` admits only
that exact verified record, captures the original files through the existing
inert boot, and publishes the backend log and provider manifest that recovery's
stopped-guest branch consumes. Every other state keeps its existing refusal.
The real session-cleanup helper then seals the stopped-Machine proof from those
inputs, as recovery does.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import io
import json
import os
import runpy
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/cloudbench-original-volume-capture.py"
SESSION = ROOT / "scripts/cloudbench-exact-session-cleanup.py"
OWNER = "8eb29986528f4cf7b3be90e495ebe0fc"
RUN_ID = "20261023-063527-3731387"
APP = "fixture-bench-app"
BENCH = "browser-auth-saved-password-retry"
MACHINE = "83d16e1b504508"
VOLUME = "vol_49156x61dwdoqk9r"
CLONE = "cloudbench-e09898b0b02b492798d0909c"
TOKEN = f"{OWNER}-0"
ROOT_AGENT = "0f3c2a5e-1111-4222-8333-944455556666"
KERNEL_SESSION = "kernelsessionabc123"


def write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    path.chmod(0o600)


def dead_pid_identity() -> tuple[str, str]:
    child = subprocess.Popen(["sleep", "30"])
    start = subprocess.run(
        ["bash", "-c", f'source "{ROOT}/scripts/lib/cloudbench-env.sh"; cloudbench_pid_start_time {child.pid}'],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    child.kill()
    child.wait()
    assert start
    return str(child.pid), start


BACKEND_LOG = (
    "[Server] Server started\n"
    "[HTTP] POST /api/agents -> 201 (12ms)\n"
    f"[HTTP] GET path=/api/agents/{ROOT_AGENT} -> 200\n"
    f"[Kernel] Created Kernel browser session sessionId={KERNEL_SESSION} agentId={ROOT_AGENT}\n"
)


class FakeFly:
    """Shared native state for the exact Machine and volume; journals every mutation."""

    def __init__(self, state: dict) -> None:
        self.state = state

    def machine(self, machine_id: str) -> dict:
        machine = self.state["machines"].get(machine_id)
        if machine is None:
            raise self.state["NotFound"]()
        return copy.deepcopy(machine)

    def volume(self, volume_id: str) -> dict:
        volume = self.state["volumes"].get(volume_id)
        if volume is None:
            raise self.state["NotFound"]()
        return copy.deepcopy(volume)

    def api(self, method: str, path: str, body: dict | None = None) -> dict:
        self.state["mutations"].append((method, path))
        machine = self.state["machines"][MACHINE]
        if path == f"/machines/{MACHINE}" and method == "POST":
            machine["config"] = copy.deepcopy(body["config"])
        elif path.endswith("/start"):
            machine["state"] = "started"
        elif path.endswith("/stop"):
            machine["state"] = "stopped"
        else:
            raise AssertionError(f"unexpected Machines API call: {method} {path}")
        return {}


class UndeliveredNativeStopCapture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="k12-undelivered-")).resolve()
        common = self.tmp / "git"
        self.registry = common / "cloudbench-fleet-ownership" / OWNER
        self.audit = common / "cloudbench-fleet-audits" / OWNER
        self.workspace = self.tmp / "workspace"
        self.run = self.workspace / ".context/fleet/runs" / RUN_ID
        self.out = self.run / BENCH
        pid, start = dead_pid_identity()
        meta = {
            "version": "2", "app": APP, "fleet_owner_token": OWNER, "host": socket.gethostname(),
            "pid": pid, "pid_start": start, "run_id": RUN_ID, "workspace_root": str(self.workspace),
            "runs_root": str(self.run.parent), "audit_dir": str(self.audit), "cleanup_policy": "retain",
        }
        write(self.registry / "meta", "".join(f"{k}={v}\n" for k, v in meta.items()))
        write(self.registry / "guest-cleanup-unconfirmed", "")
        write(self.registry / "clones" / CLONE, f"name={CLONE}\nid={MACHINE}\nvolume_id={VOLUME}\n")
        write(self.audit / "meta", f"version=1\nfleet_owner_token={OWNER}\nrun_id={RUN_ID}\napp={APP}\n")
        write(self.audit / "by-machine-id" / MACHINE, CLONE + "\n")
        write(self.audit / "fresh" / CLONE, "".join(f"{k}={v}\n" for k, v in {
            "version": "1", "fleet_owner_token": OWNER, "run_id": RUN_ID, "app": APP, "clone_name": CLONE,
            "source": "fresh-clone", "machine_id": MACHINE, "volume_id": VOLUME, "disposition": "owned"}.items()))
        write(self.run / "_batch/lifecycle.json", json.dumps({
            "status": "failed", "fleet_owner_token": OWNER, "run_id": RUN_ID, "controller_exit_code": 1}))
        write(self.run / "_batch/benches.json", json.dumps([{"name": BENCH}, {"name": "other-bench"}]))
        write(self.out / ".cid", f"clone {MACHINE}\n")
        write(self.out / "post-config-start.accepted", MACHINE + "\n")
        self.native_stop = {
            "bench": BENCH, "delivery_receipt": "absent", "destroyed": False, "fleet_owner_token": OWNER,
            "kind": "guest-native-stop", "machine_id": MACHINE, "ownership": "fresh",
            "reason": "authenticated guest shutdown was not delivered", "requested_epoch": 1,
            "run_id": RUN_ID, "stop_requested": True, "stop_requests": 1, "verified": True,
            "verified_epoch": 2, "verified_state": "stopped", "version": 1, "volume_id": VOLUME,
        }
        self.write_native_stop(self.native_stop)
        for path in (self.registry, self.audit, self.run, self.out, self.workspace):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o700)
        self.capture_dir = self.tmp / "capture"
        # run_path returns a copy; patch the namespace the functions actually use.
        self.helper = runpy.run_path(str(HELPER))["main"].__globals__
        self.original_config = {
            "image": "registry.fly.io/bench@sha256:" + "a" * 64,
            "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
            "env": {"CLOUDBENCH_RUN_TOKEN": TOKEN},
            "mounts": [{"volume": VOLUME, "path": "/data"}],
            "restart": {"policy": "no"},
        }
        self.state = {
            "NotFound": self.helper["NotFound"], "mutations": [],
            "machines": {MACHINE: {"id": MACHINE, "name": CLONE, "state": "stopped", "instance_id": "i1",
                                   "config": copy.deepcopy(self.original_config)}},
            "volumes": {VOLUME: {"id": VOLUME, "state": "created", "attached_machine_id": MACHINE}},
        }
        state = self.state
        helper = self.helper

        def fake_guest_capture(fly, ident, capture_dir, journal, attempts, ssh_seconds):
            # The guest must be running only the inert command when files are read.
            current = fly.machine(ident["machine_id"])
            assert current["state"] == "started" and current["config"]["init"]["cmd"] == helper["INERT_CMD"]
            files = {
                "bench.log": f"RUNSTAMP-{ident['token']}\nrunning\n".encode(),
                "repo/.context/cloudbench/logs/backend.log": state.get("backend_log", BACKEND_LOG).encode(),
            }
            if state.get("omit_backend"):
                files.pop("repo/.context/cloudbench/logs/backend.log")
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
                for name, content in sorted(files.items()):
                    info = tarfile.TarInfo(name)
                    info.size, info.mode, info.mtime = len(content), 0o600, 0
                    archive.addfile(info, io.BytesIO(content))
            data = buffer.getvalue()
            local = capture_dir / f".{ident['machine_id']}.download"
            local.write_bytes(data)
            return local, {
                "version": 1, "run_token": ident["token"], "missing": [],
                "files": {n: {"bytes": len(c), "sha256": hashlib.sha256(c).hexdigest()} for n, c in files.items()},
                "archive_bytes": len(data), "archive_sha256": hashlib.sha256(data).hexdigest(),
                "inert_sleepers": 1,
            }

        helper["Fly"] = lambda app, token: FakeFly(state)
        helper["resolve_token"] = lambda ident: "fixture-token"
        helper["guest_capture"] = fake_guest_capture
        os.environ["CLOUDBENCH_CAPTURE_POLL_SECONDS"] = "0"

    def tearDown(self) -> None:
        subprocess.run(["rm", "-rf", str(self.tmp)], check=False)

    def write_native_stop(self, record: dict) -> None:
        write(self.out / "guest-native-stop.json", json.dumps(record, sort_keys=True))

    def main(self, *extra: str) -> tuple[int, str, str]:
        argv = ["--registry", str(self.registry), "--bench", BENCH, "--machine-id", MACHINE,
                "--volume-id", VOLUME, *extra]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                status = self.helper["main"](argv)
            except SystemExit as exit_:
                status = exit_.code
        return status, stdout.getvalue(), stderr.getvalue()

    def capture(self, *extra: str) -> tuple[int, str, str]:
        return self.main("--capture-dir", str(self.capture_dir), "--undelivered-native-stop", *extra)

    def assert_refused(self, reason: str, *, flag: bool = True) -> None:
        status, _, stderr = (self.capture() if flag
                             else self.main("--capture-dir", str(self.capture_dir)))
        self.assertEqual(status, self.helper["EXIT_REFUSED"], stderr)
        self.assertIn(reason, stderr)
        self.assertEqual(self.state["mutations"], [], "a refusal must not mutate the provider")
        self.assertFalse((self.out / "guest-cleanup.provider-manifest.json").exists())
        self.assertFalse((self.out / "guest-cleanup.backend.log").exists())

    def test_exact_undelivered_native_stop_is_captured_and_handed_to_recovery(self) -> None:
        status, stdout, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        self.assertEqual(self.state["mutations"], [
            ("POST", f"/machines/{MACHINE}"), ("POST", f"/machines/{MACHINE}/start"),
            ("POST", f"/machines/{MACHINE}/stop"), ("POST", f"/machines/{MACHINE}")])
        machine = self.state["machines"][MACHINE]
        self.assertEqual((machine["state"], machine["config"]), ("stopped", self.original_config))
        self.assertTrue((self.capture_dir / f"{MACHINE}.tar.gz").is_file())
        provenance = json.loads((self.capture_dir / f"{MACHINE}.provenance.json").read_text())
        self.assertEqual(provenance["admission"], "undelivered-native-stop")
        self.assertEqual(provenance["proof_credit"], 0)
        self.assertEqual((self.out / "guest-cleanup.backend.log").read_text(), BACKEND_LOG)
        manifest = json.loads((self.out / "guest-cleanup.provider-manifest.json").read_text())
        self.assertEqual(manifest["kind"], "provider-active-exact-manifest")
        self.assertEqual(manifest["sessions"], {"kernel": [KERNEL_SESSION], "steel": []})
        self.assertEqual(manifest["root_agent_id"], ROOT_AGENT)
        # The latch is untouched: only exact-owner recovery may discharge it.
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").is_file())
        self.assertIn("cleanup_policy=retain", (self.registry / "meta").read_text())
        self.assertFalse((self.out / "guest-shutdown.confirmed").exists())
        # Recovery's stopped-guest branch: seal the stopped proof from these inputs.
        status_text = (f"Machine ID: {MACHINE}\nState: stopped\n\nVM\n  ID    = {MACHINE}\n"
                       f"  Name  = {CLONE}\n  State = stopped\n\nEvent Logs\n")
        write(self.out / "guest-cleanup.machine-status.txt", status_text)
        proof = subprocess.run([
            sys.executable, str(SESSION), "publish-stopped-machine-proof",
            "--owner", OWNER, "--fleet-run-id", RUN_ID, "--bench", BENCH, "--machine-id", MACHINE,
            "--output-dir", str(self.out), "--guest-run-token", TOKEN,
            "--backend-log", str(self.out / "guest-cleanup.backend.log"),
            "--manifest", str(self.out / "guest-cleanup.provider-manifest.json"),
            "--clone-name", CLONE, "--machine-status", str(self.out / "guest-cleanup.machine-status.txt"),
            "--stopped-proof", str(self.out / "guest-cleanup.machine-stopped.json"),
        ], capture_output=True, text=True)
        self.assertEqual(proof.returncode, 0, proof.stderr)
        sealed = json.loads((self.out / "guest-cleanup.machine-stopped.json").read_text())
        self.assertEqual(sealed["kind"], "machine-stopped-proof")
        # A second capture is refused: recovery already holds this guest's evidence.
        self.state["mutations"].clear()
        status, _, stderr = self.main("--capture-dir", str(self.tmp / "capture-2"), "--undelivered-native-stop")
        self.assertEqual(status, self.helper["EXIT_REFUSED"], stderr)
        self.assertIn("already exists; run exact-owner recovery instead", stderr)
        self.assertEqual(self.state["mutations"], [])

    def test_next_step_names_the_exact_capture(self) -> None:
        status, stdout, stderr = self.main("--next-step")
        self.assertEqual(status, 0, stderr)
        self.assertIn("--undelivered-native-stop", stdout)
        self.assertIn(f"--machine-id {MACHINE} --volume-id {VOLUME}", stdout)
        self.assertIn(f"scripts/run-bench --recover-stale-owner {OWNER}", stdout)
        self.assertEqual(self.state["mutations"], [])
        self.write_native_stop(dict(self.native_stop, delivery_receipt="http-202"))
        status, stdout, stderr = self.main("--next-step")
        self.assertEqual(status, self.helper["EXIT_REFUSED"])
        self.assertIn("not admissible", stderr)

    def test_quarantined_owner_without_flag_keeps_existing_refusal(self) -> None:
        self.assert_refused("owner cleanup policy is not reap", flag=False)

    def test_foreign_owner_record_is_refused(self) -> None:
        self.write_native_stop(dict(self.native_stop, fleet_owner_token="f" * 32))
        self.assert_refused("not an exact verified undelivered stop")

    def test_delivered_receipt_is_refused(self) -> None:
        self.write_native_stop(dict(self.native_stop, delivery_receipt="http-202"))
        self.assert_refused("not an exact verified undelivered stop")

    def test_unverified_or_destroyed_record_is_refused(self) -> None:
        for change in ({"verified": False}, {"destroyed": True}, {"verified_state": "started"},
                       {"volume_id": "vol_other"}, {"machine_id": "aaaaaaaaaaaaaa"}, {"verified": 1}):
            self.write_native_stop(dict(self.native_stop, **change))
            self.assert_refused("not an exact verified undelivered stop")

    def test_destroyed_volume_is_refused_natively(self) -> None:
        del self.state["volumes"][VOLUME]
        self.assert_refused("volume is already destroyed")

    def test_retained_policy_without_native_stop_record_is_refused(self) -> None:
        (self.out / "guest-native-stop.json").unlink()
        self.assert_refused("no guest-native-stop.json")

    def test_reap_policy_is_not_admitted_as_undelivered(self) -> None:
        meta = (self.registry / "meta").read_text().replace("cleanup_policy=retain", "cleanup_policy=reap")
        write(self.registry / "meta", meta)
        self.assert_refused("requires the retained quarantine policy")

    def test_missing_quarantine_latch_is_refused(self) -> None:
        (self.registry / "guest-cleanup-unconfirmed").unlink()
        self.assert_refused("requires the guest-cleanup-unconfirmed latch")

    def test_absent_backend_log_publishes_no_recovery_inputs(self) -> None:
        self.state["omit_backend"] = True
        status, _, stderr = self.capture()
        self.assertEqual(status, self.helper["EXIT_FAILED"], stderr)
        self.assertIn("provider-session identity is unrecoverable", stderr)
        machine = self.state["machines"][MACHINE]
        self.assertEqual((machine["state"], machine["config"]), ("stopped", self.original_config))
        self.assertFalse((self.out / "guest-cleanup.provider-manifest.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=1)
