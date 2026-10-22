"""Workflow-local browser serialization and acknowledged activity cleanup."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from temporalio import workflow

BROWSER_ACTIVITY_QUEUE_PATCH = "persistent-browser-activity-queue-v1"


def browser_activity_queue_enabled() -> bool:
    return not workflow.in_workflow() or workflow.patched(BROWSER_ACTIVITY_QUEUE_PATCH)


@asynccontextmanager
async def browser_activity_turn(owner: Any, enabled: bool) -> AsyncIterator[None]:
    if not enabled:
        yield
        return
    # Owned by this GP workflow, reconstructed in deterministic coroutine order
    # on replay. Never keep this lock on the process-global manager singleton.
    lock = getattr(owner, "_browser_activity_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        owner._browser_activity_lock = lock
    async with lock:
        yield


async def await_owned_browser_cleanup(task: asyncio.Future) -> None:
    """Do not acknowledge cancellation while this activity still owns cleanup."""
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


async def cancel_and_join_browser_activity(handle: Any) -> None:
    """WAIT_CANCELLATION_COMPLETED keeps the workflow turn until worker cleanup."""
    handle.cancel()
    while not handle.done():
        try:
            await asyncio.shield(handle)
        except asyncio.CancelledError:
            pass
        except Exception:
            break
    # Retrieve the terminal error; the caller preserves its cancellation.
    try:
        handle.result()
    except (asyncio.CancelledError, Exception):
        pass
