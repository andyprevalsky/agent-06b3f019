"""Test web_search tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.web_search import WebSearchManager, get_manager, web_search
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "web_search"
    print("✅ test_manager_singleton passed")


async def test_web_search_success():
    """Test successful web search execution."""
    manager = get_manager()
    
    # Mock workflow instance
    mock_workflow = MagicMock()
    
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
    
    # Patch workflow.execute_activity
    with patch('tools.web_search.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "query": "What is Python?",
            "max_tokens": 1500
        }
        tool_call_id = "test-123"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Verify events
        assert len(events) == 2
        
        # Pre-execution event
        assert events[0].type == EventType.POST_MESSAGE
        assert events[0].title == "🔍 Searching the web"
        assert "What is Python?" in events[0].message
        assert events[0].status == MessageStatus.IN_PROGRESS
        
        # Post-execution event
        assert events[1].type == EventType.POST_MESSAGE
        assert events[1].title == "Web search completed"
        assert "Python is a high-level programming language" in events[1].message
        assert "https://www.python.org" in events[1].message
        assert events[1].status == MessageStatus.FINISHED
    
    print("✅ test_web_search_success passed")


async def test_web_search_no_sources():
    """Test web search with no sources returned."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    # Mock result without sources
    mock_result = {
        "answer": "The sky is blue due to Rayleigh scattering.",
        "sources": [],
        "query": "Why is the sky blue?",
        "model": "gpt-4.1"
    }
    
    with patch('tools.web_search.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "query": "Why is the sky blue?",
            "max_tokens": 1500
        }
        tool_call_id = "test-456"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Post-execution should have answer but no sources section
        assert events[1].status == MessageStatus.FINISHED
        assert "Rayleigh scattering" in events[1].message
        assert "**Sources:**" not in events[1].message
    
    print("✅ test_web_search_no_sources passed")


async def test_web_search_many_sources():
    """Test web search with many sources (should truncate display)."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    # Mock result with many sources
    mock_sources = [f"https://example{i}.com" for i in range(10)]
    mock_result = {
        "answer": "Test answer",
        "sources": mock_sources,
        "query": "test query",
        "model": "gpt-4.1"
    }
    
    with patch('tools.web_search.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {"query": "test query", "max_tokens": 1500}
        tool_call_id = "test-789"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Should show first 5 sources + "and X more"
        message = events[1].message
        assert "example0.com" in message
        assert "example4.com" in message
        assert "and 5 more" in message
    
    print("✅ test_web_search_many_sources passed")


async def test_web_search_long_query():
    """Test web search with long query (should truncate for display)."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    long_query = "A" * 150  # Very long query
    
    mock_result = {
        "answer": "Answer",
        "sources": [],
        "query": long_query,
        "model": "gpt-4.1"
    }
    
    with patch('tools.web_search.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {"query": long_query, "max_tokens": 1500}
        tool_call_id = "test-long"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Pre-execution message should have truncated query with "..."
        assert len(events[0].message) < len(long_query) + 20  # Account for "Query: " prefix
        assert "..." in events[0].message
    
    print("✅ test_web_search_long_query passed")


async def test_web_search_error():
    """Test web search error handling."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    # Mock activity failure
    with patch('tools.web_search.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("OpenAI API error")
        
        tool_call = {"query": "test", "max_tokens": 1500}
        tool_call_id = "test-error"
        
        events = []
        try:
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
        except Exception:
            pass  # Expected to raise
        
        # Should have pre-execution and error events
        assert len(events) == 2
        assert events[0].status == MessageStatus.IN_PROGRESS
        assert events[1].status == MessageStatus.ERROR
        assert events[1].title == "❌ Web search failed"
        assert "OpenAI API error" in events[1].message
    
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
        await test_web_search_no_sources()
        await test_web_search_many_sources()
        await test_web_search_long_query()
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

