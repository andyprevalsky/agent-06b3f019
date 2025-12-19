"""Test screenshot browser tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.screenshot import screenshot_tool



async def test_screenshot_success():
    """Test screenshot tool with successful capture."""
    # Mock screenshot bytes
    mock_screenshot = b"fake_screenshot_data"
    
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.screenshot = AsyncMock(return_value=mock_screenshot)
    mock_stagehand.page.url = MagicMock(return_value="https://example.com")
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await screenshot_tool(mock_stagehand, {}, mock_logger)
    
    # Verify
    assert "base64" in result
    assert "timestamp" in result
    assert "pageUrl" in result
    assert result["pageUrl"] == "https://example.com"
    assert isinstance(result["base64"], str)
    assert isinstance(result["timestamp"], int)
    
    # Verify screenshot was called with correct params
    mock_stagehand.page.screenshot.assert_called_once_with(
        full_page=False,
        type="jpeg"
    )
    
    print("✅ test_screenshot_success passed")


async def test_screenshot_error_handling():
    """Test screenshot tool with capture error."""
    # Mock stagehand with error
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.screenshot = AsyncMock(side_effect=Exception("Screenshot failed"))
    mock_stagehand.page.url = MagicMock(return_value="https://example.com")
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await screenshot_tool(mock_stagehand, {}, mock_logger)
    
    # Verify error handling
    assert "base64" in result
    assert result["base64"] == ""  # Empty on error
    assert "error" in result
    assert "Screenshot failed" in result["error"]
    
    print("✅ test_screenshot_error_handling passed")


async def run_all_tests():
    """Run all screenshot tool tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SCREENSHOT TOOL")
    print("="*60 + "\n")
    
    try:
        await test_screenshot_success()
        await test_screenshot_error_handling()
        
        print("\n✅ All screenshot tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

