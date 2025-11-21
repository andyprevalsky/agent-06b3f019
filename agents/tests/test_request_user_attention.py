"""Test request_user_attention tool (event-driven architecture)."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.request_user_attention import (
    RequestUserAttentionManager,
    get_manager,
    create_attention_request_activity,
)
from tools.base import EventType, MessageStatus


async def test_manager_singleton():
    """Test manager singleton pattern."""
    manager1 = get_manager()
    manager2 = get_manager()
    
    assert manager1 is manager2
    assert isinstance(manager1, RequestUserAttentionManager)
    assert manager1.tool_name == "request_user_attention"
    
    print("✅ test_manager_singleton passed")


async def test_execute_tool_success():
    """Test successful attention request and user response."""
    manager = get_manager()
    
    # Mock workflow instance
    workflow_instance = MagicMock()
    workflow_instance.user_id = "user-123"
    workflow_instance.agent_id = "agent-456"
    workflow_instance.context = []
    
    # Mock workflow.info
    mock_info = MagicMock()
    mock_info.workflow_id = "workflow-789"
    
    # Mock workflow.execute_activity
    with patch('tools.request_user_attention.workflow.info', return_value=mock_info):
        with patch('tools.request_user_attention.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = "request-123"
            
            # Mock workflow.wait_condition to simulate user response
            with patch('tools.request_user_attention.workflow.wait_condition', new_callable=AsyncMock) as mock_wait:
                # Simulate user adding a message to context
                async def simulate_user_response(condition):
                    workflow_instance.context.append({
                        "role": "USER",
                        "text": "Here is my answer"
                    })
                
                mock_wait.side_effect = simulate_user_response
                
                tool_call = {
                    "question": "What is your preference?",
                    "image_url": "https://example.com/image.jpg"
                }
                tool_call_id = "test-123"
                
                events = []
                async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
                    events.append(event)
                
                # Should have 2 events: pre and post
                assert len(events) == 2
                
                # Check pre-execution event
                pre_event = events[0]
                assert pre_event.type == EventType.POST_MESSAGE
                assert "Requesting user attention" in pre_event.title
                assert pre_event.message == "What is your preference?"
                assert pre_event.status == MessageStatus.IN_PROGRESS
                
                # Check post-execution event
                post_event = events[1]
                assert post_event.type == EventType.POST_MESSAGE
                assert "User message received" in post_event.title
                assert post_event.status == MessageStatus.FINISHED
                
                # Verify activity was called with correct args
                mock_activity.assert_called_once()
    
    print("✅ test_execute_tool_success passed")


async def test_execute_tool_empty_question():
    """Test attention request with empty question."""
    manager = get_manager()
    
    workflow_instance = MagicMock()
    
    tool_call = {"question": ""}
    tool_call_id = "test-123"
    
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        events.append(event)
    
    # Should have 1 error event
    assert len(events) == 1
    error_event = events[0]
    assert error_event.type == EventType.POST_MESSAGE
    assert error_event.status == MessageStatus.ERROR
    assert "Invalid attention request" in error_event.title
    assert "Question is required" in error_event.message
    
    print("✅ test_execute_tool_empty_question passed")


async def test_execute_tool_activity_failure():
    """Test error handling when activity fails."""
    manager = get_manager()
    
    workflow_instance = MagicMock()
    workflow_instance.user_id = "user-123"
    workflow_instance.agent_id = "agent-456"
    
    mock_info = MagicMock()
    mock_info.workflow_id = "workflow-789"
    
    with patch('tools.request_user_attention.workflow.info', return_value=mock_info):
        with patch('tools.request_user_attention.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.side_effect = Exception("Database connection failed")
            
            tool_call = {"question": "What is your preference?"}
            tool_call_id = "test-123"
            
            events = []
            async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
                events.append(event)
            
            # Should have 1 error event when creation fails
            assert len(events) == 1
            
            error_event = events[0]
            assert error_event.type == EventType.POST_MESSAGE
            assert error_event.status == MessageStatus.ERROR
            assert "Failed to create attention request" in error_event.title
            assert "Database connection failed" in error_event.message
    
    print("✅ test_execute_tool_activity_failure passed")


async def test_execute_tool_wait_failure():
    """Test error handling when waiting for user response fails."""
    manager = get_manager()
    
    workflow_instance = MagicMock()
    workflow_instance.user_id = "user-123"
    workflow_instance.agent_id = "agent-456"
    
    mock_info = MagicMock()
    mock_info.workflow_id = "workflow-789"
    
    with patch('tools.request_user_attention.workflow.info', return_value=mock_info):
        with patch('tools.request_user_attention.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = "request-123"
            
            with patch('tools.request_user_attention.workflow.wait_condition', new_callable=AsyncMock) as mock_wait:
                mock_wait.side_effect = Exception("Timeout waiting for response")
                
                tool_call = {"question": "What is your preference?"}
                tool_call_id = "test-123"
                
                events = []
                async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
                    events.append(event)
                
                # Should have 2 events: pre and error
                assert len(events) == 2
                
                error_event = events[1]
                assert error_event.type == EventType.POST_MESSAGE
                assert error_event.status == MessageStatus.ERROR
                assert "Failed waiting for user response" in error_event.title
    
    print("✅ test_execute_tool_wait_failure passed")


async def test_execute_tool_multiple_user_messages():
    """Test handling multiple consecutive user messages."""
    manager = get_manager()
    
    workflow_instance = MagicMock()
    workflow_instance.user_id = "user-123"
    workflow_instance.agent_id = "agent-456"
    workflow_instance.context = []
    
    mock_info = MagicMock()
    mock_info.workflow_id = "workflow-789"
    
    with patch('tools.request_user_attention.workflow.info', return_value=mock_info):
        with patch('tools.request_user_attention.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = "request-123"
            
            with patch('tools.request_user_attention.workflow.wait_condition', new_callable=AsyncMock) as mock_wait:
                # Simulate multiple user messages
                async def simulate_multiple_responses(condition):
                    workflow_instance.context.extend([
                        {"role": "ASSISTANT", "text": "Previous message"},
                        {"role": "USER", "text": "First message"},
                        {"role": "USER", "text": "Second message"},
                        {"role": "USER", "text": "Third message"}
                    ])
                
                mock_wait.side_effect = simulate_multiple_responses
                
                tool_call = {"question": "What do you think?"}
                tool_call_id = "test-123"
                
                events = []
                async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
                    events.append(event)
                
                # Should successfully handle multiple messages
                assert len(events) == 2
                assert events[1].status == MessageStatus.FINISHED
    
    print("✅ test_execute_tool_multiple_user_messages passed")


async def test_activity_success():
    """Test create_attention_request_activity with mocked HTTP call."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"id": "request-123"}
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            result = await create_attention_request_activity(
                user_id="user-123",
                agent_id="agent-456",
                workflow_id="workflow-789",
                question="What is your preference?",
                image_url="https://example.com/image.jpg"
            )
        
        assert result == "request-123"
    
    print("✅ test_activity_success passed")


