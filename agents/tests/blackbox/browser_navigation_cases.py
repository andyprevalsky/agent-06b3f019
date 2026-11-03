"""Regression coverage for user navigation on the worker's already-open CDP client."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


async def test_browser_user_navigation_history():
    from playwright.async_api import async_playwright
    from domains.spawn_browser_agent_v3.navigation import execute_navigation
    async def handle(reader, writer):
        request = await reader.readline()
        path = request.decode().split(" ")[1]
        body = f"<html><title>{path}</title><body>{path}</body></html>".encode()
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        await writer.drain()
        writer.close()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    base = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = await browser.new_page()
            await page.goto(base + "/one")
            await page.goto(base + "/two")
            await page.evaluate("history.pushState({}, '', '#same-document')")
            async def live_session():
                return "held-target", await page.context.new_cdp_session(page)
            dom = SimpleNamespace(_live_cdp_session=live_session,
                                  _send_cdp_command=lambda session, method, params=None: session.send(method, params or {}))
            assert (await execute_navigation(dom, "back")).endswith("/two")
            assert "one" in (await execute_navigation(dom, "back"))
            assert "two" in (await execute_navigation(dom, "forward"))
            assert (await execute_navigation(dom, "forward")).endswith("#same-document")
            assert (await execute_navigation(dom, "reload")).endswith("#same-document")
            # History boundary is an intentional successful no-op.
            assert (await execute_navigation(dom, "forward")).endswith("#same-document")
        finally:
            await browser.close()
            server.close()
            await server.wait_closed()


async def test_browser_user_navigation_command_binding():
    from domains.spawn_browser_agent_v3.navigation import consume_navigation
    config = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend", api_key="test"))
    command = {"id": "command", "sessionId": "live", "action": "back", "deadline": time.time() * 1000 + 10000}
    response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"command": command})
    client = SimpleNamespace(post=AsyncMock(return_value=response))
    with patch("domains.spawn_browser_agent_v3.navigation.get_http_client", return_value=client), \
         patch("domains.spawn_browser_agent_v3.navigation.execute_navigation", new=AsyncMock(return_value="https://back.test")) as execute:
        await consume_navigation(config, "task", "live", object())
        execute.assert_awaited_once()
        assert client.post.call_args.kwargs["json"]["url"] == "https://back.test"
        command["sessionId"] = "old"
        try:
            await consume_navigation(config, "task", "live", object())
            assert False, "foreign-session command must fail"
        except RuntimeError:
            pass
        assert execute.await_count == 1
        command["sessionId"] = "live"
        command["deadline"] = 0
        await consume_navigation(config, "task", "live", object())
        assert execute.await_count == 1, "expired command must not execute"
