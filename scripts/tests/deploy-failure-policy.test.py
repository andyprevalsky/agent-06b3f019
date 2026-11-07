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

    def test_execution_recovery_is_recorded_and_rendered_without_a_waiver(self):
        entry = self.occurrence(attribution="NOT_INTRODUCED", native_result="UNVERIFIED",
            repair_agent="https://boxes.dev/thread/thr_owned_repair", execute_unverified=True)
        self.assertEqual("execution required", MODULE.decision(entry))
        with tempfile.TemporaryDirectory() as directory:
            report = MODULE.record(Path(directory)/"report.json", entry)
            self.assertEqual("execution required", report["failures"][0]["disposition"])
            for prefix in ("", "Existing scorecard"):
                text = MODULE.render(report, prefix)
                self.assertIn("EXECUTION REQUIRED", text)
                self.assertIn("UNVERIFIED", text)
                self.assertIn(entry["evidence"], text)
                self.assertNotIn("DELEGATED", text)
                self.assertNotIn("waived", text)
                self.assertNotIn("PASS", text)

    def test_execution_recovery_cannot_override_waiver_authority(self):
        original = self.occurrence(attribution="NOT_INTRODUCED", native_result="UNVERIFIED",
            repair_agent="https://boxes.dev/thread/thr_owned_repair", execute_unverified=True)
        for changes in ({"attribution":"UNKNOWN"}, {"attribution":"INTRODUCED"},
                        {"repair_agent":None}, {"native_result":"FAIL"},
                        {"execute_unverified":"true"},
                        {"external_provider":{"name":"provider","reason":"outage"}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                MODULE.decision({**original, **changes})

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
        for reason in ["outage", "credits exhausted", "credential or billing change"]:
            e = self.occurrence(attribution="NOT_INTRODUCED", external_provider={"name": "Example", "reason": reason})
            self.assertEqual(MODULE.decision(e), "external / waived")
            with self.assertRaises(ValueError): MODULE.decision({**e, "repair_agent": "https://www.roselabs.ai/?agent-id=x"})
            with self.assertRaises(ValueError): MODULE.decision({**e, "attribution": "INTRODUCED"})
            with self.assertRaises(ValueError): MODULE.decision({**e, "external_provider": {"name": "Example", "reason": "flaky"}})

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

    def packet(self):
        return {"test": "providers/kernel.blackbox.ts::live parity", "command": ["npm", "run", "test:coverage:sharded"],
                "scope": "blackbox:kernel", "error": "Error: upstream reset\n    at parity (kernel.blackbox.ts:88)",
                "source": "7be0644bb164763af1526ead7b426e2d5e909f4a", "evidence": ["coverage/shard-1.log:412"]}

    def pending_occurrence(self):
        packet = self.packet()
        return self.occurrence(attribution="NOT_INTRODUCED", native_result="FAIL / exit 1",
                               check=packet["test"], command=packet["command"],
                               source=packet["source"], post_merge=packet)

    def test_post_merge_packet_rejects_a_different_test_command_or_source(self):
        good = self.pending_occurrence()
        for field, value in [("test", "unrelated/test"), ("command", ["false"]),
                             ("source", "b" * 40), ("test", True),
                             ("command", True), ("source", True)]:
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "recorded failure"):
                MODULE.decision({**good, "post_merge": {**good["post_merge"], field: value}})

    def test_failed_not_introduced_packet_is_pending_post_merge_without_any_waiver(self):
        entry = self.pending_occurrence()
        self.assertEqual("pending post-merge", MODULE.decision(entry))
        with tempfile.TemporaryDirectory() as directory:
            report = MODULE.record(Path(directory) / "report.json", entry)
            self.assertEqual("pending post-merge", report["failures"][0]["disposition"])
            text = MODULE.render(report)
            self.assertIn("PENDING POST-MERGE", text); self.assertIn("kernel.blackbox.ts::live parity", text)
            self.assertIn("upstream reset", text); self.assertIn("coverage/shard-1.log:412", text)
            for forbidden in ("DELEGATED", "waived", "PASS", "Repair:"):
                self.assertNotIn(forbidden, text)
            # the transition to delegated requires a real post-merge repair link
            with self.assertRaisesRegex(ValueError, "repair link"):
                MODULE.resolve_post_merge(Path(directory) / "report.json", "failure-1", "")
            resolved = MODULE.resolve_post_merge(Path(directory) / "report.json", "failure-1",
                                                 "https://boxes.dev/thread/thr_post_merge_repair")
            self.assertEqual("delegated / waived", resolved["failures"][0]["disposition"])
            self.assertEqual(self.packet(), resolved["failures"][0]["resolved_post_merge"])
            self.assertIn("DELEGATED", MODULE.render(resolved)); self.assertNotIn("PENDING", MODULE.render(resolved))

    def test_pending_post_merge_is_refused_for_incomplete_packets_links_or_nonfailed_results(self):
        good = self.pending_occurrence()
        for field in MODULE.PACKET_FIELDS:
            with self.subTest(missing=field):
                with self.assertRaisesRegex(ValueError, "packet requires"):
                    MODULE.decision({**good, "post_merge": {k: v for k, v in self.packet().items() if k != field}})
        for result in ("UNVERIFIED", "UNKNOWN"):
            with self.subTest(native_result=result), self.assertRaisesRegex(ValueError, "actually ran and failed"):
                MODULE.decision({**good, "native_result": result})
        for attribution in ("INTRODUCED", "UNKNOWN"):
            with self.subTest(attribution=attribution), self.assertRaisesRegex(ValueError, "stay blocking"):
                MODULE.decision({**good, "attribution": attribution})
        with self.assertRaisesRegex(ValueError, "cannot carry"):
            MODULE.decision({**good, "repair_agent": "https://boxes.dev/thread/thr_x"})
        with self.assertRaisesRegex(ValueError, "cannot carry"):
            MODULE.decision({**good, "external_provider": {"name": "p", "reason": "outage"}})
        with self.assertRaisesRegex(ValueError, "cannot carry"):
            MODULE.decision({**good, "execute_unverified": True})

    def test_canonical_instructions_and_tools_are_wired(self):
        deploy = (ROOT / ".claude/commands/deploy.md").read_text()
        policy = (ROOT / ".claude/shared/deploy-failure-policy.md").read_text()
        self.assertIn("rose-agent-spawn: false", deploy)
        self.assertIn("deploy-failure-policy.md", deploy)
        triage = deploy.split("## When a gate fails: triage and parallelize", 1)[1].split("\n## ", 1)[0]
        self.assertIn("Details: `.claude/shared/deploy-failure-policy.md`", triage)
        for rule in [
            "`Gate: INTRODUCED` or `Gate: NOT_INTRODUCED`",
            "UNKNOWN: blocking until attributed",
            "An assigned repair (the failure your `/goal` targets) stays yours whatever the attribution says",
            "Provider outage or exhausted credits with evidence: external exception, no handoff",
            "new devbox in the Bugs folder at high effort and standard speed",
        ]:
            self.assertIn(rule, triage)
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
