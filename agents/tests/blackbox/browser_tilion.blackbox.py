"""Tilion support in the browser worker, against real Chromium and a fake Tilion gateway.

The gateway enforces Tilion's live contract (lane E probe, 2026-10-21): one CDP
client per session; a concurrent second socket is accepted and closed with
4409 ``another client is attached to this session``; REST drive calls fail
while a client is attached.
"""

import asyncio
import base64
import contextlib
import json
import logging
import os
import socket
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import httpx
import websockets
from playwright.async_api import async_playwright

from _test_utils import BlackboxResult

TILION_SESSION = "sess_0123456789abcdef0123456789abcdef"
TILION_TOKEN = "tok_secret_value_never_logged"


class FakeTilionGateway:
    """Single-client CDP gateway in front of a real Chromium endpoint."""

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.active = 0
        self.accepted = 0
        self.rejected_4409 = 0
        self.max_concurrent = 0
        self.port = 0
        self._server = None

    @property
    def cdp_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/v1/session/{TILION_SESSION}/cdp?token={TILION_TOKEN}"

    async def _handle(self, downstream):
        if self.active:
            self.rejected_4409 += 1
            await downstream.close(code=4409, reason="another client is attached to this session")
            return
        self.active += 1
        self.accepted += 1
        self.max_concurrent = max(self.max_concurrent, self.active)
        try:
            async with websockets.connect(self.endpoint, max_size=None, proxy=None) as upstream:
                async def up():
                    async for raw in downstream:
                        await upstream.send(raw)

                async def down():
                    async for raw in upstream:
                        await downstream.send(raw)

                tasks = [asyncio.create_task(up()), asyncio.create_task(down())]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            self.active -= 1

    async def __aenter__(self):
        quiet = logging.getLogger("browser_tilion.fake_gateway")
        quiet.setLevel(logging.CRITICAL)
        self._server = await websockets.serve(self._handle, "127.0.0.1", 0, max_size=None, logger=quiet)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self._server.close()
        with contextlib.suppress(Exception):
            await self._server.wait_closed()


@contextlib.asynccontextmanager
async def _chromium():
    async with async_playwright() as playwright:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        browser = await playwright.chromium.launch(headless=True, args=[f"--remote-debugging-port={port}"])
        try:
            async with httpx.AsyncClient(trust_env=False) as client:
                version = await client.get(f"http://127.0.0.1:{port}/json/version")
            yield playwright, browser, version.json()["webSocketDebuggerUrl"]
        finally:
            await browser.close()


def _tilion_env(gateway: FakeTilionGateway):
    return patch.dict(os.environ, {"TILION_BASE_URL": f"http://127.0.0.1:{gateway.port}"})


async def _stop_dom_service(service):
    with contextlib.suppress(Exception):
        await asyncio.wait_for(service.disconnect(), timeout=20)


# ----- single CDP client -------------------------------------------------------


