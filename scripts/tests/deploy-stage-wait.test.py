#!/usr/bin/env python3
"""Event-driven /deploy stage waits wake on the runner's own receipts.

Black-box: real ``scripts/run-deploy-stage`` runners in a temporary run root.
The waiter must wake promptly on completion (not on a fixed 60 s poll), fail
fast on the first failed lane without touching the others, and report a runner
that died without its finish receipt, a silent stall, and a plain timeout.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "scripts" / "run-deploy-stage"


class DeployStageWaitTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.run_root = Path(self._tmp.name) / "runs"
        self.env = dict(os.environ, DEPLOY_RUN_ROOT=str(self.run_root))
        self.children: list[subprocess.Popen[bytes]] = []
        subprocess.run(
            ["bash", str(WRAPPER), "--start", "--run-id", "waittest"],
            check=True,
            env=self.env,
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
        )

    def tearDown(self) -> None:
        for child in self.children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
        self._tmp.cleanup()

    def stage(self, name: str, script: str) -> subprocess.Popen[bytes]:
        child = subprocess.Popen(
            ["bash", str(WRAPPER), name, "--", "bash", "-c", script],
            env=self.env,
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.children.append(child)
        return child

    def wait(self, *arguments: str) -> tuple[int, dict, float]:
        started = time.monotonic()
        completed = subprocess.run(
            ["bash", str(WRAPPER), "--wait", *arguments],
            env=self.env,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        elapsed = time.monotonic() - started
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
        return completed.returncode, payload, elapsed

    def admitted(self, name: str) -> None:
        deadline = time.monotonic() + 10
        admissions = self.run_root / "waittest" / "admissions"
        while time.monotonic() < deadline:
            if any(path.name.startswith(f"{name}-") for path in admissions.glob("*.json")):
                return
            time.sleep(0.05)
        self.fail(f"{name} was never admitted")

    def test_wakes_on_completion_not_a_fixed_poll(self) -> None:
        since = f"{time.time():.3f}"
        self.stage("lane-a", "sleep 0.5")
        self.stage("lane-b", "sleep 1.5; echo done")
        code, payload, elapsed = self.wait("--since", since, "--timeout", "30", "lane-a", "lane-b")
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["event"], "passed")
        self.assertEqual(set(payload["finished"]), {"lane-a", "lane-b"})
        finished_epoch = payload["finished"]["lane-b"]["finished_epoch"]
        wake_latency = time.time() - finished_epoch
        self.assertLess(elapsed, 6, "waiter did not wake promptly after the last lane")
        self.assertLess(wake_latency, 3, "wake latency was not event-driven")

    def test_first_failure_wakes_immediately_and_leaves_other_lanes_running(self) -> None:
        since = f"{time.time():.3f}"
        slow = self.stage("lane-slow", "sleep 8")
        self.stage("lane-bad", "sleep 0.3; echo broken; exit 7")
        code, payload, elapsed = self.wait("--since", since, "--timeout", "30", "lane-slow", "lane-bad")
        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["failed"], ["lane-bad"])
        self.assertEqual(payload["finished"]["lane-bad"]["exit_code"], 7)
        self.assertLess(elapsed, 10)
        self.assertIsNone(slow.poll(), "the waiter must not cancel healthy lanes")

    def test_rows_before_since_never_satisfy_the_wait(self) -> None:
        self.stage("lane-old", "true").wait(timeout=20)
        code, payload, _elapsed = self.wait(
            "--since", f"{time.time():.3f}", "--timeout", "0.6", "lane-old"
        )
        self.assertEqual(code, 124, payload)
        self.assertEqual(payload["not_started"], ["lane-old"])

    def test_runner_killed_without_receipt_is_reported(self) -> None:
        since = f"{time.time():.3f}"
        runner = self.stage("lane-dies", "sleep 3")
        self.admitted("lane-dies")
        os.kill(runner.pid, signal.SIGKILL)  # the runner itself; no finish row
        runner.wait()
        code, payload, elapsed = self.wait("--since", since, "--timeout", "20", "lane-dies")
        self.assertEqual(code, 3, payload)
        self.assertEqual(payload["stage"], "lane-dies")
        self.assertLess(elapsed, 5)

    def test_stale_admission_before_since_is_not_a_death(self) -> None:
        # A forced kill before the runner installed its signal handlers can
        # leave an admission without a receipt. It predates this wait's
        # --since, so it must not report the rerun's lane as dead.
        admissions = self.run_root / "waittest" / "admissions"
        admissions.mkdir(parents=True, exist_ok=True)
        dead = subprocess.Popen(["true"])
        dead.wait()
        stale = admissions / f"lane-stale-{dead.pid}-deadbeef.json"
        stale.write_text(json.dumps({"schema_version": 1, "run_id": "waittest", "token": stale.stem, "pid": dead.pid}))
        old = time.time() - 120
        os.utime(stale, (old, old))
        since = f"{time.time():.3f}"
        code, payload, _elapsed = self.wait("--since", since, "--timeout", "0.6", "lane-stale")
        self.assertEqual(code, 124, payload)
        self.assertEqual(payload["not_started"], ["lane-stale"])

    def test_silent_stall_wakes_the_owner(self) -> None:
        since = f"{time.time():.3f}"
        self.stage("lane-quiet", "echo started; sleep 6")
        self.admitted("lane-quiet")
        code, payload, elapsed = self.wait(
            "--since", since, "--timeout", "20", "--stall-seconds", "1", "lane-quiet"
        )
        self.assertEqual(code, 4, payload)
        self.assertEqual(payload["stage"], "lane-quiet")
        self.assertLess(elapsed, 8)

    def test_healthy_lanes_time_out_without_being_cancelled(self) -> None:
        since = f"{time.time():.3f}"
        lane = self.stage("lane-long", "sleep 6")
        self.admitted("lane-long")
        code, payload, _elapsed = self.wait("--since", since, "--timeout", "0.5", "lane-long")
        self.assertEqual(code, 124, payload)
        self.assertEqual(payload["running"], ["lane-long"])
        self.assertIsNone(lane.poll())


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
