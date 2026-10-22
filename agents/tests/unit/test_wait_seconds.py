"""Test wait_seconds tool (event-driven architecture)."""

import asyncio
from datetime import timedelta
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add the agents root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

load_dotenv()

from tools.wait_seconds import (
    WaitSecondsManager,
    get_manager,
    format_duration,
)
from tools.base import EventType, MessageStatus


def test_format_duration():
    """Test duration formatting."""
    assert format_duration(1) == "1 second"
    assert format_duration(5) == "5 seconds"
    assert format_duration(60) == "1 minute"
    assert format_duration(120) == "2 minutes"
    assert format_duration(90) == "1.5 minutes"
    assert format_duration(3600) == "1 hour"
    assert format_duration(7200) == "2 hours"
    assert format_duration(5400) == "1.5 hours"
    assert format_duration(86400) == "1 day"
    assert format_duration(172800) == "2 days"

    print("✅ test_format_duration passed")


async def test_manager_singleton():
    """Test manager singleton pattern."""
    manager1 = get_manager()
    manager2 = get_manager()

    assert manager1 is manager2
    assert isinstance(manager1, WaitSecondsManager)
    assert manager1.tool_name == "wait_seconds"

    print("✅ test_manager_singleton passed")


async def test_execute_tool_success():
    """Test successful wait execution."""
    manager = get_manager()

    # Mock workflow instance
    workflow_instance = MagicMock()

    # Mock the wait's deterministic timer (wait_condition timing out = timer fired)
    with patch(
        "domains.wait_seconds.handler.workflow.wait_condition",
        new_callable=AsyncMock,
        side_effect=asyncio.TimeoutError(),
    ) as mock_sleep:
        tool_call = {"seconds": 2}
        tool_call_id = "test-123"

        events = []
        async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
            events.append(event)

        # Should have 2 events: pre and post
        assert len(events) == 2

        # Check pre-execution event
        pre_event = events[0]
        assert pre_event.type == EventType.POST_MESSAGE
        assert "Waiting" in pre_event.title
        assert "2 seconds" in pre_event.title
        assert pre_event.status == MessageStatus.IN_PROGRESS

        # Check post-execution event
        post_event = events[1]
        assert post_event.type == EventType.POST_MESSAGE
        assert "Waited" in post_event.title
        assert "2 seconds" in post_event.title
        assert post_event.status == MessageStatus.FINISHED

        # Verify one timer for the full duration (no 30s pointer-poll slices)
        assert mock_sleep.await_count == 1
        assert mock_sleep.await_args.kwargs["timeout"] == timedelta(seconds=2)

    print("✅ test_execute_tool_success passed")


async def test_execute_tool_invalid_duration():
    """Test wait with invalid duration."""
    manager = get_manager()

    # Mock workflow instance
    workflow_instance = MagicMock()

    # Test duration too short
    tool_call = {"seconds": 0}
    tool_call_id = "test-123"

    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        events.append(event)

    # Should have 1 error event
    assert len(events) == 1
    error_event = events[0]
    assert error_event.type == EventType.POST_MESSAGE
    assert error_event.status == MessageStatus.ERROR
    assert "Invalid wait duration" in error_event.title

    # Test duration too long (MAX_WAIT is 2_678_400 = 31 days)
    tool_call = {"seconds": 3_000_000}
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        events.append(event)

    assert len(events) == 1
    error_event = events[0]
    assert error_event.status == MessageStatus.ERROR

    print("✅ test_execute_tool_invalid_duration passed")


async def test_execute_tool_error_handling():
    """Test error handling during wait."""
    manager = get_manager()

    workflow_instance = MagicMock()

    # Mock the wait's timer to raise an error
    with patch("domains.wait_seconds.handler.workflow.wait_condition", new_callable=AsyncMock) as mock_sleep:
        mock_sleep.side_effect = Exception("Test error")

        tool_call = {"seconds": 1}
        tool_call_id = "test-123"

        events = []
        async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
            events.append(event)

        # Should have 2 events: pre and error
        assert len(events) == 2

        pre_event = events[0]
        assert pre_event.status == MessageStatus.IN_PROGRESS

        error_event = events[1]
        assert error_event.type == EventType.POST_MESSAGE
        assert error_event.status == MessageStatus.ERROR
        assert "Wait failed" in error_event.title
        assert "Test error" in error_event.message

    print("✅ test_execute_tool_error_handling passed")


async def test_various_durations():
    """Test various duration formats."""
    manager = get_manager()
    workflow_instance = MagicMock()

    test_cases = [
        (1, "1 second"),
        (30, "30 seconds"),
        (60, "1 minute"),
        (90, "1.5 minutes"),
        (3600, "1 hour"),
    ]

    with patch(
        "domains.wait_seconds.handler.workflow.wait_condition",
        new_callable=AsyncMock,
        side_effect=asyncio.TimeoutError(),
    ):
        for seconds, expected_text in test_cases:
            tool_call = {"seconds": seconds}
            events = []
            async for event in manager.execute_tool(workflow_instance, tool_call, "test"):
                events.append(event)

            # Check that duration is formatted correctly in title
            pre_event = events[0]
            assert expected_text in pre_event.title

    print("✅ test_various_durations passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("🧪 TESTING WAIT_SECONDS")
    print("=" * 60 + "\n")

    try:
        # Sync test
        test_format_duration()

        # Async tests
        await test_manager_singleton()
        await test_execute_tool_success()
        await test_execute_tool_invalid_duration()
        await test_execute_tool_error_handling()
        await test_various_durations()

        print("\n✅ All wait_seconds tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback

        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
