"""Reproduce opener-isolated POST popup startup failures without Rose/browser-use.

Run from the checkout root after ``bash scripts/cloud-init.sh``:
    agents/venv/bin/python agents/tests/e2e/steel_popup_probe.py

Requires STEEL_API_KEY in agents/.env and an available Steel browser slot. Creates
one fresh session with synthetic example.com content, compares isolated/opener
POST popups in that same session, and verifies release before exiting. Exit 1
means a popup did not commit/respond. Opener access is a diagnostic control,
not a proposed change to third-party pages or production browser behavior.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
import websockets
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
COMMAND_TIMEOUT = 8
DESTINATION = "https://example.com/"


def report(kind: str, **fields: Any) -> None:
    print(json.dumps({"event": kind, **fields}), flush=True)


class Cdp:
    def __init__(self, socket: Any) -> None:
        self.socket = socket
        self.sequence = 0
        self.pending: dict[int, asyncio.Future] = {}

    async def read(self) -> None:
        async for raw in self.socket:
            message = json.loads(raw)
            future = self.pending.pop(message.get("id"), None)
            if future is not None and not future.done():
                future.set_result(message)
            elif message.get("method") == "Target.attachedToTarget":
                report("target.attached", **message["params"])

    async def send(self, method: str, params: dict | None = None, session: str | None = None) -> dict:
        self.sequence += 1
        command_id = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[command_id] = future
        message = {"id": command_id, "method": method, "params": params or {}}
        if session is not None:
            message["sessionId"] = session
        try:
            await self.socket.send(json.dumps(message))
            reply = await asyncio.wait_for(future, COMMAND_TIMEOUT)
            if "error" in reply:
                raise RuntimeError(f"{method}: {reply['error']}")
            return reply.get("result", {})
        finally:
            self.pending.pop(command_id, None)

    async def pages(self) -> list[dict]:
        result = await self.send("Target.getTargets")
        return [target for target in result["targetInfos"] if target["type"] == "page"]

    async def attach(self, target: str) -> str:
        result = await self.send("Target.attachToTarget", {"targetId": target, "flatten": True})
        return result["sessionId"]


async def compare_popups(cdp: Cdp) -> bool:
    report("browser.version", **await cdp.send("Browser.getVersion"))
    page = (await cdp.pages())[0]
    main = await cdp.attach(page["targetId"])
    navigation = await cdp.send("Page.navigate", {"url": DESTINATION}, main)
    assert not navigation.get("errorText"), navigation
    deadline = time.monotonic() + 15
    while True:
        state = await cdp.send("Runtime.evaluate", {"expression": "document.readyState", "returnByValue": True}, main)
        if state["result"].get("value") == "complete":
            break
        assert time.monotonic() < deadline, "Fixture navigation did not complete"
        await asyncio.sleep(0.1)

    known = {target["targetId"] for target in await cdp.pages()}
    outcomes = []
    for opener in (False, True):
        started = time.monotonic()
        await cdp.send("Page.bringToFront", session=main)
        expression = """(() => {
            const form = document.createElement('form');
            form.method = 'POST'; form.action = 'https://example.com/'; form.target = '_blank';
            if (OPENER) form.rel = 'opener';
            const input = document.createElement('input'); input.name = 'u'; input.value = 'synthetic';
            const button = document.createElement('button'); button.textContent = 'Continue';
            form.append(input, button); document.body.replaceChildren(form);
            const r = button.getBoundingClientRect();
            return {x:r.x+r.width/2, y:r.y+r.height/2};
        })()""".replace("OPENER", "true" if opener else "false")
        result = await cdp.send("Runtime.evaluate", {"expression": expression, "returnByValue": True}, main)
        coordinates = result["result"]["value"]
        for event_type in ("mousePressed", "mouseReleased"):
            await cdp.send(
                "Input.dispatchMouseEvent",
                {"type": event_type, "button": "left", "clickCount": 1, **coordinates},
                main,
            )
        await asyncio.sleep(6)
        created = [target for target in await cdp.pages() if target["targetId"] not in known]
        known.update(target["targetId"] for target in created)
        responsive = False
        report("popup.observed", opener=opener, targets=created)
        if len(created) == 1:
            session = await cdp.attach(created[0]["targetId"])
            try:
                await cdp.send("Page.enable", session=session)
                frame_tree = await cdp.send("Page.getFrameTree", session=session)
                frame = frame_tree["frameTree"]["frame"]
                responsive = frame.get("url") == DESTINATION and bool(frame.get("loaderId"))
                report("popup.frame", opener=opener, frame=frame)
            except TimeoutError:
                report("popup.timeout", opener=opener, command_timeout_seconds=COMMAND_TIMEOUT)
        outcomes.append(responsive)
        report("popup.result", opener=opener, committed=responsive, wall_seconds=round(time.monotonic() - started, 2))
    return all(outcomes)


async def main() -> bool:
    load_dotenv(ROOT / "agents/.env", override=False)
    key = os.environ.get("STEEL_API_KEY")
    if not key:
        raise RuntimeError("STEEL_API_KEY is required in agents/.env or the process environment")
    api = os.environ.get("STEEL_BASE_URL", "https://api.steel.dev").rstrip("/")
    connect = os.environ.get("STEEL_CONNECT_URL", "wss://connect.steel.dev").rstrip("/")
    configuration = {
        "useProxy": {"geolocation": {"country": "US", "state": "CA"}},
        "solveCaptcha": True,
        "stealthConfig": {"humanizeInteractions": False, "skipFingerprintInjection": True},
        "timeout": 900000,
        "dimensions": {"width": 1288, "height": 891},
    }
    async with httpx.AsyncClient(timeout=30, headers={"steel-api-key": key}) as client:
        response = await client.post(f"{api}/v1/sessions", json=configuration)
        response.raise_for_status()
        session_id = response.json()["id"]
        report("session.created", session_id=session_id, configuration=configuration)
        try:
            url = f"{connect}?{urlencode({'sessionId': session_id, 'apiKey': key})}"
            async with websockets.connect(url, max_size=20 * 1024 * 1024) as socket:
                cdp = Cdp(socket)
                reader = asyncio.create_task(cdp.read())
                try:
                    return await compare_popups(cdp)
                finally:
                    reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
        finally:
            released = await client.post(f"{api}/v1/sessions/{session_id}/release")
            released.raise_for_status()
            status = await client.get(f"{api}/v1/sessions/{session_id}")
            status.raise_for_status()
            value = status.json().get("status")
            report("session.cleanup", session_id=session_id, status=value)
            assert value == "released", f"Owned Steel session {session_id} is not released: {value}"


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
