"""Prove a tab owner's debugger wait can block an isolated POST popup.

Prerequisites: agents/venv and its Playwright Chromium installation.
    agents/venv/bin/python -m playwright install chromium
    agents/venv/bin/python agents/tests/e2e/cdp_popup_owner_probe.py

Use --chrome /absolute/path/to/chrome to pin another browser build. This starts
an isolated local browser and HTTP fixture, with no Steel credentials or public
tunnel. It deliberately injects an owner wait, observes the unchanged assertion
fail, then resumes that owner and observes it pass. This proves the mechanism;
it does not establish that a hosted provider has the same internal defect.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import httpx
import websockets
from playwright.async_api import async_playwright
from steel_popup_probe import Cdp, report


class Owner(Cdp):
    def __init__(self, socket, initial_tabs: set[str]) -> None:
        super().__init__(socket)
        self.initial_tabs = initial_tabs
        self.held_session: str | None = None
        self.held = asyncio.Event()
        self.tasks: set[asyncio.Task] = set()

    async def arm(self, event: dict) -> None:
        info, session = event["targetInfo"], event["sessionId"]
        if info["type"] != "tab":
            return
        await self.send(
            "Target.setAutoAttach",
            {
                "autoAttach": True,
                "waitForDebuggerOnStart": False,
                "flatten": True,
                "filter": [{"type": "page"}, {"exclude": True}],
            },
            session,
        )
        if info["targetId"] in self.initial_tabs or not event.get("waitingForDebugger"):
            await self.send("Runtime.runIfWaitingForDebugger", session=session)
        else:
            assert event["waitingForDebugger"], event
            self.held_session = session
            self.held.set()
            report("owner.held", target_id=info["targetId"], waiting_for_debugger=True)

    async def read(self) -> None:
        async for raw in self.socket:
            message = json.loads(raw)
            future = self.pending.pop(message.get("id"), None)
            if future is not None and not future.done():
                future.set_result(message)
            elif message.get("method") == "Target.attachedToTarget":
                self.tasks.add(asyncio.create_task(self.arm(message["params"])))


async def assert_arrived(observer: Cdp, session: str, nonce: str, posts: list[str]) -> None:
    async with asyncio.timeout(4):
        await observer.send("Page.enable", session=session)
        while True:
            frame = (await observer.send("Page.getFrameTree", session=session))["frameTree"]["frame"]
            result = await observer.send(
                "Runtime.evaluate",
                {
                    "expression": "({text:document.querySelector('#arrived')?.textContent,isolated:window.opener===null})",
                    "returnByValue": True,
                },
                session,
            )
            value = result["result"].get("value", {})
            if value.get("text") == "Intact POST arrived":
                assert value["isolated"] is True, value
                assert parse_qs(urlsplit(frame["url"]).query).get("nonce") == [nonce], frame
                assert posts == [nonce], posts
                return
            await asyncio.sleep(0.05)


async def experiment(browser, endpoint: str, base: str, nonce: str, posts: list[str]) -> None:
    page = await browser.new_page()
    await page.goto(base + "/form")
    async with websockets.connect(endpoint) as owner_socket, websockets.connect(endpoint) as observer_socket:
        observer = Cdp(observer_socket)
        observer_reader = asyncio.create_task(observer.read())
        target_infos = (await observer.send("Target.getTargets", {"filter": [{}]}))["targetInfos"]
        owner = Owner(owner_socket, {t["targetId"] for t in target_infos if t["type"] == "tab"})
        owner_reader = asyncio.create_task(owner.read())
        try:
            report("browser.version", **await observer.send("Browser.getVersion"))
            await owner.send(
                "Target.setAutoAttach",
                {
                    "autoAttach": True,
                    "waitForDebuggerOnStart": True,
                    "flatten": True,
                    "filter": [{"type": "tab"}, {"exclude": True}],
                },
            )
            await page.click("button")
            await asyncio.wait_for(owner.held.wait(), 4)
            for task in owner.tasks:
                if task.done():
                    task.result()
            popup = next(t for t in await observer.pages() if t.get("openerId"))
            assert popup["url"] == "", popup
            session = await observer.attach(popup["targetId"])
            try:
                await assert_arrived(observer, session, nonce, posts)
            except TimeoutError:
                report("assertion.before", result="FAIL", reason="Page.enable timed out", post_count=len(posts))
            else:
                raise AssertionError("Popup completed despite the deliberately held owner wait")
            assert posts == [], posts
            try:
                async with asyncio.timeout(1):
                    await observer.send("Runtime.runIfWaitingForDebugger", session=session)
            except TimeoutError:
                report("observer.resume", result="TIMEOUT")
            else:
                raise AssertionError("Observer resume unexpectedly completed while owner was held")
            assert owner.held_session is not None
            started = time.monotonic()
            await owner.send("Runtime.runIfWaitingForDebugger", session=owner.held_session)
            await assert_arrived(observer, session, nonce, posts)
            report(
                "assertion.after",
                result="PASS",
                resume_ms=round((time.monotonic() - started) * 1000),
                original_post_count=len(posts),
                opener_isolated=True,
            )
        finally:
            for task in owner.tasks:
                task.cancel()
            owner_reader.cancel()
            observer_reader.cancel()
            await asyncio.gather(owner_reader, observer_reader, *owner.tasks, return_exceptions=True)


async def main(chrome: str | None) -> None:
    nonce, posts = uuid.uuid4().hex, []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = (
                f'<form method="POST" action="/handoff" target="_blank"><input name="nonce" value="{nonce}">'
                "<button>Continue</button></form>"
                if self.path == "/form"
                else '<h1 id="arrived">Intact POST arrived</h1>'
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["Content-Length"])).decode()
            assert parse_qs(body) == {"nonce": [nonce]}, body
            posts.append(nonce)
            self.send_response(303)
            self.send_header("Location", "/done?nonce=" + nonce)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with socket.socket() as socket_probe:
            socket_probe.bind(("127.0.0.1", 0))
            port = socket_probe.getsockname()[1]
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                executable_path=chrome,
                headless=True,
                args=[f"--remote-debugging-port={port}", "--no-sandbox", "--use-mock-keychain"],
            )
            try:
                async with httpx.AsyncClient(trust_env=False) as client:
                    response = await client.get(f"http://127.0.0.1:{port}/json/version")
                    response.raise_for_status()
                await experiment(
                    browser,
                    response.json()["webSocketDebuggerUrl"],
                    f"http://127.0.0.1:{server.server_port}",
                    nonce,
                    posts,
                )
            finally:
                await browser.close()
                report("cleanup.browser", connected=browser.is_connected())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", help="Absolute path to an isolated test Chrome executable")
    asyncio.run(main(parser.parse_args().chrome))
