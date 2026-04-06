"""Blackbox tests for enable-write-permissions domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_missing_reason_yields_error():
    """execute_tool yields an error event when reason is missing."""
    from tools.enable_write_permissions import EnableWritePermissionsManager
    from tools.base import MessageStatus

    manager = EnableWritePermissionsManager()
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={"action_description": "Send an email"},
        tool_call_id="tc-1",
    ):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "reason" in events[0].message.lower()


async def test_missing_action_description_yields_error():
    """execute_tool yields an error event when action_description is missing."""
    from tools.enable_write_permissions import EnableWritePermissionsManager
    from tools.base import MessageStatus

    manager = EnableWritePermissionsManager()
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={"reason": "User asked to send"},
        tool_call_id="tc-2",
    ):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "action_description" in events[0].message.lower()


async def test_no_outbound_http_calls():
    """enable_write_permissions validation makes zero outbound HTTP calls."""
    from tools.enable_write_permissions import EnableWritePermissionsManager

    manager = EnableWritePermissionsManager()
    # Missing both params — should fail validation before any HTTP
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={},
        tool_call_id="tc-3",
    ):
        events.append(event)

    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("enable-write-permissions blackbox tests:")
    r = BlackboxResult()
    await r.record_async("missing_reason_yields_error", test_missing_reason_yields_error)
    await r.record_async("missing_action_description_yields_error", test_missing_action_description_yields_error)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
