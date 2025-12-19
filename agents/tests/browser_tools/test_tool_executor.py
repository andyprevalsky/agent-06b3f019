"""Test browser tool executor."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.tool_executor import execute_browser_tool



async def test_execute_goto():
    """Test executor with goto tool."""
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.goto = AsyncMock()
    
    mock_logger = MagicMock()
    # logger mock
    
    result = await execute_browser_tool(
        "goto",
        {"url": "https://example.com"},
        mock_stagehand,
        mock_logger
    )
    
    assert result["success"] is True
    assert result["url"] == "https://example.com"
    
    print("✅ test_execute_goto passed")


async def test_execute_close():
    """Test executor with close tool."""
    mock_stagehand = MagicMock()
    mock_logger = MagicMock()
    # logger mock
    
    result = await execute_browser_tool(
        "close",
        {"reasoning": "Done", "success": True},
        mock_stagehand,
        mock_logger
    )
    
    assert result["success"] is True
    assert result["reasoning"] == "Done"
    
    print("✅ test_execute_close passed")


async def test_execute_unknown_tool():
    """Test executor with unknown tool name."""
    mock_stagehand = MagicMock()
    mock_logger = MagicMock()
    # logger mock
    
    result = await execute_browser_tool(
        "unknown_tool",
        {},
        mock_stagehand,
        mock_logger
    )
    
    assert result["success"] is False
    assert "Unknown tool" in result["error"]
    
    print("✅ test_execute_unknown_tool passed")


async def test_execute_with_execution_model():
    """Test executor passing execution model to tools."""
    # Mock observe and act for act tool
    mock_observe_result = MagicMock()
    mock_observe_result.description = "button"
    mock_observe_result.method = "click"
    mock_observe_result.arguments = []
    mock_observe_result.selector = "//button"
    
    mock_act_result = MagicMock()
    mock_act_result.success = True
    mock_act_result.action = "click"
    
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.observe = AsyncMock(return_value=[mock_observe_result])
    mock_stagehand.page.act = AsyncMock(return_value=mock_act_result)
    
    mock_logger = MagicMock()
    # logger mock
    
    result = await execute_browser_tool(
        "act",
        {"action": "click the button"},
        mock_stagehand,
        mock_logger,
        execution_model="rose-1-ultra"
    )
    
    assert result["success"] is True
    
    # Verify execution model was passed
    observe_call = mock_stagehand.page.observe.call_args
    assert "modelName" in observe_call[0][0]
    assert observe_call[0][0]["modelName"] == "rose-1-ultra"
    
    print("✅ test_execute_with_execution_model passed")


async def test_execute_tool_exception():
    """Test executor with tool that raises exception."""
    # Mock stagehand that will cause error
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.goto = AsyncMock(side_effect=Exception("Network error"))
    
    mock_logger = MagicMock()
    # logger mock
    
    result = await execute_browser_tool(
        "goto",
        {"url": "https://example.com"},
        mock_stagehand,
        mock_logger
    )
    
    assert result["success"] is False
    assert "error" in result
    
    print("✅ test_execute_tool_exception passed")


async def run_all_tests():
    """Run all tool executor tests."""
    print("\n" + "="*60)
    print("🧪 TESTING TOOL EXECUTOR")
    print("="*60 + "\n")
    
    try:
        await test_execute_goto()
        await test_execute_close()
        await test_execute_unknown_tool()
        await test_execute_with_execution_model()
        await test_execute_tool_exception()
        
        print("\n✅ All tool executor tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

