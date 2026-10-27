"""Live G3 check on Tilion through the worker path: tilion_emulation + open_browser_cdp_connection
(the single-CDP mux) + Playwright. Asserts timezone, navigator.language and Accept-Language on the
first script of the main page and a popup, and again after a forced upstream redial.

Run from agents/ with TILION_API_KEY set: python scripts/tilion_geo_locale_live_check.py [la-user-us-exit|gb-exit]
Creates one session per case and deletes it. Results 2026-10-22: timezone and Accept-Language PASS;
navigator.language stays en-US on Tilion (vendor-pinned), popup Intl locale refused with
'Another locale override is already in effect'.
"""

import asyncio
import json
import logging
import os
import sys
import urllib.request
import urllib.error

from playwright.async_api import async_playwright
from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection
from domains.spawn_browser_agent_v3.tilion_worker import tilion_emulation

BASE = os.environ.get("TILION_BASE_URL", "https://back.tilion.dev").rstrip("/")
FIRST = """(() => { if (window.__roseFirst) return; window.__roseFirst = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  lang: navigator.language, langs: navigator.languages.join(','), offset: new Date().getTimezoneOffset() }; })()"""

CASES = {
    "la-user-us-exit": (
        {"timezone": "America/Los_Angeles", "locale": "en-US"},
        {"timezone": "America/New_York", "locale": "en-US", "country": "US"},
        "us",
        {"tz": "America/Los_Angeles", "lang": "en-US", "accept": "en-US,en"},
    ),
    "gb-exit": (
        None,
        {"timezone": "Europe/London", "locale": "en-GB", "country": "GB"},
        "gb",
        {"tz": "Europe/London", "lang": "en-GB", "accept": "en-GB,en"},
    ),
}


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


results = []


def check(case, name, ok, detail):
    results.append((case, name, ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {case} {name}: {detail}", flush=True)


async def first_values(page):
    return await page.evaluate("window.__roseFirst || null")


async def accept_language(page):
    await page.goto("https://httpbin.org/headers", wait_until="domcontentloaded", timeout=45000)
    body = await page.evaluate("document.body.innerText")
    headers = json.loads(body).get("headers", {})
    return headers.get("Accept-Language")


async def run_case(name):
    fi, exit_geo, country, want = CASES[name]
    status, s = rest(
        "POST",
        "/v1/session",
        {
            "ttl": 600,
            "idle_timeout": 120,
            "residential": True,
            "proxy_type": "residential",
            "geo": {"country": country},
            "cdp_observe": False,
        },
    )
    if status != 201:
        print(name, "create failed", status, s)
        return
    sid = s["session_id"]
    print(f"== {name} session {sid}", flush=True)
    mux = None
    try:
        # Inside the try: a refused gateway or handshake timeout still deletes the
        # paid residential session instead of leaving it live until its TTL.
        emulation = tilion_emulation(fi, exit_geo)
        print("   emulation:", emulation, flush=True)
        url, mux = await open_browser_cdp_connection(s["connect_url"], label=f"a1-g3:{name}", emulation=emulation)
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(url, timeout=60000)
            context = browser.contexts[0]
            await context.add_init_script(FIRST)
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("https://example.com/", wait_until="domcontentloaded", timeout=45000)
            v = await first_values(page)
            check(name, "main first-script timezone", v and v["tz"] == want["tz"], v)
            check(name, "main first-script navigator.language", v and v["lang"] == want["lang"], v and v["langs"])
            diag = await page.evaluate(
                """({getter: String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')?.get), own: Object.getOwnPropertyNames(navigator).join(','), langs: navigator.languages.join(',')})"""
            )
            print("   diag navigator.language getter:", diag, flush=True)
            cdp = await context.new_cdp_session(page)
            ua = (await cdp.send("Browser.getVersion"))["userAgent"]
            await cdp.send(
                "Emulation.setUserAgentOverride",
                {"userAgent": ua, "acceptLanguage": emulation.get("accept_language", "en-US")},
            )
            await page.reload(wait_until="domcontentloaded")
            print(
                "   diag after direct page-session UA override:",
                await page.evaluate("({lang: navigator.language, langs: navigator.languages.join(',')})"),
                flush=True,
            )
            al = await accept_language(page)
            check(name, "Accept-Language header", (al or "").startswith(want["accept"]), al)
            await page.goto("https://example.com/", wait_until="domcontentloaded", timeout=45000)
            async with page.expect_popup(timeout=30000) as popup_info:
                await page.evaluate("window.open('https://example.com/?popup=1', '_blank')")
            popup = await popup_info.value
            await popup.wait_for_load_state("domcontentloaded", timeout=30000)
            pv = await first_values(popup)
            check(name, "popup first-script timezone", pv and pv["tz"] == want["tz"], pv)
            check(name, "popup first-script navigator.language", pv and pv["lang"] == want["lang"], pv and pv["langs"])
            # Forced upstream redial: the provider socket drops, every client is closed.
            opened_before = mux.upstream_connections_opened
            await mux._upstream.close()
            for _ in range(50):
                if not browser.is_connected():
                    break
                await asyncio.sleep(0.1)
            print(f"   redial: playwright disconnected={not browser.is_connected()}", flush=True)
            browser2 = await p.chromium.connect_over_cdp(url, timeout=60000)
            check(
                name,
                "redial opened a new upstream",
                mux.upstream_connections_opened == opened_before + 1,
                mux.upstream_connections_opened,
            )
            context2 = browser2.contexts[0]
            await context2.add_init_script(FIRST)
            page2 = next((pg for pg in context2.pages if "popup" not in pg.url), context2.pages[0])
            live = await page2.evaluate(
                "({tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language})"
            )
            check(name, "after redial existing page timezone", live["tz"] == want["tz"], live)
            await page2.goto("https://example.com/?after-redial=1", wait_until="domcontentloaded", timeout=45000)
            v2 = await first_values(page2)
            check(name, "after redial first-script timezone", v2 and v2["tz"] == want["tz"], v2)
            check(name, "after redial navigator.language", v2 and v2["lang"] == want["lang"], v2 and v2["langs"])
            al2 = await accept_language(page2)
            check(name, "after redial Accept-Language", (al2 or "").startswith(want["accept"]), al2)
            newp = await context2.new_page()
            await newp.goto("https://example.com/?new-after-redial=1", wait_until="domcontentloaded", timeout=45000)
            nv = await first_values(newp)
            check(name, "after redial new page timezone", nv and nv["tz"] == want["tz"], nv)
            print(f"   mux emulation_failures={getattr(mux, 'emulation_failures', None)}", flush=True)
            await browser2.close()
    finally:
        if mux is not None:
            await mux.close()
        print(f"   delete {sid}: {rest('DELETE', f'/v1/session/{sid}')[0]}", flush=True)


async def main():
    for name in sys.argv[1:] or list(CASES):
        try:
            await run_case(name)
        except Exception as error:
            print(f"  [FAIL] {name} exception: {type(error).__name__}: {str(error)[:300]}", flush=True)
            results.append((name, "exception", False))
    failed = [r for r in results if not r[2]]
    print(f"SUMMARY pass={len(results) - len(failed)} fail={len(failed)}", flush=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
    for noisy in ("websockets", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    asyncio.run(main())
