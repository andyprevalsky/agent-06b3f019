"""Test send_email tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.send_email import send_email_activity


async def test_activity_success():
    """Test email activity with mocked backend call."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "success": True,
        "messageId": "msg-123456",
        "threadId": "thread-789",
    }

    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"

    with patch('tools.send_email.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)

            with patch('temporalio.activity.heartbeat'):
                result = await send_email_activity(
                    "user-123",
                    "recipient@example.com",
                    "Test Subject",
                    "Hello, this is a test email.",
                    None
                )

            assert result["messageId"] == "msg-123456"
            assert result["threadId"] == "thread-789"
            assert result["to"] == "recipient@example.com"
            assert result["subject"] == "Test Subject"

    print("✅ test_activity_success passed")


async def test_activity_gmail_not_connected():
    """Test activity raises exception when Gmail is not connected."""
    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.json.return_value = {
        "error": "Gmail not connected",
        "message": "Connect your Gmail in order to allow Rose to send emails on your behalf. To connect your Gmail click on the hamburger icon > Integrations > Connect Gmail",
    }

    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"

    with patch('tools.send_email.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)

            with patch('temporalio.activity.heartbeat'):
                try:
                    await send_email_activity(
                        "user-123",
                        "recipient@example.com",
                        "Test Subject",
                        "Test body",
                        None
                    )
                    assert False, "Should have raised exception"
                except Exception as e:
                    # Should contain the helpful error message
                    assert "Gmail" in str(e) or "hamburger" in str(e)

    print("✅ test_activity_gmail_not_connected passed")


async def test_activity_with_cc():
    """Test email activity with CC field."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "success": True,
        "messageId": "msg-cc-123",
        "threadId": "thread-cc-456",
    }

    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"

    with patch('tools.send_email.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)

            with patch('temporalio.activity.heartbeat'):
                result = await send_email_activity(
                    "user-123",
                    "recipient@example.com",
                    "Test with CC",
                    "Email with CC recipient.",
                    "cc@example.com"
                )

            assert result["messageId"] == "msg-cc-123"

            # Verify CC was included in the request
            call_args = mock_instance.post.call_args
            assert call_args is not None
            request_json = call_args.kwargs.get("json", {})
            assert request_json.get("cc") == "cc@example.com"

    print("✅ test_activity_with_cc passed")


async def test_activity_api_error():
    """Test activity raises exception on backend server error."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.json.return_value = {
        "error": "Internal server error",
    }

    mock_config = MagicMock()
    mock_config.backend.api_url = "http://test-backend"
    mock_config.backend.api_key = "test-key"

    with patch('tools.send_email.load_config', return_value=mock_config):
        with patch('httpx.AsyncClient') as mock_client:
            mock_instance = mock_client.return_value.__aenter__.return_value
            mock_instance.post = AsyncMock(return_value=mock_response)

            with patch('temporalio.activity.heartbeat'):
                try:
                    await send_email_activity(
                        "user-123",
                        "recipient@example.com",
                        "Test Subject",
                        "Test body",
                        None
                    )
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "error" in str(e).lower() or "500" in str(e)

    print("✅ test_activity_api_error passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("🧪 TESTING SEND_EMAIL")
    print("=" * 60 + "\n")

    try:
        # Async tests for activity
        await test_activity_success()
        await test_activity_gmail_not_connected()
        await test_activity_with_cc()
        await test_activity_api_error()

        print("\n✅ All send_email tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
