"""Blackbox tests for shared-memory domain."""

import asyncio
import json
from unittest.mock import patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _mock_handler(request: httpx.Request) -> httpx.Response:
    """Route shared memory endpoints."""
    url = str(request.url)
    method = request.method

    # GET /api/memory/{bus_id} - fetch shared memory
    if "/api/memory/" in url and method == "GET":
        # If hash query param matches, return 304
        if "hash=current-hash-abc" in url:
            return httpx.Response(304)
        return httpx.Response(200, json={
            "content": [
                {"type": "USER_MESSAGE", "content": "Hello from user", "timestamp": "2026-04-05T12:00:00Z"},
                {"type": "USER_MESSAGE", "content": "Another message", "timestamp": "2026-04-05T12:01:00Z"},
            ],
            "hash": "new-hash-xyz",
        })

    # POST /api/memory/{bus_id}/append - append to shared memory
    if "/api/memory/" in url and "/append" in url and method == "POST":
        return httpx.Response(200, json={
            "hash": "updated-hash-123",
        })

    return httpx.Response(404, json={"error": f"No mock for {method} {url}"})


def _setup():
    setup_mock_fn(_mock_handler)


async def test_get_shared_memory_happy_path():
    """get_shared_memory returns content and hash from backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from activities.shared_memory import get_shared_memory

        result = await get_shared_memory(bus_id="bus-test-1")

    assert result is not None
    assert len(result["content"]) == 2
    assert result["hash"] == "new-hash-xyz"
    assert result["content"][0]["type"] == "USER_MESSAGE"


async def test_get_shared_memory_boundary():
    """Verify GET request includes hash query param when provided."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from activities.shared_memory import get_shared_memory

        # When current_hash matches, should return None (304)
        result = await get_shared_memory(
            bus_id="bus-test-2",
            current_hash="current-hash-abc",
        )

    assert result is None

    # Verify the request URL included the hash param
    call = assert_captured_call(
        url_contains="/api/memory/bus-test-2",
        method="GET",
        header_present="X-API-Key",
    )
    assert "hash=current-hash-abc" in call["url"]


async def test_append_shared_memory_happy_path():
    """append_shared_memory POSTs entry and returns new hash."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from activities.shared_memory import append_shared_memory

        result = await append_shared_memory(
            bus_id="bus-test-3",
            entry_type="USER_MESSAGE",
            content="Hello from the user",
            message_id="msg-42",
        )

    assert result is not None
    assert result["hash"] == "updated-hash-123"


async def test_append_shared_memory_boundary():
    """Verify POST body contains entry with type, content, message_id."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from activities.shared_memory import append_shared_memory

        await append_shared_memory(
            bus_id="bus-test-4",
            entry_type="USER_MESSAGE",
            content="Test content",
            message_id="msg-99",
            files=[{"original_filename": "doc.pdf", "mime_type": "application/pdf"}],
        )

    call = assert_captured_call(
        url_contains="/api/memory/bus-test-4/append",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["entry"]["type"] == "USER_MESSAGE"
    assert body["entry"]["content"] == "Test content"
    assert body["entry"]["message_id"] == "msg-99"
    assert len(body["entry"]["files"]) == 1
    assert body["entry"]["files"][0]["original_filename"] == "doc.pdf"


async def run_all_tests():
    print("shared-memory blackbox tests:")
    r = BlackboxResult()
    await r.record_async("get_memory_happy_path", test_get_shared_memory_happy_path)
    await r.record_async("get_memory_boundary", test_get_shared_memory_boundary)
    await r.record_async("append_memory_happy_path", test_append_shared_memory_happy_path)
    await r.record_async("append_memory_boundary", test_append_shared_memory_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
