"""Exercise remote attachment through real Chromium and a local CDP proxy."""

import asyncio
import json
import logging
import socket
import time

import httpx
import websockets
from playwright.async_api import async_playwright

from browser_tools.dom_service import DOMService
from _test_utils import BlackboxResult


async def test_remote_attach_preserves_provider_viewport():
    async with async_playwright() as playwright:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        browser = await playwright.chromium.launch(
            headless=True, args=[f"--remote-debugging-port={port}"]
        )
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        for title in ("healthy", "background"):
            page = await context.new_page()
            await page.goto(f"data:text/html,<title>{title}</title>{title}")
        async with httpx.AsyncClient(trust_env=False) as client:
            version = await client.get(f"http://127.0.0.1:{port}/json/version")
            endpoint = version.json()["webSocketDebuggerUrl"]
        root = await browser.new_browser_cdp_session()
        targets = (await root.send("Target.getTargets"))["targetInfos"]
        # browser-use chooses the first page as its initial focus. Hold only
        # another page's viewport response; all actual browser commands still run.
        target_id = [target["targetId"] for target in targets if target["type"] == "page"][1]
        stats = {"metrics": 0, "dropped": 0, "other_replies": 0}
        sessions = {}
        held_ids = set()

        async def proxy(downstream):
            async with websockets.connect(endpoint, max_size=None) as upstream:
                async def to_upstream():
                    async for raw in downstream:
                        message = json.loads(raw)
                        if message.get("method") == "Emulation.setDeviceMetricsOverride":
                            stats["metrics"] += 1
                            if sessions.get(message.get("sessionId")) == target_id:
                                held_ids.add(message["id"])
                                stats["dropped"] += 1
                                print("WITHHOLD background viewport reply", flush=True)
                        await upstream.send(raw)

                async def to_downstream():
                    async for raw in upstream:
                        message = json.loads(raw)
                        if message.get("method") == "Target.attachedToTarget":
                            params = message["params"]
                            sessions[params["sessionId"]] = params["targetInfo"]["targetId"]
                        if message.get("id") in held_ids:
                            continue
                        stats["other_replies"] += 1
                        await downstream.send(raw)

                tasks = [asyncio.create_task(to_upstream()), asyncio.create_task(to_downstream())]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)

        # browser-use probes the socket before opening its websocket; suppress
        # only this fixture server's expected empty-handshake diagnostic.
        proxy_logger = logging.getLogger("browser_remote_viewport.fixture_proxy")
        proxy_logger.setLevel(logging.CRITICAL)
        async with websockets.serve(proxy, "127.0.0.1", 0, logger=proxy_logger) as server:
            proxy_port = server.sockets[0].getsockname()[1]
            service = DOMService(f"ws://127.0.0.1:{proxy_port}")
            start = time.monotonic()
            failure = None
            try:
                await service.connect()
            except Exception as exc:
                failure = exc
                print("CONNECT ERROR", type(exc).__name__, str(exc), flush=True)
            elapsed = time.monotonic() - start
            print("RESULT", json.dumps({
                "elapsed_s": round(elapsed, 3), "stats": stats, "connected": failure is None,
            }), flush=True)
            try:
                sizes = [await page.evaluate("({width:innerWidth,height:innerHeight})")
                         for page in context.pages]
                print("VIEWPORTS", sizes, flush=True)
            finally:
                # This fixture owns Chromium. Close the transport directly so
                # teardown doesn't enqueue work behind the deliberately held reply.
                if service._captcha_indicator_task is not None:
                    service._captcha_indicator_task.cancel()
                    await asyncio.gather(service._captcha_indicator_task, return_exceptions=True)
                if service._session:
                    service._session._intentional_stop = True
                    if service._session._cdp_client_root is not None:
                        await service._session._cdp_client_root.stop()
                    await service._session.event_bus.stop(timeout=0, clear=True)
                await browser.close()
            assert failure is None, (
                f"Browser startup blocked by background viewport: {type(failure).__name__}: {failure}"
            )
            assert stats["metrics"] == 0, "Attachment must preserve the provider's viewport"
            assert stats["other_replies"] > 0, "The local CDP transport must remain responsive"
            assert all(size == {"width": 1280, "height": 800} for size in sizes), sizes


async def run_all_tests():
    result = BlackboxResult()
    await result.record_async(
        "remote_attach_preserves_provider_viewport", test_remote_attach_preserves_provider_viewport
    )
    return result.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
