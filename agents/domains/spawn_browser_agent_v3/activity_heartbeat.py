"""Process-local Temporal heartbeat pump for browser activities.

The 2026-07-02 keepalive was an asyncio task on the same loop that runs CDP,
screenshots, and LLM awaits. Concurrent browser activities can starve that
loop; every in-flight activity then misses Temporal's heartbeat window and
dies together with ``activity Heartbeat timeout`` (agent 37b7bb31, 2026-09-09).

Liveness must not share the subsystem it monitors. One daemon thread heartbeats
every registered activity context so a blocked event loop cannot silence the
worker. At 10k concurrent browsers this is still one thread and O(1) register/
unregister — the same per-activity heartbeat RPCs as today, without 10k extra
threads.
"""

from __future__ import annotations

import contextvars
import threading
from typing import Callable, Optional

from temporalio import activity

from .config import HEARTBEAT_KEEPALIVE_SECONDS

KEEPALIVE_MESSAGE = "browser keepalive (renderer/CDP may be blocked by a bot-challenge)"


class BrowserActivityHeartbeat:
    """Shared watchdog that heartbeats registered Temporal activity contexts."""

    def __init__(
        self,
        *,
        keepalive_seconds: float = HEARTBEAT_KEEPALIVE_SECONDS,
        heartbeat_fn: Optional[Callable[..., None]] = None,
    ) -> None:
        self._keepalive_seconds = keepalive_seconds
        self._heartbeat_fn = heartbeat_fn
        self._lock = threading.Lock()
        self._entries: dict[int, contextvars.Context] = {}
        self._next_id = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def register(self) -> int:
        ctx = contextvars.copy_context()
        with self._lock:
            self._next_id += 1
            token = self._next_id
            self._entries[token] = ctx
            self._ensure_thread_locked()
        return token

    def unregister(self, token: int) -> None:
        with self._lock:
            self._entries.pop(token, None)

    def shutdown(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=1.0)
        self._thread = None
        self._stop = threading.Event()

    def _ensure_thread_locked(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="browser-activity-heartbeat",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        beat = self._heartbeat_fn or activity.heartbeat
        while not self._stop.is_set():
            with self._lock:
                items = list(self._entries.items())
            for _token, ctx in items:
                try:
                    ctx.run(beat, KEEPALIVE_MESSAGE)
                except Exception:
                    continue
            if self._stop.wait(self._keepalive_seconds):
                break


_DEFAULT = BrowserActivityHeartbeat()


def start_browser_activity_heartbeat() -> int:
    """Register the current activity context with the process heartbeat pump."""
    return _DEFAULT.register()


def stop_browser_activity_heartbeat(token: int) -> None:
    """Drop a previously registered activity context."""
    _DEFAULT.unregister(token)
