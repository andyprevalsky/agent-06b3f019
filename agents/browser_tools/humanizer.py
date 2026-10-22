"""Human-like browser interactions.

Architecture:
- browser-use Page: DOM operations (evaluate, coordinate lookup) - READ ONLY
- Playwright Page: Input events (mouse, keyboard) - WRITE ONLY

The two CDP connections don't conflict because they use different CDP domains:
- browser-use: DOM, Runtime, Page (reading)
- Playwright: Input (writing)

Cursor positions are published to a recorder observer for the replay overlay.
The optional in-page cursor is disabled by default so Steel recordings do not
capture duplicate cursor layers.
"""

import asyncio
import contextlib
import inspect
import math
import os
import random
import time
from typing import Any, Callable, List, Optional, Tuple

import structlog

from browser_tools.input_synthesis import (
    IDLE_MOUSE_RADIUS_PX,
    KeycapTimingSynthesizer,
    MouseSample,
    synthesize_click_delay_ms,
    synthesize_idle_mouse_drift,
    synthesize_mouse_path,
)

logger = structlog.get_logger()


FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
CDP_INPUT_DRAIN_TIMEOUT_SECONDS = float(os.getenv("BROWSER_AGENT_CDP_INPUT_DRAIN_TIMEOUT_SECONDS", "15"))


