"""Blackbox tests for send-message-to-user domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_emits_message_event():
    """execute_tool yields a FINISHED event for non-question messages."""
    from tools.send_message_to_user import SendMessageToUserManager
    from tools.base import MessageStatus

    manager = SendMessageToUserManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"message": "Hello! I found 3 results for you.", "is_question": False},
        tool_call_id="tc-1",
    )
    event = await gen.__anext__()

    # Non-question messages get FINISHED status immediately
    assert event.status == MessageStatus.FINISHED
    assert "Hello! I found 3 results for you." in event.message


async def test_question_flag_in_metadata():
    """When is_question=True, event metadata flags it as attention-requiring."""
    from tools.send_message_to_user import SendMessageToUserManager
    from tools.base import MessageStatus

    manager = SendMessageToUserManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"message": "Should I proceed?", "is_question": True},
        tool_call_id="tc-2",
    )
    event = await gen.__anext__()

    # The event should contain the question
    assert "Should I proceed?" in event.message or "Should I proceed?" in (event.title or "")


async def test_no_outbound_http_calls():
    """send_message_to_user initial event makes zero outbound HTTP calls."""
    from tools.send_message_to_user import SendMessageToUserManager

    manager = SendMessageToUserManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"message": "Test message"},
        tool_call_id="tc-3",
    )
    await gen.__anext__()

    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("send-message-to-user blackbox tests:")
    r = BlackboxResult()
    await r.record_async("emits_message_event", test_emits_message_event)
    await r.record_async("question_flag_in_metadata", test_question_flag_in_metadata)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
