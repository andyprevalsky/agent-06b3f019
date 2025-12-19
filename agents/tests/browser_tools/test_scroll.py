"""Test scroll browser tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.scroll import scroll_tool



async def test_scroll_down():
    """Test scroll tool scrolling down."""
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.mouse = MagicMock()
    mock_stagehand.page.mouse.wheel = AsyncMock()
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await scroll_tool(
        mock_stagehand,
        {"pixels": 500, "direction": "down"},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    assert result["pixels"] == 500
    
    # Verify wheel was called with positive delta (down)
    mock_stagehand.page.mouse.wheel.assert_called_once_with(0, 500)
    
    print("✅ test_scroll_down passed")


async def test_scroll_up():
    """Test scroll tool scrolling up."""
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.mouse = MagicMock()
    mock_stagehand.page.mouse.wheel = AsyncMock()
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await scroll_tool(
        mock_stagehand,
        {"pixels": 300, "direction": "up"},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    assert result["pixels"] == 300
    
    # Verify wheel was called with negative delta (up)
    mock_stagehand.page.mouse.wheel.assert_called_once_with(0, -300)
    
    print("✅ test_scroll_up passed")


async def test_scroll_error_handling():
    """Test scroll tool with error."""
    # Mock stagehand with error
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.mouse = MagicMock()
    mock_stagehand.page.mouse.wheel = AsyncMock(side_effect=Exception("Scroll failed"))
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await scroll_tool(
        mock_stagehand,
        {"pixels": 100, "direction": "down"},
        mock_logger
    )
    
    # Verify error handling
    assert result["success"] is False
    assert "Scroll failed" in result["error"]
    
    print("✅ test_scroll_error_handling passed")


async def run_all_tests():
    """Run all scroll tool tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SCROLL TOOL")
    print("="*60 + "\n")
    
    try:
        await test_scroll_down()
        await test_scroll_up()
        await test_scroll_error_handling()
        
        print("\n✅ All scroll tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

