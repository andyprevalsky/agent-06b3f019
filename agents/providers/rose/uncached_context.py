"""Uncached runtime context: per-call text that must stay AFTER the cache breakpoint.

    stable conversation (cached prefix) ─▶ [message breakpoint] ─▶ UncachedContextText tail

A volatile suffix (e.g. the environment status tail: current time + live agent
status, rebuilt on every call) is appended after the conversation. claudeAuth
places its single message-level breakpoint on the last block that is NOT
uncached context, so the growing conversation stays a reusable prefix and the
tail is never written into a cache entry that no later call can match.

Python mirror of the TS ``markUncachedContext`` (back-end/src/providers/rose/cache.ts).
A ``str`` subclass is the marker so nothing extra reaches provider JSON: it
serializes as a plain string, survives dict copies / deepcopy / block merges,
and every provider still sees the same text.
"""

from __future__ import annotations

from typing import Any, Dict


class UncachedContextText(str):
    """Text of a per-call runtime suffix that must never carry the cache breakpoint."""

    __slots__ = ()


def uncached_user_message(text: str) -> Dict[str, Any]:
    """A trailing user message whose text is marked uncached."""
    return {"role": "user", "content": UncachedContextText(text)}


def is_uncached_context(value: Any) -> bool:
    return isinstance(value, UncachedContextText)


__all__ = ["UncachedContextText", "is_uncached_context", "uncached_user_message"]
