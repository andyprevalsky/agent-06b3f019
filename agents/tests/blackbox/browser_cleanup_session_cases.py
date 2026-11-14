"""Native browser-use/CDP ownership, with real loopback WebSockets only."""
import asyncio
import inspect
import json
from unittest.mock import patch

from _test_utils import BlackboxResult
from browser_tools.dom_service import DOMService
from browser_use.browser.profile import BrowserProfile
from browser_use.browser.session import BrowserSession
from cdp_use import CDPClient
from websockets.asyncio.server import serve
from websockets.protocol import State


async def test_native_stop_failure_cannot_acknowledge_disconnect():
    async def peer(socket):
        await socket.wait_closed()

    async with serve(peer, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        client = CDPClient(url)
        await client.start()
        socket = client.ws
        session = BrowserSession(browser_profile=BrowserProfile(keep_alive=True, is_local=False), cdp_url=url)
        session._cdp_client_root = client
        dom = DOMService(url)
        dom._session = session
        dom.disconnect_confirmed = False
        dom._session_disconnect_confirmed = False
        try:
            with patch.object(socket, "close", side_effect=RuntimeError("native socket close refused")):
                await dom.disconnect()
            observed = dict(native_open=socket.state is State.OPEN,
                            session_lost_client=session._cdp_client_root is None,
                            dom_confirmed=dom.disconnect_confirmed,
                            retained_sessions=len(dom._disconnecting_sessions))
            print("NATIVE_STOP", json.dumps(observed), flush=True)
            assert not (observed["native_open"] and dom.disconnect_confirmed), "failed CDP client stop acknowledged DOM disconnect and discarded client custody"
            assert dom._disconnecting_sessions, "failed native owner was discarded"
            await dom.disconnect()
            assert dom.disconnect_confirmed and socket.state is State.CLOSED
            assert client.ws is None and not dom._disconnecting_sessions
        finally:
            await client.stop()
            await session.event_bus.stop(clear=True, timeout=5)


async def _reject_cdp(socket):
    async for raw in socket:
        request = json.loads(raw)
        await socket.send(json.dumps({"id": request["id"], "error": {"code": -32000, "message": "controlled local rejection"}}))


def _owned_session(url):
    from browser_tools.browser_session_owner import create_owned_browser_session
    return create_owned_browser_session(BrowserSession, browser_profile=BrowserProfile(keep_alive=True, is_local=False), cdp_url=url)


async def test_displaced_clients_survive_reconnect_and_reset():
    async with serve(_reject_cdp, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        session = _owned_session(url)
        old = CDPClient(url)
        await old.start()
        socket = old.ws
        session._cdp_client_root = old
        dom = DOMService(url)
        dom._session = session
        try:
            with patch.object(socket, "close", side_effect=RuntimeError("old native close refused")):
                try:
                    await session.reconnect()
                except Exception as error:
                    assert "controlled local rejection" in str(error)
                else:
                    raise AssertionError("local transport error was swallowed")
                custody = session._native_custody
                assert custody.clients[id(old)] is old
                replacements = [client for client in custody.clients.values() if client is not old]
                assert len(replacements) == 1
                replacement = replacements[0]
                assert isinstance(replacement, CDPClient)
                replacement_sockets = [owned for owned in custody.sockets.values() if owned is not socket]
                assert len(replacement_sockets) == 1
                replacement_socket = replacement_sockets[0]
                published = session._cdp_client_root
                if published is not None:
                    assert published is replacement
                    assert replacement.ws is replacement_socket
                else:
                    assert replacement.ws is None
                    assert replacement_socket.state is State.CLOSED
                await session.reset()
                assert session._cdp_client_root is None
                assert custody.clients[id(old)] is old and custody.clients[id(replacement)] is replacement
                await dom.disconnect()
                assert not dom.disconnect_confirmed and dom._disconnecting_sessions
                assert socket.state is State.OPEN
            await dom.disconnect()
            assert dom.disconnect_confirmed and socket.state is State.CLOSED
            assert replacement_socket.state is State.CLOSED
            assert old.ws is None and replacement.ws is None
            assert all(task.done() for task in custody.tasks)
            assert session._native_custody.closed
        finally:
            for client in session._native_custody.clients.values():
                await client.stop()
            await session.event_bus.stop(clear=True, timeout=5)


async def test_failed_connect_retains_new_native_client():
    requested, respond = asyncio.Event(), asyncio.Event()

    async def peer(socket):
        async for raw in socket:
            requested.set()
            await respond.wait()
            request = json.loads(raw)
            await socket.send(json.dumps({"id": request["id"], "error": {"code": -32000, "message": "controlled connect failure"}}))

    async with serve(peer, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        session = _owned_session(url)
        dom = DOMService(url)
        dom._session = session
        connecting = asyncio.create_task(session.connect())
        await requested.wait()
        client = session._cdp_client_root
        socket = client.ws
        try:
            with patch.object(socket, "close", side_effect=RuntimeError("new native close refused")):
                respond.set()
                try:
                    await connecting
                except RuntimeError as error:
                    assert "controlled connect failure" in str(error)
                else:
                    raise AssertionError("original connect failure was lost")
                assert session._cdp_client_root is None and socket.state is State.OPEN
                assert session._native_custody.clients[id(client)] is client
                await dom.disconnect()
                assert not dom.disconnect_confirmed and dom._disconnecting_sessions
            await dom.disconnect()
            assert dom.disconnect_confirmed and session._native_custody.closed
        finally:
            respond.set()
            await asyncio.gather(connecting, return_exceptions=True)
            await client.stop()
            await session.event_bus.stop(clear=True, timeout=5)


async def test_cleanup_joins_late_native_acquisition_and_seals_admission():
    acquired, cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_start = CDPClient.start

    async def delayed_start(client):
        await original_start(client)
        acquired.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            await release.wait()

    async with serve(_reject_cdp, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        session = _owned_session(url)
        dom = DOMService(url)
        dom._session = session
        dom.disconnect_confirmed = False
        with patch.object(CDPClient, "start", delayed_start):
            connecting = asyncio.create_task(session.connect())
            await acquired.wait()
            socket = session._cdp_client_root.ws
            disconnecting = asyncio.create_task(dom.disconnect())
            try:
                await cancelled.wait()
                assert not disconnecting.done() and not dom.disconnect_confirmed
                try:
                    await session.connect()
                except RuntimeError as error:
                    assert "acquisition is closed" in str(error)
                else:
                    raise AssertionError("teardown admitted a new acquisition")
                release.set()
                await disconnecting
                await asyncio.gather(connecting, return_exceptions=True)
                assert connecting.done() and socket.state is State.CLOSED
                assert dom.disconnect_confirmed and session._native_custody.closed
            finally:
                release.set()
                await asyncio.gather(connecting, disconnecting, return_exceptions=True)
                for client in session._native_custody.clients.values():
                    await client.stop()
                await session.event_bus.stop(clear=True, timeout=5)


async def test_cancelled_native_close_retains_retry_owner():
    async def peer(socket):
        await socket.wait_closed()

    async with serve(peer, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        session = _owned_session(url)
        client = CDPClient(url)
        await client.start()
        socket = client.ws
        session._cdp_client_root = client
        dom = DOMService(url)
        dom._session = session
        entered, release = asyncio.Event(), asyncio.Event()
        original_close = socket.close

        async def delayed_close():
            entered.set()
            await release.wait()
            await original_close()

        try:
            with patch.object(socket, "close", delayed_close):
                disconnecting = asyncio.create_task(dom.disconnect())
                await entered.wait()
                disconnecting.cancel()
                try:
                    await disconnecting
                except asyncio.CancelledError:
                    pass
                else:
                    raise AssertionError("cleanup cancellation was swallowed")
                assert socket.state is State.OPEN and not dom.disconnect_confirmed
                assert dom._disconnecting_sessions == [session]
                assert id(client) in session._native_custody.clients
                release.set()
                await dom.disconnect()
                assert dom.disconnect_confirmed and session._native_custody.closed
        finally:
            release.set()
            await client.stop()
            await session.event_bus.stop(clear=True, timeout=5)


async def run_all_tests():
    results = BlackboxResult()
    await results.record_async("native_stop_failure_custody", test_native_stop_failure_cannot_acknowledge_disconnect)
    await results.record_async("displaced_native_clients", test_displaced_clients_survive_reconnect_and_reset)
    await results.record_async("failed_connect_native_custody", test_failed_connect_retains_new_native_client)
    await results.record_async("late_native_acquisition", test_cleanup_joins_late_native_acquisition_and_seals_admission)
    await results.record_async("cancelled_native_close", test_cancelled_native_close_retains_retry_owner)
    return results.summary()


if __name__ == "__main__":
    print("IMPORTED", inspect.getfile(DOMService), inspect.getfile(BrowserSession), inspect.getfile(CDPClient), flush=True)
    result = asyncio.run(run_all_tests())
    raise SystemExit(0 if result["failed"] == 0 else 1)
