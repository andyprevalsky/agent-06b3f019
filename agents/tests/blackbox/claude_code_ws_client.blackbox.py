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

    async def fake_wait_for(coro, timeout):
        # asyncio.wait_for owns and consumes the coroutine it receives. Keep that
        # contract in the test double so the Event.wait coroutine is not leaked.
        coro.close()
        raise asyncio.TimeoutError()

    with patch("helpers.claude_code_ws_client.asyncio.wait_for", side_effect=fake_wait_for):
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



async def _serve_ws(handler):
    """A local WebSocket server standing in for a sandbox; returns (url, runner)."""
    import socket

    from aiohttp import web

    async def upgrade(request):
        ws = web.WebSocketResponse()
        if not ws.can_prepare(request).ok:
            # Dev-box port forwarders probe new local listeners with plain HTTP.
            return web.Response(status=400)
        await ws.prepare(request)
        await handler(request, ws)
        return ws

    app = web.Application()
    app.router.add_get("/", upgrade)
    runner = web.AppRunner(app)
    await runner.setup()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    await web.TCPSite(runner, "127.0.0.1", port).start()
    return f"ws://127.0.0.1:{port}", runner


async def test_reads_single_frame_history_larger_than_aiohttp_default():
    """Sandboxes built before bounded replay frames still reattach (multi-day RCA T1 #1).

    They send the whole history in one frame. With aiohttp's default 4 MiB
    receive limit the client closed with 1009 and never read the exit behind it.
    """
    history = [{"seq": n, "type": "agent_message", "text": "x" * 100_000} for n in range(60)]

    async def old_sandbox(_request, ws):
        await ws.send_str(json.dumps({"type": "code_agent_events", "data": history}))
        await ws.send_str(json.dumps({"type": "exit", "code": 0}))
        await ws.close()

    url, runner = await _serve_ws(old_sandbox)
    replays: list = []

    async def on_events_replay(events):
        replays.append(events)

    client = _make_client(ws_url=url, on_events_replay=on_events_replay, reconnect_delay=0.0)
    try:
        assert await client.connect()
        await asyncio.wait_for(client.listen(), timeout=10)
    finally:
        await client.disconnect()
        await runner.cleanup()
    assert client._test_exits == [0], client._test_exits
    assert len(replays) == 1 and len(replays[0]) == 60, [len(r) for r in replays]


async def test_chunked_replay_is_delivered_as_one_history():
    """A chunked replay reaches the consumer once, complete, when its last chunk arrives."""
    seen: list = []

    async def chunked_sandbox(request, ws):
        seen.append(request.query.get("replay_chunks"))
        await ws.send_str(json.dumps({"type": "code_agent_events", "chunk": 0, "last": False, "data": [{"seq": 0}]}))
        await ws.send_str(json.dumps({"type": "code_agent_events", "chunk": 1, "last": True, "data": [{"seq": 1}, {"seq": 2}]}))
        await ws.send_str(json.dumps({"type": "exit", "code": 0}))
        await ws.close()

    url, runner = await _serve_ws(chunked_sandbox)
    replays: list = []

    async def on_events_replay(events):
        replays.append(events)

    client = _make_client(ws_url=url, on_events_replay=on_events_replay)
    try:
        assert await client.connect()
        await asyncio.wait_for(client.listen(), timeout=10)
    finally:
        await client.disconnect()
        await runner.cleanup()
    assert seen == ["1"], seen
    assert replays == [[{"seq": 0}, {"seq": 1}, {"seq": 2}]] and client._test_events == [], (replays, client._test_events)


async def test_reconnects_without_progress_exhaust_the_budget():
    """A sandbox whose every connection fails before delivering anything ends the retries (T1 #1).

    connect() reset the budget on each successful handshake, so a replay that
    failed on every attempt was retried about once a second forever.
    """
    connections = 0

    async def failing_sandbox(_request, ws):
        nonlocal connections
        connections += 1
        await ws.send_str(json.dumps({"type": "buffer", "data": "terminal"}))
        await ws.close()

    url, runner = await _serve_ws(failing_sandbox)
    client = _make_client(ws_url=url, max_reconnects=3, reconnect_delay=0.0)
    try:
        assert await client.connect()
        try:
            await asyncio.wait_for(client.listen(), timeout=10)
        except asyncio.TimeoutError:
            raise AssertionError(f"reconnected {connections} times without exhausting the budget") from None
    finally:
        await client.disconnect()
        await runner.cleanup()
    assert client.reconnects_exhausted is True
    assert connections == 4, connections  # the first connect plus max_reconnects



