"""Blackbox tests for handle_tool_event domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


async def test_post_message_event():
    """handle_tool_event routes POST_MESSAGE to execute_activity with post_agent_message."""
    from tools.base import ToolEvent, EventType, MessageStatus
    from helpers.handle_tool_event import handle_tool_event

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({
            "activity": activity_fn.__name__,
            "args": args,
        })

    event = ToolEvent(
        type=EventType.POST_MESSAGE,
        message="Task started",
        title="web_search",
        status=MessageStatus.IN_PROGRESS,
    )

    await handle_tool_event(
        event=event,
        agent_id="agent-123",
        tool_call_id="tc-456",
        tool_name="web_search",
        execute_activity=mock_execute_activity,
    )

    assert len(calls) == 1
    assert calls[0]["activity"] == "post_agent_message"
    # args: [agent_id, message, role, metadata, file_pointer]
    assert calls[0]["args"][0] == "agent-123"
    assert calls[0]["args"][1] == "Task started"
    assert calls[0]["args"][2] == "TOOL"
    metadata = calls[0]["args"][3]
    assert metadata["toolCallId"] == "tc-456"
    assert metadata["toolName"] == "web_search"
    assert metadata["toolStatus"] == "IN_PROGRESS"


async def test_assistant_event():
    """handle_tool_event routes AssistantEvent to execute_activity with role=ASSISTANT."""
    from tools.base import AssistantEvent
    from helpers.handle_tool_event import handle_tool_event

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({
            "activity": activity_fn.__name__,
            "args": args,
        })

    event = AssistantEvent(message="Here is the result", file_pointer=None)

    await handle_tool_event(
        event=event,
        agent_id="agent-789",
        tool_call_id="tc-000",
        tool_name="web_search",
        execute_activity=mock_execute_activity,
    )

    assert len(calls) == 1
    assert calls[0]["activity"] == "post_agent_message"
    # args: [agent_id, message, role, metadata, file_pointer]
    assert calls[0]["args"][0] == "agent-789"
    assert calls[0]["args"][1] == "Here is the result"
    assert calls[0]["args"][2] == "ASSISTANT"
    assert calls[0]["args"][3] is None  # no metadata for assistant events
    assert calls[0]["args"][4] is None  # no file_pointer


async def test_output_attachment_is_tagged_as_artifact():
    from tools.base import AssistantEvent
    from helpers.handle_tool_event import handle_tool_event

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append(args)

    pointer = {"mime_type": "image/png", "storage_path": "child/screenshot.png"}
    await handle_tool_event(
        event=AssistantEvent(message="", file_pointer=pointer),
        agent_id="parent-1",
        tool_call_id="spawn-child-1",
        tool_name="spawn_browser_agent",
        execute_activity=mock_execute_activity,
    )
    assert calls[0][2] == "ASSISTANT"
    assert calls[0][3] == {"artifactOnly": True, "sourceToolCallId": "spawn-child-1"}
    assert calls[0][4] == pointer


async def test_no_outbound_http():
    """handle_tool_event makes zero outbound HTTP calls for POST_MESSAGE events."""
    from tools.base import ToolEvent, EventType, MessageStatus
    from helpers.handle_tool_event import handle_tool_event

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        pass

    event = ToolEvent(
        type=EventType.POST_MESSAGE,
        message="Hello",
        status=MessageStatus.FINISHED,
    )

    await handle_tool_event(
        event=event,
        agent_id="agent-test",
        tool_call_id="tc-test",
        tool_name="test_tool",
        execute_activity=mock_execute_activity,
    )

    captures = get_captured_requests()
    assert len(captures) == 0, f"Expected 0 HTTP calls, got {len(captures)}"


async def run_all_tests():
    print("handle-tool-event blackbox tests:")
    r = BlackboxResult()
    await r.record_async("post_message_event", test_post_message_event)
    await r.record_async("assistant_event", test_assistant_event)
    await r.record_async("output_attachment_is_tagged_as_artifact", test_output_attachment_is_tagged_as_artifact)
    await r.record_async("no_outbound_http", test_no_outbound_http)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
