"""Exercise telemetry cancellation at the real DOMService ownership boundary."""

import asyncio
import contextlib
import json
import socket
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.request import urlopen


async def check_indicator_completion_racing_disconnect(dom=None) -> None:
    from browser_tools.dom_service import DOMService
    from domains.spawn_browser_agent_v3.handler import (
        _disconnect_browser,
        drain_background_browser_cleanups,
    )

    if dom is None:
        dom = DOMService(cdp_url="ws://unused.invalid")
        session = SimpleNamespace(stop=AsyncMock())
        dom._session = session
        dom.set_captcha_indicator_phase = AsyncMock()
    else:
        session = dom.session
        object.__setattr__(session, "stop", AsyncMock(wraps=session.stop))
        dom.set_captcha_indicator_phase = AsyncMock(wraps=dom.set_captcha_indicator_phase)
    ready = asyncio.Event()
    response = asyncio.get_running_loop().create_future()
    completions = []

    async def poll_phase():
        ready.set()
        phase = await asyncio.wait_for(response, timeout=10)
        completions.append(asyncio.current_task().cancelling())
        return phase

    dom.start_captcha_telemetry_indicator(poll_phase)
    indicator = dom._captcha_indicator_task
    await ready.wait()
    # The real Python 3.11 wait_for race: its response and the shutdown cancel
    # become ready in the same loop turn. No fake ignores cancellation here.
    response.set_result("idle")
    try:
        disconnected = await _disconnect_browser(dom)
        assert completions and completions[0] == 1, "the actual completion/cancellation race was not reached"
        assert disconnected, "completed telemetry swallowed cancellation and blocked browser disconnect"
        assert completions == [1], "shutdown allowed another telemetry poll"
        assert indicator.done(), "the disconnected service retained its telemetry task"
        assert dom.session is None
        session.stop.assert_awaited_once()
        dom.set_captcha_indicator_phase.assert_not_awaited()
    finally:
        if not indicator.done():
            indicator.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await indicator
        await drain_background_browser_cleanups(timeout=3)


async def check_real_remote_indicator_shutdown() -> None:
    from browser_tools.dom_service import DOMService
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        browser = await playwright.chromium.launch(
            headless=True, args=[f"--remote-debugging-port={port}"]
        )
        dom = None
        dom_services = []
        try:
            await browser.new_page()
            with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=10) as response:
                endpoint = json.load(response)["webSocketDebuggerUrl"]
            dom = DOMService(cdp_url=endpoint)
            dom_services.append(dom)
            await dom.connect()
            # Ordinary live telemetry still updates before shutdown.
            updated = asyncio.Event()
            original_update = dom.set_captcha_indicator_phase

            async def update(phase):
                await original_update(phase)
                updated.set()

            async def idle():
                return "idle"

            dom.set_captcha_indicator_phase = update
            dom.start_captcha_telemetry_indicator(idle)
            await asyncio.wait_for(updated.wait(), timeout=10)
            await dom.disconnect()
            assert dom.disconnect_confirmed, "first native session cleanup was not confirmed"
            assert browser.is_connected(), "worker disconnect killed the provider browser"
            dom = DOMService(cdp_url=endpoint)
            dom_services.append(dom)
            await dom.connect()
            await check_indicator_completion_racing_disconnect(dom)
            assert browser.is_connected(), "racing disconnect killed the provider browser"
        finally:
            try:
                for service in reversed(dom_services):
                    await service.disconnect()
            finally:
                await browser.close()
