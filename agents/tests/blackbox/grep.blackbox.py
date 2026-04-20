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


async def test_grep_network_source_forwarded():
    """grep_activity forwards source=network to backend."""
    setup_mock({
        "/api/data/grep": {
            "status": 200,
            "json": {
                "matches": [
                    {
                        "person_id": "p-1",
                        "first_name": "Alice",
                        "last_name": "Smith",
                        "phone_number": "+15551234567",
                        "email": "alice@example.com",
                        "company": "Acme",
                        "title": "CTO",
                        "relation": "colleague",
                        "communication_frequency": "weekly",
                        "messages_exchanged": 42,
                    }
                ],
                "total_matches": 1,
                "truncated": False,
            },
        },
    })
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity(
            pattern="acme",
            source="network",
            user_id="user-42",
        )

    assert result["total_matches"] == 1
    assert result["matches"][0]["first_name"] == "Alice"

    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["source"] == "network"
    assert body["pattern"] == "acme"
    # person_id / since must NOT be injected for network source
    assert "person_id" not in body
    assert "since" not in body


# -------------------- service.py tests --------------------


def test_truncate_pattern_short():
    from domains.grep.service import _truncate_pattern
    assert _truncate_pattern("abc") == "abc"


def test_truncate_pattern_long():
    from domains.grep.service import _truncate_pattern
    from domains.grep.config import DISPLAY_PATTERN_MAX_LENGTH
    long = "x" * (DISPLAY_PATTERN_MAX_LENGTH + 50)
    out = _truncate_pattern(long)
    assert len(out) == DISPLAY_PATTERN_MAX_LENGTH
    assert out.endswith("...")


async def test_execute_grep_happy():
    from domains.grep.service import execute_grep

    calls = []
    activity_result = {"matches": [], "total_matches": 0, "truncated": False}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": getattr(activity_fn, "__name__", "fn")})
        if getattr(activity_fn, "__name__", "") == "grep_activity":
            return activity_result
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "foo", "source": "messages"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"] == activity_result
    assert out["usage"] == {"llm": [], "service": []}
    # IN_PROGRESS + activity + FINISHED = 3
    assert any(c["activity"] == "grep_activity" for c in calls)


async def test_execute_grep_empty_pattern_path():
    """Empty pattern exercises the 'all messages' title branch."""
    from domains.grep.service import execute_grep

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "grep_activity":
            return {"matches": []}
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": ""},
        tool_call_id="tc-1",
        agent_id="a-1",
    )
    assert out["result"] == {"matches": []}


async def test_execute_grep_error_reraises():
    from domains.grep.service import execute_grep

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        if name == "grep_activity":
            raise RuntimeError("backend down")
        return None

    try:
        await execute_grep(
            execute_activity=mock_execute_activity,
            tool_call={"pattern": "x", "person_id": "p-abcdef"},
            tool_call_id="tc-1",
            agent_id="a-1",
        )
        raise AssertionError("should have raised")
    except RuntimeError as e:
        assert "backend down" in str(e)


async def test_manager_execute_tool():
    from domains.grep.handler import GrepManager

    activity_result = {"matches": [], "total_matches": 0}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "grep_activity":
            return activity_result
        return None

    manager = GrepManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "foo", "source": "messages"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"] == activity_result


async def run_all_tests():
    print("grep blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_grep_happy_path)
    await r.record_async("boundary", test_grep_boundary)
    await r.record_async("fetch_local_data_summary", test_fetch_local_data_summary)
    await r.record_async("empty_pattern", test_grep_empty_pattern)
    await r.record_async("network_source_forwarded", test_grep_network_source_forwarded)
    r.record("truncate_pattern_short", test_truncate_pattern_short)
    r.record("truncate_pattern_long", test_truncate_pattern_long)
    await r.record_async("execute_grep_happy", test_execute_grep_happy)
    await r.record_async("execute_grep_empty_pattern_path", test_execute_grep_empty_pattern_path)
    await r.record_async("execute_grep_error_reraises", test_execute_grep_error_reraises)
    await r.record_async("manager_execute_tool", test_manager_execute_tool)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