async def test_fake_gateway_rejects_second_direct_client():
    """Negative control: two direct sockets collide with 4409 exactly like Tilion."""
    async with _chromium() as (_playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            async with websockets.connect(gateway.cdp_url, proxy=None) as first:
                await first.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                assert "result" in json.loads(await first.recv())
                async with websockets.connect(gateway.cdp_url, proxy=None) as second:
                    try:
                        await asyncio.wait_for(second.recv(), timeout=5)
                    except websockets.ConnectionClosed:
                        pass
                    assert second.close_code == 4409, second.close_code
            assert gateway.rejected_4409 == 1


async def test_tilion_worker_attach_uses_one_upstream_socket():
    """browser-use DOMService + Playwright attach together; the gateway sees one socket."""
    from browser_tools.dom_service import DOMService
    from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection

    async with _chromium() as (playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
          with _tilion_env(gateway):
            local_url, multiplexer = await open_browser_cdp_connection(gateway.cdp_url, label="test")
            assert multiplexer is not None, "Tilion CDP URLs must be multiplexed"
            assert local_url.startswith("ws://127.0.0.1:") and TILION_TOKEN not in local_url
            service = DOMService(cdp_url=local_url, cdp_multiplexer=multiplexer)
            pw_browser = None
            try:
                pw_browser_task = asyncio.create_task(playwright.chromium.connect_over_cdp(local_url))
                await service.connect()
                pw_browser = await pw_browser_task
                assert service.single_cdp_client is True
                pw_page = pw_browser.contexts[0].pages[0]
                await pw_page.goto("data:text/html,<title>tilion-one-socket</title><button>hello</button>")
                dom_page = await service.session.get_current_page()
                assert dom_page is not None
                state = await service.get_browser_state(include_screenshot=False)
                # browser-use observed the page Playwright drove: one browser, two clients.
                assert state.get("url", "").startswith("data:text/html,<title>tilion-one-socket"), state.get("url")
                cdp_session = await service.session.get_or_create_cdp_session(focus=False)
                evaluated = await cdp_session.cdp_client.send.Runtime.evaluate(
                    params={"expression": "document.title='set-by-browser-use'", "returnByValue": True},
                    session_id=cdp_session.session_id,
                )
                assert evaluated["result"]["value"] == "set-by-browser-use", evaluated
                assert await pw_page.evaluate("document.title") == "set-by-browser-use"
                png = await service.capture_viewport_png()
                assert base64.b64decode(png)[:8] == b"\x89PNG\r\n\x1a\n"
                assert gateway.rejected_4409 == 0, "a second CDP socket reached Tilion"
                assert gateway.max_concurrent == 1
                assert multiplexer.upstream_connections_opened == 1
            finally:
                if pw_browser is not None:
                    await pw_browser.close()
                await _stop_dom_service(service)
            await asyncio.sleep(0.2)
            assert gateway.active == 0, "worker teardown must release Tilion's single client slot"
            assert gateway.rejected_4409 == 0


async def test_multiplexer_releases_upstream_when_clients_leave_and_reattaches():
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async with _chromium() as (_playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            multiplexer = SingleCdpConnectionMultiplexer(gateway.cdp_url)
            local_url = await multiplexer.start()
            try:
                for round_number in (1, 2):
                    async with websockets.connect(local_url, proxy=None) as one, websockets.connect(
                        local_url, proxy=None
                    ) as two:
                        await one.send(json.dumps({"id": 7, "method": "Browser.getVersion"}))
                        await two.send(json.dumps({"id": 7, "method": "Target.getTargets"}))
                        first = json.loads(await asyncio.wait_for(one.recv(), 10))
                        second = json.loads(await asyncio.wait_for(two.recv(), 10))
                        assert first["id"] == 7 and "product" in first["result"], first
                        assert second["id"] == 7 and "targetInfos" in second["result"], second
                        assert "sessionId" not in first and "sessionId" not in second
                        assert gateway.active == 1
                    await asyncio.sleep(0.2)
                    assert gateway.active == 0, f"round {round_number}: slot not released"
                assert multiplexer.upstream_connections_opened == 2
                assert gateway.rejected_4409 == 0
            finally:
                await multiplexer.close()


async def test_multiplexer_propagates_provider_close_code():
    """A provider 4409/4410 close reaches every local client with the same code."""
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async def holder(socket_):
        await socket_.recv()
        await socket_.close(code=4410, reason="the session's browser crashed")

    quiet = logging.getLogger("browser_tilion.fake_crash")
    quiet.setLevel(logging.CRITICAL)
    async with websockets.serve(holder, "127.0.0.1", 0, logger=quiet) as server:
        port = server.sockets[0].getsockname()[1]
        multiplexer = SingleCdpConnectionMultiplexer(f"ws://127.0.0.1:{port}/v1/session/x/cdp?token=t")
        local_url = await multiplexer.start()
        try:
            async with websockets.connect(local_url, proxy=None) as client:
                with contextlib.suppress(websockets.ConnectionClosed):
                    await asyncio.wait_for(client.recv(), 10)
                assert client.close_code == 4410, client.close_code
            assert multiplexer.last_upstream_close == (4410, "the session's browser crashed")
        finally:
            await multiplexer.close()


# ----- URLs ------------------------------------------------------------------


async def test_tilion_cdp_url_detection_and_redaction():
    from domains.spawn_browser_agent_v3.cdp_urls import (
        is_tilion_cdp_url,
        open_browser_cdp_connection,
        redact_cdp_url,
    )

    url = f"wss://back.tilion.dev/v1/session/{TILION_SESSION}/cdp?token={TILION_TOKEN}"
    with patch.dict(os.environ, {"TILION_BASE_URL": "https://back.tilion.dev"}):
        assert is_tilion_cdp_url(url)
        assert not is_tilion_cdp_url("wss://api.onkernel.com/browser/cdp?jwt=x")
        assert not is_tilion_cdp_url(f"wss://back.tilion.dev/v1/session/{TILION_SESSION}/playwright?token=x")
        redacted = redact_cdp_url(url)
        assert TILION_TOKEN not in redacted and "token=REDACTED" in redacted
        assert TILION_SESSION in redacted
        assert "apiKey=REDACTED" in redact_cdp_url("wss://connect.steel.dev?apiKey=k&sessionId=s")
        direct, multiplexer = await open_browser_cdp_connection("wss://api.onkernel.com/browser/cdp?jwt=x")
        assert direct == "wss://api.onkernel.com/browser/cdp?jwt=x" and multiplexer is None
        local_url, multiplexer = await open_browser_cdp_connection(url)
        try:
            # The token is never stripped: the multiplexer dials the full URL.
            assert multiplexer is not None and multiplexer._upstream_url == url
        finally:
            await multiplexer.close()


async def run_all_tests():
    result = BlackboxResult()
    for name, test in [
        ("fake_gateway_rejects_second_direct_client", test_fake_gateway_rejects_second_direct_client),
        ("tilion_worker_attach_uses_one_upstream_socket", test_tilion_worker_attach_uses_one_upstream_socket),
        ("multiplexer_releases_and_reattaches", test_multiplexer_releases_upstream_when_clients_leave_and_reattaches),
        ("multiplexer_propagates_provider_close_code", test_multiplexer_propagates_provider_close_code),
        ("tilion_cdp_url_detection_and_redaction", test_tilion_cdp_url_detection_and_redaction),
    ]:
        await result.record_async(name, test)
    return result.all_passed
