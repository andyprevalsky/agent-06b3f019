"""Steel page-load investigation.

Answers two questions about the ~95s dead-air stall on the toast page:
  (1) Does it EVENTUALLY resolve into a usable page (menu rendered)?
  (2) Is it just "Steel servers are slow", or is it specifically the
      bot-challenge resources hanging while everything else is fast?

Uses the browser's own Resource Timing API (performance.getEntriesByType
('resource')) — the ground-truth per-resource timing from inside the page,
not my external CDP listener. A resource with responseEnd==0 never
completed; duration is the browser's own measured wall time.

Keeps CDP responsive by defaulting solveCaptcha OFF (the solver freezes
CDP — proven separately) so we can query the page throughout the stall.

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_pageload_investigation.py
  ... --proxy-mode none --budget 200
  ... --url https://en.wikipedia.org/wiki/San_Francisco   # control site
  ... --local                                             # local-Chromium control
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
SF_GEO = {"country": "US", "state": "CA"}
DEFAULT_KW = ["Rocky", "Sandwich", "Albacore", "Shrimp", "Add to", "$"]


def _key() -> str:
    k = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not k:
        raise SystemExit("STEEL_API_KEY / BROWSERBASE_API_KEY not set — source agents/.env")
    return k


async def _create(key, use_proxy, solve_captcha):
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


async def _release(key, sid):
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            await c.post(f"{STEEL_API}/{sid}/release", headers={"steel-api-key": key})
    except Exception:
        pass


RES_JS = """() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource').map(r => ({
    name: r.name, start: Math.round(r.startTime), end: Math.round(r.responseEnd),
    dur: Math.round(r.duration), size: r.transferSize || 0, proto: r.nextHopProtocol || '', it: r.initiatorType
  }));
  return { dcl: Math.round(nav.domContentLoadedEventEnd||0), load: Math.round(nav.loadEventEnd||0), count: res.length, res };
}"""


def _content_js(kw):
    arr = ",".join([f'"{k}"' for k in kw])
    return f"""() => {{
  const txt = document.body ? (document.body.innerText||'') : '';
  const kw = [{arr}];
  const found = {{}}; kw.forEach(k => found[k] = txt.includes(k));
  return {{ title: document.title, bodyLen: txt.length,
           buttons: document.querySelectorAll('button').length,
           links: document.querySelectorAll('a').length, found }};
}}"""


def _host(u):
    try:
        return u.split("/")[2]
    except Exception:
        return u[:40]


async def run(url, proxy_mode, solve_captcha, budget, local, kw):
    key = _key()
    if local or proxy_mode == "none":
        use_proxy = False
    elif proxy_mode == "byop":
        use_proxy = {"server": os.environ["STEEL_PROXY_SERVER"]}
    else:
        use_proxy = {"geolocation": dict(SF_GEO)}

    print(f"\n=== Steel page-load investigation ===")
    print(f"url={url}  mode={'LOCAL' if local else proxy_mode}  solveCaptcha={solve_captcha}  budget={budget}s\n")

    sid = None
    async with async_playwright() as pw:
        if local:
            browser = await pw.chromium.launch(headless=True)
        else:
            sess = await _create(key, use_proxy, solve_captcha)
            sid = sess["id"]
            print(f"steel session {sid} proxySource={sess.get('proxySource')}")
            browser = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")

        try:
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            cdp = await ctx.new_cdp_session(page)

            t0 = time.monotonic()
            idle_at = None

            async def reach_idle():
                nonlocal idle_at
                try:
                    await page.wait_for_load_state("networkidle", timeout=int(budget * 1000))
                    idle_at = time.monotonic() - t0
                except Exception:
                    pass

            try:
                await page.goto(url, wait_until="commit", timeout=30000)
            except Exception as e:  # noqa: BLE001
                print(f"goto: {str(e)[:90]}")
            idle_task = asyncio.create_task(reach_idle())

            # lightweight liveness loop
            print(f"{'t':>6} {'cdp_ping':>9} {'readyState':>12} {'idle?':>8}")
            print("-" * 40)
            deadline = t0 + budget
            while time.monotonic() < deadline:
                rel = time.monotonic() - t0
                ts = time.monotonic()
                rs = "?"
                try:
                    r = await asyncio.wait_for(cdp.send("Runtime.evaluate", {"expression": "document.readyState", "returnByValue": True}), timeout=6)
                    rs = r.get("result", {}).get("value", "?")
                    ping = f"{(time.monotonic()-ts)*1000:5.0f}ms"
                except Exception:
                    ping = "FAIL"
                print(f"{rel:6.1f} {ping:>9} {rs:>12} {('YES @'+format(idle_at,'.0f')) if idle_at else 'no':>8}")
                if idle_at:
                    break
                await asyncio.sleep(4.0)
            idle_task.cancel()

            # ---- resource timing (browser ground truth) ----
            print("\n--- RESOURCE TIMING (browser Performance API) ---")
            try:
                rt = await asyncio.wait_for(cdp.send("Runtime.evaluate", {"expression": f"({RES_JS})()", "returnByValue": True}), timeout=10)
                v = rt.get("result", {}).get("value", {}) or {}
                res = v.get("res", [])
                pending = [r for r in res if not r.get("end")]
                slow = sorted([r for r in res if r.get("end")], key=lambda r: -r["dur"])[:8]
                print(f"navigation: domContentLoaded={v.get('dcl')}ms  load={v.get('load')}ms  resources={v.get('count')}")
                print(f"\nPENDING / never completed ({len(pending)}):")
                for r in pending:
                    print(f"  start={r['start']:>6}ms  [{_host(r['name'])}]  {r['it']}  {r['name'][:75]}")
                print(f"\nSLOWEST COMPLETED:")
                for r in slow:
                    print(f"  dur={r['dur']:>6}ms  start={r['start']:>6}ms  end={r['end']:>6}ms  [{_host(r['name'])}]  {r['name'][:60]}")
                # Steel-slow test: median/p90 duration of COMPLETED resources
                durs = sorted([r["dur"] for r in res if r.get("end")])
                if durs:
                    med = durs[len(durs) // 2]
                    p90 = durs[int(len(durs) * 0.9)]
                    print(f"\ncompleted-resource latency: median={med}ms  p90={p90}ms  (high across-the-board ⇒ Steel slow; low ⇒ only challenge hangs)")
            except Exception as e:  # noqa: BLE001
                print(f"resource-timing eval failed: {str(e)[:80]}")

            # ---- usability check ----
            print("\n--- PAGE USABILITY ---")
            try:
                c = await asyncio.wait_for(cdp.send("Runtime.evaluate", {"expression": f"({_content_js(kw)})()", "returnByValue": True}), timeout=10)
                cv = c.get("result", {}).get("value", {}) or {}
                print(f"title   : {cv.get('title')}")
                print(f"bodyLen : {cv.get('bodyLen')}   buttons={cv.get('buttons')}  links={cv.get('links')}")
                print(f"keywords: {cv.get('found')}")
                usable = (cv.get("bodyLen", 0) > 500) and any(cv.get("found", {}).values())
                print(f"\nVERDICT: {'PAGE USABLE (content rendered)' if usable else 'NOT USABLE (no menu content)'}"
                      f"   networkidle={'@%.0fs' % idle_at if idle_at else 'NEVER'}")
            except Exception as e:  # noqa: BLE001
                print(f"content eval failed: {str(e)[:80]}")
        finally:
            if sid:
                await _release(key, sid)
                print(f"released {sid}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--proxy-mode", choices=["steel", "none", "byop"], default="none")
    ap.add_argument("--no-solve-captcha", action="store_true", default=False)
    ap.add_argument("--solve-captcha", action="store_true", help="enable solver (default OFF to keep CDP responsive)")
    ap.add_argument("--budget", type=float, default=200.0)
    ap.add_argument("--local", action="store_true")
    a = ap.parse_args()
    asyncio.run(run(a.url, a.proxy_mode, a.solve_captcha, a.budget, a.local, DEFAULT_KW))


if __name__ == "__main__":
    main()
