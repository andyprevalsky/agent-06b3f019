"""Blackbox tests for spawn-claude-code-agent domain.

Complex orchestrator with many endpoints. We test the session
create and health-check boundaries as the primary entry points.
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
        "/api/claude-code-session/create": {
            "status": 200,
            "json": {
                "sandbox_id": "sandbox-abc",
                "task_id": "cctask-123",
                "status": "running",
            },
        },
        "/api/claude-code-session/": {
            "status": 200,
            "json": {"status": "healthy", "sandbox_id": "sandbox-abc"},
        },
    })


async def test_claude_code_session_create_mock():
    """Mock verifies Claude Code session create endpoint returns sandbox_id."""
    _setup()
    import httpx
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(
            "https://test-backend.example.com/api/claude-code-session/create",
            json={"goal": "Fix the login bug", "agent_id": "agent-1"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["sandbox_id"] == "sandbox-abc"
    assert data["task_id"] == "cctask-123"

    assert_captured_call(
        url_contains="/api/claude-code-session/create",
        method="POST",
    )


async def test_claude_code_session_health_mock():
    """Mock verifies Claude Code session health endpoint."""
    _setup()
    import httpx
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(
            "https://test-backend.example.com/api/claude-code-session/sandbox-abc/health",
        )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"

    assert_captured_call(
        url_contains="/api/claude-code-session/",
        method="GET",
    )


async def run_all_tests():
    print("spawn-claude-code-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("session_create_mock", test_claude_code_session_create_mock)
    await r.record_async("session_health_mock", test_claude_code_session_health_mock)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
