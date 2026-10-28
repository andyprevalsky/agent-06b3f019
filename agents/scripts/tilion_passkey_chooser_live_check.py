"""Live D4 check on Tilion: navigator.credentials.get with no matching credential, with and without the
worker's WebAuthn setup (WebAuthn.enable enableUI=false + virtual authenticator), conditional UI, CDP Escape,
and late arming. Run from agents/ with TILION_API_KEY set; D4_LATE_ONLY=1 runs only the unarmed case.
Creates one direct-egress session and deletes it. Results 2026-10-22: armed -> NotAllowedError in ~5 ms (no
chooser); unarmed -> pending past the 30 s timeout, not dismissed by CDP Escape or by arming late.
"""

import asyncio
import json
import os
import urllib.request
import urllib.error
import websockets

BASE = os.environ.get("TILION_BASE_URL", "https://back.tilion.dev").rstrip("/")


def rest(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['TILION_API_KEY']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300]


class Cdp:
    def __init__(self, ws):
        self.ws, self.n, self.pending = ws, 0, {}

    async def reader(self):
        async for raw in self.ws:
            m = json.loads(raw)
            f = self.pending.pop(m.get("id"), None)
            if f and not f.done():
                f.set_result(m)

    async def send(self, method, params=None, session=None, timeout=15):
        self.n += 1
        i = self.n
        f = asyncio.get_running_loop().create_future()
        self.pending[i] = f
        m = {"id": i, "method": method, "params": params or {}}
        if session:
            m["sessionId"] = session
        await self.ws.send(json.dumps(m))
        try:
            return await asyncio.wait_for(f, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(i, None)
            return None


START_GET = """(() => {
  window.__wa = {state: 'pending', t0: performance.now()};
  const opts = {publicKey: {challenge: new Uint8Array(32), rpId: location.hostname, allowCredentials: [],
                userVerification: 'preferred', timeout: 30000}};
  if (window.__conditional) opts.mediation = 'conditional';
  navigator.credentials.get(opts).then(
    c => { window.__wa = {state: 'resolved', ms: performance.now() - window.__wa.t0}; },
    e => { window.__wa = {state: 'rejected', name: e.name, msg: String(e.message).slice(0, 120), ms: performance.now() - window.__wa.t0}; });
  return true; })()"""


async def evaluate(a, sa, expression):
    r = await a.send(
        "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": False}, session=sa
    )
    return ((r or {}).get("result") or {}).get("result", {}).get("value")


async def target_types(a):
    r = await a.send("Target.getTargets")
    return sorted({(t["type"], t.get("url", "")[:60]) for t in (r or {}).get("result", {}).get("targetInfos", [])})


async def escape(a, sa):
    out = []
    for p in (
        {"type": "rawKeyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
        {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
    ):
        r = await a.send("Input.dispatchKeyEvent", p, session=sa)
        out.append("ok" if r else "no-response")
    return out


async def scenario(a, sa, name, *, webauthn, conditional=False):
    await a.send("Page.navigate", {"url": "https://example.com/?d4=" + name}, session=sa, timeout=40)
    await asyncio.sleep(2)
    if webauthn:
        enable = await a.send("WebAuthn.enable", {"enableUI": False}, session=sa)
        add = await a.send(
            "WebAuthn.addVirtualAuthenticator",
            {
                "options": {
                    "protocol": "ctap2",
                    "transport": "internal",
                    "hasResidentKey": True,
                    "hasUserVerification": True,
                    "isUserVerified": True,
                }
            },
            session=sa,
        )
        print(
            f"  {name}: WebAuthn.enable={'ok' if enable and 'error' not in enable else enable} addVirtualAuthenticator={'ok' if add and 'error' not in add else add}",
            flush=True,
        )
    if conditional:
        await evaluate(
            a,
            sa,
            "document.body.innerHTML = '<input id=u autocomplete=\"username webauthn\">'; window.__conditional = true; 1",
        )
    before = await target_types(a)
    await evaluate(a, sa, START_GET)
    await asyncio.sleep(4)
    after = await target_types(a)
    state4 = await evaluate(a, sa, "window.__wa")
    print(f"  {name}: after 4 s get() = {state4}; new targets = {[t for t in after if t not in before]}", flush=True)
    if conditional:
        await a.send(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": 20, "y": 12, "button": "left", "clickCount": 1},
            session=sa,
        )
        await a.send(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": 20, "y": 12, "button": "left", "clickCount": 1},
            session=sa,
        )
        await asyncio.sleep(2)
        print(
            f"  {name}: after focusing the webauthn field = {await evaluate(a, sa, 'window.__wa')}; new targets = {[t for t in await target_types(a) if t not in before]}",
            flush=True,
        )
    if (state4 or {}).get("state") == "pending":
        esc = await escape(a, sa)
        await asyncio.sleep(2)
        print(f"  {name}: CDP Escape (serial) {esc} -> {await evaluate(a, sa, 'window.__wa')}", flush=True)
        probe = await a.send("Runtime.evaluate", {"expression": "1+1", "returnByValue": True}, session=sa, timeout=5)
        print(f"  {name}: page still responsive: {bool(probe)}", flush=True)
        if not webauthn:
            # Late arm: does the worker's WebAuthn setup close an already-open chooser?
            enable = await a.send("WebAuthn.enable", {"enableUI": False}, session=sa)
            await asyncio.sleep(2)
            print(
                f"  {name}: after late WebAuthn.enable={'ok' if enable and 'error' not in enable else enable} -> {await evaluate(a, sa, 'window.__wa')}",
                flush=True,
            )
            add = await a.send(
                "WebAuthn.addVirtualAuthenticator",
                {
                    "options": {
                        "protocol": "ctap2",
                        "transport": "internal",
                        "hasResidentKey": True,
                        "hasUserVerification": True,
                        "isUserVerified": True,
                    }
                },
                session=sa,
            )
            await asyncio.sleep(2)
            print(
                f"  {name}: after late addVirtualAuthenticator={'ok' if add and 'error' not in add else add} -> {await evaluate(a, sa, 'window.__wa')}",
                flush=True,
            )
            await asyncio.sleep(25)
            print(f"  {name}: after the 30 s WebAuthn timeout -> {await evaluate(a, sa, 'window.__wa')}", flush=True)


async def main():
    status, s = rest(
        "POST", "/v1/session", {"ttl": 600, "idle_timeout": 120, "residential": False, "cdp_observe": False}
    )
    sid = s["session_id"]
    print("session", sid, "(direct egress)", flush=True)
    try:
        ws = await websockets.connect(s["connect_url"], max_size=None, proxy=None)
        a = Cdp(ws)
        asyncio.create_task(a.reader())
        r = await a.send("Target.getTargets")
        page = next(t for t in r["result"]["targetInfos"] if t["type"] == "page")
        r = await a.send("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
        sa = r["result"]["sessionId"]
        await a.send("Page.enable", session=sa)
        for name, kwargs in (
            (("no-authenticator", {"webauthn": False}),)
            if os.environ.get("D4_LATE_ONLY")
            else (
                ("no-authenticator", {"webauthn": False}),
                ("worker-webauthn", {"webauthn": True}),
                ("worker-webauthn-conditional", {"webauthn": True, "conditional": True}),
            )
        ):
            await scenario(a, sa, name, **kwargs)
        await ws.close()
    finally:
        print("delete", sid, rest("DELETE", f"/v1/session/{sid}")[0], flush=True)


asyncio.run(main())
