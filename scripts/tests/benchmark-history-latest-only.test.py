"""Offline regression: a branch deploy commits only each task's most recent run."""
from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "benchmark-history-latest-only.py"
spec = importlib.util.spec_from_file_location("history_latest_only", SCRIPT)
tool = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = tool
spec.loader.exec_module(tool)

HISTORY = Path("agents/benchmarks/history")


def attempt(task, passed, end, duration, agent):
    return {"task": task, "passed": passed, "status": "COMPLETED" if passed else "FAILED",
            "duration_seconds": duration, "cost_cents": 0.0, "timestamp": end,
            "agent_id": agent, "failure_reason": None if passed else "boom",
            "fast_mode_cache": False, "counts_for_deploy_eligibility": False, "suite": "predeploy"}


def span(benchmark, agent, stamp):
    return {"agent_id": agent, "benchmark": benchmark, "duration_ms": 1.0, "span_key": "k",
            "span_name": "n", "status": "ok", "timestamp": stamp}


class LatestOnlyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        (self.repo / HISTORY).mkdir(parents=True)
        # Main already holds an old failure and pass; these must never be touched.
        self.base_attempts = [attempt("smoke-a", False, "2026-10-01T00:10:00+00:00", 60, "main-1"),
                              attempt("smoke-a", True, "2026-10-01T01:10:00+00:00", 60, "main-2")]
        self.write("task_attempts.jsonl", self.base_attempts)
        self.write("task_durations.jsonl", [{"task": "smoke-a", "duration_seconds": 60,
                                             "timestamp": "2026-10-01T01:10:00+00:00", "agent_id": "main-2"}])
        self.write("span_durations.jsonl", [span("smoke-a", "main-2", "2026-10-01T01:09:30+00:00")])
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        self.git("branch", "base")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(("git", "-C", str(self.repo), *args), check=True, capture_output=True)

    def write(self, name, rows, append=False):
        path = self.repo / HISTORY / name
        with path.open("a" if append else "w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")

    def read(self, name):
        path = self.repo / HISTORY / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else None

    def run_tool(self, *args):
        with redirect_stdout(io.StringIO()) as out:
            code = tool.main(["--repo", str(self.repo), "--base", "base", *args])
        return code, out.getvalue()

    def branch_iteration(self):
        # Deploy loop: smoke-a fails twice, then passes after the fix. smoke-b passes once.
        # smoke-c ran two concurrent copies in its final run after an earlier failed run.
        self.write("task_attempts.jsonl", [
            attempt("smoke-a", False, "2026-10-21T10:05:00+00:00", 300, "br-a1"),
            attempt("smoke-c", False, "2026-10-21T10:06:00+00:00", 100, "br-c1"),
            attempt("smoke-a", False, "2026-10-21T11:05:00+00:00", 300, "br-a2"),
            attempt("smoke-b", True, "2026-10-21T11:06:00+00:00", 100, "br-b1"),
            attempt("smoke-a", True, "2026-10-21T12:05:00+00:00", 300, "br-a3"),
            attempt("smoke-c", True, "2026-10-21T12:06:00+00:00", 200, "br-c2"),
            attempt("smoke-c", True, "2026-10-21T12:06:30+00:00", 220, "br-c3"),
        ], append=True)
        self.write("task_durations.jsonl", [
            {"task": "smoke-b", "duration_seconds": 100, "timestamp": "2026-10-21T11:06:00+00:00", "agent_id": "br-b1"},
            {"task": "smoke-a", "duration_seconds": 300, "timestamp": "2026-10-21T12:05:00+00:00", "agent_id": "br-a3"},
            {"task": "smoke-c", "duration_seconds": 200, "timestamp": "2026-10-21T12:06:00+00:00", "agent_id": "br-c2"},
            {"task": "smoke-c", "duration_seconds": 220, "timestamp": "2026-10-21T12:06:30+00:00", "agent_id": "br-c3"},
        ], append=True)
        self.write("span_durations.jsonl", [
            span("smoke-a", "br-a1", "2026-10-21T10:01:00+00:00"),
            span("smoke-a", "child-of-a2", "2026-10-21T11:02:00+00:00"),
            span("smoke-a", "child-of-a3", "2026-10-21T12:01:00+00:00"),
            span("smoke-a", "br-a3", "2026-10-21T11:59:30+00:00"),
        ], append=True)
        self.write("span_durations.20261021.my-branch.jsonl", [
            span("smoke-a", "br-a2", "2026-10-21T11:01:00+00:00"),
        ])

    def test_write_keeps_only_latest_branch_run_and_all_base_rows(self):
        self.branch_iteration()
        code, out = self.run_tool("--write")
        self.assertEqual(code, 0, out)
        attempts = self.read("task_attempts.jsonl")
        self.assertEqual(attempts[:2], self.base_attempts)
        self.assertEqual([r["agent_id"] for r in attempts[2:]], ["br-b1", "br-a3", "br-c2", "br-c3"])
        self.assertTrue(all(r["passed"] for r in attempts[2:]))
        self.assertEqual([r["agent_id"] for r in self.read("task_durations.jsonl")],
                         ["main-2", "br-b1", "br-a3", "br-c2", "br-c3"])
        self.assertEqual([r["agent_id"] for r in self.read("span_durations.jsonl")],
                         ["main-2", "child-of-a3", "br-a3"])
        # A new branch span file holding only a superseded run disappears entirely.
        self.assertIsNone(self.read("span_durations.20261021.my-branch.jsonl"))
        self.assertEqual(self.run_tool("--check")[0], 0)

    def test_check_fails_until_written_and_report_mode_changes_nothing(self):
        self.branch_iteration()
        before = (self.repo / HISTORY / "task_attempts.jsonl").read_bytes()
        code, out = self.run_tool()
        self.assertEqual(code, 0)
        self.assertIn("drop 3 superseded of 7 branch rows", out)
        self.assertEqual((self.repo / HISTORY / "task_attempts.jsonl").read_bytes(), before)
        self.assertEqual(self.run_tool("--check")[0], 1)

    def test_latest_failure_is_kept_because_it_describes_the_merged_code(self):
        self.write("task_attempts.jsonl", [
            attempt("smoke-a", True, "2026-10-21T10:05:00+00:00", 60, "br-1"),
            attempt("smoke-a", False, "2026-10-21T11:05:00+00:00", 60, "br-2"),
        ], append=True)
        self.run_tool("--write")
        self.assertEqual([r["agent_id"] for r in self.read("task_attempts.jsonl")[2:]], ["br-2"])

    def test_committed_branch_rows_are_filtered_too(self):
        self.branch_iteration()
        self.git("checkout", "-qb", "feature")
        self.git("add", "-A")
        self.git("commit", "-qm", "branch history")
        self.assertEqual(self.run_tool("--check")[0], 1)
        self.run_tool("--write")
        self.assertEqual(self.run_tool("--check")[0], 0)

    def test_no_branch_rows_is_a_clean_noop(self):
        code, out = self.run_tool("--check")
        self.assertEqual(code, 0)
        self.assertIn("no branch rows", out)


if __name__ == "__main__":
    unittest.main()
