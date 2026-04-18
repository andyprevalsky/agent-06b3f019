"""Blackbox tests for check-monitor-events domain."""

import asyncio
from unittest.mock import patch, AsyncMock

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "api.parallel.ai/v1alpha/monitors/": {
            "status": 200,
            "json": {
                "events": [
                    {"id": "evt-1", "type": "price_change", "data": {"old": 100, "new": 95}},
                    {"id": "evt-2", "type": "stock_alert", "data": {"ticker": "AAPL"}},
                ]
            },
        }
    })


async def test_happy_path():
    """check_monitor_events_activity returns events from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.check_monitor_events import check_monitor_events_activity

        result = await check_monitor_events_activity("monitor_abc123", limit=5)

    assert "events" in result
    assert len(result["events"]) == 2
    assert result["events"][0]["id"] == "evt-1"


async def test_boundary_request_params():
    """Verify exact HTTP request sent to Parallel AI monitors API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.check_monitor_events import check_monitor_events_activity

        await check_monitor_events_activity("monitor_xyz789", limit=3)

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1alpha/monitors/monitor_xyz789/events",
        method="GET",
        header_present="x-api-key",
    )
    assert "limit=3" in call["url"]


async def test_invalid_monitor_id():
    """Manager returns error for monitor_id not starting with 'monitor_'."""
    _setup()
    from tools.check_monitor_events import CheckMonitorEventsManager

    manager = CheckMonitorEventsManager()
    mock_execute = AsyncMock()

    with patch("tools.check_monitor_events.handle_tool_event", new_callable=AsyncMock):
        result = await manager.execute_tool(
            execute_activity=mock_execute,
            tool_call={"monitor_id": "bad-id-123", "limit": 10},
            tool_call_id="tc-invalid",
            agent_id="agent-1",
            user_id="user-1",
        )

    assert "error" in result
    assert result["events"] == []
    # No activity call should be made for invalid ID
    mock_execute.assert_not_called()


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "kwargs": kwargs})
        if name == "check_monitor_events_activity":
            if raises:
                raise RuntimeError("parallel offline")
            return result or {"events": [{"id": "e-1"}]}
        return None
    return mock


async def test_manager_happy_path():
    """CheckMonitorEventsManager returns activity result on success."""
    from tools.check_monitor_events import CheckMonitorEventsManager

    calls = []
    manager = CheckMonitorEventsManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(calls, result={"events": [{"id": "e-1"}, {"id": "e-2"}]}),
        tool_call={"monitor_id": "monitor_ok_abc", "limit": 5},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["events"][0]["id"] == "e-1"
    assert len(out["events"]) == 2


async def test_manager_error_returns_error_dict():
    """On activity failure, manager returns {error, events=[]}, does not raise."""
    from tools.check_monitor_events import CheckMonitorEventsManager

    calls = []
    manager = CheckMonitorEventsManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(calls, raises=True),
        tool_call={"monitor_id": "monitor_xyz", "limit": 5},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "error" in out
    assert out["events"] == []


async def run_all_tests():
    print("check-monitor-events blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary_request_params", test_boundary_request_params)
    await r.record_async("invalid_monitor_id", test_invalid_monitor_id)
    await r.record_async("manager_happy_path", test_manager_happy_path)
    await r.record_async("manager_error_returns_error_dict", test_manager_error_returns_error_dict)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
