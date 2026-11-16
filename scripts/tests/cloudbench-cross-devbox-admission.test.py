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

import ast
import contextlib
import hashlib
import json
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

    def test_without_caller_deadline_the_default_budget_applies(self):
        result = run_admission({"CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS": "2",
                                "CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS": "1"},
                               guard_successes_after=None)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("capacity admission remained blocked for 2s", result.stderr)
        # The shared default matches the teardown disk-reserve wait (1800 s), for
        # the admission guard and the borrowed-inventory wait that shares its clock.
        self.assertIn('local wait_seconds="${CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS:-1800}"',
                      fleet_function("admit_app_capacity_with_wait"))
        self.assertIn('local wait_seconds="${CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS:-1800}"',
                      fleet_function("campaign_inventory_wait"))

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


def lane_inventory(live: int, lane: str) -> str:
    """A native app inventory with `live` started guests of one lane, plus never-counted rows."""
    rows = [{"id": f"m{index}", "state": "started", "config": {
        "metadata": {"rose_cloudbench_lane": lane}, "guest": {"cpu_kind": "shared", "cpus": 4}}}
        for index in range(live)]
    rows += [{"id": "stopped", "state": "stopped", "config": {"metadata": {"rose_cloudbench_lane": lane}}},
             {"id": "worker", "state": "started", "config": {"guest": {"cpu_kind": "performance", "cpus": 1}}}]
    return json.dumps(rows)


