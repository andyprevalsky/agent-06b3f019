"""Blackbox tests for claude_code_ws_client domain."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def _make_client(**overrides):
    """Helper: build a client with minimal stub callbacks."""
    from helpers.claude_code_ws_client import ClaudeCodeWsClient

    outputs: list = []
    exits: list = []
    conn_changes: list = []
    stdin_errors: list = []
    events: list = []

    async def on_output(data, is_buffer):
        outputs.append((data, is_buffer))

    async def on_exit(code):
        exits.append(code)

    async def on_connection_change(is_connected):
        conn_changes.append(is_connected)

    async def on_stdin_error(err):
        stdin_errors.append(err)

    async def on_event(event):
        events.append(event)

    kwargs = {
        "ws_url": "ws://test:1234",
        "on_output": on_output,
        "on_exit": on_exit,
        "on_connection_change": on_connection_change,
        "on_stdin_error": on_stdin_error,
        "on_event": on_event,
    }
    kwargs.update(overrides)
    client = ClaudeCodeWsClient(**kwargs)
    client._test_outputs = outputs  # type: ignore[attr-defined]
    client._test_exits = exits  # type: ignore[attr-defined]
    client._test_conn_changes = conn_changes  # type: ignore[attr-defined]
    client._test_stdin_errors = stdin_errors  # type: ignore[attr-defined]
    client._test_events = events  # type: ignore[attr-defined]
    return client


def test_init_state():
    """ClaudeCodeWsClient initializes with correct default state."""
    client = _make_client(ws_url="ws://test:1234")

    assert client.is_connected is False
    assert client.has_exited is False
    assert client.reconnects_exhausted is False
    assert client.ws_url == "ws://test:1234"


def test_init_with_options():
    """ClaudeCodeWsClient stores custom max_reconnects and reconnect_delay."""
    client = _make_client(ws_url="ws://test:5678", max_reconnects=3, reconnect_delay=2.0)

    assert client.max_reconnects == 3
    assert client.reconnect_delay == 2.0


def test_no_outbound_http():
    """Creating ClaudeCodeWsClient makes zero HTTP calls."""
    client = _make_client(ws_url="ws://test:9999")

    captures = get_captured_requests()
    assert len(captures) == 0, f"Expected 0 HTTP calls, got {len(captures)}"
    # Keep a reference
    assert client.ws_url == "ws://test:9999"


async def test_handle_message_buffer():
    """_handle_message with type=buffer routes to on_output with is_buffer=True."""
    client = _make_client()
    await client._handle_message(json.dumps({"type": "buffer", "data": "full state"}))
    assert client._test_outputs == [("full state", True)]


async def test_handle_message_stdout_and_stderr():
    """_handle_message with type=stdout/stderr routes to on_output with is_buffer=False."""
    client = _make_client()
    await client._handle_message(json.dumps({"type": "stdout", "data": "hello"}))
    await client._handle_message(json.dumps({"type": "stderr", "data": "err"}))
    assert ("hello", False) in client._test_outputs
    assert ("err", False) in client._test_outputs


async def test_handle_message_code_agent_event_routes_json():
    """_handle_message routes normalized code-agent JSON events without terminal scraping."""
    client = _make_client()
    event = {"version": 1, "provider": "codex", "type": "file_change", "paths": ["/home/user/output/a.png"]}
    await client._handle_message(json.dumps({"type": "code_agent_event", "data": event}))
    assert client._test_events == [event]


async def test_handle_message_code_agent_events_replays_buffer():
    """_handle_message routes replayed normalized event buffers in order."""
    client = _make_client()
    events = [
        {"version": 1, "provider": "claude", "type": "session"},
        {"version": 1, "provider": "claude", "type": "result"},
    ]
    await client._handle_message(json.dumps({"type": "code_agent_events", "data": events}))
    assert client._test_events == events


async def test_handle_message_exit_sets_exited():
    """_handle_message with type=exit sets _exited=True and invokes on_exit."""
    client = _make_client()
    await client._handle_message(json.dumps({"type": "exit", "code": 7}))
    assert client.has_exited is True
    assert client._test_exits == [7]


async def test_handle_message_error_logs_only():
    """_handle_message with type=error logs and does NOT trigger callbacks."""
    client = _make_client()
    await client._handle_message(json.dumps({"type": "error", "data": "server oops"}))
    assert client._test_outputs == []
    assert client._test_exits == []


async def test_handle_message_stdin_ack_sets_result_true():
    """_handle_message with type=stdin_ack sets result=True on pending event."""
    client = _make_client()
    client._stdin_ack_event = asyncio.Event()
    await client._handle_message(json.dumps({"type": "stdin_ack", "bytes": 5}))
    assert client._stdin_ack_result is True
    assert client._stdin_ack_event.is_set()


async def test_handle_message_stdin_error_sets_result_false():
    """_handle_message with type=stdin_error triggers on_stdin_error callback."""
    client = _make_client()
    client._stdin_ack_event = asyncio.Event()
    await client._handle_message(json.dumps({"type": "stdin_error", "error": "pipe closed"}))
    assert client._stdin_ack_result is False
    assert client._stdin_ack_event.is_set()
    assert client._test_stdin_errors == ["pipe closed"]


async def test_handle_message_unknown_type():
    """_handle_message with unknown type logs warning, no callback."""
    client = _make_client()
    await client._handle_message(json.dumps({"type": "ping"}))
    assert client._test_outputs == []
    assert client._test_exits == []


async def test_handle_message_non_json_falls_through_to_stdout():
    """_handle_message on non-JSON data sends raw data as stdout output."""
    client = _make_client()
    await client._handle_message("not json at all")
    assert client._test_outputs == [("not json at all", False)]


async def test_connect_success():
    """connect() returns True and invokes on_connection_change(True)."""
    client = _make_client()
    mock_ws = MagicMock()
    mock_ws.closed = False
    mock_session = MagicMock()
    mock_session.ws_connect = AsyncMock(return_value=mock_ws)

    with patch(
        "helpers.claude_code_ws_client.aiohttp.ClientSession",
        return_value=mock_session,
    ):
        ok = await client.connect()

    assert ok is True
    assert client._running is True
    assert client._test_conn_changes == [True]


async def test_connect_failure_returns_false():
    """connect() returns False if ws_connect raises."""
    client = _make_client()

    mock_session = MagicMock()
    mock_session.ws_connect = AsyncMock(side_effect=Exception("refused"))

    with patch(
        "helpers.claude_code_ws_client.aiohttp.ClientSession",
        return_value=mock_session,
    ):
        ok = await client.connect()

    assert ok is False
    assert client._test_conn_changes == []  # no notification on failure


async def test_disconnect_closes_ws_and_session():
    """disconnect() closes the websocket and session, clears state."""
    client = _make_client()
    mock_ws = MagicMock()
    mock_ws.closed = False
    mock_ws.close = AsyncMock()
    mock_session = MagicMock()
    mock_session.closed = False
    mock_session.close = AsyncMock()
    client._ws = mock_ws
    client._session = mock_session
    client._running = True

    await client.disconnect()

    assert client._running is False
    assert client._ws is None
    assert client._session is None
    mock_ws.close.assert_awaited_once()
    mock_session.close.assert_awaited_once()


async def test_send_stdin_not_connected_returns_false():
    """send_stdin returns False when not connected."""
    client = _make_client()
    # _ws is None
    ok = await client.send_stdin("hello")
    assert ok is False


async def test_send_stdin_timeout_returns_false():
    """send_stdin returns False on ack timeout."""
    client = _make_client()
    mock_ws = MagicMock()
    mock_ws.closed = False
    mock_ws.send_str = AsyncMock()
    client._ws = mock_ws

    # Patch wait_for to raise TimeoutError
    with patch("helpers.claude_code_ws_client.asyncio.wait_for", side_effect=asyncio.TimeoutError()):
        ok = await client.send_stdin("test data")

    assert ok is False
    mock_ws.send_str.assert_awaited_once()


async def test_send_stdin_success_returns_true():
    """send_stdin returns True when ack is received."""
    client = _make_client()
    mock_ws = MagicMock()
    mock_ws.closed = False
    mock_ws.send_str = AsyncMock()
    client._ws = mock_ws

    async def fake_wait_for(coro, timeout):
        # Simulate successful ack having already been set
        client._stdin_ack_result = True
        # consume the coroutine without actually waiting
        coro.close()

    with patch("helpers.claude_code_ws_client.asyncio.wait_for", side_effect=fake_wait_for):
        ok = await client.send_stdin("test data")

    assert ok is True
    mock_ws.send_str.assert_awaited_once()


async def test_send_stdin_exception_returns_false():
    """send_stdin returns False when send_str raises."""
    client = _make_client()
    mock_ws = MagicMock()
    mock_ws.closed = False
    mock_ws.send_str = AsyncMock(side_effect=RuntimeError("boom"))
    client._ws = mock_ws

    ok = await client.send_stdin("x")
    assert ok is False


async def test_reconnect_success_after_attempts():
    """_reconnect succeeds on first successful connect()."""
    client = _make_client(max_reconnects=3, reconnect_delay=0.0)

    async def fake_connect():
        client._ws = MagicMock()
        client._ws.closed = False
        return True

    with (
        patch.object(client, "connect", side_effect=fake_connect),
        patch("helpers.claude_code_ws_client.asyncio.sleep", new=AsyncMock()),
    ):
        ok = await client._reconnect()

    assert ok is True
    assert client._reconnect_count == 1


async def test_reconnect_exhausts_attempts():
    """_reconnect returns False after all attempts fail."""
    client = _make_client(max_reconnects=2, reconnect_delay=0.0)

    with (
        patch.object(client, "connect", new=AsyncMock(return_value=False)),
        patch("helpers.claude_code_ws_client.asyncio.sleep", new=AsyncMock()),
    ):
        ok = await client._reconnect()

    assert ok is False
    assert client._reconnect_count == 2


async def test_listen_loop_processes_text_and_exits_on_closed():
    """_listen_loop iterates ws messages, routes TEXT to _handle_message, stops on CLOSED."""
    import aiohttp

    client = _make_client()

    msg_text = MagicMock()
    msg_text.type = aiohttp.WSMsgType.TEXT
    msg_text.data = '{"type": "stdout", "data": "hello"}'
    msg_closed = MagicMock()
    msg_closed.type = aiohttp.WSMsgType.CLOSED

    class FakeWs:
        def __init__(self, messages):
            self._messages = list(messages)

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._messages:
                raise StopAsyncIteration
            return self._messages.pop(0)

    client._ws = FakeWs([msg_text, msg_closed])
    client._running = True

    heartbeats = []
    client.heartbeat_fn = lambda msg: heartbeats.append(msg)

    await client._listen_loop()

    assert ("hello", False) in client._test_outputs
    assert len(heartbeats) >= 1


async def test_listen_loop_exits_on_error_type():
    """_listen_loop breaks out when WSMsgType.ERROR received."""
    import aiohttp

    client = _make_client()
    msg_err = MagicMock()
    msg_err.type = aiohttp.WSMsgType.ERROR

    class FakeWs:
        def __init__(self, messages):
            self._messages = list(messages)

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._messages:
                raise StopAsyncIteration
            return self._messages.pop(0)

        def exception(self):
            return RuntimeError("ws error")

    client._ws = FakeWs([msg_err])
    client._running = True

    await client._listen_loop()
    # Should have exited cleanly without raising


async def test_listen_loop_no_ws_returns_early():
    """_listen_loop returns immediately if _ws is None."""
    client = _make_client()
    client._ws = None
    # should not raise
    await client._listen_loop()


async def test_listen_exits_when_exited_flag_set():
    """listen() exits cleanly when _exited was set during _listen_loop."""
    client = _make_client()
    client._running = True
    client._exited = True

    # _listen_loop will be called once and exit immediately because _exited is True
    async def fake_listen_loop():
        return

    with patch.object(client, "_listen_loop", new=AsyncMock(side_effect=fake_listen_loop)):
        await client.listen()

    # No reconnect attempts should have been made
    assert client._reconnect_count == 0


async def test_listen_reconnects_on_disconnect_then_exits_when_max_reached():
    """listen() calls _reconnect on disconnect; when it fails, sets reconnects_exhausted."""
    client = _make_client(max_reconnects=1, reconnect_delay=0.0)
    client._running = True

    # _listen_loop returns immediately (simulating disconnect)
    async def fake_listen_loop():
        return

    # _reconnect returns False (max exceeded)
    with (
        patch.object(client, "_listen_loop", new=AsyncMock(side_effect=fake_listen_loop)),
        patch.object(client, "_reconnect", new=AsyncMock(return_value=False)),
    ):
        await client.listen()

    assert client.reconnects_exhausted is True
    # on_connection_change(False) was called
    assert client._test_conn_changes == [False]


async def test_listen_handles_exception_then_reconnects():
    """listen() catches generic Exception from _listen_loop and calls _reconnect."""
    client = _make_client(max_reconnects=1, reconnect_delay=0.0)
    client._running = True

    call_counter = {"n": 0}

    async def fake_listen_loop():
        call_counter["n"] += 1
        raise RuntimeError("boom")

    reconnect_calls = {"n": 0}

    async def fake_reconnect():
        reconnect_calls["n"] += 1
        return False

    with (
        patch.object(client, "_listen_loop", new=AsyncMock(side_effect=fake_listen_loop)),
        patch.object(client, "_reconnect", new=AsyncMock(side_effect=fake_reconnect)),
    ):
        await client.listen()

    assert call_counter["n"] == 1
    assert reconnect_calls["n"] == 1
    assert client.reconnects_exhausted is True


async def run_all_tests():
    print("claude-code-ws-client blackbox tests:")
    r = BlackboxResult()
    r.record("init_state", test_init_state)
    r.record("init_with_options", test_init_with_options)
    r.record("no_outbound_http", test_no_outbound_http)
    await r.record_async("handle_message_buffer", test_handle_message_buffer)
    await r.record_async("handle_message_stdout_and_stderr", test_handle_message_stdout_and_stderr)
    await r.record_async("handle_message_code_agent_event_routes_json", test_handle_message_code_agent_event_routes_json)
    await r.record_async("handle_message_code_agent_events_replays_buffer", test_handle_message_code_agent_events_replays_buffer)
    await r.record_async("handle_message_exit_sets_exited", test_handle_message_exit_sets_exited)
    await r.record_async("handle_message_error_logs_only", test_handle_message_error_logs_only)
    await r.record_async("handle_message_stdin_ack_sets_result_true", test_handle_message_stdin_ack_sets_result_true)
    await r.record_async("handle_message_stdin_error_sets_result_false", test_handle_message_stdin_error_sets_result_false)
    await r.record_async("handle_message_unknown_type", test_handle_message_unknown_type)
    await r.record_async("handle_message_non_json_falls_through_to_stdout", test_handle_message_non_json_falls_through_to_stdout)
    await r.record_async("connect_success", test_connect_success)
    await r.record_async("connect_failure_returns_false", test_connect_failure_returns_false)
    await r.record_async("disconnect_closes_ws_and_session", test_disconnect_closes_ws_and_session)
    await r.record_async("send_stdin_not_connected_returns_false", test_send_stdin_not_connected_returns_false)
    await r.record_async("send_stdin_timeout_returns_false", test_send_stdin_timeout_returns_false)
    await r.record_async("send_stdin_success_returns_true", test_send_stdin_success_returns_true)
    await r.record_async("send_stdin_exception_returns_false", test_send_stdin_exception_returns_false)
    await r.record_async("reconnect_success_after_attempts", test_reconnect_success_after_attempts)
    await r.record_async("reconnect_exhausts_attempts", test_reconnect_exhausts_attempts)
    await r.record_async("listen_loop_processes_text_and_exits_on_closed", test_listen_loop_processes_text_and_exits_on_closed)
    await r.record_async("listen_loop_exits_on_error_type", test_listen_loop_exits_on_error_type)
    await r.record_async("listen_loop_no_ws_returns_early", test_listen_loop_no_ws_returns_early)
    await r.record_async("listen_exits_when_exited_flag_set", test_listen_exits_when_exited_flag_set)
    await r.record_async("listen_reconnects_on_disconnect_then_exits_when_max_reached", test_listen_reconnects_on_disconnect_then_exits_when_max_reached)
    await r.record_async("listen_handles_exception_then_reconnects", test_listen_handles_exception_then_reconnects)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
