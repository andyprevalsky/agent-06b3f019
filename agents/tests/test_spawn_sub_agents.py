"""Test spawn_sub_agents tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.spawn_sub_agents import SubAgentSpawner
from tools.spawn_sub_agents_formatters import format_pre_message, format_post_message


async def test_sub_agent_spawner_init():
    """Test SubAgentSpawner initialization."""
    with patch('tools.spawn_sub_agents.load_config') as mock_config:
        config_mock = MagicMock()
        config_mock.backend.api_url = "http://localhost:3001"
        config_mock.backend.api_key = "test-api-key"
        mock_config.return_value = config_mock
        
        spawner = SubAgentSpawner()
        
        assert spawner.backend_url == "http://localhost:3001"
        assert spawner.api_key == "test-api-key"
    
    print("✅ test_sub_agent_spawner_init passed")


async def test_spawn_agents_success():
    """Test spawning sub-agents with mocked HTTP calls."""
    with patch('tools.spawn_sub_agents.load_config') as mock_config:
        config_mock = MagicMock()
        config_mock.backend.api_url = "http://localhost:3001"
        config_mock.backend.api_key = "test-api-key"
        mock_config.return_value = config_mock
        
        spawner = SubAgentSpawner()
        
        # Mock successful HTTP responses
        mock_response1 = MagicMock()
        mock_response1.status_code = 201
        mock_response1.json.return_value = {
            "agent_id": "agent1",
            "temporal_workflow_id": "wf1",
            "goal": "Task 1",
            "model": "anthropic/claude-sonnet-4.5",
            "status": "ACTIVE"
        }
        mock_response1.raise_for_status = MagicMock()
        
        mock_response2 = MagicMock()
        mock_response2.status_code = 201
        mock_response2.json.return_value = {
            "agent_id": "agent2",
            "temporal_workflow_id": "wf2",
            "goal": "Task 2",
            "model": "anthropic/claude-sonnet-4.5",
            "status": "ACTIVE"
        }
        mock_response2.raise_for_status = MagicMock()
        
        sub_agents = [
            {
                "goal": "Task 1",
                "model": "anthropic/claude-sonnet-4.5",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "test"}
            },
            {
                "goal": "Task 2",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "test"}
            }
        ]
        
        with patch('asyncio.gather', new_callable=AsyncMock) as mock_gather:
            mock_gather.return_value = [mock_response1, mock_response2]
            
            with patch('temporalio.activity.heartbeat'):
                with patch('httpx.AsyncClient'):
                    result = await spawner.spawn_agents(
                        user_id="test_user",
                        sub_agents=sub_agents,
                        parent_agent_id="parent123",
                        parent_workflow_id="parent_wf",
                        depth=1,
                        parent_is_paused=False
                    )
            
            assert len(result) == 2
            assert result[0]["agent_id"] == "agent1"
            assert result[1]["agent_id"] == "agent2"
    
    print("✅ test_spawn_agents_success passed")


async def test_spawn_agents_partial_failure():
    """Test spawning sub-agents with one failure."""
    with patch('tools.spawn_sub_agents.load_config') as mock_config:
        config_mock = MagicMock()
        config_mock.backend.api_url = "http://localhost:3001"
        config_mock.backend.api_key = "test-api-key"
        mock_config.return_value = config_mock
        
        spawner = SubAgentSpawner()
        
        # Mock one success and one failure
        mock_response_success = MagicMock()
        mock_response_success.status_code = 201
        mock_response_success.json.return_value = {
            "agent_id": "agent1",
            "temporal_workflow_id": "wf1",
            "goal": "Task 1",
            "model": "anthropic/claude-sonnet-4.5",
            "status": "ACTIVE"
        }
        mock_response_success.raise_for_status = MagicMock()
        
        mock_exception = Exception("API error")
        
        sub_agents = [
            {"goal": "Task 1", "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "test"}},
            {"goal": "Task 2", "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "test"}}
        ]
        
        with patch('asyncio.gather', new_callable=AsyncMock) as mock_gather:
            mock_gather.return_value = [mock_response_success, mock_exception]
            
            with patch('temporalio.activity.heartbeat'):
                with patch('httpx.AsyncClient'):
                    result = await spawner.spawn_agents(
                        user_id="test_user",
                        sub_agents=sub_agents,
                        parent_agent_id="parent123",
                        parent_workflow_id="parent_wf",
                        depth=1,
                        parent_is_paused=False
                    )
            
            assert len(result) == 2
            assert result[0]["agent_id"] == "agent1"
            assert result[1]["status"] == "FAILED"
            assert "error" in result[1]
    
    print("✅ test_spawn_agents_partial_failure passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {
        "sub_agents": [
            {
                "goal": "Research topic A",
                "model": "anthropic/claude-sonnet-4.5",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "test"}
            },
            {
                "goal": "Research topic B",
                "model": "anthropic/claude-sonnet-4.5",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "test"}
            }
        ]
    }
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "2" in result["title"] or "agents" in result["title"].lower()
    
    print("✅ test_format_pre_message passed")


def test_format_post_message_success():
    """Test post-message formatting with successful spawn."""
    tool_call = {
        "sub_agents": [
            {"goal": "Task 1"},
            {"goal": "Task 2"}
        ]
    }
    result_data = {
        "spawned_agents": [
            {"agent_id": "agent1", "goal": "Task 1"},
            {"agent_id": "agent2", "goal": "Task 2"}
        ]
    }
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_post_message_success passed")


def test_format_post_message_error():
    """Test post-message formatting with error."""
    tool_call = {"sub_agents": [{"goal": "Task 1"}]}
    result_data = "Error: Failed to spawn sub-agents"
    
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_post_message_error passed")


async def run_all_tests():
    """Run all spawn_sub_agents tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SPAWN_SUB_AGENTS TOOL")
    print("="*60 + "\n")
    
    try:
        # Async tests for SubAgentSpawner
        await test_sub_agent_spawner_init()
        await test_spawn_agents_success()
        await test_spawn_agents_partial_failure()
        
        # Sync tests for formatters
        test_format_pre_message()
        test_format_post_message_success()
        test_format_post_message_error()
        
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

