"""Blackbox tests for cursor_api domain."""

import asyncio
from unittest.mock import patch

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


async def test_launch_agent_with_model_and_auto_pr():
    """launch_cursor_agent includes model and autoCreatePr when set."""
    _setup_launch()
    from helpers.cursor_api import launch_cursor_agent

    await launch_cursor_agent(
        api_key="test-key",
        goal="a" * 200,  # long goal exercising truncation in log
        github_repo="https://github.com/owner/repo",
        branch_name="b",
        auto_create_pr=True,
        model="gpt-5",
    )
    import json
    call = assert_captured_call(url_contains="/v1/agents", method="POST")
    body = json.loads(call["requestBody"])
    assert body["autoCreatePr"] is True
    assert body["model"] == "gpt-5"


async def test_poll_status_completes():
    """poll_cursor_agent_status returns once status becomes completed."""
    from helpers.cursor_api import CursorAgentStatus
    import helpers.cursor_api as cursor_mod

    # Simulate two status calls: first running, then completed
    call_count = [0]
    completed_status = CursorAgentStatus(
        agent_id="a-1",
        status="completed",
        branch_name="b",
        files_changed=["f.py"],
    )
    running_status = CursorAgentStatus(agent_id="a-1", status="running")

    async def fake_get_status(api_key, agent_id, base_url="x"):
        call_count[0] += 1
        if call_count[0] == 1:
            return running_status
        return completed_status

    async def fast_sleep(_):
        return None

    # Also track on_status_update calls
    cb_calls = []
    async def cb(status):
        cb_calls.append(status.status)

    with patch.object(cursor_mod, "get_cursor_agent_status", fake_get_status):
        with patch("asyncio.sleep", fast_sleep):
            status = await cursor_mod.poll_cursor_agent_status(
                api_key="k",
                agent_id="a-1",
                poll_interval=0.01,
                timeout=10.0,
                on_status_update=cb,
            )
    assert status.status == "completed"
    # Both status changes reported through callback (running -> completed)
    assert "running" in cb_calls
    assert "completed" in cb_calls


async def test_poll_status_times_out():
    """poll_cursor_agent_status raises TimeoutError."""
    from helpers.cursor_api import CursorAgentStatus
    import helpers.cursor_api as cursor_mod

    running_status = CursorAgentStatus(agent_id="a-1", status="running")

    async def fake_get_status(api_key, agent_id, base_url="x"):
        return running_status

    async def fast_sleep(_):
        return None

    # Use fake loop time that leaps past timeout
    time_vals = [0.0, 0.0, 1000.0]
    def fake_time():
        return time_vals.pop(0) if time_vals else 1000.0

    class FakeLoop:
        def time(self):
            return fake_time()

    with patch.object(cursor_mod, "get_cursor_agent_status", fake_get_status):
        with patch("asyncio.sleep", fast_sleep):
            with patch("asyncio.get_event_loop", return_value=FakeLoop()):
                try:
                    await cursor_mod.poll_cursor_agent_status(
                        api_key="k",
                        agent_id="a-1",
                        poll_interval=0.01,
                        timeout=1.0,
                    )
                    raise AssertionError("expected TimeoutError")
                except TimeoutError:
                    pass


async def test_poll_status_callback_exception_ignored():
    """poll_cursor_agent_status handles callback exceptions gracefully."""
    from helpers.cursor_api import CursorAgentStatus
    import helpers.cursor_api as cursor_mod

    completed_status = CursorAgentStatus(agent_id="a-1", status="completed")

    async def fake_get_status(*a, **kw):
        return completed_status

    async def fast_sleep(_):
        return None

    async def bad_cb(status):
        raise RuntimeError("bad cb")

    with patch.object(cursor_mod, "get_cursor_agent_status", fake_get_status):
        with patch("asyncio.sleep", fast_sleep):
            status = await cursor_mod.poll_cursor_agent_status(
                api_key="k",
                agent_id="a-1",
                poll_interval=0.01,
                timeout=10.0,
                on_status_update=bad_cb,
            )
    assert status.status == "completed"


async def test_stop_cursor_agent():
    """stop_cursor_agent POSTs to /stop endpoint."""
    setup_mock({
        "/agents/a-1/stop": {"status": 200, "json": {"ok": True}},
    })
    from helpers.cursor_api import stop_cursor_agent

    ok = await stop_cursor_agent(api_key="k", agent_id="a-1")
    assert ok is True
    assert_captured_call(url_contains="/agents/a-1/stop", method="POST", header_present="Authorization")


async def test_get_cursor_agent_conversation():
    """get_cursor_agent_conversation GETs conversation messages."""
    setup_mock({
        "/agents/a-1/conversation": {
            "status": 200,
            "json": {"messages": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hey"}]},
        },
    })
    from helpers.cursor_api import get_cursor_agent_conversation

    msgs = await get_cursor_agent_conversation(api_key="k", agent_id="a-1")
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"


async def run_all_tests():
    print("cursor-api blackbox tests:")
    r = BlackboxResult()
    await r.record_async("launch_agent_happy_path", test_launch_agent_happy_path)
    await r.record_async("get_status_happy_path", test_get_status_happy_path)
    await r.record_async("auth_header_format", test_auth_header_format)
    await r.record_async("launch_agent_with_model_and_auto_pr", test_launch_agent_with_model_and_auto_pr)
    await r.record_async("poll_status_completes", test_poll_status_completes)
    await r.record_async("poll_status_times_out", test_poll_status_times_out)
    await r.record_async("poll_status_callback_exception_ignored", test_poll_status_callback_exception_ignored)
    await r.record_async("stop_cursor_agent", test_stop_cursor_agent)
    await r.record_async("get_cursor_agent_conversation", test_get_cursor_agent_conversation)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
