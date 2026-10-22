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
import time
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
        self._sockets: set = set()
        self.withhold = None  # predicate(raw request) -> True to never deliver its reply
        self.withheld_ids: set = set()

    async def drop_all(self) -> None:
        """Simulate Tilion dropping the attached client (network blip, LB)."""
        for downstream in list(self._sockets):
            await downstream.close(code=1011, reason="upstream reset")

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
        self._sockets.add(downstream)
        self.max_concurrent = max(self.max_concurrent, self.active)
        try:
            async with websockets.connect(self.endpoint, max_size=None, proxy=None) as upstream:

                async def up():
                    async for raw in downstream:
                        if self.withhold is not None and self.withhold(raw):
                            self.withheld_ids.add((json.loads(raw).get("sessionId"), json.loads(raw).get("id")))
                        await upstream.send(raw)

                async def down():
                    async for raw in upstream:
                        message = json.loads(raw)
                        if (message.get("sessionId"), message.get("id")) in self.withheld_ids:
                            continue  # the provider never answers this command
                        await downstream.send(raw)

                tasks = [asyncio.create_task(up()), asyncio.create_task(down())]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            self._sockets.discard(downstream)
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
            payload = version.json()
            assert "webSocketDebuggerUrl" in payload, (
                f"/json/version on 127.0.0.1:{port} -> {version.status_code} {str(payload)[:300]}"
            )
            yield playwright, browser, payload["webSocketDebuggerUrl"]
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
                    async with (
                        websockets.connect(local_url, proxy=None) as one,
                        websockets.connect(local_url, proxy=None) as two,
                    ):
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


# ----- HTTP fixture site ----------------------------------------------------

DOWNLOAD_BYTES = b"%PDF-1.4 tilion download fixture\n" + bytes(range(256)) * 8
UPLOAD_BYTES = b"tilion-upload-fixture:" + os.urandom(3000)


@contextlib.asynccontextmanager
async def _fixture_site():
    from aiohttp import web

    async def index(_request):
        return web.Response(
            content_type="text/html",
            text=(
                "<title>fixture</title>"
                '<img src="/static/logo.png">'
                '<a id="dl" href="/files/report.pdf">report</a>'
                '<input id="file" type="file">'
                # TinyPNG-style: the page reads the file, then resets the input.
                '<input id="clearing" type="file" onchange="window.got=[this.files[0].name, this.files[0].size];'
                " this.value='';\">"
                # TinyPNG live (A2 probe): the handler replaces the input element.
                '<input id="replacing" type="file" onchange="window.replaced=[this.files[0].name, this.files[0].size];'
                ' this.replaceWith(this.cloneNode());">'
            ),
        )

    async def report(_request):
        return web.Response(
            body=DOWNLOAD_BYTES,
            content_type="application/pdf",
            headers={"Content-Disposition": 'attachment; filename="report.pdf"'},
        )

    async def logo(_request):
        return web.Response(body=b"\x89PNG\r\n\x1a\nnot-a-download", content_type="image/png")

    async def headers(request):
        return web.json_response({"accept_language": request.headers.get("Accept-Language", "")})

    async def first_script(request):
        return web.Response(
            content_type="text/html",
            text=(
                "<script>window.firstFacts = [Intl.DateTimeFormat().resolvedOptions().timeZone,"
                " Intl.DateTimeFormat().resolvedOptions().locale, navigator.userAgent];</script>"
                f"<p>{request.headers.get('Accept-Language', '')}</p>"
            ),
        )

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/headers", headers)
    app.router.add_get("/first-script", first_script)

    async def worker_page(_request):
        return web.Response(
            content_type="text/html",
            text=(
                "<title>worker-pending</title><script>"
                "const w = new Worker(URL.createObjectURL(new Blob([\"postMessage('pong')\"])));"
                "w.onmessage = (e) => { document.title = 'worker-' + e.data; };</script>"
            ),
        )

    app.router.add_get("/worker", worker_page)
    app.router.add_get("/files/report.pdf", report)
    app.router.add_get("/static/logo.png", logo)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await runner.cleanup()


