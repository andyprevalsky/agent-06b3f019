#!/usr/bin/env python3
"""Blackbox tests for `scripts/descend handoff`, the /descend RCA_FAILURES handoff.

Fixtures are the recorded campaign of the descend-batch1-k3 replay scenario (its
summary.json, job logs and run records), written to a temporary repository the way the
replay sandbox lays them out; the real fleet layout (`_batch/run.json` with launch
provenance and no recorded FE link) is derived from the same rows.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DESCEND = ROOT / "scripts/descend"
SCENARIO = ROOT / "agents/benchmarks/claude_md_replay/skill_scenarios/descend-batch1-k3.json"
RUN_BENCHMARK = ROOT / "agents/benchmarks/run_benchmark.py"
CAMPAIGN_ID = "campaign-20261106-110418-4087313"
HEAD = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True,
                      text=True).stdout.strip()
PLACEHOLDERS = ("None", "null", "{", "}", "<", ">", "TODO", "unknown", "N/A")


class DescendHandoffTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name) / "repo"
        scenario = json.loads(SCENARIO.read_text())
        self.campaign = Path(scenario["vars"]["CDIR"].replace("{REPO}", str(self.repo)))

        def fill(text: str) -> str:
            for name, value in (("{CDIR}", str(self.campaign)), ("{REPO}", str(self.repo)),
                                ("{HEAD_13}", HEAD[:13]), ("{HEAD_SHORT}", HEAD[:10]),
                                ("{CONTROLLER_TOKEN}", scenario["controller"]["token"])):
                text = text.replace(name, value)
            self.assertIsNone(re.search(r"\{[A-Z_0-9]+\}", text), text[:200])
            return text

        for template, content in scenario["controller"]["on_exit_files"].items():
            path = Path(fill(template))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(fill(content))
        self.summary = json.loads((self.campaign / "summary.json").read_text())

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def handoff(self, directory: Path, task: str, *, code: int = 0) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(["bash", str(DESCEND), "handoff", str(directory), task], cwd=ROOT,
                                   text=True, capture_output=True, timeout=60)
        self.assertEqual(completed.returncode, code, completed.stdout + completed.stderr)
        if code:
            self.assertEqual(completed.stdout, "", "a refused handoff must print no partial text")
            self.assertTrue(completed.stderr.startswith("descend handoff: "), completed.stderr)
        else:
            self.assertEqual(completed.stderr, "")
        return completed

    def job(self, job_id: str) -> dict:
        return next(job for job in self.summary["jobs"] if job["job_id"] == job_id)

    def fleet(self, job_id: str) -> Path:
        log = (self.campaign / Path(self.job(job_id)["log"]).name).read_text()
        return Path(re.search(r"run-bench monitor (\S+)", log).group(1))

    def record_path(self, job_id: str) -> Path:
        return self.fleet(job_id) / self.job(job_id)["task"] / "run.json"

    def edit_row(self, job_id: str, **changes: object) -> None:
        path = self.record_path(job_id)
        record = json.loads(path.read_text())
        record["tasks"][0].update(changes)
        path.write_text(json.dumps(record))

    def assert_copy(self, text: str, job_id: str, attempt: int = 1) -> None:
        row = json.loads(self.record_path(job_id).read_text())["tasks"][0]
        self.assertIn(f"- Job {job_id}, attempt {attempt} (fleet run {self.fleet(job_id).name}): FAILED\n"
                      f"  Agent ID: {row['agent_id']}\n"
                      f"  FE link: http://localhost:17320/open-agent?agent-id={row['agent_id']}\n"
                      f"  Source SHA: {HEAD[:13]}\n"
                      f"  Evaluator failure: {row['failure_reason']}\n", text)

    def assert_rules(self, text: str) -> None:
        for rule in ("Time box: 100 minutes of wall clock from when you start; no tool-call or token cap",
                     "At 90 minutes commit what works and hand back your evidence",
                     "Dedupe first: check the RCA ledger", "`python3 scripts/rca_archive.py search`",
                     "If another RCA already owns this defect, hand it this task with the evidence above and stop.",
                     "Post your named defect (code site and mechanism) to the ledger before writing a fix",
                     "A shared symptom (failure string, evaluator, status, timeout, website or issue class)",
                     "an isolated local repro", "never run scripts/setup-db.sh",
                     "Never deploy and never contact the user"):
            self.assertIn(rule, text)
        # Evaluator text is recorded data and may contain any character; everything else is generated.
        generated = "\n".join(line for line in text.splitlines() if not line.startswith("  Evaluator failure: "))
        for placeholder in PLACEHOLDERS:
            self.assertNotIn(placeholder, generated)

    def test_campaign_handoff_carries_every_failed_copy(self) -> None:
        text = self.handoff(self.campaign, "kill-agent-subtree").stdout
        self.assertTrue(text.startswith(
            "/rca kill-agent-subtree: 3 of 3 scheduled copies failed in a /descend run.\n"), text)
        self.assertIn(f"\nCampaign: {CAMPAIGN_ID}\nFailed copies:\n", text)
        for job_id in ("r001-j0003", "r002-j0023", "r003-j0043"):
            self.assert_copy(text, job_id)
        self.assertIn("3cceb724-4d32-5591-b476-70f2e23cf841", text)
        self.assertIn("target subtree not stopped: grandchild and control agents still RUNNING after kill_agent",
                      text)
        self.assertNotIn("Passed copies", text)
        self.assert_rules(text)

    def test_every_failed_task_of_the_batch_gets_a_complete_handoff(self) -> None:
        failed = {job["task"] for job in self.summary["jobs"] if job["task_status"] == "FAILED"}
        self.assertEqual(len(failed), 11)
        for task in sorted(failed):
            text = self.handoff(self.campaign, task).stdout
            for job in self.summary["jobs"]:
                if job["task"] == task and job["task_status"] == "FAILED":
                    self.assert_copy(text, job["job_id"])
            self.assert_rules(text)

    def test_partly_failing_task_names_its_passing_copies(self) -> None:
        text = self.handoff(self.campaign, "lantern-people-pagination").stdout
        self.assertTrue(text.startswith("/rca lantern-people-pagination: 1 of 3 scheduled copies failed"), text)
        self.assert_copy(text, "r002-j0025")
        self.assertIn("Evaluator failure: Benchmark timed out after 300s\n", text)
        self.assertIn("Passed copies: r001-j0005 (attempt 1), r003-j0045 (attempt 1)\n", text)
        self.assertNotIn("r001-j0005, attempt", text)

    def test_task_without_a_failed_copy_or_job_is_refused(self) -> None:
        refused = self.handoff(self.campaign, "demo-fleet-alpha", code=1)
        self.assertIn("missing a failed copy of demo-fleet-alpha (passed: 3", refused.stderr)
        refused = self.handoff(self.campaign, "no-such-task", code=1)
        self.assertIn("missing any scheduled job for task no-such-task", refused.stderr)
        self.handoff(self.campaign / "absent", "kill-agent-subtree", code=1)

    def test_live_campaign_hands_off_finished_failures_only(self) -> None:
        self.job("r003-j0043").update(status="running", task_status=None, finished_at=None)
        self.job("r002-j0023").update(status="cancelled")
        (self.campaign / "summary.json").write_text(json.dumps(self.summary))
        text = self.handoff(self.campaign, "kill-agent-subtree").stdout
        self.assertTrue(text.startswith("/rca kill-agent-subtree: 1 of 3 scheduled copies failed"), text)
        self.assert_copy(text, "r001-j0003")
        self.assertIn("Still running or queued: r003-j0043 (attempt 1)\n", text)
        self.assertIn("Cancelled copies: r002-j0023 (attempt 1)\n", text)

    def test_retried_attempt_is_read_from_its_own_log(self) -> None:
        shutil.copy(self.campaign / "r001-j0003.log", self.campaign / "r001-j0003.attempt-2.log")
        (self.campaign / "r001-j0003.log").write_text("first attempt: INFRA, released before a verdict\n")
        self.job("r001-j0003").update(attempt=2, log=str(self.campaign / "r001-j0003.attempt-2.log"))
        (self.campaign / "summary.json").write_text(json.dumps(self.summary))
        self.edit_row("r001-j0003", attempt=2)
        self.assert_copy(self.handoff(self.campaign, "kill-agent-subtree").stdout, "r001-j0003", attempt=2)
        self.edit_row("r001-j0003", attempt=1)
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("job r001-j0003 attempt 2: missing its own run record", refused.stderr)

    def test_missing_required_fields_fail_loudly(self) -> None:
        for field, named in (("agent_id", "missing agent_id"), ("failure_reason", "missing failure_reason"),
                             ("status", "missing status")):
            with self.subTest(field=field):
                original = self.record_path("r002-j0023").read_text()
                self.edit_row("r002-j0023", **{field: None})
                refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
                self.assertIn(f"job r002-j0023 attempt 1: {named}", refused.stderr)
                self.record_path("r002-j0023").write_text(original)
        record = json.loads(self.record_path("r002-j0023").read_text())
        del record["source_sha"]
        self.record_path("r002-j0023").write_text(json.dumps(record))
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("missing source SHA for job r002-j0023 attempt 1", refused.stderr)
        self.edit_row("r001-j0003", passed=True)
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("job r001-j0003 attempt 1: missing a failed verdict", refused.stderr)
        self.record_path("r001-j0003").unlink()
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("missing run record", refused.stderr)
        (self.campaign / "r001-j0003.log").write_text("controller exited before printing its fleet\n")
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("job r001-j0003: missing fleet run directory", refused.stderr)
        (self.campaign / "r001-j0003.log").unlink()
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("job r001-j0003: missing job log", refused.stderr)
        self.job("r001-j0003").pop("attempt")
        (self.campaign / "summary.json").write_text(json.dumps(self.summary))
        refused = self.handoff(self.campaign, "kill-agent-subtree", code=1)
        self.assertIn("job r001-j0003: missing attempt", refused.stderr)

    def to_fleet_layout(self, job_id: str, patch: str) -> tuple[Path, dict]:
        """Rewrite one job's record the way the real fleet aggregates it."""
        fleet, path = self.fleet(job_id), self.record_path(job_id)
        record = json.loads(path.read_text())
        path.unlink()
        row = record["tasks"][0]
        for field in ("agent_url", "job_id", "attempt", "campaign_id"):
            row.pop(field)
        record.pop("source_sha")
        (fleet / "_batch").mkdir()
        (fleet / "_batch/run.json").write_text(json.dumps(record))
        (fleet / "execution-provenance.json").write_text(json.dumps(
            {"schema_version": "cloudbench-execution-provenance-v1", "base_sha": HEAD,
             "workspace_patch_sha256": patch}))
        return fleet, row

    def test_real_fleet_layout_uses_launch_provenance_and_durable_link(self) -> None:
        constant = re.search(r'^DURABLE_BENCHMARK_FRONTEND_URL = "([^"]+)"$', RUN_BENCHMARK.read_text(), re.M)
        self.assertEqual(constant.group(1), "https://roselabs.ai")
        patch = "a" * 64
        fleet, row = self.to_fleet_layout("r002-j0023", patch)
        text = self.handoff(self.campaign, "kill-agent-subtree").stdout
        self.assertIn(f"- Job r002-j0023, attempt 1 (fleet run {fleet.name}): FAILED\n"
                      f"  Agent ID: {row['agent_id']}\n"
                      f"  FE link: https://roselabs.ai/?agent-id={row['agent_id']}\n"
                      f"  Source SHA: {HEAD} + workspace patch sha256 {patch}\n"
                      f"  Evaluator failure: {row['failure_reason']}\n", text)
        self.assert_copy(text, "r001-j0003")
        direct = self.handoff(fleet, "kill-agent-subtree").stdout
        self.assertIn(f"\nFleet run: {fleet.name}\nFailed copies:\n- Job {fleet.name}, attempt 1 (fleet run "
                      f"{fleet.name}): FAILED\n", direct)
        self.assertNotIn("Campaign:", direct)
        self.assert_rules(direct)
        (fleet / "execution-provenance.json").unlink()
        refused = self.handoff(fleet, "kill-agent-subtree", code=1)
        self.assertIn("missing source SHA", refused.stderr)

    def test_fleet_run_directory_bound_to_a_campaign(self) -> None:
        fleet = self.fleet("r001-j0003")
        text = self.handoff(fleet, "kill-agent-subtree").stdout
        self.assertTrue(text.startswith("/rca kill-agent-subtree: 1 of 1 scheduled copies failed"), text)
        self.assertIn(f"\nCampaign: {CAMPAIGN_ID}\nFleet run: {fleet.name}\nFailed copies:\n", text)
        self.assert_copy(text, "r001-j0003")
        self.handoff(self.fleet("r001-j0001"), "demo-fleet-alpha", code=1)

    def test_descend_command_names_the_helper(self) -> None:
        command = re.sub(r"\s+", " ", (ROOT / ".claude/commands/descend.md").read_text())
        self.assertIn("| 7 | `RCA_FAILURES` | Start one `/RCA` per failed task as it fails; RCAs dedupe themselves | "
                      "`scripts/descend handoff <campaign-or-run-dir> <task>` |", command)
        self.assertIn("The handoff is the output of `scripts/descend handoff <campaign-or-run-dir> <task>`", command)
        self.assertNotIn("gap: `scripts/descend handoff", command)


if __name__ == "__main__":
    unittest.main(verbosity=2)
