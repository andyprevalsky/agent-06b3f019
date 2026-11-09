"""Local transport ownership controls for real multiplexer teardown methods."""

import asyncio
import contextlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer, _Client


class Transport:
    def __init__(self, *, fail=None, block=None):
        self.fail = fail
        self.block = block
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.alive = True
        self.close_calls = 0

    async def close(self, **_kwargs):
        self.close_calls += 1
        self.entered.set()
        if self.fail == "close":
            raise RuntimeError("controlled close failed")
        if self.block == "close":
            await self.release.wait()

    async def wait_closed(self):
        self.entered.set()
        if self.fail == "wait":
            raise RuntimeError("controlled wait failed")
        if self.block == "wait":
            await self.release.wait()
        self.alive = False


def mux_with(transport):
    mux = SingleCdpConnectionMultiplexer("ws://local-unused.invalid", silence_threshold=0)
    mux._upstream = transport
    return mux


async def test_failed_upstream_close_keeps_native_owner():
    for boundary in ("close", "wait"):
        socket = Transport(fail=boundary)
        mux = mux_with(socket)
        error = None
        try:
            await mux.close()
        except RuntimeError as caught:
            error = caught
        assert mux._upstream is socket, "failed close discarded the live native owner"
        assert socket.alive and error is not None, "failed transport close was acknowledged"
        assert str(error) == f"controlled {boundary} failed"
        socket.fail = None
        await mux.close()
        assert not socket.alive and mux._upstream is None


async def test_cancelled_upstream_close_keeps_native_owner():
    for boundary in ("close", "wait"):
        socket = Transport(block=boundary)
        mux = mux_with(socket)
        task = asyncio.create_task(mux.close())
        try:
            await socket.entered.wait()
            # For wait_closed cancellation, let close() return first.
            await asyncio.sleep(0)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            assert mux._upstream is socket, "cancelled close discarded the live native owner"
            assert socket.alive
            socket.release.set()
            await mux.close()
            assert not socket.alive and mux._upstream is None
        finally:
            socket.release.set()
            await asyncio.gather(task, return_exceptions=True)


async def test_pending_upstream_close_retains_owner_until_ack():
    socket = Transport(block="wait")
    mux = mux_with(socket)
    task = asyncio.create_task(mux.close())
    try:
        await socket.entered.wait()
        await asyncio.sleep(0)
        assert mux._upstream is socket and mux.upstream_attached, "pending close lost its owner"
        assert not task.done() and socket.alive, "close returned before native acknowledgement"
        socket.release.set()
        await task
        assert mux._upstream is None and not socket.alive
    finally:
        socket.release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_failed_downstream_close_is_not_confirmed():
    for boundary in ("close", "wait"):
        socket = Transport(fail=boundary)
        mux = mux_with(Transport())
        client = _Client(socket, 1)
        mux._clients.add(client)
        error = None
        try:
            await mux.close()
        except RuntimeError as caught:
            error = caught
        assert error is not None and client in mux._clients and socket.alive, "live downstream acknowledged"
        socket.fail = None
        await mux.close()
        assert not socket.alive


async def test_failed_listener_close_retains_owner():
    class Listener(Transport):
        def close(self):
            self.close_calls += 1

    listener = Listener(fail="wait")
    mux = mux_with(Transport())
    mux._server = listener
    error = None
    try:
        await mux.close()
    except RuntimeError as caught:
        error = caught
    assert error is not None and mux._server is listener, "listener failure lost native custody"
    listener.fail = None
    await mux.close()
    assert not listener.alive and mux._server is None


async def test_close_joins_cancelled_nested_tasks():
    release = asyncio.Event()
    cancelling = asyncio.Event()

    async def nested():
        try:
            await asyncio.Future()
        finally:
            cancelling.set()
            await release.wait()

    mux = mux_with(Transport())
    nested_task = asyncio.create_task(nested())
    mux._background.add(nested_task)
    nested_task.add_done_callback(mux._background.discard)
    await asyncio.sleep(0)
    closer = asyncio.create_task(mux.close())
    try:
        await cancelling.wait()
        assert not closer.done(), "close acknowledged while a nested task was unwinding"
        assert nested_task in mux._background
        release.set()
        await closer
        assert nested_task.done() and not mux._background
    finally:
        release.set()
        await asyncio.gather(nested_task, closer, return_exceptions=True)


async def test_cancelled_listener_and_downstream_keep_native_owners():
    class Listener(Transport):
        def close(self):
            self.close_calls += 1

    for is_listener in (False, True):
        socket = Listener(block="wait") if is_listener else Transport(block="wait")
        mux = mux_with(Transport())
        client = _Client(socket, 1)
        if is_listener:
            mux._server = socket
        else:
            mux._clients.add(client)
        task = asyncio.create_task(mux.close())
        try:
            await socket.entered.wait()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            assert socket.alive
            assert mux._server is socket if is_listener else client in mux._clients
            socket.release.set()
            await mux.close()
            assert not socket.alive
        finally:
            socket.release.set()
            await asyncio.gather(task, return_exceptions=True)


