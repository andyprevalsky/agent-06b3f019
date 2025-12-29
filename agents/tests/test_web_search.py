"""Test web_search tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.web_search import WebSearchManager, get_manager, web_search, web_search_activity
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "web_search"
    print("✅ test_manager_singleton passed")


async def test_web_search_success():
    """Test successful web search execution with new execute_activity pattern."""
    manager = get_manager()
    
    # Mock execute_activity callable
    mock_execute_activity = AsyncMock()
    
    # Mock successful web search activity result
    mock_result = {
        "answer": "Python is a high-level programming language created by Guido van Rossum.",
        "sources": [
            "https://www.python.org",
            "https://en.wikipedia.org/wiki/Python_(programming_language)"
        ],
        "query": "What is Python?",
        "model": "gpt-4.1"
    }
    
    # First call is handle_tool_event (IN_PROGRESS), second is web_search_activity, third is handle_tool_event (FINISHED)
    mock_execute_activity.side_effect = [None, mock_result, None]
    
    tool_call = {
        "query": "What is Python?",
        "max_tokens": 1500
    }
    tool_call_id = "test-123"
    agent_id = "agent-123"
    user_id = "user-123"
    
    # Mock handle_tool_event to not actually post to DB
    with patch('tools.web_search.handle_tool_event', new_callable=AsyncMock) as mock_handle:
        result = await manager.execute_tool(
            execute_activity=mock_execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )
        
        # Verify handle_tool_event was called twice (IN_PROGRESS and FINISHED)
        assert mock_handle.call_count == 2
        
        # First call should be IN_PROGRESS
        first_call = mock_handle.call_args_list[0]
        assert first_call.kwargs['event'].status == MessageStatus.IN_PROGRESS
        assert "What is Python?" in first_call.kwargs['event'].message
        
        # Second call should be FINISHED
        second_call = mock_handle.call_args_list[1]
        assert second_call.kwargs['event'].status == MessageStatus.FINISHED
        
        # Verify result
        assert result["answer"] == "Python is a high-level programming language created by Guido van Rossum."
    
    print("✅ test_web_search_success passed")


async def test_web_search_error():
    """Test web search error handling."""
    manager = get_manager()
    
    # Mock execute_activity callable that fails
    mock_execute_activity = AsyncMock()
    mock_execute_activity.side_effect = Exception("OpenAI API error")
    
    tool_call = {"query": "test", "max_tokens": 1500}
    tool_call_id = "test-error"
    agent_id = "agent-123"
    user_id = "user-123"
    
    # Mock handle_tool_event
    with patch('tools.web_search.handle_tool_event', new_callable=AsyncMock) as mock_handle:
        result = await manager.execute_tool(
            execute_activity=mock_execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )
        
        # Should return error result (not raise)
        assert "error" in result
        assert "OpenAI API error" in result["error"]
        
        # Should have called handle_tool_event twice (IN_PROGRESS and ERROR)
        assert mock_handle.call_count == 2
        second_call = mock_handle.call_args_list[1]
        assert second_call.kwargs['event'].status == MessageStatus.ERROR
    
    print("✅ test_web_search_error passed")


async def test_web_search_activity_success():
    """Test the actual activity with mocked OpenAI client."""
    from tools.web_search import web_search_activity
    
    # Mock OpenAI response
    mock_response = MagicMock()
    mock_response.output_text = "Python is awesome!"
    mock_response.sources = ["https://python.org"]
    
    # Mock config
    mock_config = MagicMock()
    mock_config.openai.api_key = "test-key"
    mock_config.openai.model = "gpt-4.1"
    
    with patch('tools.web_search.load_config', return_value=mock_config):
        with patch('tools.web_search.AsyncOpenAI') as mock_openai_class:
            mock_client = MagicMock()
            mock_client.responses.create = AsyncMock(return_value=mock_response)
            mock_openai_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                result = await web_search_activity("What is Python?", 1500)
            
            assert result["answer"] == "Python is awesome!"
            assert result["sources"] == ["https://python.org"]
            assert result["query"] == "What is Python?"
            assert result["model"] == "gpt-4.1"
    
    print("✅ test_web_search_activity_success passed")


async def test_web_search_activity_error():
    """Test activity error handling."""
    from tools.web_search import web_search_activity
    
    # Mock config
    mock_config = MagicMock()
    mock_config.openai.api_key = "test-key"
    mock_config.openai.model = "gpt-4.1"
    
    with patch('tools.web_search.load_config', return_value=mock_config):
        with patch('tools.web_search.AsyncOpenAI') as mock_openai_class:
            mock_client = MagicMock()
            mock_client.responses.create = AsyncMock(side_effect=Exception("API error"))
            mock_openai_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                try:
                    await web_search_activity("test query")
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "API error" in str(e)
    
    print("✅ test_web_search_activity_error passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING WEB_SEARCH")
    print("="*60 + "\n")
    
    try:
        # Sync test
        test_manager_singleton()
        
        # Async tests
        await test_web_search_success()
        await test_web_search_error()
        await test_web_search_activity_success()
        await test_web_search_activity_error()
        
        print("\n✅ All web_search tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

