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


class _HandoffStop(Exception):
    """Raised to stop the flow at ready-to-place-order and leave the session live."""


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
        "timeout": getattr(a, "session_timeout_ms", 900000),
        "userAgent": UA_DEFAULT,
        "dimensions": {"width": 1288, "height": 891},
    }
    if a.experimental and not getattr(a, "reveal_bot", False):
        b["experimentalFeatures"] = [x for x in a.experimental.split(",") if x]
    if getattr(a, "reveal_bot", False):
        # Maximize detectability: datacenter IP (no proxy) + Steel injects nothing.
        b["useProxy"] = False
        b["stealthConfig"] = {"humanizeInteractions": False, "skipFingerprintInjection": True}
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


# Public, NON-CHARGEABLE test card (Stripe/processor test PAN). Declines at auth
# on a live processor -> cannot move money. Used only to probe checkout ordering.
TEST_CARD = {"number": "4242424242424242", "exp": "12/34", "mm": "12", "yy": "34", "cvc": "123", "zip": "94111"}


async def _fill_card(page):
    """Fill Toast's payment fields (hosted iframe(s)) with the test card. Returns dict of what filled + iframe diag."""
    filled = {"number": False, "exp": False, "cvc": False, "zip": False}
    diag = []
    # Toast hosted card iframe (payments.toasttab.com): fields by id + token autocomplete.
    sel_map = [
        ("number", ['#credit_card_number', 'input[autocomplete~="cc-number"]', 'input[aria-label*="card num" i]'],
         TEST_CARD["number"]),
        ("exp", ['#credit_card_exp', 'input[autocomplete~="cc-exp"]', 'input[aria-label*="expir" i]'],
         TEST_CARD["mm"] + TEST_CARD["yy"]),  # "1234" -> auto-formats to 12/34
        ("cvc", ['#credit_card_cvv', 'input[autocomplete~="cc-csc"]', 'input[aria-label*="security code" i]'],
         TEST_CARD["cvc"]),
        ("zip", ['#credit_card_zip', 'input[autocomplete~="postal-code"]', 'input[aria-label*="zip" i]'],
         TEST_CARD["zip"]),
    ]
    # Wait for the hosted payment iframe (payments.toasttab.com) + card field to load.
    pay_fr = None
    for _ in range(16):
        for f in page.frames:
            if "payments.toasttab.com" in (f.url or ""):
                pay_fr = f
                break
        if pay_fr:
            try:
                if await pay_fr.query_selector('#credit_card_number'):
                    break
            except Exception:
                pass
        await asyncio.sleep(1.0)

    # try main frame + every child frame (Toast card fields are in the hosted iframe)
    frames = ([pay_fr] if pay_fr else []) + [page.main_frame] + [f for f in page.frames if f != page.main_frame]
    for fr in frames:
        if fr is None:
            continue
        # select the NEW_CARD radio if present so fields are active
        try:
            radio = await fr.query_selector('#payment-option-NEW_CARD, input[name="payment-option"]')
            if radio:
                await radio.check(timeout=2000)
        except Exception:
            pass
        try:
            url = (fr.url or "")[:80]
            inputs = await fr.evaluate(
                """() => [...document.querySelectorAll('input')].map(e=>({
                    n:e.name||'', id:e.id||'', ac:e.autocomplete||'', al:e.getAttribute('aria-label')||'', t:e.type||''
                }))""")
            if inputs:
                diag.append({"frame": url, "inputs": inputs[:8]})
        except Exception:
            continue
        for key, sels, val in sel_map:
            if filled[key]:
                continue
            for s in sels:
                try:
                    el = await fr.query_selector(s)
                    if not el:
                        continue
                    # JS focus bypasses Playwright actionability on styled/secure fields;
                    # page.keyboard delivers real key events the field will accept.
                    await el.evaluate("e => { e.scrollIntoView({block:'center'}); e.focus(); }")
                    await asyncio.sleep(0.15)
                    await page.keyboard.type(val, delay=70)
                    await asyncio.sleep(0.15)
                    # confirm the field now holds a value (masked length is enough)
                    vlen = await el.evaluate("e => (e.value||'').length")
                    if vlen and vlen > 0:
                        filled[key] = vlen  # store observed length to diagnose partial fills
                        break
                except Exception:
                    continue
    return {"filled": filled, "iframe_diag": diag}


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


