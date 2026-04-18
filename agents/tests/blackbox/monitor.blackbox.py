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


# -------------------- service.py tests --------------------


def test_truncate_short():
    from domains.monitor.service import _truncate
    assert _truncate("abc", 10) == "abc"


def test_truncate_long():
    from domains.monitor.service import _truncate
    assert _truncate("abcdefghijkl", 8) == "abcde..."


async def test_execute_monitor_happy():
    from domains.monitor.service import execute_monitor

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "monitor_activity":
            return {"monitor_id": "m-1", "status": {"status": "active"}}
        return None

    async def fake_monitor_activity(query, cadence, webhook_url, metadata):
        return {"monitor_id": "m-1", "status": {"status": "active"}}
    fake_monitor_activity.__name__ = "monitor_activity"

    out = await execute_monitor(
        execute_activity=mock_execute_activity,
        monitor_activity=fake_monitor_activity,
        tool_call={"query": "AI news", "cadence": "daily"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"]["monitor_id"] == "m-1"
    assert out["usage"]["service"][0]["provider"] == "Parallel Monitor API"


async def test_execute_monitor_error():
    from domains.monitor.service import execute_monitor

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        if name == "monitor_activity":
            raise RuntimeError("API down")
        return None

    async def fake_monitor_activity(*a, **kw):
        return None
    fake_monitor_activity.__name__ = "monitor_activity"

    out = await execute_monitor(
        execute_activity=mock_execute_activity,
        monitor_activity=fake_monitor_activity,
        tool_call={"query": "q"},
        tool_call_id="tc-1",
        agent_id="a-1",
    )
    assert "error" in out["result"]
    assert "API down" in out["result"]["error"]
    assert out["usage"]["service"] == []


async def test_execute_monitor_long_query_truncated():
    from domains.monitor.service import execute_monitor

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "monitor_activity":
            return {"monitor_id": "m-2"}
        return None

    async def fake_monitor_activity(*a, **kw):
        return {"monitor_id": "m-2"}
    fake_monitor_activity.__name__ = "monitor_activity"

    out = await execute_monitor(
        execute_activity=mock_execute_activity,
        monitor_activity=fake_monitor_activity,
        tool_call={"query": "x" * 300},
        tool_call_id="tc-1",
        agent_id="a-1",
    )
    assert out["result"]["monitor_id"] == "m-2"


async def test_monitor_entry_point():
    """The top-level monitor() function delegates to execute_monitor."""
    from domains.monitor.handler import monitor

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "monitor_activity":
            return {"monitor_id": "m-3"}
        return None

    out = await monitor(
        execute_activity=mock_execute_activity,
        tool_call={"query": "q"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"]["monitor_id"] == "m-3"


async def run_all_tests():
    print("monitor blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_monitor_happy_path)
    await r.record_async("boundary", test_monitor_boundary)
    await r.record_async("minimal_params", test_monitor_minimal_params)
    r.record("truncate_short", test_truncate_short)
    r.record("truncate_long", test_truncate_long)
    await r.record_async("execute_monitor_happy", test_execute_monitor_happy)
    await r.record_async("execute_monitor_error", test_execute_monitor_error)
    await r.record_async("execute_monitor_long_query", test_execute_monitor_long_query_truncated)
    await r.record_async("monitor_entry_point", test_monitor_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
