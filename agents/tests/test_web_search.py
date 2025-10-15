"""Test web_search tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.web_search import get_web_searcher, format_pre_message, format_post_message


async def test_web_search_basic():
    """Test basic web search functionality."""
    searcher = get_web_searcher()
    query = "What is the capital of France?"
    
    result = await searcher.search(query, max_tokens=500)
    
    assert "answer" in result
    assert "query" in result
    assert "model" in result
    assert len(result["answer"]) > 0
    assert result["query"] == query
    
    print("✅ test_web_search_basic passed")


async def test_web_search_current_events():
    """Test web search with current events query."""
    searcher = get_web_searcher()
    query = "Latest AI model releases in 2024"
    
    result = await searcher.search(query, max_tokens=1000)
    
    assert "answer" in result
    assert len(result["answer"]) > 100  # Should be substantial
    
    print("✅ test_web_search_current_events passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {"query": "Test query"}
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "🔍" in result["title"]
    assert "Test query" in result["message"]
    
    print("✅ test_format_pre_message passed")


def test_format_post_message():
    """Test post-message formatting."""
    tool_call = {"query": "Test query"}
    result_data = {
        "answer": "Test answer",
        "sources": ["https://example.com"],
        "query": "Test query",
        "model": "test-model"
    }
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    assert "Test answer" in result["message"]
    
    print("✅ test_format_post_message passed")


async def run_all_tests():
    """Run all web_search tests."""
    print("\n" + "="*60)
    print("🧪 TESTING WEB_SEARCH TOOL")
    print("="*60 + "\n")
    
    try:
        # Async tests
        await test_web_search_basic()
        await test_web_search_current_events()
        
        # Sync tests
        test_format_pre_message()
        test_format_post_message()
        
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

