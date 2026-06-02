#!/usr/bin/env python3
"""Live Steel probe for one humanized click and cursor replay alignment.

This is intentionally not part of the default offline suite. It creates one
short Steel session, drives BrowserHumanizer from (20, 20) to a target button,
and writes the same local HTML recording used by browser agents.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest.mock import patch

import requests
from dotenv import load_dotenv


AGENTS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = AGENTS_ROOT.parent
sys.path.insert(0, str(AGENTS_ROOT))


HTML = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; font-family: system-ui, sans-serif; }
    body {
      background:
        linear-gradient(#eef2f7 1px, transparent 1px),
        linear-gradient(90deg, #eef2f7 1px, transparent 1px),
        #fbfcfe;
      background-size: 20px 20px;
      color: #142033;
    }
    #target {
      position: absolute;
      left: 520px;
      top: 300px;
      width: 180px;
      height: 64px;
      border: 2px solid #1d4ed8;
      background: #eff6ff;
      color: #172554;
      border-radius: 8px;
      font-size: 18px;
      font-weight: 650;
    }
    #target.clicked {
      background: #dcfce7;
      border-color: #15803d;
      color: #14532d;
    }
    #origin {
      position: absolute;
      left: 20px;
      top: 20px;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #111827;
      transform: translate(-4px, -4px);
    }
    #note {
      position: absolute;
      left: 36px;
      top: 14px;
      font-size: 13px;
      color: #475569;
    }
  </style>
</head>
<body>
  <div id="origin"></div>
  <div id="note">Start cursor at (20, 20); click the target once.</div>
  <button id="target">Click target</button>
  <script>
    window.eventLog = [];
    window.overlayLog = [];

    function recordEvent(event) {
      window.eventLog.push({
        name: event.type,
        x: Math.round(event.clientX || 0),
        y: Math.round(event.clientY || 0),
        button: event.button,
        t: performance.now()
      });
    }

    for (const name of ["mousemove", "mousedown", "mouseup", "click"]) {
      document.addEventListener(name, recordEvent, true);
    }

    document.getElementById("target").addEventListener("click", () => {
      document.getElementById("target").classList.add("clicked");
    });

    window.installOverlayProbe = () => {
      const el = document.getElementById("__rose_visual_cursor");
      if (!el || el.__roseProbeInstalled) return false;
      el.__roseProbeInstalled = true;
      const record = () => {
        window.overlayLog.push({
          x: Number(el.dataset.x),
          y: Number(el.dataset.y),
          transform: el.style.transform,
          t: performance.now()
        });
      };
      record();
      new MutationObserver(record).observe(el, {
        attributes: true,
        attributeFilter: ["style", "data-x", "data-y"]
      });
      return true;
    };
  </script>
</body>
</html>
"""


def _load_env() -> None:
    load_dotenv(REPO_ROOT / "back-end" / ".env")
    load_dotenv(AGENTS_ROOT / ".env")


def _steel_headers() -> Dict[str, str]:
    api_key = os.getenv("STEEL_API_KEY")
    if not api_key:
        raise RuntimeError("STEEL_API_KEY is not set in back-end/.env or agents/.env")
    return {"steel-api-key": api_key, "content-type": "application/json"}