async def test_unchanged_replays_do_not_refill_the_reconnect_budget():
    """Resending a history the client already holds is not progress (CodeRabbit 4475152990).

    A sandbox that replays the same events and then drops every connection was
    retried forever: each complete replay reset the budget. A replay that
    brings new events still counts, so a session that keeps working survives
    any number of blips.
    """
    history = [{"seq": 0, "type": "agent_message", "text": "a"}, {"seq": 1, "type": "agent_message", "text": "b"}]
    connections = 0

    async def stuck_sandbox(_request, ws):
        nonlocal connections
        connections += 1
        await ws.send_str(json.dumps({"type": "code_agent_events", "chunk": 0, "last": True, "data": history}))
        await ws.close()

    url, runner = await _serve_ws(stuck_sandbox)
    client = _make_client(ws_url=url, max_reconnects=3, reconnect_delay=0.0, on_events_replay=AsyncMock())
    try:
        assert await client.connect()
        try:
            await asyncio.wait_for(client.listen(), timeout=10)
        except asyncio.TimeoutError:
            raise AssertionError(f"identical replays kept the client reconnecting ({connections} connections)") from None
    finally:
        await client.disconnect()
        await runner.cleanup()
    assert client.reconnects_exhausted is True
    assert connections == 4, connections  # the first connect plus max_reconnects

    growing = 0

    async def working_sandbox(_request, ws):
        nonlocal growing
        growing += 1
        events = [{"seq": n, "type": "agent_message", "text": str(n)} for n in range(growing)]
        await ws.send_str(json.dumps({"type": "code_agent_events", "chunk": 0, "last": True, "data": events}))
        if growing == 8:
            await ws.send_str(json.dumps({"type": "exit", "code": 0}))
        await ws.close()

    url, runner = await _serve_ws(working_sandbox)
    client = _make_client(ws_url=url, max_reconnects=3, reconnect_delay=0.0, on_events_replay=AsyncMock())
    try:
        assert await client.connect()
        await asyncio.wait_for(client.listen(), timeout=10)
    finally:
        await client.disconnect()
        await runner.cleanup()
    assert client._test_exits == [0] and growing == 8, (client._test_exits, growing)


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
    await r.record_async("reads_single_frame_history_over_default_limit", test_reads_single_frame_history_larger_than_aiohttp_default)
    await r.record_async("chunked_replay_delivered_as_one_history", test_chunked_replay_is_delivered_as_one_history)
    await r.record_async("reconnects_without_progress_exhaust_budget", test_reconnects_without_progress_exhaust_the_budget)
    await r.record_async("unchanged_replays_do_not_refill_budget", test_unchanged_replays_do_not_refill_the_reconnect_budget)
    r.record("backoff_delay_exponential_capped_jittered", test_backoff_delay_is_exponential_capped_and_jittered)
    await r.record_async("reconnect_sleeps_jittered_backoff_and_heartbeats", test_reconnect_sleeps_jittered_backoff_and_heartbeats)
    await r.record_async("reconnect_deadline_is_configurable", test_reconnect_deadline_is_configurable)
    await r.record_async("connect_with_retry_recovers_from_failed_handshakes", test_connect_with_retry_recovers_from_failed_handshakes)
    await r.record_async("connect_with_retry_gives_up_with_last_error", test_connect_with_retry_gives_up_with_the_last_error)
    await r.record_async("connect_with_retry_stops_at_deadline", test_connect_with_retry_stops_at_the_deadline)
    await r.record_async("connect_with_retry_reaches_late_sandbox", test_connect_with_retry_reaches_a_sandbox_that_comes_up_late)
    teardown_mock()
    return r.summary()


# ── Backoff, jitter and connect retries (tar_2b02efd49fc2466497723b3e) ──


def test_backoff_delay_is_exponential_capped_and_jittered():
    """Delays double per attempt up to the cap, and jitter keeps half of each fixed."""
    from helpers.claude_code_ws_client import backoff_delay

    lows = [backoff_delay(n, 1.0, cap=20.0, rand=lambda: 0.0) for n in range(1, 8)]
    highs = [backoff_delay(n, 1.0, cap=20.0, rand=lambda: 1.0) for n in range(1, 8)]
    assert lows == [0.5, 1.0, 2.0, 4.0, 8.0, 10.0, 10.0], lows
    assert highs == [1.0, 2.0, 4.0, 8.0, 16.0, 20.0, 20.0], highs
    # Real jitter spreads simultaneous retries inside [exp/2, exp].
    samples = {backoff_delay(3, 1.0) for _ in range(50)}
    assert len(samples) > 1 and all(2.0 <= s <= 4.0 for s in samples), samples


