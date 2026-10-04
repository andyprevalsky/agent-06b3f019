#!/usr/bin/env python3
"""Compact deploy control: evaluated outcomes are visible before teardown."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT / "agents"
PYTHON = AGENTS / "venv/bin/python"

if __name__ == "__main__":
    interpreter = str(PYTHON) if PYTHON.exists() else sys.executable
    env = dict(os.environ)
    env["PATH"] = str(Path(interpreter).parent) + os.pathsep + env.get("PATH", "")
    if Path("/opt/homebrew/bin").is_dir():
        env["PATH"] = str(Path(interpreter).parent) + ":/opt/homebrew/bin:" + env.get("PATH", "")
    raise SystemExit(
        subprocess.call(
            [
                interpreter,
                "-m",
                "pytest",
                "-q",
                "benchmarks/cloudbench_dependency_sync_test.py",
                "benchmarks/cloud_batch_cleanup_test.py",
                "benchmarks/worker_capacity_loop_test.py",
                "benchmarks/outcome_publication_test.py",
                "-k",
                "fleet_publishes_evaluation_before_teardown or evaluated_outcome_is_visible_before_agent_and_phone_teardown or autoscaler_runtime_handoff_capacity or outcome_publication_http or outcome_wait_preserves",
            ],
            cwd=AGENTS,
            env=env,
        )
    )
