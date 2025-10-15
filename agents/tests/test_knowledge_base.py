"""Test knowledge_base (blueprints) tool."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.knowledge_base import BlueprintManager
from helpers.formatters import (
    format_query_blueprints_pre,
    format_query_blueprints_post,
    format_save_blueprint_pre,
    format_save_blueprint_post
)


async def test_blueprint_query_by_similarity():
    """Test blueprint query with mocked HTTP calls."""
    manager = BlueprintManager()
    
    # Mock the HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = [
        {
            "id": "bp1",
            "title": "Write Python script",
            "similarity": 0.95,
            "blueprint": [{"step": 1, "action": "test"}]
        },
        {
            "id": "bp2",
            "title": "Create automation",
            "similarity": 0.85,
            "blueprint": [{"step": 1, "action": "test2"}]
        }
    ]
    mock_response.raise_for_status = MagicMock()
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            results = await manager.query_by_similarity(
                goal="Write a Python script",
                user_id="test_user",
                limit=3
            )
        
        assert len(results) == 2
        assert results[0]["id"] == "bp1"
        assert results[0]["similarity"] == 0.95
        assert results[1]["title"] == "Create automation"
    
    print("✅ test_blueprint_query_by_similarity passed")


async def test_blueprint_query_failure():
    """Test blueprint query with failed HTTP call."""
    manager = BlueprintManager()
    
    # Mock a failed HTTP response
    mock_response = MagicMock()
    mock_response.raise_for_status.side_effect = Exception("API error")
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            results = await manager.query_by_similarity(
                goal="Test goal",
                user_id="test_user"
            )
        
        # Should return empty list on error (graceful degradation)
        assert results == []
    
    print("✅ test_blueprint_query_failure passed")


async def test_blueprint_save():
    """Test blueprint save with mocked HTTP calls."""
    manager = BlueprintManager()
    
    # Mock the HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 201
    mock_response.json.return_value = {
        "id": "bp123",
        "title": "Complete task successfully",
        "user_id": "test_user"
    }
    mock_response.raise_for_status = MagicMock()
    
    with patch('httpx.AsyncClient') as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        with patch('temporalio.activity.heartbeat'):
            result = await manager.save(
                user_id="test_user",
                title="Complete task successfully",
                blueprint=[{"step": 1, "action": "test"}]
            )
        
        assert result["id"] == "bp123"
        assert result["title"] == "Complete task successfully"
    
    print("✅ test_blueprint_save passed")


def test_format_query_blueprints_pre():
    """Test query blueprints pre-message formatting."""
    args = ["Find similar tasks for: Write a Python script"]
    result = format_query_blueprints_pre(args)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_query_blueprints_pre passed")


def test_format_query_blueprints_post():
    """Test query blueprints post-message formatting."""
    result_data = [
        {
            "id": "bp1",
            "title": "Write Python script",
            "similarity": 0.95
        },
        {
            "id": "bp2",
            "title": "Create automation script",
            "similarity": 0.85
        }
    ]
    
    result = format_query_blueprints_post(None, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_query_blueprints_post passed")


def test_format_query_blueprints_post_no_results():
    """Test query blueprints post-message with no results."""
    result_data = []
    
    result = format_query_blueprints_post(None, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_query_blueprints_post_no_results passed")


def test_format_save_blueprint_pre():
    """Test save blueprint pre-message formatting."""
    args = [
        "user123",
        "Complete task successfully",
        [{"step": 1, "action": "test"}]
    ]
    result = format_save_blueprint_pre(args)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_save_blueprint_pre passed")


def test_format_save_blueprint_post():
    """Test save blueprint post-message formatting."""
    result_data = {
        "id": "bp123",
        "title": "Complete task successfully"
    }
    
    result = format_save_blueprint_post(None, result_data)
    
    assert "title" in result
    assert "message" in result
    
    print("✅ test_format_save_blueprint_post passed")


async def run_all_tests():
    """Run all knowledge_base tests."""
    print("\n" + "="*60)
    print("🧪 TESTING KNOWLEDGE_BASE (BLUEPRINTS) TOOL")
    print("="*60 + "\n")
    
    try:
        # Async tests for BlueprintManager
        await test_blueprint_query_by_similarity()
        await test_blueprint_query_failure()
        await test_blueprint_save()
        
        # Sync tests for formatters
        test_format_query_blueprints_pre()
        test_format_query_blueprints_post()
        test_format_query_blueprints_post_no_results()
        test_format_save_blueprint_pre()
        test_format_save_blueprint_post()
        
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