async def test_cancelled_dial_confirmation_retains_native_socket():
    class DialTransport(Transport):
        async def recv(self):
            self.entered.set()
            await asyncio.Future()

    socket = DialTransport()

    async def connect(_url):
        return socket

    mux = SingleCdpConnectionMultiplexer("ws://local-unused.invalid", upstream_connect=connect)
    task = asyncio.create_task(mux._ensure_upstream())
    try:
        await socket.entered.wait()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        assert mux._dialing_upstream is socket, "cancelled confirmation lost its newly dialled socket"
        assert mux._upstream is None, "cancelled confirmation published an unusable upstream"
        await mux.close()
        assert not socket.alive
    finally:
        await asyncio.gather(task, return_exceptions=True)


async def test_reader_failure_keeps_socket_until_native_close():
    class ReaderTransport(Transport):
        async def __aiter__(self):
            raise ValueError("controlled reader failure")
            yield "unreachable"

    socket = ReaderTransport(fail="close")
    mux = mux_with(socket)
    reader = asyncio.create_task(mux._read_upstream(socket))
    mux._reader = reader
    await asyncio.gather(reader, return_exceptions=True)
    assert mux._upstream is socket and socket.alive, "reader failure lost a live native socket"
    socket.fail = None
    await mux.close()
    assert not socket.alive


async def test_close_joins_downstream_sender_tail():
    entered, release = asyncio.Event(), asyncio.Event()

    async def sender():
        try:
            await asyncio.Future()
        finally:
            entered.set()
            await release.wait()

    mux = mux_with(Transport())
    client = _Client(Transport(), 1)
    client.sender = asyncio.create_task(sender())
    mux._clients.add(client)
    await asyncio.sleep(0)
    task = asyncio.create_task(mux.close())
    try:
        # On the broken implementation the sender is never cancelled.
        await asyncio.sleep(0)
        assert entered.is_set() or not task.done(), "close acknowledged a running sender"
        await asyncio.sleep(0)
        assert not task.done() and client in mux._clients, "sender tail lost custody"
        release.set()
        await task
        assert client.sender is None and client not in mux._clients
    finally:
        release.set()
        if client.sender is not None:
            client.sender.cancel()
            await asyncio.gather(client.sender, return_exceptions=True)
        await asyncio.gather(task, return_exceptions=True)


async def test_failed_close_never_emits_cleanup_receipt():
    from unittest.mock import AsyncMock, patch
    from browser_tools.dom_service import DOMService
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    socket = Transport(fail="close")
    mux = mux_with(socket)
    dom = DOMService("ws://local-unused.invalid", cdp_multiplexer=mux)
    receipt = AsyncMock()
    with browser_cleanup_owners() as owners, patch.object(handler, "acknowledge_browser_activity_cleanup", receipt):
        owners.track_dom(dom)
        await handler._schedule_browser_cleanup(
            agent_id="local-mux-control",
            task_id=None,
            user_id="local-mux-control",
            browser_url=None,
            browser_session_metadata={},
            input_page=None,
            start_url="",
            cursor_streamer=None,
            interaction_layer_task=None,
            humanizer=None,
            browser_network_recorder=None,
            network_recorder_task=None,
            browser_recorder=None,
            dom_service=None,
            playwright_browser=None,
            playwright_instance=None,
            playwright_driver_pid=None,
            emit_task_terminal=False,
        )
    print(
        {
            "native_alive": socket.alive,
            "mux_retains_upstream": mux._upstream is socket,
            "dom_confirmed": dom.disconnect_confirmed,
            "cleanup_receipts": receipt.await_count,
        }
    )
    assert socket.alive and mux._upstream is socket, "live socket lost native custody"
    assert not dom.disconnect_confirmed and receipt.await_count == 0, "live socket emitted cleanup receipt"
    socket.fail = None
    await dom.disconnect()
    assert not socket.alive and dom.disconnect_confirmed


