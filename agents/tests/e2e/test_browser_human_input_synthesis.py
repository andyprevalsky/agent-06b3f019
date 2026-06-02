#!/usr/bin/env python3
"""Browser-level E2E for human input synthesis.

This keeps the verification cheap: it launches a real Playwright browser,
drives it through BrowserHumanizer, and asserts the page receives multiple
mousemove samples plus organic key events.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


AGENTS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AGENTS_ROOT))


HTML = """
<!doctype html>
<html>
<body>
  <input id="target" style="margin:120px;width:260px;height:34px" />
  <button id="button" style="margin-left:120px;width:120px;height:42px">Click</button>
  <script>
    window.eventLog = [];
    for (const name of ['mousemove', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'input']) {
      document.addEventListener(name, event => {
        window.eventLog.push({
          name,
          x: event.clientX || 0,
          y: event.clientY || 0,
          key: event.key || '',
          value: document.querySelector('#target').value,
          t: performance.now()
        });
      }, true);
    }
  </script>
</body>
</html>
"""


async def run() -> None:
    from playwright.async_api import async_playwright
    from browser_tools.humanizer import BrowserHumanizer

    os.environ["BROWSER_AGENT_HUMAN_INPUT_ENABLED"] = "1"
    os.environ["BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS"] = "1"
    os.environ["BROWSER_AGENT_HUMAN_KEYBOARD_SYNTHESIS"] = "1"

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1280, "height": 800})
        await page.set_content(HTML)

        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        observed_cursor = []
        humanizer.set_cursor_observer(lambda x, y: observed_cursor.append((x, y)))
        await humanizer.initialize_cursor((40, 40))
        expected_text = "rose.meadow25@mail.roselabs.ai"
        await humanizer.click_at_coords(180, 140, pre_hover=False, overshoot=False)
        await humanizer.type_text(expected_text)
        await humanizer.click_at_coords(560, 145, pre_hover=False, overshoot=False)

        value = await page.locator("#target").input_value()
        event_log = await page.evaluate("window.eventLog")
        await browser.close()

    mouse_moves = [event for event in event_log if event["name"] == "mousemove"]
    key_events = [event for event in event_log if event["name"] in ("keydown", "keyup")]
    click_events = [event for event in event_log if event["name"] == "click"]

    assert value == expected_text, f"expected input text to be typed, got {value!r}"
    assert len(mouse_moves) >= 12, f"expected synthesized mouse path, got {len(mouse_moves)} moves"
    assert len({(event['x'], event['y']) for event in mouse_moves}) >= 8, "mouse path did not vary"
    assert len(key_events) >= len(expected_text) * 2, f"expected down/up key events, got {len(key_events)}"
    assert click_events, "expected at least one click event"
    assert observed_cursor and observed_cursor[-1] == (560, 145), "cursor observer did not mirror final click"


if __name__ == "__main__":
    asyncio.run(run())
    print("browser human input synthesis e2e: PASS")
