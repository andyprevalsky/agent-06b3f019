"""Tests for the lightweight request_user_attention tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.request_user_attention import RequestUserAttentionManager, get_manager  # noqa: E402
from tools.base import EventType, MessageStatus  # noqa: E402


async def test_manager_singleton():
    """Ensure singleton manager works."""
    manager1 = get_manager()
    manager2 = get_manager()

    assert manager1 is manager2
    assert isinstance(manager1, RequestUserAttentionManager)
    assert manager1.tool_name == "request_user_attention"


async def test_execute_tool_success():
    """Tool waits for user response and finishes."""
    manager = get_manager()

    workflow_instance = MagicMock()
    workflow_instance.context = []
    tool_call_id = "test-123"

    async def simulate_wait(predicate):
        workflow_instance.context.append({"role": "USER", "text": "User reply"})
        assert predicate()

    with patch("tools.request_user_attention.workflow.wait_condition", new_callable=AsyncMock) as mock_wait:
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
    assert events[0].message == "Need your approval on this plan."
    assert events[0].title == "💭 Thought"
    assert events[0].metadata["timeout"] == 60
    assert events[0].metadata["requestUserAttention"]["message"] == "Need your approval on this plan."


async def test_execute_tool_wait_failure():
    """Tool emits error if waiting fails."""
    manager = get_manager()

    workflow_instance = MagicMock()
    workflow_instance.context = []

    with patch("tools.request_user_attention.workflow.wait_condition", new_callable=AsyncMock) as mock_wait:
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


async def main():
    await test_manager_singleton()
    await test_execute_tool_success()
    await test_execute_tool_wait_failure()
    await test_execute_tool_missing_message()
    print("\n🎉 request_user_attention tests passed!")


if __name__ == "__main__":
    asyncio.run(main())