async def _fill_contact(page):
    """Fill Toast contact fields with REAL keyboard events (React controlled inputs
    ignore programmatic value-set; .type/keyboard delivers events React accepts)."""
    fields = [
        ("first", ['#yourInfoFirstName', 'input[autocomplete~="given-name"]', 'input[aria-label*="first name" i]'], GUEST["first"]),
        ("last", ['#yourInfoLastName', 'input[autocomplete~="family-name"]', 'input[aria-label*="last name" i]'], GUEST["last"]),
        ("email", ['#yourInfoEmail', 'input[autocomplete="email"]', 'input[type="email"]'], GUEST["email"]),
        ("phone", ['#yourInfoPhone', 'input[autocomplete~="tel"]', 'input[type="tel"]', 'input[aria-label*="phone" i]', 'input[name*="phone" i]'], GUEST["phone"]),
    ]
    out = {}
    for key, sels, val in fields:
        out[key] = 0
        for s in sels:
            try:
                el = await page.query_selector(s)
                if not el:
                    continue
                await el.evaluate("e => { e.scrollIntoView({block:'center'}); e.focus(); }")
                await asyncio.sleep(0.1)
                # clear anything already there, then type real keystrokes
                await page.keyboard.press("Control+A")
                await page.keyboard.press("Delete")
                await page.keyboard.type(val, delay=60)
                await asyncio.sleep(0.1)
                vlen = await el.evaluate("e => (e.value||'').length")
                if vlen and vlen > 0:
                    out[key] = vlen
                    break
            except Exception:
                continue
    return out


