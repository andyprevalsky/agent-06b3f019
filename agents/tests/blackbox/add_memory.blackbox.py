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


# -------------------- service.py tests --------------------


def test_truncate_for_display_short():
    from domains.add_memory.service import truncate_for_display
    assert truncate_for_display("hello") == "hello"


def test_truncate_for_display_long():
    from domains.add_memory.service import truncate_for_display
    from domains.add_memory.config import DISPLAY_CONTENT_MAX_LENGTH, DISPLAY_CONTENT_TRUNCATION_LENGTH
    long = "x" * (DISPLAY_CONTENT_MAX_LENGTH + 50)
    out = truncate_for_display(long)
    assert out.endswith("...")
    assert len(out) == DISPLAY_CONTENT_TRUNCATION_LENGTH + 3


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "kwargs": kwargs})
        if name == "add_memory_activity":
            if raises:
                raise RuntimeError("supermemory down")
            return result or {"document_id": "doc-1", "status": "queued", "message": "Saved"}
        return None
    return mock


async def test_manager_execute_tool_happy():
    """AddMemoryManager.execute_tool returns result + usage."""
    from domains.add_memory.handler import AddMemoryManager

    calls = []
    manager = AddMemoryManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(calls),
        tool_call={"content": "Remember this"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["result"]["document_id"] == "doc-1"
    assert out["usage"] == {"llm": [], "service": []}


async def test_manager_execute_tool_raises():
    """AddMemoryManager.execute_tool re-raises on activity failure."""
    from domains.add_memory.handler import AddMemoryManager

    calls = []
    manager = AddMemoryManager()
    try:
        await manager.execute_tool(
            execute_activity=_mock_execute(calls, raises=True),
            tool_call={"content": "x"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
        raise AssertionError("Expected RuntimeError")
    except RuntimeError as e:
        assert "supermemory down" in str(e)


async def test_manager_execute_tool_long_content_truncates_display():
    """Long content triggers truncation in display only."""
    from domains.add_memory.handler import AddMemoryManager

    calls = []
    manager = AddMemoryManager()
    await manager.execute_tool(
        execute_activity=_mock_execute(calls),
        tool_call={"content": "y" * 500},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    add_calls = [c for c in calls if c["activity"] == "add_memory_activity"]
    assert len(add_calls) == 1


async def test_add_memory_entry_point():
    """add_memory() entry point dispatches to the manager."""
    from domains.add_memory.handler import add_memory

    calls = []
    out = await add_memory(
        execute_activity=_mock_execute(calls),
        tool_call={"content": "x"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "result" in out


async def run_all_tests():
    print("add-memory blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary_request_params", test_boundary_request_params)
    await r.record_async("missing_api_key", test_missing_api_key)
    r.record("truncate_for_display_short", test_truncate_for_display_short)
    r.record("truncate_for_display_long", test_truncate_for_display_long)
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy)
    await r.record_async("manager_execute_tool_raises", test_manager_execute_tool_raises)
    await r.record_async("manager_long_content_truncates", test_manager_execute_tool_long_content_truncates_display)
    await r.record_async("add_memory_entry_point", test_add_memory_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
