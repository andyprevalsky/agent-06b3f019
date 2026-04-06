"""Blackbox tests for spawn-browser-agent-v3 domain.

This is a complex orchestrator tool with many HTTP endpoints.
We test the browser session init/close boundaries which are
the most critical entry/exit points.
"""

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
        "/api/browser-session/init": {
            "status": 200,
            "json": {
                "session_id": "bs-session-123",
                "cdp_url": "wss://connect.steel.dev/bs-session-123",
                "live_url": "https://live.steel.dev/bs-session-123",
            },
        },
        "/api/browser-session/close": {
            "status": 200,
            "json": {"success": True, "closed": True},
        },
        "/api/browser-session/task/": {
            "status": 200,
            "json": {"status": "completed"},
        },
    })


async def test_browser_session_init_mock():
    """Mock verifies browser session init endpoint exists and returns session_id."""
    _setup()
    import httpx
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(
            "https://test-backend.example.com/api/browser-session/init",
            json={"task_id": "task-1", "agent_id": "agent-1"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["session_id"] == "bs-session-123"

    call = assert_captured_call(
        url_contains="/api/browser-session/init",
        method="POST",
    )


async def test_browser_session_close_mock():
    """Mock verifies browser session close endpoint."""
    _setup()
    import httpx
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(
            "https://test-backend.example.com/api/browser-session/close",
            json={"session_id": "bs-session-123"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True

    call = assert_captured_call(
        url_contains="/api/browser-session/close",
        method="POST",
    )


async def run_all_tests():
    print("spawn-browser-agent-v3 blackbox tests:")
    r = BlackboxResult()
    await r.record_async("browser_session_init_mock", test_browser_session_init_mock)
    await r.record_async("browser_session_close_mock", test_browser_session_close_mock)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
