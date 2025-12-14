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


async def test_manager_singleton():
    """Ensure singleton manager works."""
    manager1 = get_manager()
    manager2 = get_manager()

    assert manager1 is manager2
    assert isinstance(manager1, SendMessageToUserManager)
    assert manager1.tool_name == "send_message_to_user"


async def test_execute_tool_question_blocks():
    """Blocking mode waits for user response."""
    manager = get_manager()

    workflow_instance = MagicMock()
    workflow_instance.context = []
    tool_call_id = "test-123"

    async def simulate_wait(predicate):
        workflow_instance.context.append({"role": "USER", "text": "User reply"})
        assert predicate()

    with patch("tools.send_message_to_user.workflow.wait_condition", new_callable=AsyncMock) as mock_wait:
        mock_wait.side_effect = simulate_wait

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


async def test_execute_tool_info_mode():
    """Non-blocking mode should not wait for the user."""
    manager = get_manager()
    workflow_instance = MagicMock()
    workflow_instance.context = []

    with patch("tools.send_message_to_user.workflow.wait_condition", new_callable=AsyncMock) as mock_wait:
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "Plan: 1) Audit docs 2) Draft email", "is_question": False},
            "info-mode",
        ):
            events.append(event)

    mock_wait.assert_not_called()
    assert len(events) == 1
    event = events[0]
    assert event.status == MessageStatus.FINISHED
    metadata = event.metadata or {}
    assert metadata["sendMessageToUser"]["isQuestion"] is False
    assert metadata["sendMessageToUser"]["isWaitingForUser"] is False


async def test_execute_tool_wait_failure():
    """Tool emits error if waiting fails."""
    manager = get_manager()

    workflow_instance = MagicMock()
    workflow_instance.context = []

    with patch("tools.send_message_to_user.workflow.wait_condition", new_callable=AsyncMock) as mock_wait:
        mock_wait.side_effect = Exception("timeout")

        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"message": "Need more info"},
            "test-err"
        ):
            events.append(event)

    assert len(events) == 2
    assert events[1].status == MessageStatus.ERROR
    assert "Error waiting for response" in events[1].title


async def test_execute_tool_missing_message():
    """Tool errors when message payload is missing."""
    manager = get_manager()
    workflow_instance = MagicMock()
    workflow_instance.context = []

    events = []
    async for event in manager.execute_tool(workflow_instance, {}, "missing"):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "requires a non-empty `message`" in events[0].message


async def test_execute_tool_invalid_question_flag():
    """Tool errors when is_question is invalid."""
    manager = get_manager()
    workflow_instance = MagicMock()
    workflow_instance.context = []

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
    await test_execute_tool_info_mode()
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
