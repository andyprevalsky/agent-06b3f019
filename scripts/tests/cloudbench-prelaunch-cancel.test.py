#!/usr/bin/env python3
"""A cancellation during guest bootstrap must end with a retirable guest.

Runs the real cloudbench-boot.sh, the real status server, both real runtime
evidence collectors and the fleet's final primary-evidence validator against a
local guest whose bootstrap fetch is slow (production: git-fetch 220s). The
fleet waits CLOUDBENCH_CHILD_TERM_SECONDS (30s) for the cleanup ACK after its
/shutdown, then needs a sealed runtime-evidence bundle and a cleared pending
latch before it may delete the guest (descend-full69-20261023 LEAK: four
cancelled guests stayed STARTED and exact-owner recovery refused them).
"""

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
TOKEN = "0805839042c94bccbcd73f3a77cd48c3-0"
MACHINE = "8d967dda943528"
ACK_SECONDS = 30  # run-bench-fleet CLOUDBENCH_CHILD_TERM_SECONDS default


def free_port() -> int:
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
        probe.bind(("::", 0))
        return probe.getsockname()[1]


def shell_function(path: Path, name: str) -> str:
    match = re.search(rf"(?ms)^{name}\(\).*?^}}\n", path.read_text())
    assert match, f"{name} was not found in {path}"
    return match.group()


