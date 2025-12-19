"""Test act browser tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.act import act_tool



async def test_act_success():
    """Test act tool with successful action."""
    # Mock observe result
    mock_observe_result = MagicMock()
    mock_observe_result.description = "login button"
    mock_observe_result.method = "click"
    mock_observe_result.arguments = []
    mock_observe_result.selector = "//button[@id='login']"
    
    # Mock act result
    mock_act_result = MagicMock()
    mock_act_result.success = True
    mock_act_result.action = "click"
    
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.observe = AsyncMock(return_value=[mock_observe_result])
    mock_stagehand.page.act = AsyncMock(return_value=mock_act_result)
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await act_tool(
        mock_stagehand,
        {"action": "click the login button"},
        mock_logger
    )
    
    # Verify
    assert result["success"] is True
    assert result["action"] == "click"
    assert result["isIframe"] is False
    assert "playwrightArguments" in result
    
    print("✅ test_act_success passed")


async def test_act_no_elements_found():
    """Test act tool when no elements are found."""
    # Mock stagehand with empty observe result
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.observe = AsyncMock(return_value=[])
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await act_tool(
        mock_stagehand,
        {"action": "click the nonexistent button"},
        mock_logger
    )
    
    # Verify error handling
    assert result["success"] is False
    assert "No observable actions found" in result["error"]
    
    print("✅ test_act_no_elements_found passed")


async def test_act_iframe_handling():
    """Test act tool with iframe element."""
    # Mock observe result indicating iframe
    mock_iframe_observe = MagicMock()
    mock_iframe_observe.description = "an iframe"
    
    # Mock iframe-specific observe result
    mock_iframe_element = MagicMock()
    mock_iframe_element.description = "submit button"
    mock_iframe_element.method = "click"
    mock_iframe_element.arguments = []
    mock_iframe_element.selector = "//button[@type='submit']"
    
    # Mock act result
    mock_act_result = MagicMock()
    mock_act_result.success = True
    mock_act_result.action = "click"
    
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    # First observe returns iframe indicator, second observe returns actual element
    mock_stagehand.page.observe = AsyncMock(side_effect=[
        [mock_iframe_observe],
        [mock_iframe_element]
    ])
    mock_stagehand.page.act = AsyncMock(return_value=mock_act_result)
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await act_tool(
        mock_stagehand,
        {"action": "click the submit button"},
        mock_logger
    )
    
    # Verify iframe handling
    assert result["success"] is True
    assert result["isIframe"] is True
    assert "playwrightArguments" in result
    
    print("✅ test_act_iframe_handling passed")


async def test_act_with_execution_model():
    """Test act tool with custom execution model."""
    # Mock observe result
    mock_observe_result = MagicMock()
    mock_observe_result.description = "search button"
    mock_observe_result.method = "click"
    mock_observe_result.arguments = []
    mock_observe_result.selector = "//button[@type='search']"
    
    # Mock act result
    mock_act_result = MagicMock()
    mock_act_result.success = True
    mock_act_result.action = "click"
    
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.observe = AsyncMock(return_value=[mock_observe_result])
    mock_stagehand.page.act = AsyncMock(return_value=mock_act_result)
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool with execution model
    result = await act_tool(
        mock_stagehand,
        {"action": "click the search button"},
        mock_logger,
        execution_model="rose-1-ultra"
    )
    
    # Verify success
    assert result["success"] is True
    
    # Verify observe was called with modelName
    observe_call = mock_stagehand.page.observe.call_args
    assert observe_call is not None
    assert "modelName" in observe_call[0][0]
    assert observe_call[0][0]["modelName"] == "rose-1-ultra"
    
    print("✅ test_act_with_execution_model passed")


async def run_all_tests():
    """Run all act tool tests."""
    print("\n" + "="*60)
    print("🧪 TESTING ACT TOOL")
    print("="*60 + "\n")
    
    try:
        await test_act_success()
        await test_act_no_elements_found()
        await test_act_iframe_handling()
        await test_act_with_execution_model()
        
        print("\n✅ All act tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

