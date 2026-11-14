"""Ordinary screenshot tool-result transport with descriptive capture context."""
from __future__ import annotations

import base64
import binascii
from typing import Any, Callable

IMAGE_TYPES = frozenset({"image", "image_url", "input_image"})
SCREENSHOT_KEYS = frozenset({"screenshot", "screenshot_b64", "__screenshot_base64__"})


def _raster_media_type(value: str) -> str | None:
    """Distinguish encoded pixels from ordinary text in a screenshot-named field."""
    if value.startswith("data:image/"):
        value = value.partition(",")[2]
    try:
        pixels = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        return None
    for magic, media_type in ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"),
                              (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif")):
        if pixels.startswith(magic):
            return media_type
    return "image/webp" if pixels.startswith(b"RIFF") and pixels[8:12] == b"WEBP" else None


def _is_raster_transport(value: str) -> bool:
    return _raster_media_type(value) is not None


def redact_with_screenshots(value: Any, redact: Callable[[Any], Any], *, _nested: bool = False) -> Any:
    """Keep original raster transport while retaining nested page-key redaction."""
    if isinstance(value, dict):
        safe = redact(value)
        safe = dict(safe) if isinstance(safe, dict) else {}
        if _nested:
            safe = {redact(key): item for key, item in safe.items()}

        def restore_transport(key: str, item: Any) -> None:
            if _nested and redact(key) != key:
                safe.pop(redact(key), None)
            safe[key] = item

        raster_candidates = [value.get("data"), value.get("image_url")]
        if isinstance(value.get("image_url"), dict):
            raster_candidates.append(value["image_url"].get("url"))
        if isinstance(value.get("source"), dict):
            raster_candidates.append(value["source"].get("data"))
        if (isinstance(value.get("type"), str) and value["type"] in IMAGE_TYPES
                and any(isinstance(item, str) and _is_raster_transport(item) for item in raster_candidates)):
            restore_transport("type", value["type"])
            if value["type"] == "image_url" and isinstance(value.get("image_url"), dict):
                original_url = value["image_url"].get("url")
                payload = redact_with_screenshots(value["image_url"], redact, _nested=True)
                if isinstance(original_url, str) and _is_raster_transport(original_url):
                    payload.pop(redact("url"), None)
                    payload["url"] = original_url
                restore_transport("image_url", payload)
            for key in ("data", "image_url"):
                if isinstance(value.get(key), str) and _is_raster_transport(value[key]):
                    restore_transport(key, value[key])
            if isinstance(value.get("source"), dict) and isinstance(value["source"].get("data"), str):
                if _is_raster_transport(value["source"]["data"]):
                    payload = redact_with_screenshots(value["source"], redact, _nested=True)
                    payload.pop(redact("data"), None)
                    payload["data"] = value["source"]["data"]
                    for key, canonical in (("type", "base64"), ("media_type", _raster_media_type(value["source"]["data"]))):
                        if value["source"].get(key) == canonical:
                            payload.pop(redact(key), None)
                            payload[key] = canonical
                    restore_transport("source", payload)
            return safe
        for key, item in value.items():
            if (key in SCREENSHOT_KEYS or key == "image_url") and isinstance(item, str) and _is_raster_transport(item):
                restore_transport(key, item)
            elif isinstance(item, (dict, list, tuple)):
                safe[redact(key) if _nested else key] = redact_with_screenshots(item, redact, _nested=True)
        return safe
    if isinstance(value, list):
        return [redact_with_screenshots(item, redact, _nested=True) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_with_screenshots(item, redact, _nested=True) for item in value)
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
