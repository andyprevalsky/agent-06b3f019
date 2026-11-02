#!/usr/bin/env python3
"""Enforce agreed exceptions and cumulative reporting without running repair agents."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("failure_report", ROOT / "scripts/deploy_failure_report.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FailurePolicyTest(unittest.TestCase):
    def occurrence(self, **changes):
        return {"id": "failure-1", "description": "provider test", "evidence": "native.log:12",
                "native_result": "FAIL / exit 1", "attribution": "UNKNOWN", **changes}

    def test_introduced_and_unknown_stay_blocking(self):
        for attribution in ["INTRODUCED", "UNKNOWN"]:
            e = self.occurrence(attribution=attribution)
            self.assertEqual(MODULE.decision(e), "blocking")
            with self.assertRaises(ValueError):
                MODULE.decision({**e, "repair_agent": "https://www.roselabs.ai/?agent-id=repair"})

    def test_creation_or_delivery_link_completes_handoff_without_ack(self):
        e = self.occurrence(attribution="NOT_INTRODUCED", repair_agent="https://www.roselabs.ai/?agent-id=repair")
        self.assertEqual(MODULE.decision(e), "delegated / waived")
        self.assertNotIn("acknowledgement", e)

    def test_nonintroduced_without_handoff_is_not_silently_waived(self):
        self.assertEqual(MODULE.decision(self.occurrence(attribution="NOT_INTRODUCED")), "blocking")

    def test_boxes_handoff_is_waived_and_rendered_without_rose_migration(self):
        with tempfile.TemporaryDirectory() as d:
            link = "https://boxes.dev/thread/thr_owned_repair"
            report = MODULE.record(Path(d) / "report.json", self.occurrence(
                attribution="NOT_INTRODUCED", repair_agent=link))
            self.assertEqual(report["failures"][0]["disposition"], "delegated / waived")
            self.assertIn("provider test — " + link, MODULE.render(report))
            self.assertEqual(report["failures"][0]["native_result"], "FAIL / exit 1")
        for link in ["http://boxes.dev/thread/thr_owned", "https://boxes.dev.evil.test/thread/thr_owned", "https://boxes.dev/thread/"]:
            with self.subTest(link=link), self.assertRaises(ValueError):
                MODULE.decision(self.occurrence(attribution="NOT_INTRODUCED", repair_agent=link))

    def test_dot_segments_and_nonthread_paths_cannot_waive(self):
        for path in ["..", ".", "%2e%2e", "%2E", "thr_owned/../", "thr_owned/other", "%2f..", "thr_owned%2fother"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                MODULE.decision(self.occurrence(attribution="NOT_INTRODUCED", repair_agent="https://boxes.dev/thread/" + path))

    def test_empty_scorecard_still_shows_blocking_native_results(self):
        entry = {**self.occurrence(), "disposition": "blocking"}
        text = MODULE.render({"failures": [entry]})
        self.assertIn("BLOCKING", text)
        self.assertIn(entry["description"], text)
        self.assertIn(entry["native_result"], text)
        self.assertIn(entry["evidence"], text)
        self.assertNotIn("PASS", text)
        self.assertEqual(MODULE.render({"failures": [entry]}, "Existing scorecard\n"), "Existing scorecard\n")

    def test_external_outage_and_credit_exhaustion_never_require_or_accept_handoff(self):
        for reason in ["outage", "credits exhausted"]:
            e = self.occurrence(attribution="NOT_INTRODUCED", external_provider={"name": "Example", "reason": reason})
            self.assertEqual(MODULE.decision(e), "external / waived")
            with self.assertRaises(ValueError): MODULE.decision({**e, "repair_agent": "https://www.roselabs.ai/?agent-id=x"})
            with self.assertRaises(ValueError): MODULE.decision({**e, "attribution": "INTRODUCED"})

    def test_report_survives_resume_retains_original_results_and_alert_is_last(self):
        with tempfile.TemporaryDirectory(prefix="rose-deploy-report-") as d:
            path = Path(d) / "failure-report.json"
            delegated = self.occurrence(attribution="NOT_INTRODUCED", repair_agent="https://www.roselabs.ai/?agent-id=repair")
            MODULE.record(path, delegated); MODULE.record(path, delegated)
            MODULE.record(path, self.occurrence(id="external", attribution="NOT_INTRODUCED", external_provider={"name":"Example", "reason":"outage"}))
            # Fresh process exercises the documented resume/read/render path.
            p = subprocess.run([sys.executable, str(ROOT / "scripts/deploy_failure_report.py"), "render", "--report", str(path)],
                input="DEPLOY\nREADY TO CLOSE: completed with recorded exceptions\n", capture_output=True, text=True, check=True)
            saved = json.loads(path.read_text())
            self.assertEqual(len(saved["failures"]), 2)
            self.assertEqual(saved["failures"][0]["native_result"], "FAIL / exit 1")
            self.assertEqual(saved["failures"][0]["attribution"], "NOT_INTRODUCED")
            self.assertIn("DELEGATED\n- provider test — https://www.roselabs.ai/?agent-id=repair", p.stdout)
            self.assertNotIn("NOT INTRODUCED", p.stdout)
            self.assertNotIn("NOT_INTRODUCED", p.stdout)
            self.assertGreater(p.stdout.index("🚨🚨 EXTERNAL PROVIDER FAILURE"), p.stdout.index("READY TO CLOSE"))
            self.assertTrue(p.stdout.rstrip().endswith("Evidence: native.log:12"))
            self.assertNotIn("PASS", p.stdout)

    def test_required_evidence_and_occurrence_immutability(self):
        with self.assertRaises(ValueError): MODULE.decision(self.occurrence(evidence=""))
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "report.json"; MODULE.record(path, self.occurrence())
            with self.assertRaises(ValueError): MODULE.record(path, self.occurrence(native_result="PASS"))

    def test_retained_spaced_attribution_survives_resume_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "report.json"
            legacy = self.occurrence(attribution="NOT INTRODUCED", repair_agent="https://www.roselabs.ai/?agent-id=repair")
            retained = {**legacy, "disposition": "delegated / waived"}
            path.write_text(json.dumps({"failures": [retained]}))
            original = path.read_bytes()
            report = MODULE.record(path, legacy)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(report["failures"], [retained])
            self.assertIn("DELEGATED", MODULE.render(report))

    def test_unresolved_or_invalid_rca_attribution_cannot_waive(self):
        for attribution in [None, "", "NOT-INTRODUCED", "INTRODUCED || NOT_INTRODUCED"]:
            with self.subTest(attribution=attribution), self.assertRaises(ValueError):
                MODULE.decision(self.occurrence(attribution=attribution, repair_agent="https://www.roselabs.ai/?agent-id=repair"))
        for kind in [{"repair_agent": "https://www.roselabs.ai/?agent-id=repair"},
                     {"external_provider": {"name": "Example", "reason": "outage"}}]:
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                MODULE.decision(self.occurrence(**kind))

    def test_canonical_instructions_and_tools_are_wired(self):
        deploy = (ROOT / ".claude/commands/deploy.md").read_text()
        policy = (ROOT / ".claude/shared/deploy-failure-policy.md").read_text()
        self.assertIn("rose-agent-spawn: false", deploy)
        self.assertIn("Controlling failure policy", deploy)
        self.assertNotIn("report and retry every 10 minutes", deploy)
        self.assertNotIn("spawn ONE `general-purpose` agent", deploy)
        for name in ["CLAUDE.md", ".claude/commands/rca.md", ".claude/commands/push.md", "docs/testing.md", "docs/root-cause-analysis.md", ".claude/shared/report-display-format.md"]:
            self.assertIn("deploy-failure-policy.md", (ROOT / name).read_text(), name)
        for value in ["1ec468d5-95dc-4754-a385-1c9abe784cd4", "18cb4c74-55f4-4f2e-a432-c5e7c7604f15", "no acknowledgement", "UNKNOWN", "INTRODUCED"]:
            self.assertIn(value, policy)
        self.assertIn("Active backend: boxes.dev", policy)
        self.assertIn("ROSE_ACCOUNT_AGENTS_ENABLED=true", policy)
        commands = (ROOT / "back-end/src/assets/rose-skills/agent-graph/SKILL.md").read_text()
        self.assertIn("does not authorize independent spawning", commands)


if __name__ == "__main__": unittest.main()