class PrelaunchCancel(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="cloudbench-prelaunch-cancel-", dir="/var/tmp"))
        self.data = self.root / "data"
        self.data.mkdir()
        (self.root / "repo").mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        # boot.sh pkills by broad patterns; never let the fixture reach real
        # processes on this host.
        (bin_dir / "pkill").write_text("#!/bin/sh\nexit 0\n")
        (bin_dir / "pkill").chmod(0o755)
        self.fetch_pid = self.root / "fetch.pid"
        fetch = self.root / "fetch-ref.sh"
        fetch.write_text(
            "#!/bin/bash\n"
            f"echo $$ > {self.fetch_pid}\n"
            "echo '[cloudbench] git-maintenance 0s'\n"
            "exec sleep 240\n"
        )
        driver = self.root / "driver.sh"
        driver.write_text(f"#!/bin/bash\ntouch {self.root}/driver-launched\n")
        self.port = free_port()
        self.secret = secrets.token_hex(32)
        self.env = dict(
            os.environ,
            PATH=f"{bin_dir}:{os.environ['PATH']}",
            CLOUDBENCH_BOOT="1",
            CLOUDBENCH_RUN_TOKEN=TOKEN,
            REF="da22666f3ec3ed3e22f5e6663e1b914339015982",
            CLOUDBENCH_DATA_DIR=str(self.data),
            CLOUDBENCH_REPO_DIR=str(self.root / "repo"),
            CLOUDBENCH_STATUS_PORT=str(self.port),
            CLOUDBENCH_RUN_SCRIPT=str(driver),
            CLOUDBENCH_FETCH_REF_SCRIPT=str(fetch),
            CLOUDBENCH_STATUS_SERVER_SCRIPT=str(SCRIPTS / "cloudbench-status-server.py"),
            CLOUDBENCH_BARRIER_TOKEN=self.secret,
            FLY_MACHINE_ID=MACHINE,
            HOME=str(self.root),
        )
        self.env.pop("CLOUDBENCH_BOOT_PAYLOAD_FILE", None)
        self.env.pop("CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP", None)
        self.boot = subprocess.Popen(
            ["bash", str(SCRIPTS / "cloudbench-boot.sh")],
            env=self.env, start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.cleanup)

    def cleanup(self) -> None:
        try:
            os.killpg(self.boot.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.boot.wait(timeout=10)
        # The status server and fetch run in their own sessions; reap only the
        # processes whose argv/cwd names this fixture's unique directory.
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                argv = (entry / "cmdline").read_bytes().split(b"\0")
            except OSError:
                continue
            owned = any(str(self.root).encode() in part for part in argv)
            if not owned and self.fetch_pid.exists():
                owned = entry.name == self.fetch_pid.read_text().strip()
            if owned:
                try:
                    os.kill(int(entry.name), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        shutil.rmtree(self.root, ignore_errors=True)

    def call(self, method: str, path: str) -> int:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", method=method,
            headers={"Authorization": f"Bearer {self.secret}",
                     "X-Cloudbench-Run-Token": TOKEN, "X-Cloudbench-Machine-Id": MACHINE},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=3) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def wait_for_bootstrap(self) -> None:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if self.fetch_pid.exists() and self.call("GET", "/driver-health") == 425:
                    return
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.1)
        self.fail("guest never reached the bootstrap fetch")

    def owner_output(self, name: str) -> Path:
        out = self.root / name
        (out / "remote-logs").mkdir(parents=True)
        owner = json.dumps({"version": 1, "run_token": TOKEN, "machine_id": MACHINE})
        for marker in ("runtime-evidence.owner.json", "runtime-evidence.pending"):
            (out / marker).write_text(owner)
        return out

    def test_term_during_bootstrap_is_acknowledged_and_retirable(self) -> None:
        self.wait_for_bootstrap()
        # Fleet TERM: deliver the exact authenticated stop, then wait the
        # unchanged acknowledgement window.
        self.assertIn(self.call("POST", "/shutdown"), (202, 204))
        started = time.monotonic()
        status = None
        while time.monotonic() - started < ACK_SECONDS:
            status = self.call("GET", "/shutdown-health")
            if status == 204:
                break
            time.sleep(0.25)
        self.assertEqual(status, 204, "guest did not acknowledge cleanup within the fleet window")
        self.assertFalse((self.root / "driver-launched").exists(), "driver launched after shutdown")
        fetch = int(self.fetch_pid.read_text())
        self.assertFalse(Path(f"/proc/{fetch}").exists(), "bootstrap fetch outlived the stop")

        # Both collectors seal the exact pre-launch outcome and release the
        # runtime latch; the fleet's final validator accepts it.
        env = dict(self.env)
        recovery = self.owner_output("recovery")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "cloudbench-collect-runtime-evidence.py"),
             str(recovery / "remote-logs"), str(self.port), TOKEN, MACHINE, "20", "--driver-log"],
            env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        controller = self.owner_output("controller")
        collect = shell_function(SCRIPTS / "run-bench-cloud", "cloudbench_collect_runtime_evidence")
        result = subprocess.run(
            ["bash", "-c", collect + '\ncloudbench_collect_runtime_evidence "$@"', "collect",
             str(controller / "remote-logs"), str(self.port), TOKEN, MACHINE, "20"],
            env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        validate = shell_function(SCRIPTS / "run-bench-fleet", "cloudbench_validate_primary_runtime_evidence")
        for out in (recovery, controller):
            self.assertFalse(os.path.lexists(out / "runtime-evidence.pending"))
            manifest = json.loads((out / "remote-logs/runtime-evidence/manifest.json").read_text())
            self.assertEqual(manifest["prelaunch"], True)
            log = (out / "remote-logs/runtime-evidence/bench.log").read_bytes()
            self.assertTrue(log.startswith(f"RUNSTAMP-{TOKEN}\n".encode()))
            self.assertEqual(manifest["files"]["bench.log"]["sha256"], hashlib.sha256(log).hexdigest())
            result = subprocess.run(
                ["bash", "-c", validate + '\ncloudbench_validate_primary_runtime_evidence "$@"',
                 "validate", str(out), MACHINE, TOKEN],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])

        # Guests sealed by an older status server have no pre-launch bundle;
        # exact-owner recovery preserves the same originals as pre-service.
        archive = self.root / "originals.tar.gz"
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "cloudbench-startup-failure-archive.py"), "capture",
             "--root", str(self.data), "--machine", MACHINE, "--run-token", TOKEN, "--archive", str(archive)],
            env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        import tarfile
        with tarfile.open(archive) as bundle:
            manifest = json.loads(bundle.extractfile("capture-manifest.json").read())
        self.assertIn("repo/.context/cloudbench/services.json", manifest["missing"])

    def test_launched_driver_never_uses_prelaunch_seal(self) -> None:
        # A guest whose driver launched keeps the complete stack contract.
        (self.root / "fetch-ref.sh").write_text("#!/bin/bash\nexit 0\n")
        self.assertIsNone(self.boot.poll())
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not (self.root / "driver-launched").exists():
            time.sleep(0.1)
        if not (self.root / "driver-launched").exists():
            # The slow fetch from setUp was already running; stop it so the
            # driver launches, then assert no pre-launch seal was produced.
            self.wait_for_bootstrap()
            os.kill(int(self.fetch_pid.read_text()), signal.SIGTERM)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and (self.data / "cloudbench-driver.state").read_text().strip() != "exited":
            time.sleep(0.1)
        self.assertTrue((self.root / "driver-launched").exists())
        self.assertFalse(list(self.data.glob("cloudbench-prelaunch-*")))
        self.assertEqual(self.call("GET", "/runtime-evidence"), 409)


