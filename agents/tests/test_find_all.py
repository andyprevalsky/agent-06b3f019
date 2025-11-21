"""Test find_all tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.find_all import FindAllManager, get_manager, find_all
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "find_all"
    print("✅ test_manager_singleton passed")


async def test_find_all_success():
    """Test successful Find All execution."""
    manager = get_manager()
    
    # Mock workflow instance
    mock_workflow = MagicMock()
    
    # Mock results for each activity in sequence
    mock_ingest_result = {
        "entity_type": "companies",
        "match_conditions": [{"name": "test", "description": "test"}]
    }
    mock_create_result = {
        "findall_id": "findall_abc123"
    }
    mock_poll_result = {
        "is_completed": True,
        "is_failed": False,
        "generated_candidates_count": 2,
        "matched_candidates_count": 2,
        "status": {"status": "completed", "is_active": False}
    }
    mock_get_result = {
        "candidates": [
            {
                "candidate_id": "candidate_1",
                "name": "Example Company",
                "description": "A great company",
                "url": "https://example.com",
                "match_status": "matched",
                "output": {},
                "basis": []
            },
            {
                "candidate_id": "candidate_2",
                "name": "Another Company",
                "description": "Another great company",
                "url": "https://another.com",
                "match_status": "matched",
                "output": {},
                "basis": []
            }
        ],
        "usage": [{"name": "sku_search", "count": 1}]
    }
    
    # Patch workflow.execute_activity and workflow.sleep
    with patch('tools.find_all.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.find_all.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_ingest_result, mock_create_result, mock_poll_result, mock_get_result]
            
            tool_call = {
                "objective": "Find all AI startups in San Francisco",
                "generator": "core",
                "match_limit": 10
            }
            tool_call_id = "test-123"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            # Verify events
            assert len(events) >= 2
            
            # Pre-execution event
            assert events[0].type == EventType.POST_MESSAGE
            assert events[0].title.startswith("🔍 Finding All")
            assert "AI startups" in events[0].message or "AI startups" in events[0].title
            assert events[0].status == MessageStatus.IN_PROGRESS
            
            # Usage event (if usage is present)
            usage_events = [e for e in events if e.type == EventType.USAGE]
            if usage_events:
                assert len(usage_events) == 1
            
            # Post-execution event
            finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
            assert len(finished_events) == 1
            finished_event = finished_events[0]
            assert finished_event.type == EventType.POST_MESSAGE
            assert finished_event.title.startswith("Find All completed")
            assert "findall_abc123" in finished_event.message
            assert "Example Company" in finished_event.message
            assert "Find All ID" in finished_event.message
    
    print("✅ test_find_all_success passed")


async def test_find_all_no_candidates():
    """Test Find All with no candidates found."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    mock_ingest_result = {"entity_type": "companies", "match_conditions": []}
    mock_create_result = {"findall_id": "findall_xyz789"}
    mock_poll_result = {"is_completed": True, "is_failed": False, "generated_candidates_count": 0, "matched_candidates_count": 0, "status": {}}
    mock_get_result = {"candidates": [], "usage": []}
    
    with patch('tools.find_all.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.find_all.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_ingest_result, mock_create_result, mock_poll_result, mock_get_result]
            
            tool_call = {
                "objective": "Find companies that don't exist",
                "generator": "core",
                "match_limit": 10
            }
            tool_call_id = "test-456"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
            assert len(finished_events) == 1
            assert "Found 0 candidates" in finished_events[0].message
            assert "findall_xyz789" in finished_events[0].message
    
    print("✅ test_find_all_no_candidates passed")


async def test_find_all_many_candidates():
    """Test Find All with many candidates (should show first 5)."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    # Create 10 candidates
    mock_candidates = [
        {
            "candidate_id": f"candidate_{i}",
            "name": f"Company {i}",
            "description": f"Description {i}",
            "url": f"https://company{i}.com",
            "match_status": "matched",
            "output": {},
            "basis": []
        }
        for i in range(10)
    ]
    
    mock_ingest_result = {"entity_type": "companies", "match_conditions": []}
    mock_create_result = {"findall_id": "findall_many"}
    mock_poll_result = {"is_completed": True, "is_failed": False, "generated_candidates_count": 10, "matched_candidates_count": 10, "status": {}}
    mock_get_result = {"candidates": mock_candidates, "usage": []}
    
    with patch('tools.find_all.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.find_all.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_ingest_result, mock_create_result, mock_poll_result, mock_get_result]
            
            tool_call = {
                "objective": "Find many companies",
                "generator": "base",
                "match_limit": 10
            }
            tool_call_id = "test-many"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
            message = finished_events[0].message
            assert "Company 0" in message
            assert "Company 4" in message
            assert "and 5 more" in message
    
    print("✅ test_find_all_many_candidates passed")


async def test_find_all_long_objective():
    """Test Find All with long objective (should truncate for display)."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    long_objective = "A" * 150  # Very long objective
    
    mock_ingest_result = {"entity_type": "companies", "match_conditions": []}
    mock_create_result = {"findall_id": "findall_long"}
    mock_poll_result = {"is_completed": True, "is_failed": False, "generated_candidates_count": 0, "matched_candidates_count": 0, "status": {}}
    mock_get_result = {"candidates": [], "usage": []}
    
    with patch('tools.find_all.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.find_all.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_ingest_result, mock_create_result, mock_poll_result, mock_get_result]
            
            tool_call = {
                "objective": long_objective,
                "generator": "core",
                "match_limit": 10
            }
            tool_call_id = "test-long"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            # Pre-execution message should have truncated objective with "..."
            assert len(events[0].message) < len(long_objective) + 50
            assert "..." in events[0].message
    
    print("✅ test_find_all_long_objective passed")


async def test_find_all_error():
    """Test Find All error handling."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    # Mock activity failure on first call (ingest)
    with patch('tools.find_all.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("API error")
        
        tool_call = {
            "objective": "test",
            "generator": "core",
            "match_limit": 10
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
        assert events[1].title.startswith("❌ Find All failed")
        assert "API error" in events[1].message
    
    print("✅ test_find_all_error passed")


async def test_find_all_activity_mocked():
    """Test the individual Find All activities with mocked HTTP client."""
    from tools.find_all import (
        find_all_ingest_activity,
        find_all_create_run_activity,
        find_all_poll_status_once_activity,
        find_all_get_results_activity
    )
    
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"
    
    mock_ingest_response = MagicMock()
    mock_ingest_response.json.return_value = {
        "entity_type": "companies",
        "match_conditions": [
            {"name": "test_check", "description": "Test condition"}
        ]
    }
    mock_ingest_response.raise_for_status = MagicMock()
    
    mock_create_response = MagicMock()
    mock_create_response.json.return_value = {
        "findall_id": "findall_test123"
    }
    mock_create_response.raise_for_status = MagicMock()
    
    mock_status_response = MagicMock()
    mock_status_response.json.return_value = {
        "status": {
            "status": "completed",
            "is_active": False,
            "metrics": {
                "generated_candidates_count": 1,
                "matched_candidates_count": 1
            }
        }
    }
    mock_status_response.raise_for_status = MagicMock()
    
    mock_result_response = MagicMock()
    mock_result_response.json.return_value = {
        "candidates": [
            {
                "candidate_id": "candidate_1",
                "name": "Test Company",
                "description": "Test description",
                "url": "https://test.com",
                "match_status": "matched",
                "output": {},
                "basis": []
            }
        ],
        "usage": []
    }
    mock_result_response.raise_for_status = MagicMock()
    
    with patch('tools.find_all.load_config', return_value=mock_config):
        with patch('temporalio.activity.heartbeat'):
            # Ingest activity
            with patch('tools.find_all.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.post = AsyncMock(return_value=mock_ingest_response)
                mock_client_class.return_value = mock_client
                ingest_data = await find_all_ingest_activity("Find test companies")
            
            assert ingest_data["entity_type"] == "companies"
            assert len(ingest_data["match_conditions"]) == 1
            
            # Create run activity
            with patch('tools.find_all.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.post = AsyncMock(return_value=mock_create_response)
                mock_client_class.return_value = mock_client
                create_data = await find_all_create_run_activity(
                    "Find test companies",
                    ingest_data["entity_type"],
                    ingest_data["match_conditions"],
                    "core",
                    10
                )
            
            assert create_data["findall_id"] == "findall_test123"
            
            # Poll status once activity
            with patch('tools.find_all.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.get = AsyncMock(return_value=mock_status_response)
                mock_client_class.return_value = mock_client
                poll_data = await find_all_poll_status_once_activity("findall_test123")
            
            assert poll_data["status"]["is_active"] is False
            assert poll_data["matched_candidates_count"] == 1
            
            # Get results activity
            with patch('tools.find_all.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.get = AsyncMock(return_value=mock_result_response)
                mock_client_class.return_value = mock_client
                result_data = await find_all_get_results_activity("findall_test123")
            
            assert len(result_data["candidates"]) == 1
            assert result_data["candidates"][0]["name"] == "Test Company"
    
    print("✅ test_find_all_activity_mocked passed")


async def test_find_all_real_api():
    """Test Find All with real API call."""
    import asyncio
    from tools.find_all import (
        find_all_ingest_activity,
        find_all_create_run_activity,
        find_all_poll_status_once_activity,
        find_all_get_results_activity
    )
    from dotenv import load_dotenv
    import os
    
    load_dotenv()
    
    # Skip if API key not set
    if not os.getenv("PARRALLEL_API_KEY"):
        print("⏭️  test_find_all_real_api skipped (PARRALLEL_API_KEY not set)")
        return
    
    print("\n🔍 Testing Find All with real API...")
    print("Objective: Find all gym owners that own a boxing and muay thai gym in Coppell Texas")
    
    try:
        objective = "Find all gym owners that own a boxing and muay thai gym in Coppell Texas"
        ingest_data = await find_all_ingest_activity(objective)
        create_data = await find_all_create_run_activity(
            objective=objective,
            entity_type=ingest_data["entity_type"],
            match_conditions=ingest_data["match_conditions"],
            generator="preview",
            match_limit=5
        )
        findall_id = create_data["findall_id"]
        
        print(f"   Find All ID: {findall_id}")
        
        # Poll until completed (with max attempts safeguard)
        for attempt in range(60):  # Up to ~5 minutes with 5s sleeps
            status = await find_all_poll_status_once_activity(findall_id)
            if status["is_failed"]:
                raise RuntimeError(f"Find All run failed: {status['status']}")
            if status["is_completed"]:
                break
            await asyncio.sleep(5)
        else:
            raise TimeoutError("Find All run did not complete in time")
        
        result = await find_all_get_results_activity(findall_id)
        result_payload = {"findall_id": findall_id, **result}
        
        assert "candidates" in result_payload
        assert isinstance(result_payload["candidates"], list)
        
        print(f"✅ Find All completed!")
        print(f"   Candidates found: {len(result_payload['candidates'])}")
        
        # Print full response structure
        print(f"\n   Full response keys: {list(result_payload.keys())}")
        if result_payload.get("status"):
            print(f"   Status: {result_payload['status']}")
        if result_payload.get("usage"):
            print(f"   Usage: {result_payload['usage']}")
        
        if result_payload["candidates"]:
            print(f"\n   First candidate structure:")
            first_candidate = result_payload['candidates'][0]
            print(f"     Keys: {list(first_candidate.keys())}")
            print(f"     Name: {first_candidate.get('name', 'N/A')}")
            print(f"     Description: {first_candidate.get('description', 'N/A')[:100] if first_candidate.get('description') else 'N/A'}")
            print(f"     URL: {first_candidate.get('url', 'N/A')}")
            print(f"     Match status: {first_candidate.get('match_status', 'N/A')}")
            if first_candidate.get('output'):
                print(f"     Output: {first_candidate.get('output')}")
            if first_candidate.get('basis'):
                print(f"     Basis count: {len(first_candidate.get('basis', []))}")
        
        return result_payload  # Return for use in enrich/enrich tests
        
    except Exception as e:
        print(f"❌ Real API test failed: {e}")
        import traceback
        traceback.print_exc()
        raise


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING FIND_ALL")
    print("="*60 + "\n")
    
    try:
        # Sync test
        test_manager_singleton()
        
        # Async tests (mocked)
        await test_find_all_success()
        await test_find_all_no_candidates()
        await test_find_all_many_candidates()
        await test_find_all_long_objective()
        await test_find_all_error()
        await test_find_all_activity_mocked()
        
        # Real API test (optional, requires API key)
        try:
            real_result = await test_find_all_real_api()
            # Store result for enrich test if needed
            if real_result:
                import os
                os.environ["TEST_FINDALL_ID"] = real_result["findall_id"]
        except Exception as e:
            print(f"⚠️  Real API test skipped or failed: {e}")
        
        print("\n✅ All find_all tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

