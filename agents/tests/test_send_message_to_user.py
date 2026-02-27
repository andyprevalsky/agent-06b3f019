"""Tests for the lightweight send_message_to_user tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.send_message_to_user import SendMessageToUserManager, get_manager  # noqa: E402
from tools.base import EventType, MessageStatus  # noqa: E402


def _make_workflow_instance(depth=0, has_new_messages=False):
    """Create a mock workflow instance with required attributes."""
    wf = MagicMock()
    wf.user_id = "test-user-id"
    wf.agent_id = "test-agent-id"
    wf.depth = depth
    wf._has_new_messages = has_new_messages
    wf._post_message = AsyncMock()
    return wf


async def test_manager_singleton():
    """Ensure singleton manager works."""
    manager1 = get_manager()
    manager2 = get_manager()

    assert manager1 is manager2
    assert isinstance(manager1, SendMessageToUserManager)
    assert manager1.tool_name == "send_message_to_user"


async def test_execute_tool_question_blocks():
    """Blocking mode gets source, waits for response."""
    manager = get_manager()

    workflow_instance = _make_workflow_instance()
    tool_call_id = "test-123"

    async def simulate_wait(predicate, timeout=None):
        # Simulate user responding
        workflow_instance._has_new_messages = True

    with patch("tools.send_message_to_user.workflow") as mock_workflow:
        mock_workflow.execute_activity = AsyncMock(side_effect=[
            "WEB",                 # get_agent_source
        ])
        mock_workflow.wait_condition = AsyncMock(side_effect=simulate_wait)
        mock_workflow.unsafe = MagicMock()

        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "Need your approval on this plan."},
            tool_call_id,
        ):
            events.append(event)

    assert len(events) == 2
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[1].status == MessageStatus.FINISHED
    assert events[0].type == EventType.POST_MESSAGE
    assert events[1].type == EventType.POST_MESSAGE
    assert events[0].metadata["sendMessageToUser"]["isQuestion"] is True
    assert events[0].metadata["sendMessageToUser"]["isWaitingForUser"] is True
    assert events[1].metadata["sendMessageToUser"]["isWaitingForUser"] is False

    # get_agent_source only (WEB source, user responded within timeout — no SMS)
    assert mock_workflow.execute_activity.call_count == 1


async def test_execute_tool_question_sms_source():
    """SMS-source agents send SMS immediately via notify_sms_event_activity."""
    manager = get_manager()

    workflow_instance = _make_workflow_instance()
    tool_call_id = "test-sms"

    async def simulate_wait(predicate, timeout=None):
        workflow_instance._has_new_messages = True

    with patch("tools.send_message_to_user.workflow") as mock_workflow:
        mock_workflow.execute_activity = AsyncMock(side_effect=[
            "SMS",                 # get_agent_source → SMS source
            {"success": True},     # notify_sms_event_activity
        ])
        mock_workflow.wait_condition = AsyncMock(side_effect=simulate_wait)
        mock_workflow.unsafe = MagicMock()

        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "What color do you prefer?"},
            tool_call_id,
        ):
            events.append(event)

    assert len(events) == 2
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[1].status == MessageStatus.FINISHED

    # get_agent_source + notify_sms_event_activity
    assert mock_workflow.execute_activity.call_count == 2


async def test_execute_tool_info_mode():
    """Non-blocking mode should not wait for the user."""
    manager = get_manager()
    workflow_instance = _make_workflow_instance()

    with patch("tools.send_message_to_user.workflow") as mock_workflow:
        mock_workflow.execute_activity = AsyncMock()
        mock_workflow.wait_condition = AsyncMock()
        mock_workflow.unsafe = MagicMock()

        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "Plan: 1) Audit docs 2) Draft email", "is_question": False},
            "info-mode",
        ):
            events.append(event)

    mock_workflow.wait_condition.assert_not_called()
    mock_workflow.execute_activity.assert_not_called()
    assert len(events) == 1
    event = events[0]
    assert event.status == MessageStatus.FINISHED
    metadata = event.metadata or {}
    assert metadata["sendMessageToUser"]["isQuestion"] is False
    assert metadata["sendMessageToUser"]["isWaitingForUser"] is False


async def test_execute_tool_sub_agent_auto_responds():
    """Sub-agents auto-respond instead of blocking."""
    manager = get_manager()
    workflow_instance = _make_workflow_instance(depth=1)

    with patch("tools.send_message_to_user.workflow") as mock_workflow:
        mock_workflow.unsafe = MagicMock()

        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "Should I proceed?"},
            "sub-agent-test",
        ):
            events.append(event)

    assert len(events) == 2
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[1].status == MessageStatus.FINISHED
    assert events[1].title == "Auto-response (sub-agent)"

    # Should have posted auto-response message
    workflow_instance._post_message.assert_called_once()
    call_args = workflow_instance._post_message.call_args
    assert "trust your judgment" in call_args[0][0]


async def test_execute_tool_wait_failure():
    """Tool emits error if the indefinite wait fails."""
    manager = get_manager()

    workflow_instance = _make_workflow_instance()

    call_count = 0

    async def wait_side_effect(predicate, timeout=None):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # First call: 15-min timeout wait — simulate timeout
            raise TimeoutError()
        else:
            # Second call: indefinite wait — simulate failure
            raise Exception("connection lost")

    with patch("tools.send_message_to_user.workflow") as mock_workflow:
        mock_workflow.execute_activity = AsyncMock(side_effect=[
            "WEB",                 # get_agent_source
            {"success": True},     # notify_sms_event_activity (sent after timeout)
        ])
        mock_workflow.wait_condition = AsyncMock(side_effect=wait_side_effect)
        mock_workflow.unsafe = MagicMock()

        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "Need more info"},
            "test-err"
        ):
            events.append(event)

    assert events[-1].status == MessageStatus.ERROR
    assert "Error waiting for response" in events[-1].title


async def test_execute_tool_missing_message():
    """Tool errors when message payload is missing."""
    manager = get_manager()
    workflow_instance = _make_workflow_instance()

    events = []
    async for event in manager.execute_tool(workflow_instance, {}, "missing"):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "requires a non-empty `message`" in events[0].message


async def test_execute_tool_invalid_question_flag():
    """Tool errors when is_question is invalid."""
    manager = get_manager()
    workflow_instance = _make_workflow_instance()

    events = []
    async for event in manager.execute_tool(
        workflow_instance,
        {"message": "hello", "is_question": "yes"},
        "bad-flag",
    ):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "must be a boolean" in events[0].message


async def _run_all_tests():
    await test_manager_singleton()
    await test_execute_tool_question_blocks()
    await test_execute_tool_question_sms_source()
    await test_execute_tool_info_mode()
    await test_execute_tool_sub_agent_auto_responds()
    await test_execute_tool_wait_failure()
    await test_execute_tool_missing_message()
    await test_execute_tool_invalid_question_flag()
    print("\n🎉 send_message_to_user tests passed!")
    return True


def run_all_tests():
    return asyncio.run(_run_all_tests())


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
