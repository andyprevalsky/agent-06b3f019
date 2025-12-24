"""Test aria_tree browser tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from browser_tools.aria_tree import aria_tree_tool



async def test_aria_tree_success():
    """Test aria_tree tool with successful extraction."""
    # Mock stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.extract = AsyncMock(return_value={
        "page_text": "Sample page content with buttons and links"
    })
    mock_stagehand.page.url = MagicMock(return_value="https://example.com")
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await aria_tree_tool(mock_stagehand, {}, mock_logger)
    
    # Verify
    assert "content" in result
    assert "pageUrl" in result
    assert result["content"] == "Sample page content with buttons and links"
    assert result["pageUrl"] == "https://example.com"
    
    print("✅ test_aria_tree_success passed")


async def test_aria_tree_truncation():
    """Test aria_tree tool with content truncation."""
    # Mock stagehand with very long content
    long_content = "x" * 300000  # 300k characters (exceeds 70k token limit)
    
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.extract = AsyncMock(return_value={
        "page_text": long_content
    })
    mock_stagehand.page.url = MagicMock(return_value="https://example.com")
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await aria_tree_tool(mock_stagehand, {}, mock_logger)
    
    # Verify truncation
    assert "content" in result
    assert "[CONTENT TRUNCATED" in result["content"]
    assert len(result["content"]) < len(long_content)
    
    print("✅ test_aria_tree_truncation passed")


async def test_aria_tree_error_handling():
    """Test aria_tree tool with extraction error."""
    # Mock stagehand with error
    mock_stagehand = MagicMock()
    mock_stagehand.page = MagicMock()
    mock_stagehand.page.extract = AsyncMock(side_effect=Exception("Extraction failed"))
    mock_stagehand.page.url = MagicMock(return_value="https://example.com")
    
    # Mock logger
    mock_logger = MagicMock()
    # logger mock
    
    # Execute tool
    result = await aria_tree_tool(mock_stagehand, {}, mock_logger)
    
    # Verify error handling
    assert "content" in result
    assert "Error extracting ARIA tree" in result["content"]
    assert result["pageUrl"] == "https://example.com"
    
    print("✅ test_aria_tree_error_handling passed")


async def run_all_tests():
    """Run all aria_tree tool tests."""
    print("\n" + "="*60)
    print("🧪 TESTING ARIA_TREE TOOL")
    print("="*60 + "\n")
    
    try:
        await test_aria_tree_success()
        await test_aria_tree_truncation()
        await test_aria_tree_error_handling()
        
        print("\n✅ All aria_tree tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)


