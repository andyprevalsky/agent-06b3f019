#!/usr/bin/env python3
"""Fast FCaptcha anti-detection probe.

Creates a Steel session with configurable stealth/proxy options, connects via
Playwright CDP, optionally applies the automation override + a webdriver spoof,
navigates the live WebDecoy FCaptcha demo, submits the form, and prints BOTH the
live navigator.webdriver descriptor and the /api/verify risk breakdown.

This decouples anti-detection iteration from the full Temporal/agent stack so we
can measure each lever in ~45s. NOT part of the offline suite.

Usage:
  python tests/e2e/fcaptcha_probe.py [--skip-fp] [--no-proxy] [--auto-override]
        [--js-webdriver none|configurable|nonconfigurable] [--label NAME]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(REPO_ROOT / "back-end" / ".env")
load_dotenv(REPO_ROOT / "agents" / ".env")

DEMO_URL = "https://webdecoy.com/product/fcaptcha-demo/"


def steel_key() -> str:
    k = os.getenv("STEEL_API_KEY")
    if not k:
        raise SystemExit("STEEL_API_KEY missing in back-end/.env or agents/.env")
    return k


def _proxy_value(proxy_spec: str | None, use_proxy: bool):
    """Resolve --proxy into a useProxy value. None -> bool use_proxy."""
    if not proxy_spec:
        return use_proxy
    if proxy_spec in ("none", "false"):
        return False
    if proxy_spec == "true":
        return True
    if proxy_spec == "fixed":
        return {"type": "fixed"}
    if proxy_spec.startswith("fixed:"):
        return {"type": "fixed", "id": proxy_spec}
    if proxy_spec.startswith("geo:"):
        parts = proxy_spec[4:].split("/")
        g = {"country": parts[0]}
        if len(parts) > 1 and parts[1]:
            g["state"] = parts[1]
        if len(parts) > 2 and parts[2]:
            g["city"] = parts[2]
        return {"geolocation": g}
    return use_proxy


def create_session(skip_fp: bool, use_proxy: bool, proxy_spec: str | None = None,
                   experimental: str | None = None, persist_profile: bool = False,
                   profile_id: str | None = None) -> dict:
    body = {
        "useProxy": _proxy_value(proxy_spec, use_proxy),
        "solveCaptcha": True,
        "stealthConfig": {
            "humanizeInteractions": False,
            "skipFingerprintInjection": skip_fp,
        },
        "timeout": 180000,
        "dimensions": {"width": 1288, "height": 891},
    }
    if experimental:
        body["experimentalFeatures"] = [x for x in experimental.split(",") if x]
    if persist_profile or profile_id:
        body["persistProfile"] = True
    if profile_id:
        body["profileId"] = profile_id
    r = requests.post(
        "https://api.steel.dev/v1/sessions",
        headers={"steel-api-key": steel_key(), "content-type": "application/json"},
        json=body,
        timeout=45,
    )
    if r.status_code >= 400:
        raise SystemExit(f"session create failed {r.status_code}: {r.text[:400]}")
    return r.json()


def release(session_id: str) -> None:
    try:
        requests.post(
            f"https://api.steel.dev/v1/sessions/{session_id}/release",
            headers={"steel-api-key": steel_key()},
            json={},
            timeout=20,
        )
    except Exception:
        pass


FULL_SPOOF = r"""
(function () {
  'use strict';
  try { for (const m of ['debug','log','info','warn','error','trace','dir','dirxml','table','group','groupCollapsed','groupEnd','assert','count','countReset','time','timeEnd','timeLog','profile','profileEnd']) { try { const fn=function(){}; Object.defineProperty(fn,'toString',{value:()=>'function '+m+'() { [native code] }',configurable:true}); Object.defineProperty(console,m,{value:fn,writable:true,configurable:true}); } catch(e){} } } catch(e){}
  try { Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:false,enumerable:true}); } catch(e){ try{delete Navigator.prototype.webdriver;}catch(e2){} }
  try { if (typeof Notification!=='undefined') Object.defineProperty(Notification,'permission',{get:()=>'default',configurable:true}); } catch(e){}
  try { if(!window.chrome){Object.defineProperty(window,'chrome',{value:{runtime:{},app:{isInstalled:false},csi:function(){},loadTimes:function(){}},configurable:true,writable:true});} else if(!window.chrome.runtime){window.chrome.runtime={};} } catch(e){}
  try {
    const sessionSeed=((Math.random()*1e9)|0)^0x811c9dc5;
    const mkRand=(s)=>()=>{s=(s+0x6d2b79f5)|0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};
    const perturb=(img)=>{const d=img&&img.data;if(!d||d.length===0)return img;const px=d.length>>>2;if(px===0||px>600*600)return img;const rand=mkRand((sessionSeed^Math.imul(px,2654435761))>>>0);for(let i=0;i<px;i++){const o=i<<2;d[o]=(d[o]+((rand()*6)|0))&255;d[o+1]=(d[o+1]+((rand()*6)|0))&255;d[o+2]=(d[o+2]+((rand()*6)|0))&255;}return img;};
    const mask=(fn,name)=>{try{Object.defineProperty(fn,'toString',{value:()=>'function '+name+'() { [native code] }',configurable:true});}catch(e){}return fn;};
    const origGID=CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData=mask(function(sx,sy,sw,sh){const img=origGID.call(this,sx,sy,sw,sh);try{return perturb(img);}catch(e){return img;}},'getImageData');
    const origTDU=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=mask(function(...args){try{const w=this.width,h=this.height;if(w>0&&h>0&&w<=600&&h<=600){const ctx=this.getContext('2d');if(ctx){const img=origGID.call(ctx,0,0,w,h);perturb(img);const tmp=document.createElement('canvas');tmp.width=w;tmp.height=h;const tctx=tmp.getContext('2d');if(tctx){tctx.putImageData(img,0,0);return origTDU.apply(tmp,args);}}}}catch(e){}return origTDU.apply(this,args);},'toDataURL');
  } catch(e){}
})();
"""

WEBDRIVER_SPOOFS = {
    "none": "",
    "configurable": "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:true,enumerable:true});",
    "nonconfigurable": "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:false,enumerable:true});",
}

DESCRIPTOR_PROBE = """() => {
  const proto = Object.getPrototypeOf(navigator);
  const d = Object.getOwnPropertyDescriptor(proto, 'webdriver');
  return {
    value: navigator.webdriver,
    hasDesc: !!d,
    configurable: d ? d.configurable : null,
    enumerable: d ? d.enumerable : null,
    getterNative: d && d.get ? /\\[native code\\]/.test(d.get.toString()) : null,
  };
}"""

# Mirrors FCaptcha's _getCanvasHash exactly so we can see why it reports
# "canvas blocked or failed" (exception => supported:false, or a short/blank
# dataUrl) and whether our toDataURL spoof produced a substantial value.
CANVAS_PROBE = """() => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('FCaptcha', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'; ctx.fillText('FCaptcha', 4, 17);
    const dataUrl = canvas.toDataURL();
    const dataUrl2 = canvas.toDataURL();
    return { supported: true, dataLength: dataUrl.length, head: dataUrl.slice(0, 40),
             stableAcrossReads: dataUrl === dataUrl2,
             toDataURLNative: /\\[native code\\]/.test(HTMLCanvasElement.prototype.toDataURL.toString()) };
  } catch (e) {
    return { supported: false, error: String(e) };
  }
}"""


async def humanized_submit(page, args) -> None:
    """Drive a human-like cursor path to the submit button via CDP mouse input.

    Mirrors what humanizer.py does in the real agent: a wobbling approach, an
    overshoot that crosses the target's bounding-rect edge, a re-entry, then a
    decoupled down/up. Produces overshootCorrections>=1 and keeps the mouse-event
    window dense enough for mouseEventRate to clear FCaptcha's >=10/sec floor.
    """
    import math

    # The live demo triggers verification on the FCaptcha checkbox, not a form
    # submit. analyzeClick uses the clicked element's rect, so the overshoot must
    # cross THIS element's edge.
    target = await page.query_selector(".fcaptcha-checkbox")
    if not target:
        target = await page.query_selector("button[type=submit], button:has-text('Submit')")
    if not target:
        print(f"[{args.label}] no checkbox/submit target found")
        return
    box = await target.bounding_box()
    if not box:
        await target.click()
        return
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2
    # Start the approach from up-and-left of the button.
    sx, sy = cx - 280, cy - 190

    steps = max(4, args.approach_steps)
    delay = args.step_delay_ms
    await page.mouse.move(sx, sy)
    for i in range(1, steps + 1):
        t = i / steps
        # Lateral wobble (sinusoid) keeps approachDirectness < 0.95 (vision_ai).
        wob = math.sin(t * math.pi) * 14
        x = sx + (cx - sx) * t + wob
        y = sy + (cy - sy) * t - wob * 0.4
        await page.mouse.move(x, y)
        await page.wait_for_timeout(delay)

    # Overshoot: cross the bottom edge by overshoot_px so the cursor exits the
    # rect (enter->exit), then re-enter to register an overshoot correction.
    oy = box["y"] + box["height"] + args.overshoot_px
    await page.mouse.move(cx + 6, oy)
    await page.wait_for_timeout(args.dwell_ms)
    # Re-enter to just inside the button (slightly off-center, human imprecision).
    await page.mouse.move(cx - 3, cy + 2)
    await page.wait_for_timeout(args.dwell_ms)
    await page.mouse.down()
    await page.wait_for_timeout(45)
    await page.mouse.up()


async def run(args) -> None:
    from playwright.async_api import async_playwright

    session = create_session(skip_fp=args.skip_fp, use_proxy=not args.no_proxy,
                             proxy_spec=args.proxy, experimental=args.experimental,
                             persist_profile=args.persist_profile, profile_id=args.profile_id)
    sid = session["id"]
    ws = f"wss://connect.steel.dev?apiKey={steel_key()}&sessionId={sid}"
    print(f"[{args.label}] session={sid} skip_fp={args.skip_fp} proxy={args.proxy or (not args.no_proxy)} "
          f"experimental={args.experimental} profileId={session.get('profileId')} "
          f"auto_override={args.auto_override} js_webdriver={args.js_webdriver}")
    cap = {"resp": None, "req_signals": None}
    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(ws, timeout=60000)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            if args.auto_override:
                try:
                    page0 = context.pages[0] if context.pages else await context.new_page()
                    cdp = await context.new_cdp_session(page0)
                    await cdp.send("Emulation.setAutomationOverride", {"enabled": False})
                    print(f"[{args.label}] setAutomationOverride enabled=false OK")
                except Exception as e:
                    print(f"[{args.label}] setAutomationOverride FAILED: {e}")
            if args.full_spoof:
                await context.add_init_script(FULL_SPOOF)
            js = WEBDRIVER_SPOOFS[args.js_webdriver]
            if js:
                await context.add_init_script(js)
            page = context.pages[0] if context.pages else await context.new_page()

            def on_request(req):
                if "/api/verify" in req.url and req.method == "POST":
                    try:
                        body = req.post_data
                        if body:
                            data = json.loads(body)
                            sj = data.get("signalsJson")
                            cap["req_signals"] = json.loads(sj) if sj else data.get("signals")
                    except Exception as e:
                        print(f"[{args.label}] req parse err: {e}")

            async def on_response(resp):
                if "/api/verify" in resp.url and resp.request.method == "POST":
                    try:
                        cap["resp"] = await resp.json()
                    except Exception:
                        pass

            page.on("request", on_request)
            page.on("response", on_response)
            await page.goto(DEMO_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(1500)

            desc = await page.evaluate(DESCRIPTOR_PROBE)
            print(f"[{args.label}] webdriver descriptor: {json.dumps(desc)}")
            canvas = await page.evaluate(CANVAS_PROBE)
            print(f"[{args.label}] canvas probe: {json.dumps(canvas)}")

            # A human scrolls + reads before interacting (clears the no-scroll flag
            # and pushes first-interaction-timing well past the 100ms floor).
            try:
                await page.mouse.wheel(0, 240)
                await page.wait_for_timeout(350)
                await page.mouse.wheel(0, -120)
                await page.wait_for_timeout(400)
            except Exception:
                pass

            # Fill the form (keyboard only — no stray mouse moves to pollute the
            # cursor-event budget that the CDP "never coalesced" detector watches).
            try:
                email = await page.query_selector("input[type=email], input[name*=email i]")
                if email:
                    await email.focus()
                    await email.type("benchmark-human@example.com", delay=90)
                msg = await page.query_selector("textarea, input[name*=message i]")
                if msg:
                    await msg.focus()
                    await msg.type("Hello, I am interested in this product.", delay=85)
            except Exception as e:
                print(f"[{args.label}] fill error: {e}")

            # Submit with a tunable humanized cursor path (approach -> overshoot
            # past an edge -> re-enter -> click), so overshootCorrections>=1 and
            # mouseEventRate lands in (10,200) without exceeding the coalesced cap.
            try:
                if args.humanize:
                    await humanized_submit(page, args)
                else:
                    trigger = await page.query_selector(".fcaptcha-checkbox")
                    if not trigger:
                        trigger = await page.query_selector("button[type=submit], button:has-text('Submit')")
                    if trigger:
                        await trigger.click()
            except Exception as e:
                print(f"[{args.label}] submit error: {e}")

            for _ in range(40):
                if cap["resp"]:
                    break
                await page.wait_for_timeout(500)
            await browser.close()
    finally:
        release(sid)

    sig = cap["req_signals"] or {}
    beh = sig.get("behavioral", {}) if isinstance(sig, dict) else {}
    fcs = beh.get("inputForensics", {}) if isinstance(beh, dict) else {}
    if beh:
        print(f"[{args.label}] BEHAVIORAL signals: "
              f"totalPoints={beh.get('totalPoints')} "
              f"mouseEventRate={round(beh.get('mouseEventRate',0),2)} "
              f"trajLen={round(beh.get('trajectoryLength',0),1)} "
              f"overshoots={beh.get('overshootCorrections')} "
              f"coalescedSamples={fcs.get('coalescedSamples')} "
              f"coalescedMax={fcs.get('coalescedMax')} "
              f"ptrMoveSamples={fcs.get('pointerMoveSamples')} "
              f"ptrMoveZeroRatio={round(fcs.get('pointerMoveZeroRatio',0),3)}")

    v = cap["resp"]
    if not v:
        print(f"[{args.label}] NO /api/verify response captured")
        return
    print(f"[{args.label}] === SCORE {round(v.get('score',0),3)} rec={v.get('recommendation')} ===")
    print(f"[{args.label}] categoryScores: {json.dumps(v.get('categoryScores',{}))}")
    for d in v.get("detections", []):
        print(f"[{args.label}]   {d.get('category'):12} {d.get('score')}  {d.get('reason')}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-fp", action="store_true", help="skipFingerprintInjection=true (Steel does NOT inject its stealth fingerprint)")
    ap.add_argument("--no-proxy", action="store_true", help="useProxy=false")
    ap.add_argument("--proxy", default=None, help="proxy spec: none|true|fixed|fixed:<id>|geo:US (overrides --no-proxy)")
    ap.add_argument("--experimental", default=None, help="comma-separated experimentalFeatures, e.g. useStealthBrowser")
    ap.add_argument("--persist-profile", dest="persist_profile", action="store_true")
    ap.add_argument("--profile-id", dest="profile_id", default=None)
    ap.add_argument("--auto-override", action="store_true", help="apply Emulation.setAutomationOverride{enabled:false}")
    ap.add_argument("--js-webdriver", choices=list(WEBDRIVER_SPOOFS), default="none")
    ap.add_argument("--full-spoof", action="store_true", help="inject the full anti-detection script (console/webdriver/canvas/notifications/chrome)")
    ap.add_argument("--humanize", action="store_true", help="drive a humanized cursor path (overshoot+reentry) to the submit button")
    ap.add_argument("--approach-steps", type=int, default=10, help="number of approach mousemoves before overshoot")
    ap.add_argument("--overshoot-px", type=int, default=14, help="px past the button's bottom edge to overshoot")
    ap.add_argument("--dwell-ms", type=int, default=70, help="dwell after overshoot and after re-entry")
    ap.add_argument("--step-delay-ms", type=int, default=40, help="delay between approach mousemoves (controls event rate)")
    ap.add_argument("--label", default="probe")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
