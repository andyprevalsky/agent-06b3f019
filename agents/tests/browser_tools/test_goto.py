"""Test goto browser tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.goto import goto_tool


async def test_goto_success():
    """Test goto tool with successful navigation."""
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.goto = AsyncMock()
    
    # Mock logger
    mock_logger = MagicMock()
    
    # Execute tool
    result = await goto_tool(
        mock_stagehand,
        {"url": "https://example.com"},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    assert result["url"] == "https://example.com"
    mock_stagehand.page.goto.assert_called_once_with("https://example.com", wait_until="load")
    
    print("✅ test_goto_success passed")


async def test_goto_failure():
    """Test goto tool with navigation failure."""
    # Mock stagehand with error
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.goto = AsyncMock(side_effect=Exception("Navigation failed"))
    
    # Mock logger
    mock_logger = MagicMock()
    
    # Execute tool
    result = await goto_tool(
        mock_stagehand,
        {"url": "https://example.com"},
        mock_logger
    )
    
    # Verify error handling
    assert result["success"] is False
    assert "Navigation failed" in result["error"]
    
    print("✅ test_goto_failure passed")


async def test_goto_empty_url():
    """Test goto tool with empty URL."""
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.goto = AsyncMock()
    
    # Mock logger
    mock_logger = MagicMock()
    
    # Execute tool with empty URL
    result = await goto_tool(
        mock_stagehand,
        {},  # No URL provided
        mock_logger
    )
    
    # Should still attempt navigation with empty string
    assert result["success"] is True
    assert result["url"] == ""
    
    print("✅ test_goto_empty_url passed")


async def run_all_tests():
    """Run all goto tool tests."""
    print("\n" + "="*60)
    print("🧪 TESTING GOTO TOOL")
    print("="*60 + "\n")
    
    try:
        await test_goto_success()
        await test_goto_failure()
        await test_goto_empty_url()
        
        print("\n✅ All goto tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

