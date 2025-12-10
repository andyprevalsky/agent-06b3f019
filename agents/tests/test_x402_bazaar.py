"""Test x402_bazaar tools."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.x402_bazaar import (
    SearchX402BazaarManager,
    PayForX402BazaarServiceManager,
    get_search_manager,
    get_pay_manager,
    search_x402_bazaar_activity,
    pay_for_x402_service_activity,
)
from tools.base import EventType, MessageStatus


# ========================================
# SEARCH X402 BAZAAR TESTS
# ========================================

def test_search_manager_singleton():
    """Test that search manager is a singleton."""
    manager1 = get_search_manager()
    manager2 = get_search_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "search_x402_bazaar"
    assert manager1.read_only is True
    print("✅ test_search_manager_singleton passed")


def test_pay_manager_singleton():
    """Test that pay manager is a singleton."""
    manager1 = get_pay_manager()
    manager2 = get_pay_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "pay_for_x402_bazaar_service"
    assert manager1.read_only is False
    print("✅ test_pay_manager_singleton passed")


async def test_search_bazaar_success():
    """Test successful bazaar search execution."""
    manager = get_search_manager()
    
    mock_workflow = MagicMock()
    
    # Mock successful search activity result
    mock_result = {
        "services": [
            {
                "resource": "https://api.example.com/x402/weather",
                "price_cents": 10,
                "price_display": "$0.0010",
                "pay_to": "0xabc123",
                "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "network": "base",
                "method": "GET",
                "input_schema": {"type": "http", "method": "GET"},
                "output_schema": None,
                "metadata": {},
                "last_updated": "2025-01-01T00:00:00Z",
            }
        ],
        "service_count": 1,
        "filters_applied": {
            "max_price_cents": None,
            "keyword": None,
            "excluded_own_wallet": True,
        }
    }
    
    with patch('tools.x402_bazaar.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "max_price_cents": 100,
            "keyword": "weather"
        }
        tool_call_id = "test-search-123"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Verify events
        assert len(events) == 2
        
        # Pre-execution event
        assert events[0].type == EventType.POST_MESSAGE
        assert events[0].title == "🔍 Searching x402 Bazaar"
        assert "weather" in events[0].message
        assert events[0].status == MessageStatus.IN_PROGRESS
        
        # Post-execution event
        assert events[1].type == EventType.POST_MESSAGE
        assert "1 x402 services" in events[1].title
        assert events[1].status == MessageStatus.FINISHED
    
    print("✅ test_search_bazaar_success passed")


async def test_search_bazaar_no_filters():
    """Test bazaar search with no filters."""
    manager = get_search_manager()
    
    mock_workflow = MagicMock()
    
    mock_result = {
        "services": [],
        "service_count": 0,
        "filters_applied": {
            "max_price_cents": None,
            "keyword": None,
            "excluded_own_wallet": True,
        }
    }
    
    with patch('tools.x402_bazaar.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {}  # No filters
        tool_call_id = "test-search-no-filter"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Should show "no filters" in message
        assert "no filters" in events[0].message
        assert events[1].status == MessageStatus.FINISHED
    
    print("✅ test_search_bazaar_no_filters passed")


async def test_search_bazaar_error():
    """Test bazaar search error handling."""
    manager = get_search_manager()
    
    mock_workflow = MagicMock()
    
    with patch('tools.x402_bazaar.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("API unavailable")
        
        tool_call = {"keyword": "test"}
        tool_call_id = "test-search-error"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Should have pre-execution and error events
        assert len(events) == 2
        assert events[0].status == MessageStatus.IN_PROGRESS
        assert events[1].status == MessageStatus.ERROR
        assert "x402 Bazaar search failed" in events[1].title
        assert "API unavailable" in events[1].message
    
    print("✅ test_search_bazaar_error passed")


async def test_search_activity_filters_own_wallet():
    """Test that search activity filters out our own services."""
    # Mock config with our wallet address
    mock_config = MagicMock()
    mock_config.x402.receiving_wallet = "0xOurWallet123"
    
    # Mock API response with one of our services and one external service
    mock_api_response = {
        "items": [
            {
                "resource": "https://our-service.com/x402/endpoint",
                "accepts": [
                    {
                        "payTo": "0xOurWallet123",  # Our wallet - should be filtered
                        "maxAmountRequired": "100000",
                        "asset": "0xUSDC",
                        "network": "base",
                        "resource": "https://our-service.com/x402/endpoint",
                        "outputSchema": {"input": {"method": "GET", "type": "http"}, "output": None}
                    }
                ],
                "metadata": {},
                "lastUpdated": "2025-01-01T00:00:00Z"
            },
            {
                "resource": "https://external-service.com/x402/api",
                "accepts": [
                    {
                        "payTo": "0xExternalWallet456",  # External wallet - should remain
                        "maxAmountRequired": "200000",
                        "asset": "0xUSDC",
                        "network": "base",
                        "resource": "https://external-service.com/x402/api",
                        "outputSchema": {"input": {"method": "POST", "type": "http"}, "output": None}
                    }
                ],
                "metadata": {},
                "lastUpdated": "2025-01-01T00:00:00Z"
            }
        ]
    }
    
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = mock_api_response
    
    with patch('tools.x402_bazaar.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                result = await search_x402_bazaar_activity()
            
            # Should only have the external service (our service filtered out)
            assert result["service_count"] == 1
            assert len(result["services"]) == 1
            assert result["services"][0]["resource"] == "https://external-service.com/x402/api"
            assert result["services"][0]["pay_to"] == "0xExternalWallet456"
            assert result["filters_applied"]["excluded_own_wallet"] is True
    
    print("✅ test_search_activity_filters_own_wallet passed")


async def test_search_activity_price_filter():
    """Test that search activity filters by max price."""
    mock_config = MagicMock()
    mock_config.x402.receiving_wallet = ""
    
    # Mock API response with services at different price points
    mock_api_response = {
        "items": [
            {
                "resource": "https://cheap.com/api",
                "accepts": [
                    {
                        "payTo": "0xWallet1",
                        "maxAmountRequired": "100000",  # $0.01 (100000 / 10000 = 10 cents)
                        "asset": "0xUSDC",
                        "network": "base",
                        "resource": "https://cheap.com/api",
                        "outputSchema": {"input": {"method": "GET"}, "output": None}
                    }
                ],
                "metadata": {},
            },
            {
                "resource": "https://expensive.com/api",
                "accepts": [
                    {
                        "payTo": "0xWallet2",
                        "maxAmountRequired": "10000000",  # $1.00 (10000000 / 10000 = 1000 cents)
                        "asset": "0xUSDC",
                        "network": "base",
                        "resource": "https://expensive.com/api",
                        "outputSchema": {"input": {"method": "GET"}, "output": None}
                    }
                ],
                "metadata": {},
            }
        ]
    }
    
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = mock_api_response
    
    with patch('tools.x402_bazaar.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                # Filter to max 50 cents - should only return cheap service
                result = await search_x402_bazaar_activity(max_price_cents=50)
            
            assert result["service_count"] == 1
            assert result["services"][0]["resource"] == "https://cheap.com/api"
    
    print("✅ test_search_activity_price_filter passed")


# ========================================
# PAY FOR X402 SERVICE TESTS
# ========================================

async def test_pay_service_success():
    """Test successful x402 service payment execution."""
    manager = get_pay_manager()
    
    mock_workflow = MagicMock()
    
    # Mock successful payment activity result
    mock_result = {
        "response": {"weather": "sunny", "temperature": 72},
        "amount_paid_cents": 10,
        "amount_paid_display": "$0.0010",
        "transaction_id": "tx_123",
        "pay_to": "0xabc123",
        "network": "base",
    }
    
    with patch('tools.x402_bazaar.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "resource_url": "https://api.example.com/x402/weather",
            "method": "GET",
            "params": {"location": "SF"},
            "max_amount_cents": 50
        }
        tool_call_id = "test-pay-123"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Verify events (3 total: pre-message, post-message, usage)
        assert len(events) == 3, f"Expected 3 events, got {len(events)}"
        
        # Pre-execution event
        assert events[0].type == EventType.POST_MESSAGE
        assert events[0].title == "💳 Calling x402 Service"
        assert "https://api.example.com/x402/weather" in events[0].message
        assert "$0.50" in events[0].message  # Max payment
        assert events[0].status == MessageStatus.IN_PROGRESS
        
        # Post-execution event
        assert events[1].type == EventType.POST_MESSAGE
        assert "x402 Service completed" in events[1].title
        assert "$0.10" in events[1].title or "$0.1000" in events[1].title  # Actual cost (10 cents)
        assert events[1].status == MessageStatus.FINISHED
        
        # Usage event (for billing)
        assert events[2].type == EventType.USAGE
        assert events[2].tool_name == "pay_for_x402_bazaar_service"
        assert len(events[2].usage_items) == 1
        assert events[2].usage_items[0].cost_cents == 10
        assert events[2].usage_items[0].provider == "x402 Bazaar (base)"
    
    print("✅ test_pay_service_success passed")


async def test_pay_service_error():
    """Test x402 service payment error handling."""
    manager = get_pay_manager()
    
    mock_workflow = MagicMock()
    
    with patch('tools.x402_bazaar.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("Payment failed: insufficient funds")
        
        tool_call = {
            "resource_url": "https://api.example.com/x402/service",
            "method": "POST",
            "params": {"data": "test"},
            "max_amount_cents": 100
        }
        tool_call_id = "test-pay-error"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Should have pre-execution and error events
        assert len(events) == 2
        assert events[0].status == MessageStatus.IN_PROGRESS
        assert events[1].status == MessageStatus.ERROR
        assert "x402 Service call failed" in events[1].title
        assert "insufficient funds" in events[1].message
    
    print("✅ test_pay_service_error passed")


async def test_pay_activity_free_service():
    """Test activity when service returns 200 without payment."""
    mock_config = MagicMock()
    mock_config.x402.receiving_wallet = "0xOurWallet"
    mock_config.x402.wallet_secret = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtest"  # Mock CDP secret
    
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"result": "free data"}
    
    with patch('tools.x402_bazaar.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                result = await pay_for_x402_service_activity(
                    resource_url="https://api.example.com/free",
                    method="GET",
                    params=None,
                    max_amount_cents=100
                )
            
            assert result["amount_paid_cents"] == 0
            assert result["response"] == {"result": "free data"}
            assert "did not require payment" in result["note"]
    
    print("✅ test_pay_activity_free_service passed")


async def test_pay_activity_no_wallet_key():
    """Test activity fails gracefully without wallet secret."""
    mock_config = MagicMock()
    mock_config.x402.receiving_wallet = "0xOurWallet"
    mock_config.x402.wallet_secret = ""  # No wallet secret
    
    with patch('tools.x402_bazaar.load_config', return_value=mock_config):
        with patch('temporalio.activity.heartbeat'):
            try:
                await pay_for_x402_service_activity(
                    resource_url="https://api.example.com/paid",
                    method="GET",
                    params=None,
                    max_amount_cents=100
                )
                assert False, "Should have raised exception"
            except Exception as e:
                assert "CDP_WALLET_SECRET not configured" in str(e)
    
    print("✅ test_pay_activity_no_wallet_key passed")


async def test_pay_activity_max_amount_exceeded():
    """Test activity fails when service requires more than max amount."""
    mock_config = MagicMock()
    mock_config.x402.receiving_wallet = "0xOurWallet"
    mock_config.x402.wallet_secret = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtest"  # Mock CDP secret
    
    # Initial request returns 402 requiring $1.00
    mock_402_response = MagicMock()
    mock_402_response.status_code = 402
    mock_402_response.headers = {"X-Payment": '{"maxAmountRequired": "10000000", "payTo": "0xReceiver", "asset": "0xUSDC", "network": "base"}'}
    mock_402_response.json.return_value = {}
    
    with patch('tools.x402_bazaar.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.get = AsyncMock(return_value=mock_402_response)
            mock_client_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                try:
                    await pay_for_x402_service_activity(
                        resource_url="https://api.example.com/expensive",
                        method="GET",
                        params=None,
                        max_amount_cents=50  # Only willing to pay $0.50
                    )
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "requires" in str(e).lower() and "max allowed" in str(e).lower()
    
    print("✅ test_pay_activity_max_amount_exceeded passed")


# ========================================
# RUN ALL TESTS
# ========================================

async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING X402_BAZAAR")
    print("="*60 + "\n")
    
    try:
        # Sync tests
        test_search_manager_singleton()
        test_pay_manager_singleton()
        
        # Async tests - Search
        await test_search_bazaar_success()
        await test_search_bazaar_no_filters()
        await test_search_bazaar_error()
        await test_search_activity_filters_own_wallet()
        await test_search_activity_price_filter()
        
        # Async tests - Pay
        await test_pay_service_success()
        await test_pay_service_error()
        await test_pay_activity_free_service()
        await test_pay_activity_no_wallet_key()
        await test_pay_activity_max_amount_exceeded()
        
        print("\n✅ All x402_bazaar tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

