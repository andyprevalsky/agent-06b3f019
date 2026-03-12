"""Test wait_for tool (timestamp and condition modes)."""

import asyncio
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.wait_for import (
    WaitForManager,
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
    assert isinstance(manager1, WaitForManager)
    assert manager1.tool_name == "wait_for"

    print("✅ test_manager_singleton passed")


async def test_timestamp_mode_success():
    """Test successful timestamp wait."""
    manager = get_manager()
    workflow_instance = MagicMock()

    # Mock workflow.now() to return a fixed time
    fixed_now = datetime(2026, 3, 11, 12, 0, 0, tzinfo=timezone.utc)
    target = "2026-03-11T12:05:00Z"  # 5 minutes later

    with patch('tools.wait_for.workflow.now', return_value=fixed_now), \
         patch('tools.wait_for.workflow.sleep', new_callable=AsyncMock) as mock_sleep:

        tool_call = {"until_timestamp": target}
        events = []
        async for event in manager.execute_tool(workflow_instance, tool_call, "test-ts"):
            events.append(event)

        assert len(events) == 2
        assert events[0].status == MessageStatus.IN_PROGRESS
        assert "Waiting until" in events[0].title
        assert events[1].status == MessageStatus.FINISHED
        assert "Wait complete" in events[1].title

        # Should sleep for 300 seconds (5 minutes)
        mock_sleep.assert_called_once_with(300)

    print("✅ test_timestamp_mode_success passed")


async def test_timestamp_mode_past():
    """Test timestamp in the past returns error."""
    manager = get_manager()
    workflow_instance = MagicMock()

    fixed_now = datetime(2026, 3, 11, 12, 0, 0, tzinfo=timezone.utc)
    target = "2026-03-11T11:00:00Z"  # 1 hour in the past

    with patch('tools.wait_for.workflow.now', return_value=fixed_now):
        tool_call = {"until_timestamp": target}
        events = []
        async for event in manager.execute_tool(workflow_instance, tool_call, "test-past"):
            events.append(event)

        assert len(events) == 1
        assert events[0].status == MessageStatus.ERROR
        assert "past" in events[0].message.lower()

    print("✅ test_timestamp_mode_past passed")


async def test_missing_params():
    """Test error when neither timestamp nor condition provided."""
    manager = get_manager()
    workflow_instance = MagicMock()

    tool_call = {}
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, "test-empty"):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "until_timestamp" in events[0].message or "condition" in events[0].message

    print("✅ test_missing_params passed")


async def test_invalid_timestamp():
    """Test error with invalid timestamp format."""
    manager = get_manager()
    workflow_instance = MagicMock()

    tool_call = {"until_timestamp": "not-a-date"}
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, "test-invalid"):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR

    print("✅ test_invalid_timestamp passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("🧪 TESTING WAIT_FOR")
    print("=" * 60 + "\n")

    try:
        test_format_duration()

        await test_manager_singleton()
        await test_timestamp_mode_success()
        await test_timestamp_mode_past()
        await test_missing_params()
        await test_invalid_timestamp()

        print("\n✅ All wait_for tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
