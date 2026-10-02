"""Step-boundary drain signal for long-running, resumable activities.

A browser activity runs for up to an hour, but its worker only lives until the
next deploy. A rolling deploy SIGTERMs the machine (the worker stops polling,
waits out its grace period, then exits mid-activity, which Temporal reports as
a heartbeat timeout). A cooperative cutover leaves the activity running on a
superseded generation until force-clear replaces the agent. Activities that
can checkpoint poll this between steps and return their resume state instead.
"""

from __future__ import annotations

import time

import structlog
from temporalio import activity

from helpers.fetch_queue_pointer import read_agent_queue_pointer
from helpers.generation_handoff import should_handoff_to_generation

logger = structlog.get_logger()

WORKER_SHUTDOWN = "worker_shutdown"
GENERATION_SUPERSEDED = "generation_superseded"

# One pointer read per worker process per window, shared by every activity on
# that worker, so polling costs O(machines) backend reads rather than O(agents).
POINTER_CACHE_SECONDS = 30.0
POINTER_READ_TIMEOUT_SECONDS = 5.0

_cached_at: float | None = None
_cached_queue: str | None = None


def reset_live_queue_cache() -> None:
    """Forget the cached pointer (tests and worker restarts)."""
    global _cached_at, _cached_queue
    _cached_at = None
    _cached_queue = None


async def _live_task_queue() -> str | None:
    global _cached_at, _cached_queue
    now = time.monotonic()
    if _cached_at is not None and now - _cached_at < POINTER_CACHE_SECONDS:
        return _cached_queue
    # Claim the window before awaiting so concurrent activities on this worker
    # reuse the previous answer instead of all refreshing at once.
    _cached_at = now
    try:
        pointer = await read_agent_queue_pointer(timeout_seconds=POINTER_READ_TIMEOUT_SECONDS)
        live = pointer.get("task_queue")
        _cached_queue = live.strip() if isinstance(live, str) and live.strip() else None
    except Exception as exc:
        logger.warning("Activity drain pointer read failed; staying on this generation", error=str(exc))
        _cached_queue = None
    return _cached_queue


async def activity_drain_reason(*, allow_generation_handoff: bool = True) -> str | None:
    """Return why the running activity should checkpoint and return, or None.

    ``WORKER_SHUTDOWN``: this worker began graceful shutdown; the activity must
    finish within the grace period or be killed mid-step.
    ``GENERATION_SUPERSEDED``: the live pointer moved to another generation's
    queue; the workflow can continue_as_new there once the activity returns.
    Pointer read failures fail open (keep running).
    """
    if not activity.in_activity():
        return None
    if activity.is_worker_shutdown():
        return WORKER_SHUTDOWN
    if not allow_generation_handoff:
        return None
    if should_handoff_to_generation(activity.info().task_queue, await _live_task_queue()):
        return GENERATION_SUPERSEDED
    return None
