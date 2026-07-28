#!/usr/bin/env python3
"""Regression tests for the concurrent deploy structural-gate runner."""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "run-deploy-structural-gates.py"
DEPLOY_MD = ROOT / ".claude" / "commands" / "deploy.md"


def _registry_commands() -> set[str]:
    """Every gate command the runner will actually execute."""
    listed = subprocess.run(
        [sys.executable, str(RUNNER), "--list"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    source = RUNNER.read_text()
    body = source.split("GATES = (", 1)[1].split("\n)\n", 1)[0]
    commands = set()
    for match in re.finditer(r'\(\s*((?:"[^"]*"\s*,?\s*)+)\)', body):
        parts = re.findall(r'"([^"]*)"', match.group(1))
        if len(parts) >= 2:
            commands.add(" ".join(parts))
    assert len(commands) == len(listed), f"parsed {len(commands)} gates, runner lists {len(listed)}"
    return commands


class StructuralGateDocumentationTests(unittest.TestCase):
    """Step 4s lists its suites explicitly so a gate cannot be silently dropped.

    Several suites (approval-format, deploy-worktree-preflight, semantic-deploy,
    check-agent-behavior-approval) assert their own command still appears in
    deploy.md. Replacing that list with a registry pointer therefore removes
    real coverage while still looking tidy. Pin both directions instead.
    """

    def test_deploy_md_lists_every_registered_gate(self) -> None:
        deploy_md = DEPLOY_MD.read_text()
        missing = sorted(c for c in _registry_commands() if f"`{c}`" not in deploy_md)
        self.assertEqual(missing, [], f"deploy.md Step 4s is missing registered gate(s): {missing}")

    def test_deploy_md_lists_no_unregistered_gate(self) -> None:
        deploy_md = DEPLOY_MD.read_text()
        registry = _registry_commands()
        documented = {
            match.group(1)
            for match in re.finditer(r"`((?:bash|python3) scripts/tests/[^`]+)`", deploy_md)
        }
        stale = sorted(documented - registry)
        self.assertEqual(stale, [], f"deploy.md names gate(s) absent from the registry: {stale}")


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
            "from pathlib import Path; import time; "
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
                self.fail("runner hung after SIGTERM with pending gates")

            self.assertEqual(process.returncode, 128 + signal.SIGTERM, output)
            self.assertFalse(never_started.exists(), "signal must not launch pending gates")


if __name__ == "__main__":
    unittest.main()
