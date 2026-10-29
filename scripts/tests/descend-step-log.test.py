#!/usr/bin/env python3
"""Blackbox tests for durable /descend step timing history."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LOGGER = ROOT / "scripts/descend_step_log.py"


class DescendStepLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.history = temp_path / "descend_steps.jsonl"
        self.state_root = temp_path / "state"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_logger(
        self, *args: str, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(LOGGER),
                *args,
                "--history",
                str(self.history),
                "--state-root",
                str(self.state_root),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=check,
        )

    def complete_run(
        self,
        run_id: str,
        *,
        run_start: str = "2026-07-22T00:00:00Z",
        first_end: str,
        run_end: str,
    ) -> None:
        self.run_logger(
            "start",
            "--run-id",
            run_id,
            "--slice",
            "daily",
            "--step",
            "RESOLVE_SLICE",
            "--epoch",
            "1",
            "--task-count",
            "42",
            "--at",
            run_start,
        )
        self.run_logger(
            "transition",
            "--run-id",
            run_id,
            "--step",
            "RUN_SLICE",
            "--epoch",
            "1",
            "--at",
            first_end,
        )
        self.run_logger(
            "finish",
            "--run-id",
            run_id,
            "--run-terminal",
            "--at",
            run_end,
        )

    def records(self) -> list[dict[str, object]]:
        if not self.history.exists():
            return []
        return [
            json.loads(line)
            for line in self.history.read_text().splitlines()
            if line.strip()
        ]

    def stage_finishes(self) -> list[dict[str, object]]:
        return [
            record
            for record in self.records()
            if record.get("workflow") == "descend"
            and record.get("event") == "stage-finish"
        ]

    def test_transition_appends_completed_steps_and_preserves_dimensions(self) -> None:
        self.complete_run(
            "run-a",
            first_end="2026-07-22T00:00:10Z",
            run_end="2026-07-22T00:00:40Z",
        )

        records = self.records()
        self.assertEqual(
            [(record["event"], record["value"]) for record in records],
            [
                ("stage-start", "RESOLVE_SLICE"),
                ("stage-finish", "RESOLVE_SLICE"),
                ("stage-start", "RUN_SLICE"),
                ("stage-finish", "RUN_SLICE"),
                ("outcome", "completed"),
            ],
        )
        first, second = self.stage_finishes()
        self.assertEqual(first["record_type"], "factory_event")
        self.assertEqual(first["workflow"], "descend")
        self.assertEqual(first["event"], "stage-finish")
        self.assertEqual(first["value"], "RESOLVE_SLICE")
        self.assertEqual(first["run_id"], "run-a")
        self.assertEqual(first["slice"], "daily")
        self.assertEqual(first["task_count"], 42)
        self.assertEqual(first["lane"], "main")
        self.assertEqual(first["step"], "RESOLVE_SLICE")
        self.assertEqual(first["duration_seconds"], 10.0)
        self.assertEqual(
            datetime.fromisoformat(str(first["recorded_at"]).replace("Z", "+00:00")),
            datetime.fromisoformat(str(first["finished_at"]).replace("Z", "+00:00")),
        )
        self.assertIsInstance(first["recorded_epoch"], float)
        self.assertFalse(first["run_terminal"])
        self.assertEqual(second["step"], "RUN_SLICE")
        self.assertEqual(second["duration_seconds"], 30.0)
        self.assertTrue(second["run_terminal"])
        self.assertFalse((self.state_root / "run-a" / "timing").exists())

    def test_step_detail_records_counts_and_rejects_unsafe_values(self) -> None:
        common = ("--run-id", "run-d")
        self.run_logger("start", *common, "--slice", "full", "--step", "RUN_SLICE",
                        "--epoch", "1", "--task-count", "600", "--at", "2026-07-22T00:00:00Z")
        rejected = self.run_logger("finish", *common, "--detail", "secret=x",
                                   "--at", "2026-07-22T00:10:00Z", check=False)
        self.assertNotEqual(rejected.returncode, 0)
        self.run_logger(
            "finish", *common, "--run-terminal", "--status", "failed",
            "--detail", "infra_failed=30", "--detail", "scheduled_total=600",
            "--detail", "failed_count=41", "--at", "2026-07-22T00:10:00Z",
        )
        finish, outcome = (r for r in self.records() if r["event"] in {"stage-finish", "outcome"})
        for record in (finish, outcome):
            self.assertEqual(
                record["detail"],
                {"schema_version": 1, "infra_failed": 30, "scheduled_total": 600, "failed_count": 41},
            )
        self.assertNotIn("detail", self.records()[0])

    def test_active_lane_cannot_be_restarted_or_closed_backwards(self) -> None:
        start = (
            "start",
            "--run-id",
            "run-active",
            "--slice",
            "daily",
            "--step",
            "RESOLVE_SLICE",
            "--epoch",
            "1",
            "--at",
            "2026-07-22T00:00:10Z",
        )
        self.run_logger(*start)

        duplicate = self.run_logger(*start, check=False)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("already active", duplicate.stderr)

        backwards = self.run_logger(
            "transition",
            "--run-id",
            "run-active",
            "--step",
            "RUN_SLICE",
            "--epoch",
            "1",
            "--at",
            "2026-07-22T00:00:09Z",
            check=False,
        )
        self.assertNotEqual(backwards.returncode, 0)
        self.assertIn("precedes step start", backwards.stderr)
        self.assertEqual(
            [(record["event"], record["value"]) for record in self.records()],
            [("stage-start", "RESOLVE_SLICE")],
        )

        self.run_logger(
            "finish",
            "--run-id",
            "run-active",
            "--run-terminal",
            "--at",
            "2026-07-22T00:00:12Z",
        )

    def test_parallel_lanes_do_not_overwrite_each_other(self) -> None:
        for lane in ("rca-I-01", "deploy-I-02"):
            self.run_logger(
                "start",
                "--run-id",
                "parallel",
                "--slice",
                "daily",
                "--step",
                "RCA_INFRA_FIX",
                "--epoch",
                "2",
                "--lane",
                lane,
                "--at",
                "2026-07-22T01:00:00Z",
            )
        for lane, end in (
            ("rca-I-01", "2026-07-22T01:00:05Z"),
            ("deploy-I-02", "2026-07-22T01:00:08Z"),
        ):
            self.run_logger(
                "finish",
                "--run-id",
                "parallel",
                "--lane",
                lane,
                "--at",
                end,
            )

        self.assertEqual(
            {record["lane"] for record in self.stage_finishes()},
            {"rca-I-01", "deploy-I-02"},
        )

    def test_report_compares_recent_and_previous_iteration_speed(self) -> None:
        self.complete_run(
            "run-slow",
            run_start="2026-07-21T00:00:00Z",
            first_end="2026-07-21T00:00:10Z",
            run_end="2026-07-21T00:00:40Z",
        )
        self.complete_run(
            "run-fast",
            first_end="2026-07-22T00:00:05Z",
            run_end="2026-07-22T00:00:20Z",
        )
        self.run_logger(
            "start",
            "--run-id",
            "run-blocked",
            "--slice",
            "daily",
            "--task-count",
            "42",
            "--step",
            "RESOLVE_SLICE",
            "--epoch",
            "1",
            "--at",
            "2026-07-23T00:00:00Z",
        )
        self.run_logger(
            "finish",
            "--run-id",
            "run-blocked",
            "--status",
            "blocked",
            "--run-terminal",
            "--at",
            "2026-07-23T00:00:01Z",
        )

        result = self.run_logger(
            "report",
            "--slice",
            "daily",
            "--window",
            "1",
            "--json",
        )
        payload = json.loads(result.stdout)
        resolve = next(
            row for row in payload["steps"] if row["step"] == "RESOLVE_SLICE"
        )
        self.assertEqual(resolve["samples"], 2)
        self.assertEqual(resolve["recent_median_seconds"], 5.0)
        self.assertEqual(resolve["previous_median_seconds"], 10.0)
        self.assertEqual(resolve["change_percent"], -50.0)
        self.assertEqual(payload["run_wall_clock"]["completed_runs"], 2)
        self.assertEqual(payload["run_wall_clock"]["recent_median_seconds"], 20.0)
        self.assertEqual(payload["run_wall_clock"]["previous_median_seconds"], 40.0)
        self.assertEqual(payload["run_wall_clock"]["change_percent"], -50.0)

        all_statuses = self.run_logger(
            "report",
            "--slice",
            "daily",
            "--status",
            "all",
            "--window",
            "1",
            "--json",
        )
        self.assertEqual(
            json.loads(all_statuses.stdout)["run_wall_clock"]["completed_runs"], 3
        )


if __name__ == "__main__":
    unittest.main()
