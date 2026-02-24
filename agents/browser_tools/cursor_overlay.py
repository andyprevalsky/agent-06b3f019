"""Composite a cursor onto browser screenshots for ML model feedback.

Draws a standard pointer arrow cursor onto a base64 PNG screenshot so
vision models can see where the previous click landed and course-correct.
"""

import base64
import os
import time as time_module
from io import BytesIO

from PIL import Image, ImageDraw

import structlog

logger = structlog.get_logger(__name__)

# Module-level singleton — created once, reused forever
_cursor_image: Image.Image | None = None


def get_cursor_image() -> Image.Image:
    """Return a cached 28x28 RGBA pointer cursor (tip at top-left)."""
    global _cursor_image
    if _cursor_image is not None:
        return _cursor_image

    size = 28
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Standard pointer arrow polygon — tip at (1,1), pointing down-right
    arrow = [
        (1, 1),
        (1, 22),
        (6, 17),
        (11, 25),
        (14, 23),
        (9, 15),
        (16, 15),
        (1, 1),
    ]

    # White stroke (draw slightly larger outline first)
    draw.polygon(arrow, fill=(255, 255, 255, 255))
    draw.line(arrow, fill=(255, 255, 255, 255), width=3)

    # Black fill on top
    inner = [
        (3, 4),
        (3, 19),
        (7, 15),
        (12, 23),
        (13, 22),
        (8, 14),
        (14, 14),
        (3, 4),
    ]
    draw.polygon(inner, fill=(26, 26, 26, 255))

    _cursor_image = img
    return _cursor_image


def composite_cursor_on_screenshot(screenshot_b64: str, x: int, y: int) -> str:
    """Paste cursor at (x, y) on a base64 PNG screenshot. Returns new base64 PNG.

    Also saves the composited image to /tmp/browser_screenshots/ for debugging.
    """
    try:
        screenshot_bytes = base64.b64decode(screenshot_b64)
        bg = Image.open(BytesIO(screenshot_bytes)).convert("RGBA")

        cursor = get_cursor_image()
        # Paste with alpha mask so transparency is preserved
        bg.paste(cursor, (x, y), cursor)

        # Convert back to RGB PNG (models don't need alpha channel)
        rgb = bg.convert("RGB")
        buf = BytesIO()
        rgb.save(buf, format="PNG")
        result_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        # Save composited screenshot to /tmp for visual inspection
        debug_dir = "/tmp/browser_screenshots"
        os.makedirs(debug_dir, exist_ok=True)
        filename = f"{debug_dir}/composited_{int(time_module.time() * 1000)}.png"
        with open(filename, "wb") as f:
            f.write(buf.getvalue())
        logger.info(f"🎯 [CURSOR] Composited cursor at ({x},{y}), saved to {filename}")

        return result_b64
    except Exception as e:
        logger.warning(f"🎯 [CURSOR] Failed to composite cursor: {e}")
        return screenshot_b64  # Return original on failure
