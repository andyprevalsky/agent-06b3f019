"""Test read_message_history_with_person tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.read_message_history import read_message_history_activity


async def test_activity_success_with_messages():
    """Test activity with person found and messages present."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "person": {
            "id": "person-123",
            "firstName": "John",
            "lastName": "Doe",
            "phoneNumber": "+19729777432",
            "email": "john@example.com"
        },
        "messages": [
            {
                "channel": "IMESSAGE",
                "from": "+19729777432",
                "to": "+14155551234",
                "timestamp": "2025-01-15T10:30:00Z",
                "message": "Hey, how are you?"
            },
            {
                "channel": "EMAIL",
                "from": "john@example.com",
                "to": "user@example.com",
                "timestamp": "2025-01-14T15:00:00Z",
                "message": "Meeting tomorrow at 3pm"
            }
        ],
        "count": 2
    }
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.read_message_history.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                result = await read_message_history_activity(
                    user_id="user-123",
                    phone="+19729777432"
                )
            
            assert result["person"] is not None
            assert result["person"]["firstName"] == "John"
            assert len(result["messages"]) == 2
            assert result["count"] == 2
    
    print("✅ test_activity_success_with_messages passed")


async def test_activity_no_person_found():
    """Test activity when no person is found."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "person": None,
        "messages": [],
        "message": "No person found matching: +19729777432"
    }
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.read_message_history.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                result = await read_message_history_activity(
                    user_id="user-123",
                    phone="+19729777432"
                )
            
            assert result["person"] is None
            assert len(result["messages"]) == 0
            assert "No person found" in result["message"]
    
    print("✅ test_activity_no_person_found passed")


async def test_activity_person_no_messages():
    """Test activity when person exists but has no messages."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "person": {
            "id": "person-123",
            "firstName": "Jane",
            "lastName": "Smith",
            "phoneNumber": "+14155551234",
            "email": "jane@example.com"
        },
        "messages": [],
        "message": "No messages present for Jane Smith"
    }
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.read_message_history.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                result = await read_message_history_activity(
                    user_id="user-123",
                    first_name="Jane",
                    last_name="Smith"
                )
            
            assert result["person"] is not None
            assert result["person"]["firstName"] == "Jane"
            assert len(result["messages"]) == 0
            assert "No messages present" in result["message"]
    
    print("✅ test_activity_person_no_messages passed")


async def test_activity_by_email():
    """Test activity searching by email."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "person": {
            "id": "person-456",
            "firstName": "Bob",
            "lastName": "Wilson",
            "phoneNumber": None,
            "email": "bob@example.com"
        },
        "messages": [
            {
                "channel": "EMAIL",
                "from": "bob@example.com",
                "to": "user@example.com",
                "timestamp": "2025-01-10T09:00:00Z",
                "message": "Project update"
            }
        ],
        "count": 1
    }
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.read_message_history.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                result = await read_message_history_activity(
                    user_id="user-123",
                    email="bob@example.com"
                )
            
            assert result["person"] is not None
            assert result["person"]["email"] == "bob@example.com"
            assert len(result["messages"]) == 1
    
    print("✅ test_activity_by_email passed")


async def test_activity_api_failure():
    """Test activity when backend API fails."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.json.return_value = {"error": "Internal server error"}
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.read_message_history.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                try:
                    await read_message_history_activity(
                        user_id="user-123",
                        phone="+19729777432"
                    )
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "Internal server error" in str(e)
    
    print("✅ test_activity_api_failure passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING READ_MESSAGE_HISTORY")
    print("="*60 + "\n")
    
    try:
        await test_activity_success_with_messages()
        await test_activity_no_person_found()
        await test_activity_person_no_messages()
        await test_activity_by_email()
        await test_activity_api_failure()
        
        print("\n✅ All read_message_history tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

