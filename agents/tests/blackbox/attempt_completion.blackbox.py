"""Blackbox tests for attempt-completion domain.

attempt_completion is parameterless by contract — the canonical call shape is
``tool_call={}``. Any args supplied by the model are silently ignored: they
must not appear in the user-visible message, must not be persisted, and must
not be referenced by the verifier.
"""

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
            tool_call={},
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
            tool_call={},
            tool_call_id="tc-1",
            agent_id="agent-1",
        )

    assert len(get_captured_requests()) == 0


async def test_extra_args_are_silently_ignored():
    """Any args passed in tool_call must not leak into the posted message.

    Some older callers (and adversarial models) may still pass `result` /
    `command` / arbitrary kwargs. The handler must drop them on the floor:
    the user-visible message must equal the canonical EVENT_MESSAGE exactly,
    with no "Completion result: ..." appendix.

    NOTE: We patch ``domains.attempt_completion.handler.handle_tool_event``
    rather than the ``tools.attempt_completion`` re-export, because the
    handler imports the name directly from ``helpers.handle_tool_event``
    (the re-export on ``tools.attempt_completion`` is a separate module-level
    binding used only for callsites that import via the shim).
    """
    from domains.attempt_completion.config import EVENT_MESSAGE
    from tools.attempt_completion import AttemptCompletionManager

    manager = AttemptCompletionManager()
    mock_execute = AsyncMock()
    mock_handle = AsyncMock()

    with patch("domains.attempt_completion.handler.handle_tool_event", new=mock_handle):
        result = await manager.execute_tool(
            execute_activity=mock_execute,
            tool_call={
                "result": "I claim I sent the email.",
                "command": "echo done",
                "anything": "else",
            },
            tool_call_id="tc-extra-args",
            agent_id="agent-extra",
            user_id="user-extra",
        )

    assert result["attempted"] is True
    assert mock_handle.await_count == 1, (
        f"handle_tool_event should be invoked exactly once, got {mock_handle.await_count}"
    )
    # The handler is called with `event=ToolEvent(...)` as a kwarg.
    call_kwargs = mock_handle.await_args.kwargs
    assert "event" in call_kwargs, f"event kwarg missing in {call_kwargs!r}"
    posted_message = call_kwargs["event"].message
    assert posted_message == EVENT_MESSAGE, (
        f"attempt_completion message must equal EVENT_MESSAGE exactly — "
        f"args must NOT leak. Got: {posted_message!r}"
    )
    assert "Completion result" not in posted_message
    assert "I claim" not in posted_message
    assert "echo done" not in posted_message


async def run_all_tests():
    print("attempt-completion blackbox tests:")
    r = BlackboxResult()
    await r.record_async("returns_attempted_true", test_returns_attempted_true)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    await r.record_async("extra_args_are_silently_ignored", test_extra_args_are_silently_ignored)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
