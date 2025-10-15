"""Test deep_research tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.deep_research import get_deep_researcher, format_pre_message, format_post_message


async def test_deep_research_basic():
    """Test basic deep research functionality."""
    researcher = get_deep_researcher()
    query = "What are the main differences between Python and JavaScript?"
    
    result = await researcher.research(query, max_tokens=1000)
    
    assert "report" in result
    assert "citations" in result
    assert "query" in result
    assert "model" in result
    assert len(result["report"]) > 0
    assert result["query"] == query
    
    print("✅ test_deep_research_basic passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {"query": "Test research query"}
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "🔬" in result["title"]
    assert "Test research query" in result["message"]
    
    print("✅ test_format_pre_message passed")


def test_format_post_message():
    """Test post-message formatting."""
    tool_call = {"query": "Test research query"}
    result_data = {
        "report": "Test research report with detailed findings",
        "citations": ["https://example.com", "https://example2.com"],
        "query": "Test query",
        "model": "sonar-deep-research",
        "report_length": 100,
        "citation_count": 2
    }
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    assert "research report" in result["message"].lower() or "findings" in result["message"].lower()
    
    print("✅ test_format_post_message passed")


async def run_all_tests():
    """Run all deep_research tests."""
    print("\n" + "="*60)
    print("🧪 TESTING DEEP_RESEARCH TOOL")
    print("="*60 + "\n")
    
    try:
        # Async tests
        print("⏳ Running deep research test (may take 30-120 seconds)...")
        await test_deep_research_basic()
        
        # Sync tests
        test_format_pre_message()
        test_format_post_message()
        
        print("\n✅ All deep_research tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

