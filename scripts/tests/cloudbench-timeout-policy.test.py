"""CLI timeout selection and prelaunch warnings without starting a benchmark."""

import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
PYTHON = ROOT / "agents/venv/bin/python"
POLICY = ROOT / "scripts/cloudbench-timeout-policy.py"
CATALOG = ROOT / "agents/benchmarks/tasks.json"


class TimeoutPolicyTest(unittest.TestCase):
    def policy(self, *args):
        return subprocess.run(
            [str(PYTHON), str(POLICY), "--catalog", str(CATALOG), *args],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )

    def test_selected_max_includes_catalog_and_timeout_floor(self):
        result = self.policy(
            "test-mass-agent-run-0", "browser-auth-signup-already-registered",
            "browser-auth-member-discount-purchase",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "1200")

    def test_short_explicit_cap_warns_for_every_affected_task(self):
        result = self.policy(
            "--requested", "696", "test-mass-agent-run-0",
            "browser-auth-signup-already-registered", "browser-auth-member-discount-purchase",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "1200")
        for task in (
            "test-mass-agent-run-0 (900s)",
            "browser-auth-signup-already-registered (900s)",
            "browser-auth-member-discount-purchase (1200s)",
        ):
            self.assertIn(task, result.stderr)

    def test_step_budgeted_polar_preserves_route_defaults(self):
        import json

        task = json.loads((ROOT / "agents/benchmarks/polar_tasks.json").read_text())[0]["name"]
        ordinary = self.policy(task)
        sharded = self.policy("--mode", "sharded", task)
        explicit = self.policy("--requested", "696", task)
        self.assertEqual((ordinary.returncode, ordinary.stdout.strip()), (0, "7200"))
        self.assertEqual((sharded.returncode, sharded.stdout.strip()), (0, "1200"))
        self.assertIn("no catalog wall-clock timeout", explicit.stderr)

    def test_wrapper_passes_implicit_default_to_ordinary_fleet(self):
        with tempfile.TemporaryDirectory() as temporary:
            stub = pathlib.Path(temporary) / "fleet.sh"
            stub.write_text('#!/usr/bin/env bash\nprintf "DEFAULT=%s ARGS=%s\\n" "$RUN_BENCH_DEFAULT_TIMEOUT" "$*"\n')
            env = os.environ.copy()
            env.update(RUN_BENCH_FLEET_BIN_UNDER_TEST=str(stub), RUN_BENCH_SHARDED_ROUTE="never")
            result = subprocess.run(
                ["bash", str(ROOT / "scripts/run-bench"), "test-mass-agent-run-0"],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("DEFAULT=900", result.stdout)
            self.assertIn("ARGS=test-mass-agent-run-0", result.stdout)

    def test_wrapper_warns_before_passing_an_explicit_short_cap(self):
        with tempfile.TemporaryDirectory() as temporary:
            stub = pathlib.Path(temporary) / "fleet.sh"
            stub.write_text('#!/usr/bin/env bash\nprintf "DEFAULT=%s ARGS=%s\\n" "$RUN_BENCH_DEFAULT_TIMEOUT" "$*"\n')
            env = os.environ.copy()
            env.update(RUN_BENCH_FLEET_BIN_UNDER_TEST=str(stub), RUN_BENCH_SHARDED_ROUTE="never")
            result = subprocess.run(
                ["bash", str(ROOT / "scripts/run-bench"), "test-mass-agent-run-0", "--timeout", "696"],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("test-mass-agent-run-0 (900s)", result.stderr)
            self.assertIn("ARGS=test-mass-agent-run-0 --timeout 696", result.stdout)


if __name__ == "__main__":
    unittest.main()
