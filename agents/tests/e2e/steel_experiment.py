"""Steel bot-challenge experiment harness — ONE config -> ONE JSON result.

Used by the optimization workflow to try many hypotheses for reducing
time-to-usable on order.toasttab.com (Cloudflare Turnstile + reCAPTCHA)
WITHOUT abandoning the Steel cloud browser (hard invariant: every run goes
through wss://connect.steel.dev).

Emits exactly one JSON object on stdout (last line). Human logs -> stderr.

Levers (Steel session-create + nav strategy):
  --solve-captcha / --no-solve-captcha
  --proxy none | geo:US/CA | geo:US/TX | geo:GB | byop
  --user-agent default|real-mac|real-win|real-linux|"<literal UA>"
  --dims 1288x891
  --humanize / --no-humanize            (stealthConfig.humanizeInteractions)
  --inject-fingerprint / --skip-fingerprint  (stealthConfig.skipFingerprintInjection)
  --block-ads
  --region <steel region>
  --persist-profile  --profile-id <id>  (Cloudflare cf_clearance lives in the profile)
  --wait-until commit|domcontentloaded|load
  --prewarm <url>                        (visit a lighter path first)
  --save-cookies <path>  --inject-cookies <path>   (capture/replay cf_clearance)
  --budget <s> --expect "a,b,c" --label "..."

Two-step experiments (profile / cookie reuse) = run twice:
  warm:  --persist-profile --save-cookies /tmp/c.json   (prints profile_id)
  reuse: --profile-id <id>      OR    --inject-cookies /tmp/c.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import httpx
from playwright.async_api import async_playwright

STEEL_API = "https://api.steel.dev/v1/sessions"
DEFAULT_URL = "https://order.toasttab.com/online/nopafish"
DEFAULT_EXPECT = ["Rocky", "Sandwich", "$"]

UA = {
    "real-mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "real-win": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "real-linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
}

STATE_JS = """() => {
  const t = document.title || '';
  const body = (document.body && document.body.innerText) || '';
  const challengeTitle = /just a moment|verifying you are human|attention required|checking (your|if) (the )?browser|enable javascript and cookies/i.test(t);
  const cfFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, .cf-turnstile');
  const recaptcha = !!document.querySelector('iframe[src*="recaptcha"]') || (typeof window.grecaptcha !== 'undefined');
  return { title: t, bodyLen: body.length, challengeTitle, cfFrame, recaptcha, text: body.slice(0, 4000) };
}"""


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _key():
    if not (os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY")):
        try:
            from dotenv import load_dotenv
            load_dotenv(override=False)
        except Exception:
            pass
    k = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not k:
        log("ERROR: STEEL_API_KEY not set")
        sys.exit(2)
    return k


def _proxy(spec):
    if spec in (None, "none"):
        return False
    if spec == "byop":
        s = os.environ.get("STEEL_PROXY_SERVER", "").strip()
        if not s:
            log("WARN: byop requested but STEEL_PROXY_SERVER unset -> no proxy")
            return False
        return {"server": s}
    if spec.startswith("geo:"):
        parts = spec[4:].split("/")
        g = {"country": parts[0]}
        if len(parts) > 1 and parts[1]:
            g["state"] = parts[1]
        if len(parts) > 2 and parts[2]:
            g["city"] = parts[2]
        return {"geolocation": g}
    return False


def _build_body(args, profile_id):
    body = {
        "useProxy": _proxy(args.proxy),
        "solveCaptcha": args.solve_captcha,
        "stealthConfig": {
            "humanizeInteractions": args.humanize,
            "skipFingerprintInjection": args.skip_fingerprint,
        },
        "timeout": 900000,
    }
    w, h = (args.dims.split("x") + ["891"])[:2]
    body["dimensions"] = {"width": int(w), "height": int(h)}
    if args.user_agent and args.user_agent != "default":
        body["userAgent"] = UA.get(args.user_agent, args.user_agent)
    if args.persist_profile or profile_id:
        body["persistProfile"] = True
    if profile_id:
        body["profileId"] = profile_id
    if args.block_ads:
        body["blockAds"] = True
    if args.region:
        body["region"] = args.region
    return body


async def _create(key, body):
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


async def run(args):
    key = _key()
    result = {
        "label": args.label, "usable": False, "time_to_usable": None, "freeze_dur": 0.0,
        "challenge": "none", "profile_id": args.profile_id, "cf_clearance": False,
        "proxy": args.proxy, "solve_captcha": args.solve_captcha, "ua": args.user_agent,
        "humanize": args.humanize, "skip_fp": args.skip_fingerprint, "error": None,
    }
    # retry city-drop like prod
    body = _build_body(args, args.profile_id)
    sid = None
    async with async_playwright() as pw:
        try:
            try:
                sess = await _create(key, body)
            except RuntimeError as e:
                if "400" in str(e) and isinstance(body.get("useProxy"), dict) and "geolocation" in body["useProxy"]:
                    body["useProxy"]["geolocation"].pop("city", None)
                    sess = await _create(key, body)
                else:
                    raise
            sid = sess["id"]
            result["profile_id"] = sess.get("profileId") or args.profile_id
            log(f"[{args.label}] session {sid} profile={result['profile_id']} proxySrc={sess.get('proxySource')}")
            browser = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()

            if args.inject_cookies:
                try:
                    cookies = json.load(open(args.inject_cookies))
                    await ctx.add_cookies(cookies)
                    log(f"[{args.label}] injected {len(cookies)} cookies")
                except Exception as e:  # noqa: BLE001
                    log(f"[{args.label}] cookie inject failed: {e}")

            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            pcdp = await ctx.new_cdp_session(page)
            bcdp = await browser.new_browser_cdp_session()

            freeze_start = freeze_end = None
            t2u = None
            challenge = set()
            last_title = ""

            if args.prewarm:
                try:
                    await page.goto(args.prewarm, wait_until="domcontentloaded", timeout=30000)
                    log(f"[{args.label}] prewarmed {args.prewarm}")
                except Exception:
                    pass

            t0 = time.monotonic()
            try:
                await page.goto(args.url, wait_until=args.wait_until, timeout=30000)
            except Exception:
                pass

            while time.monotonic() - t0 < args.budget:
                rel = time.monotonic() - t0
                frozen = False
                state = None
                try:
                    r = await asyncio.wait_for(
                        pcdp.send("Runtime.evaluate", {"expression": f"({STATE_JS})()", "returnByValue": True}), timeout=4)
                    state = r.get("result", {}).get("value", {}) or {}
                except Exception:
                    frozen = True
                if frozen:
                    if freeze_start is None:
                        freeze_start = rel
                    freeze_end = rel
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
                    is_ch = state.get("challengeTitle") or state.get("cfFrame")
                    kw_ok = (not args.expect) or any(k in state.get("text", "") for k in args.expect)
                    if state.get("bodyLen", 0) > 500 and kw_ok and not is_ch:
                        t2u = rel
                        break
                await asyncio.sleep(2.0)

            result["usable"] = t2u is not None
            result["time_to_usable"] = round(t2u, 1) if t2u is not None else None
            result["freeze_dur"] = round((freeze_end - freeze_start), 1) if freeze_start is not None else 0.0
            result["challenge"] = ",".join(sorted(challenge)) or "none"

            # capture cookies (cf_clearance) if asked
            if args.save_cookies:
                try:
                    cookies = await ctx.cookies()
                    keep = [c for c in cookies if "toasttab" in c.get("domain", "") or c.get("name") in ("cf_clearance", "__cf_bm")]
                    json.dump(keep, open(args.save_cookies, "w"))
                    result["cf_clearance"] = any(c.get("name") == "cf_clearance" for c in keep)
                    log(f"[{args.label}] saved {len(keep)} cookies cf_clearance={result['cf_clearance']}")
                except Exception as e:  # noqa: BLE001
                    log(f"[{args.label}] cookie save failed: {e}")
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)[:200]
            log(f"[{args.label}] ERROR {result['error']}")
        finally:
            if sid:
                await _release(key, sid)
    print(json.dumps(result))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="exp")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--proxy", default="none")
    ap.add_argument("--solve-captcha", dest="solve_captcha", action="store_true", default=True)
    ap.add_argument("--no-solve-captcha", dest="solve_captcha", action="store_false")
    ap.add_argument("--user-agent", default="default")
    ap.add_argument("--dims", default="1288x891")
    ap.add_argument("--humanize", dest="humanize", action="store_true", default=False)
    ap.add_argument("--no-humanize", dest="humanize", action="store_false")
    ap.add_argument("--inject-fingerprint", dest="skip_fingerprint", action="store_false", default=True)
    ap.add_argument("--skip-fingerprint", dest="skip_fingerprint", action="store_true")
    ap.add_argument("--block-ads", action="store_true")
    ap.add_argument("--region", default=None)
    ap.add_argument("--persist-profile", action="store_true")
    ap.add_argument("--profile-id", default=None)
    ap.add_argument("--wait-until", default="commit", choices=["commit", "domcontentloaded", "load"])
    ap.add_argument("--prewarm", default=None)
    ap.add_argument("--save-cookies", default=None)
    ap.add_argument("--inject-cookies", default=None)
    ap.add_argument("--budget", type=float, default=150.0)
    ap.add_argument("--expect", default=",".join(DEFAULT_EXPECT))
    a = ap.parse_args()
    a.expect = [k for k in (a.expect.split(",") if a.expect else []) if k.strip()]
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
