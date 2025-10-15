"""Test amazon_shopping tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.amazon_shopping import (
    format_pre_message,
    format_post_message,
    search_amazon_activity,
    rank_amazon_products_activity
)


async def test_search_amazon_activity():
    """Test Amazon search activity with mocked HTTP calls."""
    # Mock the HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = [
        {
            "title": "Test Product 1",
            "price": "$29.99",
            "rating": "4.5",
            "reviews": "500",
            "url": "https://amazon.com/test1"
        },
        {
            "title": "Test Product 2",
            "price": "$39.99",
            "rating": "4.8",
            "reviews": "1000",
            "url": "https://amazon.com/test2"
        }
    ]
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(return_value=mock_response)
        
        # Call the activity (outside activity context for testing)
        with patch('temporalio.activity.heartbeat'):
            status, products = await search_amazon_activity("wireless headphones")
        
        assert status == 200
        assert len(products) == 2
        assert products[0]["title"] == "Test Product 1"
        assert products[1]["price"] == "$39.99"
    
    print("✅ test_search_amazon_activity passed")


async def test_search_amazon_activity_failure():
    """Test Amazon search activity with failed HTTP call."""
    # Mock a failed HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 500
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            status, products = await search_amazon_activity("test query")
        
        assert status == 500
        assert products == []
    
    print("✅ test_search_amazon_activity_failure passed")


async def test_rank_amazon_products_activity():
    """Test product ranking activity with mocked LLM call."""
    # Mock the LLM structured call
    mock_ranking = MagicMock()
    mock_ranking.best_product_index = 1
    mock_ranking.reasoning = "Product 1 has the best reviews and price"
    mock_ranking.runner_up_index = 0
    
    mock_usage = {
        "prompt_tokens": 500,
        "completion_tokens": 50,
        "total_tokens": 550
    }
    
    with patch('helpers.llm.call_llm_structured', new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = (mock_ranking, mock_usage)
        
        with patch('temporalio.activity.heartbeat'):
            result = await rank_amazon_products_activity("Rank these products: ...")
        
        assert result["best_product_index"] == 1
        assert "reasoning" in result
        assert result["runner_up_index"] == 0
        assert result["usage"]["total_tokens"] == 550
        
        # Verify LLM was called
        mock_llm.assert_called_once()
    
    print("✅ test_rank_amazon_products_activity passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {
        "query": "wireless headphones",
        "max_results": 5
    }
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "🛒" in result["title"] or "Amazon" in result["title"]
    
    print("✅ test_format_pre_message passed")


def test_format_post_message_success():
    """Test post-message formatting with successful results."""
    tool_call = {"query": "wireless headphones"}
    result_data = {
        "products": [
            {
                "title": "Test Headphones",
                "price": "$99.99",
                "rating": "4.5",
                "reviews": "1000",
                "url": "https://amazon.com/test"
            }
        ],
        "query": "wireless headphones"
    }
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_post_message_success passed")


def test_format_post_message_no_results():
    """Test post-message formatting with no results."""
    tool_call = {"query": "nonexistent product xyz123"}
    result_data = {
        "products": [],
        "query": "nonexistent product xyz123"
    }
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_post_message_no_results passed")


def test_format_post_message_error():
    """Test post-message formatting with error."""
    tool_call = {"query": "test query"}
    result_data = "Error: API key not configured"
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_post_message_error passed")


async def run_all_tests():
    """Run all amazon_shopping tests."""
    print("\n" + "="*60)
    print("🧪 TESTING AMAZON_SHOPPING TOOL")
    print("="*60 + "\n")
    
    try:
        # Async tests for activities
        await test_search_amazon_activity()
        await test_search_amazon_activity_failure()
        await test_rank_amazon_products_activity()
        
        # Sync tests for formatters
        test_format_pre_message()
        test_format_post_message_success()
        test_format_post_message_no_results()
        test_format_post_message_error()
        
        print("\n✅ All amazon_shopping tests passed!")
        print("ℹ️  Note: buy_item_from_amazon requires workflow context")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

