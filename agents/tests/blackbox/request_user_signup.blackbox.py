"""Blackbox tests for request-user-signup domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_emits_in_progress_with_signup_metadata():
    """execute_tool yields an IN_PROGRESS event with signup metadata."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus

    manager = RequestUserSignupManager()

    # Collect only the first event (before the blocking wait_condition)
    events = []
    gen = manager.execute_tool(
        workflow_instance=None,  # Will fail at wait_condition, but first yield is before that
        tool_call={"reason": "Need account to send email"},
        tool_call_id="tc-1",
    )
    # Get the first yielded event (before any blocking)
    event = await gen.__anext__()
    events.append(event)

    assert event.status == MessageStatus.IN_PROGRESS
    assert event.metadata["requestUserSignup"]["isWaitingForUser"] is True
    assert event.metadata["requestUserSignup"]["attentionKind"] == "signup"
    assert event.metadata["isUserAttentionMessage"] is True
    assert "Need account to send email" in event.message


async def test_default_reason():
    """Default reason is used when none provided."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus

    manager = RequestUserSignupManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={},
        tool_call_id="tc-2",
    )
    event = await gen.__anext__()

    assert event.status == MessageStatus.IN_PROGRESS
    assert "requires a signed-in account" in event.message


async def test_no_outbound_http_calls():
    """request_user_signup makes zero outbound HTTP calls."""
    from tools.request_user_signup import RequestUserSignupManager

    manager = RequestUserSignupManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"reason": "Test"},
        tool_call_id="tc-3",
    )
    await gen.__anext__()

    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("request-user-signup blackbox tests:")
    r = BlackboxResult()
    await r.record_async("emits_in_progress_with_signup_metadata", test_emits_in_progress_with_signup_metadata)
    await r.record_async("default_reason", test_default_reason)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
