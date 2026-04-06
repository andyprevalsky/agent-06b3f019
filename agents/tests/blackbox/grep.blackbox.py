"""Blackbox tests for grep domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/data/grep": {
            "status": 200,
            "json": {
                "matches": [
                    {
                        "thread_id": "t-1",
                        "person_name": "Alice",
                        "messages": [
                            {"text": "Let's discuss the project", "timestamp": "2026-01-01T10:00:00Z"}
                        ],
                    }
                ],
                "total_matches": 1,
                "truncated": False,
            },
        },
        "/api/data/summary": {
            "status": 200,
            "json": {
                "sources": {
                    "messages": {
                        "total_threads": 5,
                        "total_messages": 120,
                        "channels": {"sms": 80, "email": 40},
                        "date_range": {"from": "2025-06-01T00:00:00Z", "to": "2026-04-01T00:00:00Z"},
                        "threads": [
                            {"name": "Alice", "message_count": 50, "last_message": "2026-04-01"},
                            {"name": "Bob", "message_count": 30, "last_message": "2026-03-15"},
                        ],
                    }
                }
            },
        },
    })


async def test_grep_happy_path():
    """grep_activity returns matches from backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity(
            pattern="project",
            source="messages",
            person_id=None,
            since=None,
            user_id="user-42",
            agent_id="agent-1",
        )

    assert result["total_matches"] == 1
    assert result["truncated"] is False
    assert len(result["matches"]) == 1
    assert result["matches"][0]["person_name"] == "Alice"


async def test_grep_boundary():
    """Verify exact HTTP request sent to backend grep endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        await grep_activity(
            pattern="quarterly report",
            source="messages",
            person_id="person-abc",
            since="2026-01-01T00:00:00Z",
            user_id="user-99",
            agent_id="agent-2",
        )

    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["pattern"] == "quarterly report"
    assert body["source"] == "messages"
    assert body["person_id"] == "person-abc"
    assert body["since"] == "2026-01-01T00:00:00Z"
    assert body["user_id"] == "user-99"

    # Verify X-User-Id header is set
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower


async def test_fetch_local_data_summary():
    """fetch_local_data_summary returns formatted summary string."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import fetch_local_data_summary, _data_summary_cache

        # Clear cache to force fresh fetch
        _data_summary_cache.clear()

        result = await fetch_local_data_summary("user-42")

    assert "5 threads" in result
    assert "120" in result
    assert "Alice" in result


async def test_grep_empty_pattern():
    """grep_activity with empty pattern still sends POST request."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity(
            pattern="",
            source="messages",
            user_id="user-42",
        )

    assert "matches" in result
    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["pattern"] == ""


async def run_all_tests():
    print("grep blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_grep_happy_path)
    await r.record_async("boundary", test_grep_boundary)
    await r.record_async("fetch_local_data_summary", test_fetch_local_data_summary)
    await r.record_async("empty_pattern", test_grep_empty_pattern)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
