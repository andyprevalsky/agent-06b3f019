"""Offline evidence contracts for the capability proof's three-query gate."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "verify_successful_llm_queries", ROOT / "scripts/verify_successful_llm_queries.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ROOT_AGENT = "11111111-1111-4111-8111-111111111111"
RUN_ID = "22222222-2222-4222-8222-222222222222"


def fixture():
    events = []
    for index in range(3):
        common = {
            "span_id": f"read-{index}",
            "parent_span_id": f"call-{index}",
            "agent_id": ROOT_AGENT,
            "request_id": f"request-{index}",
            "actual_model": "model-a",
            "attempt": 1,
        }
        events.extend(
            [
                {**common, "event": "span.start", "span_name": "llm.provider_read",
                 "timestamp": f"2026-09-29T00:00:{index * 10:02d}Z"},
                {**common, "event": "span.end", "span_name": "llm.provider_read",
                 "status": "ok", "timestamp": f"2026-09-29T00:00:{index * 10 + 2:02d}Z"},
                {"event": "llm.cache", "span_id": f"call-{index}",
                 "agent_id": ROOT_AGENT, "actual_model": "model-a",
                 "timestamp": f"2026-09-29T00:00:{index * 10 + 1:02d}Z",
                 "completion_tokens": 8, "finish": "stop"},
            ]
        )
    return {
        "run_id": RUN_ID,
        "timestamp": "2026-09-29T00:00:00Z",
        "tasks": [{
            "name": "example-task", "agent_id": ROOT_AGENT,
            "duration_seconds": 45,
            "logs": {"tree": {ROOT_AGENT: {"parent_agent_id": None}},
                     "worker_logs": [json.dumps(event) for event in events]},
        }],
    }


class QueryEvidenceTest(unittest.TestCase):
    def test_three_completed_queries_pass_and_duplicate_lines_do_not_inflate(self):
        payload = fixture()
        payload["tasks"][0]["logs"]["worker_logs"].extend(
            payload["tasks"][0]["logs"]["worker_logs"][:]
        )
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 3)
        self.assertEqual(result["status"], "passed")

    def test_failed_or_foreign_provider_read_cannot_prove_third_query(self):
        payload = fixture()
        lines = payload["tasks"][0]["logs"]["worker_logs"]
        events = [json.loads(line) for line in lines]
        for event in events:
            if event.get("span_id") == "read-2" and event["event"] == "span.end":
                event["status"] = "error"
        foreign = dict(events[6], agent_id="33333333-3333-4333-8333-333333333333")
        events.append(foreign)
        payload["tasks"][0]["logs"]["worker_logs"] = [json.dumps(event) for event in events]
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 2)
        self.assertEqual(result["status"], "failed")

    def test_missing_task_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.assertEqual(module.main([str(base), str(base / "report.json"),
                                          "--expected-count", "1"]), 70)
            self.assertFalse((base / "report.json").exists())


if __name__ == "__main__":
    unittest.main()
