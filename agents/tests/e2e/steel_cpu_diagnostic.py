"""Steel CPU-bottleneck diagnostic.

Tests the hypothesis: the ~90s freeze during the toast bot-challenge is the
renderer main thread being CPU-pinned (so a faster CPU would clear it
faster), vs. something else (CDP transport stall / target detach).

Each tick pings TWO independent CDP layers:
  - RENDERER (page target): Runtime.evaluate("1+1")  -> blocks if the page's
    main thread is pinned by challenge JS.
  - BROWSER process: Browser.getVersion + SystemInfo.getProcessInfo +
    Target.getTargets -> run in the browser process, NOT the renderer, so
    they stay responsive even when the renderer is 100% busy. getProcessInfo
    gives cumulative cpuTime per process; we delta it to get CPU% per tick.

Decision:
  - renderer FROZEN + browser RESPONSIVE + renderer-process CPU ~= 100%/core
      => CPU-bound renderer. A faster CPU should reduce the freeze.  ✅ hypothesis
  - browser ALSO frozen, or renderer CPU ~0 during freeze
      => NOT page CPU (transport/infra/detach). Faster CPU won't help.

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_cpu_diagnostic.py --budget 160
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


def _key():
    k = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not k:
        raise SystemExit("STEEL_API_KEY / BROWSERBASE_API_KEY not set")
    return k


async def _create(key, solve_captcha):
    body = {
        "useProxy": False,
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


async def run(url, budget, solve_captcha):
    key = _key()
    print(f"\n=== Steel CPU diagnostic ===\nurl={url}  solveCaptcha={solve_captcha}  budget={budget}s\n")
    sess = await _create(key, solve_captcha)
    sid = sess["id"]
    print(f"steel session {sid}")
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
        try:
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            page_cdp = await ctx.new_cdp_session(page)          # renderer (page target)
            brow_cdp = await browser.new_browser_cdp_session()  # browser process

            # SystemInfo can report CPU per process (browser-process call)
            sysinfo_ok = True
            try:
                await brow_cdp.send("SystemInfo.getInfo")
            except Exception:
                sysinfo_ok = False

            t0 = time.monotonic()
            try:
                await page.goto(url, wait_until="commit", timeout=30000)
            except Exception as e:  # noqa: BLE001
                print(f"goto: {str(e)[:80]}")

            prev_cpu = {}   # pid -> cpuTime
            prev_t = time.monotonic()

            hdr = f"{'t':>6} {'renderer':>10} {'browser':>10} {'tgts':>5} {'rendCPU%':>9} {'page (from browser proc)':>32}"
            print(hdr)
            print("-" * len(hdr))
            deadline = t0 + budget
            while time.monotonic() < deadline:
                rel = time.monotonic() - t0

                # RENDERER ping
                ts = time.monotonic()
                try:
                    await asyncio.wait_for(page_cdp.send("Runtime.evaluate", {"expression": "1+1", "returnByValue": True}), timeout=5)
                    rend = f"{(time.monotonic()-ts)*1000:5.0f}ms"
                except Exception:
                    rend = "FROZEN"

                # BROWSER-process ping
                ts = time.monotonic()
                try:
                    await asyncio.wait_for(brow_cdp.send("Browser.getVersion"), timeout=5)
                    brow = f"{(time.monotonic()-ts)*1000:5.0f}ms"
                except Exception:
                    brow = "FROZEN"

                # targets + current page url/title (browser process — works while renderer frozen)
                page_desc = "?"
                ntgts = "?"
                try:
                    tg = await asyncio.wait_for(brow_cdp.send("Target.getTargets"), timeout=5)
                    infos = tg.get("targetInfos", [])
                    pages = [i for i in infos if i.get("type") == "page"]
                    ntgts = str(len(pages))
                    if pages:
                        p = pages[0]
                        title = (p.get("title") or "")[:18]
                        host = (p.get("url") or "").split("/")[2] if "://" in (p.get("url") or "") else (p.get("url") or "")[:20]
                        page_desc = f"{title} | {host}"[:31]
                except Exception:
                    page_desc = "tgt-FROZEN"

                # CPU per process delta (browser-process call)
                rend_cpu = "?"
                if sysinfo_ok:
                    try:
                        pi = await asyncio.wait_for(brow_cdp.send("SystemInfo.getProcessInfo"), timeout=5)
                        now = time.monotonic()
                        dt = now - prev_t
                        procs = pi.get("processInfo", [])
                        # find max renderer cpu delta
                        best = 0.0
                        for pr in procs:
                            pid = pr.get("id")
                            ct = pr.get("cpuTime", 0.0)
                            if pid in prev_cpu and dt > 0:
                                pct = (ct - prev_cpu[pid]) / dt * 100.0
                                if pct > best:
                                    best = pct
                            prev_cpu[pid] = ct
                        prev_t = now
                        rend_cpu = f"{best:6.0f}%"
                    except Exception:
                        rend_cpu = "na"

                print(f"{rel:6.1f} {rend:>10} {brow:>10} {ntgts:>5} {rend_cpu:>9} {page_desc:>32}")
                await asyncio.sleep(3.0)
        finally:
            await _release(key, sid)
            print(f"released {sid}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--budget", type=float, default=160.0)
    ap.add_argument("--no-solve-captcha", action="store_true")
    a = ap.parse_args()
    asyncio.run(run(a.url, a.budget, not a.no_solve_captcha))


if __name__ == "__main__":
    main()
