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
import base64
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
            if "prestack" in state:
                # The guest died during bootstrap checkout: only the driver files exist.
                files = dict(state["prestack"])
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
                "version": 1, "run_token": ident["token"],
                "missing": sorted(helper["expected_names"](ident["token"]) - set(files)),
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
        # A backend-less capture that is not a pre-stack boot proves nothing.
        self.state["omit_backend"] = True
        status, _, stderr = self.capture()
        self.assertEqual(status, self.helper["EXIT_FAILED"], stderr)
        self.assertIn("capture does not prove zero provider sessions", stderr)
        self.assertFalse((self.out / "guest-cleanup.undelivered-capture.json").exists())
        machine = self.state["machines"][MACHINE]
        self.assertEqual((machine["state"], machine["config"]), ("stopped", self.original_config))
        self.assertFalse((self.out / "guest-cleanup.provider-manifest.json").exists())


CLONE_SERVICES = [{
    "protocol": "tcp", "internal_port": 8765,
    "ports": [{"port": 8765, "handlers": ["http"]}],
}]


class UndeliveredNativeStopCaptureWithServices(UndeliveredNativeStopCapture):
    """Every fleet clone inherits the donor's network services (PR #1972 owner a4b2999b).

    The whole exact-owner chain (capture, stopped proof, sealed cleanup, receipt) must
    complete with the evidence preserved: the inert boot carries no services and the
    exact original config, services included, is restored.
    """

    def setUp(self) -> None:
        super().setUp()
        self.original_config["services"] = copy.deepcopy(CLONE_SERVICES)
        self.state["machines"][MACHINE]["config"] = copy.deepcopy(self.original_config)
        capture, state = self.helper["guest_capture"], self.state

        def capture_without_listeners(fly, ident, *args):
            assert not state["machines"][ident["machine_id"]]["config"].get("services"), \
                "the inert boot must not expose the clone's services"
            return capture(fly, ident, *args)

        self.helper["guest_capture"] = capture_without_listeners

    def test_capture_provenance_records_isolated_services(self) -> None:
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        provenance = json.loads((self.capture_dir / f"{MACHINE}.provenance.json").read_text())
        self.assertIs(provenance["services_isolated"], True)
        self.assertEqual(self.state["machines"][MACHINE]["config"]["services"], CLONE_SERVICES)


PRESTACK_FILES = {
    "bench.log": (f"RUNSTAMP-{TOKEN}\n[boot 06:37:04] bootstrap-checkout 172e555bd1c4\n"
                  "[cloudbench] git-maintenance 0s\nTerminated\n").encode(),
    "cloudbench-driver.state": b"booting\n",
}


