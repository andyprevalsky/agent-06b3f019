"""Test search_user_network_for_people tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.search_user_network import search_user_network_activity


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
                tool_call={
                    "first_name": "NonExistent",
                    "last_name": "Person"
                }
            )
        
        assert result["count"] == 0
        assert result["results"] == []
    
    print("✅ test_activity_no_matches passed")


async def test_activity_api_error():
    """Test activity error handling for API errors."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            try:
                await search_user_network_activity(
                    user_id="test-user-123",
                    tool_call={
                        "first_name": "Test",
                        "last_name": "User"
                    }
                )
                assert False, "Expected ValueError to be raised"
            except ValueError as e:
                assert "500" in str(e) or "Backend API error" in str(e)
    
    print("✅ test_activity_api_error passed")


async def test_activity_timeout():
    """Test activity error handling for timeout."""
    import httpx
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(
            side_effect=httpx.TimeoutException("Connection timed out")
        )
        
        with patch('temporalio.activity.heartbeat'):
            try:
                await search_user_network_activity(
                    user_id="test-user-123",
                    tool_call={
                        "first_name": "Test",
                        "last_name": "User"
                    }
                )
                assert False, "Expected ValueError to be raised"
            except ValueError as e:
                assert "timed out" in str(e).lower()
    
    print("✅ test_activity_timeout passed")


async def test_activity_with_all_signals():
    """Test activity with all person signals."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "results": [
            {
                "firstName": "John",
                "lastName": "Doe",
                "profession": "Software Engineer",
                "company": "Google",
                "title": "Senior Engineer",
                "location": "San Francisco",
                "skills": ["Python", "Go", "Kubernetes"],
                "similarity": 0.88,
            }
        ],
        "count": 1,
        "query": {}
    }
    
    tool_call = {
        "first_name": "John",
        "last_name": "Doe",
        "profession": "Software Engineer",
        "company": "Google",
        "title": "Senior Engineer",
        "industry": "Technology",
        "location": "San Francisco",
        "relation": "colleague",
        "skills": ["Python", "Go"],
        "interests": ["AI", "Cloud"],
        "total_online_reach": 5000,
    }
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            result = await search_user_network_activity(
                user_id="test-user-123",
                tool_call=tool_call
            )
        
        assert result["count"] == 1
        assert result["results"][0]["firstName"] == "John"
        
        # Verify the query was passed correctly (excluding 'tool' key)
        assert "first_name" in result["query"]
        assert "last_name" in result["query"]
    
    print("✅ test_activity_with_all_signals passed")


async def test_activity_excludes_internal_fields():
    """Test that internal fields like 'tool' are excluded from query."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "results": [],
        "count": 0,
        "query": {}
    }
    
    captured_json = None
    
    async def capture_post(*args, **kwargs):
        nonlocal captured_json
        captured_json = kwargs.get('json', {})
        return mock_response
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(side_effect=capture_post)
        
        with patch('temporalio.activity.heartbeat'):
            await search_user_network_activity(
                user_id="test-user-123",
                tool_call={
                    "tool": "search_user_network_for_people",
                    "tool_call_id": "abc123",
                    "first_name": "Test",
                    "last_name": "User"
                }
            )
        
        # Verify internal fields were excluded
        assert "tool" not in captured_json
        assert "tool_call_id" not in captured_json
        assert "first_name" in captured_json
        assert "last_name" in captured_json
    
    print("✅ test_activity_excludes_internal_fields passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING SEARCH_USER_NETWORK_FOR_PEOPLE")
    print("="*60 + "\n")
    
    try:
        # Async tests for activities
        await test_activity_success()
        await test_activity_no_matches()
        await test_activity_api_error()
        await test_activity_timeout()
        await test_activity_with_all_signals()
        await test_activity_excludes_internal_fields()
        
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
