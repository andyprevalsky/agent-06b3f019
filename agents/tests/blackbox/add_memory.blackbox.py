"""Blackbox tests for add-memory domain."""

import asyncio
import json
from unittest.mock import patch, AsyncMock
import os

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    clear_captures,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "supermemory.ai/v3/documents": {
            "status": 200,
            "json": {"id": "doc-abc123", "status": "queued"},
        }
    })


async def test_happy_path():
    """add_memory_activity returns document_id and status from SuperMemory API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.add_memory import add_memory_activity

        result = await add_memory_activity("Remember that the user likes coffee", "user-42")

    assert result["document_id"] == "doc-abc123"
    assert result["status"] == "queued"
    assert result["message"] == "Memory saved successfully"


async def test_boundary_request_params():
    """Verify exact HTTP request sent to SuperMemory API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.add_memory import add_memory_activity

        await add_memory_activity("Test memory content", "user-99")

    call = assert_captured_call(
        url_contains="supermemory.ai/v3/documents",
        method="POST",
        body_contains={"content": "Test memory content", "containerTag": "user-99"},
        header_present="x-supermemory-api-key",
    )
    assert call["responseStatus"] == 200


async def test_missing_api_key():
    """Activity raises ValueError when SUPERMEMORY_API_KEY is not configured."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch.dict("os.environ", {"SUPERMEMORY_API_KEY": ""}),
    ):
        from tools.add_memory import add_memory_activity

        try:
            await add_memory_activity("test", "user-1")
            raise AssertionError("Should have raised ValueError")
        except ValueError:
            pass

    clear_captures()
    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("add-memory blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary_request_params", test_boundary_request_params)
    await r.record_async("missing_api_key", test_missing_api_key)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
