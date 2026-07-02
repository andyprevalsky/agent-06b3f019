"""Steel browser connection / page-load probe.

Reproduces the "page never finishes loading" stall seen on agent
9ec05898 (order.toasttab.com/online/nopafish) using the SAME Steel +
proxy path production uses:

  - Steel session created with prod config: residential proxy
    (geolocation US/TX/DALLAS by default), solveCaptcha, the prod
    stealthConfig + dimensions + 15m timeout.
  - Connected via Playwright connect_over_cdp(wss://connect.steel.dev...),
    exactly like agents/domains/spawn_browser_agent_v3/handler.py.

Measures what actually matters for the stall:
  - session-create + CDP-connect latency
  - navigation: commit / domcontentloaded / load
  - whether the page EVER reaches networkidle (it doesn't, in the bug)
  - longest "dead air" gap between network events (the ~2min stall)
  - requests that never get a response (hung XHR/fetch)
  - screenshot success vs 5s timeout (mirrors prod recording capture)
  - CDP disconnects

Proxy is the variable under test — toggle with --proxy-mode so we can
compare Steel-managed vs no-proxy vs BYOP residential.

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_connection_probe.py
  ... --proxy-mode none
  ... --url https://example.com --budget 60
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
# Mirrors back-end/src/providers/geoip.ts DEFAULT_GEOLOCATION
DEFAULT_GEO = {"country": "US", "state": "TX", "city": "DALLAS"}


def _steel_key() -> str:
    key = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not key:
        raise SystemExit("STEEL_API_KEY (or BROWSERBASE_API_KEY) not set — `source agents/.env` first")
    return key


def _build_use_proxy(mode: str, geo: dict) -> object:
    """Mirror back-end/src/providers/steel/session.ts buildSteelProxySettings."""
    if mode == "none":
        return False
    if mode == "byop":
        server = os.environ.get("STEEL_PROXY_SERVER", "").strip()
        if not server:
            raise SystemExit("--proxy-mode byop requires STEEL_PROXY_SERVER env")
        return {"server": server}
    # steel managed residential (prod default)
    g = {"country": geo["country"]}
    if geo["country"] == "US" and geo.get("state"):
        g["state"] = geo["state"]
    if geo.get("city"):
        g["city"] = geo["city"]
    return {"geolocation": g}


async def create_session(key: str, use_proxy: object, drop_city: bool, solve_captcha: bool = True) -> dict:
    """Create a Steel session with the same shape as prod session.ts."""
    if drop_city and isinstance(use_proxy, dict) and "geolocation" in use_proxy:
        use_proxy = {"geolocation": {k: v for k, v in use_proxy["geolocation"].items() if k != "city"}}
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
        raise RuntimeError(f"Steel create failed HTTP {r.status_code}: {r.text[:400]}")
    return r.json()


async def release_session(key: str, sid: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            await c.post(f"{STEEL_API}/{sid}/release", headers={"steel-api-key": key})
    except Exception as e:  # noqa: BLE001
        print(f"  (release failed: {e})")


async def probe(url: str, proxy_mode: str, geo: dict, budget_s: float, drop_city: bool, solve_captcha: bool = True, local: bool = False) -> None:
    key = _steel_key()
    use_proxy = _build_use_proxy(proxy_mode, geo)
    print(f"\n=== Steel connection probe ===")
    print(f"url        : {url}")
    print(f"proxy_mode : {proxy_mode}  useProxy={use_proxy}")
    print(f"solveCaptcha: {solve_captcha}")
    print(f"budget     : {budget_s}s\n")

    t0 = time.monotonic()
    sid = None
    ws_url = None
    t_create = 0.0
    if not local:
        # Mirror prod session.ts retry loop: Steel 400s on unsupported cities
        # (e.g. SAN FRANCISCO) — on "Invalid proxy configuration" drop the city
        # and retry with country+state only.
        try:
            sess = await create_session(key, use_proxy, drop_city, solve_captcha)
        except RuntimeError as e:
            if "400" in str(e) and isinstance(use_proxy, dict) and "geolocation" in use_proxy and not drop_city:
                print(f"  Steel 400 on city — dropping city, retrying with country+state (matches prod)")
                sess = await create_session(key, use_proxy, drop_city=True, solve_captcha=solve_captcha)
            else:
                raise
        sid = sess["id"]
        t_create = time.monotonic() - t0
        print(f"[{t_create:6.2f}s] session created: {sid}  proxySource={sess.get('proxySource')}")
        ws_url = f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}"
    else:
        print(f"[  0.00s] LOCAL CONTROL: launching normal Chromium (no Steel, no proxy)")

    # network bookkeeping
    nav_start = None
    last_event = None  # monotonic of last network activity
    max_gap = 0.0
    max_gap_window = (0.0, 0.0)
    inflight: dict = {}            # url -> start offset (no response yet)
    completed = 0
    failed = 0
    cdp_disconnected = {"v": False}

    def rel() -> float:
        return (time.monotonic() - nav_start) if nav_start else 0.0

    def mark_event(kind: str, u: str):
        nonlocal last_event, max_gap, max_gap_window
        now = time.monotonic()
        if last_event is not None:
            gap = now - last_event
            if gap > max_gap:
                max_gap = gap
                max_gap_window = (last_event - nav_start, now - nav_start)
        last_event = now

    try:
        async with async_playwright() as pw:
            tc = time.monotonic()
            if local:
                browser = await pw.chromium.launch(headless=True)
            else:
                browser = await pw.chromium.connect_over_cdp(ws_url)
            t_cdp = time.monotonic() - tc
            print(f"[{time.monotonic()-t0:6.2f}s] browser ready ({t_cdp:.2f}s)")
            browser.on("disconnected", lambda *_: cdp_disconnected.__setitem__("v", True))

            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            def on_request(req):
                inflight[req.url] = rel()
                mark_event("req", req.url)

            def on_response(resp):
                nonlocal completed
                inflight.pop(resp.url, None)
                completed += 1
                mark_event("resp", resp.url)

            def on_failed(req):
                nonlocal failed
                inflight.pop(req.url, None)
                failed += 1
                mark_event("fail", req.url)

            page.on("request", on_request)
            page.on("response", on_response)
            page.on("requestfailed", on_failed)

            # ---- navigation ----
            nav_start = time.monotonic()
            last_event = nav_start
            events = {"commit": None, "domcontentloaded": None, "load": None, "networkidle": None}

            async def wait_state(state):
                try:
                    await page.wait_for_load_state(state, timeout=int(budget_s * 1000))
                    if events[state] is None:
                        events[state] = rel()
                except Exception:
                    pass

            try:
                await page.goto(url, wait_until="commit", timeout=30000)
                events["commit"] = rel()
            except Exception as e:  # noqa: BLE001
                print(f"  goto(commit) error after {rel():.1f}s: {str(e)[:120]}")

            idle_task = asyncio.create_task(wait_state("networkidle"))
            dcl_task = asyncio.create_task(wait_state("domcontentloaded"))
            load_task = asyncio.create_task(wait_state("load"))

            # ---- periodic screenshot probe (mirrors prod 5s recording capture) ----
            shot_ok = shot_fail = 0
            deadline = nav_start + budget_s
            while time.monotonic() < deadline and not cdp_disconnected["v"]:
                try:
                    await page.screenshot(timeout=5000)
                    shot_ok += 1
                except Exception:
                    shot_fail += 1
                if events["networkidle"] is not None:
                    break
                await asyncio.sleep(2.0)

            for tsk in (idle_task, dcl_task, load_task):
                tsk.cancel()

            # ---- report ----
            print("\n--- RESULTS ---")
            print(f"session create     : {t_create:.2f}s")
            print(f"CDP connect        : {t_cdp:.2f}s")
            def fmt(x):
                return f"{x:.2f}s" if x is not None else "NEVER"
            print(f"commit             : {fmt(events['commit'])}")
            print(f"domcontentloaded   : {fmt(events['domcontentloaded'])}")
            print(f"load               : {fmt(events['load'])}")
            print(f"networkidle        : {fmt(events['networkidle'])}  <-- the bug signal")
            print(f"requests completed : {completed}")
            print(f"requests failed    : {failed}")
            print(f"requests STILL in-flight (never responded): {len(inflight)}")
            for u, off in list(inflight.items())[:12]:
                print(f"    [{off:6.1f}s start, no response] {u[:90]}")
            print(f"longest dead-air gap: {max_gap:.1f}s  (window {max_gap_window[0]:.1f}s..{max_gap_window[1]:.1f}s)")
            print(f"screenshots ok/fail: {shot_ok}/{shot_fail}")
            print(f"CDP disconnected   : {cdp_disconnected['v']}")

            verdict = "FINISHED (networkidle reached)" if events["networkidle"] is not None else "NEVER FINISHED LOADING"
            print(f"\nVERDICT: {verdict}")
    finally:
        if sid:
            await release_session(key, sid)
            print(f"session released: {sid}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--proxy-mode", choices=["steel", "none", "byop"], default="steel")
    ap.add_argument("--budget", type=float, default=180.0, help="seconds to observe load")
    ap.add_argument("--country", default=DEFAULT_GEO["country"])
    ap.add_argument("--state", default=DEFAULT_GEO["state"])
    ap.add_argument("--city", default=DEFAULT_GEO["city"])
    ap.add_argument("--drop-city", action="store_true", help="omit city (Steel 400s on unsupported cities)")
    ap.add_argument("--no-solve-captcha", action="store_true", help="disable Steel solveCaptcha (test if solver causes the reCAPTCHA stall)")
    ap.add_argument("--local", action="store_true", help="control: use a normal local Chromium instead of Steel (isolates whether the hang is Steel-specific)")
    args = ap.parse_args()
    geo = {"country": args.country, "state": args.state, "city": args.city}
    asyncio.run(probe(args.url, args.proxy_mode, geo, args.budget, args.drop_city, solve_captcha=not args.no_solve_captcha, local=args.local))


if __name__ == "__main__":
    main()
