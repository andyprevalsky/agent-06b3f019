"""Blackbox tests for monitor domain."""

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
        "api.parallel.ai/v1alpha/monitors": {
            "status": 200,
            "json": {
                "monitor_id": "monitor_abc123",
                "status": "active",
            },
        },
    })


async def test_monitor_happy_path():
    """monitor_activity creates a monitor and returns monitor_id."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.monitor import monitor_activity

        result = await monitor_activity(
            query="AI startup funding rounds",
            cadence="daily",
        )

    assert result["monitor_id"] == "monitor_abc123"
    assert result["status"] == {"status": "active"}


async def test_monitor_boundary():
    """Verify exact HTTP request sent to Parallel AI Monitor API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.monitor import monitor_activity

        await monitor_activity(
            query="New climate tech patents",
            cadence="weekly",
            webhook_url="https://hooks.example.com/monitor",
            metadata={"tag": "climate"},
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1alpha/monitors",
        method="POST",
        body_contains={"query": "New climate tech patents", "cadence": "weekly"},
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["webhook"] == "https://hooks.example.com/monitor"
    assert body["metadata"] == {"tag": "climate"}


async def test_monitor_minimal_params():
    """monitor_activity works with only required params."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.monitor import monitor_activity

        result = await monitor_activity(query="Test query")

    assert result["monitor_id"] == "monitor_abc123"
    call = assert_captured_call(
        url_contains="api.parallel.ai/v1alpha/monitors",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["query"] == "Test query"
    assert body["cadence"] == "daily"


async def run_all_tests():
    print("monitor blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_monitor_happy_path)
    await r.record_async("boundary", test_monitor_boundary)
    await r.record_async("minimal_params", test_monitor_minimal_params)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
