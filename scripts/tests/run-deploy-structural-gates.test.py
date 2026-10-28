#!/usr/bin/env python3
"""Regression tests for the concurrent deploy structural-gate runner."""

from __future__ import annotations

import os
import contextlib
import importlib.util
import io
import json
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
    assert len(commands) == len(listed), (
        f"parsed {len(commands)} gates, runner lists {len(listed)}"
    )
    return commands


class StructuralGateDocumentationTests(unittest.TestCase):
    """Step 4s lists its suites explicitly so a gate cannot be silently dropped.

    Several suites (approval-format, deploy-worktree-preflight, semantic-deploy,
    check-agent-behavior-approval) assert their own command still appears in
    deploy.md. Replacing that list with a registry pointer therefore removes
    real coverage while still looking tidy. Pin both directions instead.
    """

    def test_frontend_coverage_requires_app_typecheck_before_vitest(self) -> None:
        package = json.loads((ROOT / "front-end" / "package.json").read_text())
        command = package["scripts"]["test:coverage"]
        self.assertRegex(
            command,
            r"^tsc --noEmit -p tsconfig\.app\.json\s*&&\s*vitest run --coverage(?:\s|$)",
            "coverage must typecheck the app project before running Vitest",
        )
        app_config = (ROOT / "front-end" / "tsconfig.app.json").read_text()
        self.assertRegex(app_config, r'"include"\s*:\s*\[\s*"src"')
        self.assertTrue((ROOT / "front-end" / "src").is_dir())

    def test_clone_recovery_is_registered(self) -> None:
        self.assertIn(
            "bash scripts/tests/deploy-agent-clone-recovery.test.sh",
            _registry_commands(),
        )

    def test_compact_benchmark_gates_are_always_registered(self) -> None:
        self.assertTrue(
            {
                "bash scripts/tests/descend-command.test.sh",
                "python3 scripts/tests/benchmark-live-results.test.py",
                "python3 scripts/tests/cloudbench-provider-capacity.test.py",
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
        self.assertEqual(
            missing, [], f"deploy.md Step 4s is missing registered gate(s): {missing}"
        )

    def test_deploy_md_lists_no_unregistered_gate(self) -> None:
        deploy_md = DEPLOY_MD.read_text()
        registry = _registry_commands()
        documented = {match.group(1) for match in re.finditer(r"`((?:bash|python3) scripts/tests/[^`]+)`", deploy_md)}
        stale = sorted(documented - registry)
        self.assertEqual(
            stale, [], f"deploy.md names gate(s) absent from the registry: {stale}"
        )

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
            for low, high in re.findall(
                r"seq\s+(\d{4,5})\s+(\d{4,5})", script.read_text()
            ):
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


class StructuralGateInterpreterTests(unittest.TestCase):
    """The agents venv is preferred only when it is the pinned Python 3.11+.

    cloud-build.sh falls back to whatever `python3` exists when Python 3.11
    setup fails, so a venv can exist with an interpreter the suites cannot run
    on. Prepending that venv made every gate fail on the wrong interpreter.
    """

    def _runner_with_venv(self, temporary: str, version: str):
        spec = importlib.util.spec_from_file_location("deploy_runner_venv", RUNNER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        venv = Path(temporary) / "venv"
        venv_bin = venv / "bin"
        venv_bin.mkdir(parents=True)
        (venv_bin / "python3").write_text("#!/bin/sh\n")
        (venv / "pyvenv.cfg").write_text(f"home = /usr/bin\nversion = {version}\n")
        module.VENV_BIN = venv_bin
        return module, venv_bin

    def test_supported_venv_interpreter_is_put_first(self) -> None:
        with tempfile.TemporaryDirectory(prefix="deploy-runner-venv-") as temporary:
            module, venv_bin = self._runner_with_venv(temporary, "3.11.9")
            self.assertTrue(module.gate_environment()["PATH"].startswith(f"{venv_bin}{os.pathsep}"))

    def test_unsupported_venv_interpreter_is_not_preferred(self) -> None:
        with tempfile.TemporaryDirectory(prefix="deploy-runner-venv-") as temporary:
            module, venv_bin = self._runner_with_venv(temporary, "3.10.5")
            self.assertEqual(module.gate_environment().get("PATH"), os.environ.get("PATH"))
            self.assertNotIn(str(venv_bin), module.gate_environment().get("PATH", ""))


class LinuxGateFailedStepTests(unittest.TestCase):
    """The Linux controller gate names its failed suites from the machine log.

    A log read can miss the summary line, the per-step markers, or both. The
    controller runs under `set -euo pipefail`, where an unmatched grep in a
    command substitution used to end it before it told the machine its logs
    were fetched, leaving the machine to wait out its 900-second window.
    """

    GATE = ROOT / "scripts" / "run-cloudbench-controller-gate"

    def _parse(self, name: str, log_text: str) -> subprocess.CompletedProcess[str]:
        function = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", self.GATE.read_text(), re.M | re.S)
        self.assertIsNotNone(function, f"the gate script must keep {name}()")
        with tempfile.TemporaryDirectory(prefix="linux-gate-steps-") as temporary:
            log = Path(temporary) / "machine.log"
            log.write_text(log_text)
            script = f'set -euo pipefail\n{function.group(0)}\nsteps="$({name} "$1")"\necho "steps:[$steps]"\n'
            return subprocess.run(["bash", "-c", script, "gate", str(log)], capture_output=True, text=True, timeout=30)

    def _failed_steps(self, log_text: str) -> subprocess.CompletedProcess[str]:
        return self._parse("gate_failed_steps", log_text)

    def test_summary_line_names_the_failed_steps(self) -> None:
        result = self._failed_steps("GATE_STEP_FAILED 9\nGATE_FAILED_STEPS 2 5\nGATE_RESULT exit=1\n")
        self.assertEqual((result.returncode, result.stdout.split()), (0, ["steps:[", "2", "5]"]), result.stderr)

    def test_step_markers_are_the_fallback(self) -> None:
        result = self._failed_steps("GATE_STEP_FAILED 3\nGATE_STEP_FAILED 7\nGATE_RESULT exit=1\n")
        self.assertEqual((result.returncode, result.stdout.split()), (0, ["steps:[3", "7]"]), result.stderr)

    def test_a_log_with_neither_marker_is_an_empty_answer(self) -> None:
        result = self._failed_steps("GATE_RESULT exit=1\n")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "steps:[]"), result.stderr)

    def test_running_suite_is_the_latest_numbered_start_marker(self) -> None:
        # Fly returns about 100 lines per read, so the markers for suites 1-5
        # can be missing from the log by the time suite 6 times out.
        result = self._parse("gate_running_step", "GATE_STEP bash a exit=0\nGATE_STEP_START #6 bash b\npartial output\n")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "steps:[6]"), result.stderr)

    def test_a_log_without_a_start_marker_names_no_running_suite(self) -> None:
        result = self._parse("gate_running_step", "GATE_ENV backend_env=yes\n")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "steps:[0]"), result.stderr)

    def test_remote_runner_numbers_its_start_markers(self) -> None:
        self.assertIn('GATE_STEP_START #%%s %%s', self.GATE.read_text())


