#!/usr/bin/env python3
"""Owning regression: cross-devbox Fly capacity admission waits to the caller's deadline.

Fleets on every devbox share one benchmark app, so a lane/machine shortfall is
usually another devbox's fleet that will release soon. The fleet used to give up
after a hidden fixed 300 s and fail the deploy's smoke gate. The deploy cloud
adapter now passes its gate deadline explicitly
(CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH) and admission keeps polling at the
existing cadence until then. Every ceiling stays unchanged.

Offline only: the real fleet functions run in bash with the provider observation
stubbed; no flyctl, network or credentials.
"""
from __future__ import annotations

import shutil
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLEET = ROOT / "scripts" / "run-bench-fleet"
ADAPTER = ROOT / "scripts" / "deploy_test_cloud.py"
sys.path.insert(0, str(ROOT / "scripts"))


def fleet_function(name: str) -> str:
    """Return one top-level bash function from the real fleet script."""
    text = FLEET.read_text()
    start = text.index(f"\n{name}() {{") + 1
    end = text.index("\n}\n", start) + 3
    return text[start:end]


def run_admission(environment: dict[str, str], guard_successes_after: int | None,
                  timeout: float = 20) -> subprocess.CompletedProcess:
    """Run admit_app_capacity_with_wait with a retryable guard that admits after N refusals."""
    succeed = -1 if guard_successes_after is None else guard_successes_after
    script = f"""set -u
attempts=0
fleet_admission_machines_json() {{ printf '[]'; }}
enforce_app_capacity_guard() {{
    attempts=$((attempts + 1))
    if [ {succeed} -ge 0 ] && [ "$attempts" -gt {succeed} ]; then
        CAPACITY_ADMISSION_RETRYABLE=0
        return 0
    fi
    echo "❌ DEMO guest ceiling reached: 50 live + 1 requested > 50" >&2
    CAPACITY_ADMISSION_RETRYABLE=1
    return 1
}}
{fleet_function("admit_app_capacity_with_wait")}
admit_app_capacity_with_wait
status=$?
printf 'attempts=%s status=%s\\n' "$attempts" "$status"
exit "$status"
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLOUDBENCH_CAPACITY_ADMISSION")}
    env.pop("CAPACITY_ADMISSION_DEADLINE", None)
    env.update(environment)
    return subprocess.run(["bash", "-c", script], env=env, text=True, capture_output=True, timeout=timeout)


class FleetAdmissionDeadline(unittest.TestCase):
    def test_caller_deadline_outlasts_the_default_wait(self):
        # Default budget is 1 s here; the caller's deadline allows the 4th poll to admit.
        result = run_admission({
            "CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS": "1",
            "CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS": "1",
            "CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": str(int(time.time()) + 30),
        }, guard_successes_after=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("attempts=4 status=0", result.stdout)
        # Clear progress: every pending poll names the remaining caller deadline.
        progress = [line for line in result.stderr.splitlines() if line.startswith("⏳ capacity admission pending")]
        self.assertEqual(len(progress), 3, result.stderr)
        for line in progress:
            self.assertRegex(line, r"retrying provider observation in 1s \(\d+s left before the caller's deadline\)")

    def test_caller_deadline_still_ends_the_wait(self):
        started = time.monotonic()
        result = run_admission({
            "CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS": "1",
            "CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": str(int(time.time()) + 3),
        }, guard_successes_after=None)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("capacity admission remained blocked", result.stderr)
        self.assertIn("caller's deadline", result.stderr)
        self.assertLess(time.monotonic() - started, 10)

    def test_expired_or_invalid_caller_deadline_fails_before_waiting(self):
        expired = run_admission({"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": str(int(time.time()) - 5)},
                                guard_successes_after=0, timeout=5)
        self.assertEqual(expired.returncode, 1, expired.stderr)
        self.assertIn("attempts=0", expired.stdout)
        self.assertIn("caller's capacity admission deadline already passed", expired.stderr)
        invalid = run_admission({"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": "soon"},
                                guard_successes_after=0, timeout=5)
        self.assertEqual(invalid.returncode, 2, invalid.stderr)
        self.assertIn("attempts=0", invalid.stdout)

    def test_without_caller_deadline_the_default_budget_is_unchanged(self):
        result = run_admission({"CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS": "2",
                                "CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS": "1"},
                               guard_successes_after=None)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("capacity admission remained blocked for 2s", result.stderr)
        self.assertIn('local wait_seconds="${CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS:-300}"',
                      fleet_function("admit_app_capacity_with_wait"))

    def test_borrowed_inventory_wait_shares_the_caller_deadline(self):
        script = f"""set -u
