#!/usr/bin/env python3
"""Regression for scripts/run_deploy_pipeline.py (Group 3 + Group 4 driver).

Real run-deploy-stage lanes under a temporary timing run prove: lanes start
concurrently, ``after`` dependencies wait, ``wait`` wakes on the first failure
while siblings keep running, the next run admits that failed lane first, and a
source change after the freeze turns an all-green run into ``stale``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "scripts" / "run_deploy_pipeline.py"


def start_timing(run_root: Path, env: dict[str, str]) -> None:
    subprocess.run(
        ["bash", str(ROOT / "scripts/run-deploy-stage"), "--start"],
        cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL,
    )


def write_plan(path: Path, lanes: list[dict]) -> None:
    path.write_text(json.dumps({"lanes": lanes}))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="deploy-pipeline-test-") as raw:
        tmp = Path(raw)
        env = {**os.environ, "DEPLOY_RUN_ROOT": str(tmp / "runs")}
        start_timing(tmp / "runs", env)
        marker = tmp / "slow-finished"
        plan = tmp / "plan.json"
        write_plan(plan, [
            {"name": "fast-a", "command": ["sleep", "1"], "reuse_passed": False},
            {"name": "fast-b", "command": ["sleep", "1"], "reuse_passed": False},
            {"name": "fails", "command": ["bash", "-c", "sleep 0.5; exit 7"], "reuse_passed": False},
            {"name": "slow", "command": ["bash", "-c", f"sleep 4; touch {marker}"], "reuse_passed": False},
            {"name": "dependent", "command": ["true"], "after": ["fast-a"], "reuse_passed": False},
        ])
        state = tmp / "state"
        started = time.monotonic()
        supervisor = subprocess.Popen(
            [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state)], env=env
        )
        waited = subprocess.run(
            [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "30"],
            env=env, stdout=subprocess.PIPE, text=True,
        )
        wake_s = time.monotonic() - started
        assert waited.returncode == 1, waited.stdout
        assert "FAILED fails exit=7" in waited.stdout, waited.stdout
        assert "slow" in waited.stdout.split("still_running=")[1], waited.stdout
        assert wake_s < 3.5, f"wait must wake on first failure, took {wake_s:.1f}s"
        assert not marker.exists(), "wake happened only after the slow sibling"
        assert supervisor.wait(timeout=30) == 1
        assert marker.exists(), "siblings keep running after a failure"
        total = time.monotonic() - started
        assert total < 7, f"lanes must run concurrently (serial would be >=6.5s), took {total:.1f}s"
        receipt = json.loads((state / "receipt.json").read_text())
        lanes = receipt["lanes"]
        assert receipt["status"] == "failed", receipt
        assert lanes["dependent"]["started_epoch"] >= lanes["fast-a"]["finished_epoch"]
        stage_lines = (Path(env["DEPLOY_RUN_ROOT"]) / Path(
            (Path(env["DEPLOY_RUN_ROOT"]) / "current").read_text().strip())).glob("**/*.jsonl")
        recorded = "".join(path.read_text() for path in stage_lines)
        for name in ("fast-a", "fails", "slow", "dependent"):
            assert f'"{name}"' in recorded, f"run-deploy-stage record missing for {name}"

        # Retry: the previously failed lane is admitted first; serial cap makes order observable.
        # retry_env (backend coverage's failed-first sweep) applies only to the
        # lane that failed in the previous receipt.
        retry_marks = tmp / "retry-marks"
        retry_marks.mkdir()
        mark = f'echo "${{PIPELINE_RETRY:-0}}" > {retry_marks}/'
        write_plan(plan, [
            {"name": "fast-a", "command": ["bash", "-c", mark + "fast-a"], "reuse_passed": False,
             "retry_env": {"PIPELINE_RETRY": "1"}},
            {"name": "fails", "command": ["bash", "-c", mark + "fails"], "reuse_passed": False,
             "retry_env": {"PIPELINE_RETRY": "1"}},
        ])
        retry = subprocess.run(
            [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state),
             "--max-parallel", "1"], env=env,
        )
        assert retry.returncode == 0
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["order"][0] == "fails", receipt["order"]
        assert receipt["lanes"]["fails"]["started_epoch"] < receipt["lanes"]["fast-a"]["started_epoch"]
        assert (state / "history.jsonl").read_text().count("\n") == 1
        assert (retry_marks / "fails").read_text().strip() == "1", "failed lane must get its retry_env"
        assert (retry_marks / "fast-a").read_text().strip() == "0", "passed lane must not get retry_env"
        standard = json.loads(subprocess.run(
            [sys.executable, str(DRIVER), "plan", "--group", "3", "--backend"],
            stdout=subprocess.PIPE, text=True, check=True,
        ).stdout)
        backend = next(lane for lane in standard["lanes"] if lane["name"] == "backend-coverage-blackbox")
        assert backend["command"] == ["npm", "run", "test:coverage:sharded"], backend
        assert backend["retry_env"] == {"BACKEND_COVERAGE_FAILED_FIRST": "1"}, backend

        # A --reuse-passed cache hit records status "reused" (exp/telemetry); the
        # shared stage waiter must treat it as a pass, never as a failed lane.
        write_plan(plan, [{"name": "cached", "command": ["true"], "reuse_passed": True}])
        for _ in range(2):
            ran = subprocess.run(
                [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state)], env=env
            )
            assert ran.returncode == 0, ran.returncode
        waited = subprocess.run(
            [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "10"],
            env=env, stdout=subprocess.PIPE, text=True,
        )
        run_dir = Path(json.loads((state / "receipt.json").read_text())["stage_run_dir"])
        reused_rows = [row for row in map(json.loads, (run_dir / "stages.jsonl").read_text().splitlines())
                       if row.get("stage") == "cached" and row.get("status") == "reused"]
        assert reused_rows, "second run must be an exact-input reuse"
        assert waited.returncode == 0, waited.stdout

        # A source edit during the sweep must never report green.
        probe = ROOT / ".pipeline-stale-probe.tmp"
        write_plan(plan, [{"name": "edits", "command": ["bash", "-c", f"echo x > {probe}"],
                           "reuse_passed": False}])
        try:
            stale = subprocess.run(
                [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state)], env=env
            )
            waited = subprocess.run(
                [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "10"],
                env=env, stdout=subprocess.PIPE, text=True,
            )
        finally:
            probe.unlink(missing_ok=True)
        assert stale.returncode == 5 and waited.returncode == 5, (stale.returncode, waited.stdout)
    print("run-deploy-pipeline: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