class StructuralGateRunnerTests(unittest.TestCase):
    def test_workflow_behavior_has_one_registered_execution(self) -> None:
        """Execute the real semantic ownership stanza and dispatcher commands.

        Inert owner scripts count invocations and return real child statuses;
        they stand in for the expensive fleet/workflow fixtures, not the wiring
        under test. Running the whole semantic suite here would itself duplicate
        its independently registered parser and session controls.
        """
        spec = importlib.util.spec_from_file_location("deploy_runner_owners", RUNNER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        semantic_source = (
            ROOT / "scripts/tests/semantic-deploy-gate.test.sh"
        ).read_text()
        ownership = semantic_source.split(
            "# /descend is part of the deploy orchestration surface.", 1
        )[1]
        ownership = ownership.split("\n", 1)[1]
        ownership = ownership.split('node --test "$PROD_SESSION_TEST"', 1)[0]
        selected = tuple(
            gate
            for gate in module.GATES
            if gate.name
            in {
                "descend-command",
                "semantic-deploy",
            }
        )
        cases = (
            (None, None),
            ("descend-command", None),
            (None, "missing"),
            (None, "duplicate"),
            (None, "wrong-command"),
        )
        for failing_owner, registry_fault in cases:
            with (
                self.subTest(
                    failing_owner=failing_owner, registry_fault=registry_fault
                ),
                tempfile.TemporaryDirectory(
                    prefix="deploy-runner-owners-"
                ) as temporary,
            ):
                root = Path(temporary)
                scripts = root / "scripts/tests"
                scripts.mkdir(parents=True)
                calls = root / "calls"
                for name, filename in (
                    ("descend-command", "descend-command.test.sh"),
                ):
                    (scripts / filename).write_text(
                        f"printf '%s\\n' {name!r} >> \"$GATE_CALLS\"\n"
                        f"exit {7 if name == failing_owner else 0}\n"
                    )
                registry_path = RUNNER
                if registry_fault:
                    registry_path = root / "registry.py"
                    faults = {
                        "missing": 'GATES = tuple(gate for gate in GATES if gate.name != "descend-command")',
                        "duplicate": 'GATES += (Gate("duplicate", ("bash", "scripts/tests/descend-command.test.sh")),)',
                        "wrong-command": 'GATES = tuple(Gate(gate.name, ("bash", "wrong-owner.sh")) if gate.name == "descend-command" else gate for gate in GATES)',
                    }
                    registry_path.write_text(
                        RUNNER.read_text() + "\n" + faults[registry_fault] + "\n"
                    )
                (scripts / "semantic-deploy-gate.test.sh").write_text(
                    "set -euo pipefail\n"
                    f"DESCEND_COMMAND_TEST={str(scripts / 'descend-command.test.sh')!r}\n"
                    f"DEPLOY_COMMAND={str(DEPLOY_MD)!r}\n"
                    f"DEPLOY_STRUCTURAL_RUNNER={str(registry_path)!r}\n"
                    'fail() { echo "FAIL: $1" >&2; exit 1; }\n'
                    'require_text() { grep -Fq -- "$2" "$1" || fail "$3"; }\n'
                    + ownership
                )
                output = io.StringIO()
                with (
                    patch.object(module, "ROOT", root),
                    patch.dict(os.environ, {"GATE_CALLS": str(calls)}),
                    contextlib.redirect_stdout(output),
                ):
                    result = module.run_gates(selected, max_workers=3)
                observed = calls.read_text().splitlines()
                self.assertEqual(
                    sorted(observed),
                    ["descend-command"],
                    output.getvalue(),
                )
                self.assertEqual(
                    result,
                    1 if failing_owner or registry_fault else 0,
                    output.getvalue(),
                )
                if registry_fault:
                    self.assertIn(
                        "must have exactly one registered behavior owner",
                        output.getvalue(),
                    )

    def test_default_admission_is_bounded_and_runs_every_gate_once(self) -> None:
        spec = importlib.util.spec_from_file_location("deploy_runner_admission", RUNNER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(
            prefix="deploy-runner-admission-"
        ) as temporary:
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
                    patch.object(module, "FAILURE_STATE", root / "failures.json"),
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
                run.assert_called_once_with(
                    module.GATES,
                    max_workers=3,
                    failure_state=module.ROOT / module.FAILURE_STATE,
                )

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
                while (
                    not started.exists()
                    and process.poll() is None
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.02)
                self.assertTrue(started.exists(), "the first gate did not start")

                process.send_signal(signal.SIGTERM)
                try:
                    output, _ = process.communicate(timeout=60)
                except subprocess.TimeoutExpired:
                    self.fail(
                        "runner did not escalate a TERM-resistant gate to SIGKILL"
                    )
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                try:
                    process.communicate(timeout=60)
                except subprocess.TimeoutExpired:
                    if process.poll() is not None:
                        self.fail(
                            "reaped harness left an open pipe; child ownership is unverified"
                        )
                    # Gate sessions are separate from the outer harness group.
                    # Retire only direct child groups still owned by this parent.
                    children = subprocess.run(
                        ["pgrep", "-P", str(process.pid)],
                        capture_output=True,
                        text=True,
                        timeout=60,
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
            self.assertFalse(
                never_started.exists(), "signal must not launch pending gates"
            )


class LinuxGateStorageRetentionTests(unittest.TestCase):
    """Test public refusal and the post-admission body with offline transports.

    The public wrapper deliberately has no allocation authority. Legacy storage
    and export cases therefore need synthetic admission in a temporary copy;
    they are component coverage, never proof that the public route may allocate.
    """

    def _run(self, retain="0", size="", outcome="0", export="0", bad_collector=False, workspace="", volume_fault="", command=None, keep_tmp="0", admitted=True, disposable=False, gate_path=None):
        temporary = tempfile.TemporaryDirectory(prefix="gate-storage-retention-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        transport = root / "bin"
        transport.mkdir()
        calls = root / "calls.jsonl"
        fly = transport / "flyctl"
        fly.write_text("#!" + sys.executable + "\n" + r'''
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
with Path(os.environ['GATE_TEST_CALLS']).open('a') as out: out.write(json.dumps(args)+'\n')
if args[:2]==['volumes','create']:
    fault=os.environ.get('GATE_TEST_VOLUME_FAULT','')
    if fault=='create-failed': print('incomplete native response'); raise SystemExit(5)
    value={'id':'vol_fixture123','name':args[2],'region':args[args.index('--region')+1],'size_gb':int(args[args.index('--size')+1]),'encrypted':True,'attached_machine_id':None}
    if fault=='wrong-region': value['region']='foreign'
    if fault=='wrong-name': value['name']='foreign'
    if fault=='wrong-size': value['size_gb']=1
    if fault=='false-size': value['size_gb']=True
    if fault=='attached': value['attached_machine_id']='foreign'
    if fault=='unencrypted': value['encrypted']=False
    if fault=='bad-id': value['id']='foreign/unsafe'
    if os.environ.get('GATE_TEST_NATIVE_STATE'):
        state=Path(os.environ['GATE_TEST_NATIVE_STATE']);values=json.loads(state.read_text());values['volume']={**value,'state':'created','auto_backup_enabled':True};state.write_text(json.dumps(values))
    print(json.dumps(value))
elif args[:2]==['machine','run']:
    if os.environ.get('GATE_TEST_VOLUME_FAULT')=='machine-refused': print('provider refused before creation');raise SystemExit(6)
    if os.environ.get('GATE_TEST_NATIVE_STATE'):
        state=Path(os.environ['GATE_TEST_NATIVE_STATE']);values=json.loads(state.read_text());values['machine']={'id':'abcdef12345678','instance_id':'fixture-instance','name':args[args.index('--name')+1],'region':args[args.index('--region')+1],'state':'started','config':{'image':args[2],'guest':{'cpu_kind':'performance','cpus':8,'memory_mb':32768},'mounts':[{'volume':values['volume']['id'],'path':'/tmp/gate'}]}};values['volume']['attached_machine_id']='abcdef12345678';state.write_text(json.dumps(values))
    import subprocess
    uploaded=dict(arg.split('=',1) for i,arg in enumerate(args) if i and args[i-1]=='--file-local')
    subprocess.run(['bash','-n',uploaded['/tmp/gate.sh']],check=True)
    if os.environ.get('GATE_TEST_SCRIPT_COPY'): Path(os.environ['GATE_TEST_SCRIPT_COPY']).write_bytes(Path(uploaded['/tmp/gate.sh']).read_bytes())
    if os.environ.get('GATE_TEST_VOLUME_FAULT')=='machine-failed': print('provider refused VM');raise SystemExit(6)

    if os.environ.get('GATE_TEST_EXPORT')=='1':
        import types,tarfile
        from argparse import Namespace
        remote=Path(os.environ['GATE_TEST_REMOTE']);repo=remote/'repo';repo.mkdir(parents=True)
        (repo/'.context').mkdir();(repo/'scripts').mkdir();(repo/'.git').mkdir()
        (repo/'.context/original.log').write_bytes(b'original remote controller evidence')
        files=dict(arg.split('=',1) for i,arg in enumerate(args) if i and args[i-1]=='--file-local')
        helper=Path(files['/tmp/controller-host-export.py'])
        if '/tmp/controller-host-workspace.json' in files:
            import subprocess,hashlib
            env=dict(os.environ)
            for i,arg in enumerate(args):
                if i and args[i-1]=='-e':
                    key,value=arg.split('=',1);env[key]=value
            env['GATE_REF']='a'*40;env['FLY_APP_NAME']=args[args.index('-a')+1]
            os.environ.update({key:value for key,value in env.items() if key.startswith('GATE_WORKSPACE_')})
            script=Path(files['/tmp/gate.sh']).read_text()
            assert 'mountpoint -q /tmp/gate' in script
            code=script.split("<<'PY_WORKSPACE_CUSTODY'\n",1)[1].split('\nPY_WORKSPACE_CUSTODY',1)[0]
            code=code.replace('/tmp/controller-host-workspace.json',files['/tmp/controller-host-workspace.json']).replace('/tmp/gate/repo',str(repo))
            subprocess.run([sys.executable,'-I','-B','-c',code],env=env,check=True)
            assert (repo/'.context/controller-workspace-volume/ownership.json').read_bytes()==Path(files['/tmp/controller-host-workspace.json']).read_bytes()

        original_iter=Path.iterdir
        def bounded_proc(path):
            if str(path)!='/proc': return original_iter(path)
            selected=[]
            for process in original_iter(path):
                try:
                    if process.name.isdecimal() and process.stat().st_uid==os.getuid():
                        status=Path(str(process)+'/stat').read_text();fields=status[status.rfind(')')+2:].split()
                        if int(process.name) in (os.getpid(),os.getppid()) or int(fields[1])==os.getppid(): selected.append(process)
                except (FileNotFoundError, ProcessLookupError): continue  # exited mid-scan
            return iter(selected)
        Path.iterdir=bounded_proc
        subject={'__name__':'fake_native_collector','__file__':str(helper)}
        exec(compile(helper.read_bytes(),str(helper),'exec'),subject)
        subject['record_temp_roots']=lambda repo,common:[str(remote/'owned-temp-state')]
        os.environ['FLY_MACHINE_ID']='abcdef12345678';os.environ['FLY_APP_NAME']=args[args.index('-a')+1]
        subject['launch'](Namespace(repo=repo,record=remote/'launch.json',driver_pid=os.getpid(),caller=Path(files['/tmp/controller-host-caller.json']),ref='a'*40,image='fixture/immutable@sha256:'+'b'*64))
        if os.environ.get('GATE_TEST_VOLUME_FAULT')=='exchanged-owner': (repo/'.context/controller-workspace-volume/ownership.json').write_text('{}')
        if os.environ.get('GATE_TEST_VOLUME_FAULT')=='missing-owner': (repo/'.context/controller-workspace-volume/ownership.json').unlink()
        rc=subject['export'](Namespace(record=remote/'launch.json',archive=remote/'originals.tar.gz',manifest=remote/'manifest.json',pending=remote/'pending.json'))
        if rc: raise SystemExit(rc)
    print('Machine ID: abcdef12345678')
elif args[0]=='logs':
    outcome=os.environ['GATE_TEST_OUTCOME']
    if outcome!='timeout': print('GATE_RESULT exit='+outcome)
elif args[:2]==['machines','list']: print('[{"id":"abcdef12345678","state":"started"}]')
elif args[:3]==['ssh','sftp','get']:
    if os.environ.get('GATE_TEST_EXPORT')=='1':
        import shutil
        shutil.copyfile(Path(os.environ['GATE_TEST_REMOTE'])/Path(args[-2]).name,args[-1])
    else: Path(args[-1]).write_text('fixture original log\n')
''')
        fly.chmod(0o700)
        git_transport = transport/"git"
        git_transport.write_text("#!"+sys.executable+"\n"+"""import os,sys
from pathlib import Path
args=sys.argv[1:]
if 'show' in args:
    if os.environ.get('GATE_TEST_BAD_COLLECTOR')=='1': sys.stdout.write('substituted bytes')
    else:
        path=args[args.index('show')+1].split(':',1)[1]
        sys.stdout.buffer.write((Path(os.environ['GATE_TEST_SOURCE']).parent.parent/path).read_bytes())
elif '--git-common-dir' in args: print(str(Path(os.environ['GATE_TEST_REMOTE'])/'repo/.git'))
elif 'diff' in args: pass
elif 'rev-parse' in args: print('a'*40)
else: print('origin/fixture')
""")
        git_transport.chmod(0o700)
        for name, text in {
            "sleep": "#!/bin/sh\nexit 0\n",
        }.items():
            path = transport / name
            path.write_text(text)
            path.chmod(0o700)
        env = {**os.environ, "PATH": str(transport)+os.pathsep+os.environ["PATH"],
               "FLY_API_TOKEN":"offline-fixture", "GITHUB_TOKEN":"offline-fixture",
               "CLOUDBENCH_GATE_REF":"a"*40, "WARM_IMAGE_REF":"fixture/immutable@sha256:"+"b"*64,
               "CLOUDBENCH_GATE_NODE_VERSION":"v24.21.0", "CLOUDBENCH_GATE_LOG":str(root/"machine.log"),
               "CLOUDBENCH_GATE_TIMEOUT_S":"0" if outcome=="timeout" else "30",
               "CLOUDBENCH_GATE_RETAIN_HOST":retain, "CLOUDBENCH_GATE_ROOTFS_SIZE_GB":size,
               "CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE":keep_tmp,
               "GATE_TEST_CALLS":str(calls), "GATE_TEST_OUTCOME":outcome,
               "CLOUDBENCH_GATE_EXPORT_HOST":export,"CLOUDBENCH_GATE_EXPORT_DIR":str(root/"custody"),
               "GATE_TEST_EXPORT":export,"GATE_TEST_REMOTE":str(root/"remote"),
               "GATE_TEST_BAD_COLLECTOR":"1" if bad_collector else "0",
               "GATE_TEST_SOURCE":str(ROOT/"scripts/cloudbench-controller-export.py"),
               "CLOUDBENCH_GATE_WORKSPACE_VOLUME_SIZE_GB":workspace,"GATE_TEST_VOLUME_FAULT":volume_fault}
        env.pop("CLOUDBENCH_GATE_SELF_COPY", None)
        env.pop("CLOUDBENCH_GATE_ROOT_DIR", None)
        gate = Path(gate_path) if gate_path else ROOT / "scripts/run-cloudbench-controller-gate"
        if disposable:
            import hashlib,runpy,threading
            from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
            state=root/'native-state.json';state.write_text(json.dumps(dict(machine=None,volume=None)))
            protected=['keep'+str(i)for i in range(4)]
            api_calls=[]
            class Handler(BaseHTTPRequestHandler):
                def log_message(self,*unused):pass
                def dispatch(self):
                    path=self.path.split('/v1/apps/navi-whisper-lux-bench',1)[1]
                    api_calls.append([self.command,path]);values=json.loads(state.read_text());result=None;status=200
                    if self.command=='GET' and path in('/machines','/machines?summary=true'):result=[dict(id=x)for x in protected]+([values['machine']]if values['machine']else [])
                    elif self.command=='GET' and path=='/machines/abcdef12345678':result=values['machine'];status=200 if result else 404
                    elif self.command=='GET' and path=='/volumes/vol_fixture123':result=values['volume'];status=200 if result else 404
                    elif self.command=='PUT' and path=='/volumes/vol_fixture123':
                        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));assert body=={'auto_backup_enabled':False};values['volume'].update(body);result=values['volume'];state.write_text(json.dumps(values))
                    elif self.command=='DELETE' and path=='/machines/abcdef12345678?kill=true':values['machine']=None;values['volume']['attached_machine_id']=None;state.write_text(json.dumps(values));result={}
                    elif self.command=='DELETE' and path=='/volumes/vol_fixture123':values['volume']['state']='pending_destroy';state.write_text(json.dumps(values));result={}
                    else:raise AssertionError((self.command,path))
                    raw=json.dumps(result).encode();self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                do_GET=do_PUT=do_DELETE=dispatch
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
            subject=runpy.run_path(str(ROOT/'scripts/cloudbench-disposable-controller.py'))
            auth=dict(schema='cloudbench-disposable-controller-authority-v1',allowed=True,single_host=True,app='navi-whisper-lux-bench',region='iad',vm_size='performance-8x',memory_mib=32768,workspace_size_gb=256,org_machine_limit=1000,org_object_count=4,verified_epoch=time.time(),cleanup_owner_pid=os.getpid(),cleanup_owner_birth=subject['birth'](os.getpid()),protected_machines=protected,protected_volumes=['vol_keep'],source_ref='a'*40,env_files={},output_directory=str(root/'custody'))
            proof=root/'capacity.json';proof.write_text('{}');proof.chmod(0o600);auth['capacity_proof']=dict(path=str(proof),sha256=hashlib.sha256(proof.read_bytes()).hexdigest())
            for component in ('agents','backend'):
                file=root/(component+'.env');file.write_text('COMPLETE_FIXTURE=value\n');file.chmod(0o600);auth['env_files'][component]=dict(path=str(file),sha256=hashlib.sha256(file.read_bytes()).hexdigest())
            authority=root/'authority.json';authority.write_text(json.dumps(auth));authority.chmod(0o600)
            env.update(FLY_API_HOSTNAME='http://127.0.0.1:'+str(server.server_port),GATE_TEST_NATIVE_STATE=str(state),GATE_TEST_EXPORT='1')
            admitted=False
        if admitted:
            # Only the offline fixture crosses admission. Keep the production
            # file untouched and retain all refusal checks in public tests.
            # Four creation-admission sites: two direct exits and two early
            # sites whose wrapper adds the typed no-effect refusal receipt.
            source = gate.read_text()
            boundary = "controller_machine_creation_admission || exit $?"
            early = "\nearly_controller_admission\n"
            self.assertEqual(source.count(boundary), 2)
            self.assertEqual(source.count(early), 2)
            gate = root / "synthetically-admitted-gate.sh"
            gate.write_text(source.replace(boundary, ": # offline fixture admission")
                            .replace(early, "\n: # offline fixture admission\n"))
            env["CLOUDBENCH_GATE_SELF_COPY"] = str(gate)
            env["CLOUDBENCH_GATE_ROOT_DIR"] = str(ROOT)
        flag=["--disposable-controller",str(authority)]if disposable else []
        result = subprocess.run(["bash",str(gate),*flag,"--",*(command or ["true"])],
                                cwd=ROOT, env=env, text=True, capture_output=True, timeout=30)
        records = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
        if disposable:
            failed_before_host=volume_fault=='machine-refused'
            if failed_before_host:self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            else:
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertTrue((root/'custody/disposable-export.verified.json').exists())
            helper=ROOT/'scripts/cloudbench-disposable-controller.py'
            cleanup=subprocess.run([sys.executable,str(helper),'cleanup-workspace'if failed_before_host else'cleanup','--authority',str(authority),'--root',str(ROOT),'--directory',str(root/'custody'),'--workspace',str(root/'custody/workspace-volume.ownership.json')],env=env,capture_output=True,text=True,timeout=20)
            self.assertEqual(cleanup.returncode,0,cleanup.stdout+cleanup.stderr)
            self.assertEqual([x for x in api_calls if x[0]=='DELETE'],([['DELETE','/volumes/vol_fixture123']]if failed_before_host else[['DELETE','/machines/abcdef12345678?kill=true'],['DELETE','/volumes/vol_fixture123']]))
            self.assertTrue((root/'custody/disposable-controller.release.json').exists())
        return result, records

    def test_public_disposable_controller_creates_exports_and_disposes_exact_host(self):
        result,calls=self._run(disposable=True,command=['true'])
        create=next(row for row in calls if row[:2]==['volumes','create'])
        self.assertEqual(create[create.index('--size')+1],'256')
        run=next(row for row in calls if row[:2]==['machine','run'])
        self.assertEqual(run[run.index('--vm-size')+1],'performance-8x')
        self.assertEqual(run[run.index('--vm-memory')+1],'32768')
        self.assertIn('GATE_EXPORT_VERIFIED',result.stdout)

    def test_public_disposable_controller_partial_failure_disposes_only_exact_workspace(self):
        result,calls=self._run(disposable=True,command=['true'],volume_fault='machine-refused')
        self.assertFalse(any(row[:2]==['machine','destroy']for row in calls))

    def test_public_entrypoint_refuses_unadmitted_creation_before_any_provider_call(self):
        for options in ({}, {"retain": "1", "export": "1", "workspace": "80", "size": "50"}):
            with self.subTest(options=options):
                result, calls = self._run(admitted=False, **options)
                self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
                self.assertIn("reuse an existing retained controller", result.stderr)
                self.assertEqual(calls, [])

    def test_stress200_existing_allocator_requires_sealed_minimum_plan(self):
        driver=ROOT/"agents/benchmarks/fixtures/cloudbench_cleanup_reserve_cohort.py"
        with tempfile.TemporaryDirectory(prefix="stress200-owning-") as temporary:
            for sealed in (False,True):
                with self.subTest(sealed=sealed):
                    work=Path(temporary)/("sealed" if sealed else "unsealed")
                    env={**os.environ,"RESERVE_FIXTURE_OWNER_COUNT":"200","RESERVE_FIXTURE_CAPACITY_MB":"72705","RESERVE_FIXTURE_UNSEALED":"0" if sealed else "1","RESERVE_FIXTURE_NESTED":"1" if sealed else "","PYTHONDONTWRITEBYTECODE":"1"}
                    result=subprocess.run([sys.executable,"-B",str(driver),str(ROOT/"scripts/run-bench-fleet"),str(work)],env=env,capture_output=True,text=True,timeout=120)
                    receipt=json.loads((work/"receipt.safe.json").read_text())
                    self.assertEqual(receipt["owner_count"],200)
                    self.assertEqual(receipt["provider_calls"],0)
                    self.assertEqual(result.returncode==0,sealed)
                    if sealed:
                        self.assertEqual(receipt["admitted"],200);self.assertEqual(receipt["nested_canary_exit"],0)
                        self.assertTrue(all(receipt["assertions"].values()))
                    else:self.assertLess(receipt["admitted"],200);self.assertGreater(receipt["failed"],0)
                    self.assertTrue(json.loads((work/"child-drain.safe.json").read_text())["all_reaped"])

    def test_gate_bootstrap_real_git_preserves_origin_main_ancestry(self):
        with tempfile.TemporaryDirectory(prefix="gate-real-origin-") as temporary:
            root=Path(temporary);origin=root/"origin";origin.mkdir()
            subprocess.run(["git","init","-qb","main",str(origin)],check=True)
            (origin/"original").write_text("main")
            subprocess.run(["git","-C",str(origin),"add","original"],check=True)
            subprocess.run(["git","-C",str(origin),"-c","user.name=fixture","-c","user.email=f@example.invalid","commit","-qm","main"],check=True)
            base=subprocess.check_output(["git","-C",str(origin),"rev-parse","HEAD"],text=True).strip()
            subprocess.run(["git","-C",str(origin),"checkout","-qb","feature"],check=True)
            (origin/"original").write_text("feature")
            subprocess.run(["git","-C",str(origin),"-c","user.name=fixture","-c","user.email=f@example.invalid","commit","-qam","feature"],check=True)
            ref=subprocess.check_output(["git","-C",str(origin),"rev-parse","HEAD"],text=True).strip()
            gate=(ROOT/"scripts/run-cloudbench-controller-gate").read_text()
            start=gate.index("  echo 'git init -q repo && cd repo'");end=gate.index("  echo '# Dependencies",start)
            producer=gate[start:end]
            script=subprocess.check_output(["bash","-c",producer],text=True)
            host=root/"host";host.mkdir()
            subprocess.run(["bash","-c",script],cwd=host,env={**os.environ,"GATE_REPO_URL":origin.as_uri(),"GATE_REF":ref,"token":"offline"},check=True)
            repo=host/"repo"
            self.assertEqual(subprocess.check_output(["git","-C",str(repo),"remote","get-url","origin"],text=True).strip(),origin.as_uri())
            self.assertEqual(subprocess.check_output(["git","-C",str(repo),"merge-base",ref,"origin/main"],text=True).strip(),base)

    def test_generated_gate_multiline_command_labels_are_shell_safe(self):
        body="set -euo pipefail\npython3 -c \"import site;site.addsitedir('/app/agents/venv/lib/python3.11/site-packages')\"\n"
        result,_=self._run(retain="1",command=["bash","-c",body,"fixture","1791923515.9527698"])
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_controller_export_real_foreign_uid_git_is_command_scoped(self):
        with tempfile.TemporaryDirectory(prefix="gate-foreign-uid-") as temporary:
            repo=Path(temporary)/"repo";repo.mkdir()
            subprocess.run(["git","init","-q",str(repo)],check=True)
            (repo/"original").write_text("retained original")
            subprocess.run(["git","-C",str(repo),"add","original"],check=True)
            subprocess.run(["git","-C",str(repo),"-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-qm","original"],check=True)
            expected=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
            Path(temporary).chmod(0o755)
            repo.chmod(0o755)
            for item in repo.rglob("*"): item.chmod(0o755 if item.is_dir() else 0o644)
            subprocess.run(["sudo","-n","chown","-R","0:0",str(repo)],check=True)
            try:
                refused=subprocess.run(["git","-C",str(repo),"rev-parse","HEAD"],capture_output=True,text=True)
                self.assertNotEqual(refused.returncode,0);self.assertIn("dubious ownership",refused.stderr)
                spec=importlib.util.spec_from_file_location("collector_foreign",ROOT/"scripts/cloudbench-controller-export.py")
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                # The pre-fix exporter helper (d1a87a9c, never merged to main, so absent from fresh clones).
                def original_git(repo, *args):
                    return subprocess.check_output(["git", "-C", str(repo), *args]).decode().strip()
                with self.assertRaises(subprocess.CalledProcessError): original_git(repo,"rev-parse","HEAD")
                self.assertEqual(module.git(repo,"rev-parse","HEAD"),expected)
                gate=(ROOT/"scripts/run-cloudbench-controller-gate").read_text()
                self.assertIn("'safe.directory=/tmp/gate/repo'",gate)
            finally:
                subprocess.run(["sudo","-n","chown","-R",str(os.getuid())+":"+str(os.getgid()),str(repo)],check=True)

    def test_workspace_volume_uses_actual_repo_mount_and_retains_both_resources(self):
        result,calls=self._run(retain="1",size="50",export="1",workspace="80")
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertTrue(any(row[:2]==["volumes","create"] for row in calls), "actual gate did not allocate the declared persistent workspace")
        create=next(row for row in calls if row[:2]==["volumes","create"])
        self.assertEqual(create[create.index("--size")+1],"80")
        self.assertEqual(create[create.index("--region")+1],"iad")
        run=next(row for row in calls if row[:2]==["machine","run"])
        self.assertEqual(run[run.index("--volume")+1],"vol_fixture123:/tmp/gate")
        self.assertIn("GATE_WORKSPACE_VOLUME_ID=vol_fixture123",run)
        self.assertFalse(any(row[:2] in (["machine","destroy"],["volumes","destroy"]) for row in calls))
        self.assertIn("GATE_WORKSPACE_VOLUME_RETAINED",result.stdout+result.stderr)

    @contextlib.contextmanager
    def _root_workspace_custody(self):
        """Yield (repo, run) for the real generated custody block run as root."""
        with tempfile.TemporaryDirectory(prefix="gate-custody-uid-") as temporary:
            base=Path(temporary);copy=base/"gate.sh"
            with patch.dict(os.environ,{"GATE_TEST_SCRIPT_COPY":str(copy)}):
                result,_=self._run(retain="1",size="50",export="1",workspace="80")
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            script=copy.read_text()
            self.assertLess(script.index("chown -R rose:rose /tmp/gate"),script.index("<<'PY_WORKSPACE_CUSTODY'\n"))
            code=script.split("<<'PY_WORKSPACE_CUSTODY'\n",1)[1].split("\nPY_WORKSPACE_CUSTODY",1)[0]
            repo=base/"gate/repo";repo.mkdir(parents=True)
            owner=base/"workspace.json"
            owner.write_text(json.dumps(dict(volume_id="vol_fixture123",source_ref="a"*40,app="navi-whisper-lux-bench",mount_path="/tmp/gate")))
            code=code.replace("/tmp/controller-host-workspace.json",str(owner)).replace("/tmp/gate/repo",str(repo))
            import hashlib
            env=["GATE_WORKSPACE_VOLUME_SHA256="+hashlib.sha256(owner.read_bytes()).hexdigest(),"GATE_WORKSPACE_VOLUME_ID=vol_fixture123","GATE_REF="+"a"*40,"FLY_APP_NAME=navi-whisper-lux-bench"]
            def run():
                return subprocess.run(["sudo","-n","env",*env,sys.executable,"-I","-B","-c",code],capture_output=True,text=True,timeout=30)
            try:
                yield repo,run
            finally:
                subprocess.run(["sudo","-n","chown","-R",str(os.getuid())+":"+str(os.getgid()),str(base)],check=True)

    def test_root_workspace_custody_leaves_repo_context_writable_by_runtime_user(self):
        # The generated guest script hands /tmp/gate to the runtime user and then
        # records workspace custody as root. The runtime's first controller step
        # writes its supervisor files under repo/.context, so custody must not
        # leave that directory root-owned (polar70 post-deploy step-1 EACCES).
        with self._root_workspace_custody() as (repo,run):
            result=run()
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            custody=(repo/".context/controller-workspace-volume").stat()
            self.assertEqual((custody.st_uid,custody.st_mode&0o777),(0,0o700))
            record=subprocess.run(["sudo","-n","stat","-c","%u %a",str(repo/".context/controller-workspace-volume/ownership.json")],capture_output=True,text=True,check=True)
            self.assertEqual(record.stdout.split(),["0","600"])
            supervisor=repo/".context/original600-supervisor.fixture.tasks.json"
            supervisor.write_text("[]\n")
            self.assertEqual(supervisor.stat().st_uid,os.getuid())

    def test_root_workspace_custody_refuses_runtime_user_planted_paths(self):
        # The runtime user owns repo/ and may pre-create .context entries before
        # root records custody; root must never write through them.
        for planted in ("context-symlink","context-file","custody-symlink","custody-directory"):
            with self.subTest(planted=planted), self._root_workspace_custody() as (repo,run):
                decoy=repo.parent/"decoy";decoy.mkdir()
                context=repo/".context"
                if planted=="context-symlink":
                    context.symlink_to(decoy,target_is_directory=True)
                elif planted=="context-file":
                    context.write_text("not a directory\n")
                else:
                    context.mkdir()
                    if planted=="custody-symlink":
                        (context/"controller-workspace-volume").symlink_to(decoy,target_is_directory=True)
                    else:
                        (context/"controller-workspace-volume").mkdir()
                result=run()
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertEqual(list(decoy.iterdir()),[])
                self.assertFalse(os.path.lexists(decoy/"ownership.json"))
                if planted=="custody-directory":
                    self.assertEqual(list((context/"controller-workspace-volume").iterdir()),[])

    def test_workspace_volume_changed_original_owner_refuses_export_and_retains(self):
        for fault in ("exchanged-owner","missing-owner"):
            with self.subTest(fault=fault):
                result,calls=self._run(retain="1",size="50",export="1",workspace="80",volume_fault=fault)
                self.assertNotEqual(result.returncode,0)
                self.assertIn("original workspace ownership changed",result.stdout+result.stderr)
                self.assertFalse(any(row[:2] in (["machine","destroy"],["volumes","destroy"]) for row in calls))

    def test_workspace_volume_rejects_foreign_or_unknown_native_binding_before_host(self):
        for fault in ("wrong-region","wrong-name","wrong-size","false-size","attached","unencrypted","bad-id"):
            with self.subTest(fault=fault):
                result,calls=self._run(retain="1",size="50",export="1",workspace="80",volume_fault=fault)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(sum(row[:2]==["volumes","create"] for row in calls),1)
                self.assertFalse(any(row[:2]==["machine","run"] for row in calls))
                self.assertFalse(any(row[:2]==["volumes","destroy"] for row in calls))

    def test_workspace_volume_partial_allocation_or_host_failure_retains_intent(self):
        for fault in ("create-failed","machine-failed"):
            with self.subTest(fault=fault):
                result,calls=self._run(retain="1",size="50",export="1",workspace="80",volume_fault=fault)
                self.assertNotEqual(result.returncode,0)
                self.assertIn("GATE_WORKSPACE_VOLUME_RETAINED",result.stdout+result.stderr)
                self.assertEqual(sum(row[:2]==["volumes","create"] for row in calls),1)
                self.assertFalse(any(row[:2] in (["volumes","destroy"],["machine","destroy"]) for row in calls))

    def test_workspace_volume_requires_retain_export_and_strict_size_before_native(self):
        for retain,export,size in (("0","0","80"),("1","0","80"),("1","1","0"),("1","1","80gb")):
            with self.subTest(retain=retain,export=export,size=size):
                result,calls=self._run(retain=retain,export=export,workspace=size)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(calls,[])

    def test_default_gate_still_removes_its_machine(self):
        result,calls = self._run()
        self.assertEqual(result.returncode,0,result.stderr)
        run=next(row for row in calls if row[:2]==["machine","run"])
        self.assertIn("--rm",run)
        self.assertNotIn("--rootfs-size",run)
        self.assertTrue(any(row[:2]==["machine","destroy"] for row in calls))

    def test_opt_in_storage_and_retention_preserve_host_on_terminal_boundaries(self):
        for outcome in ("0","7","timeout"):
            with self.subTest(outcome=outcome):
                result,calls = self._run(retain="1",size="80",outcome=outcome)
                self.assertEqual(result.returncode,0 if outcome=="0" else (1 if outcome=="timeout" else 7),result.stderr)
                run=next(row for row in calls if row[:2]==["machine","run"])
                self.assertNotIn("--rm",run)
                self.assertEqual(run[run.index("--rootfs-size")+1],"80gb")
                self.assertEqual(run[run.index("--rootfs-persist")+1],"always")
                self.assertFalse(any(row[:2]==["machine","destroy"] for row in calls))
                self.assertIn("GATE_HOST_RETAINED",result.stdout+result.stderr)

    def test_export_retrieves_and_verifies_actual_original_members_without_destroy(self):
        result,calls=self._run(retain="1",size="80",export="1")
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn("GATE_EXPORT_VERIFIED",result.stdout)
        self.assertFalse(any(row[:2]==["machine","destroy"] for row in calls))
        self.assertEqual(sum(row[:3]==["ssh","sftp","get"] for row in calls),3)

    def test_failed_command_exports_custody_without_stopping_or_acknowledging_host(self):
        result,calls=self._run(retain="1",size="80",export="1",outcome="7")
        self.assertEqual(result.returncode,7,result.stdout+result.stderr)
        self.assertIn("GATE_EXPORT_VERIFIED",result.stdout)
        self.assertFalse(any(row[:2]==["machine","destroy"] for row in calls))
        self.assertFalse(any(row[:2]==["ssh","console"] for row in calls))

    def test_changed_collector_is_rejected_before_interpretation_and_launch(self):
        result,calls=self._run(retain="1",size="80",export="1",bad_collector=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("authority differs",result.stderr)
        self.assertEqual(calls,[])

    def test_fixture_failure_retention_reaches_native_env_and_refuses_invalid_values(self):
        for keep in ("0", "1"):
            with self.subTest(keep=keep):
                result, calls = self._run(retain="1", export="1", keep_tmp=keep)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                run = next(row for row in calls if row[:2] == ["machine", "run"])
                forwarded = [run[i + 1] for i, arg in enumerate(run[:-1]) if arg == "-e"]
                self.assertIn("CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=" + keep, forwarded)
                self.assertFalse(any(row[:2] == ["machine", "destroy"] for row in calls))
        for keep in ("yes", "-1", "1;false"):
            with self.subTest(keep=keep):
                result, calls = self._run(retain="1", export="1", keep_tmp=keep)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_invalid_opt_in_values_refuse_before_native_launch(self):
        for retain,size in (("invalid","80"),("1","80gb"),("1","0"),("1","-1"),("1","80;false")):
            with self.subTest(retain=retain,size=size):
                result,calls = self._run(retain=retain,size=size)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(calls,[])



class LinuxGateExportIdleBoundTests(unittest.TestCase):
    """An export-mode gate guest must not idle forever after its result.

    2026-10-20 two sharded #16 gate controllers idled ~8.5 h after their host
    operator died: the guest ran `while :; do sleep 60; done` after GATE_RESULT.
    The bound must still cover the host's whole export window (TIMEOUT_S).
    """

    GATE = ROOT / "scripts" / "run-cloudbench-controller-gate"

    def _guest_tail(self, timeout_s: int) -> str:
        source = self.GATE.read_text()
        block = re.search(r'^  if \[ "\$EXPORT_HOST" = 1 \]; then\n    # Export mode keeps.*?^  else\n', source, re.M | re.S)
        self.assertIsNotNone(block, "the gate must keep its bounded export idle block")
        grace = re.search(r"^GATE_EXPORT_LAUNCH_GRACE_S=(\d+)$", source, re.M).group(1)
        recovery = re.search(r"^GATE_EXPORT_RECOVERY_S=(\d+)$", source, re.M).group(1)
        generator = (f"EXPORT_HOST=1 TIMEOUT_S={timeout_s} GATE_EXPORT_LAUNCH_GRACE_S={grace} "
                     f"GATE_EXPORT_RECOVERY_S={recovery}\n" + block.group(0) + "  :\nfi\n")
        return subprocess.check_output(["bash", "-c", generator], text=True, timeout=30)

    def _idle(self, timeout_s: int, result_at: int) -> tuple[int, int]:
        # Simulated clock: each sleep advances the guest's SECONDS instead of waiting.
        script = (f"SECONDS={result_at}\nsleep() {{ SECONDS=$((SECONDS + $1)); }}\n"
                  + self._guest_tail(timeout_s))
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        until = int(re.search(r"GATE_EXPORT_IDLE_UNTIL elapsed_s=(\d+)", out.stdout).group(1))
        expired = int(re.search(r"GATE_EXPORT_IDLE_EXPIRED elapsed_s=(\d+)", out.stdout).group(1))
        self.assertGreaterEqual(expired, until)
        self.assertLess(expired, until + 60)
        return until, expired

    def test_idle_ends_after_the_host_export_window(self) -> None:
        until, _ = self._idle(7200, result_at=600)
        self.assertEqual(until, 7200 + 900)

    def test_a_late_result_still_gets_a_bounded_recovery_window(self) -> None:
        until, _ = self._idle(7200, result_at=30000)
        self.assertEqual(until, 30000 + 3600)

    def test_the_bound_never_ends_inside_the_host_deadline(self) -> None:
        for timeout_s, result_at in ((5400, 0), (5400, 5399), (60, 30)):
            until, _ = self._idle(timeout_s, result_at)
            self.assertGreater(until, timeout_s)
            self.assertNotIn("while :; do sleep 60; done", self._guest_tail(timeout_s))


class LinuxControllerExportTests(unittest.TestCase):
    def _fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="controller-original-export-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        repo = root/"repo"; repo.mkdir()
        subprocess.run(["git","init","-q",str(repo)],check=True)
        (repo/"scripts").mkdir()
        (repo/"scripts/fixture.py").write_bytes(b"original source bytes\n")
        subprocess.run(["git","-C",str(repo),"add","scripts"],check=True)
        subprocess.run(["git","-C",str(repo),"-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-qm","source"],check=True)
        ref=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
        context=repo/".context"; context.mkdir()
        (context/"original.log").write_bytes(b"actual original fixture bytes\n")
        (repo/"agents").mkdir(); (repo/"agents/.env").write_bytes(b"PRIVATE_FIXTURE=preserved\n")
        reserve=repo/".git/cloudbench-fleet-ownership/fixture/cleanup-disk-reserve"
        reserve.parent.mkdir(parents=True)
        reserve.write_bytes(b"reserve payload must never enter archive")
        helper=ROOT/"scripts/cloudbench-controller-export.py"
        caller,record=root/"caller.json",root/"launch.json"
        self._call(helper,"caller","--record",caller,"--driver-pid",os.getpid())
        self._call(helper,"launch","--repo",repo,"--record",record,"--driver-pid",os.getpid(),
                   "--caller",caller,"--ref",ref,"--image","fixture@sha256:"+"a"*64)
        return root,repo,helper,record,reserve

    def _call(self, helper, *args, expected=0):
        # Bound /proc enumeration to the fake host's native process namespace.
        # Birth ticks, cwd and fd observations remain the real kernel values;
        # the production guest collector is root and observes every host UID.
        harness = """from pathlib import Path
import os,sys
original=Path.iterdir
def namespace(path):
    if str(path)=='/proc':
        selected=[]
        for process in original(path):
            try:
                if process.name.isdecimal() and process.stat().st_uid==os.getuid():
                    status=Path(str(process)+'/stat').read_text();fields=status[status.rfind(')')+2:].split()
                    if int(process.name) in (os.getpid(),os.getppid()) or int(fields[1])==os.getppid(): selected.append(process)
            except FileNotFoundError: continue
        return iter(selected)
    return original(path)
Path.iterdir=namespace
helper=Path(sys.argv[1]);sys.argv=sys.argv[1:]
subject={'__name__':'fake_native_host','__file__':str(helper)}
exec(compile(helper.read_bytes(),str(helper),'exec'),subject)
subject['record_temp_roots']=lambda repo,common:[str(repo.parent/'owned-temp-state')]
subject['EXPORT_WRITER_DRAIN_SECONDS']=2  # these writers persist; keep the bounded drain short
try: raise SystemExit(subject['main']())
except (OSError,ValueError,KeyError): raise SystemExit(75)
"""
        result=subprocess.run([sys.executable,"-c",harness,str(helper),*[str(a) for a in args]],text=True,capture_output=True,timeout=30)
        self.assertEqual(result.returncode,expected,result.stderr)
        return result

    def test_original_members_verify_without_reading_or_removing_cleanup_reserve(self):
        root,repo,helper,record,reserve=self._fixture()
        archive,manifest=root/"originals.tar.gz",root/"manifest.json"
        self._call(helper,"export","--record",record,"--archive",archive,"--manifest",manifest,"--pending",root/"pending.json")
        self._call(helper,"verify","--archive",archive,"--manifest",manifest)
        value=json.loads(manifest.read_text())
        self.assertFalse(value["resource_release_verified"])
        self.assertEqual(value["files"]["context/original.log"]["sha256"],__import__("hashlib").sha256((repo/".context/original.log").read_bytes()).hexdigest())
        self.assertIn("source/agents/.env",value["files"])
        self.assertEqual(len(value["excluded"]),1)
        self.assertNotIn("git-common/cloudbench-fleet-ownership/fixture/cleanup-disk-reserve",value["files"])
        self.assertEqual(reserve.read_bytes(),b"reserve payload must never enter archive")
        self.assertEqual((repo/".context/original.log").read_bytes(),b"actual original fixture bytes\n")
        archive.write_bytes(archive.read_bytes()+b"changed")
        self._call(helper,"verify","--archive",archive,"--manifest",manifest,expected=75)

    def test_unknown_manifest_kind_refuses_and_unrelated_reserve_basename_is_preserved(self):
        root,repo,helper,record,reserve=self._fixture()
        (repo/".context/cleanup-disk-reserve").write_bytes(b"ordinary evidence, not physical reserve")
        archive,manifest=root/"originals.tar.gz",root/"manifest.json"
        self._call(helper,"export","--record",record,"--archive",archive,"--manifest",manifest,"--pending",root/"pending.json")
        value=json.loads(manifest.read_text())
        self.assertIn("context/cleanup-disk-reserve",value["files"])
        self.assertEqual(len(value["excluded"]),1)
        value["files"]["context/original.log"]["kind"]="unknown"
        manifest.write_text(json.dumps(value))
        self._call(helper,"verify","--archive",archive,"--manifest",manifest,expected=75)

    def test_writable_mapping_without_file_descriptor_reports_pending(self):
        root,repo,helper,record,reserve=self._fixture()
        ready=root/"ready"
        command="""import ctypes,os,sys,time
from pathlib import Path
lib=ctypes.CDLL(None,use_errno=True);lib.mmap.restype=ctypes.c_void_p
fd=os.open(sys.argv[1],os.O_RDWR)
address=lib.mmap(None,os.fstat(fd).st_size,3,1,fd,0);os.close(fd)
assert address not in (None,ctypes.c_void_p(-1).value)
Path(sys.argv[2]).touch();time.sleep(30)
"""
        writer=subprocess.Popen([sys.executable,"-c",command,str(repo/".context/original.log"),str(ready)])
        try:
            deadline=time.monotonic()+10
            while not ready.exists():
                self.assertLess(time.monotonic(),deadline);time.sleep(.01)
            self.assertFalse(any(str(repo) in os.readlink(fd) for fd in Path(f"/proc/{writer.pid}/fd").iterdir()))
            archive,manifest,pending=root/"originals.tar.gz",root/"manifest.json",root/"pending.json"
            self._call(helper,"export","--record",record,"--archive",archive,"--manifest",manifest,"--pending",pending,expected=75)
            self.assertFalse(archive.exists());self.assertEqual(json.loads(pending.read_text())["status"],"pending")
        finally:
            writer.terminate();writer.wait(timeout=10)

    def test_live_writer_keeps_originals_and_reports_pending_without_archive(self):
        root,repo,helper,record,reserve=self._fixture()
        ready=root/"ready"
        writer=subprocess.Popen([sys.executable,"-c",
            "from pathlib import Path;import sys,time;f=open(sys.argv[1],'ab');Path(sys.argv[2]).touch();time.sleep(30)",
            str(repo/".context/original.log"),str(ready)])
        try:
            deadline=time.monotonic()+10
            while not ready.exists():
                self.assertLess(time.monotonic(),deadline);time.sleep(.01)
            archive,manifest,pending=root/"originals.tar.gz",root/"manifest.json",root/"pending.json"
            self._call(helper,"export","--record",record,"--archive",archive,"--manifest",manifest,"--pending",pending,expected=75)
            self.assertFalse(archive.exists());self.assertFalse(manifest.exists())
            self.assertEqual(json.loads(pending.read_text())["status"],"pending")
            self.assertEqual((repo/".context/original.log").read_bytes(),b"actual original fixture bytes\n")
            self.assertTrue(reserve.exists())
        finally:
            writer.terminate();writer.wait(timeout=10)

def _load_runner(name: str):
    spec = importlib.util.spec_from_file_location(name, RUNNER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class StructuralGateSchedulingTests(unittest.TestCase):
    """Sharding, longest-first admission, hard timeouts and failed-first retries."""

    def test_shards_partition_the_selection_exactly_once(self) -> None:
        sys.path.insert(0, str(ROOT / "scripts" / "tests"))
        try:
            import deploy_gate_shard as shard
        finally:
            sys.path.pop(0)
        items = list(range(1117))
        for count in (1, 2, 4, 6, 7):
            union = []
            for index in range(1, count + 1):
                with patch.dict(os.environ, {shard.ENV: f"{index}/{count}"}):
                    kept, dropped = shard.select(items)
                self.assertTrue(kept)
                self.assertEqual(sorted(kept + dropped), items)
                union += kept
            self.assertEqual(sorted(union), items, f"{count} shards")
        with patch.dict(os.environ, {shard.ENV: "3/2"}), self.assertRaises(ValueError):
            shard.select(items)
        env = dict(os.environ)
        env.pop(shard.ENV, None)
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(shard.select(items), (items, []))

    def test_registered_shards_expand_with_their_environment(self) -> None:
        module = _load_runner("deploy_runner_shards")
        sharded = [gate for gate in module.GATES if gate.shards > 1]
        self.assertTrue(sharded, "the long suites must stay sharded")
        jobs = module.expand_jobs(module.GATES)
        self.assertEqual(
            len(jobs), sum(max(gate.shards, 1) for gate in module.GATES)
        )
        for gate in sharded:
            specs = sorted(
                job.environment()[module.SHARD_ENV] for job in jobs if job.gate is gate
            )
            self.assertEqual(
                specs, sorted(f"{i}/{gate.shards}" for i in range(1, gate.shards + 1))
            )
        unsharded = next(job for job in jobs if job.gate.shards == 1)
        with patch.dict(os.environ, {module.SHARD_ENV: "1/9"}):
            self.assertNotIn(module.SHARD_ENV, unsharded.environment())
        expected = [job.expected_seconds for job in jobs]
        self.assertEqual(expected, sorted(expected, reverse=True), "longest first")

    def test_sharded_gate_runs_every_shard_through_the_runner(self) -> None:
        module = _load_runner("deploy_runner_shard_run")
        with tempfile.TemporaryDirectory(prefix="deploy-runner-shard-run-") as temporary:
            seen = Path(temporary) / "seen"
            gates = (
                module.Gate(
                    "split",
                    ("bash", "-c", f'echo "$DEPLOY_GATE_SHARD" >> {seen}; [ "$DEPLOY_GATE_SHARD" != 2/3 ]'),
                    expected_seconds=30,
                    shards=3,
                ),
                module.Gate("whole", ("bash", "-c", f'echo "whole:${{DEPLOY_GATE_SHARD:-none}}" >> {seen}')),
            )
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = module.run_gates(gates, max_workers=2)
            self.assertEqual(result, 1, "one failing shard fails the gate")
            self.assertEqual(
                sorted(seen.read_text().split()), ["1/3", "2/3", "3/3", "whole:none"]
            )
            self.assertIn("split[2/3]", stderr.getvalue())
            self.assertIn("== split[1/3]: exit=0", stdout.getvalue())

    def test_hung_gate_is_killed_with_its_process_group_and_fails_by_name(self) -> None:
        module = _load_runner("deploy_runner_timeout")
        with tempfile.TemporaryDirectory(prefix="deploy-runner-timeout-") as temporary:
            child_pid = Path(temporary) / "child.pid"
            gates = (
                module.Gate(
                    "hangs-forever",
                    (
                        "bash",
                        "-c",
                        f"trap '' TERM; sleep 300 & echo $! > {child_pid}; wait",
                    ),
                ),
                module.Gate("quick", ("bash", "-c", "exit 0")),
            )
            stdout, stderr = io.StringIO(), io.StringIO()
            started = time.monotonic()
            with (
                patch.object(module, "DEFAULT_GATE_TIMEOUT_SECONDS", 2.0),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                result = module.run_gates(gates, max_workers=2)
            elapsed = time.monotonic() - started
            self.assertEqual(result, 1)
            self.assertLess(elapsed, 60, "the hung gate must not hold the runner")
            self.assertIn("hangs-forever (timed out)", stderr.getvalue())
            self.assertIn("TIMEOUT: deploy structural gate hangs-forever", stderr.getvalue())
            self.assertIn("== hangs-forever: exit=124", stdout.getvalue())
            self.assertIn("== quick: exit=0", stdout.getvalue())
            pid = int(child_pid.read_text())
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            else:
                self.fail("the hung gate's background child survived the timeout")

    def test_timeout_scales_with_recorded_cost(self) -> None:
        module = _load_runner("deploy_runner_timeout_scale")
        quick = module.Job(module.Gate("quick", ("true",)), 0)
        slow = module.Job(module.Gate("slow", ("true",), expected_seconds=700, shards=2), 1)
        self.assertEqual(quick.timeout_seconds, module.DEFAULT_GATE_TIMEOUT_SECONDS)
        self.assertEqual(slow.timeout_seconds, max(module.DEFAULT_GATE_TIMEOUT_SECONDS, 3 * 350))

    def test_retry_runs_previous_failures_first_then_the_full_sweep(self) -> None:
        module = _load_runner("deploy_runner_failed_first")
        with tempfile.TemporaryDirectory(prefix="deploy-runner-failed-first-") as temporary:
            root = Path(temporary)
            order = root / "order"
            broken = root / "broken"
            state = root / "state.json"

            def gate(name: str, seconds: float) -> object:
                body = f"echo {name} >> {order}; test ! -e {broken}.{name}"
                return module.Gate(name, ("bash", "-c", body), expected_seconds=seconds)

            gates = (gate("long", 100), gate("middle", 50), gate("short", 1))

            def run() -> tuple[int, list[str], str]:
                order.write_text("")
                stderr = io.StringIO()
                with (
                    contextlib.redirect_stdout(io.StringIO()),
                    contextlib.redirect_stderr(stderr),
                ):
                    result = module.run_gates(gates, max_workers=1, failure_state=state)
                return result, order.read_text().split(), stderr.getvalue()

            Path(f"{broken}.short").touch()
            result, ran, _ = run()
            self.assertEqual((result, ran), (1, ["long", "middle", "short"]))
            self.assertEqual(json.loads(state.read_text())["failed"], ["short"])

            # Still broken: the retry signals within the first job and stops.
            result, ran, stderr = run()
            self.assertEqual((result, ran), (1, ["short"]))
            self.assertIn("previously failed short failed again", stderr)
            self.assertEqual(json.loads(state.read_text())["failed"], ["short"])

            # Fixed, but the fix broke another gate: the full sweep catches it.
            Path(f"{broken}.short").unlink()
            Path(f"{broken}.long").touch()
            result, ran, _ = run()
            self.assertEqual((result, ran), (1, ["short", "long", "middle"]))
            self.assertEqual(json.loads(state.read_text())["failed"], ["long"])

            # Everything fixed: only a complete sweep passes, and clears state.
            Path(f"{broken}.long").unlink()
            result, ran, _ = run()
            self.assertEqual((result, ran), (0, ["long", "middle", "short"]))
            self.assertEqual(json.loads(state.read_text())["failed"], [])

            # Without a recorded state the order is plain longest-first.
            with (
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                order.write_text("")
                self.assertEqual(module.run_gates(gates, max_workers=1), 0)
            self.assertEqual(order.read_text().split(), ["long", "middle", "short"])

    def test_unreadable_failure_state_runs_the_normal_order(self) -> None:
        module = _load_runner("deploy_runner_failed_first_state")
        with tempfile.TemporaryDirectory(prefix="deploy-runner-state-") as temporary:
            state = Path(temporary) / "state.json"
            self.assertEqual(module.load_previous_failures(state), set())
            state.write_text("{not json")
            self.assertEqual(module.load_previous_failures(state), set())
            state.write_text('{"failed": "short"}')
            self.assertEqual(module.load_previous_failures(state), set())
            module.record_failures(state, ["b", "a"])
            self.assertEqual(module.load_previous_failures(state), {"a", "b"})

if __name__ == "__main__":
    unittest.main()