def _create_steel_session(timeout_ms: int) -> Dict[str, Any]:
    response = requests.post(
        "https://api.steel.dev/v1/sessions",
        headers=_steel_headers(),
        json={
            "useProxy": False,
            "solveCaptcha": True,
            "debugConfig": {
                "systemCursor": False,
            },
            "stealthConfig": {
                "humanizeInteractions": False,
                "skipFingerprintInjection": True,
            },
            "timeout": timeout_ms,
            "dimensions": {"width": 1288, "height": 891},
        },
        timeout=45,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Steel session create failed: HTTP {response.status_code} {response.text[:500]}")
    return response.json()


def _release_steel_session(session_id: str) -> None:
    try:
        requests.post(
            f"https://api.steel.dev/v1/sessions/{session_id}/release",
            headers=_steel_headers(),
            json={},
            timeout=20,
        )
    except Exception:
        pass


def _same_point(a: Tuple[int, int], b: Tuple[int, int], tolerance: int = 1) -> bool:
    return abs(a[0] - b[0]) <= tolerance and abs(a[1] - b[1]) <= tolerance


def _point_distance(a: Tuple[int, int], b: Tuple[int, int]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _point_to_segment_distance(point: Tuple[int, int], start: Tuple[int, int], end: Tuple[int, int]) -> float:
    px, py = point
    sx, sy = start
    ex, ey = end
    dx = ex - sx
    dy = ey - sy
    if dx == 0 and dy == 0:
        return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / float(dx * dx + dy * dy)))
    nearest_x = sx + t * dx
    nearest_y = sy + t * dy
    return ((px - nearest_x) ** 2 + (py - nearest_y) ** 2) ** 0.5


def _point_to_path_distance(point: Tuple[int, int], path: List[Tuple[int, int]]) -> float:
    if not path:
        return float("inf")
    if len(path) == 1:
        return _point_to_segment_distance(point, path[0], path[0])
    return min(_point_to_segment_distance(point, path[index], path[index + 1]) for index in range(len(path) - 1))


