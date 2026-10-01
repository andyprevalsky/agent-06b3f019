#!/usr/bin/env python3
"""Profile the per-step browser observe cost on a real Kernel browser.

Creates one stealth Kernel browser (same shape as the backend's
``providers/browser/kernel.ts``), connects ``DOMService`` exactly like the
browser agent, navigates prod-like heavy pages, and times the per-step
non-LLM work the agent loop does before each decision:
overlay suppression, ``get_browser_state`` (DOM + screenshot), and the
browser-use state request on its own.

    cd agents && PYTHONPATH=. venv/bin/python benchmarks/browser_observe_profile.py
    ... --url https://www.amazon.com/s?k=usb+c+cable --samples 5 --json out.json

The browser is always deleted on exit (including Ctrl-C).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List

import httpx

AGENTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTS_DIR))

from dotenv import load_dotenv

load_dotenv(AGENTS_DIR / ".env")
load_dotenv(AGENTS_DIR.parent / "back-end" / ".env")

os.environ.setdefault("BROWSER_PROVIDER", "kernel")

from browser_tools.dom_service import DOMService

DEFAULT_URLS = [
    "https://www.amazon.com/s?k=usb+c+cable",
    "https://www.doordash.com/",
    "https://en.wikipedia.org/wiki/Web_browser",
]


def _kernel_base() -> str:
    return (os.getenv("KERNEL_API_BASE_URL") or "https://api.onkernel.com").rstrip("/")


def _kernel_headers() -> Dict[str, str]:
    key = os.getenv("KERNEL_API_KEY")
    if not key:
        raise SystemExit("KERNEL_API_KEY is required (agents/.env or back-end/.env)")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def create_kernel_browser() -> Dict[str, Any]:
    response = httpx.post(
        f"{_kernel_base()}/browsers",
        headers=_kernel_headers(),
        json={
            "headless": False,
            "stealth": True,
            "viewport": {"width": 1280, "height": 800},
            "timeout_seconds": 600,
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def delete_kernel_browser(session_id: str) -> None:
    httpx.delete(f"{_kernel_base()}/browsers/{session_id}", headers=_kernel_headers(), timeout=30)


async def _timed(fn: Callable[[], Awaitable[Any]]) -> float:
    started = time.perf_counter()
    await fn()
    return (time.perf_counter() - started) * 1000


def _summary(values: List[float]) -> Dict[str, float]:
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "p50_ms": round(statistics.median(ordered), 1),
        "max_ms": round(ordered[-1], 1),
        "min_ms": round(ordered[0], 1),
    }


async def profile_url(dom: DOMService, url: str, samples: int) -> Dict[str, Any]:
    from browser_use.browser.events import NavigateToUrlEvent

    nav_ms = await _timed(lambda: dom.session.event_bus.dispatch(NavigateToUrlEvent(url=url)))
    await asyncio.sleep(2.0)
    phases: Dict[str, List[float]] = {
        "overlay_suppress": [],
        "state_summary_no_screenshot": [],
        "get_browser_state_no_screenshot": [],
        "get_browser_state_with_screenshot": [],
    }
    dom_chars = 0
    for _ in range(samples):
        phases["overlay_suppress"].append(await _timed(dom.ensure_browser_overlays_suppressed))
        phases["state_summary_no_screenshot"].append(
            await _timed(lambda: dom.session.get_browser_state_summary(include_screenshot=False))
        )
        state: Dict[str, Any] = {}

        async def _observe() -> None:
            state.update(await dom.get_browser_state(include_screenshot=False))

        phases["get_browser_state_no_screenshot"].append(await _timed(_observe))
        dom_chars = len(state.get("dom_tree") or "")
        phases["get_browser_state_with_screenshot"].append(
            await _timed(lambda: dom.get_browser_state(include_screenshot=True))
        )
    return {
        "url": url,
        "navigate_ms": round(nav_ms, 1),
        "dom_tree_chars": dom_chars,
        "phases": {name: _summary(values) for name, values in phases.items()},
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", action="append", help="URL to profile (repeatable)")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--json", help="Write results JSON to this path")
    args = parser.parse_args()

    browser = create_kernel_browser()
    session_id = browser["session_id"]
    print(f"kernel browser {session_id}", flush=True)
    results: List[Dict[str, Any]] = []
    try:
        dom = DOMService(cdp_url=browser["cdp_ws_url"])
        connect_ms = await _timed(dom.connect)
        print(f"connect {connect_ms:.0f}ms", flush=True)
        for url in args.url or DEFAULT_URLS:
            try:
                result = await profile_url(dom, url, args.samples)
            except Exception as exc:
                result = {"url": url, "error": f"{type(exc).__name__}: {exc}"}
            results.append(result)
            print(json.dumps(result, indent=2), flush=True)
    finally:
        delete_kernel_browser(session_id)
        print(f"deleted kernel browser {session_id}", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
