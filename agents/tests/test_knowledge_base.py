"""Test knowledge_base tool (event-driven architecture)."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.knowledge_base import query_blueprints, save_blueprint
from tools.base import EventType, MessageStatus


async def test_query_blueprints_success():
    """Test successful blueprint query."""
    workflow_instance = MagicMock()
    workflow_instance._handle_tool_event = AsyncMock()
    
    # Mock blueprints result
    mock_blueprints = [
        {"id": "1", "title": "Build a website"},
        {"id": "2", "title": "Create API"},
        {"id": "3", "title": "Setup database"}
    ]
    
    with patch('tools.knowledge_base.workflow.uuid4', return_value="test-123"):
        with patch('tools.knowledge_base.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = mock_blueprints
            
            context = [{"role": "USER", "text": "Build a web app"}]
            result = await query_blueprints(workflow_instance, context, "user-123", 3)
            
            # Should return blueprints
            assert result == mock_blueprints
            
            # Should have posted 2 events
            assert workflow_instance._handle_tool_event.call_count == 2
            
            # Check pre-execution event
            pre_call = workflow_instance._handle_tool_event.call_args_list[0]
            pre_event = pre_call[0][0]
            assert pre_event.type == EventType.POST_MESSAGE
            assert "Querying Knowledge Base" in pre_event.title
            assert pre_event.status == MessageStatus.IN_PROGRESS
            
            # Check post-execution event
            post_call = workflow_instance._handle_tool_event.call_args_list[1]
            post_event = post_call[0][0]
            assert post_event.type == EventType.POST_MESSAGE
            assert "Found 3 similar goals" in post_event.title
            assert "Build a website" in post_event.message
            assert post_event.status == MessageStatus.FINISHED
    
    print("✅ test_query_blueprints_success passed")


async def test_query_blueprints_no_results():
    """Test blueprint query with no results."""
    workflow_instance = MagicMock()
    workflow_instance._handle_tool_event = AsyncMock()
    
    with patch('tools.knowledge_base.workflow.uuid4', return_value="test-123"):
        with patch('tools.knowledge_base.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = []
            
            context = [{"role": "USER", "text": "Build a web app"}]
            result = await query_blueprints(workflow_instance, context, "user-123", 3)
            
            # Should return empty list
            assert result == []
            
            # Check post-execution event
            post_call = workflow_instance._handle_tool_event.call_args_list[1]
            post_event = post_call[0][0]
            assert "No similar goals found" in post_event.title
            assert post_event.status == MessageStatus.FINISHED
    
    print("✅ test_query_blueprints_no_results passed")


async def test_query_blueprints_failure():
    """Test error handling when query fails."""
    workflow_instance = MagicMock()
    workflow_instance._handle_tool_event = AsyncMock()
    
    with patch('tools.knowledge_base.workflow.uuid4', return_value="test-123"):
        with patch('tools.knowledge_base.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.side_effect = Exception("Database connection failed")
            
            context = [{"role": "USER", "text": "Build a web app"}]
            result = await query_blueprints(workflow_instance, context, "user-123", 3)
            
            # Should return empty list on error
            assert result == []
            
            # Should have posted 2 events: pre and error
            assert workflow_instance._handle_tool_event.call_count == 2
            
            error_call = workflow_instance._handle_tool_event.call_args_list[1]
            error_event = error_call[0][0]
            assert error_event.status == MessageStatus.ERROR
            assert "Knowledge base query failed" in error_event.title
            assert "Database connection failed" in error_event.message
    
    print("✅ test_query_blueprints_failure passed")


async def test_save_blueprint_success():
    """Test successful blueprint save."""
    workflow_instance = MagicMock()
    workflow_instance._handle_tool_event = AsyncMock()
    
    mock_result = {
        "saved_blueprint": {"id": "blueprint-123", "title": "Web app created"},
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150
        }
    }
    
    with patch('tools.knowledge_base.workflow.uuid4', return_value="test-123"):
        with patch('tools.knowledge_base.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = mock_result
            
            steps = [
                {"role": "USER", "text": "Build a web app"},
                {"role": "ASSISTANT", "text": "Created the app"}
            ]
            
            result = await save_blueprint(workflow_instance, "user-123", steps)
            
            # Should return the result with usage data
            assert result == mock_result
            assert result["usage"]["total_tokens"] == 150
            
            # Should have posted 2 events: pre and post
            assert workflow_instance._handle_tool_event.call_count == 2
            
            # Check pre-execution event
            pre_call = workflow_instance._handle_tool_event.call_args_list[0]
            pre_event = pre_call[0][0]
            assert pre_event.type == EventType.POST_MESSAGE
            assert "Saving route to goal" in pre_event.title
            assert pre_event.status == MessageStatus.IN_PROGRESS
            
            # Check post-execution event
            post_call = workflow_instance._handle_tool_event.call_args_list[1]
            post_event = post_call[0][0]
            assert post_event.type == EventType.POST_MESSAGE
            assert "Route to goal saved" in post_event.title
            assert post_event.status == MessageStatus.FINISHED
    
    print("✅ test_save_blueprint_success passed")


async def test_save_blueprint_failure():
    """Test error handling when save fails."""
    workflow_instance = MagicMock()
    workflow_instance._handle_tool_event = AsyncMock()
    
    with patch('tools.knowledge_base.workflow.uuid4', return_value="test-123"):
        with patch('tools.knowledge_base.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.side_effect = Exception("Failed to save to database")
            
            steps = [{"role": "USER", "text": "Build a web app"}]
            
            try:
                await save_blueprint(workflow_instance, "user-123", steps)
                assert False, "Should have raised exception"
            except Exception as e:
                assert "Failed to save to database" in str(e)
            
            # Should have posted 2 events: pre and error
            assert workflow_instance._handle_tool_event.call_count == 2
            
            error_call = workflow_instance._handle_tool_event.call_args_list[1]
            error_event = error_call[0][0]
            assert error_event.type == EventType.POST_MESSAGE
            assert error_event.status == MessageStatus.ERROR
            assert "Failed to save route" in error_event.title
            assert "Failed to save to database" in error_event.message
    
    print("✅ test_save_blueprint_failure passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING KNOWLEDGE_BASE")
    print("="*60 + "\n")
    
    try:
        await test_query_blueprints_success()
        await test_query_blueprints_no_results()
        await test_query_blueprints_failure()
        await test_save_blueprint_success()
        await test_save_blueprint_failure()
        
        print("\n✅ All knowledge_base tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