CLOUDBENCH_CAMPAIGN_INVENTORY_DIR=/nonexistent INVENTORY_PUBLISHER_BORROWED=1 SNAPSHOT_LOOP_PID=1
reads=0
read_inventory() {{ reads=$((reads + 1)); [ "$reads" -gt 3 ] && return 0; return 75; }}
{fleet_function("campaign_inventory_wait")}
campaign_inventory_wait read_inventory
status=$?
printf 'reads=%s status=%s\\n' "$reads" "$status"
exit "$status"
"""
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLOUDBENCH_CAPACITY_ADMISSION")}
        env.update(CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS="1", CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS="1",
                   CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH=str(int(time.time()) + 30))
        result = subprocess.run(["bash", "-c", script], env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reads=4 status=0", result.stdout)

    def test_every_capacity_ceiling_is_unchanged(self):
        text = FLEET.read_text()
        for line in ('shared_cpu_governor="${CLOUDBENCH_SHARED_CPU_GOVERNOR:-1000}"',
                     'shared_cpu_headroom="${CLOUDBENCH_SHARED_CPU_HEADROOM:-20}"',
                     'app_machine_ceiling="${CLOUDBENCH_APP_MACHINE_CEILING:-300}"',
                     'local demo_ceiling="${CLOUDBENCH_DEMO_GUEST_CEILING:-50}"',
                     'local delegating_ceiling="${CLOUDBENCH_DELEGATING_PRIMARY_CEILING:-70}"'):
            self.assertIn(line, text)


class AdapterPassesGateDeadline(unittest.TestCase):
    def setUp(self):
        import deploy_test_cloud
        self.adapter = deploy_test_cloud

    def test_gate_deadline_is_an_explicit_admission_input(self):
        from deploy_gates import GATE_DEADLINE_SECONDS
        env = self.adapter.capacity_admission_env(1_000_000.4, environ={})
        self.assertEqual(env, {"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": str(1_000_000 + GATE_DEADLINE_SECONDS)})
        # An operator's explicit deadline wins; it is never silently extended.
        self.assertEqual(self.adapter.capacity_admission_env(
            1_000_000, environ={"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": "1000100"}),
            {"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": "1000100"})

    def test_execute_hands_the_deadline_to_the_native_cli(self):
        calls = []
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as base:
            root = Path(base)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / '.git/info/exclude').write_text('.context/\n')
            for relative in ('scripts/lib/cloudbench-env.sh', 'scripts/create-worktree-patch.sh'):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            subprocess.run(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
                            'commit', '-qm', 'fixture'], cwd=root, check=True)
            subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd=root, check=True)
            requested = dict(checks=['browser-smoke'], skips={}, token='owned',
                             source=self.adapter.source(root), gate='smoke')
            # Use the real adapter and source seal, but no enclosing gate request or provider.
            standalone = {key: value for key, value in os.environ.items()
                          if key not in ('DEPLOY_GATE_REQUEST', 'DEPLOY_GATE_RESULT')}
            with patch.dict(os.environ, standalone, clear=True), \
                    patch.object(self.adapter, 'origin_fetchable', return_value=True), \
                    patch.object(self.adapter, 'campaign_width', return_value=1), \
                    patch.object(self.adapter, 'shared_canary_env', return_value={}), \
                    patch.object(self.adapter, 'run_command', side_effect=lambda *a, **k:
                                 (calls.append((a, k)) or (1, False, False, False))), \
                    patch.object(self.adapter, 'collect_campaign',
                                 return_value=({'browser-smoke': 'UNVERIFIED'}, {}, False, 'fixture')):
                foreign = root / 'foreign/attempts/0/initial/smoke/request.json'
                with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(foreign)):
                    with self.assertRaisesRegex(ValueError, 'missing request-owned custody locator'):
                        self.adapter.execute(requested, root)
                self.assertEqual(calls, [])
                before = time.time()
                result = self.adapter.execute(requested, root)
                self.assertEqual(result['source_transport']['source'], requested['source'])
        self.assertEqual(len(calls), 1)
        deadline = int(calls[0][1]["env"]["CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH"])
        from deploy_gates import GATE_DEADLINE_SECONDS
        self.assertGreaterEqual(deadline, int(before) + GATE_DEADLINE_SECONDS - 1)
        self.assertLessEqual(deadline, int(time.time()) + GATE_DEADLINE_SECONDS)


if __name__ == "__main__":
    unittest.main()
