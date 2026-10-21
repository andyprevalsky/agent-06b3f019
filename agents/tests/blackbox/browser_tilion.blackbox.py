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

    app = web.Application()
    app.router.add_get("/", index)
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
async def _tilion_worker_stack():
    """Real Chromium behind the fake Tilion gateway, attached like the worker does."""
    from browser_tools.dom_service import DOMService, browser_downloads_path_for_provider
    from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection

    async with _chromium() as (playwright, _browser, endpoint):
        async with FakeTilionGateway(endpoint) as gateway:
            with _tilion_env(gateway):
                local_url, multiplexer = await open_browser_cdp_connection(gateway.cdp_url)
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

        with patch("domains.spawn_browser_agent_v3.repo.upload_file_to_session", no_backend), patch(
            "domains.spawn_browser_agent_v3.repo.download_session_file", no_backend
        ), patch.object(browser_service, "list_session_files", no_backend), patch.object(
            browser_service, "download_session_file", no_backend
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

    with patch("domains.spawn_browser_agent_v3.repo.take_browser_computer_screenshot", rest_forbidden), patch(
        "domains.spawn_browser_agent_v3.repo.upload_file_to_session", rest_forbidden
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
    ]:
        await result.record_async(name, test)
    return result.all_passed
