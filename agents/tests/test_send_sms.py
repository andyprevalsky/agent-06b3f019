"""Test send_sms tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.send_sms import send_sms_activity


async def test_activity_success():
    """Test SMS activity with mocked backend call."""
    # Mock backend API response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "success": True,
        "phone_number": "+19729777432",
        "message_id": "msg-123456"
    }
    
    # Mock config
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.send_sms.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                result = await send_sms_activity("+19729777432", "Test message")
            
            assert result["success"] == True
            assert "phone_number" in result
            assert result["message_id"] == "msg-123456"
    
    print("✅ test_activity_success passed")


async def test_activity_invalid_phone():
    """Test activity with invalid phone number."""
    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.text = "Invalid phone number"
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.send_sms.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                try:
                    await send_sms_activity("invalid", "Test")
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "Backend API error" in str(e)
    
    print("✅ test_activity_invalid_phone passed")


async def test_activity_sms_api_failure():
    """Test activity when backend API fails."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal server error"
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.send_sms.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                try:
                    await send_sms_activity("+19729777432", "Test")
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "Backend API error" in str(e)
    
    print("✅ test_activity_sms_api_failure passed")


async def test_activity_response_format():
    """Test that response has correct format."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "success": True,
        "phone_number": "+19729777432",
        "message_id": "msg-test"
    }
    
    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"
    
    with patch('tools.send_sms.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)
            
            with patch('temporalio.activity.heartbeat'):
                result = await send_sms_activity("+19729777432", "Test")
            
            # Verify response structure
            assert "success" in result
            assert "phone_number" in result
            assert "message_id" in result
            assert result["success"] == True
            assert result["message_id"] == "msg-test"
    
    print("✅ test_activity_response_format passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SEND_SMS")
    print("="*60 + "\n")
    
    try:
        await test_activity_success()
        await test_activity_invalid_phone()
        await test_activity_sms_api_failure()
        await test_activity_response_format()
        
        print("\n✅ All send_sms tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

