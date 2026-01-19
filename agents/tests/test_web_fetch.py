"""Test web_fetch tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.web_fetch import WebFetchManager, get_manager, web_fetch, web_fetch_activity
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "web_fetch"
    print("✅ test_manager_singleton passed")


async def test_web_fetch_success():
    """Test successful web fetch execution with new execute_activity pattern."""
    manager = get_manager()

    # Mock execute_activity callable
    mock_execute_activity = AsyncMock()

    # Mock successful web fetch activity result
    mock_result = {
        "content": "**Python** (https://python.org)\nPython is a programming language.",
        "sources": ["https://python.org"],
        "objective": "What is Python?",
        "results": [
            {
                "url": "https://python.org",
                "title": "Python",
                "excerpts": ["Python is a programming language."]
            }
        ],
        "errors": []
    }

    # execute_activity is only called once (for web_fetch_activity)
    # handle_tool_event is mocked separately
    mock_execute_activity.return_value = mock_result

    tool_call = {
        "urls": ["https://python.org"],
        "objective": "What is Python?",
        "excerpts": True,
        "full_content": False
    }
    tool_call_id = "test-123"
    agent_id = "agent-123"
    user_id = "user-123"

    # Mock handle_tool_event to not actually post to DB
    with patch('tools.web_fetch.handle_tool_event', new_callable=AsyncMock) as mock_handle:
        result = await manager.execute_tool(
            execute_activity=mock_execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )

        # Verify handle_tool_event was called 3 times (IN_PROGRESS, FINISHED, USAGE)
        assert mock_handle.call_count == 3

        # First call should be IN_PROGRESS
        first_call = mock_handle.call_args_list[0]
        assert first_call.kwargs['event'].status == MessageStatus.IN_PROGRESS
        assert "What is Python?" in first_call.kwargs['event'].message

        # Second call should be FINISHED
        second_call = mock_handle.call_args_list[1]
        assert second_call.kwargs['event'].status == MessageStatus.FINISHED

        # Verify result
        assert "Python" in result["content"]

    print("✅ test_web_fetch_success passed")


async def test_web_fetch_error():
    """Test web fetch error handling."""
    manager = get_manager()

    # Mock execute_activity callable that fails
    mock_execute_activity = AsyncMock()
    mock_execute_activity.side_effect = Exception("API error")

    tool_call = {
        "urls": ["https://example.com"],
        "objective": "test",
        "excerpts": True,
        "full_content": False
    }
    tool_call_id = "test-error"
    agent_id = "agent-123"
    user_id = "user-123"

    # Mock handle_tool_event
    with patch('tools.web_fetch.handle_tool_event', new_callable=AsyncMock) as mock_handle:
        result = await manager.execute_tool(
            execute_activity=mock_execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )

        # Should return error result (not raise)
        assert "error" in result
        assert "API error" in result["error"]

        # Should have called handle_tool_event twice (IN_PROGRESS and ERROR)
        assert mock_handle.call_count == 2
        second_call = mock_handle.call_args_list[1]
        assert second_call.kwargs['event'].status == MessageStatus.ERROR

    print("✅ test_web_fetch_error passed")


async def test_web_fetch_activity_success():
    """Test the actual activity with mocked httpx client."""
    from tools.web_fetch import web_fetch_activity

    # Mock Parallel AI response
    mock_response_data = {
        "results": [
            {
                "url": "https://python.org",
                "title": "Python",
                "excerpts": ["Python is awesome!"]
            }
        ],
        "errors": []
    }

    # Mock config
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"

    # Create mock response object
    mock_response = MagicMock()
    mock_response.json.return_value = mock_response_data
    mock_response.raise_for_status = MagicMock()

    with patch('tools.web_fetch.load_config', return_value=mock_config):
        with patch('tools.web_fetch.httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client

            with patch('temporalio.activity.heartbeat'):
                result = await web_fetch_activity(
                    urls=["https://python.org"],
                    objective="What is Python?",
                    excerpts=True,
                    full_content=False
                )

            assert "Python is awesome!" in result["content"]
            assert result["sources"] == ["https://python.org"]
            assert result["objective"] == "What is Python?"

    print("✅ test_web_fetch_activity_success passed")


async def test_web_fetch_activity_error():
    """Test activity error handling."""
    from tools.web_fetch import web_fetch_activity

    # Mock config
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"

    with patch('tools.web_fetch.load_config', return_value=mock_config):
        with patch('tools.web_fetch.httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.post = AsyncMock(side_effect=Exception("API error"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client

            with patch('temporalio.activity.heartbeat'):
                try:
                    await web_fetch_activity(
                        urls=["https://example.com"],
                        objective="test query"
                    )
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "API error" in str(e)

    print("✅ test_web_fetch_activity_error passed")


async def test_web_fetch_multiple_urls():
    """Test fetching multiple URLs."""
    from tools.web_fetch import web_fetch_activity

    # Mock Parallel AI response with multiple results
    mock_response_data = {
        "results": [
            {
                "url": "https://python.org",
                "title": "Python",
                "excerpts": ["Python programming"]
            },
            {
                "url": "https://rust-lang.org",
                "title": "Rust",
                "excerpts": ["Rust programming"]
            }
        ],
        "errors": []
    }

    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"

    mock_response = MagicMock()
    mock_response.json.return_value = mock_response_data
    mock_response.raise_for_status = MagicMock()

    with patch('tools.web_fetch.load_config', return_value=mock_config):
        with patch('tools.web_fetch.httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client

            with patch('temporalio.activity.heartbeat'):
                result = await web_fetch_activity(
                    urls=["https://python.org", "https://rust-lang.org"],
                    objective="Compare programming languages",
                    excerpts=True,
                    full_content=False
                )

            assert len(result["sources"]) == 2
            assert "Python programming" in result["content"]
            assert "Rust programming" in result["content"]

    print("✅ test_web_fetch_multiple_urls passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING WEB_FETCH")
    print("="*60 + "\n")

    try:
        # Sync test
        test_manager_singleton()

        # Async tests
        await test_web_fetch_success()
        await test_web_fetch_error()
        await test_web_fetch_activity_success()
        await test_web_fetch_activity_error()
        await test_web_fetch_multiple_urls()

        print("\n✅ All web_fetch tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
