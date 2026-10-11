#!/usr/bin/env python3
"""Regression tests for the concurrent deploy structural-gate runner."""

from __future__ import annotations

import os
import contextlib
import importlib.util
import io
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


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

    def test_clone_recovery_is_registered(self) -> None:
        self.assertIn("bash scripts/tests/deploy-agent-clone-recovery.test.sh", _registry_commands())

    def test_compact_benchmark_gates_are_always_registered(self) -> None:
        self.assertTrue(
            {
                "bash scripts/tests/descend-command.test.sh",
                "python3 scripts/tests/benchmark-live-results.test.py",
                "bash scripts/tests/campaign-hub-grouping.test.sh",
                "bash scripts/tests/cloudbench-fetch-ref.test.sh",
                "python3 scripts/tests/verify-successful-llm-queries.test.py",
                "python3 scripts/tests/cloudbench-exact-session-multi-root.test.py",
                "python3 scripts/tests/cloudbench-forensic-quiesced.test.py",
                "python3 scripts/tests/cloudbench-bootstrap-recovery.test.py",
            }.issubset(_registry_commands())
        )

    def test_pytest_gate_wrapper_signals_reach_pytest(self) -> None:
        """Stopping the gate's PID must stop pytest, not orphan it."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wrapper = root / "scripts/tests/benchmark-live-results.test.py"
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text((ROOT / "scripts/tests/benchmark-live-results.test.py").read_text())
            pid_file = root / "pytest.pid"
            fake_python = root / "agents/venv/bin/python"
            fake_python.parent.mkdir(parents=True)
            fake_python.write_text(f'#!/bin/sh\necho $$ > "{pid_file}"\nexec sleep 60\n')
            fake_python.chmod(0o755)
            process = subprocess.Popen([sys.executable, str(wrapper)], start_new_session=True)
            try:
                deadline = time.monotonic() + 60
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(pid_file.exists(), "fake pytest never started")
                self.assertEqual(int(pid_file.read_text()), process.pid, "wrapper must exec pytest in place")
                process.terminate()
                self.assertEqual(process.wait(timeout=60), -signal.SIGTERM)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=60)

    def test_deploy_md_lists_every_registered_gate(self) -> None:
        deploy_md = DEPLOY_MD.read_text()
        missing = sorted(c for c in _registry_commands() if f"`{c}`" not in deploy_md)
        self.assertEqual(missing, [], f"deploy.md Step 4s is missing registered gate(s): {missing}")

    def test_deploy_md_lists_no_unregistered_gate(self) -> None:
        deploy_md = DEPLOY_MD.read_text()
        registry = _registry_commands()
        documented = {match.group(1) for match in re.finditer(r"`((?:bash|python3) scripts/tests/[^`]+)`", deploy_md)}
        stale = sorted(documented - registry)
        self.assertEqual(stale, [], f"deploy.md names gate(s) absent from the registry: {stale}")

    def test_agents_blackbox_registration_guard_is_a_deploy_gate(self) -> None:
        self.assertIn(
            "python3 agents/tests/structural/structural_test_registration.py",
            _registry_commands(),
            "agents blackbox registration must stay in /deploy; scripts/test.sh alone let dead tests land",
        )

    def test_cloudbench_blackbox_is_not_duplicated_with_agents_coverage(self) -> None:
        deploy_md = DEPLOY_MD.read_text()
        step = deploy_md.split("## Step 4cb:", 1)[1].split("## Step 4c:", 1)[0]
        self.assertIn('if [ -z "$CHANGED_AGENTS" ]; then', step)
        self.assertIn("./venv/bin/python scripts/run_blackbox_tests.py benchmark", step)
        self.assertIn("Step 4g's agents coverage already runs it", step)
        self.assertIn("wait for Step 4g to finish before starting", step)


class StructuralGatePortIsolationTests(unittest.TestCase):
    """Concurrent gates must not be able to hand out the same port.

    These suites allocate with check-then-bind (`lsof` probe, then bind), which
    is not parallel-safe: two gates that scan overlapping ranges can both see the
    same port as free and race for it. Because Step 4s runs every gate
    concurrently, overlapping ranges are a latent flake, not a theoretical one --
    `run-port-collision` scanned 61000-62000 while `kill-services` scanned
    62000-63000, so both could claim 62000.
    """

    def test_concurrent_gate_port_ranges_are_disjoint(self) -> None:
        ranges: dict[str, list[tuple[int, int]]] = {}
        for command in _registry_commands():
            script = ROOT / command.split()[-1]
            if not script.exists():
                continue
            for low, high in re.findall(r"seq\s+(\d{4,5})\s+(\d{4,5})", script.read_text()):
                ranges.setdefault(script.name, []).append((int(low), int(high)))

        overlaps = []
        names = sorted(ranges)
        for i, first in enumerate(names):
            for second in names[i + 1 :]:
                for low_a, high_a in ranges[first]:
                    for low_b, high_b in ranges[second]:
                        if low_a <= high_b and low_b <= high_a:
                            overlaps.append(f"{first} [{low_a}-{high_a}] overlaps {second} [{low_b}-{high_b}]")
        self.assertEqual(
            overlaps,
            [],
            "concurrently-run gates share a port range; check-then-bind will race:\n" + "\n".join(overlaps),
        )


class StructuralGatePipefailGrepTests(unittest.TestCase):
    """Source checks must not fail when a matching grep exits first.

    Under `set -o pipefail`, `printf '%s\\n' "$text" | grep -q pattern` fails
    with the writer's SIGPIPE (141) whenever grep matches and exits before the
    writer finishes. Concurrent gate load widens that window: the seed-cache
    preflight check failed this way 2/6 times in the deploy runner, and 110 of
    6,000 loaded iterations ended with PIPESTATUS=141 0. Feed the text with a
    here-string instead, which has no separate writer.
    """

    def test_pipefail_shell_tests_do_not_pipe_variables_into_grep_q(self) -> None:
        pattern = re.compile(r"""(?:printf '%s\\n'|echo) "\$\w+" \|\s*grep\s+-\w*q""")
        offenders = []
        for script in sorted((ROOT / "scripts" / "tests").glob("*.sh")):
            text = script.read_text()
            if "pipefail" not in text:
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{script.name}:{number}: {line.strip()}")
        self.assertEqual(offenders, [], "use grep ... <<<\"$text\" under pipefail:\n" + "\n".join(offenders))


class StructuralGateRunnerTests(unittest.TestCase):
    def test_default_admission_is_bounded_and_runs_every_gate_once(self) -> None:
        spec = importlib.util.spec_from_file_location("deploy_runner_admission", RUNNER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix="deploy-runner-admission-") as temporary:
            root = Path(temporary)
            release = root / "release"
            gates = tuple(
                module.Gate(
                    str(index),
                    (
                        sys.executable,
                        "-c",
                        (
                            "from pathlib import Path; import time; "
                            f"Path({str(root / f'gate-{index}')!r}).open('x').close(); "
                            f"release = Path({str(release)!r}); "
                            "\nwhile not release.exists(): time.sleep(0.02)\n"
                            f"raise SystemExit({7 if index == 10 else 0})"
                        ),
                    ),
                )
                for index in range(11)
            )
            launched = []
            real_popen = module.subprocess.Popen
            real_sleep = module.time.sleep

            def launch(command, **kwargs):
                launched.append(command)
                return real_popen(command, **kwargs)

            def observe_admission(seconds):
                if not release.exists():
                    try:
                        self.assertEqual(len(launched), 8)
                    finally:
                        release.touch()
                real_sleep(seconds)

            try:
                with (
                    patch.object(module, "GATES", gates),
                    patch.object(sys, "argv", [str(RUNNER)]),
                    patch.object(module.subprocess, "Popen", side_effect=launch),
                    patch.object(module.time, "sleep", side_effect=observe_admission),
                    contextlib.redirect_stdout(io.StringIO()),
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    result = module.main()
            finally:
                release.touch()
            self.assertEqual(launched, [gate.command for gate in gates])
            self.assertEqual(len(list(root.glob("gate-*"))), 11)
            self.assertEqual(result, 1, "a real gate failure must remain fatal")
            with (
                patch.object(module, "run_gates", return_value=0) as run,
                patch.object(sys, "argv", [str(RUNNER), "--max-workers", "3"]),
            ):
                self.assertEqual(module.main(), 0)
                run.assert_called_once_with(module.GATES, max_workers=3)

    def test_missing_host_tool_fails_before_any_gate_runs(self) -> None:
        spec = importlib.util.spec_from_file_location("deploy_runner_host_tools", RUNNER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        stderr = io.StringIO()
        with (
            patch.object(module.shutil, "which", side_effect=lambda tool: None if tool == "lsof" else "/usr/bin/" + tool),
            patch.object(module, "run_gates", return_value=0) as run,
            patch.object(sys, "argv", [str(RUNNER)]),
            contextlib.redirect_stderr(stderr),
        ):
            self.assertEqual(module.main(), 1)
        run.assert_not_called()
        self.assertIn("lsof", stderr.getvalue())
        self.assertIn("apt-get install -y lsof", stderr.getvalue())

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
            try:
                deadline = time.monotonic() + 60
                while not started.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(started.exists(), "the first gate did not start")

                process.send_signal(signal.SIGTERM)
                try:
                    output, _ = process.communicate(timeout=60)
                except subprocess.TimeoutExpired:
                    self.fail("runner did not escalate a TERM-resistant gate to SIGKILL")
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                try:
                    process.communicate(timeout=60)
                except subprocess.TimeoutExpired:
                    if process.poll() is not None:
                        self.fail("reaped harness left an open pipe; child ownership is unverified")
                    # Gate sessions are separate from the outer harness group.
                    # Retire only direct child groups still owned by this parent.
                    children = subprocess.run(
                        ["pgrep", "-P", str(process.pid)], capture_output=True, text=True, timeout=60
                    )
                    for child in children.stdout.split():
                        identity = subprocess.run(
                            ["ps", "-p", child, "-o", "ppid=,pgid="],
                            capture_output=True,
                            text=True,
                            timeout=60,
                        ).stdout.split()
                        if identity == [str(process.pid), child]:
                            try:
                                os.killpg(int(child), signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.communicate(timeout=60)

            self.assertEqual(process.returncode, 128 + signal.SIGTERM, output)
            self.assertFalse(never_started.exists(), "signal must not launch pending gates")


if __name__ == "__main__":
    unittest.main()
