"""Blackbox tests for cursor_api domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup_launch():
    setup_mock({
        "/v1/agents": {
            "status": 200,
            "json": {
                "id": "cursor-agent-123",
                "status": "pending",
            },
        },
    })


def _setup_status():
    setup_mock({
        "/v1/agents/cursor-agent-123": {
            "status": 200,
            "json": {
                "status": "completed",
                "branch": "feature/my-branch",
                "commitSha": "abc123",
                "filesChanged": ["src/main.py"],
            },
        },
    })


async def test_launch_agent_happy_path():
    """launch_cursor_agent POSTs to Cursor API and returns agent_id."""
    _setup_launch()
    from helpers.cursor_api import launch_cursor_agent

    result = await launch_cursor_agent(
        api_key="test-key",
        goal="Fix the login bug",
        github_repo="https://github.com/owner/repo",
        branch_name="fix/login-bug",
    )

    assert result["agent_id"] == "cursor-agent-123"
    assert result["status"] == "pending"
    assert result["branch_name"] == "fix/login-bug"

    call = assert_captured_call(
        url_contains="/v1/agents",
        method="POST",
        header_present="Authorization",
    )


async def test_get_status_happy_path():
    """get_cursor_agent_status GETs status from Cursor API."""
    _setup_status()
    from helpers.cursor_api import get_cursor_agent_status

    status = await get_cursor_agent_status(
        api_key="test-key",
        agent_id="cursor-agent-123",
    )

    assert status.agent_id == "cursor-agent-123"
    assert status.status == "completed"
    assert status.branch_name == "feature/my-branch"
    assert status.commit_sha == "abc123"
    assert status.files_changed == ["src/main.py"]


async def test_auth_header_format():
    """Cursor API uses Basic Auth with API key as username."""
    _setup_launch()
    from helpers.cursor_api import _get_auth_header

    header = _get_auth_header("my-api-key")

    assert header.startswith("Basic ")
    # Decode and verify format
    import base64
    decoded = base64.b64decode(header.replace("Basic ", "")).decode()
    assert decoded == "my-api-key:"


async def run_all_tests():
    print("cursor-api blackbox tests:")
    r = BlackboxResult()
    await r.record_async("launch_agent_happy_path", test_launch_agent_happy_path)
    await r.record_async("get_status_happy_path", test_get_status_happy_path)
    await r.record_async("auth_header_format", test_auth_header_format)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