OWNER = TOKEN.rsplit("-", 1)[0]
RUN = "20261024-172230-25507"
BENCH = "test-mass-agent-run-0"


class CancelledAcceptedStartEligibility(unittest.TestCase):
    """Exact-owner recovery may archive a TERM-cancelled accepted start."""

    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="cloudbench-prelaunch-eligible-", dir="/var/tmp"))
        self.addCleanup(shutil.rmtree, self.base, True)
        registry, audit = self.base / "owners" / OWNER, self.base / "audits" / OWNER
        run = self.base / "runs" / RUN
        self.registry, self.out = registry, run / BENCH
        for path in (registry / "clones", audit / "fresh", self.out, run / "_batch"):
            path.mkdir(parents=True)
        pairs = lambda path, values: path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        clone = "rose-bench-clone"
        pairs(registry / "meta", dict(version="2", fleet_owner_token=OWNER, run_id=RUN,
              runs_root=str(run.parent), audit_dir=str(audit), app="navi-whisper-lux-bench",
              cleanup_policy="reap"))
        pairs(audit / "meta", dict(fleet_owner_token=OWNER, run_id=RUN, app="navi-whisper-lux-bench"))
        pairs(audit / "fresh" / clone, dict(version="1", fleet_owner_token=OWNER, run_id=RUN,
              app="navi-whisper-lux-bench", clone_name=clone, source="fresh-clone",
              machine_id=MACHINE, volume_id="vol_original", source_machine_id="c" * 14,
              disposition="owned"))
        pairs(registry / "clones" / clone, dict(name=clone, id=MACHINE, volume_id="vol_original"))
        (run / "_batch/benches.json").write_text(json.dumps([{"name": BENCH, "mode": "REAL"}]))
        (run / "_batch/lifecycle.json").write_text(json.dumps({"status": "failed", "controller_exit_code": 1}))
        owner = json.dumps({"version": 1, "machine_id": MACHINE, "run_token": TOKEN})
        for name, body in {".cid": f"clone {MACHINE}\n", "benchmark-child.finished": "143\n",
                           "post-config-start.accepted": MACHINE + "\n", "guest-shutdown.confirmed": RUN + "\n",
                           "worker-clones.ids": "", "runtime-evidence.owner.json": owner,
                           "runtime-evidence.pending": owner}.items():
            (self.out / name).write_text(body)

    def eligible(self) -> int:
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "cloudbench-startup-failure-archive.py"), "eligible",
             "--registry", str(self.registry), "--output", str(self.out),
             "--machine", MACHINE, "--run-token", TOKEN],
            capture_output=True, text=True, timeout=30,
        ).returncode

    def test_term_cancelled_accepted_start_is_eligible(self) -> None:
        self.assertEqual(self.eligible(), 0)

    def test_accepted_start_requires_no_driver_context(self) -> None:
        import runpy
        helper = runpy.run_path(str(SCRIPTS / "cloudbench-startup-failure-archive.py"))
        require = helper["require_cancelled_before_launch"]
        require({"bench.log": b"", "cloudbench-driver.state": b"exited\n"}, "pre-service")
        for files, phase in (({"repo/.context/cloudbench/stack.log": b"x"}, "pre-service"),
                             ({"repo/.context/cloudbench/run.json": b"{}"}, "pre-service"),
                             ({}, "stopped-stack")):
            with self.assertRaises(ValueError):
                require(files, phase)

    def test_completed_or_unaccepted_starts_stay_ineligible(self) -> None:
        (self.out / "benchmark-child.finished").write_text("1\n")
        self.assertNotEqual(self.eligible(), 0)
        (self.out / "benchmark-child.finished").write_text("143\n")
        (self.out / "post-config-start.accepted").write_text("ffffffffffffff\n")
        self.assertNotEqual(self.eligible(), 0)
        (self.out / "post-config-start.accepted").write_text(MACHINE + "\n")
        (self.out / "cloudbench-run.json").write_text("{}")
        self.assertNotEqual(self.eligible(), 0)