async def test_real_loopback_socket_retained_after_failed_close():
    import websockets

    async def serve(socket):
        await socket.wait_closed()

    async with websockets.serve(serve, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        wire = await websockets.connect(f"ws://127.0.0.1:{port}", proxy=None)

        class FailingWire:
            fail = True

            async def close(self):
                if self.fail:
                    raise RuntimeError("controlled native wire close failed")
                await wire.close()

            async def wait_closed(self):
                await wire.wait_closed()

        socket = FailingWire()
        mux = mux_with(socket)
        try:
            with contextlib.suppress(RuntimeError):
                await mux.close()
            assert wire.state.name == "OPEN", "the injected close failure did not leave a real live socket"
            assert mux._upstream is socket, "real live transport lost its owner after close failed"
            socket.fail = False
            await mux.close()
            assert wire.state.name == "CLOSED" and mux._upstream is None
        finally:
            await wire.close()
            await wire.wait_closed()


async def test_cancelled_real_multiplexer_cannot_confirm_dom_disconnect():
    from browser_tools.dom_service import DOMService

    socket = Transport(block="close")
    mux = mux_with(socket)
    dom = DOMService("ws://local-unused.invalid", cdp_multiplexer=mux)
    task = asyncio.create_task(dom.disconnect())
    try:
        await socket.entered.wait()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        assert dom.cdp_multiplexer is mux and not dom.disconnect_confirmed
        socket.release.set()
        await dom.disconnect()
        assert not socket.alive, "DOM acknowledged retry after the cancelled multiplexer lost its live socket"
        assert socket.close_calls == 2 and dom.disconnect_confirmed
    finally:
        socket.release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_close_drains_work_admitted_during_transport_close():
    pending = []

    async def descendant():
        await asyncio.Future()

    class LateTransport(Transport):
        async def close(self, **kwargs):
            task = asyncio.create_task(descendant())
            pending.append(task)
            mux._background.add(task)
            task.add_done_callback(mux._background.discard)
            await super().close(**kwargs)

    mux = mux_with(LateTransport())
    try:
        await mux.close()
        assert pending and all(task.done() for task in pending), "late descendant outlived confirmed teardown"
        assert not mux._background
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


async def run_all_tests():
    from _test_utils import BlackboxResult

    results = BlackboxResult()
    for name, test in sorted(globals().copy().items()):
        if name.startswith("test_"):
            await results.record_async(name, test)
    return results.summary()


async def test_unconfirmed_socket_is_not_available_to_departing_client():
    entered, release = asyncio.Event(), asyncio.Event()

    class Wire(Transport):
        def __init__(self):
            super().__init__()
            self.sent = []

        async def recv(self):
            entered.set()
            await release.wait()
            return "{}"

        async def send(self, message):
            self.sent.append(message)

        async def __aiter__(self):
            await asyncio.Future()
            yield ""

    wire = Wire()

    async def connect(_url):
        return wire

    mux = SingleCdpConnectionMultiplexer("ws://local-unused.invalid", upstream_connect=connect)
    remaining = _Client(Transport(), 1)
    departing = _Client(Transport(), 2, browser_session_id="old-browser-session")
    mux._clients.add(remaining)
    opening = asyncio.create_task(mux._ensure_upstream())
    try:
        await entered.wait()
        await mux._release_client(departing)
        assert not wire.sent, "departing client sent detach through an unconfirmed provider socket"
        assert mux._upstream is None, "unconfirmed transport was published as usable"
        release.set()
        await opening
        assert mux._upstream is wire and mux._reader is not None
    finally:
        release.set()
        await asyncio.gather(opening, return_exceptions=True)
        await mux.close()


async def test_confirmation_error_cannot_reuse_socket_without_reader():
    class Wire(Transport):
        async def recv(self):
            raise ValueError("controlled confirmation failure")

        async def __aiter__(self):
            await asyncio.Future()
            yield ""

    first, second = Wire(), Wire()
    wires = iter((first, second))
    calls = []

    async def connect(_url):
        wire = next(wires)
        calls.append(wire)
        return wire

    mux = SingleCdpConnectionMultiplexer("ws://local-unused.invalid", upstream_connect=connect)
    try:
        try:
            await mux._ensure_upstream()
        except ValueError as error:
            assert str(error) == "controlled confirmation failure"
        else:
            raise AssertionError("confirmation error was lost")
        assert mux._upstream is None, "failed confirmation published a socket without a reader"
        mux._slot_confirm_seconds = 0
        await mux._ensure_upstream()
        assert calls == [first, second] and not first.alive
        assert mux._upstream is second and mux._reader is not None
    finally:
        await mux.close()


async def test_unconfirmed_socket_close_failure_retains_custody():
    class Wire(Transport):
        async def recv(self):
            raise ValueError("controlled confirmation failure")

    wire = Wire(fail="close")
    calls = []

    async def connect(_url):
        calls.append(wire)
        return wire

    mux = SingleCdpConnectionMultiplexer("ws://local-unused.invalid", upstream_connect=connect)
    try:
        try:
            await mux._ensure_upstream()
        except ValueError as error:
            assert str(error) == "controlled confirmation failure"
        else:
            raise AssertionError("confirmation failure was swallowed")
        for operation in (mux._ensure_upstream, mux.close):
            try:
                await operation()
            except RuntimeError as error:
                assert str(error) == "controlled close failed"
            else:
                raise AssertionError("unconfirmed socket closure was falsely acknowledged")
            assert mux._dialing_upstream is wire and mux._upstream is None
            assert calls == [wire], "another socket was dialled before old custody was closed"
    finally:
        wire.fail = None
        await mux.close()
    assert not wire.alive and mux._dialing_upstream is None


if __name__ == "__main__":
    result = asyncio.run(run_all_tests())
    raise SystemExit(0 if result.get("failed", 0) == 0 else 1)
