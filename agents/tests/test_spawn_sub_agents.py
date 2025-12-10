"""Test spawn_sub_agents tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.spawn_sub_agents import (
    get_manager,
    SpawnSubAgentsManager,
    spawn_sub_agents_activity
)
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that get_manager returns singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert isinstance(manager1, SpawnSubAgentsManager)
    print("✅ test_manager_singleton passed")


async def test_spawn_sub_agents_success():
    """Test successful spawning of sub-agents with full child tracking."""
    manager = get_manager()
    
    # Mock workflow instance with child tracking
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-123"
    mock_workflow.agent_id = "parent-agent-456"
    mock_workflow.depth = 0
    mock_workflow.is_paused = False
    mock_workflow.child_tool_ids = {}
    mock_workflow.pending_children = set()
    mock_workflow._post_message = AsyncMock()
    
    # Mock workflow info
    mock_info = MagicMock()
    mock_info.workflow_id = "parent-workflow-789"
    
    # Mock activity result
    mock_result = {
        "spawned": 2,
        "completed": 2,
        "failed": 0,
        "agents": [
            {
                "agent_id": "sub-agent-1",
                "temporal_workflow_id": "workflow-1",
                "goal": "Research topic A",
                "model": "gpt-4",
                "status": "RUNNING"
            },
            {
                "agent_id": "sub-agent-2",
                "temporal_workflow_id": "workflow-2",
                "goal": "Research topic B",
                "model": "gpt-4",
                "status": "RUNNING"
            }
        ]
    }
    
    # Track uuid4 calls
    uuid_counter = 0
    def mock_uuid4():
        nonlocal uuid_counter
        uuid_counter += 1
        return f"tool-call-{uuid_counter}"
    
    with patch('tools.spawn_sub_agents.workflow.info', return_value=mock_info):
        with patch('tools.spawn_sub_agents.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
            with patch('tools.spawn_sub_agents.workflow.uuid4', side_effect=mock_uuid4):
                with patch('tools.spawn_sub_agents.workflow.wait_condition', new_callable=AsyncMock) as mock_wait:
                    mock_execute.return_value = mock_result
                    
                    # Simulate signals removing children from pending
                    async def wait_and_clear(*args, **kwargs):
                        mock_workflow.pending_children.clear()
                    mock_wait.side_effect = wait_and_clear
                    
                    tool_call = {
                        "sub_agents": [
                            {
                                "goal": "Research topic A",
                                "model": "gpt-4",
                                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Evaluate results"}
                            },
                            {
                                "goal": "Research topic B",
                                "model": "gpt-4",
                                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Evaluate results"}
                            }
                        ]
                    }
                    tool_call_id = "test-123"
                    
                    events = []
                    async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                        events.append(event)
                    
                    # Verify events
                    assert len(events) == 2  # Pre and spawned summary
                    
                    # Pre-execution
                    assert events[0].type == EventType.POST_MESSAGE
                    assert "🚀 Spawning 2 sub-agents" in events[0].title
                    assert "Research topic A" in events[0].message
                    assert "Research topic B" in events[0].message
                    assert events[0].status == MessageStatus.IN_PROGRESS
                    
                    # Spawned summary
                    assert events[1].type == EventType.POST_MESSAGE
                    assert "⭐ Spawned 2 sub-agents" in events[1].title
                    assert events[1].status == MessageStatus.FINISHED
                    
                    # Verify child tracking was set up
                    assert len(mock_workflow.child_tool_ids) == 2
                    assert "sub-agent-1" in mock_workflow.child_tool_ids
                    assert "sub-agent-2" in mock_workflow.child_tool_ids
                    
                    # Verify initial messages were posted
                    assert mock_workflow._post_message.call_count == 2
    
    print("✅ test_spawn_sub_agents_success passed")


async def test_spawn_sub_agents_partial_failure():
    """Test spawning with some failures - only successful agents get tracked."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-123"
    mock_workflow.agent_id = "parent-agent-456"
    mock_workflow.depth = 0
    mock_workflow.is_paused = False
    mock_workflow.child_tool_ids = {}
    mock_workflow.pending_children = set()
    mock_workflow._post_message = AsyncMock()
    
    mock_info = MagicMock()
    mock_info.workflow_id = "parent-workflow-789"
    
    # Mock result with mixed success/failure
    mock_result = {
        "spawned": 3,
        "completed": 2,
        "failed": 1,
        "agents": [
            {"agent_id": "sub-agent-1", "goal": "Task 1", "status": "RUNNING"},
            {"agent_id": "sub-agent-2", "goal": "Task 2", "status": "RUNNING"},
            {"error": "API error", "goal": "Task 3", "status": "FAILED"}
        ]
    }
    
    uuid_counter = 0
    def mock_uuid4():
        nonlocal uuid_counter
        uuid_counter += 1
        return f"tool-call-{uuid_counter}"
    
    with patch('tools.spawn_sub_agents.workflow.info', return_value=mock_info):
        with patch('tools.spawn_sub_agents.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
            with patch('tools.spawn_sub_agents.workflow.uuid4', side_effect=mock_uuid4):
                with patch('tools.spawn_sub_agents.workflow.wait_condition', new_callable=AsyncMock) as mock_wait:
                    mock_execute.return_value = mock_result
                    
                    async def wait_and_clear(*args, **kwargs):
                        mock_workflow.pending_children.clear()
                    mock_wait.side_effect = wait_and_clear
                    
                    tool_call = {
                        "sub_agents": [
                            {"goal": "Task 1", "verifier": {"type": "FLOAT_LLM_JUDGE"}},
                            {"goal": "Task 2", "verifier": {"type": "FLOAT_LLM_JUDGE"}},
                            {"goal": "Task 3", "verifier": {"type": "FLOAT_LLM_JUDGE"}}
                        ]
                    }
                    tool_call_id = "test-456"
                    
                    events = []
                    async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                        events.append(event)
                    
                    # Spawned summary
                    final_event = events[-1]
                    assert "⭐ Spawned 3 sub-agents" in final_event.title
                    assert final_event.status == MessageStatus.FINISHED
                    
                    # Only successful agents should be tracked
                    assert len(mock_workflow.child_tool_ids) == 2
                    assert "sub-agent-1" in mock_workflow.child_tool_ids
                    assert "sub-agent-2" in mock_workflow.child_tool_ids
    
    print("✅ test_spawn_sub_agents_partial_failure passed")


async def test_spawn_sub_agents_empty_list():
    """Test spawning with empty sub-agents list."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-123"
    
    tool_call = {"sub_agents": []}
    tool_call_id = "test-789"
    
    events = []
    async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
        events.append(event)
    
    # Should have error event
    assert len(events) == 1
    assert events[0].type == EventType.POST_MESSAGE
    assert "No sub-agents specified" in events[0].message
    assert events[0].status == MessageStatus.ERROR
    
    print("✅ test_spawn_sub_agents_empty_list passed")


async def test_spawn_sub_agents_activity_exception():
    """Test exception handling in spawn activity."""
    manager = get_manager()
    
    mock_workflow = MagicMock()
    mock_workflow.user_id = "test-user-123"
    mock_workflow.agent_id = "parent-agent-456"
    mock_workflow.depth = 0
    mock_workflow.is_paused = False
    mock_workflow.child_tool_ids = {}
    mock_workflow.pending_children = set()
    
    mock_info = MagicMock()
    mock_info.workflow_id = "parent-workflow-789"
    
    with patch('tools.spawn_sub_agents.workflow.info', return_value=mock_info):
        with patch('tools.spawn_sub_agents.workflow.execute_activity', new_callable=AsyncMock) as mock_execute:
            mock_execute.side_effect = Exception("Backend API error")
            
            tool_call = {
                "sub_agents": [
                    {"goal": "Task 1", "verifier": {"type": "FLOAT_LLM_JUDGE"}}
                ]
            }
            tool_call_id = "test-error"
            
            events = []
            async for event in manager.execute_tool(mock_workflow, tool_call, tool_call_id):
                events.append(event)
            
            # Should have error event
            assert len(events) >= 2
            assert events[-1].status == MessageStatus.ERROR
            assert "Backend API error" in events[-1].message
    
    print("✅ test_spawn_sub_agents_activity_exception passed")


async def test_spawn_agents_activity_http_success():
    """Test spawn_sub_agents_activity with mocked HTTP calls."""
    
    # Mock HTTP responses
    mock_response_1 = MagicMock()
    mock_response_1.status_code = 200
    mock_response_1.json.return_value = {
        "agent_id": "agent-1",
        "temporal_workflow_id": "workflow-1",
        "goal": "Research AI",
        "model": "gpt-4",
        "status": "RUNNING"
    }
    
    mock_response_2 = MagicMock()
    mock_response_2.status_code = 200
    mock_response_2.json.return_value = {
        "agent_id": "agent-2",
        "temporal_workflow_id": "workflow-2",
        "goal": "Research ML",
        "model": "gpt-4",
        "status": "RUNNING"
    }
    
    # Mock httpx.AsyncClient
    with patch('tools.spawn_sub_agents.httpx.AsyncClient') as mock_client_class:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[mock_response_1, mock_response_2])
        mock_client_class.return_value = mock_client
        
        with patch('tools.spawn_sub_agents.activity.heartbeat'):
            result = await spawn_sub_agents_activity(
                user_id="test-user",
                sub_agents=[
                    {"goal": "Research AI", "verifier": {"type": "FLOAT_LLM_JUDGE"}},
                    {"goal": "Research ML", "verifier": {"type": "FLOAT_LLM_JUDGE"}}
                ],
                parent_agent_id="parent-123",
                parent_workflow_id="workflow-456",
                depth=1,
                parent_is_paused=False
            )
            
            # Verify result structure
            assert result["spawned"] == 2
            assert result["completed"] == 2
            assert result["failed"] == 0
            assert len(result["agents"]) == 2
            assert result["agents"][0]["agent_id"] == "agent-1"
            assert result["agents"][1]["agent_id"] == "agent-2"
    
    print("✅ test_spawn_agents_activity_http_success passed")


async def test_spawn_agents_activity_http_partial_failure():
    """Test spawn activity with some HTTP failures."""
    
    # First request succeeds, second fails
    mock_response_1 = MagicMock()
    mock_response_1.status_code = 200
    mock_response_1.json.return_value = {
        "agent_id": "agent-1",
        "temporal_workflow_id": "workflow-1",
        "goal": "Task 1",
        "model": "gpt-4",
        "status": "RUNNING"
    }
    
    # Second request throws exception
    http_error = Exception("Network timeout")
    
    with patch('tools.spawn_sub_agents.httpx.AsyncClient') as mock_client_class:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock()
        
        # Use asyncio.gather's behavior - return exceptions inline
        async def mock_post(*args, **kwargs):
            # Simulate gather behavior by returning results in order
            pass
        
        # Mock the gather to return [success, exception]
        with patch('tools.spawn_sub_agents.asyncio.gather', new_callable=AsyncMock) as mock_gather:
            mock_gather.return_value = [mock_response_1, http_error]
            
            mock_client_class.return_value = mock_client
            
            with patch('tools.spawn_sub_agents.activity.heartbeat'):
                result = await spawn_sub_agents_activity(
                    user_id="test-user",
                    sub_agents=[
                        {"goal": "Task 1", "verifier": {"type": "FLOAT_LLM_JUDGE"}},
                        {"goal": "Task 2", "verifier": {"type": "FLOAT_LLM_JUDGE"}}
                    ],
                    parent_agent_id="parent-123",
                    parent_workflow_id="workflow-456",
                    depth=1,
                    parent_is_paused=False
                )
                
                # Should have 1 success and 1 failure
                assert result["spawned"] == 2
                assert result["completed"] == 1
                assert result["failed"] == 1
                assert result["agents"][0]["status"] == "RUNNING"
                assert result["agents"][1]["status"] == "FAILED"
    
    print("✅ test_spawn_agents_activity_http_partial_failure passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SPAWN_SUB_AGENTS")
    print("="*60 + "\n")
    
    try:
        # Sync test for singleton
        test_manager_singleton()
        
        # Async tests
        await test_spawn_sub_agents_success()
        await test_spawn_sub_agents_partial_failure()
        await test_spawn_sub_agents_empty_list()
        await test_spawn_sub_agents_activity_exception()
        await test_spawn_agents_activity_http_success()
        await test_spawn_agents_activity_http_partial_failure()
        
        print("\n✅ All spawn_sub_agents tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