class UndeliveredPrestackZeroProvider(UndeliveredNativeStopCapture):
    """The stopped guest never started its stack: zero provider sessions, proven by the capture."""

    def setUp(self) -> None:
        super().setUp()
        self.state["prestack"] = dict(PRESTACK_FILES)

    def session(self, command: str, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run([
            sys.executable, str(SESSION), command,
            "--owner", OWNER, "--fleet-run-id", RUN_ID, "--bench", BENCH, "--machine-id", MACHINE,
            "--output-dir", str(self.out), "--guest-run-token", TOKEN,
            "--backend-log", str(self.out / "guest-cleanup.backend.log"),
            "--manifest", str(self.out / "guest-cleanup.provider-manifest.json"),
            "--clone-name", CLONE, "--machine-status", str(self.out / "guest-cleanup.machine-status.txt"),
            "--stopped-proof", str(self.out / "guest-cleanup.machine-stopped.json"), *extra,
        ], capture_output=True, text=True)

    def recover_stopped_guest(self) -> list[subprocess.CompletedProcess]:
        """Recovery's stopped-guest branch, in its order, with the real helper."""
        write(self.out / "guest-cleanup.machine-status.txt",
              f"Machine ID: {MACHINE}\nState: stopped\n\nVM\n  ID    = {MACHINE}\n"
              f"  Name  = {CLONE}\n  State = stopped\n\nEvent Logs\n")
        env = ["--agents-env", str(self.tmp / "absent-agents.env"), "--backend-env", str(self.tmp / "absent.env")]
        steps = [self.session("publish-stopped-machine-proof")]
        if steps[-1].returncode == 0:
            steps.append(self.session("cleanup-sealed-provider-sessions",
                                      "--receipt", str(self.out / "guest-cleanup.recovery-receipt.json"), *env))
        if steps[-1].returncode == 0:
            steps.append(subprocess.run([
                sys.executable, str(SESSION), "validate-recovery-receipt",
                "--owner", OWNER, "--fleet-run-id", RUN_ID, "--bench", BENCH, "--machine-id", MACHINE,
                "--output-dir", str(self.out), "--guest-run-token", TOKEN,
                "--backend-log", str(self.out / "guest-cleanup.backend.log"),
                "--manifest", str(self.out / "guest-cleanup.provider-manifest.json"),
                "--clone-name", CLONE, "--machine-status", str(self.out / "guest-cleanup.machine-status.txt"),
                "--stopped-proof", str(self.out / "guest-cleanup.machine-stopped.json"),
                "--receipt", str(self.out / "guest-cleanup.recovery-receipt.json"),
            ], capture_output=True, text=True))
        return steps

    def test_exact_undelivered_native_stop_is_captured_and_handed_to_recovery(self) -> None:
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        machine = self.state["machines"][MACHINE]
        self.assertEqual((machine["state"], machine["config"]), ("stopped", self.original_config))
        manifest = json.loads((self.out / "guest-cleanup.provider-manifest.json").read_text())
        self.assertEqual(manifest["kind"], "provider-undelivered-prestack-zero-manifest")
        self.assertEqual(manifest["sessions"], {"kernel": [], "steel": []})
        self.assertFalse((self.out / "guest-cleanup.backend.log").exists())
        steps = self.recover_stopped_guest()
        self.assertEqual([step.returncode for step in steps], [0, 0, 0], [step.stderr for step in steps])
        receipt = json.loads((self.out / "guest-cleanup.recovery-receipt.json").read_text())
        self.assertEqual((receipt["kind"], receipt["results"]), ("provider-exact-cleanup", []))
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").is_file())

    def test_existing_capture_hands_inputs_to_recovery_without_provider_calls(self) -> None:
        # The real run captured first and published nothing; replay from that capture.
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        manifest = (self.out / "guest-cleanup.provider-manifest.json").read_bytes()
        for name in ("guest-cleanup.provider-manifest.json", "guest-cleanup.undelivered-capture.json"):
            (self.out / name).unlink()
        self.state["mutations"].clear()
        status, stdout, stderr = self.main("--capture-dir", str(self.capture_dir), "--publish-recovery-inputs")
        self.assertEqual(status, 0, stderr)
        self.assertEqual(self.state["mutations"], [])
        self.assertEqual((self.out / "guest-cleanup.provider-manifest.json").read_bytes(), manifest)
        self.assertEqual([step.returncode for step in self.recover_stopped_guest()], [0, 0, 0])

    def assert_zero_proof_refused(self) -> None:
        status, _, stderr = self.capture()
        self.assertEqual(status, self.helper["EXIT_FAILED"], stderr)
        self.assertIn("does not prove zero provider sessions", stderr)
        self.assertFalse((self.out / "guest-cleanup.provider-manifest.json").exists())
        self.assertFalse((self.out / "guest-cleanup.undelivered-capture.json").exists())
        machine = self.state["machines"][MACHINE]
        self.assertEqual((machine["state"], machine["config"]), ("stopped", self.original_config))

    def test_services_manifest_present_is_refused(self) -> None:
        self.state["prestack"]["repo/.context/cloudbench/services.json"] = b'{"status":"stopped"}'
        self.assert_zero_proof_refused()

    def test_stack_log_present_is_refused(self) -> None:
        self.state["prestack"]["repo/.context/cloudbench/stack.log"] = b"launching\n"
        self.assert_zero_proof_refused()

    def test_driver_state_past_booting_is_refused(self) -> None:
        for driver in (b"running\n", b"exited\n", b"booting"):
            with self.subTest(driver=driver):
                self.state["prestack"]["cloudbench-driver.state"] = driver
                self.assert_zero_proof_refused()
                subprocess.run(["rm", "-rf", str(self.capture_dir)], check=True)

    def test_stack_launch_in_bench_log_is_refused(self) -> None:
        self.state["prestack"]["bench.log"] += b"launching stack (run.sh --benchmark)\n"
        self.assert_zero_proof_refused()

    def test_backend_log_present_never_yields_a_zero_manifest(self) -> None:
        self.state["prestack"]["repo/.context/cloudbench/logs/backend.log"] = b"[Server] Server started\n"
        status, _, stderr = self.capture()
        self.assertEqual(status, self.helper["EXIT_FAILED"], stderr)
        self.assertFalse((self.out / "guest-cleanup.provider-manifest.json").exists())

    def test_capture_digest_mismatch_is_refused_at_recovery(self) -> None:
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        archive = self.capture_dir / f"{MACHINE}.tar.gz"
        archive.chmod(0o600)
        archive.write_bytes(archive.read_bytes() + b"\0")
        steps = self.recover_stopped_guest()
        self.assertNotEqual(steps[0].returncode, 0)
        self.assertFalse((self.out / "guest-cleanup.recovery-receipt.json").exists())

    def test_delivered_receipt_after_capture_is_refused_at_recovery(self) -> None:
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        self.write_native_stop(dict(self.native_stop, delivery_receipt="http-202"))
        steps = self.recover_stopped_guest()
        self.assertNotEqual(steps[0].returncode, 0)
        self.assertIn("not an exact verified undelivered stop", steps[0].stderr)

    def test_absent_backend_log_publishes_no_recovery_inputs(self) -> None:
        self.skipTest("covered by the parent class; pre-stack files are this class's fixture")

    def test_next_step_names_the_exact_capture(self) -> None:
        self.skipTest("parent class covers next-step")


# A delivered shutdown found the driver already exited before run.sh started
# the backend (owner 7a0da79e, polar-bu-090): no services manifest, backend log
# or run record ever existed, so the guest could not ACK and recovery could not
# build a provider manifest. Its exact original files, as an inert capture sees them.
PREBACKEND_FILES = {
    "bench.log": (f"RUNSTAMP-{TOKEN}\n[boot 01:24:10] bootstrap-checkout 5b1f0b51867368\n"
                  "[cloudbench 01:25:41] STEP stack_launch\n"
                  "[cloudbench 01:25:41] launching stack (run.sh --benchmark) — base_port=3001\n"
                  "[cloudbench 01:25:41] waiting for stack to become healthy (services.json + backend + worker + WMH)...\n"
                  "[cloudbench 01:26:10] …still waiting (30s): status=none wmh=[]\n"
                  "[cloudbench 01:26:43] guest shutdown requested; draining benchmark root before stack teardown\n"
                  "[cloudbench 01:26:44] FATAL: stack worker cleanup was not confirmed; refusing guest cleanup acknowledgement\n"
                  "[boot 01:26:44] driver exited rc=143; holding for controller collection\n").encode(),
    "cloudbench-driver.state": b"exited\n",
    f"cloudbench-shutdown-{TOKEN}.request": (TOKEN + "\n").encode(),
    "repo/.context/cloudbench/stack.log": ("Applied local workflow and trajectory search functions and triggers.\n"
                                           "📦 Ensuring Playwright browser assets...\n"
                                           "Installing Chromium assets for Node Playwright\n").encode(),
}
ABSENT = {"bytes": None, "exists": False, "regular": False, "symlink": False, "within_limit": False}
PREBACKEND_STATE = {
    "backend_closed": None, "backend_log": ABSENT, "backend_port": None, "driver_descendants": [],
    "driver_pid": None, "driver_process_state": None, "driver_state": "exited", "driver_token_match": False,
    "guest_run_token": TOKEN, "live_service_pids": [], "machine_id": MACHINE,
    "reason": "missing exact guest services manifest", "run_json": ABSENT,
    "schema_version": "cloudbench-guest-state-v1", "services_manifest": ABSENT, "services_status": None,
    "state": "exited", "stopped_service_pids": [], "version": 1,
}
STOPPED_STATUS = (f"Machine ID: {MACHINE}\nState: stopped\n\nVM\n  ID    = {MACHINE}\n"
                  f"  Name  = {CLONE}\n  State = stopped\n\nEvent Logs\n")


class PrebackendExitNativeStop(unittest.TestCase):
    """Recovery records a pre-backend guest's exact native stop; capture proves zero sessions."""

    setUp = UndeliveredNativeStopCapture.setUp
    tearDown = UndeliveredNativeStopCapture.tearDown
    main = UndeliveredNativeStopCapture.main
    capture = UndeliveredNativeStopCapture.capture
    write_native_stop = UndeliveredNativeStopCapture.write_native_stop
    session = UndeliveredPrestackZeroProvider.session
    recover_stopped_guest = UndeliveredPrestackZeroProvider.recover_stopped_guest

    def prepare(self, state: dict | None = None) -> None:
        (self.out / "guest-native-stop.json").unlink(missing_ok=True)
        self.state["prestack"] = dict(PREBACKEND_FILES)
        write(self.out / "guest-cleanup.state.json", json.dumps(state or PREBACKEND_STATE, sort_keys=True))
        write(self.out / "guest-shutdown.requested", json.dumps({"http_status": 202, "machine_id": MACHINE}))

    def publish(self, *, status: str = STOPPED_STATUS, requests: str = "0") -> subprocess.CompletedProcess:
        write(self.out / "guest-cleanup.machine-status.txt", status)
        return subprocess.run([
            sys.executable, str(SESSION), "publish-prebackend-native-stop",
            "--owner", OWNER, "--fleet-run-id", RUN_ID, "--bench", BENCH, "--machine-id", MACHINE,
            "--output-dir", str(self.out), "--guest-run-token", TOKEN,
            "--state-receipt", str(self.out / "guest-cleanup.state.json"), "--clone-name", CLONE,
            "--volume-id", VOLUME, "--machine-status", str(self.out / "guest-cleanup.machine-status.txt"),
            "--stop-requests", requests,
        ], capture_output=True, text=True)

    def recover_with_fleet(self, machine_state: str) -> subprocess.CompletedProcess:
        """The real run-bench-fleet guest-cleanup recovery with provider/guest I/O stubbed."""
        source = (ROOT / "scripts/run-bench-fleet").read_text()
        start = source.index("cloudbench_recover_guest_cleanup_receipts() {")
        body = source[start:source.index("\nfleet_has_replaced_preconfig() {", start)]
        self.fly_calls = self.tmp / "fly-calls"
        write(self.tmp / "native-status.txt", STOPPED_STATUS)
        command = f"""set -u
registry_meta_value() {{ sed -n "s/^$2=//p" "$1" | head -1; }}
{body}
EXACT_SESSION_CLEANUP_HELPER={SESSION}
GUEST_RECOVERY_HELPER={ROOT / "scripts/cloudbench-guest-recovery.py"}
CLOUDBENCH_SCRIPT_SNAPSHOT={ROOT / "scripts"}
ROOT_DIR={self.tmp}
RUN_ID={RUN_ID}
APP={APP}
CLOUDBENCH_BARRIER_TOKEN=unused
CLOUDBENCH_POOL_STOP_ATTEMPTS=2
recovery_benches=({BENCH})
recovery_machine_ids=({MACHINE})
recovery_clone_names=({CLONE})
recovery_machine_states=({machine_state})
recovery_guest_tokens=({TOKEN})
recovery_proxy_ports=(8802)
recovery_outputs=({self.out})
FLY() {{
  printf '%s\\n' "$*" >> {self.fly_calls}
  case "$*" in *quiesce*) echo 'ERROR: missing exact guest services manifest'; return 1 ;; esac
  return 0
}}
cloudbench_fetch_guest_evidence() {{
  case "$4" in
    /cloudbench-guest-state-*) cp {self.tmp / "guest-state.json"} "$5"; printf -v "$1" 200 ;;
    *) printf -v "$1" 404 ;;
  esac
}}
machine_status_exact_read() {{ cat {self.tmp / "native-status.txt"}; }}
cloudbench_seal_guest_evidence_file() {{ mv -f "$1" "$2"; }}
cloudbench_publish_guest_shutdown_confirmation() {{ printf '%s\\n' "$2" > "$1/guest-shutdown.confirmed"; }}
cloudbench_recover_guest_cleanup_receipts {self.registry}
"""
        env = {**os.environ, "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"]}
        return subprocess.run(["bash", "-c", command], env=env, capture_output=True, text=True, check=False)

    def test_already_stopped_guest_is_recorded_captured_and_recovered(self) -> None:
        self.prepare()
        first = self.recover_with_fleet("stopped")
        self.assertNotEqual(first.returncode, 0, "capture is still required before cleanup")
        record = json.loads((self.out / "guest-native-stop.json").read_text())
        self.assertEqual((record["delivery_receipt"], record["stop_requests"], record["stop_requested"],
                          record["verified_state"], record["volume_id"]),
                         ("pre-backend-exit", 0, False, "stopped", VOLUME))
        self.assertIn("--undelivered-native-stop", first.stdout + first.stderr)
        self.assertFalse((self.out / "guest-shutdown.confirmed").exists())
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        manifest = json.loads((self.out / "guest-cleanup.provider-manifest.json").read_text())
        self.assertEqual((manifest["kind"], manifest["sessions"], manifest["evidence"]["driver_state"],
                          manifest["evidence"]["delivery_receipt"]),
                         ("provider-undelivered-prestack-zero-manifest", {"kernel": [], "steel": []},
                          "exited", "pre-backend-exit"))
        second = self.recover_with_fleet("stopped")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((self.out / "guest-shutdown.confirmed").read_text(), RUN_ID + "\n")
        receipt = json.loads((self.out / "guest-cleanup.recovery-receipt.json").read_text())
        self.assertEqual((receipt["kind"], receipt["results"]), ("provider-exact-cleanup", []))
        # Latches remain for the exact-owner recovery to discharge.
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").is_file())

    def test_started_guest_is_natively_stopped_and_recorded(self) -> None:
        self.prepare()
        write(self.tmp / "guest-state.json", json.dumps(PREBACKEND_STATE, sort_keys=True))
        result = self.recover_with_fleet("started")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("natively stopping it for original-volume capture", result.stdout)
        self.assertIn(f"machine stop {MACHINE} -a {APP}", self.fly_calls.read_text())
        record = json.loads((self.out / "guest-native-stop.json").read_text())
        self.assertEqual((record["stop_requests"], record["stop_requested"]), (1, True))
        self.assertIn("--undelivered-native-stop", result.stderr)

    def test_started_guest_with_service_evidence_is_never_stopped_as_prebackend(self) -> None:
        for change in ({"live_service_pids": [4242]}, {"backend_port": 3001},
                       {"backend_log": dict(ABSENT, exists=True, regular=True, bytes=10, within_limit=True)},
                       {"services_manifest": dict(ABSENT, exists=True, regular=True, bytes=9, within_limit=True)}):
            with self.subTest(change=change):
                self.prepare(dict(PREBACKEND_STATE, **change))
                write(self.tmp / "guest-state.json", json.dumps(dict(PREBACKEND_STATE, **change), sort_keys=True))
                result = self.recover_with_fleet("started")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("no sealed provider-session identity", result.stderr)
                self.assertNotIn("machine stop", self.fly_calls.read_text())
                self.assertFalse((self.out / "guest-native-stop.json").exists())
                self.fly_calls.unlink()

    def test_partial_state_evidence_refuses_the_record(self) -> None:
        for change in ({"live_service_pids": [4242]}, {"driver_state": "running"}, {"backend_port": 3001},
                       {"driver_pid": 77}, {"backend_closed": True}, {"reason": "exact guest state captured"},
                       {"backend_log": dict(ABSENT, exists=True)}, {"run_json": dict(ABSENT, exists=True)},
                       {"machine_id": "aaaaaaaaaaaaaa"}, {"extra": 1}):
            with self.subTest(change=change):
                self.prepare(dict(PREBACKEND_STATE, **change))
                result = self.publish()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("did not prove", result.stderr.replace("does not prove", "did not prove"))
                self.assertFalse((self.out / "guest-native-stop.json").exists())

    def test_local_backend_log_refuses_prebackend_admission(self) -> None:
        self.prepare()
        write(self.out / "guest-cleanup.backend.log", "[Server] Server started\n")
        result = self.recover_with_fleet("stopped")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.out / "guest-native-stop.json").exists())

    def test_running_machine_status_refuses_the_record(self) -> None:
        self.prepare()
        result = self.publish(status=STOPPED_STATUS.replace("stopped", "started"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not proven stopped", result.stderr)
        self.assertFalse((self.out / "guest-native-stop.json").exists())

    def assert_capture_refused(self) -> None:
        self.assertEqual(self.publish().returncode, 0)
        status, _, stderr = self.capture()
        subprocess.run(["rm", "-rf", str(self.capture_dir)], check=True)
        self.assertEqual(status, self.helper["EXIT_FAILED"], stderr)
        # The capture's own cross-check against the sealed state may refuse first.
        self.assertRegex(stderr, "does not prove zero provider sessions|contradicts the recovery observation")
        self.assertFalse((self.out / "guest-cleanup.provider-manifest.json").exists())
        self.assertFalse((self.out / "guest-cleanup.undelivered-capture.json").exists())
        machine = self.state["machines"][MACHINE]
        self.assertEqual((machine["state"], machine["config"]), ("stopped", self.original_config))

    def test_backend_or_service_files_on_the_volume_refuse_zero_sessions(self) -> None:
        extra = {
            "repo/.context/cloudbench/logs/backend.log": b"[Server] Server started\n",
            "repo/.context/cloudbench/logs/worker.log": b"Worker started\n",
            "repo/.context/cloudbench/logs/frontend.log": b"vite\n",
            "repo/.context/cloudbench/services.json": b'{"status":"stopped"}',
            "repo/.context/cloudbench/run.json": b"{}",
            "cloudbench-driver.pid": b"123\n",
            f"cloudbench-interrupt-cleanup-{TOKEN}.status": b"state=clean\n",
        }
        for name, data in extra.items():
            with self.subTest(name=name):
                self.prepare()
                self.state["prestack"][name] = data
                self.assert_capture_refused()

    def test_driver_or_log_past_backend_launch_refuses_zero_sessions(self) -> None:
        for name, data in (("cloudbench-driver.state", b"running\n"),
                           ("bench.log", PREBACKEND_FILES["bench.log"] + b"stack healthy - backend :3001\n"),
                           ("repo/.context/cloudbench/stack.log", b"Service manifest: x\n")):
            with self.subTest(name=name):
                self.prepare()
                self.state["prestack"][name] = data
                self.assert_capture_refused()

    def test_state_changed_after_record_refuses_capture(self) -> None:
        self.prepare()
        self.assertEqual(self.publish().returncode, 0)
        write(self.out / "guest-cleanup.state.json",
              json.dumps(dict(PREBACKEND_STATE, live_service_pids=[4242]), sort_keys=True))
        status, _, stderr = self.capture()
        self.assertEqual(status, self.helper["EXIT_REFUSED"], stderr)
        self.assertIn("not an exact verified pre-backend stop", stderr)
        self.assertEqual(self.state["mutations"], [])


RETIREMENT = ROOT / "scripts/cloudbench-forensic-retirement.py"
BUILDER = ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py"


class PrebackendExitForensicArchive(unittest.TestCase):
    """The recovered pre-backend guest's originals retire through the forensic archive.

    stack.log is present and no driver cleanup ACK exists, so the pre-stack
    archive contract cannot apply; the archive binds the exact pre-backend
    native stop and zero-session recovery receipt instead.
    """

    setUp = UndeliveredNativeStopCapture.setUp
    tearDown = UndeliveredNativeStopCapture.tearDown
    main = UndeliveredNativeStopCapture.main
    capture = UndeliveredNativeStopCapture.capture
    write_native_stop = UndeliveredNativeStopCapture.write_native_stop
    session = UndeliveredPrestackZeroProvider.session
    recover_stopped_guest = UndeliveredPrestackZeroProvider.recover_stopped_guest
    prepare = PrebackendExitNativeStop.prepare
    publish = PrebackendExitNativeStop.publish

    def recovered_owner(self) -> None:
        """Record, capture and recover exactly as the stale-owner CLI does, then discharge the cleanup latch."""
        env = self.original_config["env"]
        env.update(CLOUDBENCH_FRESH_VOLUME="1", BENCH_TASKS_B64=base64.b64encode(BENCH.encode()).decode())
        self.state["machines"][MACHINE]["config"] = copy.deepcopy(self.original_config)
        self.prepare()
        self.assertEqual(self.publish().returncode, 0)
        status, _, stderr = self.capture()
        self.assertEqual(status, 0, stderr)
        steps = self.recover_stopped_guest()
        self.assertEqual([step.returncode for step in steps], [0, 0, 0], [step.stderr for step in steps])
        write(self.out / "guest-shutdown.confirmed", RUN_ID + "\n")
        identity = json.dumps({"version": 1, "machine_id": MACHINE, "run_token": TOKEN})
        write(self.out / "runtime-evidence.owner.json", identity)
        write(self.out / "runtime-evidence.pending", identity)
        meta = (self.registry / "meta").read_text().replace("cleanup_policy=retain", "cleanup_policy=reap")
        write(self.registry / "meta", meta)
        (self.registry / "guest-cleanup-unconfirmed").unlink()
        write(self.registry / "runtime-evidence-unconfirmed", "")
        write(self.run / "_batch/benches.json", json.dumps([{"name": BENCH}]))
        write(self.run / "_batch/lifecycle.json", json.dumps({
            "version": 1, "status": "failed", "fleet_owner_token": OWNER, "run_id": RUN_ID,
            "controller_exit_code": 1}))
        for name in ("execution-provenance.json", "execution-task-matrix.json"):
            write(self.run / name, "{}")
        write(self.tmp / "machines.json", "[]")
        write(self.tmp / "volumes.json", "[]")

    def build(self) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(BUILDER), "--registry", str(self.registry),
                               "--capture-dir", str(self.capture_dir)], capture_output=True, text=True)

    def verify(self) -> dict:
        retirement = runpy.run_path(str(RETIREMENT))
        packet = self.run / "_forensic"
        return retirement["verify"](self.registry, self.run, packet / "manifest.json",
                                    packet / "originals.tar.gz", self.tmp / "machines.json",
                                    self.tmp / "volumes.json", archive_only=True)

    def test_pre_backend_capture_builds_and_verifies_zero_credit_archive(self) -> None:
        self.recovered_owner()
        built = self.build()
        self.assertEqual(built.returncode, 0, built.stderr)
        row = json.loads((self.run / "_forensic/manifest.json").read_text())["tasks"][0]
        self.assertEqual((row["phase"], row["services_status"], row["proof_credit"]),
                         ("pre-backend-exit", None, 0))
        self.assertIn("repo/.context/cloudbench/stack.log", row["files"])
        self.assertIn(f"cloudbench-driver-clean-{TOKEN}.ack", row["missing"])
        self.assertEqual(len(row["missing"]), len(set(row["missing"])))
        self.assertIn("pre-backend-recovery-receipt.json", row["files"])
        result = self.verify()
        self.assertEqual((result["proof_credit"], result["incomplete_tasks"]), (0, 1))
        # The verifier recomputes the zero-session proof from the retained evidence.
        for name, change in (("guest-cleanup.state.json", dict(PREBACKEND_STATE, live_service_pids=[4242])),
                             ("guest-cleanup.recovery-receipt.json", {"kind": "forged"})):
            with self.subTest(changed=name):
                original = (self.out / name).read_bytes()
                write(self.out / name, json.dumps(change, sort_keys=True))
                with self.assertRaises(Exception):
                    self.verify()
                write(self.out / name, original)
        self.verify()

    def test_backend_log_beside_the_capture_refuses_the_archive(self) -> None:
        self.recovered_owner()
        self.assertEqual(self.build().returncode, 0)
        write(self.out / "guest-cleanup.backend.log", "[Server] Server started\n")
        with self.assertRaises(Exception):
            self.verify()

    def test_without_pre_backend_stop_the_pre_stack_contract_still_refuses(self) -> None:
        self.recovered_owner()
        (self.out / "guest-native-stop.json").unlink()
        built = self.build()
        self.assertNotEqual(built.returncode, 0)
        self.assertFalse((self.run / "_forensic/manifest.json").exists())

    def test_pre_backend_phase_cannot_relax_a_row_with_service_files(self) -> None:
        self.recovered_owner()
        self.assertEqual(self.build().returncode, 0)
        packet = self.run / "_forensic"
        manifest = json.loads((packet / "manifest.json").read_text())
        manifest["tasks"][0]["missing"].remove("repo/.context/cloudbench/logs/backend.log")
        manifest["tasks"][0]["files"]["repo/.context/cloudbench/logs/backend.log"] = {
            "bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}
        (packet / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(Exception):
            self.verify()


if __name__ == "__main__":
    unittest.main(verbosity=1)
