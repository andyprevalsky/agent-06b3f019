"""Human-like browser interactions.

Architecture:
- browser-use Page: DOM operations (evaluate, coordinate lookup) - READ ONLY
- Playwright Page: Input events (mouse, keyboard) - WRITE ONLY

The two CDP connections don't conflict because they use different CDP domains:
- browser-use: DOM, Runtime, Page (reading)
- Playwright: Input (writing)

Note: Visual cursor rendering is handled by the frontend overlay (BrowserCursorOverlay.tsx),
not by injecting elements into the browser page.
"""

import random
import asyncio
import math
from typing import Tuple, List, Any, Optional
import structlog

logger = structlog.get_logger()


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

        # Scroll
        await humanizer.scroll(delta_y=300)
    """

    def __init__(
        self,
        dom_page: Any,
        input_page: Any,
        fast: bool = False
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
        self._last_pos = (640, 400)  # Start at center-ish

        # Typing settings
        self._cpm = 320 if fast else 260  # Characters per minute

        logger.info(
            "BrowserHumanizer initialized",
            fast=fast,
            cpm=self._cpm
        )

    async def initialize_cursor(self, start_pos: Tuple[int, int] = (640, 400)) -> None:
        """Initialize cursor at startup position.

        Args:
            start_pos: Initial cursor position (default: center of 1280x800 viewport)
        """
        # Move mouse to start position
        await self.input_page.mouse.move(start_pos[0], start_pos[1])
        self._last_pos = start_pos
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
        # Maybe pre-hover (natural browsing behavior)
        if pre_hover or random.random() < 0.30:
            await self._move_to(x, y)
            dwell = random.uniform(0.08, 0.25)
            await asyncio.sleep(dwell)
            logger.debug("Pre-hover dwell", x=x, y=y, dwell_ms=int(dwell * 1000))

        # Maybe overshoot and correct (very human!)
        if overshoot or random.random() < 0.20:
            overshoot_dist = random.randint(15, 40)
            angle = random.uniform(0, 2 * math.pi)
            overshoot_x = x + int(overshoot_dist * math.cos(angle))
            overshoot_y = y + int(overshoot_dist * math.sin(angle))

            await self._move_to(overshoot_x, overshoot_y)
            await asyncio.sleep(random.uniform(0.04, 0.10))
            logger.debug("Overshoot", target=(x, y), overshoot=(overshoot_x, overshoot_y))

        # Final movement to target
        await self._move_to(x, y)

        # Small pause before click (human reaction time)
        await asyncio.sleep(random.uniform(0.03, 0.08))

        # Get Playwright mouse and click
        mouse = self.input_page.mouse
        await mouse.click(x, y)

        self._last_pos = (x, y)
        logger.debug("Humanized click", x=x, y=y)

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
        await self._move_to(x, y)
        await asyncio.sleep(random.uniform(0.02, 0.05))

        mouse = self.input_page.mouse
        await mouse.click(x, y, click_count=2)

        self._last_pos = (x, y)
        logger.debug("Humanized double-click", x=x, y=y)

    async def type_text(self, text: str) -> None:
        """Human-like typing at current focus.

        Features:
        - Variable delay between keystrokes
        - Extra pause after spaces (thinking)
        - Occasional longer pauses (human hesitation)

        Args:
            text: Text to type
        """
        base_delay = 60 / self._cpm  # seconds per character

        for i, char in enumerate(text):
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
        """Press a single key (Enter, Tab, Escape, etc.)."""
        await asyncio.sleep(random.uniform(0.02, 0.06))
        await self.input_page.keyboard.press(key)
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
        """Internal: Move mouse along Bezier curve to target."""
        # Skip if already at position
        if self._last_pos == (x, y):
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

            # Micro-pause (5% chance)
            if random.random() < 0.05:
                await asyncio.sleep(random.uniform(0.015, 0.035))
            else:
                await asyncio.sleep(step_delay * random.uniform(0.8, 1.2))

        self._last_pos = (x, y)
