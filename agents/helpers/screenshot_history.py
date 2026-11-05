"""Ordinary screenshot tool-result transport with descriptive capture context."""
from __future__ import annotations

import base64
import binascii
from typing import Any, Callable

IMAGE_TYPES = frozenset({"image", "image_url", "input_image"})
SCREENSHOT_KEYS = frozenset({"screenshot", "screenshot_b64", "__screenshot_base64__"})


def _is_raster_transport(value: str) -> bool:
    """Distinguish encoded pixels from ordinary text in a screenshot-named field."""
    if value.startswith("data:image/"):
        value = value.partition(",")[2]
    try:
        pixels = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        return False
    return pixels.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")) or (
        pixels.startswith(b"RIFF") and pixels[8:12] == b"WEBP"
    )


def redact_with_screenshots(value: Any, redact: Callable[[Any], Any]) -> Any:
    """Keep original raster bytes; apply existing redaction to surrounding text.

    This does not discover images, read files, or decide who owns a capture.
    The caller supplies the original tool result or conversation message.
    """
    if isinstance(value, dict):
        if isinstance(value.get("type"), str) and value["type"] in IMAGE_TYPES:
            copied = redact(value)
            copied = copied if isinstance(copied, dict) else {}
            if value.get("type") == "image_url" and isinstance(value.get("image_url"), dict):
                payload = dict(copied.get("image_url") or {})
                original_url = value["image_url"].get("url")
                if isinstance(original_url, str) and original_url.startswith("data:image/"):
                    payload["url"] = original_url
                copied["image_url"] = payload
            for key in ("data", "image_url"):
                if isinstance(value.get(key), str) and _is_raster_transport(value[key]):
                    copied[key] = value[key]
            if isinstance(value.get("source"), dict) and isinstance(value["source"].get("data"), str):
                if _is_raster_transport(value["source"]["data"]):
                    copied.setdefault("source", {})["data"] = value["source"]["data"]
            return copied
        safe = redact(value)
        safe = dict(safe) if isinstance(safe, dict) else {}
        for key, item in value.items():
            if key in SCREENSHOT_KEYS and isinstance(item, str) and _is_raster_transport(item):
                safe[key] = item
            elif isinstance(item, (dict, list, tuple)):
                safe[key] = redact_with_screenshots(item, redact)
        return safe
    if isinstance(value, list):
        return [redact_with_screenshots(item, redact) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_with_screenshots(item, redact) for item in value)
    return redact(value)


def screenshot_context_text(metadata: dict) -> str:
    context = metadata.get("screenshot_context") or metadata.get("capture_context") or {}
    if not isinstance(context, dict):
        context = {}
    fields = [f"{key}={context[key]}" for key in ("captured_at", "url", "target_id", "step", "tool_call_id")
              if context.get(key) is not None]
    if isinstance(context.get("captured_at"), (int, float)):
        fields[0] += " (Unix seconds, UTC)"
    if context.get("captured_at") is None:
        fields.insert(0, "capture time unrecorded")
    return "Screenshot tool result" + (" (" + "; ".join(fields) + ")" if fields else "")


def screenshot_message(entry: dict) -> dict | None:
    image = entry.get("screenshot") or (entry.get("result") or {}).get("screenshot")
    if not isinstance(image, str) or not image:
        return None
    context = dict((entry.get("result") or {}).get("screenshot_context") or {})
    context.setdefault("step", entry.get("step"))
    return {"role": "TOOL", "text": screenshot_context_text({"screenshot_context": context}),
            "metadata": {"toolName": entry.get("action", "screenshot"), "toolStatus": "FINISHED",
                         "toolCallId": (entry.get("result") or {}).get("tool_call_id") or f"screenshot-step-{entry.get('step')}",
                         "browser_action_step": entry.get("step"), "screenshot_b64": image,
                         "screenshot_media_type": "image/png", "screenshot_context": context}}
