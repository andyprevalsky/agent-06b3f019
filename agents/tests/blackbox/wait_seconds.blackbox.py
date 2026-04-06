"""Blackbox tests for wait-seconds domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_emits_wait_event():
    """WaitSecondsManager yields an event with the wait duration."""
    from tools.wait_seconds import WaitSecondsManager
    from tools.base import MessageStatus

    manager = WaitSecondsManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"seconds": 30},
        tool_call_id="tc-1",
    )
    event = await gen.__anext__()

    assert event.status in (MessageStatus.IN_PROGRESS, MessageStatus.FINISHED)


async def test_no_outbound_http_calls():
    """wait_seconds makes zero outbound HTTP calls."""
    from tools.wait_seconds import WaitSecondsManager

    manager = WaitSecondsManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"seconds": 5},
        tool_call_id="tc-2",
    )
    event = await gen.__anext__()

    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("wait-seconds blackbox tests:")
    r = BlackboxResult()
    await r.record_async("emits_wait_event", test_emits_wait_event)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
