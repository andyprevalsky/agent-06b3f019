"""Steel screenshot-failure diagnostic.

Isolates WHY `page.screenshot(timeout=5000)` times out in Steel on the
toast page (the "Browser agent recording frame capture failed:
Page.screenshot: Timeout 5000ms exceeded ... waiting for fonts to load"
seen for agent 9ec05898 — recording.py:235).

For each tick it measures, side by side:
  - Playwright page.screenshot()      -> waits for document.fonts.ready
  - raw CDP Page.captureScreenshot    -> NO font/stability wait
  - CDP roundtrip (Runtime 1+1)       -> is the CDP channel itself slow?
  - document.fonts.status/size + how many font faces are still 'loading'
  - document.readyState

If raw-CDP succeeds fast while page.screenshot() times out, the fix is:
capture frames via CDP (or page.screenshot(animations=..., caret=...) won't
help — Playwright always awaits fonts). If raw-CDP is ALSO slow, the Steel
CDP channel / renderer is the bottleneck.

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_screenshot_diagnostic.py
  ... --proxy-mode none   --ticks 15
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time

import httpx
from playwright.async_api import async_playwright

STEEL_API = "https://api.steel.dev/v1/sessions"
DEFAULT_URL = "https://order.toasttab.com/online/nopafish"
SF_GEO = {"country": "US", "state": "CA"}  # city dropped (Steel 400s on SF) — matches prod fallback


def _key() -> str:
    k = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not k:
        raise SystemExit("STEEL_API_KEY / BROWSERBASE_API_KEY not set — source agents/.env")
    return k


async def _create(key: str, use_proxy, solve_captcha: bool) -> dict:
    body = {
        "useProxy": use_proxy,
        "solveCaptcha": solve_captcha,
        "stealthConfig": {"humanizeInteractions": False, "skipFingerprintInjection": True},
        "timeout": 900000,
        "dimensions": {"width": 1288, "height": 891},
    }
    async with httpx.AsyncClient(timeout=60.0) as c:
        r = await c.post(STEEL_API, headers={"steel-api-key": key, "Content-Type": "application/json"}, json=body)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"create {r.status_code}: {r.text[:300]}")
    return r.json()


async def _release(key: str, sid: str):
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            await c.post(f"{STEEL_API}/{sid}/release", headers={"steel-api-key": key})
    except Exception:
        pass


FONT_JS = """() => {
  let loading = 0, loaded = 0, total = 0;
  try { document.fonts.forEach(f => { total++; if (f.status === 'loading') loading++; else if (f.status === 'loaded') loaded++; }); } catch (e) {}
  return { status: document.fonts ? document.fonts.status : 'n/a', total, loading, loaded, readyState: document.readyState };
}"""


async def run(url: str, proxy_mode: str, solve_captcha: bool, ticks: int, local: bool):
    key = _key()
    if local:
        use_proxy = False
    elif proxy_mode == "none":
        use_proxy = False
    elif proxy_mode == "byop":
        server = os.environ.get("STEEL_PROXY_SERVER", "").strip()
        if not server:
            raise SystemExit("--proxy-mode byop requires STEEL_PROXY_SERVER env")
        use_proxy = {"server": server}
    else:
        use_proxy = {"geolocation": dict(SF_GEO)}  # SF/CA residential (prod fallback)

    print(f"\n=== Steel screenshot diagnostic ===")
    print(f"url={url}  mode={'LOCAL' if local else proxy_mode}  solveCaptcha={solve_captcha}  ticks={ticks}\n")

    sid = None
    async with async_playwright() as pw:
        if local:
            browser = await pw.chromium.launch(headless=True)
            print("LOCAL chromium launched")
        else:
            sess = await _create(key, use_proxy, solve_captcha)
            sid = sess["id"]
            print(f"steel session {sid} proxySource={sess.get('proxySource')}")
            ws = f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}"
            browser = await pw.chromium.connect_over_cdp(ws)

        try:
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            cdp = await ctx.new_cdp_session(page)

            t0 = time.monotonic()
            try:
                await page.goto(url, wait_until="commit", timeout=30000)
            except Exception as e:  # noqa: BLE001
                print(f"goto: {str(e)[:100]}")

            hdr = f"{'t':>6} {'pw_shot':>16} {'cdp_shot':>12} {'cdp_ping':>9} {'fonts':>22} {'readyState':>12}"
            print(hdr)
            print("-" * len(hdr))
            for _ in range(ticks):
                rel = time.monotonic() - t0

                # 1) Playwright screenshot (waits fonts.ready) — give it 8s so we see if it EVER returns
                ts = time.monotonic()
                try:
                    await page.screenshot(type="jpeg", quality=55, full_page=False, timeout=8000)
                    pw_shot = f"OK {(time.monotonic()-ts)*1000:6.0f}ms"
                except Exception as e:  # noqa: BLE001
                    msg = str(e).splitlines()[0][:11]
                    pw_shot = f"FAIL {(time.monotonic()-ts)*1000:5.0f}ms"

                # 2) raw CDP captureScreenshot (no font/stability wait)
                ts = time.monotonic()
                try:
                    await asyncio.wait_for(cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 55}), timeout=8)
                    cdp_shot = f"OK {(time.monotonic()-ts)*1000:5.0f}ms"
                except Exception:  # noqa: BLE001
                    cdp_shot = f"FAIL {(time.monotonic()-ts)*1000:4.0f}ms"

                # 3) CDP responsiveness ping
                ts = time.monotonic()
                try:
                    await asyncio.wait_for(cdp.send("Runtime.evaluate", {"expression": "1+1", "returnByValue": True}), timeout=8)
                    ping = f"{(time.monotonic()-ts)*1000:5.0f}ms"
                except Exception:
                    ping = "FAIL"

                # 4) font/readyState (via raw CDP eval to avoid Playwright waits)
                try:
                    res = await asyncio.wait_for(
                        cdp.send("Runtime.evaluate", {"expression": f"({FONT_JS})()", "returnByValue": True}), timeout=8
                    )
                    v = res.get("result", {}).get("value", {}) or {}
                    fonts = f"{v.get('status','?')} L{v.get('loading','?')}/{v.get('total','?')}"
                    rs = str(v.get("readyState", "?"))
                except Exception:
                    fonts, rs = "eval-fail", "?"

                print(f"{rel:6.1f} {pw_shot:>16} {cdp_shot:>12} {ping:>9} {fonts:>22} {rs:>12}")
                await asyncio.sleep(2.0)
        finally:
            if sid:
                await _release(key, sid)
                print(f"released {sid}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--proxy-mode", choices=["steel", "none", "byop"], default="steel")
    ap.add_argument("--no-solve-captcha", action="store_true")
    ap.add_argument("--ticks", type=int, default=15)
    ap.add_argument("--local", action="store_true")
    a = ap.parse_args()
    asyncio.run(run(a.url, a.proxy_mode, not a.no_solve_captcha, a.ticks, a.local))


if __name__ == "__main__":
    main()