def _env_enabled(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in FALSE_VALUES


def generate_bezier_points(
    start: Tuple[float, float],
    end: Tuple[float, float],
    steps: int = 40
) -> List[Tuple[float, float]]:
    """Generate points along a cubic Bezier curve.

    Creates a natural-looking curved path between two points,
    mimicking how humans move a mouse (not in straight lines).

    Args:
        start: Starting (x, y) position
        end: Ending (x, y) position
        steps: Number of points to generate

    Returns:
        List of (x, y) points along the curve
    """
    x1, y1 = start
    x2, y2 = end

    # Distance determines curve intensity
    dist = math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    # Control points with randomized offset for natural curve
    # Perpendicular offset creates arc, parallel offset creates S-curve
    offset = dist * random.uniform(0.1, 0.3)
    angle = math.atan2(y2 - y1, x2 - x1)
    perp_angle = angle + math.pi / 2

    # Randomize which side the curve bows to
    side = random.choice([-1, 1])

    # Control point 1 (closer to start)
    cp1_x = x1 + (x2 - x1) * 0.25 + side * offset * math.cos(perp_angle) * random.uniform(0.5, 1.0)
    cp1_y = y1 + (y2 - y1) * 0.25 + side * offset * math.sin(perp_angle) * random.uniform(0.5, 1.0)

    # Control point 2 (closer to end)
    cp2_x = x1 + (x2 - x1) * 0.75 + side * offset * math.cos(perp_angle) * random.uniform(0.3, 0.8)
    cp2_y = y1 + (y2 - y1) * 0.75 + side * offset * math.sin(perp_angle) * random.uniform(0.3, 0.8)

    points = []
    for i in range(steps + 1):
        t = i / steps

        # Cubic Bezier formula
        mt = 1 - t
        x = (mt ** 3 * x1 +
             3 * mt ** 2 * t * cp1_x +
             3 * mt * t ** 2 * cp2_x +
             t ** 3 * x2)
        y = (mt ** 3 * y1 +
             3 * mt ** 2 * t * cp1_y +
             3 * mt * t ** 2 * cp2_y +
             t ** 3 * y2)

        points.append((x, y))

    return points


class BrowserHumanizer:
    """Human-like browser interactions with visual cursor.

    Uses two separate CDP connections:
    - browser-use Page: For DOM operations (evaluate JS, read state)
    - Playwright Page: For input events (mouse, keyboard)

    This separation ensures:
    1. No race conditions (different CDP domains)
    2. humanization-playwright patterns work natively
    3. Visual cursor syncs with actual input events

    Usage:
        # After connecting both pages to same Steel browser
        humanizer = BrowserHumanizer(
            dom_page=browser_use_page,      # For evaluate()
            input_page=playwright_page,      # For mouse/keyboard
        )

        # Click at coordinates
        await humanizer.click_at_coords(500, 300)

        # Type text (assumes element is focused)
        await humanizer.type_text("hello@example.com")

        # Scroll viewport
        await humanizer.scroll(delta_y=300)

        # Scroll within a container (wheel events at element center)
        await humanizer.scroll(delta_y=300, at_coords=(x, y))
    """

    def __init__(
        self,
        dom_page: Any,
        input_page: Any,
        fast: bool = False,
        serial_cdp_keyboard: bool = False,
    ):
        """
        Args:
            dom_page: browser-use Page (for Runtime.evaluate)
            input_page: Playwright Page (for Input events)
            fast: If True, faster but less human-like movements
        """
        self.dom_page = dom_page
        self.input_page = input_page
        self.fast = fast
        # Single-CDP-client providers (Tilion) drop pipelined
        # Input.dispatchKeyEvent commands: no response and the keystroke is never
        # delivered. Their keyboard transport awaits each event in order; the
        # explicit CDP timestamps keep page-visible dwell/flight timing human.
        self._serial_cdp_keyboard = serial_cdp_keyboard
        self._last_pos = (640, 400)  # Start at center-ish
        self._input_synthesis_enabled = _env_enabled("BROWSER_AGENT_HUMAN_INPUT_ENABLED", True)
        self._mouse_synthesis_enabled = self._input_synthesis_enabled and _env_enabled(
            "BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS", True
        )
        self._keyboard_synthesis_enabled = self._input_synthesis_enabled and _env_enabled(
            "BROWSER_AGENT_HUMAN_KEYBOARD_SYNTHESIS", True
        )
        self._visual_cursor_enabled = _env_enabled("BROWSER_AGENT_VISUAL_CURSOR_ENABLED", False)
        self._visual_cursor_failed = False
        self._cdp_mouse_transport_enabled = self._input_synthesis_enabled and _env_enabled(
            "BROWSER_AGENT_CDP_MOUSE_TRANSPORT", True
        )
        self._cdp_keyboard_transport_enabled = self._keyboard_synthesis_enabled and _env_enabled(
            "BROWSER_AGENT_CDP_KEYBOARD_TRANSPORT", True
        )
        self._cdp_session: Optional[Any] = None
        self._cdp_session_lock = asyncio.Lock()
        self._cursor_observer: Optional[Callable[[int, int], Any]] = None
        self._keycap = KeycapTimingSynthesizer(basis_count=500 if fast else 1500)
        self._movement_lock = asyncio.Lock()
        self._closed = False
        self._idle_mouse_enabled = self._input_synthesis_enabled and _env_enabled(
            "BROWSER_AGENT_IDLE_MOUSE_ENABLED", True
        )
        self._idle_mouse_radius_px = max(0.5, float(os.getenv("BROWSER_AGENT_IDLE_MOUSE_RADIUS_PX", str(IDLE_MOUSE_RADIUS_PX))))
        self._idle_anchor = self._last_pos
        self._idle_handle: Optional[asyncio.TimerHandle] = None
        self._idle_task: Optional[asyncio.Task] = None
        # Monotonic deadline before which idle drift is suppressed. Set right after
        # a click so the FCaptcha PoW worker (triggered by the click) solves on an
        # uncontended main thread.
        self._idle_suppress_until = 0.0

        # Typing settings
        self._cpm = 320 if fast else 260  # Characters per minute

        logger.info(
            "BrowserHumanizer initialized",
            fast=fast,
            cpm=self._cpm,
            input_synthesis_enabled=self._input_synthesis_enabled,
            mouse_synthesis_enabled=self._mouse_synthesis_enabled,
            keyboard_synthesis_enabled=self._keyboard_synthesis_enabled,
            visual_cursor_enabled=self._visual_cursor_enabled,
            cdp_mouse_transport_enabled=self._cdp_mouse_transport_enabled,
            cdp_keyboard_transport_enabled=self._cdp_keyboard_transport_enabled,
            idle_mouse_enabled=self._idle_mouse_enabled,
        )

    def set_cursor_observer(self, observer: Optional[Callable[[int, int], Any]]) -> None:
        """Register a lightweight callback for cursor replay/stream mirroring."""
        self._cursor_observer = observer

    async def _publish_cursor(self, x: int, y: int) -> None:
        await self._publish_visual_cursor(x, y)
        await self._notify_cursor_observer(x, y)

    async def close(self) -> None:
        self._closed = True
        if self._idle_handle:
            self._idle_handle.cancel()
            self._idle_handle = None
        if self._idle_task:
            self._idle_task.cancel()
            try:
                await self._idle_task
            except asyncio.CancelledError:
                pass
            self._idle_task = None

    def start_idle_movement(self) -> None:
        if not self._idle_mouse_enabled or self._closed or self._idle_handle or self._idle_task:
            return
        # Dense cadence keeps the recent mouse-event window packed so behavioral
        # biometrics don't flag "mouse event rate abnormally low" (rate is
        # count/window; a sparse stream lets old samples stretch the window and
        # drag the rate under the 10/sec floor). The competing risk — dense idle
        # starving the FCaptcha Proof-of-Work worker ("PoW timing suggests
        # external processing") — is handled separately by suppressing idle for a
        # few seconds AFTER each click (see _suppress_idle), which is exactly when
        # the click-triggered PoW runs. So: dense BEFORE the click for rate,
        # silent AFTER it for PoW.
        self._schedule_idle_mouse_step(random.uniform(0.045, 0.085))

    def _schedule_idle_mouse_step(self, delay_s: float) -> None:
        if self._closed or not self._idle_mouse_enabled:
            return
        loop = asyncio.get_running_loop()
        self._idle_handle = loop.call_later(max(0.02, delay_s), self._start_idle_mouse_step)

    def _start_idle_mouse_step(self) -> None:
        self._idle_handle = None
        if self._closed or not self._idle_mouse_enabled:
            return
        remaining = self._idle_suppress_until - time.monotonic()
        if remaining > 0:
            # Idle is suppressed (a click just happened / PoW may be solving);
            # defer rather than drift, so the worker thread runs uncontended.
            self._schedule_idle_mouse_step(min(remaining, 0.45))
            return
        self._idle_task = asyncio.create_task(self._run_idle_mouse_step())

    def _suppress_idle(self, seconds: float) -> None:
        """Hold off idle drift for `seconds` (cancels any pending step)."""
        self._idle_suppress_until = max(self._idle_suppress_until, time.monotonic() + seconds)
        if self._idle_handle:
            self._idle_handle.cancel()
            self._idle_handle = None
            self._schedule_idle_mouse_step(seconds)

    async def _run_idle_mouse_step(self) -> None:
        try:
            delay_s = await self._idle_mouse_step()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("Idle mouse movement failed; disabling", error=str(exc))
            self._idle_mouse_enabled = False
            return
        finally:
            self._idle_task = None
        self._schedule_idle_mouse_step(delay_s if delay_s is not None else random.uniform(0.06, 0.14))

    async def _notify_cursor_observer(self, x: int, y: int) -> None:
        if not self._cursor_observer:
            return
        try:
            result = self._cursor_observer(int(x), int(y))
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            logger.debug("Cursor observer failed", error=str(exc))

    async def _schedule_visual_cursor_path(self, samples: List[Any]) -> None:
        if not self._visual_cursor_enabled or self._visual_cursor_failed or not samples:
            return
        if not hasattr(self.input_page, "evaluate"):
            return
        points = []
        elapsed_ms = 0
        for sample in samples:
            points.append({"x": int(sample.x), "y": int(sample.y), "delayMs": int(round(elapsed_ms))})
            elapsed_ms += max(0, int(round(sample.delay_s * 1000)))
        try:
            await self.input_page.evaluate(
                """
                ({ points }) => {
                    const id = "__rose_visual_cursor";
                    let el = document.getElementById(id);
                    if (!el) {
                        el = document.createElement("div");
                        el.id = id;
                        el.setAttribute("aria-hidden", "true");
                        el.style.position = "fixed";
                        el.style.left = "0";
                        el.style.top = "0";
                        el.style.width = "24px";
                        el.style.height = "32px";
                        el.style.pointerEvents = "none";
                        el.style.zIndex = "2147483647";
                        el.style.transform = "translate(-100px, -100px)";
                        el.style.transition = "transform 45ms linear";
                        el.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.75))";
                        el.innerHTML = `
                            <svg width="24" height="32" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M2 2L2 25L8 19L12 30L17 28L13 18L22 18L2 2Z" fill="white" stroke="black" stroke-width="2" stroke-linejoin="round"/>
                            </svg>`;
                        (document.documentElement || document.body).appendChild(el);
                    }
                    window.__moveRoseCursor = (nextX, nextY) => {
                        el.style.transform = `translate(${Math.round(nextX)}px, ${Math.round(nextY)}px)`;
                        el.dataset.x = String(Math.round(nextX));
                        el.dataset.y = String(Math.round(nextY));
                    };
                    for (const point of points) {
                        window.setTimeout(() => window.__moveRoseCursor(point.x, point.y), point.delayMs);
                    }
                }
                """,
                {"points": points},
            )
        except Exception as exc:
            self._visual_cursor_failed = True
            logger.debug("Visual cursor path schedule failed; disabling for this page", error=str(exc))

    async def _publish_visual_cursor(self, x: int, y: int) -> None:
        """Mirror synthesized mouse position into the page stream."""
        if not self._visual_cursor_enabled or self._visual_cursor_failed:
            return
        if not hasattr(self.input_page, "evaluate"):
            return
        try:
            await self.input_page.evaluate(
                """
                ({ x, y }) => {
                    const id = "__rose_visual_cursor";
                    let el = document.getElementById(id);
                    if (!el) {
                        el = document.createElement("div");
                        el.id = id;
                        el.setAttribute("aria-hidden", "true");
                        el.style.position = "fixed";
                        el.style.left = "0";
                        el.style.top = "0";
                        el.style.width = "24px";
                        el.style.height = "32px";
                        el.style.pointerEvents = "none";
                        el.style.zIndex = "2147483647";
                        el.style.transform = "translate(-100px, -100px)";
                        el.style.transition = "transform 45ms linear";
                        el.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.75))";
                        el.innerHTML = `
                            <svg width="24" height="32" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M2 2L2 25L8 19L12 30L17 28L13 18L22 18L2 2Z" fill="white" stroke="black" stroke-width="2" stroke-linejoin="round"/>
                            </svg>`;
                        (document.documentElement || document.body).appendChild(el);
                    }
                    window.__moveRoseCursor = (nextX, nextY) => {
                        el.style.transform = `translate(${Math.round(nextX)}px, ${Math.round(nextY)}px)`;
                        el.dataset.x = String(Math.round(nextX));
                        el.dataset.y = String(Math.round(nextY));
                    };
                    window.__moveRoseCursor(x, y);
                }
                """,
                {"x": int(x), "y": int(y)},
            )
        except Exception as exc:
            self._visual_cursor_failed = True
            logger.debug("Visual cursor publish failed; disabling for this page", error=str(exc))

    def _viewport_size(self) -> Tuple[int, int]:
        size = getattr(self.input_page, "viewport_size", None)
        if isinstance(size, dict):
            width = size.get("width")
            height = size.get("height")
            if isinstance(width, int) and isinstance(height, int):
                return width, height
        return (1280, 800)

    async def _get_cdp_session(self) -> Optional[Any]:
        if not self._cdp_mouse_transport_enabled and not self._cdp_keyboard_transport_enabled:
            return None
        if self._cdp_session is not None:
            return self._cdp_session

        async with self._cdp_session_lock:
            if not self._cdp_mouse_transport_enabled and not self._cdp_keyboard_transport_enabled:
                return None
            if self._cdp_session is not None:
                return self._cdp_session

            context = getattr(self.input_page, "context", None)
            if context is None or not hasattr(context, "new_cdp_session"):
                return None
            try:
                self._cdp_session = await context.new_cdp_session(self.input_page)
            except Exception as exc:
                logger.debug("CDP input transport unavailable", error=str(exc))
                if self._cdp_session is None:
                    self._cdp_mouse_transport_enabled = False
                    self._cdp_keyboard_transport_enabled = False
                return self._cdp_session
            return self._cdp_session

    async def _invalidate_cdp_session(self, cdp_session: Any) -> None:
        async with self._cdp_session_lock:
            if self._cdp_session is cdp_session:
                self._cdp_session = None
                self._cdp_mouse_transport_enabled = False
                self._cdp_keyboard_transport_enabled = False

    async def _move_path_with_cdp_fire_and_drain(self, samples: List[Any]) -> bool:
        cdp_session = await self._get_cdp_session() if self._cdp_mouse_transport_enabled else None
        if cdp_session is None:
            return False

        await self._schedule_visual_cursor_path(samples)
        pending = []
        timestamp = time.time()
        try:
            for sample in samples:
                timestamp += max(0, float(sample.delay_s))
                pending.append(
                    asyncio.create_task(
                        cdp_session.send(
                            "Input.dispatchMouseEvent",
                            {
                                "type": "mouseMoved",
                                "x": int(sample.x),
                                "y": int(sample.y),
                                "button": "none",
                                "buttons": 0,
                                "timestamp": timestamp,
                            },
                        )
                    )
                )
                await self._notify_cursor_observer(sample.x, sample.y)
                await asyncio.sleep(sample.delay_s)

            if pending:
                await asyncio.wait_for(
                    asyncio.gather(*pending),
                    timeout=CDP_INPUT_DRAIN_TIMEOUT_SECONDS,
                )
        except asyncio.CancelledError:
            for task in pending:
                if not task.done():
                    task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            raise
        except Exception as exc:
            for task in pending:
                if not task.done():
                    task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            await self._invalidate_cdp_session(cdp_session)
            logger.debug("CDP mouse path failed; using Playwright fallback", error=str(exc))
            return False

        return True

    async def _dispatch_mouse_position(self, x: int, y: int) -> None:
        cdp_session = await self._get_cdp_session() if self._cdp_mouse_transport_enabled else None
        if cdp_session is not None:
            try:
                await cdp_session.send(
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mouseMoved",
                        "x": int(x),
                        "y": int(y),
                        "button": "none",
                        "buttons": 0,
                        "timestamp": time.time(),
                    },
                )
            except Exception as exc:
                await self._invalidate_cdp_session(cdp_session)
                logger.debug("CDP mouse dispatch failed; using Playwright fallback", error=str(exc))
                await self.input_page.mouse.move(int(x), int(y))
        else:
            await self.input_page.mouse.move(int(x), int(y))
        await self._publish_cursor(int(x), int(y))

    async def _dispatch_mouse_button(self, x: float, y: float, *, pressed: bool) -> bool:
        """Press or release the left button at exact coordinates via CDP.

        Playwright's ``mouse.down``/``mouse.up`` always act at its own tracked
        cursor, so giving the release a different position requires a ``move``
        between press and release -- and every Playwright call is a round trip
        to a REMOTE browser, so that move lands inside the press and inflates
        the dwell the page observes. CDP carries the coordinates on the event
        itself, so the release can drift without extending the press at all.

        Returns False when CDP is unavailable so the caller can fall back.
        """
        cdp_session = await self._get_cdp_session() if self._cdp_mouse_transport_enabled else None
        if cdp_session is None:
            return False
        try:
            await cdp_session.send(
                "Input.dispatchMouseEvent",
                {
                    "type": "mousePressed" if pressed else "mouseReleased",
                    # Float coordinates, NOT int: the press/release offsets are
                    # sub-pixel gaussian motor noise, and truncating them to int
                    # collapses press and release onto the same pixel -- exactly
                    # the "unnaturally accurate click precision" tell the offsets
                    # exist to defeat. CDP accepts fractional coordinates.
                    "x": x,
                    "y": y,
                    "button": "left",
                    "buttons": 1 if pressed else 0,
                    "clickCount": 1,
                    "timestamp": time.time(),
                },
            )
            return True
        except Exception as exc:
            await self._invalidate_cdp_session(cdp_session)
            logger.debug("CDP mouse button dispatch failed", error=str(exc), pressed=pressed)
            return False

    async def _idle_mouse_step(self) -> Optional[float]:
        if not self._idle_mouse_enabled or self._closed:
            return None
        if self._movement_lock.locked():
            return random.uniform(0.018, 0.045)
        async with self._movement_lock:
            sample: MouseSample = synthesize_idle_mouse_drift(
                self._last_pos,
                anchor=self._idle_anchor,
                screen=self._viewport_size(),
                radius_px=self._idle_mouse_radius_px,
            )
            await self._dispatch_mouse_position(sample.x, sample.y)
            self._last_pos = (sample.x, sample.y)
            return sample.delay_s

    async def initialize_cursor(self, start_pos: Tuple[int, int] = (640, 400)) -> None:
        """Initialize cursor at startup position.

        Args:
            start_pos: Initial cursor position (default: center of 1280x800 viewport)
        """
        # Move mouse to start position
        await self.input_page.mouse.move(start_pos[0], start_pos[1])
        self._last_pos = start_pos
        self._idle_anchor = start_pos
        await self._publish_cursor(start_pos[0], start_pos[1])
        logger.info(f"🎯 Cursor initialized at {start_pos}")

    async def click_at_coords(
        self,
        x: int,
        y: int,
        pre_hover: bool = False,
        overshoot: bool = False
    ) -> None:
        """Human-like mouse movement to coords, then click.

        Args:
            x, y: Target coordinates
            pre_hover: Force pre-hover behavior (otherwise 30% chance)
            overshoot: Force overshoot behavior (otherwise 20% chance)
        """
        async with self._movement_lock:
            start_x, start_y = self._last_pos
            travel = math.hypot(x - start_x, y - start_y)

            # Maybe pre-hover (natural browsing behavior)
            if pre_hover or random.random() < 0.30:
                await self._move_to_unlocked(x, y)
                dwell = random.uniform(0.08, 0.25)
                await asyncio.sleep(dwell)
                logger.debug("Pre-hover dwell", x=x, y=y, dwell_ms=int(dwell * 1000))

            # Final movement to target
            await self._move_to_unlocked(x, y)

            # Overshoot-then-correct as the LAST samples before the click. Humans
            # overshoot the target and settle back; "no overshoot corrections on a
            # long trajectory" is a behavioral-biometrics bot tell. Detectors only
            # inspect the final ~20 mouse samples for an inside->outside->inside
            # pattern, so the correction MUST be the last thing before the click —
            # a long corrective path (via _move_to_unlocked) buries it out of the
            # window. Use short direct moves along the travel vector: settled(in)
            # -> past target(out) -> back(in).
            if overshoot or travel > 120 or random.random() < 0.35:
                angle = math.atan2(y - start_y, x - start_x) if travel > 1 else random.uniform(0, 2 * math.pi)
                overshoot_dist = random.randint(20, 34)
                overshoot_x = x + int(overshoot_dist * math.cos(angle))
                overshoot_y = y + int(overshoot_dist * math.sin(angle))
                await self.input_page.mouse.move(overshoot_x, overshoot_y)
                await asyncio.sleep(random.uniform(0.03, 0.07))
                await self.input_page.mouse.move(x, y)
                await self._notify_cursor_observer(x, y)
                await asyncio.sleep(random.uniform(0.02, 0.05))
                logger.debug("Overshoot", target=(x, y), overshoot=(overshoot_x, overshoot_y))

            # Small pause before click (human reaction time)
            await asyncio.sleep(random.uniform(0.03, 0.08))

            # Motor noise at the click instant: the press lands a hair off the
            # settled cursor and the release drifts again, with sub-pixel offsets.
            # "Unnaturally accurate click precision" (last-move == down == up,
            # pixel-perfect) is a vision-AI bot tell; real fingers micro-move.
            mouse = self.input_page.mouse
            down_x = x + random.gauss(0, 0.7)
            down_y = y + random.gauss(0, 0.7)
            up_x = down_x + random.gauss(0, 0.4)
            up_y = down_y + random.gauss(0, 0.4)
            await mouse.move(down_x, down_y)

            # The press must stay inside the sampled human dwell AND the release
            # must land a hair off the press. Doing both through Playwright is
            # impossible: it releases at its own tracked cursor, so offsetting
            # the release needs a move between down and up, and that remote
            # round trip inflates the observed hold (we sampled ~85ms and
            # emitted 621.5ms, measured). A submit whose mousedown is older than
            # 500ms is scored as a programmatic click rather than a real
            # gesture; a pixel-perfect down==up is scored as unnaturally
            # accurate precision. CDP carries coordinates on the event, so it
            # satisfies both at once -- and needs no post-click move, which
            # would otherwise race navigation triggered by the click itself.
            dwell_seconds = synthesize_click_delay_ms() / 1000
            pressed_via_cdp = await self._dispatch_mouse_button(down_x, down_y, pressed=True)
            if not pressed_via_cdp:
                await mouse.down()
            await asyncio.sleep(dwell_seconds)
            if not pressed_via_cdp or not await self._dispatch_mouse_button(up_x, up_y, pressed=False):
                # Fallback (or a CDP session lost mid-click): release in place.
                # Keeping the press short matters more than the sub-pixel offset,
                # and an unreleased button would wedge every later interaction.
                await mouse.up()

            self._last_pos = (x, y)
            self._idle_anchor = (x, y)
        # A click can trigger a behavioral-biometrics verification whose
        # Proof-of-Work runs in a page web worker. Briefly quiet idle drift so the
        # worker gets an uncontended turn, but do not hold it for several seconds:
        # ordinary field-focus clicks do not run PoW, and a long quiet window
        # starves the mouse-event-rate signal during form filling.
        self._suppress_idle(0.45)
        logger.debug("Humanized click", x=x, y=y)

    async def drag_between(
        self,
        start_x: int,
        start_y: int,
        end_x: int,
        end_y: int,
        *,
        steps: int = 24,
    ) -> None:
        """CDP mouse drag: press at start, move while held, release at end.

        Mirrors browser-use ``Element.drag_to`` (Input.dispatchMouseEvent
        mousePressed → mouseMoved → mouseReleased) with intermediate moves so
        slider CAPTCHAs see a continuous gesture.
        """
        step_count = max(2, min(120, int(steps)))
        async with self._movement_lock:
            await self._move_to_unlocked(int(start_x), int(start_y))
            await asyncio.sleep(random.uniform(0.04, 0.1))

            mouse = self.input_page.mouse
            pressed = await self._dispatch_mouse_button(float(start_x), float(start_y), pressed=True)
            if not pressed:
                await mouse.move(int(start_x), int(start_y))
                await mouse.down()

            for i in range(1, step_count + 1):
                t = i / step_count
                x = start_x + (end_x - start_x) * t
                y = start_y + (end_y - start_y) * t
                cdp_session = await self._get_cdp_session() if self._cdp_mouse_transport_enabled else None
                if cdp_session is not None and pressed:
                    try:
                        await cdp_session.send(
                            "Input.dispatchMouseEvent",
                            {
                                "type": "mouseMoved",
                                "x": float(x),
                                "y": float(y),
                                "button": "left",
                                "buttons": 1,
                                "timestamp": time.time(),
                            },
                        )
                    except Exception as exc:
                        await self._invalidate_cdp_session(cdp_session)
                        logger.debug("CDP drag move failed; Playwright fallback", error=str(exc))
                        await mouse.move(int(x), int(y))
                        pressed = False
                else:
                    await mouse.move(int(x), int(y))
                await self._notify_cursor_observer(int(x), int(y))
                await asyncio.sleep(random.uniform(0.008, 0.02))

            if not await self._dispatch_mouse_button(float(end_x), float(end_y), pressed=False):
                await mouse.move(int(end_x), int(end_y))
                await mouse.up()

            self._last_pos = (int(end_x), int(end_y))
            self._idle_anchor = (int(end_x), int(end_y))
        self._suppress_idle(0.35)
        logger.debug("Humanized drag", start=(start_x, start_y), end=(end_x, end_y), steps=step_count)

    async def click_for_input(
        self,
        x: int,
        y: int,
        width: int,
        height: int
    ) -> None:
        """Click in the right portion of an input field.

        Humans typically click towards the end of text in input fields,
        not dead center. This mimics that behavior.

        Args:
            x, y: Top-left corner of element
            width, height: Element dimensions
        """
        # Click in right 65-85% of element width
        input_x = x + int(width * random.uniform(0.65, 0.85))
        # Click in middle 30-70% of height
        input_y = y + int(height * random.uniform(0.30, 0.70))

        logger.debug(
            "Input mode click",
            element=(x, y, width, height),
            click_pos=(input_x, input_y)
        )

        await self.click_at_coords(input_x, input_y)

    async def double_click(self, x: int, y: int) -> None:
        """Human-like double click at coordinates."""
        async with self._movement_lock:
            await self._move_to_unlocked(x, y)
            await asyncio.sleep(random.uniform(0.02, 0.05))

            mouse = self.input_page.mouse
            await mouse.click(x, y, click_count=2, delay=synthesize_click_delay_ms())

            self._last_pos = (x, y)
            self._idle_anchor = (x, y)
        logger.debug("Humanized double-click", x=x, y=y)

    async def _dispatch_cdp_key(self, cdp_session: Any, pending: List[asyncio.Task], params: dict) -> None:
        send = cdp_session.send("Input.dispatchKeyEvent", params)
        if self._serial_cdp_keyboard:
            await asyncio.wait_for(send, timeout=CDP_INPUT_DRAIN_TIMEOUT_SECONDS)
        else:
            pending.append(asyncio.create_task(send))

    async def _type_text_with_cdp_fire_and_drain(self, text: str) -> bool:
        if not self._cdp_keyboard_transport_enabled:
            return False

        cdp_session = await self._get_cdp_session()
        if cdp_session is None:
            return False

        pending: List[asyncio.Task] = []
        timestamp = time.time()
        try:
            for char in text:
                timing = self._keycap.next(char)
                key = " " if char == " " else "Enter" if char == "\n" else char
                await self._dispatch_cdp_key(
                    cdp_session,
                    pending,
                    {
                        "type": "rawKeyDown",
                        "key": key,
                        "timestamp": timestamp,
                    },
                )
                await asyncio.sleep(timing.dwell_s)
                timestamp += timing.dwell_s
                await self._dispatch_cdp_key(
                    cdp_session,
                    pending,
                    {
                        "type": "char",
                        "key": key,
                        "text": char,
                        "unmodifiedText": char,
                        "timestamp": timestamp,
                    },
                )
                await self._dispatch_cdp_key(
                    cdp_session,
                    pending,
                    {
                        "type": "keyUp",
                        "key": key,
                        "timestamp": timestamp,
                    },
                )
                await asyncio.sleep(timing.interval_s)
                timestamp += timing.interval_s

            if pending:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*pending),
                        timeout=CDP_INPUT_DRAIN_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError as exc:
                    raise asyncio.TimeoutError(
                        "CDP keyboard input drain timed out after "
                        f"{CDP_INPUT_DRAIN_TIMEOUT_SECONDS:g}s"
                    ) from exc
        except BaseException:
            for task in pending:
                if not task.done():
                    task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            await self._invalidate_cdp_session(cdp_session)
            raise
        return True

    async def _keyboard_exclusive(self):
        """Hold the movement lock while keys are dispatched on a single-CDP-client
        provider: idle drift skips its step while the lock is held, so no mouse
        event is in flight next to a key event (Tilion drops such key events)."""
        if self._serial_cdp_keyboard:
            return self._movement_lock
        return contextlib.nullcontext()

    async def type_text(self, text: str) -> None:
        async with await self._keyboard_exclusive():
            await self._type_text_unlocked(text)

    async def _type_text_unlocked(self, text: str) -> None:
        """Human-like typing at current focus.

        Features:
        - Variable delay between keystrokes
        - Extra pause after spaces (thinking)
        - Occasional longer pauses (human hesitation)

        Args:
            text: Text to type
        """
        if self._keyboard_synthesis_enabled and await self._type_text_with_cdp_fire_and_drain(text):
            logger.debug("Humanized typing complete", chars=len(text))
            return

        base_delay = 60 / self._cpm  # seconds per character

        for i, char in enumerate(text):
            if self._keyboard_synthesis_enabled:
                timing = self._keycap.next(char)
                key = "Space" if char == " " else char
                await self.input_page.keyboard.down(key)
                await asyncio.sleep(timing.dwell_s)
                await self.input_page.keyboard.up(key)
                delay = timing.interval_s
            else:
                # Press the key via keyboard (not page.press which requires selector)
                await self.input_page.keyboard.press(char)

                # Inter-key delay with variation
                delay = base_delay * random.uniform(0.7, 1.4)

                # Extra pause after spaces (thinking between words)
                if char == " ":
                    delay += random.uniform(0.04, 0.12)

                # Occasional longer pause (human hesitation, ~5% chance)
                if random.random() < 0.05:
                    delay += random.uniform(0.15, 0.35)

            await asyncio.sleep(delay)

        logger.debug("Humanized typing complete", chars=len(text))

    async def press_key(self, key: str) -> None:
        async with await self._keyboard_exclusive():
            await self._press_key_unlocked(key)

    async def _press_key_unlocked(self, key: str) -> None:
        """Press a single key (Enter, Tab, Escape, etc.)."""
        if not self._keyboard_synthesis_enabled:
            await asyncio.sleep(random.uniform(0.02, 0.06))
            await self.input_page.keyboard.press(key)
            logger.debug("Key pressed", key=key)
            return

        timing = self._keycap.next(key)
        await asyncio.sleep(timing.interval_s)

        if "+" in key:
            parts = [part.strip() for part in key.split("+") if part.strip()]
            modifiers = parts[:-1]
            final_key = parts[-1] if parts else key
            for modifier in modifiers:
                await self.input_page.keyboard.down(modifier)
                await asyncio.sleep(random.uniform(0.018, 0.055))
            await self.input_page.keyboard.press(final_key, delay=int(timing.dwell_s * 1000))
            for modifier in reversed(modifiers):
                await asyncio.sleep(random.uniform(0.012, 0.04))
                await self.input_page.keyboard.up(modifier)
        else:
            await self.input_page.keyboard.press(key, delay=int(timing.dwell_s * 1000))
        logger.debug("Key pressed", key=key)

    async def scroll(self, delta_y: int, at_coords: Optional[Tuple[int, int]] = None) -> None:
        """Human-like scrolling.

        Args:
            delta_y: Pixels to scroll (positive = down, negative = up)
            at_coords: Optional (x, y) to scroll at, otherwise uses last position
        """
        x, y = at_coords or self._last_pos

        # Move to scroll position first if different
        if at_coords and at_coords != self._last_pos:
            await self._move_to(x, y)

        mouse = self.input_page.mouse

        # Break scroll into smaller chunks for natural feel
        remaining = abs(delta_y)
        direction = 1 if delta_y > 0 else -1

        while remaining > 0:
            # Variable chunk size (100-200px per "wheel tick")
            chunk = min(remaining, random.randint(80, 180))

            await mouse.wheel(0, direction * chunk)
            remaining -= chunk

            # Small delay between scroll ticks
            await asyncio.sleep(random.uniform(0.02, 0.06))

        logger.debug("Humanized scroll", delta_y=delta_y, at=(x, y))

    async def hover(self, x: int, y: int, dwell_time: float = 0.5) -> None:
        """Move to coordinates and hover.

        Args:
            x, y: Target coordinates
            dwell_time: Base hover time (will vary +/- 20%)
        """
        await self._move_to(x, y)

        actual_dwell = dwell_time * random.uniform(0.8, 1.2)
        await asyncio.sleep(actual_dwell)

        self._last_pos = (x, y)
        logger.debug("Hover complete", x=x, y=y, dwell_ms=int(actual_dwell * 1000))

    async def _move_to(self, x: int, y: int) -> None:
        async with self._movement_lock:
            await self._move_to_unlocked(x, y)

    async def _move_to_unlocked(self, x: int, y: int) -> None:
        """Internal: Move mouse along Bezier curve to target."""
        # Even when the cursor is already on the target, emit a short wander-in.
        # FCaptcha scores a press with zero preceding mouseMoved samples as
        # "Click injected with no pointer trajectory (teleport clicks)"
        # (agent 7f8b9c24 vision_ai 0.7). A few-sample approach keeps the
        # press inside a real trajectory without looking like a long re-aim.
        if self._last_pos == (x, y):
            angle = random.uniform(0, 2 * math.pi)
            dist = random.uniform(14, 28)
            vw, vh = self._viewport_size()
            origin = (
                max(0, min(vw - 1, int(x - dist * math.cos(angle)))),
                max(0, min(vh - 1, int(y - dist * math.sin(angle)))),
            )
            self._last_pos = origin
            # Fall through into the normal path synthesizer from the offset.

        if self._mouse_synthesis_enabled:
            distance = math.sqrt((x - self._last_pos[0]) ** 2 + (y - self._last_pos[1]) ** 2)
            duration_s = max(0.08, min(0.72 if self.fast else 0.95, 0.05 + distance / (1600 if self.fast else 1100)))
            samples = synthesize_mouse_path(
                self._last_pos,
                (x, y),
                screen=self._viewport_size(),
                frequency_hz=75 if self.fast else 105,
                duration_s=duration_s,
                snr=65 if self.fast else 55,
            )
            if await self._move_path_with_cdp_fire_and_drain(samples):
                self._last_pos = (x, y)
                self._idle_anchor = (x, y)
                return

            mouse = self.input_page.mouse
            for sample in samples:
                await mouse.move(sample.x, sample.y)
                await self._publish_cursor(sample.x, sample.y)
                await asyncio.sleep(sample.delay_s)
            self._last_pos = (x, y)
            self._idle_anchor = (x, y)
            return

        # Generate curved path
        steps = 25 if self.fast else 40
        points = generate_bezier_points(self._last_pos, (x, y), steps=steps)

        # Add jitter to all points upfront
        jittered_points = []
        for px, py in points:
            jitter_x = random.gauss(0, 0.6)
            jitter_y = random.gauss(0, 0.6)
            jittered_points.append((int(px + jitter_x), int(py + jitter_y)))

        # Calculate timing
        distance = math.sqrt((x - self._last_pos[0]) ** 2 + (y - self._last_pos[1]) ** 2)
        duration_ms = int(max(100, min(400, distance * 0.8)))
        step_delay = duration_ms / 1000 / len(jittered_points)

        mouse = self.input_page.mouse
        for point_x, point_y in jittered_points:
            await mouse.move(point_x, point_y)
            await self._publish_cursor(point_x, point_y)

            # Micro-pause (5% chance)
            if random.random() < 0.05:
                await asyncio.sleep(random.uniform(0.015, 0.035))
            else:
                await asyncio.sleep(step_delay * random.uniform(0.8, 1.2))

        self._last_pos = (x, y)
        self._idle_anchor = (x, y)
