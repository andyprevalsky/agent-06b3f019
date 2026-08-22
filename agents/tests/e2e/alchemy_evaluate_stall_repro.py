"""Clean local repro for the alchemy evaluate stall (agent 01dce6e9).

Findings (see docs/rca/cases/2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery.md):

A) Exact browser_use_step_23/24 evaluate JS against a Momence-like Konva Stage
   completes in milliseconds — the evaluate *payload* is fine.

B) When the renderer main thread is already blocked *before* CDP Runtime.evaluate
   is sent, the same step-24 JS hangs; Browser.getVersion stays OK; soft recovery
   matches prod (bring_to_front ok, Escape times out); evaluate after soft still
   hangs; a new page evaluates fine. This is the live recovery signature.

C) Cancelling an in-flight awaitPromise evaluate via asyncio.wait_for does NOT
   poison the page — retries succeed. The hang is not "cancel left CDP wedged"
   for promise-style waits.

Usage:
  cd agents && venv/bin/python tests/e2e/alchemy_evaluate_stall_repro.py
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from playwright.async_api import async_playwright

FIX = Path(__file__).resolve().parent / "fixtures" / "momence_konva_signature.html"

# Exact payloads from agent 01dce6e9 browser_use_step_23 / step_24 LLM dumps.
STEP23 = (
    "(()=>{try{const c=document.querySelector('canvas'); if(c){const r=c.getBoundingClientRect(); "
    "const ctx=c.getContext('2d'); ctx.beginPath();ctx.moveTo(20,30);ctx.lineTo(90,10);ctx.lineTo(150,35);"
    "ctx.stroke(); c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+20,"
    "clientY:r.top+30,pointerId:1}));c.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,"
    "clientX:r.left+100,clientY:r.top+20,pointerId:1}));c.dispatchEvent(new PointerEvent('pointerup',"
    "{bubbles:true,clientX:r.left+150,clientY:r.top+35,pointerId:1}));return 'signed canvas';} "
    "const el=document.querySelector('[role=presentation]'); if(el){const r=el.getBoundingClientRect(); "
    "['pointerdown','pointermove','pointerup'].forEach((t,i)=>el.dispatchEvent(new PointerEvent(t,"
    "{bubbles:true,clientX:r.left+20+i*60,clientY:r.top+20+(i%2)*10,pointerId:1,"
    "buttons:t==='pointerup'?0:1})));return {tag:el.tagName,html:el.outerHTML.slice(0,500)};} "
    "return 'none';}catch(e){return String(e)}})()"
)

STEP24 = (
    "(()=>{try{const c=document.querySelector('canvas');if(!c)return 'no canvas';"
    "const r=c.getBoundingClientRect();const pts=[[20,30],[40,20],[60,40],[80,15],[100,35],[130,20]];"
    "for(let i=0;i<pts.length;i++){const [x,y]=pts[i]; "
    "const type=i===0?'mousedown':i===pts.length-1?'mouseup':'mousemove';"
    "c.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:r.left+x,clientY:r.top+y,"
    "buttons:type==='mouseup'?0:1}));} return {w:c.width,h:c.height,"
    "buttons:[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('Accept'))"
    ".map(b=>({disabled:b.disabled}))};}catch(e){return String(e)}})()"
)


async def runtime_eval(cdp, expression: str, timeout: float) -> dict:
    t0 = time.monotonic()
    try:
        result = await asyncio.wait_for(
            cdp.send(
                "Runtime.evaluate",
                {"expression": expression, "returnByValue": True, "awaitPromise": True},
            ),
            timeout=timeout,
        )
        return {
            "status": "ok",
            "ms": round((time.monotonic() - t0) * 1000),
            "value": (result.get("result") or {}).get("value"),
        }
    except Exception as exc:
        return {
            "status": type(exc).__name__,
            "ms": round((time.monotonic() - t0) * 1000),
            "error": str(exc)[:160],
        }


async def soft_recovery(page) -> list[str]:
    actions: list[str] = []
    try:
        await asyncio.wait_for(page.bring_to_front(), timeout=2.0)
        actions.append("bring_to_front")
    except Exception as exc:
        actions.append(f"bring_to_front:{type(exc).__name__}")
    try:
        await asyncio.wait_for(page.keyboard.press("Escape"), timeout=2.0)
        actions.append("press_escape")
    except Exception as exc:
        actions.append(f"press_escape:{type(exc).__name__}")
    return actions


async def main() -> None:
    report: dict = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 800})

        page = await context.new_page()
        await page.goto(FIX.as_uri(), wait_until="networkidle")
        cdp = await context.new_cdp_session(page)
        report["A_healthy"] = {
            "step23": await runtime_eval(cdp, STEP23, 5.0),
            "step24": await runtime_eval(cdp, STEP24, 5.0),
        }

        page_b = await context.new_page()
        await page_b.goto(FIX.as_uri(), wait_until="networkidle")
        cdp_b = await context.new_cdp_session(page_b)
        browser_cdp = await browser.new_browser_cdp_session()
        await cdp_b.send(
            "Runtime.evaluate",
            {
                "expression": "setTimeout(() => { while (true) {} }, 0)",
                "returnByValue": True,
                "awaitPromise": False,
            },
        )
        await asyncio.sleep(0.2)
        hung = await runtime_eval(cdp_b, STEP24, 3.0)
        rend = await runtime_eval(cdp_b, "1+1", 2.0)
        t0 = time.monotonic()
        try:
            await asyncio.wait_for(browser_cdp.send("Browser.getVersion"), timeout=2.0)
            brow = {"status": "ok", "ms": round((time.monotonic() - t0) * 1000)}
        except Exception as exc:
            brow = {"status": type(exc).__name__, "ms": round((time.monotonic() - t0) * 1000)}
        soft = await soft_recovery(page_b)
        after_soft = await runtime_eval(cdp_b, "1+1", 2.0)
        page_new = await context.new_page()
        await page_new.goto("about:blank")
        hard = await runtime_eval(await context.new_cdp_session(page_new), "1+1", 2.0)
        report["B_preblocked_renderer"] = {
            "step24_during_block": hung,
            "renderer_ping": rend,
            "browser_ping": brow,
            "soft_recovery": soft,
            "evaluate_after_soft": after_soft,
            "evaluate_new_page": hard,
        }

        page_c = await context.new_page()
        await page_c.goto(FIX.as_uri(), wait_until="networkidle")
        cdp_c = await context.new_cdp_session(page_c)
        cancelled = await runtime_eval(
            cdp_c,
            "(async () => { await new Promise(r => setTimeout(r, 10000)); return 42; })()",
            1.0,
        )
        await asyncio.sleep(0.3)
        report["C_cancel_awaitPromise"] = {
            "cancelled_long_promise": cancelled,
            "retry_1plus1": await runtime_eval(cdp_c, "1+1", 5.0),
            "retry_step24": await runtime_eval(cdp_c, STEP24, 5.0),
        }

        try:
            await asyncio.wait_for(browser.close(), timeout=5.0)
        except Exception:
            proc = getattr(browser, "process", None)
            if proc is not None and getattr(proc, "pid", None):
                proc.kill()

    out = Path("/opt/cursor/artifacts/alchemy_evaluate_stall_repro.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print("WROTE", out)


if __name__ == "__main__":
    asyncio.run(main())
