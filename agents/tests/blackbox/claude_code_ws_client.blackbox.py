"""Blackbox tests for claude_code_ws_client domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_init_state():
    """ClaudeCodeWsClient initializes with correct default state."""
    from helpers.claude_code_ws_client import ClaudeCodeWsClient

    async def mock_on_output(data, is_buffer):
        pass

    async def mock_on_exit(code):
        pass

    client = ClaudeCodeWsClient(
        ws_url="ws://test:1234",
        on_output=mock_on_output,
        on_exit=mock_on_exit,
    )

    assert client.is_connected is False
    assert client.has_exited is False
    assert client.reconnects_exhausted is False
    assert client.ws_url == "ws://test:1234"


def test_init_with_options():
    """ClaudeCodeWsClient stores custom max_reconnects and reconnect_delay."""
    from helpers.claude_code_ws_client import ClaudeCodeWsClient

    async def mock_on_output(data, is_buffer):
        pass

    async def mock_on_exit(code):
        pass

    client = ClaudeCodeWsClient(
        ws_url="ws://test:5678",
        on_output=mock_on_output,
        on_exit=mock_on_exit,
        max_reconnects=3,
        reconnect_delay=2.0,
    )

    assert client.max_reconnects == 3
    assert client.reconnect_delay == 2.0


def test_no_outbound_http():
    """Creating ClaudeCodeWsClient makes zero HTTP calls."""
    from helpers.claude_code_ws_client import ClaudeCodeWsClient

    async def mock_on_output(data, is_buffer):
        pass

    async def mock_on_exit(code):
        pass

    client = ClaudeCodeWsClient(
        ws_url="ws://test:9999",
        on_output=mock_on_output,
        on_exit=mock_on_exit,
    )

    captures = get_captured_requests()
    assert len(captures) == 0, f"Expected 0 HTTP calls, got {len(captures)}"


async def run_all_tests():
    print("claude-code-ws-client blackbox tests:")
    r = BlackboxResult()
    r.record("init_state", test_init_state)
    r.record("init_with_options", test_init_with_options)
    r.record("no_outbound_http", test_no_outbound_http)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
