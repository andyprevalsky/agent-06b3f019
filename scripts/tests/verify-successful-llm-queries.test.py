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
SECOND_AGENT = "33333333-3333-4333-8333-333333333333"
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
                {
                    **common,
                    "event": "span.start",
                    "span_name": "llm.provider_read",
                    "timestamp": f"2026-09-29T00:00:{index * 10:02d}Z",
                },
                {
                    **common,
                    "event": "span.end",
                    "span_name": "llm.provider_read",
                    "status": "ok",
                    "timestamp": f"2026-09-29T00:00:{index * 10 + 2:02d}Z",
                },
                {
                    "event": "llm.cache",
                    "span_id": f"call-{index}",
                    "agent_id": ROOT_AGENT,
                    "actual_model": "model-a",
                    "timestamp": f"2026-09-29T00:00:{index * 10 + 1:02d}Z",
                    "completion_tokens": 8,
                    "finish": "stop",
                },
            ]
        )
    return {
        "run_id": RUN_ID,
        "timestamp": "2026-09-29T00:00:00Z",
        "tasks": [
            {
                "name": "example-task",
                "agent_id": ROOT_AGENT,
                "duration_seconds": 45,
                "logs": {
                    "tree": {ROOT_AGENT: {"parent_agent_id": None}},
                    "worker_logs": [json.dumps(event) for event in events],
                },
            }
        ],
    }


def rose_fixture():
    payload = fixture()
    events = []
    for index in range(3):
        common = {
            "agent_id": ROOT_AGENT,
            "request_id": f"request-{index}",
            "span_id": "shared-continuation-span",
        }
        for offset, event in (
            (0, "rose.complete.start"),
            (1, "rose.complete.first_productive_chunk"),
            (3, "rose.complete.waterfall.done"),
        ):
            events.append(
                {
                    **common,
                    "event": event,
                    "timestamp": f"2026-09-29T00:00:{index * 10 + offset:02d}Z",
                }
            )
        events.append(
            {
                "event": "llm.cache",
                "agent_id": ROOT_AGENT,
                "span_id": common["span_id"],
                "actual_model": "model-a",
                "timestamp": f"2026-09-29T00:00:{index * 10 + 2:02d}Z",
                "completion_tokens": 8,
                "finish": "stop",
            }
        )
    payload["tasks"][0]["logs"]["worker_logs"] = events
    return payload