class DriverPrestackCancel(unittest.TestCase):
    """I5: real driver cleanup after dep_sync, before run.sh exists."""

    def test_driver_cleanup_seals_prestack_evidence_for_both_collectors(self):
        import runpy
        with tempfile.TemporaryDirectory(prefix="cloudbench-driver-prestack-") as temporary:
            base = Path(temporary).resolve()
            data = base / "data"
            context = data / "repo/.context/cloudbench"
            context.mkdir(parents=True)
            token = TOKEN
            (data / "bench.log").write_text(
                f"RUNSTAMP-{token}\n[cloudbench] STEP dep_sync\n"
                "[cloudbench] guest shutdown requested; draining benchmark root before stack teardown\n"
            )
            (data / f"cloudbench-shutdown-{token}.request").touch()
            driver = SCRIPTS / "cloudbench-run.sh"
            script = "\n".join(shell_function(driver, name) for name in
                               ("publish_cleanup_ack", "cleanup_stack"))
            variables = {
                "DATA_DIR": data, "CONTEXT_DIR": context,
                "CLOUDBENCH_RUN_TOKEN": token,
                "CLEANUP_ACK_FILE": data / f"cloudbench-driver-clean-{token}.ack",
                "PRESTACK_SEAL_FILE": data / f"cloudbench-prestack-{token}.sealed",
                "INTERRUPT_CLEANUP_STATUS_FILE": data / "interrupt.status",
                "RUNNER_INTERRUPT_CLEANUP_STATUS_FILE": context / "interrupt.status",
                "STACK_CLEANUP_STATUS_FILE": context / "stack.status",
                "STACK_PID": "", "STACK_LAUNCH_ATTEMPTED": "0", "STACK_NATIVE_IDENTITY": "", "ACTIVE_COMMAND_PID": "",
                "ACTIVE_COMMAND_SIGNALLED": "0", "CODEX_AUTH_ADMISSION_TOKEN": "",
                "HEARTBEAT_SLEEP_PID": "", "TAIL_PID": "", "GUEST_DIAGNOSTICS_PID": "",
            }
            import shlex
            prefix = "\n".join(f"{key}={shlex.quote(str(value))}" for key, value in variables.items())
            result = subprocess.run(["bash", "-c", "set -uo pipefail\n" + prefix +
                                     "\nlog() { :; }\n" + script +
                                     "\ntrap cleanup_stack EXIT\nexit 143\n"],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 143, result.stderr)
            self.assertEqual((data / f"cloudbench-driver-clean-{token}.ack").read_text(), token + "\n")
            # The actual boot supervisor publishes exited only after the driver returns.
            (data / "cloudbench-driver.state").write_text("exited\n")
            server = runpy.run_path(str(SCRIPTS / "cloudbench-status-server.py"))
            manifest = server["runtime_evidence_manifest"](data, token, MACHINE)
            self.assertIs(manifest.get("prestack"), True)
            self.assertEqual(set(manifest["files"]), {"bench.log", f"cloudbench-prestack-{token}.sealed"})
            # A live driver, a foreign receipt, or any stack artifact invalidates this phase.
            seal = data / f"cloudbench-prestack-{token}.sealed"
            original = seal.read_bytes()
            for name, value in (("cloudbench-driver.pid", b"999\n"),
                                (f"cloudbench-prestack-{token}.sealed", b"foreign\n"),
                                ("repo/.context/cloudbench/services.json", b"{}")):
                target = data / name
                target.write_bytes(value)
                with self.assertRaises((OSError, ValueError, KeyError)):
                    server["runtime_evidence_manifest"](data, token, MACHINE)
                if target == seal:
                    target.write_bytes(original)
                else:
                    target.unlink()
            # Cancellation in the launch-to-PID assignment window must never
            # become a no-stack receipt, nor may an active command do so.
            for guard in ("STACK_LAUNCH_ATTEMPTED=1", "ACTIVE_COMMAND_PID=999999"):
                seal.unlink()
                guarded = subprocess.run(["bash", "-c", "set -uo pipefail\n" + prefix +
                                          "\n" + guard + "\nlog() { :; }\n" + script +
                                          "\ntrap cleanup_stack EXIT\nexit 143\n"],
                                         capture_output=True, text=True, timeout=10)
                self.assertEqual(guarded.returncode, 143, guarded.stderr)
                self.assertFalse(seal.exists(), guard)
                seal.write_bytes(original)
            port = free_port()
            secret = secrets.token_hex(32)
            env = dict(os.environ, CLOUDBENCH_BARRIER_TOKEN=secret, FLY_MACHINE_ID=MACHINE)
            process = subprocess.Popen([sys.executable, str(SCRIPTS / "cloudbench-status-server.py"),
                                        "--port", str(port), "--directory", str(data), "--run-token", token],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.1):
                            break
                    except OSError:
                        time.sleep(.02)
                for kind in ("recovery", "controller"):
                    out = base / kind
                    (out / "remote-logs").mkdir(parents=True)
                    owner = json.dumps({"version": 1, "run_token": token, "machine_id": MACHINE})
                    for name in ("runtime-evidence.pending", "runtime-evidence.owner.json"):
                        (out / name).write_text(owner)
                    if kind == "recovery":
                        command = [sys.executable, str(SCRIPTS / "cloudbench-collect-runtime-evidence.py"),
                                   str(out / "remote-logs"), str(port), token, MACHINE, "10"]
                    else:
                        collect = shell_function(SCRIPTS / "run-bench-cloud", "cloudbench_collect_runtime_evidence")
                        command = ["bash", "-c", collect + '\ncloudbench_collect_runtime_evidence "$@"',
                                   "collect", str(out / "remote-logs"), str(port), token, MACHINE, "10"]
                    captured = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
                    self.assertEqual(captured.returncode, 0, captured.stderr)
                    validate = shell_function(SCRIPTS / "run-bench-fleet", "cloudbench_validate_primary_runtime_evidence")
                    checked = subprocess.run(["bash", "-c", validate + '\ncloudbench_validate_primary_runtime_evidence "$@"',
                                              "validate", str(out), MACHINE, token],
                                             capture_output=True, text=True, timeout=10)
                    self.assertEqual(checked.returncode, 0, checked.stderr)
                    self.assertFalse((out / "runtime-evidence.pending").exists())
            finally:
                process.terminate()
                process.wait(timeout=5)

if __name__ == "__main__":
    unittest.main(verbosity=2)
