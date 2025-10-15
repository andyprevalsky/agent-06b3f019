"""Test wait_seconds tool formatters."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.wait_seconds import format_pre_message, format_post_message, format_duration


def test_format_duration():
    """Test duration formatting."""
    assert format_duration(1) == "1 second"
    assert format_duration(30) == "30 seconds"
    assert format_duration(60) == "1 minute"
    assert format_duration(90) == "1.5 minutes"
    assert format_duration(120) == "2 minutes"
    assert format_duration(3600) == "1 hour"
    assert format_duration(7200) == "2 hours"
    assert format_duration(86400) == "1 day"
    
    print("✅ test_format_duration passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {"seconds": 30}
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "30 seconds" in result["title"] or "Waiting" in result["title"]
    
    print("✅ test_format_pre_message passed")


def test_format_post_message():
    """Test post-message formatting."""
    tool_call = {"seconds": 60}
    result = format_post_message(tool_call, None)
    
    assert "title" in result
    assert "message" in result
    assert "Waited" in result["title"] or "minute" in result["title"]
    
    print("✅ test_format_post_message passed")


def run_all_tests():
    """Run all wait_seconds tests."""
    print("\n" + "="*60)
    print("🧪 TESTING WAIT_SECONDS TOOL")
    print("="*60 + "\n")
    
    try:
        test_format_duration()
        test_format_pre_message()
        test_format_post_message()
        
        print("\n✅ All wait_seconds tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)

