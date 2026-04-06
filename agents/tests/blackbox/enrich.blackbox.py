"""Blackbox tests for enrich domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "api.parallel.ai/v1/tasks/runs": {
            "status": 200,
            "json": {"run_id": "run-enrich-001"},
        },
    })


async def test_create_task_happy_path():
    """enrich_create_task_activity returns run_id from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_create_task_activity

        result = await enrich_create_task_activity(
            input_data={"name": "Elon Musk", "company": "SpaceX"},
            output_schema={"type": "object", "properties": {"bio": {"type": "string"}}},
            processor="lite",
        )

    assert result["run_id"] == "run-enrich-001"


async def test_create_task_boundary():
    """Verify exact HTTP request sent to Parallel AI Task API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_create_task_activity

        await enrich_create_task_activity(
            input_data={"name": "Ada Lovelace"},
            output_schema={"type": "object"},
            processor="core",
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1/tasks/runs",
        method="POST",
        body_contains={"processor": "core"},
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["input"]["name"] == "Ada Lovelace"
    assert "task_spec" in body
    assert "output_schema" in body["task_spec"]


async def test_poll_status_boundary():
    """Verify poll status GET request to Parallel AI."""
    setup_mock({
        "api.parallel.ai/v1/tasks/runs/run-poll-test": {
            "status": 200,
            "json": {
                "status": "completed",
                "is_active": False,
                "warnings": None,
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_poll_status_once_activity

        result = await enrich_poll_status_once_activity("run-poll-test")

    assert result["is_completed"] is True
    assert result["is_failed"] is False

    assert_captured_call(
        url_contains="api.parallel.ai/v1/tasks/runs/run-poll-test",
        method="GET",
        header_present="x-api-key",
    )


async def test_get_results_boundary():
    """Verify get results GET request to Parallel AI."""
    setup_mock({
        "api.parallel.ai/v1/tasks/runs/run-results-test/result": {
            "status": 200,
            "json": {
                "output": {"bio": "Computer scientist and mathematician."},
                "run": {"run_id": "run-results-test", "status": "completed"},
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_get_task_results_activity

        result = await enrich_get_task_results_activity("run-results-test")

    assert result["output"]["bio"] == "Computer scientist and mathematician."
    assert result["run"]["run_id"] == "run-results-test"

    assert_captured_call(
        url_contains="api.parallel.ai/v1/tasks/runs/run-results-test/result",
        method="GET",
        header_present="x-api-key",
    )


async def run_all_tests():
    print("enrich blackbox tests:")
    r = BlackboxResult()
    await r.record_async("create_task_happy_path", test_create_task_happy_path)
    await r.record_async("create_task_boundary", test_create_task_boundary)
    await r.record_async("poll_status_boundary", test_poll_status_boundary)
    await r.record_async("get_results_boundary", test_get_results_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
