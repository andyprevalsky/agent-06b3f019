"""Browser shutdown through the native event bus and a loopback CDP transport."""

import asyncio
import contextlib
import logging

import websockets
from browser_use import BrowserSession
from browser_use.browser.events import BrowserStopEvent, SaveStorageStateEvent
from browser_use.browser.watchdogs.storage_state_watchdog import StorageStateWatchdog

from _test_utils import BlackboxResult
from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer
from browser_tools.dom_service import DOMService
from domains.spawn_browser_agent_v3.config import BROWSER_DISCONNECT_TIMEOUT_SECONDS


async def stop_session(*, race, refuses_cancel=False):
    entered = asyncio.Event()
    reply = asyncio.Event()
    released = asyncio.Event()
    events = []
    allow_exit = asyncio.Event()

    async def provider(socket):
        await socket.wait_closed()
        released.set()

    quiet = logging.getLogger("storage_watchdog_cleanup.provider")
    quiet.setLevel(logging.CRITICAL)
    async with websockets.serve(provider, "127.0.0.1", 0, logger=quiet) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        wire = await websockets.connect(url, proxy=None)
        session = BrowserSession(cdp_url=url, keep_alive=True)

        async def on_SaveStorageStateEvent(event: SaveStorageStateEvent):
            events.append("save")

        session.event_bus.on(SaveStorageStateEvent, on_SaveStorageStateEvent)

        class ReplyAtStopWatchdog(StorageStateWatchdog):
            async def on_BrowserStopEvent(self, event: BrowserStopEvent):
                events.append("stop")
                if race:
                    # The RPC completes immediately before native stop cancels
                    # its waiter. Python 3.11 wait_for can consume that cancel.
                    reply.set()
                    await asyncio.sleep(0)
                await super().on_BrowserStopEvent(event)

        watchdog = ReplyAtStopWatchdog(event_bus=session.event_bus, browser_session=session)

        async def cookie_rpc():
            entered.set()
            if refuses_cancel:
                while not allow_exit.is_set():
                    try:
                        await allow_exit.wait()
                    except asyncio.CancelledError:
                        continue
                raise asyncio.CancelledError
            await asyncio.wait_for(reply.wait(), timeout=watchdog.auto_save_interval)
            events.append(("reply", asyncio.current_task().cancelling()))
            return False

        object.__setattr__(watchdog, "_have_cookies_changed", cookie_rpc)
        watchdog.attach_to_session()
        session._storage_state_watchdog = watchdog
        watchdog._monitoring_task = asyncio.create_task(watchdog._monitor_storage_changes())
        monitor = watchdog._monitoring_task
        mux = SingleCdpConnectionMultiplexer(url)
        mux._upstream = wire
        service = DOMService(cdp_url=url, cdp_multiplexer=mux)
        service._session = session
        cleanup = None
        try:
            await entered.wait()
            cleanup = asyncio.create_task(mux.disconnect_confirmed(service.disconnect))
            done, _ = await asyncio.wait({cleanup}, timeout=BROWSER_DISCONNECT_TIMEOUT_SECONDS)
            if refuses_cancel:
                assert cleanup not in done, "unjoined storage writer was credited as cleaned up"
                assert not released.is_set(), "transport closed before its storage owner stopped"
                return
            assert cleanup in done, f"native browser cleanup exceeded {BROWSER_DISCONNECT_TIMEOUT_SECONDS}s: {events}"
            await cleanup
            await asyncio.wait_for(released.wait(), timeout=1)
            assert monitor.done(), "periodic storage writer survived browser shutdown"
            assert events.index("save") < events.index("stop"), events
            assert wire.close_code == 1000, "transport release was not confirmed by a native close handshake"
        finally:
            allow_exit.set()
            if not monitor.done():
                monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await monitor
            if cleanup is not None:
                if not cleanup.done():
                    cleanup.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await cleanup
            await mux.close()
            await session.event_bus.stop(clear=True, timeout=5)


async def test_reply_racing_with_stop_releases_real_transport():
    await stop_session(race=True)


async def test_pending_cookie_rpc_stops_without_a_reply():
    await stop_session(race=False)


async def test_unjoined_storage_writer_cannot_claim_release():
    await stop_session(race=False, refuses_cancel=True)


async def run_all_tests():
    result = BlackboxResult()
    for test in (
        test_reply_racing_with_stop_releases_real_transport,
        test_pending_cookie_rpc_stops_without_a_reply,
        test_unjoined_storage_writer_cannot_claim_release,
    ):
        await result.record_async(test.__name__, test)
    return result.summary()
