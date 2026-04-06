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


async def run_all_tests():
    print("read-memories blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_read_memories_happy_path)
    await r.record_async("boundary", test_read_memories_boundary)
    await r.record_async("empty_query", test_read_memories_empty_query)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