class QueryEvidenceTest(unittest.TestCase):
    def test_three_completed_foundry_queries_use_the_same_live_evidence_contract(self):
        payload = rose_fixture()
        for event in payload["tasks"][0]["logs"]["worker_logs"]:
            if event["event"] == "rose.complete.waterfall.done":
                event["event"] = "rose.complete.foundry.done"
            elif event["event"] == "llm.cache":
                event["actual_model"] = "gpt-6-sol-foundry"
        result = module.verify(payload)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["successful_llm_queries"], 3)
        self.assertEqual(
            {row["request_id"] for row in result["queries"]},
            {"request-0", "request-1", "request-2"},
        )
        self.assertTrue(
            all(
                row["route_done_event"] == "rose.complete.foundry.done"
                and row["evidence_kind"] == "rose_live_completion"
                for row in result["queries"]
            )
        )

    def test_three_live_rose_continuations_pass_without_provider_read_spans(self):
        payload = rose_fixture()
        lines = payload["tasks"][0]["logs"]["worker_logs"]
        lines.extend([json.dumps(event) for event in lines[:]])
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 3)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(
            {row["request_id"] for row in result["queries"]},
            {"request-0", "request-1", "request-2"},
        )
        self.assertTrue(
            all(
                row["evidence_kind"] == "rose_live_completion"
                for row in result["queries"]
            )
        )

    def test_incomplete_or_conflicting_rose_completion_cannot_prove_third_query(self):
        for defect in (
            "start",
            "productive",
            "done",
            "conflicting_done",
            "conflicting_usage",
            "truncated_finish",
        ):
            with self.subTest(defect=defect):
                payload = rose_fixture()
                lines = payload["tasks"][0]["logs"]["worker_logs"]
                if defect in ("start", "productive", "done"):
                    kind = {
                        "start": "rose.complete.start",
                        "productive": "rose.complete.first_productive_chunk",
                        "done": "rose.complete.waterfall.done",
                    }[defect]
                    lines[:] = [
                        event
                        for event in lines
                        if not (
                            event.get("request_id") == "request-2"
                            and event["event"] == kind
                        )
                    ]
                elif defect == "conflicting_done":
                    closing = next(
                        event
                        for event in lines
                        if event.get("request_id") == "request-2"
                        and event["event"] == "rose.complete.waterfall.done"
                    )
                    lines.append({**closing, "timestamp": "2026-09-29T00:00:24Z"})
                else:
                    usage = next(
                        event
                        for event in lines
                        if event["event"] == "llm.cache"
                        and event["timestamp"] == "2026-09-29T00:00:22Z"
                    )
                    if defect == "conflicting_usage":
                        lines.append({**usage, "completion_tokens": 0})
                    else:
                        usage["finish"] = "length"
                result = module.verify(payload)
                self.assertEqual(result["successful_llm_queries"], 2)
                self.assertEqual(result["status"], "failed")

    def test_cache_usage_without_live_rose_lifecycle_cannot_prove_queries(self):
        payload = rose_fixture()
        logs = payload["tasks"][0]["logs"]
        logs["worker_logs"] = [
            event for event in logs["worker_logs"] if event["event"] == "llm.cache"
        ]
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 0)
        self.assertEqual(result["status"], "failed")

    def test_terminal_model_failure_invalidates_three_successes(self):
        payload = fixture()
        task = payload["tasks"][0]
        task["benchmark_status"] = "FAILED"
        common = {
            "agent_id": ROOT_AGENT,
            "request_id": "stalled-request",
            "span_id": "stalled-call",
        }
        events = [
            {
                **common,
                "event": "rose.complete.start",
                "timestamp": "2026-09-29T00:00:30Z",
            },
            {
                **common,
                "event": "rose.complete.first_productive_chunk",
                "timestamp": "2026-09-29T00:00:31Z",
            },
            {
                **common,
                "event": "rose.complete.failed",
                "timestamp": "2026-09-29T00:00:40Z",
                "error_type": "RoseDeadlineError",
                "active_route": "waterfall",
            },
        ]
        task["logs"]["worker_logs"].extend(json.dumps(event) for event in events)
        # Duplicate collected views must not create more failed requests.
        task["logs"]["worker_logs"].append(json.dumps(events[-1]))
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 3)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(result["failed_queries"]), 1)
        self.assertEqual(result["failed_queries"][0]["request_id"], "stalled-request")
        self.assertEqual(task["benchmark_status"], "FAILED")
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            task_dir = base / "example-task"
            task_dir.mkdir()
            original = json.dumps(payload)
            (task_dir / "cloudbench-run.json").write_text(original)
            report = base / "report.json"
            self.assertEqual(
                module.main([str(base), str(report), "--expected-count", "1"]), 70
            )
            self.assertEqual(json.loads(report.read_text())["status"], "failed")
            self.assertEqual((task_dir / "cloudbench-run.json").read_text(), original)

    def test_cleanup_and_foreign_failures_do_not_change_execution_verdict(self):
        payload = fixture()
        common = {
            "event": "rose.complete.failed",
            "agent_id": ROOT_AGENT,
            "request_id": "outside",
            "span_id": "outside-call",
            "error_type": "RoseDeadlineError",
        }
        payload["tasks"][0]["logs"]["worker_logs"].extend(
            [
                json.dumps({**common, "timestamp": "2026-09-29T00:00:46Z"}),
                json.dumps(
                    {
                        **common,
                        "agent_id": SECOND_AGENT,
                        "timestamp": "2026-09-29T00:00:40Z",
                    }
                ),
            ]
        )
        result = module.verify(payload)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["failed_queries"], [])

    def test_owned_child_failure_invalidates_three_root_successes(self):
        payload = fixture()
        logs = payload["tasks"][0]["logs"]
        logs["tree"][SECOND_AGENT] = {"parent_agent_id": ROOT_AGENT}
        logs["worker_logs"].append(
            json.dumps(
                {
                    "event": "rose.complete.failed",
                    "agent_id": SECOND_AGENT,
                    "root_agent_id": ROOT_AGENT,
                    "request_id": "child-stall",
                    "span_id": "child-call",
                    "timestamp": "2026-09-29T00:00:40Z",
                    "error_type": "RoseDeadlineError",
                }
            )
        )
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 3)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failed_queries"][0]["agent_id"], SECOND_AGENT)

    def test_recovered_primary_rejection_does_not_invalidate_live_completion(self):
        payload = fixture()
        payload["tasks"][0]["logs"]["worker_logs"].append(
            json.dumps(
                {
                    "event": "rose.transport.cerebras.error",
                    "status": 429,
                    "agent_id": ROOT_AGENT,
                    "request_id": "request-0",
                    "span_id": "call-0",
                    "timestamp": "2026-09-29T00:00:00Z",
                }
            )
        )
        result = module.verify(payload)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["failed_queries"], [])

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
        payload["tasks"][0]["logs"]["worker_logs"] = [
            json.dumps(event) for event in events
        ]
        result = module.verify(payload)
        self.assertEqual(result["successful_llm_queries"], 2)
        self.assertEqual(result["status"], "failed")

    def test_missing_task_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.assertEqual(
                module.main(
                    [str(base), str(base / "report.json"), "--expected-count", "1"]
                ),
                70,
            )
            self.assertFalse((base / "report.json").exists())

    def test_composite_benchmark_counts_each_sealed_root_once(self):
        payload = fixture()
        task = payload["tasks"][0]
        original = [json.loads(line) for line in task["logs"]["worker_logs"]]
        gate = [
            event
            for event in original
            if event.get("request_id") in ("request-0", "request-1")
            or event.get("span_id") in ("call-0", "call-1")
        ]
        post = [
            dict(event, agent_id=SECOND_AGENT)
            for event in original
            if event.get("request_id") == "request-2"
            or event.get("span_id") == "call-2"
        ]
        task["agent_id"] = f"{ROOT_AGENT},{SECOND_AGENT}"
        task["logs"] = {
            "gate": {"worker_logs": [json.dumps(event) for event in gate]},
            "post": {"worker_logs": [json.dumps(event) for event in post]},
            "worker_logs": [json.dumps(event) for event in original],
        }
        self.assertEqual(module.verify(payload)["successful_llm_queries"], 3)
        task["logs"]["post"]["worker_logs"] = []
        with self.assertRaises(AssertionError):
            module.verify(payload)


if __name__ == "__main__":
    unittest.main()
