"""Test request_user_attention tool."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.request_user_attention import format_pre_message, format_post_message


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {
        "question": "What color would you like?",
        "context": {"options": ["red", "blue", "green"]}
    }
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "🔔" in result["title"] or "attention" in result["title"].lower()
    assert "What color would you like?" in result["message"]
    
    print("✅ test_format_pre_message passed")


def test_format_post_message():
    """Test post-message formatting."""
    tool_call = {"question": "What color would you like?"}
    result_data = {
        "response": "I'd like blue",
        "question": "What color would you like?"
    }
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_post_message passed")


def run_all_tests():
    """Run all request_user_attention tests."""
    print("\n" + "="*60)
    print("🧪 TESTING REQUEST_USER_ATTENTION TOOL")
    print("="*60 + "\n")
    
    try:
        # Note: We don't test the actual request_user_attention function
        # because it requires workflow context and real backend interaction
        # We only test the formatters
        
        test_format_pre_message()
        test_format_post_message()
        
        print("\n✅ All request_user_attention tests passed!")
        print("ℹ️  Note: Skipped actual workflow calls (requires Temporal)")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)

