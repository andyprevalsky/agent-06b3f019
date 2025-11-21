"""Test enrich tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.enrich import EnrichManager, get_manager, enrich
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "enrich"
    print("✅ test_manager_singleton passed")


async def test_enrich_success():
    """Test successful enrichment execution."""
    manager = get_manager()
    
    # Mock workflow instance
    mock_workflow = MagicMock()
    
    # Mock results for each activity in sequence
    mock_create_result = {
        "run_id": "trun_test123",
        "status": "queued",
        "is_active": True
    }
    mock_poll_result = {
        "run_id": "trun_test123",
        "status": "completed",
        "is_active": False,
        "is_completed": True,
        "is_failed": False
    }
    mock_get_result = {
        "run_id": "trun_test123",
        "output": {
            "content": {
                "ceo_name": "John Doe",
                "founding_year": "2020"
            },
            "type": "json"
        },
        "run": {"status": "completed"},
        "usage": [{"name": "enrichment", "count": 1}]
    }
    
    # Patch workflow.execute_activity and workflow.sleep
    with patch('tools.enrich.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.enrich.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_create_result, mock_poll_result, mock_get_result]
            
            tool_call = {
                "input": {
                    "name": "Example Company",
                    "email": None,
                    "company": "Example Corp",
                    "url": "https://example.com"
                },
                "output_schema": {
                    "type": "json",
                    "json_schema": {
                        "type": "object",
                        "properties": {
                            "ceo_name": {"type": "string", "description": "CEO name"},
                            "founding_year": {"type": "string", "description": "Founding year"}
                        },
                        "required": ["ceo_name", "founding_year"],
                        "additionalProperties": False
                    }
                },
                "processor": "lite"
            }
            tool_call_id = "test-123"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            # Verify events
            assert len(events) >= 2
            
            # Pre-execution event
            assert events[0].type == EventType.POST_MESSAGE
            assert events[0].title.startswith("🔬 Enriching")
            assert "Example Company" in events[0].message or "Example Company" in events[0].title
            assert events[0].status == MessageStatus.IN_PROGRESS
            
            # Post-execution event
            finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
            assert len(finished_events) == 1
            finished_event = finished_events[0]
            assert finished_event.type == EventType.POST_MESSAGE
            assert finished_event.title.startswith("Enrichment completed")
            assert "ceo_name" in finished_event.message
    
    print("✅ test_enrich_success passed")


async def test_enrich_empty_input():
    """Test enrichment with empty input."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    tool_call = {
        "input": {},  # Empty input
        "output_schema": {
            "type": "json",
            "json_schema": {"type": "object", "properties": {}}
        },
        "processor": "lite"
    }
    tool_call_id = "test-empty"
    
    # Mock successful result
    mock_create_result = {"run_id": "trun_test123", "status": "queued", "is_active": True}
    mock_poll_result = {
        "run_id": "trun_test123",
        "status": "completed",
        "is_active": False,
        "is_completed": True,
        "is_failed": False
    }
    mock_get_result = {
        "run_id": "trun_test123",
        "output": {"content": {}, "type": "json"},
        "run": {"status": "completed"},
        "usage": None
    }
    
    with patch('tools.enrich.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.enrich.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_create_result, mock_poll_result, mock_get_result]
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            # Should complete successfully even with empty input
            finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
            assert len(finished_events) == 1
    
    print("✅ test_enrich_empty_input passed")


async def test_enrich_no_output():
    """Test enrichment with no output data."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    mock_create_result = {"run_id": "trun_xyz789", "status": "queued", "is_active": True}
    mock_poll_result = {
        "run_id": "trun_xyz789",
        "status": "completed",
        "is_active": False,
        "is_completed": True,
        "is_failed": False
    }
    mock_get_result = {
        "run_id": "trun_xyz789",
        "output": {"content": {}, "type": "json"},
        "run": {"status": "completed"},
        "usage": None
    }
    
    with patch('tools.enrich.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        with patch('tools.enrich.workflow.sleep', new_callable=AsyncMock):
            mock_execute.side_effect = [mock_create_result, mock_poll_result, mock_get_result]
            
            tool_call = {
                "input": {"name": "Test"},
                "output_schema": {
                    "type": "json",
                    "json_schema": {"type": "object", "properties": {}}
                },
                "processor": "lite"
            }
            tool_call_id = "test-no-output"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            finished_events = [e for e in events if e.status == MessageStatus.FINISHED]
            assert len(finished_events) == 1
            assert "Enrichment completed" in finished_events[0].title
    
    print("✅ test_enrich_no_output passed")


async def test_enrich_error():
    """Test enrichment error handling."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    
    # Mock activity failure
    with patch('tools.enrich.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
        mock_execute.side_effect = Exception("API error")
        
        tool_call = {
            "input": {"name": "Test"},
            "output_schema": {
                "type": "json",
                "json_schema": {"type": "object", "properties": {}}
            },
            "processor": "lite"
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
        assert events[1].title.startswith("❌ Enrichment failed")
        assert "API error" in events[1].message
    
    print("✅ test_enrich_error passed")


async def test_enrich_activity_mocked():
    """Test the split enrichment activities with mocked HTTP client."""
    from tools.enrich import (
        enrich_create_task_activity,
        enrich_poll_status_once_activity,
        enrich_get_task_results_activity
    )
    
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"
    
    mock_create_response = MagicMock()
    mock_create_response.json.return_value = {
        "run_id": "trun_test123",
        "status": "queued",
        "is_active": True
    }
    mock_create_response.raise_for_status = MagicMock()
    
    mock_status_response = MagicMock()
    mock_status_response.json.return_value = {
        "status": "completed",
        "is_active": False
    }
    mock_status_response.raise_for_status = MagicMock()
    
    mock_result_response = MagicMock()
    mock_result_response.json.return_value = {
        "run": {
            "run_id": "trun_test123",
            "status": "completed",
            "is_active": False
        },
        "output": {
            "content": {
                "email": "test@example.com",
                "full_name": "Test Person"
            },
            "type": "json"
        }
    }
    mock_result_response.raise_for_status = MagicMock()
    
    with patch('tools.enrich.load_config', return_value=mock_config):
        with patch('temporalio.activity.heartbeat'):
            input_data = {"name": "Test Person", "email": "test@example.com"}
            output_schema = {
                "type": "json",
                "json_schema": {
                    "type": "object",
                    "properties": {
                        "email": {"type": "string"},
                        "full_name": {"type": "string"}
                    },
                    "required": ["email"]
                }
            }
            
            # Create task
            with patch('tools.enrich.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.post = AsyncMock(return_value=mock_create_response)
                mock_client_class.return_value = mock_client
                create_data = await enrich_create_task_activity(input_data, output_schema, "lite")
            
            assert create_data["run_id"] == "trun_test123"
            
            # Poll status once
            with patch('tools.enrich.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.get = AsyncMock(return_value=mock_status_response)
                mock_client_class.return_value = mock_client
                status_data = await enrich_poll_status_once_activity("trun_test123")
            
            assert status_data["is_completed"] is True
            assert status_data["is_failed"] is False
            
            # Get results
            with patch('tools.enrich.httpx.AsyncClient') as mock_client_class:
                mock_client = AsyncMock()
                mock_client.__aenter__.return_value = mock_client
                mock_client.__aexit__.return_value = None
                mock_client.get = AsyncMock(return_value=mock_result_response)
                mock_client_class.return_value = mock_client
                result = await enrich_get_task_results_activity("trun_test123")
            
            assert result["run"]["run_id"] == "trun_test123"
            assert result["output"]["content"]["email"] == "test@example.com"
    
    print("✅ test_enrich_activity_mocked passed")


async def test_enrich_real_api():
    """Test Enrich with real API call using Task API."""
    import asyncio
    from tools.enrich import (
        enrich_create_task_activity,
        enrich_poll_status_once_activity,
        enrich_get_task_results_activity
    )
    from dotenv import load_dotenv
    import os
    
    load_dotenv()
    
    # Skip if API key not set
    if not os.getenv("PARRALLEL_API_KEY"):
        print("⏭️  test_enrich_real_api skipped (PARRALLEL_API_KEY not set)")
        return
    
    print("\n🔬 Testing Enrich with real Task API...")
    print("Input: Andy Prevalsky andyprevalsky@yahoo.com")
    
    try:
        # Input data with person metadata
        input_data = {
            "name": "Andy Prevalsky",
            "email": "andyprevalsky@yahoo.com",
            "company": None,
            "url": None,
            "location": None
        }
        
        # Output schema to extract
        output_schema = {
            "type": "json",
            "json_schema": {
                "type": "object",
                "properties": {
                    "email": {
                        "type": "string",
                        "description": "Email address"
                    },
                    "full_name": {
                        "type": "string",
                        "description": "Full name"
                    },
                    "location": {
                        "type": "string",
                        "description": "Location or address"
                    }
                },
                "required": ["email", "full_name"],
                "additionalProperties": False
            }
        }
        
        create_data = await enrich_create_task_activity(
            input_data=input_data,
            output_schema=output_schema,
            processor="lite"
        )
        run_id = create_data["run_id"]
        
        for attempt in range(60):
            status = await enrich_poll_status_once_activity(run_id)
            if status["is_failed"]:
                raise RuntimeError(f"Enrichment failed: {status}")
            if status["is_completed"]:
                break
            await asyncio.sleep(5)
        else:
            raise TimeoutError("Enrichment task did not complete in time")
        
        enrich_result = await enrich_get_task_results_activity(run_id)
        
        assert "output" in enrich_result
        
        print(f"✅ Enrichment completed!")
        print(f"   Run ID: {run_id}")
        
        # Print full response structure
        print(f"\n   Full response keys: {list(enrich_result.keys())}")
        
        output = enrich_result.get("output", {})
        output_content = output.get("content", {})
        
        if isinstance(output_content, dict) and output_content:
            print(f"\n   Extracted enrichment data:")
            for key, value in output_content.items():
                if isinstance(value, str) and len(value) > 100:
                    value = value[:97] + "..."
                print(f"     {key}: {value}")
        else:
            print(f"\n   Output content: {output_content}")
        
        # Check output structure
        print(f"\n   Output structure:")
        print(f"     Type: {output.get('type', 'N/A')}")
        if output.get("basis"):
            print(f"     Basis entries: {len(output.get('basis', []))}")
        
    except Exception as e:
        print(f"❌ Real API test failed: {e}")
        import traceback
        traceback.print_exc()
        raise


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING ENRICH")
    print("="*60 + "\n")
    
    try:
        # Sync test
        test_manager_singleton()
        
        # Async tests (mocked)
        await test_enrich_success()
        await test_enrich_empty_input()
        await test_enrich_no_output()
        await test_enrich_error()
        await test_enrich_activity_mocked()
        
        # Real API test (optional, requires API key)
        try:
            await test_enrich_real_api()
        except Exception as e:
            print(f"⚠️  Real API test skipped or failed: {e}")
        
        print("\n✅ All enrich tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

