"""Live I3 check on Tilion through the worker path: CDP mux (per-target WebAuthn arming) +
DOMService.inject_passkeys + Playwright. Asserts two real WebAuthn assertions resolve with an advancing
signCount that DOMService reads back, and that a popup the worker never armed rejects instead of hanging.

Run from agents/ with TILION_API_KEY set: python scripts/tilion_passkey_assertion_live_check.py
One direct-egress session, deleted. 2026-10-22 on feat/tilion-b-rotation 335ac9c28 and f7fd03a5a: 5/5 PASS.
"""

import asyncio
import base64
import json
import os
import time
import urllib.request
import urllib.error
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from playwright.async_api import async_playwright
from browser_tools.dom_service import DOMService
from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection
from domains.spawn_browser_agent_v3.tilion_worker import tilion_emulation

BASE = os.environ.get("TILION_BASE_URL", "https://back.tilion.dev").rstrip("/")
CRED_ID = base64.b64encode(b"rose-i3-credential-0001").decode()

GET = """async (credId) => {
  const raw = Uint8Array.from(atob(credId), c => c.charCodeAt(0));
  const t0 = performance.now();
  try {
    const cred = await navigator.credentials.get({publicKey: {challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname, allowCredentials: [{type: 'public-key', id: raw}], userVerification: 'preferred', timeout: 20000}});
    const ad = new Uint8Array(cred.response.authenticatorData);
    const count = (ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36];
    return {ok: true, signCount: count >>> 0, flags: ad[32], ms: Math.round(performance.now() - t0), id: cred.id};
  } catch (e) { return {ok: false, name: e.name, msg: String(e.message).slice(0, 100), ms: Math.round(performance.now() - t0)}; }
}"""

UNARMED_GET = """async () => {
  const t0 = performance.now();
  try {
    await navigator.credentials.get({publicKey: {challenge: new Uint8Array(32), rpId: location.hostname,
      allowCredentials: [{type: 'public-key', id: new Uint8Array([9, 9, 9, 9])}], timeout: 20000}});
    return {state: 'resolved', ms: Math.round(performance.now() - t0)};
  } catch (e) { return {state: 'rejected', name: e.name, ms: Math.round(performance.now() - t0)}; }
}"""


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
        return e.code, e.read()[:200]


results = []


def check(name, ok, detail):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)


async def main():
    status, s = rest(
        "POST", "/v1/session", {"ttl": 600, "idle_timeout": 120, "residential": False, "cdp_observe": False}
    )
    sid = s["session_id"]
    print("session", sid, flush=True)
    try:
        url, mux = await open_browser_cdp_connection(
            s["connect_url"],
            label="a1-i3",
            emulation=tilion_emulation({"timezone": "America/Los_Angeles", "locale": "en-US"}, None),
        )
        dom = DOMService(cdp_url=url, cdp_multiplexer=mux)
        await dom.connect()
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(url, timeout=60000)
            page = browser.contexts[0].pages[0]
            await page.goto("https://example.com/", wait_until="domcontentloaded")
            await asyncio.sleep(1)
            key = ec.generate_private_key(ec.SECP256R1())
            pkcs8 = key.private_bytes(
                serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            )
            seeded = await dom.inject_passkeys(
                [
                    {
                        "credentialId": CRED_ID,
                        "privateKey": base64.b64encode(pkcs8).decode(),
                        "rpId": "example.com",
                        "userHandle": base64.b64encode(b"rose-i3-user").decode(),
                        "signCount": 5,
                    }
                ]
            )
            print(f"  inject_passkeys seeded={seeded}", flush=True)
            first = await page.evaluate(GET, CRED_ID)
            check("first assertion resolves", bool(first.get("ok")), first)
            second = await page.evaluate(GET, CRED_ID)
            check("second assertion resolves", bool(second.get("ok")), second)
            if first.get("ok") and second.get("ok"):
                check(
                    "signCount advances",
                    second["signCount"] > first["signCount"] >= 5,
                    (first["signCount"], second["signCount"]),
                )
            counts = await dom.read_passkey_signcounts()
            check(
                "DOMService reads the advanced signCount",
                counts.get(CRED_ID, 0) >= (second.get("signCount") or 0) > 0,
                counts,
            )
            # A popup the worker never armed: the mux's per-target arming must make it reject, not hang.
            async with page.expect_popup(timeout=30000) as info:
                await page.evaluate("window.open('https://example.com/?unarmed=1', '_blank')")
            popup = await info.value
            await popup.wait_for_load_state("domcontentloaded")
            t0 = time.monotonic()
            try:
                unarmed = await asyncio.wait_for(popup.evaluate(UNARMED_GET), timeout=25)
            except asyncio.TimeoutError:
                unarmed = {"state": "pending", "ms": round((time.monotonic() - t0) * 1000)}
            check(
                "unarmed popup rejects instead of hanging",
                unarmed.get("state") == "rejected" and unarmed.get("ms", 99999) < 5000,
                unarmed,
            )
            await browser.close()
        await dom.disconnect()
    finally:
        print("delete", sid, rest("DELETE", f"/v1/session/{sid}")[0], flush=True)
    print(f"SUMMARY pass={sum(results)} fail={len(results) - sum(results)}", flush=True)


asyncio.run(main())
