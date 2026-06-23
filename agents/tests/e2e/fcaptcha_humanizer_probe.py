#!/usr/bin/env python3
"""High-fidelity FCaptcha probe that drives the REAL BrowserHumanizer.

Unlike fcaptcha_probe.py (which uses crude Playwright clicks), this connects the
production `BrowserHumanizer` (synthesize_mouse_path + overshoot + keycap timing)
to a Steel session and exercises the exact webdecoy task flow: click the FCaptcha
checkbox, then fill + submit the invisible-mode contact form. It injects the same
`_ANTI_DETECTION_SCRIPT` the agent uses and captures the raw `/api/verify` request
signals (overshootCorrections, mouseEventRate, coalescedSamples, approachDirectness)
plus the response detections for EVERY verification, so we can tune the humanizer
against FCaptcha's exact Go-server thresholds in ~60s instead of a full agent run.

Usage:
  python tests/e2e/fcaptcha_humanizer_probe.py [--label NAME] [--no-proxy]
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
AGENTS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AGENTS_ROOT))
load_dotenv(REPO_ROOT / "back-end" / ".env")
load_dotenv(REPO_ROOT / "agents" / ".env")

from browser_tools.dom_service import DOMService, offcenter_click_point  # noqa: E402
from browser_tools.humanizer import BrowserHumanizer  # noqa: E402

DEMO_URL = "https://webdecoy.com/product/fcaptcha-demo/"


def steel_key() -> str:
    k = os.getenv("STEEL_API_KEY")
    if not k:
        raise SystemExit("STEEL_API_KEY missing in back-end/.env or agents/.env")
    return k


def create_session(use_proxy: bool, solve_captcha: bool = True) -> dict:
    body = {
        "useProxy": use_proxy,
        "solveCaptcha": solve_captcha,
        # skipFingerprintInjection=False so Steel masks the SwiftShader WebGL
        # renderer + plugins. The real agent achieves the same masking via the
        # backend's own user-fingerprint injection (injectionScripts.ts); this
        # probe doesn't replicate that, so we let Steel do it to approximate the
        # agent's WebGL-masked end state.
        "stealthConfig": {"humanizeInteractions": False, "skipFingerprintInjection": False},
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


class _DummyDomPage:
    """BrowserHumanizer only touches dom_page for the (disabled) visual cursor."""

    async def evaluate(self, *_a, **_k):
        return None


def _summarize(label: str, tag: str, sig: dict, resp: dict) -> None:
    beh = sig.get("behavioral", {}) if isinstance(sig, dict) else {}
    fcs = beh.get("inputForensics", {}) if isinstance(beh, dict) else {}
    temporal = sig.get("temporal", {}) if isinstance(sig, dict) else {}
    pow_d = temporal.get("pow", {}) if isinstance(temporal, dict) else {}
    if pow_d:
        it = pow_d.get("iterations", 0) or 0
        dur = pow_d.get("duration", 0) or 0
        exp_max = (it / 50000) * 1000 if it else 0
        print(
            f"[{label}/{tag}] POW duration={round(dur,1)}ms iterations={it} "
            f"difficulty={pow_d.get('difficulty')} expectedMax*3={round(exp_max*3,1)}ms "
            f"hashrate={round(it/(dur/1000),0) if dur else 0}/s"
        )
    print(
        f"[{label}/{tag}] SIGNALS rate={round(beh.get('mouseEventRate',0),2)} "
        f"overshoots={beh.get('overshootCorrections')} "
        f"approachDirect={round(beh.get('approachDirectness',0),3)} "
        f"velVar={round(beh.get('velocityVariance',0),5)} "
        f"avgVel={round(beh.get('avgVelocity',0),4)} "
        f"microTremor={round(beh.get('microTremorScore',0),3)} "
        f"dirChanges={beh.get('directionChanges')} "
        f"straightRatio={round(beh.get('straightLineRatio',0),3)} "
        f"trajLen={round(beh.get('trajectoryLength',0),1)} "
        f"totalPts={beh.get('totalPoints')} "
        f"coalSamp={fcs.get('coalescedSamples')} coalMax={fcs.get('coalescedMax')} "
        f"ptrZeroRatio={round(fcs.get('pointerMoveZeroRatio',0),3)}"
    )
    if resp:
        print(f"[{label}/{tag}] === SCORE {round(resp.get('score',0),3)} rec={resp.get('recommendation')} ===")
        print(f"[{label}/{tag}] categoryScores: {json.dumps(resp.get('categoryScores',{}))}")
        for d in resp.get("detections", []):
            print(f"[{label}/{tag}]   {d.get('category'):12} {d.get('score')}  {d.get('reason')}")
    else:
        print(f"[{label}/{tag}] NO /api/verify response captured")


async def _center(page, selector):
    """Return a human-like off-center click point inside the element, using the
    SAME helper the agent's get_element_coordinates uses (so the probe faithfully
    measures the production click-precision behavior)."""
    el = await page.query_selector(selector)
    if not el:
        return None, None
    box = await el.bounding_box()
    if not box:
        return None, None
    return offcenter_click_point(
        box["x"] + box["width"] / 2,
        box["y"] + box["height"] / 2,
        box["width"],
        box["height"],
    )


async def run(args) -> None:
    from playwright.async_api import async_playwright

    session = create_session(use_proxy=not args.no_proxy, solve_captcha=not args.no_captcha_solver)
    sid = session["id"]
    ws = f"wss://connect.steel.dev?apiKey={steel_key()}&sessionId={sid}"
    print(f"[{args.label}] session={sid} proxy={not args.no_proxy} (real BrowserHumanizer)")

    verifications: list[tuple[dict, dict]] = []
    pending = {"sig": None}

    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(ws, timeout=60000)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            await context.add_init_script(DOMService._ANTI_DETECTION_SCRIPT)
            page = context.pages[0] if context.pages else await context.new_page()

            def on_request(req):
                if "/api/verify" in req.url and req.method == "POST":
                    try:
                        body = req.post_data
                        if body:
                            data = json.loads(body)
                            sj = data.get("signalsJson")
                            parsed = json.loads(sj) if sj else data.get("signals")
                            # powTiming is sent as a SEPARATE top-level field (not in
                            # signalsJson); fold it into temporal.pow so the summary
                            # can report the solve duration the server thresholds on.
                            pt = data.get("powTiming")
                            if pt and isinstance(parsed, dict):
                                parsed.setdefault("temporal", {})["pow"] = pt
                            pending["sig"] = parsed
                    except Exception as e:
                        print(f"[{args.label}] req parse err: {e}")

            async def on_response(resp):
                if "/api/verify" in resp.url and resp.request.method == "POST":
                    try:
                        body = await resp.json()
                    except Exception:
                        body = None
                    verifications.append((pending["sig"] or {}, body or {}))
                    pending["sig"] = None

            page.on("request", on_request)
            page.on("response", on_response)

            await page.goto(DEMO_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(1800)

            humanizer = BrowserHumanizer(dom_page=_DummyDomPage(), input_page=page, fast=False)
            await humanizer.initialize_cursor((640, 700))
            humanizer.start_idle_movement()

            # A human scrolls/reads first (clears no-scroll, pushes first-interaction
            # timing well past the 100ms floor).
            await humanizer.scroll(260)
            await page.wait_for_timeout(500)
            await humanizer.scroll(-140)
            await page.wait_for_timeout(600)

            # 1) Checkbox-mode verification.
            cx, cy = await _center(page, ".fcaptcha-checkbox")
            if cx is not None:
                await humanizer.click_at_coords(int(cx), int(cy), overshoot=True)
                for _ in range(24):
                    if verifications:
                        break
                    await page.wait_for_timeout(500)
            else:
                print(f"[{args.label}] no .fcaptcha-checkbox found")

            # 2) Invisible-mode contact form. Scroll each field into view and read
            # its coordinates FRESH right before interacting (the agent does the
            # same via get_element_coordinates -> scrollIntoViewIfNeeded); stale
            # coords from before a scroll land off-screen.
            async def _interact(selector, typed=None, overshoot=False):
                el = await page.query_selector(selector)
                if not el:
                    return False
                try:
                    await el.scroll_into_view_if_needed(timeout=4000)
                    await page.wait_for_timeout(250)
                except Exception:
                    pass
                box = await el.bounding_box()
                if not box:
                    return False
                px, py = offcenter_click_point(
                    box["x"] + box["width"] / 2, box["y"] + box["height"] / 2,
                    box["width"], box["height"],
                )
                await humanizer.click_at_coords(int(px), int(py), overshoot=overshoot)
                if typed:
                    await humanizer.type_text(typed)
                return True

            try:
                await _interact("input[type=email], input[name*=email i]", typed="benchmark-human@example.com")
                await _interact("textarea, input[name*=message i]", typed="Hello, I am interested in this product.")
                before = len(verifications)
                if await _interact("button[type=submit], button:has-text('Submit')", overshoot=True):
                    for _ in range(30):
                        if len(verifications) > before:
                            break
                        await page.wait_for_timeout(500)
            except Exception as e:
                print(f"[{args.label}] form error: {e}")

            await humanizer.close()
            await browser.close()
    finally:
        release(sid)

    if not verifications:
        print(f"[{args.label}] NO verifications captured")
        return
    tags = ["checkbox", "form", "extra3", "extra4"]
    for i, (sig, resp) in enumerate(verifications):
        _summarize(args.label, tags[i] if i < len(tags) else f"v{i}", sig, resp)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-proxy", action="store_true")
    ap.add_argument("--no-captcha-solver", action="store_true", help="solveCaptcha=false (frees Steel CPU otherwise spent auto-solving)")
    ap.add_argument("--label", default="HUMZ")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