async def test_reconnect_sleeps_jittered_backoff_and_heartbeats():
    """Every reconnect attempt waits a jittered, growing delay and keeps the activity alive."""
    beats: list[str] = []
    client = _make_client(max_reconnects=3, reconnect_delay=1.0, heartbeat_fn=beats.append)
    sleep = AsyncMock()

    with (
        patch.object(client, "connect", new=AsyncMock(return_value=False)),
        patch("helpers.claude_code_ws_client.asyncio.sleep", new=sleep),
        patch("helpers.claude_code_ws_client.random.random", return_value=0.5),
    ):
        ok = await client._reconnect()

    assert ok is False
    assert [c.args[0] for c in sleep.await_args_list] == [0.75, 1.5, 3.0]
    assert len(beats) == 3 and all("Reconnecting" in b for b in beats), beats


async def test_reconnect_deadline_is_configurable():
    """reconnect_deadline_s bounds a reconnect; the default leaves room for several 30s tries."""
    from helpers.claude_code_ws_client import RECONNECT_DEADLINE_S

    assert RECONNECT_DEADLINE_S >= 120
    client = _make_client(max_reconnects=10, reconnect_delay=0.0, reconnect_deadline_s=0.0)
    connect = AsyncMock(return_value=False)
    with patch.object(client, "connect", new=connect):
        assert await client._reconnect() is False
    connect.assert_not_awaited()


async def test_connect_with_retry_recovers_from_failed_handshakes():
    """A brief blip on attach no longer ends the run: a later attempt connects."""
    beats: list[str] = []
    client = _make_client(reconnect_delay=1.0, heartbeat_fn=beats.append)
    connect = AsyncMock(side_effect=[False, False, True])
    sleep = AsyncMock()

    with (
        patch.object(client, "connect", new=connect),
        patch("helpers.claude_code_ws_client.asyncio.sleep", new=sleep),
        patch("helpers.claude_code_ws_client.random.random", return_value=0.0),
    ):
        ok = await client.connect_with_retry(attempts=5, deadline_s=100.0)

    assert ok is True
    assert connect.await_count == 3
    assert [c.args[0] for c in sleep.await_args_list] == [0.5, 1.0]
    assert len(beats) == 2, beats


async def test_connect_with_retry_gives_up_with_the_last_error():
    """Bounded: after the attempts are spent it returns False and keeps the exact error."""
    client = _make_client(reconnect_delay=0.0)

    class Refusing:
        closed = False

        async def ws_connect(self, *_args, **_kwargs):
            raise ConnectionRefusedError("[Errno 111] Connect call failed")

    client._session = Refusing()
    ok = await client.connect_with_retry(attempts=3, deadline_s=60.0)
    assert ok is False
    assert client.last_error == "ConnectionRefusedError: [Errno 111] Connect call failed", client.last_error


async def test_connect_with_retry_stops_at_the_deadline():
    """A retry whose delay would pass the deadline is not attempted."""
    client = _make_client(reconnect_delay=10.0)
    connect = AsyncMock(return_value=False)
    with patch.object(client, "connect", new=connect):
        assert await client.connect_with_retry(attempts=5, deadline_s=1.0) is False
    assert connect.await_count == 1


async def test_connect_with_retry_reaches_a_sandbox_that_comes_up_late():
    """Real sockets: the ws-server is not listening yet on the first handshake, then starts."""
    import socket

    from aiohttp import web

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    async def upgrade(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_str(json.dumps({"type": "exit", "code": 0}))
        await ws.close()
        return ws

    app = web.Application()
    app.router.add_get("/", upgrade)
    runner = web.AppRunner(app)
    await runner.setup()

    client = _make_client(ws_url=f"ws://127.0.0.1:{port}", reconnect_delay=0.1)
    real_connect = client.connect
    handshakes: list[bool] = []
    refused = asyncio.Event()

    async def connect_and_record():
        ok = await real_connect()
        handshakes.append(ok)
        if not ok:
            refused.set()
        return ok

    async def start_late():
        # Start listening only once a handshake has actually been refused.
        await refused.wait()
        await web.TCPSite(runner, "127.0.0.1", port).start()

    starter = asyncio.create_task(start_late())
    try:
        with patch.object(client, "connect", new=connect_and_record):
            assert await client.connect_with_retry(attempts=8, deadline_s=20.0), client.last_error
        assert handshakes[0] is False and handshakes[-1] is True, handshakes
        await asyncio.wait_for(client.listen(), timeout=5)
        assert client._test_exits == [0]
    finally:
        if not starter.done():
            starter.cancel()
        await asyncio.gather(starter, return_exceptions=True)
        await client.disconnect()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