def _assert_alignment(
    *,
    target: Tuple[int, int],
    event_log: List[Dict[str, Any]],
    cursor_events: List[Dict[str, Any]],
    idle_radius_px: float = 0,
) -> None:
    mouse_moves = [event for event in event_log if event["name"] == "mousemove"]
    clicks = [event for event in event_log if event["name"] == "click"]
    if len(mouse_moves) < 12:
        raise AssertionError(f"expected at least 12 real mousemove events, got {len(mouse_moves)}")
    if len({(event["x"], event["y"]) for event in mouse_moves}) < 8:
        raise AssertionError("real mousemove path did not vary enough")
    if len(cursor_events) < 12:
        raise AssertionError(f"expected at least 12 stitched cursor events, got {len(cursor_events)}")
    if not clicks:
        raise AssertionError("target page did not receive a click event")

    actual_final = (int(mouse_moves[-1]["x"]), int(mouse_moves[-1]["y"]))
    stitched_final = (int(cursor_events[-1]["x"]), int(cursor_events[-1]["y"]))
    click_final = (int(clicks[-1]["x"]), int(clicks[-1]["y"]))
    if not _same_point(click_final, target):
        raise AssertionError(f"click event landed at {click_final}, expected {target}")
    for label, point in (("actual mouse", actual_final), ("stitched cursor", stitched_final)):
        if _point_distance(point, target) > idle_radius_px + 1:
            raise AssertionError(f"{label} ended at {point}, expected within idle radius of {target}")

    move_path = [(int(event["x"]), int(event["y"])) for event in mouse_moves]
    missing = [
        (int(event["x"]), int(event["y"]))
        for event in cursor_events
        if _point_to_path_distance((int(event["x"]), int(event["y"])), move_path) > 18
    ]
    if len(missing) > max(2, len(cursor_events) // 10):
        raise AssertionError(
            f"stitched cursor diverged from actual mousemove path: {len(missing)} off-path cursor points"
        )


async def run_probe(args: argparse.Namespace) -> Path:
    from playwright.async_api import async_playwright

    from browser_tools.humanizer import BrowserHumanizer
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    _load_env()
    os.environ["BROWSER_AGENT_HUMAN_INPUT_ENABLED"] = "1"
    os.environ["BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS"] = "1"
    os.environ["BROWSER_AGENT_VISUAL_CURSOR_ENABLED"] = "0"
    os.environ["BROWSER_AGENT_RECORDINGS"] = "1"
    os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = str(args.frame_interval)
    os.environ["BROWSER_AGENT_RECORDING_MAX_FRAMES"] = "600"

    session = _create_steel_session(timeout_ms=args.timeout_ms)
    session_id = session["id"]
    api_key = os.getenv("STEEL_API_KEY")
    ws_url = f"wss://connect.steel.dev?apiKey={api_key}&sessionId={session_id}"
    browser_url = f"{session.get('debugUrl', '')}?interactive=false" if session.get("debugUrl") else ""
    task_id = f"steel-click-probe-{int(time.time())}"
    html_path: Path | None = None
    session_released = False

    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_url, timeout=30_000)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()
            await page.set_viewport_size({"width": 1280, "height": 800})
            await page.set_content(HTML, wait_until="domcontentloaded")

            recorder = await BrowserAgentRecorder.create(
                page=page,
                agent_id="steel-humanized-click-probe",
                task_id=task_id,
                session_id=session_id,
                browser_url=browser_url,
                session_metadata={"provider": "steel", "proxy_source": "none"},
            )
            if recorder is None:
                raise RuntimeError("BrowserAgentRecorder did not start")

            humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=args.fast)
            humanizer.set_cursor_observer(recorder.set_cursor)
            humanizer.start_idle_movement()

            start = (args.start_x, args.start_y)
            target = (args.target_x, args.target_y)
            await humanizer.initialize_cursor(start)
            await page.evaluate("window.installOverlayProbe()")
            await recorder.mark("cursor initialized at (20, 20)", action="cursor_init", force=True)

            await asyncio.sleep(0.25)
            await recorder.mark("starting humanized click", action="click_start", force=True)
            with patch("browser_tools.humanizer.random.random", return_value=1.0):
                await humanizer.click_at_coords(target[0], target[1], pre_hover=False, overshoot=False)
            await asyncio.sleep(0.35)
            await recorder.mark("humanized click finished", action="click_done", force=True)

            event_log = await page.evaluate("window.eventLog")
            overlay_log = await page.evaluate("window.overlayLog")
            page_cursor_count = await page.evaluate('document.querySelectorAll("#__rose_visual_cursor").length')
            cursor_events = list(recorder.cursor_events)
            if page_cursor_count:
                raise AssertionError("page-injected visual cursor should be disabled for Steel recording dumps")
            _assert_alignment(
                target=target,
                event_log=event_log,
                cursor_events=cursor_events,
                idle_radius_px=humanizer._idle_mouse_radius_px,
            )

            await humanizer.close()
            await browser.close()
            if not args.keep_session:
                _release_steel_session(session_id)
                session_released = True

            html_path = await recorder.close()
            if html_path is None:
                raise RuntimeError("recording did not produce an HTML player")
            result_path = html_path.parent / "probe_result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "session_id": session_id,
                        "browser_url": browser_url,
                        "html_path": str(html_path),
                        "target": {"x": target[0], "y": target[1]},
                        "actual_mouse_events": len([e for e in event_log if e["name"] == "mousemove"]),
                        "stitched_cursor_events": len(cursor_events),
                        "visual_overlay_events": len(overlay_log),
                        "event_log": event_log,
                        "overlay_log": overlay_log,
                        "cursor_events": cursor_events,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            return html_path
    finally:
        if not args.keep_session and not session_released:
            _release_steel_session(session_id)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a live Steel humanized click probe.")
    parser.add_argument("--start-x", type=int, default=20)
    parser.add_argument("--start-y", type=int, default=20)
    parser.add_argument("--target-x", type=int, default=610)
    parser.add_argument("--target-y", type=int, default=332)
    parser.add_argument("--frame-interval", type=float, default=1 / 30)
    parser.add_argument("--timeout-ms", type=int, default=120_000)
    parser.add_argument("--fast", action="store_true")
    parser.add_argument("--keep-session", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    output = asyncio.run(run_probe(parse_args()))
    print(f"steel humanized click probe: PASS")
    print(f"recording: {output}")
