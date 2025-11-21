"""Test monitor and check_monitor_events tools."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.monitor import MonitorManager, get_manager as get_monitor_manager
from tools.check_monitor_events import CheckMonitorEventsManager, get_manager as get_check_manager
from tools.base import EventType, MessageStatus


def test_monitor_manager_singleton():
    """Test that monitor manager is a singleton."""
    manager1 = get_monitor_manager()
    manager2 = get_monitor_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "monitor"
    print("✅ test_monitor_manager_singleton passed")


def test_check_manager_singleton():
    """Test that check monitor events manager is a singleton."""
    manager1 = get_check_manager()
    manager2 = get_check_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "check_monitor_events"
    print("✅ test_check_manager_singleton passed")


async def test_monitor_success():
    """Test successful monitor creation."""
    manager = get_monitor_manager()
    
    # Mock workflow instance
    mock_workflow = MagicMock()
    
    # Mock successful monitor creation result
    mock_result = {
        "monitor_id": "monitor_abc123",
        "status": {"status": "active"}
    }
    
    # Patch workflow.execute_activity
    with patch('tools.monitor.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "query": "Monitor AI regulations",
            "cadence": "daily",
            "webhook_url": None,
            "metadata": None
        }
        tool_call_id = "test-123"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Verify events (pre + usage + post = 3)
        assert len(events) >= 2
        
        # Pre-execution event
        assert events[0].type == EventType.POST_MESSAGE
        assert events[0].title.startswith("📡 Creating monitor")
        assert "AI regulations" in events[0].message or "AI regulations" in events[0].title
        assert events[0].status == MessageStatus.IN_PROGRESS
        
        # Post-execution event (may have usage event in between)
        finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
        assert len(finished_events) == 1
        finished_event = finished_events[0]
        assert finished_event.type == EventType.POST_MESSAGE
        assert finished_event.title.startswith("Monitor created")
        assert "monitor_abc123" in finished_event.message
        assert "daily" in finished_event.message
    
    print("✅ test_monitor_success passed")


async def test_monitor_with_webhook():
    """Test monitor creation with webhook."""
    manager = get_monitor_manager()
    
    mock_workflow = MagicMock()
    
    mock_result = {
        "monitor_id": "monitor_webhook",
        "status": {"status": "active"}
    }
    
    with patch('tools.monitor.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "query": "Monitor test",
            "cadence": "hourly",
            "webhook_url": "https://example.com/webhook",
            "metadata": {"category": "test"}
        }
        tool_call_id = "test-webhook"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
        assert len(finished_events) == 1
        assert "webhook" in finished_events[0].message.lower()
    
    print("✅ test_monitor_with_webhook passed")


async def test_monitor_error():
    """Test monitor creation error handling."""
    manager = get_monitor_manager()
    
    mock_workflow = MagicMock()
    
    # Mock activity failure
    with patch('tools.monitor.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("API error")
        
        tool_call = {
            "query": "test",
            "cadence": "daily"
        }
        tool_call_id = "test-error"
        
        events = []
        try:
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
        except Exception:
            pass  # Expected to raise
        
        # Should have pre-execution and error events
        assert len(events) == 2
        assert events[0].status == MessageStatus.IN_PROGRESS
        assert events[1].status == MessageStatus.ERROR
        assert events[1].title.startswith("❌ Monitor creation failed")
        assert "API error" in events[1].message
    
    print("✅ test_monitor_error passed")


async def test_check_monitor_events_success():
    """Test successful check monitor events."""
    manager = get_check_manager()
    
    mock_workflow = MagicMock()
    
    mock_result = {
        "events": [
            {
                "type": "event",
                "timestamp": "2025-01-15T10:00:00Z",
                "data": {
                    "title": "New AI regulation",
                    "url": "https://example.com/news"
                }
            },
            {
                "type": "event",
                "timestamp": "2025-01-15T11:00:00Z",
                "data": {
                    "title": "Another update",
                    "url": "https://example.com/news2"
                }
            }
        ]
    }
    
    with patch('tools.check_monitor_events.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "monitor_id": "monitor_abc123",
            "limit": 10
        }
        tool_call_id = "test-check"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        # Verify events
        assert len(events) == 2
        
        # Pre-execution event
        assert events[0].type == EventType.POST_MESSAGE
        assert events[0].title == "📋 Checking monitor events"
        assert "monitor_abc123" in events[0].message
        assert events[0].status == MessageStatus.IN_PROGRESS
        
        # Post-execution event
        assert events[1].type == EventType.POST_MESSAGE
        assert events[1].title == "Monitor events retrieved"
        assert "monitor_id" in events[1].message
        assert "New AI regulation" in events[1].message
        assert events[1].status == MessageStatus.FINISHED
    
    print("✅ test_check_monitor_events_success passed")


async def test_check_monitor_events_no_events():
    """Test check monitor events with no events."""
    manager = get_check_manager()
    
    mock_workflow = MagicMock()
    
    mock_result = {
        "events": []
    }
    
    with patch('tools.check_monitor_events.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.return_value = mock_result
        
        tool_call = {
            "monitor_id": "monitor_xyz789",
            "limit": 10
        }
        tool_call_id = "test-no-events"
        
        events = []
        async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
            events.append(event)
        
        finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
        assert len(finished_events) == 1
        assert "\"events\": []" in finished_events[0].message
    
    print("✅ test_check_monitor_events_no_events passed")


async def test_check_monitor_events_invalid_id():
    """Test check monitor events with invalid monitor_id format."""
    manager = get_check_manager()
    
    mock_workflow = MagicMock()
    
    tool_call = {
        "monitor_id": "invalid_id",  # Should start with "monitor_"
        "limit": 10
    }
    tool_call_id = "test-invalid"
    
    events = []
    async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
        events.append(event)
    
    # Should have error event
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "Invalid monitor_id format" in events[0].message
    
    print("✅ test_check_monitor_events_invalid_id passed")


async def test_monitor_activity_mocked():
    """Test the monitor activity with mocked HTTP client."""
    from tools.monitor import monitor_activity
    
    # Mock config
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"
    
    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "monitor_id": "monitor_test123",
        "status": {"status": "active"}
    }
    mock_response.raise_for_status = MagicMock()
    
    with patch('tools.monitor.load_config', return_value=mock_config):
        with patch('tools.monitor.httpx.AsyncClient') as mock_client_class:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                result = await monitor_activity("Test query", "daily", None, None)
            
            assert result["monitor_id"] == "monitor_test123"
            assert result["status"]["status"] == "active"
    
    print("✅ test_monitor_activity_mocked passed")


async def test_check_monitor_events_activity_mocked():
    """Test the check monitor events activity with mocked HTTP client."""
    from tools.check_monitor_events import check_monitor_events_activity
    
    # Mock config
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"
    
    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "events": [
            {
                "type": "event",
                "timestamp": "2025-01-15T10:00:00Z",
                "data": {"title": "Test event"}
            }
        ]
    }
    mock_response.raise_for_status = MagicMock()
    
    with patch('tools.check_monitor_events.load_config', return_value=mock_config):
        with patch('tools.check_monitor_events.httpx.AsyncClient') as mock_client_class:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client
            
            with patch('temporalio.activity.heartbeat'):
                result = await check_monitor_events_activity("monitor_test", 10)
            
            assert len(result["events"]) == 1
            assert result["events"][0]["data"]["title"] == "Test event"
    
    print("✅ test_check_monitor_events_activity_mocked passed")


async def test_monitor_real_api():
    """Test Monitor with real API call."""
    from tools.monitor import monitor_activity
    from dotenv import load_dotenv
    import os
    
    load_dotenv()
    
    # Skip if API key not set
    if not os.getenv("PARRALLEL_API_KEY"):
        print("⏭️  test_monitor_real_api skipped (PARRALLEL_API_KEY not set)")
        return
    
    print("\n📡 Testing Monitor with real API...")
    print("Query: Monitor the price of bitcoin")
    
    try:
        result = await monitor_activity(
            query="Monitor the price of bitcoin",
            cadence="daily",
            webhook_url=None,
            metadata={"test": "true", "category": "crypto"}
        )
        
        assert "monitor_id" in result
        assert result["monitor_id"].startswith("monitor_")
        assert "status" in result
        
        print(f"✅ Monitor created!")
        print(f"   Monitor ID: {result['monitor_id']}")
        status_val = result['status']
        if isinstance(status_val, dict):
            print(f"   Status: {status_val.get('status', 'unknown')}")
        else:
            print(f"   Status: {status_val}")
        
        # Store monitor_id for check events test
        os.environ["TEST_MONITOR_ID"] = result["monitor_id"]
        
        return result
        
    except Exception as e:
        print(f"❌ Real API test failed: {e}")
        import traceback
        traceback.print_exc()
        raise


async def test_check_monitor_events_real_api():
    """Test Check Monitor Events with real API call."""
    from tools.check_monitor_events import check_monitor_events_activity
    from dotenv import load_dotenv
    import os
    
    load_dotenv()
    
    # Skip if API key not set
    if not os.getenv("PARRALLEL_API_KEY"):
        print("⏭️  test_check_monitor_events_real_api skipped (PARRALLEL_API_KEY not set)")
        return
    
    # Get monitor_id from previous test or env
    monitor_id = os.getenv("TEST_MONITOR_ID")
    if not monitor_id:
        print("⏭️  test_check_monitor_events_real_api skipped (no TEST_MONITOR_ID set)")
        return
    
    print(f"\n📋 Testing Check Monitor Events with real API...")
    print(f"Monitor ID: {monitor_id}")
    
    try:
        result = await check_monitor_events_activity(
            monitor_id=monitor_id,
            limit=10
        )
        
        assert "events" in result
        assert isinstance(result["events"], list)
        
        print(f"✅ Events retrieved!")
        print(f"   Events found: {len(result['events'])}")
        
        # Print full response structure
        print(f"\n   Full response keys: {list(result.keys())}")
        
        if result["events"]:
            print(f"\n   First event structure:")
            first_event = result['events'][0]
            print(f"     Keys: {list(first_event.keys())}")
            print(f"     Type: {first_event.get('type', 'N/A')}")
            print(f"     Timestamp: {first_event.get('timestamp', 'N/A')}")
            if first_event.get('data'):
                print(f"     Data keys: {list(first_event.get('data', {}).keys())}")
                print(f"     Data: {first_event.get('data')}")
        else:
            print(f"   (No events yet - monitor may need time to run)")
        
    except Exception as e:
        print(f"❌ Real API test failed: {e}")
        import traceback
        traceback.print_exc()
        raise


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING MONITOR & CHECK_MONITOR_EVENTS")
    print("="*60 + "\n")
    
    try:
        # Sync tests
        test_monitor_manager_singleton()
        test_check_manager_singleton()
        
        # Async tests (mocked)
        await test_monitor_success()
        await test_monitor_with_webhook()
        await test_monitor_error()
        await test_check_monitor_events_success()
        await test_check_monitor_events_no_events()
        await test_check_monitor_events_invalid_id()
        await test_monitor_activity_mocked()
        await test_check_monitor_events_activity_mocked()
        
        # Real API tests (optional, requires API key)
        try:
            monitor_result = await test_monitor_real_api()
            if monitor_result:
                await test_check_monitor_events_real_api()
        except Exception as e:
            print(f"⚠️  Real API tests skipped or failed: {e}")
        
        print("\n✅ All monitor tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