async def _card_state(page):
    """Read per-field DOM + validation state from the Toast payment iframe."""
    for fr in page.frames:
        if "payments.toasttab.com" not in (fr.url or ""):
            continue
        try:
            return await fr.evaluate(
                """() => {
                  const ids=['credit_card_number','credit_card_exp','credit_card_cvv','credit_card_zip'];
                  const out={};
                  for (const id of ids){
                    const e=document.getElementById(id);
                    if(!e){out[id]={present:false};continue;}
                    out[id]={present:true, value:(e.value||''), len:(e.value||'').length,
                      validityValid: (e.validity? e.validity.valid : null),
                      ariaInvalid: e.getAttribute('aria-invalid'),
                      cls:(e.className||'').toString().slice(0,80)};
                  }
                  // card brand + any visible error text in the iframe
                  const brand=[...document.querySelectorAll('[class*=brand i],[class*=card-type i],[data-card-type],img[alt*=card i]')]
                    .map(e=>e.getAttribute('data-card-type')||e.alt||e.className).filter(Boolean).slice(0,3);
                  const errs=[...document.querySelectorAll('[class*=error i],[class*=invalid i],[role=alert]')]
                    .map(e=>(e.innerText||'').trim()).filter(t=>t).slice(0,6);
                  return {fields:out, brand, errors:errs};
                }""")
        except Exception as e:
            return {"error": str(e)[:120]}
    return {"error": "no payments iframe"}


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
    timeline = []  # timestamped request/response events (recaptcha/order/payment)
    post_click = []  # EVERY request after the Place Order click (offset >= 0)
    console = []
    sid = None
    t_ref = {"t0": None}  # set at Place Order click for relative offsets
    _rx_submit = re.compile(r"recaptcha|gstatic.*recaptcha|/orders|placeOrder|place_order|payment|tokeniz|graphql|siteverify", re.I)

    def _classify(url):
        u = (url or "").lower()
        if "recaptcha" in u or "siteverify" in u:
            return "recaptcha"
        if "tokeniz" in u or "payment" in u or "card" in u:
            return "payment"
        if "/orders" in u or "placeorder" in u or "place_order" in u or "graphql" in u:
            return "order_submit"
        return "other"

    def _off():
        import time as _t
        return None if t_ref["t0"] is None else round(_t.monotonic() - t_ref["t0"], 2)

    def on_request(r):
        try:
            off = _off()
            if off is not None and off >= 0:
                post_click.append({"off": off, "method": r.method, "kind": _classify(r.url), "url": r.url[:150]})
            if _rx_submit.search(r.url or ""):
                timeline.append({"off": off, "ev": "req", "kind": _classify(r.url),
                                 "method": r.method, "url": r.url[:150]})
        except Exception:
            pass

    def on_response(r):
        try:
            if r.status >= 400:
                net.append({"status": r.status, "url": r.url[:180]})
            if _rx_submit.search(r.url or ""):
                submit_net.append({"status": r.status, "url": r.url[:160]})
                timeline.append({"off": _off(), "ev": "resp", "kind": _classify(r.url),
                                 "status": r.status, "url": r.url[:150]})
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
            page.on("request", on_request)
            page.on("response", on_response)
            page.on("console", on_console)
            if getattr(a, "reveal_bot", False):
                # Expose the automation flag so reCAPTCHA scores us as a bot.
                try:
                    await ctx.add_init_script(
                        "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>true,configurable:true});")
                    log(f"[{a.label}] REVEAL-BOT: navigator.webdriver=true injected, datacenter IP, no stealth")
                except Exception:
                    pass
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

            # ---- STEP 4: fill non-financial guest details (REAL keyboard events) ----
            contact = await _fill_contact(page)
            out["steps"].append({"step": "fill_guest", **contact})
            out["contact_fill"] = contact
            log(f"[{a.label}] fill_guest lengths: {contact}")
            if not all(contact.get(k) for k in ("first", "last", "email", "phone")):
                log(f"[{a.label}] WARNING: incomplete contact fill: {contact}")
            await asyncio.sleep(1.5)

            # ---- STEP 4b: entering the phone triggers Toast's OTP prompt; bypass via
            # "Checkout as guest" so we reach the real payment + Place Order step. ----
            guest = await _click_text(page, r"check ?out as guest|continue as guest|order as guest|guest check ?out|skip.*verif", timeout=6000)
            out["steps"].append({"step": "checkout_as_guest", "clicked": guest})
            log(f"[{a.label}] checkout_as_guest clicked={guest}")
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

            # ---- STEP 5c (OPT-IN): fill NON-CHARGEABLE test card 4242 ----
            # Public test PAN: declines at auth on a live processor -> cannot charge.
            # Purpose: prove whether reCAPTCHA fires BEFORE the payment/charge step.
            if (a.pay_test_card or a.handoff) and out["reached_place_order"]:
                card = await _fill_card(page)
                out["card_fill"] = card
                log(f"[{a.label}] TEST-CARD 4242 fill: {card['filled']}")
                # blur the card field so Toast tokenizes/validates before submit
                try:
                    await page.keyboard.press("Tab")
                    await asyncio.sleep(1.5)
                except Exception:
                    pass
                # re-check Place Order button state now that a card is entered
                try:
                    btn = await page.evaluate(
                        """() => { const rx=/place order/i;
                          for (const e of document.querySelectorAll('button,[role=button]')){
                            if(rx.test((e.innerText||'').trim()))
                              return {disabled:e.disabled===true||e.getAttribute('aria-disabled')==='true'};}
                          return {disabled:null}; }""")
                    out["place_order_disabled_after_card"] = btn.get("disabled")
                    log(f"[{a.label}] Place Order disabled after card: {btn.get('disabled')}")
                except Exception:
                    pass
                out["card_state_before_submit"] = await _card_state(page)
                cs = out["card_state_before_submit"]
                if isinstance(cs, dict) and cs.get("fields"):
                    log(f"[{a.label}] card validity: " + ", ".join(
                        f"{k.split('_')[-1]}={v.get('validityValid')}/{v.get('len')}" for k, v in cs["fields"].items())
                        + f" errors={cs.get('errors')}")

            # ---- HANDOFF: stop here, keep the session LIVE, print interactive URLs ----
            if a.handoff:
                out["handoff"] = True
                out["session_viewer_url"] = sess.get("sessionViewerUrl")
                out["debug_url"] = sess.get("debugUrl")
                out["ready_to_place_order"] = out["reached_place_order"] and isinstance(out.get("card_fill"), dict) \
                    and all(bool(v) for v in out["card_fill"].get("filled", {}).values())
                log(f"[{a.label}] HANDOFF READY ready_to_place_order={out['ready_to_place_order']}")
                log(f"[{a.label}] INTERACTIVE VIEWER: {sess.get('sessionViewerUrl')}")
                log(f"[{a.label}] session id: {sid} (stays live until timeout; NOT released)")
                # snapshot then return WITHOUT releasing (handled in finally via out['handoff'])
                out["final_body_text"] = (await _body_text(page))
                raise _HandoffStop()

            # ---- STEP 6 (OPT-IN): click Place Order to observe submission ordering ----
            # With --pay-test-card, the card cannot charge (declines), so this reveals
            # the reCAPTCHA-vs-payment ORDER without moving money.
            if a.submit and out["reached_place_order"]:
                submit_net.clear()
                timeline.clear()
                import time as _t
                t_ref["t0"] = _t.monotonic()  # timeline offsets relative to the click
                mode = "test-card 4242 (cannot charge)" if a.pay_test_card else "no card"
                log(f"[{a.label}] SUBMIT: clicking Place Order ({mode})")
                # Prefer a real mouse gesture at the button center (fully trusted, bypasses overlays)
                clicked = False
                try:
                    # scroll the button into view FIRST, then read its (now in-viewport) rect
                    box = await page.evaluate(
                        """() => { const rx=/^place order$/i;
                          for (const e of document.querySelectorAll('button,[role=button]')){
                            const t=(e.innerText||'').trim();
                            if(rx.test(t)){ e.scrollIntoView({block:'center'}); return true; }}
                          return false; }""")
                    if box:
                        await asyncio.sleep(0.6)
                        rect = await page.evaluate(
                            """() => { const rx=/^place order$/i;
                              for (const e of document.querySelectorAll('button,[role=button]')){
                                const t=(e.innerText||'').trim();
                                if(rx.test(t)){const r=e.getBoundingClientRect();
                                  if(r.width>0&&r.height>0) return {x:r.x+r.width/2,y:r.y+r.height/2,vh:window.innerHeight};}}
                              return null; }""")
                        if rect and 0 < rect["y"] < rect["vh"]:
                            # what element is actually on top at the click point? (detect overlay/interceptor)
                            top = await page.evaluate(
                                """([x,y]) => { const e=document.elementFromPoint(x,y);
                                  if(!e) return null;
                                  return {tag:e.tagName, txt:(e.innerText||'').trim().slice(0,40),
                                          cls:(e.className||'').toString().slice(0,60)}; }""", [rect["x"], rect["y"]])
                            out["click_point_top_element"] = top
                            log(f"[{a.label}] top element at click point: {top}")
                            await page.mouse.move(rect["x"], rect["y"])
                            await asyncio.sleep(0.1)
                            await page.mouse.click(rect["x"], rect["y"])
                            clicked = True
                            log(f"[{a.label}] mouse-clicked Place Order at ({round(rect['x'])},{round(rect['y'])}) vh={rect['vh']}")
                        else:
                            log(f"[{a.label}] button rect out of viewport after scroll: {rect}")
                except Exception as e:
                    log(f"[{a.label}] mouse click failed: {e}")
                if not clicked:
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
                          const rx=/recaptcha|could not|error|failed|try again|declined|verify|invalid|required|enter (a|your)|missing|please (enter|provide|add)|phone|payment/i;
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
                out["submit_network"] = submit_net[:40]
                out["submit_timeline"] = sorted([t for t in timeline if t.get("off") is not None], key=lambda x: x["off"])[:40]
                out["submit_recaptcha_calls"] = [n for n in submit_net if "recaptcha" in n["url"].lower() or "siteverify" in n["url"].lower()]
                out["submit_5xx"] = [n for n in submit_net if n["status"] >= 500]
                out["post_click_requests"] = sorted(post_click, key=lambda x: x["off"])[:40]
                out["card_state_after_submit"] = await _card_state(page)
                # did an INTERACTIVE reCAPTCHA challenge appear? (bframe = the puzzle popup)
                try:
                    out["recaptcha_challenge"] = await page.evaluate(
                        """() => ({
                          challengeBframe: !!document.querySelector('iframe[src*="recaptcha"][src*="bframe"]'),
                          recaptchaIframes: document.querySelectorAll('iframe[src*="recaptcha"]').length,
                          visibleChallenge: [...document.querySelectorAll('iframe[src*="bframe"]')]
                            .some(f=>{const r=f.getBoundingClientRect(); return r.width>10&&r.height>10;}),
                        })""")
                    log(f"[{a.label}] recaptcha_challenge={out['recaptcha_challenge']}")
                except Exception:
                    pass
                # capture any validation/error text INSIDE the payments iframe (not main doc)
                iframe_errs = []
                for fr in page.frames:
                    if "payments.toasttab.com" not in (fr.url or ""):
                        continue
                    try:
                        errs = await fr.evaluate(
                            """() => [...document.querySelectorAll('[class*=error i],[class*=invalid i],[role=alert],[aria-invalid=true]')]
                                .map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim()).filter(t=>t&&t.length<160).slice(0,8)""")
                        if errs:
                            iframe_errs += errs
                    except Exception:
                        pass
                out["payment_iframe_errors"] = iframe_errs
                out["order_confirmed"] = bool(re.search(r"order (confirmed|received|placed)|thank you|confirmation #|we'?ve got your order", after_txt, re.I))
                # ordering proof: earliest recaptcha vs earliest order_submit offset
                rc_offs = [t["off"] for t in out["submit_timeline"] if t["kind"] == "recaptcha"]
                os_offs = [t["off"] for t in out["submit_timeline"] if t["kind"] == "order_submit"]
                pay_offs = [t["off"] for t in out["submit_timeline"] if t["kind"] == "payment"]
                out["first_recaptcha_off"] = min(rc_offs) if rc_offs else None
                out["first_order_submit_off"] = min(os_offs) if os_offs else None
                out["first_payment_off"] = min(pay_offs) if pay_offs else None
                if rc_offs and os_offs:
                    out["recaptcha_before_order_submit"] = min(rc_offs) < min(os_offs)
                log(f"[{a.label}] SUBMIT result: banner={banner!r} confirmed={out['order_confirmed']} "
                    f"1st_recaptcha={out['first_recaptcha_off']} 1st_order={out['first_order_submit_off']} 1st_pay={out['first_payment_off']}")

            # snapshot page text for diagnosis
            out["final_body_text"] = (await _body_text(page))

        except _HandoffStop:
            pass  # intentional stop for handoff; session left live below
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
            if sid and not a.handoff:
                await _release(key, sid)
    print(json.dumps(out, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="checkout")
    ap.add_argument("--proxy", default="fixed:NVKJdNNtyy")
    ap.add_argument("--experimental", default="useStealthBrowser")
    ap.add_argument("--persist-profile", dest="persist_profile", action="store_true")
    ap.add_argument("--profile-id", dest="profile_id", default=None)
    ap.add_argument("--submit", action="store_true", help="click Place Order to observe submission ordering")
    ap.add_argument("--pay-test-card", dest="pay_test_card", action="store_true", help="fill NON-CHARGEABLE test card 4242 before submit (declines at auth, cannot charge)")
    ap.add_argument("--reveal-bot", dest="reveal_bot", action="store_true", help="MAXIMIZE detectability: datacenter IP + navigator.webdriver=true, to try to force a reCAPTCHA challenge at submit")
    ap.add_argument("--handoff", action="store_true", help="drive to ready-to-place-order (items+contact+test card), then STOP and keep the session live for interactive handoff")
    ap.add_argument("--session-timeout-min", dest="session_timeout_min", type=int, default=15, help="Steel session timeout in minutes (handoff wants longer)")
    ap.add_argument("--budget", type=float, default=220.0)
    a = ap.parse_args()
    # handoff needs a longer live window for the human to interact
    mins = max(a.session_timeout_min, 30 if a.handoff else a.session_timeout_min)
    a.session_timeout_ms = mins * 60 * 1000
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
