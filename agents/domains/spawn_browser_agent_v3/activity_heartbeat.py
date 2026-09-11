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

import asyncio
import contextvars
import logging
import threading
from typing import Awaitable, Callable, Optional, TypeVar

from temporalio import activity

from .config import HEARTBEAT_KEEPALIVE_SECONDS

logger = logging.getLogger(__name__)

KEEPALIVE_MESSAGE = "browser keepalive (renderer/CDP may be blocked by a bot-challenge)"
_WorkResult = TypeVar("_WorkResult")


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
        self._entries: dict[
            int, tuple[contextvars.Context, Optional[asyncio.AbstractEventLoop]]
        ] = {}
        self._next_id = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def register(self) -> int:
        ctx = contextvars.copy_context()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        with self._lock:
            self._next_id += 1
            token = self._next_id
            self._entries[token] = (ctx, loop)
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

    def _dispatch(self, ctx: contextvars.Context, loop: Optional[asyncio.AbstractEventLoop]) -> None:
        beat = self._heartbeat_fn or activity.heartbeat
        try:
            ctx.run(beat, KEEPALIVE_MESSAGE)
            return
        except RuntimeError:
            # temporalio 1.18.1's async-activity heartbeat calls
            # asyncio.create_task() internally. That raises from this daemon
            # thread (no running loop). Replay the same call on the activity
            # loop so the keepalive is not silently dropped.
            if loop is None or not loop.is_running():
                logger.debug("browser heartbeat dropped: no running activity loop", exc_info=True)
                return

            def _on_loop() -> None:
                try:
                    ctx.run(beat, KEEPALIVE_MESSAGE)
                except Exception:
                    logger.debug("browser heartbeat failed on activity loop", exc_info=True)

            try:
                loop.call_soon_threadsafe(_on_loop)
            except Exception:
                logger.debug("browser heartbeat could not schedule on activity loop", exc_info=True)
        except Exception:
            logger.debug("browser heartbeat failed", exc_info=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                items = list(self._entries.items())
            for _token, (ctx, loop) in items:
                self._dispatch(ctx, loop)
            if self._stop.wait(self._keepalive_seconds):
                break


_DEFAULT = BrowserActivityHeartbeat()


def start_browser_activity_heartbeat() -> int:
    """Register the current activity context with the process heartbeat pump."""
    return _DEFAULT.register()


def stop_browser_activity_heartbeat(token: int) -> None:
    """Drop a previously registered activity context."""
    _DEFAULT.unregister(token)


def browser_activity_checkpoint(*details: object) -> None:
    """Stop cancelled work without interrupting the awaited recording cleanup."""
    if activity.is_cancelled():
        raise asyncio.CancelledError
    activity.heartbeat(*details)


async def wait_for_browser_work(
    work: Awaitable[_WorkResult], *, timeout: float,
) -> _WorkResult:
    """Preserve cancellation when Python 3.11 wait_for returns a completed child.

    This is a work boundary, never a recording or resource-cleanup wrapper.
    Checking in finally also prevents a simultaneous timeout from sending a
    cancelled activity into another recovery step.
    """
    try:
        return await asyncio.wait_for(work, timeout=timeout)
    finally:
        if activity.is_cancelled():
            raise asyncio.CancelledError
