"""Test search_user_network_for_people tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.search_user_network import (
    search_user_network_activity,
    format_pre_message,
    format_post_message
)


async def test_activity_success():
    """Test activity with mocked backend API call."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "results": [
            {
                "firstName": "Sarah",
                "lastName": "Chen",
                "profession": "Venture Capitalist",
                "company": "Sequoia Capital",
                "title": "Partner",
                "email": "sarah@sequoia.com",
                "similarity": 0.95,
            }
        ],
        "count": 1,
        "query": {
            "first_name": "Sarah",
            "last_name": "Chen",
            "profession": "venture capitalist"
        }
    }
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            result = await search_user_network_activity(
                user_id="test-user-123",
                agent_id="test-agent-456",
                tool_call={
                    "first_name": "Sarah",
                    "last_name": "Chen",
                    "profession": "venture capitalist"
                }
            )
        
        assert result["count"] == 1
        assert len(result["results"]) == 1
        assert result["results"][0]["firstName"] == "Sarah"
        assert result["results"][0]["lastName"] == "Chen"
    
    print("✅ test_activity_success passed")


async def test_activity_no_matches():
    """Test activity when no matches found."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "results": [],
        "count": 0,
        "query": {"first_name": "NonExistent", "last_name": "Person"}
    }
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            result = await search_user_network_activity(
                user_id="test-user-123",
                agent_id="test-agent-456",
                tool_call={
                    "first_name": "NonExistent",
                    "last_name": "Person"
                }
            )
        
        assert result["count"] == 0
        assert result["results"] == []
    
    print("✅ test_activity_no_matches passed")


async def test_activity_missing_required_fields():
    """Test activity with missing required fields."""
    with patch('temporalio.activity.heartbeat'):
        result = await search_user_network_activity(
            user_id="test-user-123",
            agent_id="test-agent-456",
            tool_call={
                "profession": "engineer"  # Missing first_name and last_name
            }
        )
    
    assert "error" in result
    assert result["count"] == 0
    assert "required" in result["error"].lower()
    
    print("✅ test_activity_missing_required_fields passed")


async def test_activity_api_error():
    """Test activity error handling."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            result = await search_user_network_activity(
                user_id="test-user-123",
                agent_id="test-agent-456",
                tool_call={
                    "first_name": "Test",
                    "last_name": "User"
                }
            )
        
        assert "error" in result
        assert result["count"] == 0
    
    print("✅ test_activity_api_error passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {
        "first_name": "Sarah",
        "last_name": "Chen",
        "profession": "venture capitalist",
        "company": "Sequoia Capital",
        "skills": ["fundraising", "networking"]
    }
    result = format_pre_message(tool_call)
    
    assert "title" in result
    assert "message" in result
    assert "Searching" in result["title"]
    assert "Sarah Chen" in result["message"]
    assert "venture capitalist" in result["message"]
    assert "Sequoia Capital" in result["message"]
    
    print("✅ test_format_pre_message passed")


def test_format_post_message_success():
    """Test post-message formatting with results."""
    tool_call = {
        "first_name": "Sarah",
        "last_name": "Chen"
    }
    result_data = {
        "count": 1,
        "results": [
            {
                "firstName": "Sarah",
                "lastName": "Chen",
                "profession": "Venture Capitalist",
                "company": "Sequoia Capital",
                "title": "Partner",
                "email": "sarah@sequoia.com",
                "similarity": 0.95,
            }
        ],
        "query": {"first_name": "Sarah", "last_name": "Chen"}
    }
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    assert "Complete" in result["title"]
    assert "Sarah Chen" in result["message"]
    assert "Partner at Sequoia Capital" in result["message"]
    
    print("✅ test_format_post_message_success passed")


def test_format_post_message_no_results():
    """Test post-message formatting with no results."""
    tool_call = {
        "first_name": "NonExistent",
        "last_name": "Person"
    }
    result_data = {
        "count": 0,
        "results": [],
        "query": {"first_name": "NonExistent", "last_name": "Person"}
    }
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    assert "No matching" in result["message"]
    
    print("✅ test_format_post_message_no_results passed")


def test_format_post_message_error():
    """Test post-message formatting with error."""
    tool_call = {
        "first_name": "Test",
        "last_name": "User"
    }
    result_data = {
        "error": "API connection failed",
        "count": 0,
        "results": []
    }
    result = format_post_message(tool_call, result_data)
    
    assert "title" in result
    assert "message" in result
    assert "Failed" in result["title"]
    assert "Error" in result["message"]
    
    print("✅ test_format_post_message_error passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SEARCH_USER_NETWORK_FOR_PEOPLE")
    print("="*60 + "\n")
    
    try:
        # Async tests for activities
        await test_activity_success()
        await test_activity_no_matches()
        await test_activity_missing_required_fields()
        await test_activity_api_error()
        
        # Sync tests for formatters
        test_format_pre_message()
        test_format_post_message_success()
        test_format_post_message_no_results()
        test_format_post_message_error()
        
        print("\n✅ All search_user_network tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

