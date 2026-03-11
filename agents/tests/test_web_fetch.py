"""Test web_fetch tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.web_fetch import WebFetchManager, get_manager, web_fetch, web_fetch_activity, _extract_media_urls
from tools.base import EventType, MessageStatus


def test_manager_singleton():
    """Test that manager is a singleton."""
    manager1 = get_manager()
    manager2 = get_manager()
    assert manager1 is manager2
    assert manager1.tool_name == "web_fetch"
    print("✅ test_manager_singleton passed")


async def test_web_fetch_success():
    """Test successful web fetch execution."""
    manager = get_manager()

    # Mock execute_activity callable
    mock_execute_activity = AsyncMock()

    # Mock successful web fetch activity result
    mock_result = {
        "content": "**Python** (https://python.org)\nPython is a programming language.",
        "sources": ["https://python.org"],
        "images": ["https://python.org/logo.png"],
        "files": [],
        "links": ["https://python.org/docs"],
        "objective": "What is Python?",
        "results": [
            {
                "url": "https://python.org",
                "title": "Python",
                "excerpts": ["Python is a programming language."],
                "full_content": "Python is a programming language. ![logo](https://python.org/logo.png) [docs](https://python.org/docs)"
            }
        ],
        "errors": []
    }

    mock_execute_activity.return_value = mock_result

    tool_call = {
        "url": "https://python.org",
        "objective": "What is Python?",
        "excerpts": True,
        "full_content": False
    }
    tool_call_id = "test-123"
    agent_id = "agent-123"
    user_id = "user-123"

    # Mock handle_tool_event to not actually post to DB
    with patch('tools.web_fetch.handle_tool_event', new_callable=AsyncMock) as mock_handle:
        result = await manager.execute_tool(
            execute_activity=mock_execute_activity,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            agent_id=agent_id,
            user_id=user_id,
        )

        # Tool posts IN_PROGRESS then FINISHED
        assert mock_handle.call_count == 2

        # First call should be IN_PROGRESS
        first_call = mock_handle.call_args_list[0]
        assert first_call.kwargs['event'].status == MessageStatus.IN_PROGRESS
        assert "What is Python?" in first_call.kwargs['event'].message

        # Second call should be FINISHED
        second_call = mock_handle.call_args_list[1]
        assert second_call.kwargs['event'].status == MessageStatus.FINISHED

        # Verify result structure (wrapped with usage)
        assert "result" in result
        assert "usage" in result
        assert "Python" in result["result"]["content"]
        assert result["result"]["sources"] == ["https://python.org"]
        assert result["result"]["images"] == ["https://python.org/logo.png"]

    print("✅ test_web_fetch_success passed")


async def test_web_fetch_error():
    """Test web fetch error handling - should raise exception like spawn_browser_agent."""
    manager = get_manager()

    # Mock execute_activity callable that fails
    mock_execute_activity = AsyncMock()
    mock_execute_activity.side_effect = Exception("API error")

    tool_call = {
        "url": "https://example.com",
        "objective": "test",
        "excerpts": True,
        "full_content": False
    }
    tool_call_id = "test-error"
    agent_id = "agent-123"
    user_id = "user-123"

    # Mock handle_tool_event
    with patch('tools.web_fetch.handle_tool_event', new_callable=AsyncMock) as mock_handle:
        try:
            await manager.execute_tool(
                execute_activity=mock_execute_activity,
                tool_call=tool_call,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
            assert False, "Should have raised exception"
        except Exception as e:
            # Should re-raise the exception (hard fail like spawn_browser_agent)
            assert "API error" in str(e)

        # Should have called handle_tool_event twice (IN_PROGRESS and ERROR)
        assert mock_handle.call_count == 2
        second_call = mock_handle.call_args_list[1]
        assert second_call.kwargs['event'].status == MessageStatus.ERROR

    print("✅ test_web_fetch_error passed")


async def test_web_fetch_activity_success():
    """Test the actual activity with mocked httpx client."""
    from tools.web_fetch import web_fetch_activity

    # Mock Parallel AI response (always returns full_content now)
    mock_response_data = {
        "results": [
            {
                "url": "https://python.org",
                "title": "Python",
                "excerpts": ["Python is awesome!"],
                "full_content": "Python is awesome! ![logo](https://python.org/static/logo.png) [Download](https://python.org/downloads/python-3.12.0.zip)"
            }
        ],
        "errors": []
    }

    # Mock config
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"

    # Create mock response object
    mock_response = MagicMock()
    mock_response.json.return_value = mock_response_data
    mock_response.raise_for_status = MagicMock()

    with patch('tools.web_fetch.load_config', return_value=mock_config):
        with patch('tools.web_fetch.httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client

            with patch('temporalio.activity.heartbeat'):
                result = await web_fetch_activity(
                    url="https://python.org",
                    objective="What is Python?",
                    excerpts=True,
                    full_content=False
                )

            # Content uses excerpts (not full_content) since full_content=False was passed
            assert "Python is awesome!" in result["content"]
            assert result["sources"] == ["https://python.org"]
            assert result["objective"] == "What is Python?"

            # Verify media extraction from full_content
            assert "https://python.org/static/logo.png" in result["images"]
            assert "https://python.org/downloads/python-3.12.0.zip" in result["files"]

            # Verify API was called with full_content=True (always)
            call_args = mock_client.post.call_args
            assert call_args.kwargs['json']['full_content'] is True

    print("✅ test_web_fetch_activity_success passed")


async def test_web_fetch_activity_error():
    """Test activity error handling."""
    from tools.web_fetch import web_fetch_activity

    # Mock config
    mock_config = MagicMock()
    mock_config.parallel.api_key = "test-key"

    with patch('tools.web_fetch.load_config', return_value=mock_config):
        with patch('tools.web_fetch.httpx.AsyncClient') as mock_client_class:
            mock_client = MagicMock()
            mock_client.post = AsyncMock(side_effect=Exception("API error"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client

            with patch('temporalio.activity.heartbeat'):
                try:
                    await web_fetch_activity(
                        url="https://example.com",
                        objective="test query"
                    )
                    assert False, "Should have raised exception"
                except Exception as e:
                    assert "API error" in str(e)

    print("✅ test_web_fetch_activity_error passed")


def test_extract_media_urls():
    """Test _extract_media_urls parses image URLs, file links, and navigation links."""

    page_content = """
