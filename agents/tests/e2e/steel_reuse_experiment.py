"""Steel clearance-REUSE experiment — warm once, then measure repeated loads.

The 68-experiment sweep proved single-load config tuning can't consistently
beat the Cloudflare wall (cf_clearance is IP+UA-bound; Steel rotates IPs so
cross-session cookie/profile reuse failed). This harness tests the reuse
strategies that keep a STABLE identity so clearance survives:

  mode=same-session : warm in a live Steel session, then re-navigate within
                      the SAME session N times (same browser, same IP, same
                      in-memory cf_clearance). Free; no proxy.
  mode=same-profile : warm with persistProfile -> profileId, then open N NEW
                      sessions reusing that profileId (+ optional sticky BYOP
                      proxy via STEEL_PROXY_SERVER so the IP stays constant).
  mode=cookie-sticky: warm + save cf_clearance, then N NEW sessions that
                      inject the cookie (use with a sticky BYOP proxy).

Output: one JSON object with warm_t2u and an array of reuse load times, plus
consistent=true iff EVERY reuse load was usable AND under --fast-threshold.

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_reuse_experiment.py --mode same-session --reloads 4
  ... --mode same-profile --reloads 3
  ... --mode cookie-sticky --reloads 3   (needs STEEL_PROXY_SERVER)
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
}
STATE_JS = """() => {
  const t=document.title||''; const b=(document.body&&document.body.innerText)||'';
  const ch=/just a moment|verifying you are human|attention required|checking (your|if) (the )?browser|enable javascript and cookies/i.test(t);
  const cf=!!document.querySelector('iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, .cf-turnstile');
  return {title:t, bodyLen:b.length, challengeTitle:ch, cfFrame:cf, text:b.slice(0,4000)};
}"""


def log(*a): print(*a, file=sys.stderr, flush=True)


def _key():
    if not (os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY")):
        try:
            from dotenv import load_dotenv; load_dotenv(override=False)
        except Exception:
            pass
    k = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    if not k:
        log("ERROR: STEEL_API_KEY not set"); sys.exit(2)
    return k


def _proxy(spec):
    if spec in (None, "none"):
        return False
    if spec == "byop":
        s = os.environ.get("STEEL_PROXY_SERVER", "").strip()
        return {"server": s} if s else False
    if spec.startswith("geo:"):
        p = spec[4:].split("/"); g = {"country": p[0]}
        if len(p) > 1 and p[1]: g["state"] = p[1]
        if len(p) > 2 and p[2]: g["city"] = p[2]
        return {"geolocation": g}
    if spec == "fixed":
        return {"type": "fixed"}
    if spec.startswith("fixed:"):
        return {"type": "fixed", "id": spec}
    return False


def _body(a, profile_id):
    b = {"useProxy": _proxy(a.proxy), "solveCaptcha": a.solve_captcha,
         "stealthConfig": {"humanizeInteractions": a.humanize, "skipFingerprintInjection": a.skip_fingerprint},
         "timeout": 900000, "dimensions": {"width": 1288, "height": 891}}
    if getattr(a, "experimental", None):
        b["experimentalFeatures"] = [x for x in a.experimental.split(",") if x]
    if a.user_agent and a.user_agent != "default":
        b["userAgent"] = UA.get(a.user_agent, a.user_agent)
    if a.persist_profile or profile_id:
        b["persistProfile"] = True
    if profile_id:
        b["profileId"] = profile_id
    return b


async def _create(key, body):
    async with httpx.AsyncClient(timeout=60.0) as c:
        r = await c.post(STEEL_API, headers={"steel-api-key": key, "Content-Type": "application/json"}, json=body)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"create {r.status_code}: {r.text[:200]}")
    return r.json()


async def _release(key, sid):
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            await c.post(f"{STEEL_API}/{sid}/release", headers={"steel-api-key": key})
    except Exception:
        pass


async def _load_once(page, pcdp, bcdp, url, expect, budget, wait_until="commit"):
    """Navigate to url; return (time_to_usable|None, freeze_dur)."""
    t0 = time.monotonic()
    freeze_start = freeze_end = None
    try:
        await page.goto(url, wait_until=wait_until, timeout=30000)
    except Exception:
        pass
    while time.monotonic() - t0 < budget:
        frozen = False; state = None
        try:
            r = await asyncio.wait_for(pcdp.send("Runtime.evaluate", {"expression": f"({STATE_JS})()", "returnByValue": True}), timeout=4)
            state = r.get("result", {}).get("value", {}) or {}
        except Exception:
            frozen = True
        if frozen:
            if freeze_start is None: freeze_start = time.monotonic() - t0
            freeze_end = time.monotonic() - t0
        else:
            is_ch = state.get("challengeTitle") or state.get("cfFrame")
            kw = (not expect) or any(k in state.get("text", "") for k in expect)
            if state.get("bodyLen", 0) > 500 and kw and not is_ch:
                return round(time.monotonic() - t0, 1), round((freeze_end - freeze_start) if freeze_start is not None else 0.0, 1)
        await asyncio.sleep(1.5)
    return None, round((freeze_end - freeze_start) if freeze_start is not None else 0.0, 1)


async def run(a):
    key = _key()
    out = {"label": a.label, "mode": a.mode, "warm_t2u": None, "warm_freeze": None,
           "reuse_times": [], "reuse_usable_all": False, "consistent": False,
           "proxy": a.proxy, "ua": a.user_agent, "error": None}
    sid = None
    profile_id = a.profile_id
    async with async_playwright() as pw:
        try:
            if a.mode == "same-session":
                # one session: warm, then re-navigate within it
                sess = await _create(key, _body(a, None)); sid = sess["id"]
                log(f"[{a.label}] session {sid}")
                br = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
                ctx = br.contexts[0] if br.contexts else await br.new_context()
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                pcdp = await ctx.new_cdp_session(page); bcdp = await br.new_browser_cdp_session()
                wt, wf = await _load_once(page, pcdp, bcdp, a.url, a.expect, a.budget)
                out["warm_t2u"], out["warm_freeze"] = wt, wf
                log(f"[{a.label}] warm={wt}s freeze={wf}s")
                for i in range(a.reloads):
                    try:
                        await page.goto("about:blank"); await asyncio.sleep(1.0)
                    except Exception:
                        pass
                    rt, _ = await _load_once(page, pcdp, bcdp, a.url, a.expect, a.budget)
                    out["reuse_times"].append(rt)
                    log(f"[{a.label}] reuse#{i+1}={rt}s")
            else:
                # warm in its own session (persist profile and/or save cookies)
                warm_body = _body(a, None)
                if a.mode == "same-profile":
                    warm_body["persistProfile"] = True
                sess = await _create(key, warm_body); sid = sess["id"]
                profile_id = sess.get("profileId") or profile_id
                log(f"[{a.label}] warm session {sid} profile={profile_id}")
                br = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
                ctx = br.contexts[0] if br.contexts else await br.new_context()
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                pcdp = await ctx.new_cdp_session(page); bcdp = await br.new_browser_cdp_session()
                wt, wf = await _load_once(page, pcdp, bcdp, a.url, a.expect, a.budget)
                out["warm_t2u"], out["warm_freeze"] = wt, wf
                saved_cookies = []
                if a.mode == "cookie-sticky":
                    try:
                        ck = await ctx.cookies()
                        saved_cookies = [c for c in ck if "toasttab" in c.get("domain", "") or c.get("name") in ("cf_clearance", "__cf_bm")]
                    except Exception:
                        pass
                await _release(key, sid); sid = None
                log(f"[{a.label}] warm={wt}s; reusing via {a.mode} ({len(saved_cookies)} cookies, profile={profile_id})")
                # N fresh sessions reusing identity
                for i in range(a.reloads):
                    s2 = None
                    try:
                        b2 = _body(a, profile_id if a.mode == "same-profile" else None)
                        s2 = await _create(key, b2)
                        sid = s2["id"]
                        br2 = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={s2['id']}")
                        ctx2 = br2.contexts[0] if br2.contexts else await br2.new_context()
                        if a.mode == "cookie-sticky" and saved_cookies:
                            try: await ctx2.add_cookies(saved_cookies)
                            except Exception as e: log(f"  cookie inject fail: {e}")
                        p2 = ctx2.pages[0] if ctx2.pages else await ctx2.new_page()
                        pc2 = await ctx2.new_cdp_session(p2); bc2 = await br2.new_browser_cdp_session()
                        rt, _ = await _load_once(p2, pc2, bc2, a.url, a.expect, a.budget)
                        out["reuse_times"].append(rt)
                        log(f"[{a.label}] reuse#{i+1}={rt}s")
                    except Exception as e:
                        out["reuse_times"].append(None); log(f"  reuse#{i+1} err {e}")
                    finally:
                        if sid: await _release(key, sid); sid = None
            rts = out["reuse_times"]
            out["reuse_usable_all"] = len(rts) > 0 and all(t is not None for t in rts)
            out["consistent"] = out["reuse_usable_all"] and all((t is not None and t < a.fast_threshold) for t in rts)
        except Exception as e:
            out["error"] = str(e)[:200]; log(f"[{a.label}] ERROR {out['error']}")
        finally:
            if sid: await _release(key, sid)
    print(json.dumps(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="reuse")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--mode", default="same-session", choices=["same-session", "same-profile", "cookie-sticky"])
    ap.add_argument("--reloads", type=int, default=4)
    ap.add_argument("--proxy", default="none")
    ap.add_argument("--solve-captcha", dest="solve_captcha", action="store_true", default=True)
    ap.add_argument("--no-solve-captcha", dest="solve_captcha", action="store_false")
    ap.add_argument("--user-agent", default="default")
    ap.add_argument("--humanize", action="store_true", default=False)
    ap.add_argument("--inject-fingerprint", dest="skip_fingerprint", action="store_false", default=True)
    ap.add_argument("--persist-profile", action="store_true")
    ap.add_argument("--profile-id", default=None)
    ap.add_argument("--experimental", default=None, help="comma-separated experimentalFeatures, e.g. useStealthBrowser")
    ap.add_argument("--budget", type=float, default=130.0)
    ap.add_argument("--fast-threshold", type=float, default=20.0)
    ap.add_argument("--expect", default=",".join(DEFAULT_EXPECT))
    a = ap.parse_args()
    a.expect = [k for k in (a.expect.split(",") if a.expect else []) if k.strip()]
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