class LaneCeilingCapacityDeferral(unittest.TestCase):
    """An app-wide lane ceiling filled by other workstreams defers as capacity, never INFRA.

    2026-11-16 05:50Z: another workspace's ~44 delegating guests held the shared
    ceiling ("86 live REAL/SIM primaries + 1 requested > 70") for the whole 300 s
    admission wait, three rolling-campaign jobs ended INFRA_ERROR and the
    campaign stopped at infra 4/74. The real lane guard, admission wait and
    deferral marker run here against a stubbed native inventory.
    """

    def run_fleet(self, *, lane: str, inventories: list[str], machine_deny: bool = False,
                  unavailable_after: int | None = None, ceiling: int = 3) -> tuple[subprocess.CompletedProcess, Path]:
        directory = Path(tempfile.mkdtemp(dir=os.environ.get("TMPDIR")))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", "--", str(directory)], check=False))
        fleet = directory / "fleet"
        (fleet / "_batch").mkdir(parents=True)
        (fleet / "_batch/benches.json").write_text(json.dumps([{"name": "bench-a"}, {"name": "bench-b"}]))
        for index, inventory in enumerate(inventories):
            (directory / f"inventory-{index}.json").write_text(inventory)
        script = f"""set -u
FLEET_DIR="$1"
INVENTORIES="$2"
BENCHES=(bench-a bench-b)
bench_uses_shared_demo_cache() {{ return 1; }}
fleet_admission_machines_json() {{
    # Runs in the caller's command substitution: count observations in a file.
    local observations
    observations=$(( $(cat "$INVENTORIES/observations" 2>/dev/null || echo 0) + 1 ))
    echo "$observations" > "$INVENTORIES/observations"
    if [ -n "${{UNAVAILABLE_AFTER:-}}" ] && [ "$observations" -gt "$UNAVAILABLE_AFTER" ]; then return 75; fi
    local last=$(( {len(inventories)} - 1 )) index=$((observations - 1))
    [ "$index" -le "$last" ] || index="$last"
    cat "$INVENTORIES/inventory-$index.json"
}}
enforce_app_capacity_guard() {{
    CAPACITY_ADMISSION_RETRYABLE=0
    CAPACITY_ADMISSION_DEFERRAL_REASON=""
    admit_lane_capacity "$warm_json" || return 1
    if [ "${{MACHINE_DENY:-0}}" = 1 ]; then
        CAPACITY_ADMISSION_RETRYABLE=1
        echo "❌ Machine-count capacity admission denied: fixture" >&2
        return 1
    fi
    return 0
}}
{fleet_function("record_capacity_deferral")}
{fleet_function("admit_lane_capacity")}
{fleet_function("admit_app_capacity_with_wait")}
admit_app_capacity_with_wait 1
status=$?
printf 'observations=%s status=%s\\n' "$(cat "$INVENTORIES/observations")" "$status"
exit "$status"
"""
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("CLOUDBENCH_CAPACITY_ADMISSION", "CLOUDBENCH_DEMO_GUEST", "CLOUDBENCH_DELEGATING"))}
        for key in ("CAPACITY_ADMISSION_DEADLINE", "PROVISION_POOL", "INFRA_PROBE", "SNAPSHOT_LOOP_PID"):
            env.pop(key, None)
        env.update(CLOUDBENCH_LANE=lane, CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS="2",
                   CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS="1", CLOUDBENCH_DEMO_GUEST_CEILING=str(ceiling),
                   CLOUDBENCH_DELEGATING_PRIMARY_CEILING=str(ceiling), MACHINE_DENY="1" if machine_deny else "0")
        if unavailable_after is not None:
            env.update(UNAVAILABLE_AFTER=str(unavailable_after), SNAPSHOT_LOOP_PID="1")
        result = subprocess.run(["bash", "-c", script, "fixture", str(fleet), str(directory)], env=env,
                                text=True, capture_output=True, timeout=30)
        return result, fleet

    def aggregate(self, fleet: Path) -> list[dict]:
        result = subprocess.run([sys.executable, str(ROOT / "scripts/cloudbench-aggregate-runs.py"), str(fleet),
                                 str(fleet / "_batch/run.json")], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((fleet / "_batch/run.json").read_text())["tasks"]

    def campaign_infra(self, rows: list[dict]) -> tuple[list[bool], dict | None]:
        import runpy
        campaign = runpy.run_path(str(ROOT / "scripts/run-bench-campaign.py"))
        verdicts = [campaign["task_verdict"](row) for row in rows]
        jobs = [{"job_id": f"r001-j{index:04d}", "status": "failed", **verdict}
                for index, verdict in enumerate(verdicts)]
        # One scheduled job: a single confirmed infra failure would breach the 5% stop.
        return [verdict["infra_failure"] for verdict in verdicts], campaign["infra_stop_receipt"](jobs, 1, "enabled")

    def test_expired_lane_ceiling_wait_defers_as_capacity_outside_the_infra_stop(self):
        for lane, reason, refusal in (
                ("delegating", "delegating_primary_ceiling",
                 "Delegating-guest ceiling reached: 3 live REAL/SIM primaries + 2 requested > 3"),
                ("demo", "demo_guest_ceiling", "DEMO guest ceiling reached: 3 live + 2 requested > 3")):
            with self.subTest(lane=lane):
                result, fleet = self.run_fleet(lane=lane, inventories=[lane_inventory(3, lane)])
                self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
                self.assertIn(refusal, result.stderr)
                self.assertIn("⏳ capacity admission pending", result.stderr)
                self.assertIn("capacity admission remained blocked for 2s", result.stderr)
                self.assertIn(f"CLOUDBENCH_RETRYABLE_CAPACITY={reason}\n", result.stderr)
                marker = json.loads((fleet / "_batch/capacity-deferred.json").read_text())
                self.assertEqual((marker["schema"], marker["reason"], marker["wait_seconds"]),
                                 ("cloudbench-capacity-deferred-v1", reason, 2))
                rows = self.aggregate(fleet)
                self.assertEqual([(row["name"], row["status"], row["passed"]) for row in rows],
                                 [("bench-a", "CAPACITY_DEFERRED", False), ("bench-b", "CAPACITY_DEFERRED", False)])
                self.assertIn("capacity, not infrastructure", rows[0]["failure_reason"])
                infra, stop = self.campaign_infra(rows)
                self.assertEqual(infra, [False, False])
                self.assertIsNone(stop)

    def test_lane_ceiling_that_frees_within_the_wait_admits(self):
        result, fleet = self.run_fleet(lane="delegating", inventories=[
            lane_inventory(3, "delegating"), lane_inventory(1, "delegating")])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("observations=2 status=0", result.stdout)
        self.assertFalse((fleet / "_batch/capacity-deferred.json").exists())

    def test_expired_non_lane_capacity_wait_stays_confirmed_infra(self):
        result, fleet = self.run_fleet(lane="delegating", inventories=[lane_inventory(0, "delegating")],
                                       machine_deny=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("CLOUDBENCH_RETRYABLE_CAPACITY", result.stderr)
        self.assertFalse((fleet / "_batch/capacity-deferred.json").exists())
        rows = self.aggregate(fleet)
        self.assertEqual({row["status"] for row in rows}, {"INFRA_ERROR"})
        infra, stop = self.campaign_infra(rows)
        self.assertEqual(infra, [True, True])
        self.assertIsNotNone(stop)

    def test_only_the_final_observation_decides_the_deferral(self):
        # A lane refusal followed by unavailable native inventory at expiry is not a
        # proven lane shortage: it keeps the existing INFRA outcome.
        result, fleet = self.run_fleet(lane="delegating", inventories=[lane_inventory(3, "delegating")],
                                       unavailable_after=1)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Delegating-guest ceiling reached", result.stderr)
        self.assertIn("native inventory temporarily unavailable", result.stderr)
        self.assertNotIn("CLOUDBENCH_RETRYABLE_CAPACITY", result.stderr)
        self.assertFalse((fleet / "_batch/capacity-deferred.json").exists())

    def test_real_guard_and_controller_route_the_deferral(self):
        text = FLEET.read_text()
        guard = fleet_function("enforce_app_capacity_guard")
        self.assertLess(guard.index('CAPACITY_ADMISSION_DEFERRAL_REASON=""'), guard.index("admit_lane_capacity "))
        # The controller exits 75 (deferred capacity) only for that status; every other refusal exits 1.
        self.assertIn('\nadmit_app_capacity_with_wait 1 || { [ "$?" -eq 75 ] && exit 75; exit 1; }\n', text)
        self.assertIn("record_capacity_deferral cleanup_disk_reserve", fleet_function("admit_cleanup_disk_reserve"))


class AdapterPassesGateDeadline(unittest.TestCase):
    def setUp(self):
        # This disposable fixture owns its request; the parent deploy owns its own.
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('DEPLOY_GATE_REQUEST', None)
        import deploy_test_cloud
        self.adapter = deploy_test_cloud


    def test_outer_request_does_not_rebind_fixture_custody(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / '.context/deploy-pipeline/attempts/34/phase/gate/request.json'
            request.parent.mkdir(parents=True)
            request.write_text('{}')
            env = dict(os.environ, DEPLOY_GATE_REQUEST=str(request))
            result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()),
                'AdapterPassesGateDeadline.test_execute_hands_the_deadline_to_the_native_cli'], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn('Ran 1 test', result.stdout)

    def test_fixture_restores_request_and_native_owner_guard(self):
        import deploy_test_historical_custody as custody
        before = dict(os.environ)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / '.context/deploy-pipeline/attempts/34/phase/gate/request.json'
            with patch.dict(os.environ, {'DEPLOY_GATE_REQUEST': str(request)}):
                fixture = type(self)('test_execute_hands_the_deadline_to_the_native_cli')
                try:
                    fixture.setUp()
                    self.assertFalse('DEPLOY_GATE_REQUEST' in os.environ)
                finally:
                    fixture.doCleanups()
                self.assertEqual(os.environ['DEPLOY_GATE_REQUEST'], str(request))
                for value in ({}, {'custody_state': str(root / '.context/foreign/cycle.json')}):
                    with self.assertRaisesRegex(ValueError, 'missing request-owned custody locator'):
                        custody.admission(value, root)
        self.assertEqual(dict(os.environ), before)

    def test_gate_deadline_is_an_explicit_admission_input(self):
        from deploy_gates import GATE_DEADLINE_SECONDS
        env = self.adapter.capacity_admission_env(1_000_000.4, environ={})
        self.assertEqual(env, {"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": str(1_000_000 + GATE_DEADLINE_SECONDS)})
        # An operator's explicit deadline wins; it is never silently extended.
        self.assertEqual(self.adapter.capacity_admission_env(
            1_000_000, environ={"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": "1000100"}),
            {"CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH": "1000100"})

    def test_execute_hands_the_deadline_to_the_native_cli(self):
        code = ADAPTER.read_text()
        # execute() and the campaign helpers it calls (launch, rerun_candidates, emit, RERUN_OUTCOMES).
        function = [n for n in ast.parse(code).body
                    if isinstance(n, ast.FunctionDef) and n.name in {"execute", "launch", "rerun_candidates", "emit"}
                    or isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "RERUN_OUTCOMES" for t in n.targets)]
        calls = []
        requested = {"checks": ["browser-smoke"], "skips": {}, "token": "owned",
                     "source": {"head": "a" * 40}, "gate": "smoke"}
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as base:
            namespace = dict(
                NAME=re.compile(r"^[A-Za-z0-9_.-]+$"), source=lambda _r: requested["source"],
                campaign_width=lambda _c: 1, hashlib=hashlib, os=os, time=time, sys=sys,
                cancellation_handlers=contextlib.nullcontext, write=lambda *_a: None,
                shared_canary_env=lambda _r: {}, capacity_admission_env=self.adapter.capacity_admission_env,
                # The adapter refuses an unpushed source first (9b9a4771b0); this fixture's head is pushed.
                origin_fetchable=lambda *_a: True, catalog_quarantines=lambda _r, _c: {}, Path=Path,
                run_command=lambda *a, **k: (calls.append((a, k)) or (1, False, False, False)),
                collect_campaign=lambda *_a: ({"browser-smoke": "UNVERIFIED"}, {}, False, "fixture"))
            exec(compile(ast.Module(body=function, type_ignores=[]), str(ADAPTER), "exec"), namespace)
            before = time.time()
            namespace["execute"](requested, Path(base))
        self.assertEqual(len(calls), 1)
        deadline = int(calls[0][1]["env"]["CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH"])
        from deploy_gates import GATE_DEADLINE_SECONDS
        self.assertGreaterEqual(deadline, int(before) + GATE_DEADLINE_SECONDS - 1)
        self.assertLessEqual(deadline, int(time.time()) + GATE_DEADLINE_SECONDS)


if __name__ == "__main__":
    unittest.main()