# Welcome to My Site

![Hero Image](https://example.com/images/hero.png)
![Logo](https://example.com/logo.svg)

Check out our [About page](https://example.com/about) and [Contact](https://example.com/contact).

Download our [brochure](https://example.com/docs/brochure.pdf) or [data](https://example.com/data.csv).

Background: https://example.com/bg.jpg

Visit our [shop](https://example.com/shop).
"""
    result = _extract_media_urls(page_content)

    # Images
    assert "https://example.com/images/hero.png" in result["images"]
    assert "https://example.com/logo.svg" in result["images"]
    assert "https://example.com/bg.jpg" in result["images"]

    # Images should NOT appear in links
    assert "https://example.com/images/hero.png" not in result["links"]
    assert "https://example.com/logo.svg" not in result["links"]

    # Files
    assert "https://example.com/docs/brochure.pdf" in result["files"]
    assert "https://example.com/data.csv" in result["files"]

    # Files should NOT appear in links
    assert "https://example.com/docs/brochure.pdf" not in result["links"]
    assert "https://example.com/data.csv" not in result["links"]

    # Links (only non-image, non-file markdown links)
    assert "https://example.com/about" in result["links"]
    assert "https://example.com/contact" in result["links"]
    assert "https://example.com/shop" in result["links"]

    print("✅ test_extract_media_urls passed")


def test_extract_media_urls_case_insensitive():
    """Test _extract_media_urls matches uppercase extensions."""
    content = """
![Photo](https://example.com/photo.PNG)
https://example.com/banner.JPG
[Report](https://example.com/report.PDF)
"""
    result = _extract_media_urls(content)

    assert "https://example.com/photo.PNG" in result["images"]
    assert "https://example.com/banner.JPG" in result["images"]
    assert "https://example.com/report.PDF" in result["files"]
    # PDF file link should not appear in links
    assert "https://example.com/report.PDF" not in result["links"]

    print("✅ test_extract_media_urls_case_insensitive passed")


def test_extract_media_urls_empty():
    """Test _extract_media_urls with no media."""
    result = _extract_media_urls("Just plain text, no links or images.")
    assert result["images"] == []
    assert result["files"] == []
    assert result["links"] == []
    print("✅ test_extract_media_urls_empty passed")


def test_extract_media_urls_dedup():
    """Test _extract_media_urls deduplicates URLs."""
    content = """
![img](https://example.com/logo.png)
![img2](https://example.com/logo.png)
https://example.com/logo.png
"""
    result = _extract_media_urls(content)
    assert result["images"].count("https://example.com/logo.png") == 1
    print("✅ test_extract_media_urls_dedup passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING WEB_FETCH")
    print("="*60 + "\n")

    try:
        # Sync tests
        test_manager_singleton()
        test_extract_media_urls()
        test_extract_media_urls_case_insensitive()
        test_extract_media_urls_empty()
        test_extract_media_urls_dedup()

        # Async tests
        await test_web_fetch_success()
        await test_web_fetch_error()
        await test_web_fetch_activity_success()
        await test_web_fetch_activity_error()

        print("\n✅ All web_fetch tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
