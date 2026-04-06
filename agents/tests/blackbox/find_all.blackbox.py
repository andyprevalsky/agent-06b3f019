"""Blackbox tests for find-all domain."""

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


async def test_ingest_happy_path():
    """find_all_ingest_activity returns entity_type and match_conditions."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/ingest": {
            "status": 200,
            "json": {
                "entity_type": "companies",
                "match_conditions": [{"field": "industry", "op": "eq", "value": "AI"}],
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_ingest_activity

        result = await find_all_ingest_activity("Find all AI startups in San Francisco")

    assert result["entity_type"] == "companies"
    assert len(result["match_conditions"]) == 1


async def test_ingest_boundary():
    """Verify exact HTTP request sent to FindAll ingest endpoint."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/ingest": {
            "status": 200,
            "json": {"entity_type": "people", "match_conditions": []},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_ingest_activity

        await find_all_ingest_activity("Find all data scientists at Google")

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/ingest",
        method="POST",
        body_contains={"objective": "Find all data scientists at Google"},
        header_present="x-api-key",
    )
    # Verify beta header
    headers = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "parallel-beta" in headers


async def test_create_run_boundary():
    """Verify create run POST sends correct params."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/runs": {
            "status": 200,
            "json": {"findall_id": "fa-run-001"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_create_run_activity

        result = await find_all_create_run_activity(
            objective="Find all AI startups",
            entity_type="companies",
            match_conditions=[{"field": "industry", "op": "eq", "value": "AI"}],
            generator="core",
            match_limit=25,
        )

    assert result["findall_id"] == "fa-run-001"

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/runs",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["generator"] == "core"
    assert body["match_limit"] == 25
    assert body["entity_type"] == "companies"


async def test_poll_status_boundary():
    """Verify poll status GET hits correct URL."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/runs/fa-poll-test": {
            "status": 200,
            "json": {
                "status": {
                    "status": "completed",
                    "is_active": False,
                    "metrics": {
                        "generated_candidates_count": 100,
                        "matched_candidates_count": 12,
                    },
                }
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_poll_status_once_activity

        result = await find_all_poll_status_once_activity("fa-poll-test")

    assert result["is_completed"] is True
    assert result["generated_candidates_count"] == 100
    assert result["matched_candidates_count"] == 12

    assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/runs/fa-poll-test",
        method="GET",
        header_present="x-api-key",
    )


async def test_get_results_boundary():
    """Verify get results GET hits correct URL."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/runs/fa-res-test/result": {
            "status": 200,
            "json": {
                "candidates": [
                    {"name": "Startup A", "score": 0.95},
                    {"name": "Startup B", "score": 0.87},
                ],
                "usage": {"credits": 5},
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_get_results_activity

        result = await find_all_get_results_activity("fa-res-test")

    assert len(result["candidates"]) == 2
    assert result["candidates"][0]["name"] == "Startup A"

    assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/runs/fa-res-test/result",
        method="GET",
        header_present="x-api-key",
    )


async def run_all_tests():
    print("find-all blackbox tests:")
    r = BlackboxResult()
    await r.record_async("ingest_happy_path", test_ingest_happy_path)
    await r.record_async("ingest_boundary", test_ingest_boundary)
    await r.record_async("create_run_boundary", test_create_run_boundary)
    await r.record_async("poll_status_boundary", test_poll_status_boundary)
    await r.record_async("get_results_boundary", test_get_results_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
