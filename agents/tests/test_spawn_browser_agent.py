"""Test spawn_browser_agent tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.spawn_browser_agent import spawn_browser_agent_activity


async def test_activity_success():
    """Test browser activity with mocked Stagehand."""
    # Mock backend API response for session init
    mock_session_response = MagicMock()
    mock_session_response.status_code = 200
    mock_session_response.json.return_value = {
        "session_id": "test-session-123",
        "debug_url": "https://browserbase.com/sessions/test",
        "context_id": "test-context-456"
    }
    
    # Mock backend API response for session close
    mock_close_response = MagicMock()
    mock_close_response.status_code = 200
    
    # Mock Stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.init = AsyncMock()
    mock_stagehand.close = AsyncMock()
    
    # Mock agent
    mock_agent = MagicMock()
    mock_agent.execute = AsyncMock(return_value={
        "success": True,
        "message": "Task completed successfully",
        "actions": [
            {"type": "goto", "url": "https://example.com"},
            {"type": "act", "description": "Click button"}
        ],
        "usage": {
            "input_tokens": 1000,
            "output_tokens": 500
        }
    })
    mock_stagehand.agent.return_value = mock_agent
    
    # Mock config
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    mock_config.browserbase.api_key = "test-bb-key"
    mock_config.browserbase.project_id = "test-project"
    mock_config.openrouter.api_key = "test-or-key"
    
    with patch('tools.spawn_browser_agent.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(side_effect=[mock_session_response, mock_close_response])
            
            with patch('stagehand.Stagehand', return_value=mock_stagehand):
                with patch('temporalio.activity.heartbeat'):
                    with patch('tools.spawn_browser_agent.save_browser_action_message', new_callable=AsyncMock):
                        result = await spawn_browser_agent_activity(
                            user_id="user-123",
                            agent_id="agent-456",
                            instruction="Navigate to example.com and click the login button",
                            tool_call_id="test-tool-call-123"
                        )
            
            assert result["success"] == True
            assert "message" in result
            assert "browser_url" in result
            assert result["usage_items"]  # Should have usage data
    
    print("✅ test_activity_success passed")


async def test_activity_session_init_failure():
    """Test activity when session initialization fails."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Failed to create session"
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.spawn_browser_agent.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                with patch('tools.spawn_browser_agent.save_browser_action_message', new_callable=AsyncMock):
                    try:
                        await spawn_browser_agent_activity(
                            user_id="user-123",
                            agent_id="agent-456",
                            instruction="Navigate to example.com",
                            tool_call_id="test-tool-call-456"
                        )
                        assert False, "Should have raised exception"
                    except Exception as e:
                        assert "Failed to init session" in str(e)
    
    print("✅ test_activity_session_init_failure passed")


async def test_activity_stagehand_failure():
    """Test activity when Stagehand execution fails."""
    # Mock backend API response for session init
    mock_session_response = MagicMock()
    mock_session_response.status_code = 200
    mock_session_response.json.return_value = {
        "session_id": "test-session-123",
        "debug_url": "https://browserbase.com/sessions/test",
        "context_id": "test-context-456"
    }
    
    # Mock Stagehand
    mock_stagehand = MagicMock()
    mock_stagehand.init = AsyncMock()
    mock_stagehand.close = AsyncMock()
    
    # Mock agent that throws error
    mock_agent = MagicMock()
    mock_agent.execute = AsyncMock(side_effect=Exception("Browser automation failed"))
    mock_stagehand.agent.return_value = mock_agent
    
    # Mock config
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    mock_config.browserbase.api_key = "test-bb-key"
    mock_config.browserbase.project_id = "test-project"
    mock_config.openrouter.api_key = "test-or-key"
    
    # Mock close response
    mock_close_response = MagicMock()
    mock_close_response.status_code = 200
    
    with patch('tools.spawn_browser_agent.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(side_effect=[mock_session_response, mock_close_response])
            
            with patch('stagehand.Stagehand', return_value=mock_stagehand):
                with patch('temporalio.activity.heartbeat'):
                    with patch('tools.spawn_browser_agent.save_browser_action_message', new_callable=AsyncMock):
                        try:
                            await spawn_browser_agent_activity(
                                user_id="user-123",
                                agent_id="agent-456",
                                instruction="Navigate to example.com",
                                tool_call_id="test-tool-call-789"
                            )
                            assert False, "Should have raised exception"
                        except Exception as e:
                            assert "Browser automation failed" in str(e)
    
    print("✅ test_activity_stagehand_failure passed")


async def test_activity_usage_tracking():
    """Test that usage is properly tracked."""
    # Mock backend API responses
    mock_session_response = MagicMock()
    mock_session_response.status_code = 200
    mock_session_response.json.return_value = {
        "session_id": "test-session-123",
        "debug_url": "https://browserbase.com/sessions/test",
        "context_id": "test-context-456"
    }
    
    mock_close_response = MagicMock()
    mock_close_response.status_code = 200
    
    # Mock Stagehand with token usage
    mock_stagehand = MagicMock()
    mock_stagehand.init = AsyncMock()
    mock_stagehand.close = AsyncMock()
    
    mock_agent = MagicMock()
    mock_agent.execute = AsyncMock(return_value={
        "success": True,
        "message": "Completed",
        "actions": [],
        "usage": {
            "input_tokens": 2000,
            "output_tokens": 1000
        }
    })
    mock_stagehand.agent.return_value = mock_agent
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    mock_config.browserbase.api_key = "test-bb-key"
    mock_config.browserbase.project_id = "test-project"
    mock_config.openrouter.api_key = "test-or-key"
    
    with patch('tools.spawn_browser_agent.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(side_effect=[mock_session_response, mock_close_response])
            
            with patch('stagehand.Stagehand', return_value=mock_stagehand):
                with patch('temporalio.activity.heartbeat'):
                    with patch('tools.spawn_browser_agent.save_browser_action_message', new_callable=AsyncMock):
                        result = await spawn_browser_agent_activity(
                            user_id="user-123",
                            agent_id="agent-456",
                            instruction="Test",
                            tool_call_id="test-tool-call-usage"
                        )
            
            # Check usage items
            usage_items = result["usage_items"]
            assert len(usage_items) == 3  # Input tokens, output tokens, browserbase session
            
            # Check token pricing
            token_items = [item for item in usage_items if item["type"] == "llm"]
            assert len(token_items) == 2
            
            # Check browserbase cost
            browserbase_items = [item for item in usage_items if item["type"] == "service"]
            assert len(browserbase_items) == 1
    
    print("✅ test_activity_usage_tracking passed")


async def main():
    """Run all tests."""
    print("\n🧪 Running spawn_browser_agent tool tests...\n")
    
    await test_activity_success()
    await test_activity_session_init_failure()
    await test_activity_stagehand_failure()
    await test_activity_usage_tracking()
    
    print("\n✅ All tests passed!\n")


if __name__ == "__main__":
    asyncio.run(main())