@contextlib.asynccontextmanager
async def _tilion_worker_stack(emulation: Optional[Dict[str, Any]] = None):
    """Real Chromium behind the fake Tilion gateway, attached like the worker does."""
    from browser_tools.dom_service import DOMService, browser_downloads_path_for_provider
    from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection

    async with _chromium() as (playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            with _tilion_env(gateway):
                local_url, multiplexer = await open_browser_cdp_connection(gateway.cdp_url, emulation=emulation)
                service = DOMService(
                    cdp_url=local_url,
                    downloads_path=browser_downloads_path_for_provider("tilion"),
                    cdp_multiplexer=multiplexer,
                )
                pw_task = asyncio.create_task(playwright.chromium.connect_over_cdp(local_url))
                await service.connect()
                pw_browser = await pw_task
                try:
                    yield service, pw_browser, gateway
                finally:
                    await pw_browser.close()
                    await _stop_dom_service(service)


# ----- downloads ----------------------------------------------------------


async def test_tilion_download_lands_in_worker_ledger_not_static_assets():
    from domains.spawn_browser_agent_v3 import service as browser_service
    from domains.spawn_browser_agent_v3 import tilion_worker
    from domains.spawn_browser_agent_v3.download_persist import BrowserDownloadPersister

    session_id = "tilion-download-session"
    config = object()
    async with _fixture_site() as base, _tilion_worker_stack() as (service, pw_browser, gateway):
        backend_calls: List[str] = []

        async def no_backend(*_args, **_kwargs):
            backend_calls.append("backend")
            raise AssertionError("Tilion downloads must not use backend file routes mid-run")

        with (
            patch("domains.spawn_browser_agent_v3.repo.upload_file_to_session", no_backend),
            patch("domains.spawn_browser_agent_v3.repo.download_session_file", no_backend),
            patch.object(browser_service, "list_session_files", no_backend),
            patch.object(browser_service, "download_session_file", no_backend),
        ):
            persister = await BrowserDownloadPersister.create(
                browser_session=service.session,
                session_id=session_id,
                config=config,
                provider="tilion",
            )
            assert persister is not None
            page = pw_browser.contexts[0].pages[0]
            await page.goto(base + "/")
            await page.click("#dl")
            for _ in range(100):
                if tilion_worker.list_downloads(session_id):
                    break
                await asyncio.sleep(0.1)
            await persister.close()
            files = tilion_worker.list_downloads(session_id)
            assert [item["filename"] for item in files] == ["report.pdf"], files
            assert files[0]["size"] == len(DOWNLOAD_BYTES)

            uploaded: List[Dict[str, Any]] = []

            async def fake_upload_to_storage(*, user_id, file_content, filename, mime_type):
                uploaded.append({"filename": filename, "content": file_content, "mime_type": mime_type})
                return {"storage_path": f"{user_id}/{filename}", "original_filename": filename}

            with patch("helpers.attachments.upload_to_storage", fake_upload_to_storage):
                pointers = await browser_service.extract_session_files(session_id, "user-1", config)
            assert [pointer["original_filename"] for pointer in pointers] == ["report.pdf"]
            assert uploaded[0]["content"] == DOWNLOAD_BYTES
            assert backend_calls == []
        assert gateway.rejected_4409 == 0
    tilion_worker.release_session(session_id)
    assert not tilion_worker.owns_download_session(session_id)


# ----- uploads ------------------------------------------------------------


async def test_tilion_upload_sets_worker_bytes_on_file_input():
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3 import tilion_worker
    from domains.spawn_browser_agent_v3.service_actions import _execute_upload_file

    session_id = "tilion-upload-session"
    async with _fixture_site() as base, _tilion_worker_stack() as (service, pw_browser, gateway):
        page = pw_browser.contexts[0].pages[0]
        await page.goto(base + "/")
        staged = tilion_worker.stage_upload(session_id, "resume.txt", UPLOAD_BYTES, "text/plain")
        assert tilion_worker.is_staged_upload_path(staged["path"]) and staged["size"] == len(UPLOAD_BYTES)

        cdp_session = await service.session.get_or_create_cdp_session(focus=False)
        send = cdp_session.cdp_client.send
        document = await send.DOM.getDocument(params={}, session_id=cdp_session.session_id)
        node = await send.DOM.querySelector(
            params={"nodeId": document["root"]["nodeId"], "selector": "#file"}, session_id=cdp_session.session_id
        )
        described = await send.DOM.describeNode(params={"nodeId": node["nodeId"]}, session_id=cdp_session.session_id)
        element = SimpleNamespace(
            backend_node_id=described["node"]["backendNodeId"], node_name="INPUT", attributes={"type": "file"}
        )

        class _History:
            async def record_action(self, **_kwargs):
                return None

        class _Humanizer:
            def __init__(self, input_page):
                self.input_page = input_page

            async def click_at_coords(self, *_args):
                return None

        async def no_coordinates(_index):
            return None

        service.get_element_coordinates = no_coordinates
        result = await _execute_upload_file(
            session=service.session,
            dom_service=service,
            action_history=_History(),
            element=element,
            index=3,
            params={"filename": "resume.txt"},
            thinking="",
            humanizer=_Humanizer(page),
            available_file_paths={"resume.txt": staged["path"]},
        )
        assert result.get("success") is True, result
        landed = await page.evaluate(
            "() => { const f = document.querySelector('#file').files[0]; return f && [f.name, f.size, f.type]; }"
        )
        assert landed == ["resume.txt", len(UPLOAD_BYTES), "text/plain"], landed
        assert await page.evaluate("document.querySelector('[data-rose-upload]')") is None
        assert gateway.rejected_4409 == 0
    tilion_worker.release_session(session_id)


# ----- worker_apply (backend contract from lane A2) -------------------------


async def test_tilion_worker_apply_contract_sets_cookies_and_local_storage():
    from domains.spawn_browser_agent_v3.tilion_worker import apply_worker_state, worker_apply_payload

    async with _fixture_site() as base, _tilion_worker_stack() as (_service, pw_browser, gateway):
        agent_page = pw_browser.contexts[0].pages[0]
        await agent_page.goto("about:blank")
        # Field names exactly as A2's prepare-auth / inject-localStorage responses.
        response = {
            "cookies_injected": False,
            "worker_apply": {
                "provider": "tilion",
                "reason": "single_cdp_client",
                "cookies": [
                    {
                        "name": "sid",
                        "value": "abc",
                        "domain": "127.0.0.1",
                        "path": "/",
                        "secure": False,
                        "httpOnly": True,
                        "sameSite": "Lax",
                    }
                ],
                "local_storage": [{"origin": base, "entries": [{"key": "token", "value": "xyz"}]}],
            },
        }
        block = worker_apply_payload(response)
        assert block is not None
        assert worker_apply_payload({"worker_apply": {"provider": "kernel"}}) is None
        assert worker_apply_payload({"injected": True}) is None
        pages_before = len(pw_browser.contexts[0].pages)
        applied = await apply_worker_state(pw_browser, block)
        assert applied == {"cookies": 1, "local_storage_entries": 1}
        assert agent_page.url == "about:blank", "the agent's tab must not be navigated"
        assert len(pw_browser.contexts[0].pages) == pages_before, "the apply page must be closed"
        cookies = await pw_browser.contexts[0].cookies(base)
        assert any(c["name"] == "sid" and c["value"] == "abc" for c in cookies), cookies
        await agent_page.goto(base + "/")
        assert await agent_page.evaluate("localStorage.getItem('token')") == "xyz"
        assert gateway.rejected_4409 == 0


# ----- screenshots, key presses, cost, recording, cancel set ----------------


async def test_tilion_screenshot_action_uses_worker_socket_not_rest():
    from domains.spawn_browser_agent_v3 import tilion_worker
    from domains.spawn_browser_agent_v3.service_actions import _execute_screenshot

    png = base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode()

    class _Dom:
        secret_values_used = False
        single_cdp_client = True

        async def capture_viewport_png(self):
            return png

    class _History:
        async def record_action(self, **_kwargs):
            return None

    async def rest_forbidden(*_args, **_kwargs):
        raise AssertionError("REST screenshot/upload must not run while the worker holds Tilion CDP")

    with (
        patch("domains.spawn_browser_agent_v3.repo.take_browser_computer_screenshot", rest_forbidden),
        patch("domains.spawn_browser_agent_v3.repo.upload_file_to_session", rest_forbidden),
    ):
        result = await _execute_screenshot(
            session=None,
            dom_service=_Dom(),
            action_history=_History(),
            thinking="",
            session_id="tilion-shot",
            config=object(),
        )
    assert result["success"] is True and result["screenshot"] == png
    assert tilion_worker.staged_upload_payload(result["file_path"])["buffer"] == base64.b64decode(png)
    tilion_worker.release_session("tilion-shot")


async def test_tilion_cost_row_is_12_cents_per_hour_plus_create():
    from domains.spawn_browser_agent_v3.service import build_usage_items
    from providers.rose.pricing import get_model_pricing

    pricing = get_model_pricing("rose-1-browser-use")
    items = build_usage_items(1000, 100, pricing, 3_600_000, provider="tilion")
    service_row = next(item for item in items if item["type"] == "service")
    assert service_row["provider"] == "Tilion Browser"
    assert abs(service_row["cost_cents"] - (12.0 + 0.4)) < 1e-6, service_row
    resumed = build_usage_items(1000, 100, pricing, 60_000, provider="tilion", session_creates=0)
    assert abs(next(i for i in resumed if i["type"] == "service")["cost_cents"] - 0.2) < 1e-6
    replaced = build_usage_items(1000, 100, pricing, 3_600_000, provider="tilion", session_creates=3)
    assert abs(next(i for i in replaced if i["type"] == "service")["cost_cents"] - (12.0 + 1.2)) < 1e-6
    from pathlib import Path

    handler_source = (Path(__file__).resolve().parents[2] / "domains/spawn_browser_agent_v3/handler.py").read_text()
    # Every provider-priced cost row passes the activity's Tilion create count,
    # counted at the initial create, a replacement resume and both rotation paths.
    assert handler_source.count('session_creates=tilion_creates["count"]') == 5
    assert handler_source.count('tilion_creates["count"] += 1') == 4
    fast = build_usage_items(1000, 100, pricing, 3_600_000, provider="tilion", fast_mode_cache_enabled=True)
    assert next(i for i in fast if i["type"] == "service")["cost_cents"] == 0.0


async def test_tilion_recording_uses_provider_neutral_screenshot_replay():
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    with patch.dict(os.environ, {"KERNEL_API_KEY": "fixture"}):
        recorder = BrowserAgentRecorder(
            page=object(),
            agent_id="agent",
            task_id="task",
            session_id="sess",
            browser_url="https://back.tilion.dev/v1/session/sess/live-view?token=x",
            session_metadata={"provider": "tilion"},
        )
    assert recorder.uses_kernel_replay is False


async def test_provider_name_sets_include_tilion():
    """Structural: every literal provider set in the worker that names kernel,
    steel and browser-use also names tilion (plan criterion A4)."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    offenders = []
    pattern = re.compile(r"[\{\(\[][^\{\}\(\)\[\]]*\"kernel\"[^\{\}\(\)\[\]]*[\}\)\]]")
    for directory in ("domains/spawn_browser_agent_v3", "browser_tools"):
        for path in sorted((root / directory).glob("*.py")):
            text = path.read_text()
            for match in pattern.finditer(text):
                literal = match.group(0)
                if '"steel"' in literal and '"browser-use"' in literal and '"tilion"' not in literal:
                    offenders.append(f"{path.relative_to(root)}: {literal[:80]}")
    assert not offenders, offenders


async def test_tilion_downloads_path_and_live_view_host():
    from browser_tools.dom_service import KERNEL_DOWNLOADS_PATH, browser_downloads_path_for_provider
    from domains.spawn_browser_agent_v3.service_actions import _is_browser_provider_domain

    assert browser_downloads_path_for_provider("tilion") == KERNEL_DOWNLOADS_PATH
    assert _is_browser_provider_domain("back.tilion.dev")
    assert not _is_browser_provider_domain("roselabs.ai")


async def test_multiplexer_refreshes_expired_connect_token():
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async with _chromium() as (_playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            expired = gateway.cdp_url.replace(TILION_TOKEN, "expired")

            async def process_request(connection, request):
                if "token=expired" in request.path:
                    return connection.respond(403, "invalid_token\n")
                return None

            quiet = logging.getLogger("browser_tilion.token_gate")
            quiet.setLevel(logging.CRITICAL)
            async with websockets.serve(
                gateway._handle, "127.0.0.1", 0, process_request=process_request, logger=quiet
            ) as server:
                port = server.sockets[0].getsockname()[1]
                minted: List[str] = []

                async def mint() -> Optional[str]:
                    minted.append("fresh")
                    return f"ws://127.0.0.1:{port}/v1/session/{TILION_SESSION}/cdp?token={TILION_TOKEN}"

                multiplexer = SingleCdpConnectionMultiplexer(
                    f"ws://127.0.0.1:{port}/v1/session/{TILION_SESSION}/cdp?token=expired", refresh_url=mint
                )
                local_url = await multiplexer.start()
                try:
                    async with websockets.connect(local_url, proxy=None) as client:
                        await client.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                        reply = json.loads(await asyncio.wait_for(client.recv(), 10))
                        assert "product" in reply["result"], reply
                    assert minted == ["fresh"]
                    assert expired not in multiplexer._upstream_url
                finally:
                    await multiplexer.close()


async def test_resume_request_carries_worker_storage_state():
    """Contract with lane A2: POST /resume accepts optional storage_state."""
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3 import repo

    bodies: List[Dict[str, Any]] = []

    class _Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def post(self, url, *, headers, json):
            assert url.endswith("/api/browser-session/resume")
            bodies.append(json)
            return httpx.Response(200, json={"session_id": "s", "ws_url": "wss://x"})

    config = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend", api_key="k"))
    state = {
        "cookies": [{"name": "sid", "value": "1", "domain": "example.com", "path": "/"}],
        "origins": [{"origin": "https://example.com", "localStorage": [{"name": "a", "value": "b"}]}],
        "current_url": "https://example.com/account",
    }
    with patch.object(repo.httpx, "AsyncClient", _Client):
        await repo.resume_browser_session(config, "task-1", storage_state=state)
        await repo.resume_browser_session(config, "task-1")
    assert bodies[0] == {"task_id": "task-1", "force_fresh_profile": False, "storage_state": state}
    assert bodies[1] == {"task_id": "task-1", "force_fresh_profile": False}


async def test_tilion_press_key_uses_cdp_input_not_backend_computer_api():
    from domains.spawn_browser_agent_v3.service_actions import _ActionContext, _execute_interaction_action

    pressed: List[str] = []

    class _Humanizer:
        async def press_key(self, key):
            pressed.append(key)

    class _History:
        async def record_action(self, **_kwargs):
            return None

    class _Dom:
        single_cdp_client = True

    async def rest_forbidden(*_args, **_kwargs):
        raise AssertionError("Tilion fails /computer/press-key while the worker holds CDP")

    fields = dict.fromkeys(_ActionContext.__dataclass_fields__)
    fields.update(
        dom_service=_Dom(),
        action_history=_History(),
        action_name="press_key",
        params={"key": "Escape"},
        thinking="",
        session_id="tilion-keys",
        user_id="user-1",
        config=object(),
        humanizer=_Humanizer(),
        current_url="https://example.com",
        write_lock_enabled=False,
        system_name="rose",
        current_auth_realm="",
    )
    with patch("domains.spawn_browser_agent_v3.repo.press_browser_computer_key", rest_forbidden):
        result = await _execute_interaction_action(_ActionContext(**fields))
    assert result == {"success": True, "message": ""}, result
    assert pressed == ["Escape"]


async def test_tilion_locale_override_applies_intl_and_accept_language():
    """Backend contract (A2): fingerprint_injection.{timezone,locale} first, then
    exit_geo_locale; nothing when both are absent. The multiplexer holds every
    new target until the overrides land, so a popup's FIRST script already sees
    them, and re-applies them after an upstream redial."""
    from domains.spawn_browser_agent_v3.tilion_worker import (
        accept_language_for_locale,
        resolve_geo_locale,
        tilion_emulation,
    )

    assert accept_language_for_locale("de-DE") == "de-DE,de"
    assert accept_language_for_locale("fr") == "fr"
    exit_geo = {"country": "DE", "timezone": "Europe/Berlin", "locale": "de-DE", "source": "exit_ip"}
    assert resolve_geo_locale(None, None) == {}
    assert resolve_geo_locale({"timezone": None, "locale": None}, {"timezone": None, "locale": None}) == {}
    assert resolve_geo_locale(None, exit_geo) == {"timezone": "Europe/Berlin", "locale": "de-DE"}
    assert resolve_geo_locale({"locale": "fr-FR"}, exit_geo) == {"locale": "fr-FR", "timezone": "Europe/Berlin"}
    assert resolve_geo_locale({"locale": "de_DE; drop"}, None) == {}
    assert tilion_emulation(None, {"timezone": None, "locale": None}) is None

    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RoseFixture/1.0"
    fingerprint = {"locale": "de-DE", "userAgentOverride": {"userAgent": user_agent, "platform": "Win32"}}
    emulation = tilion_emulation(fingerprint, {"timezone": "Asia/Tokyo", "locale": "ja-JP"})
    assert emulation == {
        "locale": "de-DE",
        "timezone": "Asia/Tokyo",
        "accept_language": "de-DE,de",
        "user_agent_override": {"userAgent": user_agent, "platform": "Win32"},
    }
    expected = ["Asia/Tokyo", "de-DE", user_agent]

    async def first_facts(page):
        return await page.evaluate("window.firstFacts")

    # Control: without emulation the host defaults show (so the check discriminates).
    async with _fixture_site() as base, _tilion_worker_stack() as (_service, pw_browser, _gateway):
        page = pw_browser.contexts[0].pages[0]
        await page.goto(base + "/first-script")
        default_facts = await first_facts(page)
        assert default_facts != expected and default_facts[0] != "Asia/Tokyo", default_facts

    async with _fixture_site() as base, _tilion_worker_stack(emulation) as (service, pw_browser, gateway):
        context = pw_browser.contexts[0]
        page = context.pages[0]
        await page.goto(base + "/first-script")
        assert await first_facts(page) == expected
        assert await page.evaluate("document.body.innerText") == "de-DE,de;q=0.9"
        assert await page.evaluate("new Intl.NumberFormat().format(1234.5)") == "1.234,5"

        # A popup's first document sees the overrides: no first-navigation race.
        async with page.expect_popup() as popup_info:
            await page.evaluate(f"window.open({json.dumps(base + '/first-script')})")
        popup = await popup_info.value
        await popup.wait_for_load_state("domcontentloaded")
        # Timezone/locale are read when scripts run, so holding the target makes
        # the popup's FIRST script see them. User-Agent/Accept-Language are fixed
        # when the opener starts the popup's first request (an open issue);
        # they hold from the popup's next navigation on.
        popup_first = await first_facts(popup)
        assert popup_first[:2] == expected[:2], popup_first
        await popup.reload()
        assert await first_facts(popup) == expected
        assert await popup.evaluate("document.body.innerText") == "de-DE,de;q=0.9"
        await popup.close()
        multiplexer = service.cdp_multiplexer
        assert multiplexer.emulation_applied >= 2
        assert gateway.rejected_4409 == 0

    # Re-applied after an in-activity upstream redial (not only on rotation).
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async with _fixture_site() as base, _chromium() as (playwright, browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            multiplexer = SingleCdpConnectionMultiplexer(gateway.cdp_url, emulation=emulation)
            local_url = await multiplexer.start()
            try:
                first = await playwright.chromium.connect_over_cdp(local_url)
                page = await first.contexts[0].new_page()
                await page.goto(base + "/first-script")
                assert await first_facts(page) == expected
                await gateway.drop_all()  # Chrome detaches every session: overrides gone
                for _ in range(50):
                    if not first.is_connected():
                        break
                    await asyncio.sleep(0.1)
                assert not first.is_connected()
                second = await playwright.chromium.connect_over_cdp(local_url)  # redial
                assert multiplexer.upstream_connections_opened == 2
                reattached = next(p for p in second.contexts[0].pages if p.url.endswith("/first-script"))
                await reattached.reload()
                assert await first_facts(reattached) == expected
                await second.close()
            finally:
                await multiplexer.close()

    # Both worker attach sites (session start, rotation reattach) configure it.
    from pathlib import Path

    handler_source = (Path(__file__).resolve().parents[2] / "domains/spawn_browser_agent_v3/handler.py").read_text()
    assert handler_source.count("emulation=tilion_emulation(") == 2


async def test_multiplexer_hides_and_releases_browser_ui_targets():
    """Tilion's Chrome reports chrome://omnibox-popup.top-chrome as attached
    type "browser_ui" targets (lane E, 23:03Z). No local client may see or
    drive them; an auto-attached one is resumed and detached, never left paused."""
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    page = {"targetId": "PAGE1", "type": "page", "url": "https://example.com/", "attached": True}
    frame = {"targetId": "FRAME1", "type": "iframe", "url": "https://ads.example/", "attached": True}
    omnibox = {
        "targetId": "UI1",
        "type": "browser_ui",
        "url": "chrome://omnibox-popup.top-chrome/",
        "attached": True,
    }
    sent_upstream: List[Dict[str, Any]] = []

    async def fake_tilion(socket_):
        async for raw in socket_:
            message = json.loads(raw)
            sent_upstream.append(message)
            method, session = message.get("method"), message.get("sessionId")
            reply: Dict[str, Any] = {"id": message["id"], "result": {}}
            if session:
                reply["sessionId"] = session
            if method == "Target.attachToBrowserTarget":
                reply["result"] = {"sessionId": "BROWSER-SESSION"}
            elif method == "Target.getTargets":
                reply["result"] = {"targetInfos": [page, omnibox, frame]}
            await socket_.send(json.dumps(reply))
            if method == "Target.setAutoAttach":
                for info, child in ((omnibox, "UI-SESSION"), (page, "PAGE-SESSION")):
                    await socket_.send(
                        json.dumps(
                            {
                                "method": "Target.attachedToTarget",
                                "sessionId": session,
                                "params": {"sessionId": child, "targetInfo": info, "waitingForDebugger": True},
                            }
                        )
                    )
                for method_name in ("Target.targetCreated", "Target.targetInfoChanged"):
                    await socket_.send(
                        json.dumps({"method": method_name, "sessionId": session, "params": {"targetInfo": omnibox}})
                    )
                await socket_.send(
                    json.dumps(
                        {"method": "Target.targetDestroyed", "sessionId": session, "params": {"targetId": "UI1"}}
                    )
                )
                await socket_.send(
                    json.dumps({"method": "Page.loadEventFired", "sessionId": "UI-SESSION", "params": {}})
                )
                await socket_.send(json.dumps({"id": 0, "method": "Rose.fixtureDone", "sessionId": session}))

    quiet = logging.getLogger("browser_tilion.fake_browser_ui")
    quiet.setLevel(logging.CRITICAL)
    async with websockets.serve(fake_tilion, "127.0.0.1", 0, logger=quiet) as server:
        port = server.sockets[0].getsockname()[1]
        multiplexer = SingleCdpConnectionMultiplexer(f"ws://127.0.0.1:{port}/v1/session/x/cdp?token=t")
        local_url = await multiplexer.start()
        try:
            async with websockets.connect(local_url, proxy=None) as client:
                await client.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
                targets = json.loads(await asyncio.wait_for(client.recv(), 10))
                assert [info["targetId"] for info in targets["result"]["targetInfos"]] == ["PAGE1", "FRAME1"]
                await client.send(
                    json.dumps(
                        {
                            "id": 2,
                            "method": "Target.setAutoAttach",
                            "params": {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True},
                        }
                    )
                )
                received: List[Dict[str, Any]] = []
                with contextlib.suppress(asyncio.TimeoutError):
                    while True:
                        received.append(json.loads(await asyncio.wait_for(client.recv(), 1.5)))
                assert {"id": 2, "result": {}} in received
                attached = [m for m in received if m.get("method") == "Target.attachedToTarget"]
                assert [m["params"]["targetInfo"]["targetId"] for m in attached] == ["PAGE1"], received
                assert "UI1" not in json.dumps(received) and "UI-SESSION" not in json.dumps(received), received
            released = [m for m in sent_upstream if (m.get("params") or {}).get("sessionId") == "UI-SESSION"]
            resumed = [
                m
                for m in sent_upstream
                if m.get("method") == "Runtime.runIfWaitingForDebugger" and m.get("sessionId") == "UI-SESSION"
            ]
            assert resumed, "browser_ui target left paused by waitForDebuggerOnStart"
            assert [m["method"] for m in released] == ["Target.detachFromTarget"], sent_upstream
            assert released[0]["sessionId"] == "BROWSER-SESSION"
            assert not [m for m in sent_upstream if m.get("sessionId") == "PAGE-SESSION"], (
                "page must stay with its client"
            )
        finally:
            await multiplexer.close()


class _RawCdpClient:
    """Minimal flat-session CDP client (browser-use style) for ordering tests."""

    def __init__(self, socket_):
        self.socket = socket_
        self.events: List[Dict[str, Any]] = []
        self._next = 0
        self._replies: Dict[int, asyncio.Future] = {}
        self._reader = asyncio.create_task(self._read())

    async def _read(self):
        async for raw in self.socket:
            message = json.loads(raw)
            future = self._replies.pop(message.get("id"), None) if "id" in message else None
            if future is not None:
                future.set_result(message)
            else:
                self.events.append(message)

    async def send(self, method, params=None, session_id=None):
        self._next += 1
        future = asyncio.get_running_loop().create_future()
        self._replies[self._next] = future
        message = {"id": self._next, "method": method, "params": params or {}}
        if session_id:
            message["sessionId"] = session_id
        await self.socket.send(json.dumps(message))
        reply = await asyncio.wait_for(future, 10)
        assert "error" not in reply, reply
        return reply["result"]

    async def attached(self, predicate):
        for _ in range(100):
            for event in self.events:
                if event.get("method") == "Target.attachedToTarget" and predicate(event["params"]):
                    return event["params"]
            await asyncio.sleep(0.05)
        raise AssertionError(f"no matching attach in {[e.get('method') for e in self.events]}")

    async def close(self):
        self._reader.cancel()
        await asyncio.gather(self._reader, return_exceptions=True)


class DropOverlappingKeysGateway(FakeTilionGateway):
    """Tilion's live drop rule (A1, 2026-10-22): a key event sent while another
    Input event is unanswered on the SAME CDP session is never answered and
    never delivered. Other traffic, and other sessions, are unaffected."""

    def __init__(self, endpoint: str) -> None:
        super().__init__(endpoint)
        self.dropped_keys = 0
        self._inflight: Dict[Any, set] = {}

    async def _handle(self, downstream):
        self.active += 1
        self.accepted += 1
        try:
            async with websockets.connect(self.endpoint, max_size=None, proxy=None) as upstream:

                async def up():
                    async for raw in downstream:
                        message = json.loads(raw)
                        method = str(message.get("method") or "")
                        session = message.get("sessionId")
                        if method.startswith("Input."):
                            inflight = self._inflight.setdefault(session, set())
                            if method == "Input.dispatchKeyEvent" and inflight:
                                self.dropped_keys += 1
                                continue
                            inflight.add(message.get("id"))
                        await upstream.send(raw)

                async def down():
                    async for raw in upstream:
                        message = json.loads(raw)
                        self._inflight.get(message.get("sessionId"), set()).discard(message.get("id"))
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


async def test_multiplexer_serialises_input_per_session_so_keys_are_not_dropped():
    """T37: idle-drift mouseMoved overlapping keys on one CDP session made Tilion
    drop keys, and Playwright then awaited the dropped key forever. The
    multiplexer forwards Input.* one at a time per session for every client."""
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async with _chromium() as (playwright, _browser, endpoint):
        async with DropOverlappingKeysGateway(endpoint) as gateway:
            multiplexer = SingleCdpConnectionMultiplexer(gateway.cdp_url)
            local_url = await multiplexer.start()
            browser = await playwright.chromium.connect_over_cdp(local_url)
            try:
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else await context.new_page()
                await page.set_content('<input id="field" autofocus>')
                await page.focus("#field")
                session = await context.new_cdp_session(page)
                sends = []
                for index, char in enumerate("abcdefghij"):
                    # Pipelined like idle drift + typing: nothing awaited in between.
                    sends.append(
                        session.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 10 + index, "y": 10})
                    )
                    sends.append(session.send("Input.dispatchKeyEvent", {"type": "char", "text": char}))
                await asyncio.wait_for(asyncio.gather(*sends), timeout=30)
                value = await page.evaluate("document.getElementById('field').value")
                assert value == "abcdefghij", (value, gateway.dropped_keys)
                assert gateway.dropped_keys == 0, gateway.dropped_keys
                # Playwright's own keyboard on the page session, overlapped by mouse moves.
                await page.fill("#field", "")
                moves = [page.mouse.move(20 + step, 20) for step in range(5)]
                await asyncio.wait_for(asyncio.gather(page.keyboard.type("xyz"), *moves), timeout=30)
                assert await page.evaluate("document.getElementById('field').value") == "xyz"
                assert multiplexer.input_unanswered == 0
            finally:
                await browser.close()
                await multiplexer.close()


async def test_multiplexer_fails_unanswered_input_instead_of_hanging():
    """An Input command the provider never answers is failed back to its client
    within the bound, and the next Input on that session still goes through."""
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async with _chromium() as (_playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            gateway.withhold = lambda raw: '"Input.dispatchMouseEvent"' in raw
            multiplexer = SingleCdpConnectionMultiplexer(gateway.cdp_url, input_answer_timeout=1.0)
            local_url = await multiplexer.start()
            try:
                async with websockets.connect(local_url, max_size=None, proxy=None) as socket_:
                    client = _RawCdpClient(socket_)
                    try:
                        created = await client.send("Target.createTarget", {"url": "about:blank"})
                        attached = await client.send(
                            "Target.attachToTarget", {"targetId": created["targetId"], "flatten": True}
                        )
                        child = attached["sessionId"]
                        replies = {}
                        for message_id, method, params in [
                            (9001, "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 5}),
                            (9002, "Input.dispatchKeyEvent", {"type": "char", "text": "q"}),
                        ]:
                            replies[message_id] = asyncio.get_running_loop().create_future()
                            client._replies[message_id] = replies[message_id]
                            await socket_.send(
                                json.dumps({"id": message_id, "method": method, "params": params, "sessionId": child})
                            )
                        started = time.monotonic()
                        mouse = await asyncio.wait_for(replies[9001], timeout=5)
                        key = await asyncio.wait_for(replies[9002], timeout=5)
                        assert "error" in mouse and "not answered" in mouse["error"]["message"], mouse
                        assert "error" not in key, key
                        assert time.monotonic() - started < 4
                        assert multiplexer.input_unanswered == 1
                    finally:
                        await client.close()
            finally:
                await multiplexer.close()


async def test_multiplexer_holds_new_targets_until_emulation_lands():
    """A client that does NOT wait for the debugger (browser-use) still gets
    popups whose first script sees the emulation: the multiplexer holds new
    targets itself, then releases them (and never leaves one paused)."""
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    emulation = {"timezone": "Asia/Tokyo", "locale": "de-DE", "accept_language": "de-DE,de"}
    async with _fixture_site() as base, _chromium() as (_playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            multiplexer = SingleCdpConnectionMultiplexer(gateway.cdp_url, emulation=emulation)
            local_url = await multiplexer.start()
            try:
                async with websockets.connect(local_url, max_size=None, proxy=None) as socket_:
                    client = _RawCdpClient(socket_)
                    try:
                        await client.send(
                            "Target.setAutoAttach",
                            {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True},
                        )
                        created = await client.send("Target.createTarget", {"url": base + "/"})
                        opener = await client.attached(lambda p: p["targetInfo"]["targetId"] == created["targetId"])
                        assert opener["waitingForDebugger"] is False, "client asked for running targets"
                        for _ in range(100):
                            with contextlib.suppress(AssertionError):
                                ready = await client.send(
                                    "Runtime.evaluate",
                                    {"expression": "document.readyState", "returnByValue": True},
                                    opener["sessionId"],
                                )
                                if ready["result"].get("value") == "complete":
                                    break
                            await asyncio.sleep(0.05)
                        await client.send(
                            "Runtime.evaluate",
                            {"expression": f"window.open({json.dumps(base + '/first-script')}); 1"},
                            opener["sessionId"],
                        )
                        popup = await client.attached(
                            lambda p: (
                                p["targetInfo"]["type"] == "page" and p["targetInfo"]["targetId"] != created["targetId"]
                            )
                        )
                        assert popup["waitingForDebugger"] is False
                        facts = None
                        for _ in range(100):
                            result = await client.send(
                                "Runtime.evaluate",
                                {"expression": "window.firstFacts || null", "returnByValue": True},
                                popup["sessionId"],
                            )
                            facts = result["result"].get("value")
                            if facts:
                                break
                            await asyncio.sleep(0.05)
                        assert facts and facts[:2] == ["Asia/Tokyo", "de-DE"], facts
                        assert multiplexer.emulation_applied >= 2
                    finally:
                        await client.close()
                assert gateway.rejected_4409 == 0
            finally:
                await multiplexer.close()


async def test_tilion_downloads_survive_provider_switch_and_pause():
    """Lane B review: (1) after Tilion -> Kernel both the ledger and the new
    provider's files are listed and read by path prefix; (2) each Tilion
    download is durable as it lands (attachment storage, idempotent), so a
    write-lock/payment pause or another worker still extracts it, and the
    worker keeps only the pointer."""
    from domains.spawn_browser_agent_v3 import service as browser_service
    from domains.spawn_browser_agent_v3 import tilion_worker
    from domains.spawn_browser_agent_v3.download_persist import persist_bytes_to_session_downloads

    stored: List[Dict[str, Any]] = []

    async def fake_upload_to_storage(*, user_id, file_content, filename, mime_type, idempotency_key=None):
        stored.append({"filename": filename, "content": file_content, "key": idempotency_key})
        return {"storage_path": f"{user_id}/{filename}", "original_filename": filename, "size": len(file_content)}

    tilion_id, kernel_id, resumed_id = "tilion-switch-1", "kernel-after-switch", "tilion-resumed-2"
    with patch("helpers.attachments.upload_to_storage", fake_upload_to_storage):
        tilion_worker.register_download_session(tilion_id)
        recorded = await persist_bytes_to_session_downloads(
            object(),
            tilion_id,
            filename="a.pdf",
            content=DOWNLOAD_BYTES,
            mime_type="application/pdf",
            provider="tilion",
            user_id="user-1",
        )
        again = await persist_bytes_to_session_downloads(
            object(),
            tilion_id,
            filename="a.pdf",
            content=DOWNLOAD_BYTES,
            mime_type="application/pdf",
            provider="tilion",
            user_id="user-1",
        )
    assert recorded["storage_path"] == "user-1/a.pdf" and again["path"] == recorded["path"]
    assert stored[0]["key"] == stored[1]["key"], "same bytes must map to one storage object (at-least-once)"
    assert tilion_worker.read_download(tilion_id, recorded["path"]) is None, "durable entries keep no bytes in RSS"

    # (1) Tilion -> Kernel: the ledger moves; Kernel's own files are listed too.
    tilion_worker.move_session(tilion_id, kernel_id)
    assert not tilion_worker.is_tilion_session(kernel_id)
    reads: List[str] = []

    async def kernel_list(_config, session_id):
        assert session_id == kernel_id
        return [{"path": "/tmp/downloads/b.pdf", "size": 3}]

    async def kernel_read(_config, session_id, path):
        reads.append(path)
        return {"content": b"b!!", "filename": "b.pdf", "mime_type": "application/pdf"}

    uploaded: List[str] = []

    async def extract_upload(*, user_id, file_content, filename, mime_type, idempotency_key=None):
        uploaded.append(filename)
        return {"storage_path": f"{user_id}/{filename}", "original_filename": filename}

    with (
        patch.object(browser_service, "list_session_files", kernel_list),
        patch.object(browser_service, "download_session_file", kernel_read),
        patch("helpers.attachments.upload_to_storage", extract_upload),
    ):
        listed = await browser_service._session_files_for_listing(object(), kernel_id)
        assert [f["path"] for f in listed] == [recorded["path"], "/tmp/downloads/b.pdf"], listed
        pointers = await browser_service.extract_session_files(kernel_id, "user-1", object())
    assert [p["original_filename"] for p in pointers] == ["a.pdf", "b.pdf"], pointers
    assert reads == ["/tmp/downloads/b.pdf"], "tilion-download:// paths never go to the provider file API"
    assert uploaded == ["b.pdf"], "the durable Tilion pointer is reused, not re-uploaded"

    # (2) Pause -> resume (worker memory gone): pointers come back from the resume context.
    durable = tilion_worker.durable_downloads(kernel_id)
    assert [entry["filename"] for entry in durable] == ["a.pdf"]
    tilion_worker.release_session(kernel_id)
    assert tilion_worker.list_downloads(kernel_id) == []
    tilion_worker.register_download_session(resumed_id)
    assert tilion_worker.restore_downloads(resumed_id, json.loads(json.dumps(durable))) == 1
    with patch.object(browser_service, "list_session_files", kernel_list):
        resumed = await browser_service.extract_session_files(resumed_id, "user-1", object())
    assert resumed == [{"storage_path": "user-1/a.pdf", "original_filename": "a.pdf", "size": len(DOWNLOAD_BYTES)}]
    tilion_worker.release_session(resumed_id)

    from pathlib import Path

    handler_source = (Path(__file__).resolve().parents[2] / "domains/spawn_browser_agent_v3/handler.py").read_text()
    assert '"tilion_downloads": durable_tilion_downloads(session_id)' in handler_source
    assert 'restore_tilion_downloads(session_id, private_browser_runtime.get("tilion_downloads"))' in handler_source
    assert "user_id=user_id," in handler_source[handler_source.index("BrowserDownloadPersister.create(") :][:400]


async def test_tilion_staged_uploads_are_bounded_per_session():
    """Lane B review (3): screenshots must not grow worker RSS without bound."""
    from domains.spawn_browser_agent_v3 import tilion_worker

    session_id = "tilion-staged-cap"
    paths = [
        tilion_worker.stage_upload(session_id, "screenshot.png", bytes([index]) * 1000, "image/png")["path"]
        for index in range(6)
    ]
    kept = [path for path in paths if tilion_worker.staged_upload_payload(path) is not None]
    assert kept == paths[-tilion_worker._KEPT_SCREENSHOTS :], kept
    attachment = tilion_worker.stage_upload(session_id, "resume.pdf", b"x" * 1000, "application/pdf")
    with patch.object(tilion_worker, "_MAX_STAGED_BYTES", 3500):
        # Over budget: the oldest screenshots go first, the attachment stays.
        tilion_worker.stage_upload(session_id, "screenshot.png", b"y" * 1000, "image/png")
        assert tilion_worker.staged_upload_payload(attachment["path"]) is not None
        try:
            tilion_worker.stage_upload(session_id, "big.bin", b"z" * 4000, "application/octet-stream")
        except ValueError as error:
            assert "would exceed" in str(error)
        else:
            raise AssertionError("an upload past the per-session budget must be refused")
    total = sum(len(item["buffer"]) for item in tilion_worker._staged_uploads[session_id].values())
    assert total <= 3500, total
    tilion_worker.release_session(session_id)
    assert session_id not in tilion_worker._staged_uploads


async def test_click_path_cdp_awaits_are_bounded_when_replies_are_withheld():
    """C3 hardening: a withheld Runtime.evaluate / Page.captureScreenshot reply
    must not hang a step; the click receipt reads as unknown (None)."""
    import time
    from types import SimpleNamespace

    import browser_tools.dom_service as dom_module
    from domains.spawn_browser_agent_v3 import service_actions

    async with _fixture_site() as base, _tilion_worker_stack() as (service, pw_browser, gateway):
        await pw_browser.contexts[0].pages[0].goto(base + "/")
        gateway.withhold = lambda raw: "__roseBrowserClickReceipts" in raw or "Page.captureScreenshot" in raw

        started = time.monotonic()
        assert await service_actions._arm_click_receipt(service.session, {"x": 5, "y": 5}) is None
        assert time.monotonic() - started < service_actions._CLICK_RECEIPT_TIMEOUT_SECONDS + 2
        page = await service.session.get_current_page()
        started = time.monotonic()
        assert await service_actions._read_click_receipt((page, "token")) is None
        assert time.monotonic() - started < service_actions._CLICK_RECEIPT_TIMEOUT_SECONDS + 2
        assert len(gateway.withheld_ids) >= 2, "the fixture really withheld the replies"

        with patch.object(dom_module, "VIEWPORT_SCREENSHOT_TIMEOUT_SECONDS", 1.0):
            started = time.monotonic()
            try:
                await service.capture_viewport_png()
            except TimeoutError as error:
                assert "Page.captureScreenshot" in str(error)
            else:
                raise AssertionError("a withheld screenshot must raise, not hang")
            assert time.monotonic() - started < 3

    # Coordinates: a hung DOMService call ends as "no coordinates", not a hang.
    class _History:
        async def record_action(self, **_kwargs):
            return None

    class _Dom:
        async def get_click_coordinates(self, _index):
            await asyncio.sleep(3600)

    class _Session:
        async def highlight_interaction_element(self, _element):
            return None

    class _Humanizer:
        async def click_at_coords(self, *_args):
            raise AssertionError("must not click without coordinates")

    with patch.object(service_actions, "_CLICK_COORDINATES_TIMEOUT_SECONDS", 0.5):
        started = time.monotonic()
        result = await service_actions._execute_click(
            session=_Session(),
            dom_service=_Dom(),
            action_history=_History(),
            element=SimpleNamespace(node_name="BUTTON", tag_name="button", attributes={}),
            index=4,
            coords=None,
            thinking="",
            humanizer=_Humanizer(),
            write_lock_enabled=False,
            write_lock_approvals=None,
            current_url="https://example.com",
            system_name="rose",
        )
    assert result["success"] is False and "no coordinates" in result["error"], result
    assert time.monotonic() - started < 2


async def test_tilion_upload_verified_when_page_resets_input_on_change():
    """Lane F tinypng (agent ea613f83): the site's onchange read the file and
    reset the input, so a post-hoc files[0] check saw -1. The delivered file is
    the one the page's own change event carried."""
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3 import tilion_worker
    from domains.spawn_browser_agent_v3.service_actions import _execute_upload_file

    session_id = "tilion-upload-clearing"
    async with _fixture_site() as base, _tilion_worker_stack() as (service, pw_browser, gateway):
        page = pw_browser.contexts[0].pages[0]
        await page.goto(base + "/")
        for selector, page_record, input_gone in (
            ("#clearing", "window.got", False),
            ("#replacing", "window.replaced", True),
        ):
            await page.goto(base + "/")
            staged = tilion_worker.stage_upload(session_id, "rs.jpeg", UPLOAD_BYTES, "image/jpeg")
            cdp_session = await service.session.get_or_create_cdp_session(focus=False)
            send = cdp_session.cdp_client.send
            document = await send.DOM.getDocument(params={}, session_id=cdp_session.session_id)
            node = await send.DOM.querySelector(
                params={"nodeId": document["root"]["nodeId"], "selector": selector}, session_id=cdp_session.session_id
            )
            described = await send.DOM.describeNode(
                params={"nodeId": node["nodeId"]}, session_id=cdp_session.session_id
            )
            element = SimpleNamespace(
                backend_node_id=described["node"]["backendNodeId"], node_name="INPUT", attributes={"type": "file"}
            )

            class _History:
                async def record_action(self, **_kwargs):
                    return None

            class _Humanizer:
                def __init__(self, input_page):
                    self.input_page = input_page

                async def click_at_coords(self, *_args):
                    return None

            async def no_coordinates(_index):
                return None

            service.get_element_coordinates = no_coordinates
            result = await _execute_upload_file(
                session=service.session,
                dom_service=service,
                action_history=_History(),
                element=element,
                index=7,
                params={"filename": "rs.jpeg"},
                thinking="",
                humanizer=_Humanizer(page),
                available_file_paths={"rs.jpeg": staged["path"]},
            )
            assert result.get("success") is True, result
            assert await page.evaluate(page_record) == ["rs.jpeg", len(UPLOAD_BYTES)]
            if not input_gone:
                assert await page.evaluate("document.querySelector('#clearing').files.length") == 0, "the page reset it"
            assert await page.evaluate("document.querySelector('[data-rose-upload]')") is None
            assert gateway.rejected_4409 == 0
    tilion_worker.release_session(session_id)


async def test_multiplexer_never_leaves_workers_paused_for_non_waiting_clients():
    """The multiplexer forces waitForDebuggerOnStart to hold pages for emulation.
    Targets it does not emulate (workers) must be resumed for a client that asked
    not to wait (browser-use), or they stay paused and the page hangs."""
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    async with _fixture_site() as base, _chromium() as (_playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            multiplexer = SingleCdpConnectionMultiplexer(gateway.cdp_url, emulation={"timezone": "Asia/Tokyo"})
            local_url = await multiplexer.start()
            try:
                async with websockets.connect(local_url, max_size=None, proxy=None) as socket_:
                    client = _RawCdpClient(socket_)
                    try:
                        auto_attach = {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True}
                        await client.send("Target.setAutoAttach", auto_attach)
                        created = await client.send("Target.createTarget", {"url": "about:blank"})
                        page = await client.attached(lambda p: p["targetInfo"]["targetId"] == created["targetId"])
                        # browser-use also auto-attaches inside each page (workers, OOPIFs).
                        await client.send("Target.setAutoAttach", auto_attach, page["sessionId"])
                        await client.send("Page.navigate", {"url": base + "/worker"}, page["sessionId"])
                        worker = await client.attached(lambda p: p["targetInfo"]["type"] == "worker")
                        assert worker["waitingForDebugger"] is False
                        title = None
                        for _ in range(100):
                            with contextlib.suppress(AssertionError):
                                result = await client.send(
                                    "Runtime.evaluate",
                                    {"expression": "document.title", "returnByValue": True},
                                    page["sessionId"],
                                )
                                title = result["result"].get("value")
                                if title == "worker-pong":
                                    break
                            await asyncio.sleep(0.05)
                        assert title == "worker-pong", f"worker stayed paused: {title}"
                    finally:
                        await client.close()
            finally:
                await multiplexer.close()


async def test_tilion_live_view_token_is_redacted_before_persisting():
    """The live-view URL's ?token= must not reach message metadata, recording
    manifests or activity results; other providers' URLs are unchanged."""
    from domains.spawn_browser_agent_v3 import repo
    from domains.spawn_browser_agent_v3.cdp_urls import redact_url_secrets

    live_view = f"https://back.tilion.dev/v1/session/{TILION_SESSION}/live-view?token={TILION_TOKEN}"
    kernel_view = "https://live.onkernel.com/browser/abc?jwt=kernel-jwt"
    with patch.dict(os.environ, {"TILION_BASE_URL": "https://back.tilion.dev"}):
        assert redact_url_secrets(live_view) == live_view.replace(TILION_TOKEN, "REDACTED")
        assert redact_url_secrets(kernel_view) == kernel_view
        assert redact_url_secrets("") == "" and redact_url_secrets(None) is None
        posted: List[Dict[str, Any]] = []

        class _Client:
            async def post(self, url, *, timeout, headers, json):
                posted.append(json)
                return httpx.Response(201, json={"id": "m1"})

        from tools.base import MessageStatus

        with patch.object(repo, "get_http_client", lambda: _Client()):
            await repo.save_browser_action_message(
                agent_id="agent-1",
                title="t",
                message="m",
                status=MessageStatus.IN_PROGRESS,
                task_id="task-1",
                browser_url=live_view,
            )
        assert posted and posted[0]["metadata"]["browser_url"] == redact_url_secrets(live_view)
        assert TILION_TOKEN not in json.dumps(posted)

        # Auth-assistance handoff: the backend mints the live view (A2 6ee00fe4e).
        from types import SimpleNamespace

        handoffs: List[Dict[str, Any]] = []

        class _AsyncClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return False

            async def post(self, url, *, headers, json):
                handoffs.append(json)
                return httpx.Response(201, json={"id": "aa-1"})

        config = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend", api_key="k"))
        with patch.object(repo.httpx, "AsyncClient", _AsyncClient):
            await repo.create_user_auth_assistance_request(
                config,
                agent_id="agent-1",
                user_id="user-1",
                auth_realm="example.com",
                browser_session_id="task-1",
                steel_session_id=TILION_SESSION,
                browser_url=live_view,
                current_url="https://example.com/login",
            )
        assert handoffs[0]["browserUrl"] == redact_url_secrets(live_view)
        assert TILION_TOKEN not in json.dumps(handoffs)

    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "domains/spawn_browser_agent_v3"
    handler_source = (root / "handler.py").read_text()
    assert '"browser_url": browser_url,' not in handler_source, "activity results must redact browser_url"
    # Serial Tilion keyboard (A1 RCA): the initial humanizer and every rebind after a
    # provider handoff (rotation, recovery, auth restart) carry the flag.
    assert handler_source.count("serial_cdp_keyboard=is_single_cdp_client_provider(") == 4
    assert handler_source.count("humanizer = await _replace_browser_humanizer(") == 3
    assert '"browser_url": redact_url_secrets(self.browser_url)' in (root / "recording.py").read_text()


async def test_supervisor_cap_logs_blocked_stack_and_classifies_action_timeouts():
    """Lane B T37: (1) a TimeoutError the action raises itself (humanizer drain)
    is an action error, not the supervisor cap; (2) at the cap, the stack where
    the action is blocked is logged before it is cancelled, and the wait for the
    cancellation is bounded."""
    import time

    from structlog.testing import capture_logs

    from domains.spawn_browser_agent_v3.handler import (
        BrowserActionRaisedTimeout,
        BrowserSupervisorCapExceeded,
        _await_browser_action_within_cap,
    )
    from domains.spawn_browser_agent_v3.service_actions import BrowserEvaluateDeadlineExceeded

    context = {"agent_id": "agent-1", "action_name": "click"}

    async def blocked_on_a_lost_cdp_reply():
        await asyncio.get_running_loop().create_future()  # never answered

    started = time.monotonic()
    with capture_logs() as logs:
        try:
            await _await_browser_action_within_cap(
                asyncio.create_task(blocked_on_a_lost_cdp_reply()), timeout=0.3, log_context=context
            )
        except BrowserSupervisorCapExceeded as error:
            assert error.cancelled is True and error.timeout_seconds == 0.3
        else:
            raise AssertionError("the supervisor cap must fire")
    assert time.monotonic() - started < 0.3 + 5
    blocked = [entry for entry in logs if entry["event"] == "Browser action blocked at supervisor cap"]
    assert blocked and "blocked_on_a_lost_cdp_reply" in blocked[0]["blocked_stack"], logs
    assert len(blocked[0]["blocked_stack"]) <= 4096 and blocked[0]["action_name"] == "click"

    async def ignores_cancellation():
        while True:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                continue

    stubborn = asyncio.create_task(ignores_cancellation())
    started = time.monotonic()
    try:
        await _await_browser_action_within_cap(stubborn, timeout=0.1, log_context=context, drain_seconds=0.3)
    except BrowserSupervisorCapExceeded as error:
        assert error.cancelled is False, "unknown timeout source when the action ignores cancellation"
    assert time.monotonic() - started < 2, "the cancellation wait is bounded"
    stubborn.get_coro().close()  # a task that ignores cancel; end it for the fixture

    async def drain_times_out():
        raise asyncio.TimeoutError("CDP keyboard input drain timed out after 15s")

    try:
        await _await_browser_action_within_cap(asyncio.create_task(drain_times_out()), timeout=5, log_context=context)
    except BrowserActionRaisedTimeout as error:
        assert not isinstance(error, asyncio.TimeoutError), "must reach the generic action-error path"
        assert "drain timed out" in str(error)
    else:
        raise AssertionError("an action-raised TimeoutError must be reclassified")

    async def evaluate_deadline():
        raise BrowserEvaluateDeadlineExceeded(30, 30.1)

    try:
        await _await_browser_action_within_cap(asyncio.create_task(evaluate_deadline()), timeout=5, log_context=context)
    except BrowserEvaluateDeadlineExceeded:
        pass
    else:
        raise AssertionError("the evaluate deadline keeps its timeout semantics")

    async def succeeds():
        return {"success": True}

    assert await _await_browser_action_within_cap(asyncio.create_task(succeeds()), timeout=5, log_context=context) == {
        "success": True
    }

    from pathlib import Path

    handler_source = (Path(__file__).resolve().parents[2] / "domains/spawn_browser_agent_v3/handler.py").read_text()
    assert "result = await _await_browser_action_within_cap(" in handler_source
    assert "asyncio.wait_for(\n                    action_task," not in handler_source


async def run_all_tests():
    result = BlackboxResult()
    for name, test in [
        ("fake_gateway_rejects_second_direct_client", test_fake_gateway_rejects_second_direct_client),
        ("tilion_worker_attach_uses_one_upstream_socket", test_tilion_worker_attach_uses_one_upstream_socket),
        ("multiplexer_releases_and_reattaches", test_multiplexer_releases_upstream_when_clients_leave_and_reattaches),
        ("multiplexer_propagates_provider_close_code", test_multiplexer_propagates_provider_close_code),
        ("tilion_cdp_url_detection_and_redaction", test_tilion_cdp_url_detection_and_redaction),
        ("tilion_download_lands_in_worker_ledger", test_tilion_download_lands_in_worker_ledger_not_static_assets),
        ("tilion_upload_sets_worker_bytes_on_file_input", test_tilion_upload_sets_worker_bytes_on_file_input),
        ("tilion_worker_apply_contract", test_tilion_worker_apply_contract_sets_cookies_and_local_storage),
        ("tilion_screenshot_action_uses_worker_socket", test_tilion_screenshot_action_uses_worker_socket_not_rest),
        ("tilion_cost_row", test_tilion_cost_row_is_12_cents_per_hour_plus_create),
        ("tilion_recording_screenshot_replay", test_tilion_recording_uses_provider_neutral_screenshot_replay),
        ("provider_name_sets_include_tilion", test_provider_name_sets_include_tilion),
        ("tilion_downloads_path_and_live_view_host", test_tilion_downloads_path_and_live_view_host),
        ("multiplexer_refreshes_expired_connect_token", test_multiplexer_refreshes_expired_connect_token),
        ("resume_request_carries_worker_storage_state", test_resume_request_carries_worker_storage_state),
        ("tilion_press_key_uses_cdp_input", test_tilion_press_key_uses_cdp_input_not_backend_computer_api),
        ("tilion_locale_override", test_tilion_locale_override_applies_intl_and_accept_language),
        ("multiplexer_hides_browser_ui_targets", test_multiplexer_hides_and_releases_browser_ui_targets),
        ("multiplexer_holds_new_targets_for_emulation", test_multiplexer_holds_new_targets_until_emulation_lands),
        ("tilion_downloads_survive_switch_and_pause", test_tilion_downloads_survive_provider_switch_and_pause),
        ("tilion_staged_uploads_bounded", test_tilion_staged_uploads_are_bounded_per_session),
        ("click_path_cdp_awaits_bounded", test_click_path_cdp_awaits_are_bounded_when_replies_are_withheld),
        ("tilion_upload_input_reset_on_change", test_tilion_upload_verified_when_page_resets_input_on_change),
        ("multiplexer_resumes_workers", test_multiplexer_never_leaves_workers_paused_for_non_waiting_clients),
        ("multiplexer_serialises_input_per_session", test_multiplexer_serialises_input_per_session_so_keys_are_not_dropped),
        ("multiplexer_fails_unanswered_input", test_multiplexer_fails_unanswered_input_instead_of_hanging),
        ("tilion_live_view_token_redacted", test_tilion_live_view_token_is_redacted_before_persisting),
        (
            "supervisor_cap_logs_stack_and_classifies",
            test_supervisor_cap_logs_blocked_stack_and_classifies_action_timeouts,
        ),
    ]:
        await result.record_async(name, test)
    return result.all_passed
