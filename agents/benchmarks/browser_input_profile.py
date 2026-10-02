#!/usr/bin/env python3
"""Profile humanized typing and mouse movement on a real Kernel browser.

Creates one stealth Kernel browser (same shape as
``benchmarks/browser_observe_profile.py``), connects Playwright over CDP the
way the browser agent does, and times the ``BrowserHumanizer`` primitives the
agent's ``click`` / ``input_text`` actions are made of:

- CDP round trip (``Runtime.evaluate 1``) as the transport floor
- ``_move_to_unlocked`` at several distances: designed path duration (sum of
  sample delays) vs. wall clock, so the CDP ack drain shows up separately
- ``click_at_coords`` at several distances
- ``press_key("Control+a")`` + ``press_key("Backspace")``
- ``type_text`` for a short search query: designed keystroke time vs. wall clock

    cd agents && PYTHONPATH=. venv/bin/python benchmarks/browser_input_profile.py
    ... --samples 8 --text "usb c cable 6ft" --json out.json

The browser is always deleted on exit (including Ctrl-C).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import math
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

from benchmarks.browser_observe_profile import create_kernel_browser, delete_kernel_browser
from browser_tools import humanizer as humanizer_mod
from browser_tools.humanizer import BrowserHumanizer

TEST_PAGE = """data:text/html,<html><body style='margin:0;height:100vh'>
<input id=q style='position:absolute;left:520px;top:60px;width:400px;height:36px'>
<button id=b style='position:absolute;left:100px;top:700px;width:120px;height:40px'>Go</button>
</body></html>"""


def _summary(values: List[float]) -> Dict[str, float]:
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "p50_ms": round(statistics.median(ordered), 1),
        "min_ms": round(ordered[0], 1),
        "max_ms": round(ordered[-1], 1),
    }


class _PathRecorder:
    """Captures the designed duration of every synthesized mouse path."""

    def __init__(self) -> None:
        self.designed_s: List[float] = []
        self._original = humanizer_mod.synthesize_mouse_path

    def install(self) -> None:
        def recording(*args: Any, **kwargs: Any) -> Any:
            samples = self._original(*args, **kwargs)
            self.designed_s.append(sum(float(sample.delay_s) for sample in samples))
            return samples

        humanizer_mod.synthesize_mouse_path = recording

    def take(self) -> float:
        total = sum(self.designed_s)
        self.designed_s.clear()
        return total


async def profile(page: Any, samples: int, text: str) -> Dict[str, Any]:
    recorder = _PathRecorder()
    recorder.install()
    human = BrowserHumanizer(dom_page=page, input_page=page, fast=False)
    await human.initialize_cursor(start_pos=(640, 400))
    cdp = await page.context.new_cdp_session(page)

    rtt: List[float] = []
    for _ in range(samples):
        started = time.perf_counter()
        await cdp.send("Runtime.evaluate", {"expression": "1"})
        rtt.append((time.perf_counter() - started) * 1000)

    targets = {"short_60px": (60, 0), "medium_350px": (350, 0), "long_800px": (800, 0)}
    move_wall: Dict[str, List[float]] = {name: [] for name in targets}
    move_designed: Dict[str, List[float]] = {name: [] for name in targets}
    click_wall: Dict[str, List[float]] = {name: [] for name in targets}
    for _ in range(samples):
        for name, (dx, dy) in targets.items():
            start = (220, 400)
            human._last_pos = start
            end = (start[0] + dx, start[1] + dy)
            recorder.take()
            started = time.perf_counter()
            await human._move_to(*end)
            move_wall[name].append((time.perf_counter() - started) * 1000)
            move_designed[name].append(recorder.take() * 1000)

            human._last_pos = start
            started = time.perf_counter()
            await human.click_at_coords(*end)
            click_wall[name].append((time.perf_counter() - started) * 1000)

    clear_wall: List[float] = []
    type_wall: List[float] = []
    type_designed: List[float] = []
    focus_click: List[float] = []
    for _ in range(samples):
        human._last_pos = (160, 720)
        started = time.perf_counter()
        await human.click_at_coords(720, 78)
        focus_click.append((time.perf_counter() - started) * 1000)

        started = time.perf_counter()
        await human.press_key("Control+a")
        await human.press_key("Backspace")
        clear_wall.append((time.perf_counter() - started) * 1000)

        designed = 0.0
        original_next = human._keycap.next

        def recording_next(char: str = "", _next: Any = original_next) -> Any:
            nonlocal designed
            timing = _next(char)
            designed += timing.dwell_s + timing.interval_s
            return timing

        human._keycap.next = recording_next
        started = time.perf_counter()
        await human.type_text(text)
        type_wall.append((time.perf_counter() - started) * 1000)
        human._keycap.next = original_next
        type_designed.append(designed * 1000)
    typed = await page.evaluate("document.getElementById('q').value")
    await human.close()

    return {
        "cdp_round_trip": _summary(rtt),
        "move": {
            name: {
                "wall": _summary(move_wall[name]),
                "designed_path": _summary(move_designed[name]),
                "drain_overhead_p50_ms": round(
                    statistics.median(w - d for w, d in zip(move_wall[name], move_designed[name])), 1
                ),
            }
            for name in targets
        },
        "click_at_coords": {name: _summary(values) for name, values in click_wall.items()},
        "input_text_pieces": {
            "focus_click_long": _summary(focus_click),
            "clear_ctrl_a_backspace": _summary(clear_wall),
            "type_text": _summary(type_wall),
            "type_text_designed": _summary(type_designed),
            "chars": len(text),
            "ms_per_char_p50": round(statistics.median(type_wall) / max(1, len(text)), 1),
            "typed_value_ok": typed.endswith(text),
        },
        "move_distance_px": {name: math.hypot(*delta) for name, delta in targets.items()},
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--samples", type=int, default=6)
    parser.add_argument("--text", default="usb c cable 6ft")
    parser.add_argument("--json", help="Write results JSON to this path")
    args = parser.parse_args()

    from playwright.async_api import async_playwright

    browser = create_kernel_browser()
    session_id = browser["session_id"]
    print(f"kernel browser {session_id}", flush=True)
    result: Dict[str, Any] = {}
    try:
        async with async_playwright() as pw:
            pw_browser = await pw.chromium.connect_over_cdp(browser["cdp_ws_url"])
            context = pw_browser.contexts[0] if pw_browser.contexts else await pw_browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(TEST_PAGE)
            result = await profile(page, args.samples, args.text)
            print(json.dumps(result, indent=2), flush=True)
            with contextlib.suppress(Exception):
                await pw_browser.close()
    finally:
        delete_kernel_browser(session_id)
        print(f"deleted kernel browser {session_id}", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
