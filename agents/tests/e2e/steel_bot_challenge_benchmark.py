"""Steel bot-challenge load-time benchmark.

CANONICAL test for: how long does a Steel cloud browser take to get past a
bot wall (Cloudflare Turnstile "Just a moment" + reCAPTCHA Enterprise) to a
USABLE page? Isolated from agent 9ec05898 (order.toasttab.com/online/nopafish),
which stalled ~90-260s on exactly this.

What it measures (per run):
  - time_to_usable : nav start -> page actually usable (challenge cleared AND
                     content rendered). THE headline metric.
  - freeze_window  : how long the renderer main thread was CPU-pinned by the
                     challenge PoW (renderer CDP frozen while browser process
                     stays live). This is what starves the agent's screenshots.
  - challenge      : which bot wall was detected (cloudflare/turnstile/recaptcha).
  - usable         : did it EVER render real content within the budget.

Why it works (validated against Cloudflare docs + our diagnostics):
  Turnstile runs a single-threaded cryptographic proof-of-work that
  monopolizes the renderer main thread; difficulty scales with bot-suspicion
  (datacenter IP / headless fingerprint). So this number is a direct proxy
  for "how bot-detected is our browser" AND "how slow is the cloud CPU".
  Use it to compare levers over time: proxy mode, fingerprint/stealth
  changes, a higher-clock Steel tier, etc. Lower = better (ratchet down).

Companion diagnostics (root-cause, not for CI):
  steel_cpu_diagnostic.py   - proves the freeze is the renderer main thread
  steel_cpu_benchmark.py    - single-thread CPU speed (Steel vs local)
  steel_pageload_investigation.py / steel_connection_probe.py - resource timing

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_bot_challenge_benchmark.py
  ... --runs 5 --proxy-mode none
  ... --url https://order.toasttab.com/online/nopafish --expect "Rocky,Sandwich,$"
  ... --max-seconds 120          # PASS gate: median time_to_usable must beat this
  ... --json                     # machine-readable output
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import time

import httpx
from playwright.async_api import async_playwright

STEEL_API = "https://api.steel.dev/v1/sessions"
DEFAULT_URL = "https://order.toasttab.com/online/nopafish"
DEFAULT_EXPECT = ["Rocky", "Sandwich", "$"]
SF_GEO = {"country": "US", "state": "CA"}

# RATCHET (ceiling, seconds): median time-to-usable must stay AT OR BELOW this.
# Baseline 2026-06-27: ~111s median (3 runs, <1s spread) on the prod-faithful
# config — Steel managed CPU, no special proxy, solveCaptcha on, default
# fingerprint — clearing order.toasttab.com's Cloudflare Turnstile + reCAPTCHA
# Enterprise wall. The cost is dominated by an ~87s renderer-main-thread CPU
# freeze (single-threaded challenge proof-of-work on Steel's weak vCPU).
#
# This gate ONLY ratchets DOWN. Lower it as fixes land — a high-single-thread
# -clock / dedicated Steel tier cuts the freeze ~3.5x; reducing bot-detect-
# ability (fingerprint + residential IP + behavior) cuts the challenge weight
# ~10x. NEVER raise it to make a regression pass (per CLAUDE.md). The headroom
# over baseline (111 -> 150) only absorbs day-to-day Cloudflare/CPU variance.
TIME_TO_USABLE_RATCHET_SECONDS = 150.0

# Runs in the page. During a renderer freeze this won't return (that's the
# signal); we time it out and mark the tick FROZEN.
STATE_JS = """() => {
  const t = document.title || '';
  const body = (document.body && document.body.innerText) || '';
  const challengeTitle = /just a moment|verifying you are human|attention required|checking (your|if) (the )?browser|enable javascript and cookies/i.test(t);
  const cfFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, .cf-turnstile');
  const recaptcha = !!document.querySelector('iframe[src*="recaptcha"]') || (typeof window.grecaptcha !== 'undefined');
  return { title: t, bodyLen: body.length, challengeTitle, cfFrame, recaptcha,
           text: body.slice(0, 4000) };
}"""


def _key():
    # Self-contained: load agents/.env so this runs standalone AND under the
    # smoke wrapper without the caller having to export anything.
    if not (os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY")):
        try:
            from dotenv import load_dotenv

            load_dotenv(override=False)
        except Exception:
            pass
    k = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not k:
        raise SystemExit("STEEL_API_KEY / BROWSERBASE_API_KEY not set — source agents/.env")
    return k


def _use_proxy(mode):
    if mode == "none":
        return False
    if mode == "byop":
        s = os.environ.get("STEEL_PROXY_SERVER", "").strip()
        if not s:
            raise SystemExit("--proxy-mode byop requires STEEL_PROXY_SERVER")
        return {"server": s}
    return {"geolocation": dict(SF_GEO)}


async def _create(key, use_proxy, solve_captcha, drop_city=False):
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
        raise RuntimeError(f"create {r.status_code}: {r.text[:300]}")
    return r.json()


async def _release(key, sid):
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            await c.post(f"{STEEL_API}/{sid}/release", headers={"steel-api-key": key})
    except Exception:
        pass


async def one_run(key, url, use_proxy, solve_captcha, expect, budget, local, idx, verbose):
    sid = None
    async with async_playwright() as pw:
        if local:
            browser = await pw.chromium.launch(headless=True)
        else:
            try:
                sess = await _create(key, use_proxy, solve_captcha)
            except RuntimeError as e:
                if "400" in str(e) and isinstance(use_proxy, dict) and "geolocation" in use_proxy:
                    sess = await _create(key, use_proxy, solve_captcha, drop_city=True)
                else:
                    raise
            sid = sess["id"]
            browser = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
        try:
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            pcdp = await ctx.new_cdp_session(page)
            bcdp = await browser.new_browser_cdp_session()

            challenge = set()
            freeze_start = freeze_end = None
            time_to_usable = None
            last_title = ""

            t0 = time.monotonic()
            try:
                await page.goto(url, wait_until="commit", timeout=30000)
            except Exception:
                pass

            while time.monotonic() - t0 < budget:
                rel = time.monotonic() - t0
                # renderer responsive?
                frozen = False
                state = None
                try:
                    r = await asyncio.wait_for(
                        pcdp.send("Runtime.evaluate", {"expression": f"({STATE_JS})()", "returnByValue": True}),
                        timeout=4,
                    )
                    state = r.get("result", {}).get("value", {}) or {}
                except Exception:
                    frozen = True

                if frozen:
                    if freeze_start is None:
                        freeze_start = rel
                    freeze_end = rel
                    # read title from browser process (works while renderer pinned)
                    try:
                        tg = await asyncio.wait_for(bcdp.send("Target.getTargets"), timeout=4)
                        pages = [i for i in tg.get("targetInfos", []) if i.get("type") == "page"]
                        if pages:
                            last_title = pages[0].get("title") or last_title
                    except Exception:
                        pass
                    if "just a moment" in last_title.lower() or "verifying" in last_title.lower():
                        challenge.add("cloudflare")
                else:
                    last_title = state.get("title", last_title)
                    if state.get("challengeTitle") or state.get("cfFrame"):
                        challenge.add("cloudflare")
                    if state.get("recaptcha"):
                        challenge.add("recaptcha")
                    text = state.get("text", "")
                    is_challenge = state.get("challengeTitle") or state.get("cfFrame")
                    has_content = state.get("bodyLen", 0) > 500
                    kw_ok = (not expect) or any(k in text for k in expect)
                    if has_content and kw_ok and not is_challenge:
                        time_to_usable = rel
                        break
                if verbose:
                    st = "FROZEN" if frozen else ("challenge" if (state and (state.get("challengeTitle") or state.get("cfFrame"))) else f"body={state.get('bodyLen') if state else '?'}")
                    print(f"  run{idx} t={rel:6.1f}s  {st:>12}  title={last_title[:30]!r}")
                await asyncio.sleep(2.0)

            freeze_dur = (freeze_end - freeze_start) if freeze_start is not None else 0.0
            return {
                "run": idx,
                "usable": time_to_usable is not None,
                "time_to_usable": round(time_to_usable, 1) if time_to_usable is not None else None,
                "freeze_start": round(freeze_start, 1) if freeze_start is not None else None,
                "freeze_dur": round(freeze_dur, 1),
                "challenge": ",".join(sorted(challenge)) or "none",
                "final_title": last_title[:40],
            }
        finally:
            if sid:
                await _release(key, sid)


async def run(url, proxy_mode, solve_captcha, expect, budget, runs, local, max_seconds, as_json, verbose):
    key = _key()
    use_proxy = False if local else _use_proxy(proxy_mode)
    results = []
    for i in range(1, runs + 1):
        if verbose and not as_json:
            print(f"\n--- run {i}/{runs} ---")
        try:
            res = await one_run(key, url, use_proxy, solve_captcha, expect, budget, local, i, verbose and not as_json)
        except Exception as e:  # noqa: BLE001
            res = {"run": i, "usable": False, "time_to_usable": None, "freeze_start": None,
                   "freeze_dur": 0.0, "challenge": "error", "final_title": str(e)[:40]}
        results.append(res)

    usable_times = [r["time_to_usable"] for r in results if r["usable"]]
    freezes = [r["freeze_dur"] for r in results if r["freeze_dur"]]
    summary = {
        "url": url,
        "mode": "local" if local else proxy_mode,
        "solveCaptcha": solve_captcha,
        "runs": runs,
        "usable_rate": f"{len(usable_times)}/{runs}",
        "time_to_usable_median": round(statistics.median(usable_times), 1) if usable_times else None,
        "time_to_usable_min": min(usable_times) if usable_times else None,
        "time_to_usable_max": max(usable_times) if usable_times else None,
        "freeze_median": round(statistics.median(freezes), 1) if freezes else 0.0,
        "challenges_seen": sorted({r["challenge"] for r in results}),
    }

    if as_json:
        print(json.dumps({"summary": summary, "runs": results}, indent=2))
    else:
        print(f"\n=== BOT-CHALLENGE LOAD BENCHMARK ===")
        print(f"url={url}\nmode={summary['mode']}  solveCaptcha={solve_captcha}  runs={runs}\n")
        print(f"{'run':>4} {'usable':>7} {'t_usable':>9} {'freeze':>8} {'challenge':>20} {'final title':>22}")
        print("-" * 76)
        for r in results:
            print(f"{r['run']:>4} {str(r['usable']):>7} "
                  f"{(str(r['time_to_usable'])+'s') if r['time_to_usable'] is not None else 'NEVER':>9} "
                  f"{str(r['freeze_dur'])+'s':>8} {r['challenge']:>20} {r['final_title']:>22}")
        print("-" * 76)
        print(f"usable rate        : {summary['usable_rate']}")
        print(f"time-to-usable      : median={summary['time_to_usable_median']}s "
              f"min={summary['time_to_usable_min']}s max={summary['time_to_usable_max']}s")
        print(f"renderer freeze     : median={summary['freeze_median']}s")
        print(f"challenges detected : {summary['challenges_seen']}")

    # PASS/FAIL gate
    med = summary["time_to_usable_median"]
    ok = bool(usable_times) and len(usable_times) == runs and med is not None and med <= max_seconds
    if not as_json:
        if ok:
            print(f"\nPASS: all runs usable, median {med}s <= {max_seconds}s")
        else:
            why = "not all runs reached a usable page" if len(usable_times) != runs else \
                  (f"median {med}s exceeds {max_seconds}s" if med is not None else "never usable")
            print(f"\nFAIL: {why}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--proxy-mode", choices=["steel", "none", "byop"], default="none")
    ap.add_argument("--no-solve-captcha", action="store_true")
    ap.add_argument("--expect", default=",".join(DEFAULT_EXPECT),
                    help="comma-separated keywords that must appear in body for 'usable' (empty = any content)")
    ap.add_argument("--budget", type=float, default=240.0, help="max seconds to wait per run")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--max-seconds", type=float, default=TIME_TO_USABLE_RATCHET_SECONDS,
                    help="PASS gate on median time-to-usable (default = TIME_TO_USABLE_RATCHET_SECONDS)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    expect = [k for k in (a.expect.split(",") if a.expect else []) if k.strip()]
    rc = asyncio.run(run(a.url, a.proxy_mode, not a.no_solve_captcha, expect, a.budget,
                         a.runs, a.local, a.max_seconds, a.json, a.verbose))
    raise SystemExit(rc)


if __name__ == "__main__":
    main()
