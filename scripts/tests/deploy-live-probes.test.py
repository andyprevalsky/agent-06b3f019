#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "run_deploy_live_probes.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("run_deploy_live_probes", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load live-probe runner")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class DeployLiveProbeTests(unittest.TestCase):
    def test_independent_probes_run_concurrently(self) -> None:
        module = _load_module()
        commands = (
            module.Command("first", (sys.executable, "-c", "first"), ROOT),
            module.Command("second", (sys.executable, "-c", "second"), ROOT),
        )
        events: list[tuple[str, str]] = []

        class FinishedProcess:
            def __init__(self, name: str) -> None:
                self.name = name
                self.pid = 1

            def poll(self) -> int:
                events.append(("poll", self.name))
                return 0

            def wait(self) -> int:
                events.append(("wait", self.name))
                return 0

        def launch(argv, *, cwd, start_new_session):
            self.assertEqual(cwd, ROOT)
            self.assertTrue(start_new_session)
            name = argv[-1]
            events.append(("launch", name))
            return FinishedProcess(name)

        with patch.object(module.subprocess, "Popen", side_effect=launch):
            results = module.run_commands(commands)

        self.assertEqual(events[:2], [("launch", "first"), ("launch", "second")])
        self.assertEqual(results, {"first": 0, "second": 0})

    def test_failure_does_not_interrupt_sibling_evidence(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "completed"
            commands = (
                module.Command("failed", (sys.executable, "-c", "raise SystemExit(7)"), ROOT),
                module.Command(
                    "slow",
                    (sys.executable, "-c", f"import time; time.sleep(.15); open({str(marker)!r}, 'w').write('done')"),
                    ROOT,
                ),
            )
            results = module.run_commands(commands)

            self.assertEqual(results, {"failed": 7, "slow": 0})
            self.assertEqual(marker.read_text(), "done")

    def test_dependent_probe_starts_after_prerequisite_exits_even_on_failure(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory() as temporary:
            finished = Path(temporary) / "prerequisite-finished"
            started = Path(temporary) / "dependent-started"
            commands = (
                module.Command(
                    "dependent",
                    (
                        sys.executable,
                        "-c",
                        f"import time; open({str(started)!r}, 'w').write(repr(time.time()))",
                    ),
                    ROOT,
                    after="prerequisite",
                ),
                module.Command(
                    "prerequisite",
                    (
                        sys.executable,
                        "-c",
                        (
                            "import time; time.sleep(.15); "
                            f"open({str(finished)!r}, 'w').write(repr(time.time())); "
                            "raise SystemExit(7)"
                        ),
                    ),
                    ROOT,
                ),
            )
            results = module.run_commands(commands)

            self.assertEqual(results, {"dependent": 0, "prerequisite": 7})
            self.assertGreaterEqual(float(started.read_text()), float(finished.read_text()))

    def test_unknown_or_cyclic_prerequisites_are_rejected(self) -> None:
        module = _load_module()
        with self.assertRaises(ValueError):
            module.run_commands((module.Command("orphan", ("true",), ROOT, after="missing"),))
        with self.assertRaises(ValueError):
            module.run_commands((module.Command("self", ("true",), ROOT, after="self"),))

    def test_chat_router_failover_live_probe_runs_after_amplitude(self) -> None:
        module = _load_module()
        commands = {command.name: command for command in module.deploy_commands()}

        self.assertEqual(
            set(commands),
            {
                "credential-health",
                "amplitude-live",
                "chat-router-failover-live",
                "browser-provider-live",
                "report-bug-storage-live",
                "migration-preflight",
            },
        )
        probe = commands["chat-router-failover-live"]
        self.assertEqual(probe.after, "amplitude-live")
        self.assertIn("CHAT_ROUTER_FAILOVER_LIVE=1", probe.argv)
        self.assertEqual(probe.argv[-2:], ("scripts/run-blackbox-tests.sh", "chat-router-failover"))
        self.assertEqual(probe.cwd, ROOT / "back-end")

    def test_live_third_party_blackbox_cases_run_as_serialized_probes(self) -> None:
        module = _load_module()
        commands = {command.name: command for command in module.deploy_commands()}
        for name, after, flag, domain in (
            ("browser-provider-live", "chat-router-failover-live", "BROWSER_PROVIDER_LIVE=1", "browser-provider"),
            ("report-bug-storage-live", "browser-provider-live", "REPORT_BUG_STORAGE_LIVE=1", "report-bug"),
        ):
            probe = commands[name]
            self.assertEqual(probe.after, after)
            self.assertIn(flag, probe.argv)
            self.assertEqual(probe.argv[-2:], ("scripts/run-blackbox-tests.sh", domain))
            self.assertEqual(probe.cwd, ROOT / "back-end")

    def test_live_tilion_cases_reach_the_production_region_from_any_runner(self) -> None:
        """The gate VM's accelerator route (back.tilion.dev) lands on west, which production
        never uses and whose direct-exit DNS was dead on 2026-11-15; the live Tilion cases must
        reach east, the region production's Render (ohio) and Fly (iad) clients reach, even
        when the runner's own environment names another region."""
        module = _load_module()
        self.assertEqual(module.TILION_PRODUCTION_REGION_BASE_URL, "https://east.back.tilion.dev")
        commands = {command.name: command for command in module.deploy_commands()}
        argv = commands["browser-provider-live"].argv
        env_args = argv[argv.index("env") + 1 : argv.index("bash", argv.index("env"))]
        self.assertIn("TILION_BASE_URL=https://east.back.tilion.dev", env_args)
        # `env NAME=VALUE` replaces an inherited value, so a west runner environment cannot win.
        result = subprocess.run(
            [*argv[argv.index("env") : argv.index("bash", argv.index("env"))], "printenv", "TILION_BASE_URL"],
            env={**os.environ, "TILION_BASE_URL": "https://west.back.tilion.dev"},
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        self.assertEqual(result.stdout.strip(), "https://east.back.tilion.dev")
        # Negative control: no other probe is pinned to a Tilion region.
        for name, command in commands.items():
            if name != "browser-provider-live":
                self.assertFalse(any(arg.startswith("TILION_BASE_URL=") for arg in command.argv), name)

    def test_migration_preflight_checks_branch_migrations_against_production(self) -> None:
        module = _load_module()
        commands = {command.name: command for command in module.deploy_commands()}
        probe = commands["migration-preflight"]
        self.assertIsNone(probe.after)
        self.assertEqual(
            probe.argv[-2:],
            (module.workspace_tsx(), "scripts/migration-preflight.ts"),
        )
        self.assertEqual(probe.cwd, ROOT / "back-end")

    def test_each_probe_reports_one_live_progress_row_without_changing_the_result(self) -> None:
        """DEPLOY_GATE_PROGRESS gets one row per probe the moment it exits: the
        waiter only exits after the failing probe's FAIL row is in the file.
        Exit code and output match a run without the variable, which writes nothing."""
        waiter = (
            "import json, os, sys, time\n"
            "watch = os.environ.get('DEPLOY_GATE_PROGRESS')\n"
            "deadline = time.monotonic() + 60\n"
            "while watch and time.monotonic() < deadline:\n"
            "    try:\n"
            "        rows = [json.loads(line) for line in open(watch).read().splitlines()]\n"
            "    except (OSError, ValueError):\n"
            "        rows = []\n"
            "    if any(row['unit'] == 'fails' and row['status'] == 'FAIL' for row in rows):\n"
            "        break\n"
            "    time.sleep(0.05)\n"
            "else:\n"
            "    if watch:\n"
            "        sys.exit(9)\n"
            "print('waiter done')\n"
        )
        driver = (
            "import importlib.util, sys\n"
            f"spec = importlib.util.spec_from_file_location('live_probes_progress', {str(MODULE_PATH)!r})\n"
            "module = importlib.util.module_from_spec(spec)\n"
            "sys.modules[spec.name] = module\n"
            "spec.loader.exec_module(module)\n"
            "root = module.ROOT\n"
            "module.deploy_commands = lambda: (\n"
            "    module.Command('fails', (sys.executable, '-c', \"print('probe-fail-marker'); raise SystemExit(4)\"), root),\n"
            f"    module.Command('waiter', (sys.executable, '-c', {waiter!r}), root),\n"
            "    module.Command('after-fails', (sys.executable, '-c', \"print('dependent ran')\"), root, after='fails'),\n"
            ")\n"
            "raise SystemExit(module.main())\n"
        )
        with tempfile.TemporaryDirectory() as temporary:
            progress = Path(temporary) / "progress.jsonl"

            def run(extra: dict[str, str]) -> tuple[int, list[str], str]:
                env = {key: value for key, value in os.environ.items() if key != "DEPLOY_GATE_PROGRESS"}
                env.update(extra)
                result = subprocess.run(
                    [sys.executable, "-c", driver], env=env, capture_output=True, text=True, timeout=120
                )
                return result.returncode, sorted(result.stdout.splitlines()), result.stderr

            reported = run({"DEPLOY_GATE_PROGRESS": str(progress), "DEPLOY_GATE_CASE": "live-probes"})
            unset = run({})
            self.assertEqual(reported[0], 1, reported)
            self.assertEqual(reported, unset, "reporting changed the exit code or output")
            self.assertIn("live probe fails: exit=4", reported[1])
            self.assertEqual(list(Path(temporary).iterdir()), [progress], "an unset variable wrote a progress file")
            rows = [json.loads(line) for line in progress.read_text().splitlines()]
        units = [row["unit"] for row in rows]
        self.assertEqual(sorted(units), ["after-fails", "fails", "waiter"], "one row per probe")
        self.assertLess(units.index("fails"), units.index("waiter"), "the FAIL row precedes later probes")
        by_unit = {row["unit"]: row for row in rows}
        self.assertEqual(
            {unit: row["status"] for unit, row in by_unit.items()},
            {"fails": "FAIL", "waiter": "PASS", "after-fails": "PASS"},
        )
        self.assertEqual({(row["scope"], row["case"], row["log"]) for row in rows}, {("suite", "live-probes", "")})
        self.assertEqual(by_unit["fails"]["detail"], "live probe fails: exit=4")
        self.assertEqual(by_unit["waiter"]["detail"], "")

    def test_credential_health_uses_workspace_tsx_not_npx(self) -> None:
        module = _load_module()
        commands = {command.name: command for command in module.deploy_commands()}
        probe = commands["credential-health"]
        tsx = module.workspace_tsx()
        self.assertEqual(probe.argv[-2:], (tsx, "src/tests/blackbox/integration-health.blackbox.ts"))
        self.assertNotIn("npx", probe.argv)


    def test_probe_names_list_every_probe_in_an_order_that_satisfies_each_after(self) -> None:
        """The staged cycle runs one case per probe, one after another, in PROBE_NAMES order."""
        module = _load_module()
        commands = module.deploy_commands()
        self.assertEqual(sorted(module.PROBE_NAMES), sorted(command.name for command in commands))
        position = {name: index for index, name in enumerate(module.PROBE_NAMES)}
        for command in commands:
            if command.after is not None:
                self.assertLess(position[command.after], position[command.name], command.name)

    def test_only_runs_that_probe_alone_and_returns_its_exit(self) -> None:
        module = _load_module()
        seen: list[tuple] = []

        def fake_run(commands):
            seen.append(tuple((command.name, command.after) for command in commands))
            return {command.name: 1 for command in commands}

        with patch.object(module, "run_commands", fake_run):
            self.assertEqual(1, module.main(["--only", "chat-router-failover-live"]))
        # It does not wait for amplitude-live: that probe is its own, earlier case.
        self.assertEqual([(("chat-router-failover-live", None),)], seen)
        with patch.object(module, "run_commands", lambda commands: {c.name: 0 for c in commands}):
            self.assertEqual(0, module.main(["--only", "migration-preflight"]))
        with self.assertRaises(SystemExit):
            module.main(["--only", "not-a-probe"])

    def test_default_run_still_runs_every_probe_with_its_ordering(self) -> None:
        module = _load_module()
        seen: list[tuple] = []

        def fake_run(commands):
            seen.append(tuple((command.name, command.after) for command in commands))
            return {command.name: 0 for command in commands}

        with patch.object(module, "run_commands", fake_run):
            self.assertEqual(0, module.main([]))
        self.assertEqual([tuple((c.name, c.after) for c in module.deploy_commands())], seen)


if __name__ == "__main__":
    unittest.main()
