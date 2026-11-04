#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deploy_timeline import account, event_intervals
from record_factory_event import factory_event_payload, validate_event


def interval(a, b, kind, reason="fixture"):
    return {"start": a, "end": b, "kind": kind, "reason": reason, "evidence": "native fixture receipt"}


class Timeline(unittest.TestCase):
    def test_gaps_only_count_as_unrecorded_waits(self):
        result = account(0, 10, [interval(2, 6, "active_work")])
        self.assertEqual(result["seconds"], {"active_work": 4, "automation": 0, "external_wait": 6})
        self.assertEqual(result["unrecorded_wait_seconds"], 6)
        self.assertFalse(result["segments"][0]["wait_reason_recorded"])

    def test_parallel_wait_does_not_double_count_or_hide_work(self):
        result = account(0, 10, [interval(0, 8, "external_wait", "credits"), interval(2, 6, "active_work")])
        self.assertEqual(result["seconds"], {"active_work": 4, "automation": 0, "external_wait": 6})
        self.assertEqual(len(result["recorded_intervals"]), 2)
        self.assertEqual(sum(result["seconds"].values()), 10)

    def test_running_tests_are_separate_from_agent_effort(self):
        result = account(0, 10, [interval(-5, 20, "automation")])
        self.assertEqual(result["seconds"]["automation"], 10)
        self.assertEqual(result["seconds"]["active_work"], 0)

    def test_invalid_or_unsubstantiated_work_refuses(self):
        for row in [interval(5, 2, "active_work"), interval(0, float("nan"), "active_work"),
                    interval(0, 5, "fixes-other"), {**interval(0, 5, "active_work"), "evidence": None}]:
            with self.assertRaises(ValueError):
                account(0, 10, [row])

    def test_native_pair_keeps_scope_and_unmatched_records_unknown(self):
        def event(name, epoch, run="one"):
            return {"workflow": "deploy", "run_id": run, "event": name, "value": "user",
                    "recorded_epoch": epoch, "detail": {"request_id": "question-1", "reason": "awaiting reply"}}
        rows, gaps = event_intervals([event("wait-start", 1), event("wait-finish", 3, "another"), event("wait-finish", 5)])
        self.assertEqual([(r["start"], r["end"]) for r in rows], [(1, 5)])
        self.assertEqual(len(gaps), 1)
        self.assertEqual(event_intervals([event("wait-start", 1)])[0], [])

    def test_native_activity_types_supported_for_every_workflow(self):
        for workflow in ("deploy", "rca", "descend", "update-prompts"):
            for event, value in (("work-start", "implementation"), ("work-finish", "implementation"),
                                 ("wait-start", "credits"), ("wait-finish", "credits")):
                validate_event(workflow, event, value)

    def test_native_activity_refuses_unidentified_reasonless_events(self):
        with self.assertRaisesRegex(ValueError, "request_id and reason"):
            factory_event_payload("deploy", "wait-start", "user")


if __name__ == "__main__":
    unittest.main()
