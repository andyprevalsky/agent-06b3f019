"""Steel renderer single-thread CPU benchmark.

The toast bot-challenge pins the Steel renderer's main thread for ~84s.
That work is single-threaded JS/WASM, so its wall time scales with the
renderer's single-thread CPU speed. This measures that speed directly by
running a fixed CPU-bound JS workload on about:blank (no challenge), on
Steel vs local Chromium.

ratio = steel_ms / local_ms  ==  how much faster the challenge would clear
on a local-class CPU. If Steel is ~Nx slower, the 84s freeze would be
~84/N s on a faster box — i.e. how much a "more powerful CPU" would help.

Usage:
  cd agents && source .env && venv/bin/python tests/e2e/steel_cpu_benchmark.py            # Steel
  cd agents && source .env && venv/bin/python tests/e2e/steel_cpu_benchmark.py --local    # local
"""

from __future__ import annotations

import argparse
import asyncio
import os

import httpx
from playwright.async_api import async_playwright

STEEL_API = "https://api.steel.dev/v1/sessions"

# Fixed CPU-bound workloads. Pure compute, no allocation churn, deterministic.
WORKLOAD = """() => {
  const runs = [];
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    let x = 0;
    for (let i = 1; i < 300000000; i++) { x += Math.sqrt(i) * 1.0000001; x = x % 1e9; }
    runs.push(Math.round(performance.now() - t));
  }
  return { runs, hw: navigator.hardwareConcurrency, ua: navigator.userAgent };
}"""


async def _create(key):
    body = {"useProxy": False, "solveCaptcha": False, "timeout": 300000, "dimensions": {"width": 1288, "height": 891}}
    async with httpx.AsyncClient(timeout=60.0) as c:
        r = await c.post(STEEL_API, headers={"steel-api-key": key, "Content-Type": "application/json"}, json=body)
    r.raise_for_status()
    return r.json()


async def _release(key, sid):
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            await c.post(f"{STEEL_API}/{sid}/release", headers={"steel-api-key": key})
    except Exception:
        pass


async def run(local: bool):
    key = os.environ.get("STEEL_API_KEY") or os.environ.get("BROWSERBASE_API_KEY") or ""
    sid = None
    async with async_playwright() as pw:
        if local:
            browser = await pw.chromium.launch(headless=True)
            label = "LOCAL"
        else:
            if not key:
                raise SystemExit("STEEL_API_KEY not set")
            sess = await _create(key)
            sid = sess["id"]
            browser = await pw.chromium.connect_over_cdp(f"wss://connect.steel.dev?apiKey={key}&sessionId={sid}")
            label = "STEEL"
        try:
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto("about:blank")
            res = await page.evaluate(WORKLOAD)
            runs = res["runs"]
            print(f"\n=== {label} renderer CPU benchmark ===")
            print(f"hardwareConcurrency: {res['hw']}")
            print(f"userAgent: {res['ua'][:90]}")
            print(f"workload runs (ms): {runs}")
            print(f"best: {min(runs)}ms   median: {sorted(runs)[len(runs)//2]}ms")
        finally:
            if sid:
                await _release(key, sid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true")
    a = ap.parse_args()
    asyncio.run(run(a.local))


if __name__ == "__main__":
    main()
