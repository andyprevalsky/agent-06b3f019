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


def create_session(skip_fp: bool, use_proxy: bool) -> dict:
    body = {
        "useProxy": use_proxy,
        "solveCaptcha": True,
        "stealthConfig": {
            "humanizeInteractions": False,
            "skipFingerprintInjection": skip_fp,
        },
        "timeout": 180000,
        "dimensions": {"width": 1288, "height": 891},
    }
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
    let seed=(Math.random()*1e9|0)^0x811c9dc5;
    const rand=()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};
    const perturb=(img)=>{const d=img&&img.data;if(!d||d.length===0)return img;const px=d.length>>>2,n=Math.min(64,px);for(let k=0;k<n;k++){const o=(Math.floor(rand()*px))<<2;d[o]=(d[o]+(rand()<0.5?1:-1)+256)&255;d[o+1]=(d[o+1]+(rand()<0.5?1:-1)+256)&255;d[o+2]=(d[o+2]+(rand()<0.5?1:-1)+256)&255;if(d[o+3]===0)d[o+3]=255;}return img;};
    const mask=(fn,name)=>{try{Object.defineProperty(fn,'toString',{value:()=>'function '+name+'() { [native code] }',configurable:true});}catch(e){}return fn;};
    const origGID=CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData=mask(function(sx,sy,sw,sh){const img=origGID.call(this,sx,sy,sw,sh);try{return perturb(img);}catch(e){return img;}},'getImageData');
    const origTDU=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=mask(function(){try{const w=this.width,h=this.height;if(w>0&&h>0){const ctx=this.getContext('2d');if(ctx){const img=origGID.call(ctx,0,0,w,h);perturb(img);ctx.putImageData(img,0,0);}}}catch(e){}return origTDU.apply(this,arguments);},'toDataURL');
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


async def run(args) -> None:
    from playwright.async_api import async_playwright

    session = create_session(skip_fp=args.skip_fp, use_proxy=not args.no_proxy)
    sid = session["id"]
    ws = f"wss://connect.steel.dev?apiKey={steel_key()}&sessionId={sid}"
    print(f"[{args.label}] session={sid} skip_fp={args.skip_fp} proxy={not args.no_proxy} "
          f"auto_override={args.auto_override} js_webdriver={args.js_webdriver}")
    verify_payload = {"holder": None}
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

            async def on_response(resp):
                if "/api/verify" in resp.url and resp.request.method == "POST":
                    try:
                        verify_payload["holder"] = await resp.json()
                    except Exception:
                        pass

            page.on("response", on_response)
            await page.goto(DEMO_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(1500)

            desc = await page.evaluate(DESCRIPTOR_PROBE)
            print(f"[{args.label}] webdriver descriptor: {json.dumps(desc)}")

            # Interact: checkbox (if present) + invisible-mode form submit.
            try:
                cb = await page.query_selector("input[type=checkbox], [role=checkbox]")
                if cb:
                    await cb.click(timeout=5000)
                    await page.wait_for_timeout(800)
            except Exception:
                pass
            try:
                email = await page.query_selector("input[type=email], input[name*=email i]")
                if email:
                    await email.click()
                    await email.type("benchmark-human@example.com", delay=90)
                msg = await page.query_selector("textarea, input[name*=message i]")
                if msg:
                    await msg.click()
                    await msg.type("Hello, I am interested in this product.", delay=85)
                submit = await page.query_selector("button[type=submit], button:has-text('Submit')")
                if submit:
                    await submit.click()
            except Exception as e:
                print(f"[{args.label}] interaction error: {e}")

            for _ in range(30):
                if verify_payload["holder"]:
                    break
                await page.wait_for_timeout(500)
            await browser.close()
    finally:
        release(sid)

    v = verify_payload["holder"]
    if not v:
        print(f"[{args.label}] NO /api/verify captured")
        return
    print(f"[{args.label}] === SCORE {round(v.get('score',0),3)} rec={v.get('recommendation')} ===")
    print(f"[{args.label}] categoryScores: {json.dumps(v.get('categoryScores',{}))}")
    for d in v.get("detections", []):
        print(f"[{args.label}]   {d.get('category'):12} {d.get('score')}  {d.get('reason')}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-fp", action="store_true", help="skipFingerprintInjection=true (Steel does NOT inject its stealth fingerprint)")
    ap.add_argument("--no-proxy", action="store_true", help="useProxy=false")
    ap.add_argument("--auto-override", action="store_true", help="apply Emulation.setAutomationOverride{enabled:false}")
    ap.add_argument("--js-webdriver", choices=list(WEBDRIVER_SPOOFS), default="none")
    ap.add_argument("--full-spoof", action="store_true", help="inject the full anti-detection script (console/webdriver/canvas/notifications/chrome)")
    ap.add_argument("--label", default="probe")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