async def test_activity_http_error():
    """Test activity error handling with HTTP error."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal server error"
    mock_response.raise_for_status.side_effect = Exception("HTTP 500")
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            try:
                await create_attention_request_activity(
                    user_id="user-123",
                    agent_id="agent-456",
                    workflow_id="workflow-789",
                    question="Test question"
                )
                assert False, "Should have raised an exception"
            except Exception as e:
                assert "HTTP 500" in str(e)
    
    print("✅ test_activity_http_error passed")


async def test_execute_tool_with_image():
    """Test attention request with image URL."""
    manager = get_manager()
    
    workflow_instance = MagicMock()
    workflow_instance.user_id = "user-123"
    workflow_instance.agent_id = "agent-456"
    workflow_instance.context = []
    
    mock_info = MagicMock()
    mock_info.workflow_id = "workflow-789"
    
    with patch('tools.request_user_attention.workflow.info', return_value=mock_info):
        with patch('tools.request_user_attention.workflow.execute_activity', new_callable=AsyncMock) as mock_activity:
            mock_activity.return_value = "request-123"
            
            with patch('tools.request_user_attention.workflow.wait_condition', new_callable=AsyncMock) as mock_wait:
                async def simulate_user_response(condition):
                    workflow_instance.context.append({
                        "role": "USER",
                        "text": "Looks good!"
                    })
                
                mock_wait.side_effect = simulate_user_response
                
                tool_call = {
                    "question": "Do you like this product?",
                    "image_url": "https://example.com/product.jpg"
                }
                tool_call_id = "test-123"
                
                events = []
                async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
                    events.append(event)
                
                # Verify activity was called with image_url
                assert len(events) == 2
                assert events[1].status == MessageStatus.FINISHED
                
                # Check that activity was called with image_url
                call_args = mock_activity.call_args[1]['args']
                assert call_args[4] == "https://example.com/product.jpg"
    
    print("✅ test_execute_tool_with_image passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING REQUEST_USER_ATTENTION")
    print("="*60 + "\n")
    
    try:
        await test_manager_singleton()
        await test_execute_tool_success()
        await test_execute_tool_empty_question()
        await test_execute_tool_activity_failure()
        await test_execute_tool_wait_failure()
        await test_execute_tool_multiple_user_messages()
        await test_activity_success()
        await test_activity_http_error()
        await test_execute_tool_with_image()
        
        print("\n✅ All request_user_attention tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

