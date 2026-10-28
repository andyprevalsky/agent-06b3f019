"""Live Tilion probe: pipelined vs sequential CDP Input.dispatchKeyEvent.

Tilion's CDP gateway answers keyboard events sent one at a time, but drops a
key event sent while another is still in flight: no response, and the
keystroke never reaches the page (RCA 2026-10-21, browser-biometrics-webdecoy
and browser-auth-* input_text timeouts). Every variant uses a fresh session on
example.com with a plain ``autocomplete=off`` input, so a dropped command
cannot poison the next variant. Every session is deleted.

Run from ``agents/`` with the venv active and TILION_API_KEY in the
environment (``set -a; . .env; set +a``):

    python scripts/tilion_cdp_input_probe.py            # all variants
    python scripts/tilion_cdp_input_probe.py sequential pipelined

Costs ~3 credits per variant. Exit status 1 when a sequential variant loses a
key (that would be a new Tilion regression); pipelined losses are reported.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import websockets

BASE_URL = os.environ.get("TILION_BASE_URL", "https://back.tilion.dev").rstrip("/")
INPUT_HTML = (
    '<input id=f type=text autocomplete=off style="position:fixed;top:200px;left:200px;width:300px;height:30px">'
)
TEXT = "abcdef"


def _typed(text: str) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for char in text:
        events += [
            {"type": "keyDown", "key": char},
            {"type": "char", "key": char, "text": char, "unmodifiedText": char},
            {"type": "keyUp", "key": char},
        ]
    return events


# name -> (send pipelined?, gap between sends in seconds)
VARIANTS: Dict[str, Tuple[bool, float]] = {
    "sequential": (False, 0.0),
    "pipelined": (True, 0.06),
    "pipelined-nogap": (True, 0.0),
}


def _rest(method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Tuple[int, Any]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['TILION_API_KEY']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, None


class _Cdp:
    def __init__(self, websocket: Any) -> None:
        self.websocket = websocket
        self.next_id = 0
        self.pending: Dict[int, asyncio.Future] = {}

    async def read(self) -> None:
        async for raw in self.websocket:
            message = json.loads(raw)
            future = self.pending.pop(message.get("id"), None)
            if future is not None and not future.done():
                future.set_result(message)

    async def send(self, method: str, params: Dict[str, Any], session: Optional[str] = None, timeout: float = 10.0):
        self.next_id += 1
        message_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[message_id] = future
        message: Dict[str, Any] = {"id": message_id, "method": method, "params": params}
        if session:
            message["sessionId"] = session
        await self.websocket.send(json.dumps(message))
        try:
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(message_id, None)
            return None


async def _run_variant(name: str) -> Dict[str, Any]:
    pipelined, gap = VARIANTS[name]
    status, created = _rest(
        "POST",
        "/v1/session",
        {"ttl": 300, "idle_timeout": 60, "residential": True, "proxy_type": "residential", "geo": {"country": "us"}},
    )
    if status != 201 or not created:
        raise RuntimeError(f"Tilion create failed with HTTP {status}")
    session_id = created["session_id"]
    started_utc = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    print(f"[{name}] session {session_id} at {started_utc}", flush=True)
    try:
        async with websockets.connect(created["connect_url"], max_size=None, proxy=None) as websocket:
            cdp = _Cdp(websocket)
            reader = asyncio.create_task(cdp.read())
            targets = await cdp.send("Target.getTargets", {})
            page = next(t for t in targets["result"]["targetInfos"] if t["type"] == "page")
            attached = await cdp.send("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
            page_session = attached["result"]["sessionId"]
            await cdp.send("Page.navigate", {"url": "https://example.com/"}, page_session, timeout=30)
            await asyncio.sleep(1.5)
            await cdp.send(
                "Runtime.evaluate",
                {
                    "expression": f"document.body.innerHTML = {json.dumps(INPUT_HTML)}; document.getElementById('f').focus(); 1"
                },
                page_session,
            )
            events = _typed(TEXT)
            if pipelined:
                tasks = []
                for event in events:
                    tasks.append(asyncio.create_task(cdp.send("Input.dispatchKeyEvent", event, page_session)))
                    if gap:
                        await asyncio.sleep(gap)
                answers = await asyncio.gather(*tasks)
            else:
                answers = [await cdp.send("Input.dispatchKeyEvent", event, page_session) for event in events]
            value = await cdp.send(
                "Runtime.evaluate",
                {"expression": "document.getElementById('f').value", "returnByValue": True},
                page_session,
            )
            reader.cancel()
            result = {
                "variant": name,
                "session_id": session_id,
                "started_utc": started_utc,
                "sent": len(events),
                "unanswered": sum(answer is None for answer in answers),
                "value": ((value or {}).get("result") or {}).get("result", {}).get("value"),
            }
    finally:
        print(f"[{name}] delete {session_id}: HTTP {_rest('DELETE', f'/v1/session/{session_id}')[0]}", flush=True)
    result["delivered_all"] = result["value"] == TEXT
    print(json.dumps(result), flush=True)
    return result


async def _main(names: List[str]) -> int:
    results = [await _run_variant(name) for name in names]
    sequential_broken = [r for r in results if r["variant"] == "sequential" and not r["delivered_all"]]
    return 1 if sequential_broken else 0


if __name__ == "__main__":
    selected = sys.argv[1:] or list(VARIANTS)
    unknown = [name for name in selected if name not in VARIANTS]
    if unknown:
        raise SystemExit(f"unknown variant(s) {unknown}; expected {list(VARIANTS)}")
    raise SystemExit(asyncio.run(_main(selected)))
