"""Blackbox tests for read-memories domain."""

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
        "api.supermemory.ai/v4/profile": {
            "status": 200,
            "json": {
                "profile": {"name": "Andy", "interests": ["AI", "music"]},
                "results": [
                    {"content": "Likes hiking on weekends", "score": 0.92},
                    {"content": "Prefers async communication", "score": 0.85},
                ],
            },
        },
    })


async def test_read_memories_happy_path():
    """read_memories_activity returns profile and memories."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_memories import read_memories_activity

        result = await read_memories_activity(
            query="hobbies",
            user_id="user-42",
        )

    assert "profile" in result or "memories" in result


async def test_read_memories_boundary():
    """Verify exact HTTP request sent to SuperMemory profile endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_memories import read_memories_activity

        await read_memories_activity(
            query="communication preferences",
            user_id="user-99",
        )

    call = assert_captured_call(
        url_contains="api.supermemory.ai/v4/profile",
        method="POST",
        header_present="x-supermemory-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["containerTag"] == "user-99"
    assert body["q"] == "communication preferences"


async def test_read_memories_empty_query():
    """Empty query returns profile only (no q param)."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_memories import read_memories_activity

        result = await read_memories_activity(query="", user_id="user-42")

    call = assert_captured_call(
        url_contains="api.supermemory.ai/v4/profile",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["containerTag"] == "user-42"
    # Empty query should not include q param
    assert "q" not in body or body.get("q") == ""


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    """Build a mock execute_activity that records calls and returns result/raises."""
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "args": kwargs.get("args"), "kwargs": kwargs})
        if name == "read_memories_activity":
            if raises:
                raise RuntimeError("supermemory offline")
            return result or {"profile": {"name": "Andy"}, "results": []}
        # post_agent_message and other posting activities return None
        return None
    return mock


async def test_manager_execute_tool_happy_path():
    """ReadMemoriesManager.execute_tool runs activity and returns result+usage."""
    from domains.read_memories.handler import ReadMemoriesManager

    calls = []
    manager = ReadMemoriesManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(calls, result={"profile": {"name": "A"}, "results": [{"content": "x"}]}),
        tool_call={"query": "hobbies"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["result"]["profile"]["name"] == "A"
    assert out["usage"] == {"llm": [], "service": []}
    # Verify read_memories_activity was called
    activity_names = [c["activity"] for c in calls]
    assert "read_memories_activity" in activity_names


async def test_manager_execute_tool_error():
    """ReadMemoriesManager.execute_tool raises on activity error (after posting error event)."""
    from domains.read_memories.handler import ReadMemoriesManager

    calls = []
    manager = ReadMemoriesManager()
    try:
        await manager.execute_tool(
            execute_activity=_mock_execute(calls, raises=True),
            tool_call={"query": "hobbies"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
        raise AssertionError("Expected RuntimeError")
    except RuntimeError as e:
        assert "supermemory offline" in str(e)


async def test_manager_execute_tool_long_query_truncates():
    """Long query (>100 chars) is truncated for display but passed whole to activity."""
    from domains.read_memories.handler import ReadMemoriesManager

    calls = []
    manager = ReadMemoriesManager()
    long_query = "a" * 200
    await manager.execute_tool(
        execute_activity=_mock_execute(calls),
        tool_call={"query": long_query},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    # Activity receives the full query
    read_calls = [c for c in calls if c["activity"] == "read_memories_activity"]
    assert len(read_calls) == 1
    assert read_calls[0]["args"][0] == long_query


async def test_read_memories_entry_point():
    """read_memories() entry point dispatches to the manager."""
    from domains.read_memories.handler import read_memories

    calls = []
    out = await read_memories(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "x"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "result" in out
    assert "usage" in out


async def run_all_tests():
    print("read-memories blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_read_memories_happy_path)
    await r.record_async("boundary", test_read_memories_boundary)
    await r.record_async("empty_query", test_read_memories_empty_query)
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy_path)
    await r.record_async("manager_execute_tool_error", test_manager_execute_tool_error)
    await r.record_async("manager_long_query_truncates", test_manager_execute_tool_long_query_truncates)
    await r.record_async("read_memories_entry_point", test_read_memories_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
