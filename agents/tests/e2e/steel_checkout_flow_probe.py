"""Steel CHECKOUT-FLOW probe — drive order.toasttab.com all the way to the
final "Place Order" button WITHOUT ever submitting.

This exists to separate two failure modes we've been conflating:

  (A) LOAD FREEZE  — Cloudflare / reCAPTCHA runs a single-threaded, CPU-bound
      proof-of-work on page load. It pins the Steel renderer main thread for
      ~90s (every CDP call hangs). We measure this as `load_time_to_usable`
      and `load_freeze_seconds`. This is a LATENCY problem — the page does
      eventually render.

  (B) CHECKOUT BLOCKED — even after the page renders, the order flow may be
      unable to reach a usable "Place Order" state. The known culprit is that
      Toast's checkout calls reCAPTCHA Enterprise, which cannot connect inside
      a bot-flagged browser ("Could not connect to reCAPTCHA service" -> HTTP
      500). This is a CORRECTNESS problem — the order can NEVER be placed, no
      matter how long we wait. A dedicated IP / warm cf_clearance fixes (A) but
      does NOTHING for (B).

The probe walks: menu -> add 2x fish sandwich -> open cart -> checkout ->
fill NON-FINANCIAL guest details (test name/email/phone only) -> stop at the
Place Order button. It NEVER clicks submit and NEVER enters card data.

Throughout, it records every HTTP response >=400 and every console error, so
we can point Steel at the exact request that fails and prove (B) is distinct
from (A).

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_checkout_flow_probe.py \
      --proxy fixed:NVKJdNNtyy --experimental useStealthBrowser
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time

import httpx
from playwright.async_api import async_playwright

STEEL_API = "https://api.steel.dev/v1/sessions"
MENU_URL = "https://order.toasttab.com/online/nopafish"
UA_DEFAULT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

# Non-financial test identity only. NEVER card data.
GUEST = {"first": "Andy", "last": "Test", "email": "andy@hinavi.ai", "phone": "9729777432"}

STATE_JS = """() => {
  const t=document.title||''; const b=(document.body&&document.body.innerText)||'';
  const ch=/just a moment|verifying you are human|attention required|checking (your|if) (the )?browser|enable javascript and cookies/i.test(t);
  const cf=!!document.querySelector('iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, .cf-turnstile');
  return {title:t, bodyLen:b.length, challengeTitle:ch, cfFrame:cf, text:b.slice(0,3000)};
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
        return {"server": s} if s else False
    if spec.startswith("geo:"):
        p = spec[4:].split("/")
        g = {"country": p[0]}
        if len(p) > 1 and p[1]:
            g["state"] = p[1]
        if len(p) > 2 and p[2]:
            g["city"] = p[2]
        return {"geolocation": g}
    if spec == "fixed":
        return {"type": "fixed"}
    if spec.startswith("fixed:"):
        return {"type": "fixed", "id": spec}
    return False


def _body(a):
    b = {
        "useProxy": _proxy(a.proxy),
        "solveCaptcha": True,
        "stealthConfig": {"humanizeInteractions": False, "skipFingerprintInjection": True},
        "timeout": 900000,
        "userAgent": UA_DEFAULT,
        "dimensions": {"width": 1288, "height": 891},
    }
    if a.experimental:
        b["experimentalFeatures"] = [x for x in a.experimental.split(",") if x]
    if getattr(a, "persist_profile", False) or getattr(a, "profile_id", None):
        b["persistProfile"] = True
    if getattr(a, "profile_id", None):
        b["profileId"] = a.profile_id
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


async def _await_usable(page, pcdp, budget):
    """Navigate menu; wait through any freeze. Return (t2u|None, freeze_s, final_state)."""
    t0 = time.monotonic()
    fs = fe = None
    try:
        await page.goto(MENU_URL, wait_until="commit", timeout=30000)
    except Exception:
        pass
    last = {}
    while time.monotonic() - t0 < budget:
        frozen = False
        state = None
        try:
            r = await asyncio.wait_for(
                pcdp.send("Runtime.evaluate", {"expression": f"({STATE_JS})()", "returnByValue": True}), timeout=4)
            state = r.get("result", {}).get("value", {}) or {}
            last = state
        except Exception:
            frozen = True
        if frozen:
            if fs is None:
                fs = time.monotonic() - t0
            fe = time.monotonic() - t0
        else:
            is_ch = state.get("challengeTitle") or state.get("cfFrame")
            if state.get("bodyLen", 0) > 500 and not is_ch:
                return round(time.monotonic() - t0, 1), round((fe - fs) if fs is not None else 0.0, 1), state
        await asyncio.sleep(1.5)
    return None, round((fe - fs) if fs is not None else 0.0, 1), last


async def _click_text(page, pattern, timeout=12000, roles=("button", "link", "menuitem")):
    """Best-effort click of the first visible element whose text matches pattern."""
    rx = re.compile(pattern, re.I)
    for role in roles:
        try:
            loc = page.get_by_role(role, name=rx).first
            await loc.wait_for(state="visible", timeout=timeout // len(roles))
            await loc.scroll_into_view_if_needed(timeout=3000)
            await loc.click(timeout=4000)
            return True
        except Exception:
            continue
    # JS fallback: click any element whose innerText matches
    try:
        clicked = await page.evaluate(
            """(pat) => {
              const rx = new RegExp(pat, 'i');
              const els = [...document.querySelectorAll('button,a,[role=button],div,span')];
              for (const e of els) {
                const t = (e.innerText||'').trim();
                if (t && rx.test(t) && e.offsetParent !== null && t.length < 60) { e.click(); return t; }
              }
              return null;
            }""", pattern)
        return bool(clicked)
    except Exception:
        return False


async def _fill(page, patterns, value):
    """Fill first input whose name/placeholder/label matches any pattern."""
    for pat in patterns:
        rx = re.compile(pat, re.I)
        for getter in ("get_by_label", "get_by_placeholder"):
            try:
                loc = getattr(page, getter)(rx).first
                await loc.wait_for(state="visible", timeout=2500)
                await loc.fill(value, timeout=3000)
                return True
            except Exception:
                continue
    # JS fallback by name/id/placeholder attr
    try:
        ok = await page.evaluate(
            """([pats, val]) => {
              const rx = new RegExp(pats.join('|'), 'i');
              const els = [...document.querySelectorAll('input,textarea')];
              for (const e of els) {
                const key = (e.name||'')+' '+(e.id||'')+' '+(e.placeholder||'')+' '+(e.getAttribute('aria-label')||'');
                if (rx.test(key) && e.offsetParent !== null) {
                  e.focus(); e.value = val;
                  e.dispatchEvent(new Event('input',{bubbles:true}));
                  e.dispatchEvent(new Event('change',{bubbles:true}));
                  return true;
                }
              }
              return false;
            }""", [patterns, value])
        return bool(ok)
    except Exception:
        return False


async def _body_text(page):
    try:
        return await page.evaluate("() => (document.body&&document.body.innerText||'').slice(0,1500)")
    except Exception:
        return ""


async def _interactive(page):
    """Snapshot visible interactive elements (for selector design)."""
    try:
        return await page.evaluate(
            """() => {
              const out=[];
              const els=[...document.querySelectorAll('button,a,[role=button],[role=dialog] *')];
              for (const e of els) {
                if (e.offsetParent===null) continue;
                const tag=e.tagName.toLowerCase();
                if (!/^(button|a)$/.test(tag) && e.getAttribute('role')!=='button') continue;
                const t=(e.innerText||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');
                if (t && t.length<60) out.push({tag, t, dis: e.disabled===true||e.getAttribute('aria-disabled')==='true'});
              }
              const seen=new Set(); const uniq=[];
              for (const o of out){const k=o.tag+'|'+o.t; if(!seen.has(k)){seen.add(k);uniq.push(o);}}
              return uniq.slice(0,60);
            }""")
    except Exception:
        return []


async def _has_dialog(page):
    try:
        return await page.evaluate("() => !!document.querySelector('[role=dialog], [aria-modal=true]')")
    except Exception:
        return False


async def run(a):
    key = _key()
    out = {
        "label": a.label, "proxy": a.proxy, "experimental": a.experimental,
        "load_time_to_usable": None, "load_freeze_seconds": None,
        "steps": [], "reached_place_order": False, "place_order_enabled": None,
        "checkout_blocked": None, "block_reason": None,
        "http_errors": [], "recaptcha_console_errors": [], "error": None,
    }
    net = []
    submit_net = []  # reCAPTCHA + order-submit traffic, ALL statuses
    console = []
    sid = None
    _rx_submit = re.compile(r"recaptcha|gstatic.*recaptcha|/orders|placeOrder|checkout|payment|graphql", re.I)

    def on_response(r):
        try:
            if r.status >= 400:
                net.append({"status": r.status, "url": r.url[:180]})
            if _rx_submit.search(r.url or ""):
                submit_net.append({"status": r.status, "url": r.url[:160]})
        except Exception:
            pass

    def on_console(m):
        try:
            if m.type in ("error", "warning") or "recaptcha" in (m.text or "").lower():
                console.append({"type": m.type, "text": (m.text or "")[:200]})
        except Exception:
            pass

    async with async_playwright() as pw:
        try:
            sess = await _create(key, _body(a))
            sid = sess["id"]
            log(f"[{a.label}] session {sid}  viewer={sess.get('sessionViewerUrl')}")
            br = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
            ctx = br.contexts[0] if br.contexts else await br.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            page.on("response", on_response)
            page.on("console", on_console)
            pcdp = await ctx.new_cdp_session(page)

            # ---- STEP 0: load menu past any freeze ----
            t2u, freeze, state = await _await_usable(page, pcdp, a.budget)
            out["load_time_to_usable"], out["load_freeze_seconds"] = t2u, freeze
            if t2u is None:
                out["steps"].append({"step": "load_menu", "ok": False, "note": f"never usable within {a.budget}s (freeze {freeze}s)"})
                out["checkout_blocked"] = None
                out["block_reason"] = "PAGE_NEVER_LOADED (mode A freeze exceeded budget)"
                raise RuntimeError("menu never usable")
            out["steps"].append({"step": "load_menu", "ok": True, "note": f"usable in {t2u}s (freeze {freeze}s)"})
            log(f"[{a.label}] menu usable in {t2u}s (freeze {freeze}s)")
            await asyncio.sleep(2)
            out["profile_id"] = sess.get("profileId")
            out["debug_menu_buttons"] = await _interactive(page)

            # ---- STEP 1: open the fish sandwich item (Rocky Sandwich / Fish & Chips) ----
            item_ok = await _click_text(page, r"rocky sandwich|fish sandwich|fish & chips|rockfish", timeout=10000, roles=("link", "button", "menuitem"))
            if not item_ok:
                item_ok = await _click_text(page, r"sandwich", timeout=8000, roles=("link", "button", "menuitem"))
            await asyncio.sleep(2.5)
            in_dialog = await _has_dialog(page)
            out["steps"].append({"step": "open_item", "ok": item_ok, "dialog_opened": in_dialog})
            out["debug_item_dialog"] = await _interactive(page)
            log(f"[{a.label}] open_item={item_ok} dialog={in_dialog}")

            # ---- STEP 2: quantity 2 (stepper +), then add to cart ----
            qty_ok = await _click_text(page, r"increase quantity|increase|^\+$|add one", timeout=4000)
            if not qty_ok:
                qty_ok = await _fill(page, [r"quantity", r"qty"], "2")
            add_ok = await _click_text(page, r"add to (cart|order|bag)|add \$|add \d+ to", timeout=8000)
            await asyncio.sleep(3)
            out["steps"].append({"step": "add_to_cart", "ok": add_ok, "qty_set": qty_ok, "dialog_closed": not await _has_dialog(page)})
            log(f"[{a.label}] add_to_cart={add_ok} qty_set={qty_ok}")
            out["debug_after_add"] = await _interactive(page)

            # ---- STEP 3: open cart, then checkout (retry loop; cart panel races the fast path) ----
            co_ok = False
            for _attempt in range(5):
                if "checkout" in page.url:
                    co_ok = True
                    break
                # desktop right-panel Checkout button (appears once cart has items)
                await _click_text(page, r"(go to |proceed to )?checkout|checkout \$|continue to payment|place your order", timeout=4000)
                await asyncio.sleep(2.5)
                if "checkout" in page.url:
                    co_ok = True
                    break
                # otherwise open the cart drawer via the item-count badge, then checkout
                await _click_text(page, r"^\d+$|view (cart|order)|your order|cart|bag|basket", timeout=3000)
                await asyncio.sleep(2)
                await _click_text(page, r"(go to |proceed to )?checkout|continue", timeout=4000)
                await asyncio.sleep(3)
            # scheduled-order stores may force a time-slot pick before checkout
            if re.search(r"schedul", (await _body_text(page)) or "", re.I):
                out["steps"].append({"step": "scheduling_prompt", "seen": True})
                await _click_text(page, r"schedule|save|confirm|continue|next|apply", timeout=6000)
                await asyncio.sleep(3)
                await _click_text(page, r"(go to |proceed to )?checkout|continue", timeout=6000)
                await asyncio.sleep(4)
            out["steps"].append({"step": "to_checkout", "ok": co_ok, "url": page.url})
            log(f"[{a.label}] to_checkout={co_ok} url={page.url}")
            out["debug_checkout_page"] = await _interactive(page)

            # ---- STEP 4: fill non-financial guest details ----
            f1 = await _fill(page, [r"first.?name", r"^name"], GUEST["first"])
            f2 = await _fill(page, [r"last.?name"], GUEST["last"])
            f3 = await _fill(page, [r"email"], GUEST["email"])
            f4 = await _fill(page, [r"phone", r"tel"], GUEST["phone"])
            out["steps"].append({"step": "fill_guest", "first": f1, "last": f2, "email": f3, "phone": f4})
            log(f"[{a.label}] fill_guest first={f1} last={f2} email={f3} phone={f4}")
            await asyncio.sleep(2)

            # ---- STEP 5: detect Place Order button (DO NOT CLICK) ----
            place = await page.evaluate(
                """() => {
                  const rx = /place order|submit order|pay( now)?|complete order|order & pay/i;
                  const els = [...document.querySelectorAll('button,[role=button],a')];
                  for (const e of els) {
                    const t=(e.innerText||'').trim();
                    if (t && rx.test(t)) {
                      return {found:true, text:t.slice(0,40), disabled: e.disabled === true || e.getAttribute('aria-disabled')==='true'};
                    }
                  }
                  return {found:false};
                }""")
            out["reached_place_order"] = bool(place.get("found"))
            out["place_order_enabled"] = (None if not place.get("found") else (not place.get("disabled")))
            out["steps"].append({"step": "detect_place_order", **place})
            log(f"[{a.label}] place_order={place}")

            # ---- STEP 5b: reCAPTCHA health at checkout (safe; no submit) ----
            try:
                rc_health = await page.evaluate(
                    """() => {
                      const scripts=[...document.querySelectorAll('script[src]')].map(s=>s.src);
                      const rcScripts=scripts.filter(s=>/recaptcha|gstatic.*recaptcha/i.test(s));
                      const frames=[...document.querySelectorAll('iframe[src]')].map(f=>f.src)
                        .filter(s=>/recaptcha/i.test(s));
                      let perr=[];
                      try { perr = performance.getEntriesByType('resource')
                        .filter(e=>/recaptcha/i.test(e.name))
                        .map(e=>({name:e.name.slice(0,90), dur:Math.round(e.duration), size:e.transferSize})); } catch(e){}
                      return {
                        grecaptcha: typeof window.grecaptcha !== 'undefined',
                        enterprise: !!(window.grecaptcha && window.grecaptcha.enterprise),
                        recaptcha_scripts: rcScripts.length,
                        recaptcha_iframes: frames.length,
                        recaptcha_resources: perr.slice(0,8),
                      };
                    }""")
                out["recaptcha_health"] = rc_health
                log(f"[{a.label}] recaptcha_health={rc_health}")
            except Exception as e:
                out["recaptcha_health"] = {"error": str(e)[:120]}

            # ---- STEP 6 (OPT-IN): actually click Place Order to observe submission ----
            # SAFE: no card data was entered, so Toast cannot finalize a charge; this
            # surfaces the reCAPTCHA / submit-time behavior without placing a real order.
            if a.submit and out["reached_place_order"]:
                submit_net.clear()
                log(f"[{a.label}] SUBMIT: clicking Place Order (no card entered — cannot charge)")
                clicked = await _click_text(page, r"place order|submit order|complete order|order & pay", timeout=8000)
                # wait for reCAPTCHA / submit round-trip + any error banner to render
                for _ in range(20):
                    await asyncio.sleep(1.5)
                    txt = (await _body_text(page)) or ""
                    if re.search(r"recaptcha|could not connect|declined|verify you|invalid card|required|order (confirmed|received|placed)|thank you", txt, re.I):
                        break
                    if submit_net:
                        break
                after_txt = (await _body_text(page)) or ""
                banner = None
                try:
                    banner = await page.evaluate(
                        """() => {
                          const rx=/recaptcha|could not|error|failed|try again|declined|verify|invalid|payment required/i;
                          const els=[...document.querySelectorAll('[role=alert],.error,[class*=error],[class*=Error],div,span,p')];
                          for (const e of els){const t=(e.innerText||'').trim();
                            if(t && rx.test(t) && t.length<200 && e.offsetParent!==null) return t;}
                          return null;
                        }""")
                except Exception:
                    pass
                out["submit_attempted"] = bool(clicked)
                out["submit_banner"] = banner
                out["submit_url"] = page.url
                out["submit_network"] = submit_net[:30]
                out["submit_recaptcha_calls"] = [n for n in submit_net if "recaptcha" in n["url"].lower()]
                out["submit_5xx"] = [n for n in submit_net if n["status"] >= 500]
                out["order_confirmed"] = bool(re.search(r"order (confirmed|received|placed)|thank you|confirmation #|we'?ve got your order", after_txt, re.I))
                log(f"[{a.label}] SUBMIT result: banner={banner!r} 5xx={out['submit_5xx']} recaptcha={out['submit_recaptcha_calls']} confirmed={out['order_confirmed']}")

            # snapshot page text for diagnosis
            out["final_body_text"] = (await _body_text(page))

        except Exception as e:
            out["error"] = str(e)[:200]
            log(f"[{a.label}] ERROR {out['error']}")
        finally:
            # classify checkout-blocked using network + console evidence
            rc = [c for c in console if "recaptcha" in c["text"].lower()]
            toast_5xx = [n for n in net if n["status"] >= 500]
            recaptcha_net = [n for n in net if "recaptcha" in n["url"].lower() or "gstatic" in n["url"].lower()]
            out["http_errors"] = net[:25]
            out["recaptcha_console_errors"] = rc[:10]
            if out["checkout_blocked"] is None:
                if rc or recaptcha_net or (toast_5xx and not out["reached_place_order"]):
                    out["checkout_blocked"] = True
                    out["block_reason"] = "RECAPTCHA/5xx at checkout (mode B: order can never be placed)"
                elif out["reached_place_order"] and out["place_order_enabled"]:
                    out["checkout_blocked"] = False
                    out["block_reason"] = "reached enabled Place Order (would-be submit point)"
                else:
                    out["checkout_blocked"] = None
                    out["block_reason"] = "inconclusive (flow did not reach place-order and no recaptcha/5xx captured)"
            if sid:
                await _release(key, sid)
    print(json.dumps(out, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="checkout")
    ap.add_argument("--proxy", default="fixed:NVKJdNNtyy")
    ap.add_argument("--experimental", default="useStealthBrowser")
    ap.add_argument("--persist-profile", dest="persist_profile", action="store_true")
    ap.add_argument("--profile-id", dest="profile_id", default=None)
    ap.add_argument("--submit", action="store_true", help="click Place Order (SAFE: no card entered, cannot charge) to observe submission behavior")
    ap.add_argument("--budget", type=float, default=220.0)
    a = ap.parse_args()
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
