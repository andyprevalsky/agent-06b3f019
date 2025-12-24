"""Test simple browser tools (wait, navback, close)."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.wait import wait_tool
from browser_tools.navback import navback_tool
from browser_tools.close import close_tool



# ============================================
# WAIT TOOL TESTS
# ============================================

async def test_wait_success():
    """Test wait tool with successful wait."""
    # Mock stagehand (not used by wait tool)
    mock_stagehand = MagicMock()
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool (use short wait for test speed)
    result = await wait_tool(
        mock_stagehand,
        {"timeMs": 10},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    assert result["waited"] == 10
    
    print("✅ test_wait_success passed")


async def test_wait_zero():
    """Test wait tool with zero milliseconds."""
    mock_stagehand = MagicMock()
    mock_logger = MagicMock()
    # logger mock
    
    result = await wait_tool(
        mock_stagehand,
        {"timeMs": 0},
        mock_logger
    )
    
    assert result["success"] is True
    assert result["waited"] == 0
    
    print("✅ test_wait_zero passed")


# ============================================
# NAVBACK TOOL TESTS
# ============================================

async def test_navback_success():
    """Test navback tool with successful navigation."""
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.go_back = AsyncMock()
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await navback_tool(
        mock_stagehand,
        {"reasoning": "Going back to previous page"},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    mock_stagehand.page.go_back.assert_called_once()
    
    print("✅ test_navback_success passed")


async def test_navback_error():
    """Test navback tool with navigation error."""
    # Mock stagehand with error
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.go_back = AsyncMock(side_effect=Exception("Cannot go back"))
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await navback_tool(
        mock_stagehand,
        {"reasoning": "Going back"},
        mock_logger
    )
    
    # Verify error handling
    assert result["success"] is False
    assert "Cannot go back" in result["error"]
    
    print("✅ test_navback_error passed")


# ============================================
# CLOSE TOOL TESTS
# ============================================

async def test_close_success():
    """Test close tool with success status."""
    # Mock stagehand (not used by close tool)
    mock_stagehand = MagicMock()
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await close_tool(
        mock_stagehand,
        {"reasoning": "Task completed successfully", "success": True},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    assert result["reasoning"] == "Task completed successfully"
    
    print("✅ test_close_success passed")


async def test_close_failure():
    """Test close tool with failure status."""
    mock_stagehand = MagicMock()
    mock_logger = MagicMock()
    # logger mock
    
    result = await close_tool(
        mock_stagehand,
        {"reasoning": "Could not complete task", "success": False},
        mock_logger
    )
    
    assert result["success"] is False
    assert result["reasoning"] == "Could not complete task"
    
    print("✅ test_close_failure passed")


async def test_close_defaults():
    """Test close tool with default values."""
    mock_stagehand = MagicMock()
    mock_logger = MagicMock()
    # logger mock
    
    result = await close_tool(
        mock_stagehand,
        {},  # No arguments provided
        mock_logger
    )
    
    # Should use defaults
    assert result["success"] is False  # Default success
    assert result["reasoning"] == ""  # Default reasoning
    
    print("✅ test_close_defaults passed")


# ============================================
# RUN ALL TESTS
# ============================================

async def run_all_tests():
    """Run all simple tool tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SIMPLE BROWSER TOOLS")
    print("="*60 + "\n")
    
    try:
        # Wait tool tests
        await test_wait_success()
        await test_wait_zero()
        
        # Navback tool tests
        await test_navback_success()
        await test_navback_error()
        
        # Close tool tests
        await test_close_success()
        await test_close_failure()
        await test_close_defaults()
        
        print("\n✅ All simple browser tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)


