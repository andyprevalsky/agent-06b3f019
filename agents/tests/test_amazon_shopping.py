"""Test amazon_shopping tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.amazon_shopping import AmazonShoppingManager, get_manager, buy_item_from_amazon
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "buy_item_from_amazon"
    print("✅ test_manager_singleton passed")


async def test_amazon_purchase_confirmed():
    """Test successful Amazon purchase with user confirmation."""
    manager = get_manager()
    
    # Mock workflow instance
    mock_workflow = MagicMock()
    mock_workflow.goal = "Buy a shower bench"
    mock_workflow.user_id = "test-user-123"
    
    # Mock user settings
    mock_user_settings = {
        "name": "Test User",
        "addressLine1": "123 Main St",
        "city": "San Francisco",
        "state": "CA",
        "postalCode": "94102",
        "country": "United States"
    }
    
    # Mock Amazon search results
    mock_products = [{
        "title": "Premium Wooden Shower Bench",
        "extracted_price": 79.99,
        "extracted_original_price": 99.99,
        "rating": 4.7,
        "reviews": 1543,
        "asin": "B08XYZ123",
        "link": "https://amazon.com/product",
        "thumbnail": "https://example.com/thumb.jpg"
    }]
    
    # Mock LLM ranking
    mock_ranking = {
        "best_product_index": 0,
        "reasoning": "Best rated with good price",
        "usage": {
            "prompt_tokens": 500,
            "completion_tokens": 100,
            "total_tokens": 600
        }
    }
    
    # Mock user confirmation
    mock_attention_result = {
        "response": "yes, buy it"
    }
    
    with patch('tools.amazon_shopping.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        # Setup activity mocks - now using function references, not string names
        async def activity_side_effect(func_ref, *args, **kwargs):
            func_name = func_ref.__name__ if callable(func_ref) else str(func_ref)
            if "fetch_user_settings" in func_name:
                return mock_user_settings
            elif "search_amazon" in func_name:
                return (200, mock_products)
            elif "rank_amazon" in func_name:
                return mock_ranking
            return None
        
        mock_execute.side_effect = activity_side_effect
        
        with patch('tools.amazon_shopping.request_user_attention', new_callable=AsyncMock) as mock_attention:
            mock_attention.return_value = mock_attention_result
            
            tool_call = {
                "item_search_query": "wooden shower bench",
                "item_qualifications": "under $100, highly rated"
            }
            tool_call_id = "test-123"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            # Verify events
            assert len(events) >= 3  # Pre, usage, post
            
            # Pre-execution
            assert events[0].type == EventType.POST_MESSAGE
            assert events[0].title == "🛒 Buying wooden shower bench from Amazon"
            assert events[0].status == MessageStatus.IN_PROGRESS
            
            # Usage tracking
            usage_events = [e for e in events if e.type == EventType.USAGE]
            assert len(usage_events) == 1
            
            # Post-execution success
            final_event = events[-1]
            assert final_event.type == EventType.POST_MESSAGE
            assert "purchased from Amazon" in final_event.title
            assert final_event.status == MessageStatus.FINISHED
            assert "$79.99" in final_event.message
    
    print("✅ test_amazon_purchase_confirmed passed")


async def test_amazon_purchase_canceled():
    """Test Amazon purchase canceled by user."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.goal = "Buy headphones"
    mock_workflow.user_id = "test-user-456"
    
    mock_user_settings = {"name": "Test", "addressLine1": "123 St", "city": "SF", "state": "CA", "postalCode": "94102"}
    mock_products = [{"title": "Headphones", "extracted_price": 50, "rating": 4.5, "reviews": 100, "asin": "B123", "link": "", "thumbnail": ""}]
    mock_ranking = {"best_product_index": 0, "reasoning": "Good", "usage": {"total_tokens": 500}}
    mock_attention_result = {"response": "no, cancel it"}
    
    with patch('tools.amazon_shopping.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        async def activity_side_effect(func_ref, *args, **kwargs):
            func_name = func_ref.__name__ if callable(func_ref) else str(func_ref)
            if "fetch_user_settings" in func_name:
                return mock_user_settings
            elif "search_amazon" in func_name:
                return (200, mock_products)
            elif "rank_amazon" in func_name:
                return mock_ranking
            return None
        
        mock_execute.side_effect = activity_side_effect
        
        with patch('tools.amazon_shopping.request_user_attention', new_callable=AsyncMock) as mock_attention:
            mock_attention.return_value = mock_attention_result
            
            tool_call = {"item_search_query": "headphones", "item_qualifications": ""}
            tool_call_id = "test-456"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            final_event = events[-1]
            assert "canceled" in final_event.title.lower()
            assert "declined" in final_event.message.lower()
    
    print("✅ test_amazon_purchase_canceled passed")


async def test_amazon_no_products_found():
    """Test Amazon search with no results."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-789"
    
    with patch('tools.amazon_shopping.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        async def activity_side_effect(func_ref, *args, **kwargs):
            func_name = func_ref.__name__ if callable(func_ref) else str(func_ref)
            if "fetch_user_settings" in func_name:
                return {}
            elif "search_amazon" in func_name:
                return (200, [])  # Empty products list
            return None
        
        mock_execute.side_effect = activity_side_effect
        
        tool_call = {"item_search_query": "nonexistent item xyz", "item_qualifications": ""}
        tool_call_id = "test-789"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Should have error event
        error_events = [e for e in events if e.status == MessageStatus.ERROR]
        assert len(error_events) > 0
        assert "No products found" in error_events[0].message
    
    print("✅ test_amazon_no_products_found passed")


async def test_amazon_search_failure():
    """Test Amazon search API failure."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-error"
    
    with patch('tools.amazon_shopping.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        async def activity_side_effect(func_ref, *args, **kwargs):
            func_name = func_ref.__name__ if callable(func_ref) else str(func_ref)
            if "fetch_user_settings" in func_name:
                return {}
            elif "search_amazon" in func_name:
                return (500, [])  # API error
            return None
        
        mock_execute.side_effect = activity_side_effect
        
        tool_call = {"item_search_query": "test item", "item_qualifications": ""}
        tool_call_id = "test-error"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Should have error event
        final_event = events[-1]
        assert final_event.status == MessageStatus.ERROR
    
    print("✅ test_amazon_search_failure passed")


async def test_amazon_activity_exception():
    """Test exception handling in Amazon flow."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-exception"
    
    with patch('tools.amazon_shopping.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("Network error")
        
        tool_call = {"item_search_query": "test", "item_qualifications": ""}
        tool_call_id = "test-exception"
        
        events = []
        try:
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
        except Exception:
            pass  # Expected to raise
        
        # Should have error event
        assert len(events) >= 2
        assert events[-1].status == MessageStatus.ERROR
        assert "Network error" in events[-1].message
    
    print("✅ test_amazon_activity_exception passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING AMAZON_SHOPPING")
    print("="*60 + "\n")
    
    try:
        # Sync test
        test_manager_singleton()
        
        # Async tests
        await test_amazon_purchase_confirmed()
        await test_amazon_purchase_canceled()
        await test_amazon_no_products_found()
        await test_amazon_search_failure()
        await test_amazon_activity_exception()
        
        print("\n✅ All amazon_shopping tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

