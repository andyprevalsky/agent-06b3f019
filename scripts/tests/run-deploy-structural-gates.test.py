#!/usr/bin/env python3
"""Regression tests for the concurrent deploy structural-gate runner."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "run-deploy-structural-gates.py"


class StructuralGateRunnerTests(unittest.TestCase):
    def test_signal_does_not_wait_for_unlaunched_gates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="deploy-runner-signal-") as temporary:
            temporary_path = Path(temporary)
            started = temporary_path / "started"
            never_started = temporary_path / "never-started"
            harness = f"""
import importlib.util
import sys
from pathlib import Path

runner_path = Path({str(RUNNER)!r})
spec = importlib.util.spec_from_file_location("deploy_structural_runner", runner_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
gates = (
    module.Gate(
        "slow",
        (
            sys.executable,
            "-c",
            "from pathlib import Path; import signal; import time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "Path({str(started)!r}).write_text('started'); time.sleep(60)",
        ),
    ),
    module.Gate(
        "never",
        (
            sys.executable,
            "-c",
            "from pathlib import Path; Path({str(never_started)!r}).write_text('started')",
        ),
    ),
)
raise SystemExit(module.run_gates(gates, max_workers=1))
"""
            process = subprocess.Popen(
                (sys.executable, "-c", harness),
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                text=True,
            )
            deadline = time.monotonic() + 5
            while not started.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(started.exists(), "the first gate did not start")

            process.send_signal(signal.SIGTERM)
            try:
                output, _ = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                self.fail("runner did not escalate a TERM-resistant gate to SIGKILL")

            self.assertEqual(process.returncode, 128 + signal.SIGTERM, output)
            self.assertFalse(never_started.exists(), "signal must not launch pending gates")


if __name__ == "__main__":
    unittest.main()
