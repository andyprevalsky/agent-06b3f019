"""Canonicalize model-supplied keyboard keys for Playwright."""

from __future__ import annotations

_NAMED_KEYS = (
    "Alt",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "Backspace",
    "CapsLock",
    "Control",
    "Delete",
    "End",
    "Enter",
    "Escape",
    "Home",
    "Insert",
    "Meta",
    "NumLock",
    "PageDown",
    "PageUp",
    "Pause",
    "PrintScreen",
    "ScrollLock",
    "Shift",
    "Space",
    "Tab",
)
_CASE_INSENSITIVE_KEYS = {key.casefold(): key for key in _NAMED_KEYS}
_CASE_INSENSITIVE_KEYS.update({f"f{number}": f"F{number}" for number in range(1, 13)})
_CASE_INSENSITIVE_KEYS.update({"cmd": "Meta", "command": "Meta", "ctrl": "Control"})


def canonicalize_playwright_key(key: str) -> str:
    """Normalize named keys/modifiers without changing printable character case."""
    parts = key.split("+")
    canonical = [_CASE_INSENSITIVE_KEYS.get(part.strip().casefold(), part.strip()) for part in parts]
    return "+".join(canonical)
