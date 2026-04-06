"""Blackbox tests for attempt-completion domain."""

import asyncio
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, get_captured_requests, teardown_mock


async def test_returns_attempted_true():
    """attempt_completion returns {attempted: True} without making HTTP calls."""
    from tools.attempt_completion import AttemptCompletionManager

    manager = AttemptCompletionManager()
    mock_execute = AsyncMock()

    with patch("tools.attempt_completion.handle_tool_event", new_callable=AsyncMock):
        result = await manager.execute_tool(
            execute_activity=mock_execute,
            tool_call={
                "result": "Task completed successfully",
                "command": "echo done",
            },
            tool_call_id="tc-123",
            agent_id="agent-456",
            user_id="user-789",
        )

    assert result["attempted"] is True


async def test_no_outbound_http_calls():
    """attempt_completion makes zero outbound HTTP calls."""
    from tools.attempt_completion import AttemptCompletionManager

    manager = AttemptCompletionManager()
    mock_execute = AsyncMock()

    with patch("tools.attempt_completion.handle_tool_event", new_callable=AsyncMock):
        await manager.execute_tool(
            execute_activity=mock_execute,
            tool_call={"result": "Done"},
            tool_call_id="tc-1",
            agent_id="agent-1",
        )

    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("attempt-completion blackbox tests:")
    r = BlackboxResult()
    await r.record_async("returns_attempted_true", test_returns_attempted_true)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
