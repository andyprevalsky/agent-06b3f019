"""Interruptible parks for cooperative generation cutover.

``run_agent`` only checks the live AgentQueuePointer at the top of a turn,
after the previous tool/LLM/browser activity finished. An unbounded
``wait_condition`` inside a tool (approval, gate, signup, send_message,
``wait_for`` sleep) never reaches that checkpoint — that is how a browser
write-lock parked through a 45m drain SLO and was force-cleared.

Every park that is NOT waiting on a running activity must use these helpers
so cutover can continue_as_new within one 30s poll. Activity-bound waits
(browser / claude-code / spawn activity handles) cannot continue_as_new
until the activity completes; those stay classified ``activity-bound`` and
force-clear *replaces* them if they outlive the SLO.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Callable

from temporalio import workflow
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

from helpers.generation_handoff import GenerationHandoffRequested

HANDOFF_POLL_SECONDS = 30.0


async def live_handoff_queue(workflow_instance: Any) -> str | None:
    """Return the live generation queue when this workflow must hand off, else None.

    Fails open (None) when the workflow cannot check or the pointer read fails.
    """
    checker = getattr(workflow_instance, "_check_generation_handoff", None)
    if checker is None:
        return None
    try:
        result = await checker()
    except Exception:
        return None
    if isinstance(result, str) and result.strip():
        return result.strip()
    return None


def _workflow_mod(workflow_mod: Any | None) -> Any:
    """Use the caller's ``workflow`` module so tests that patch it still see parks."""
    return workflow_mod if workflow_mod is not None else workflow


async def wait_condition_or_generation_handoff(
    predicate: Callable[[], bool],
    workflow_instance: Any,
    *,
    timeout: timedelta | None = None,
    poll_seconds: float = HANDOFF_POLL_SECONDS,
    workflow_mod: Any | None = None,
) -> None:
    """Park until ``predicate()`` is true, or raise ``GenerationHandoffRequested``.

    # cutover-class: primitive
    Must not be called while a Temporal activity started by this workflow is
    still running — continue_as_new is illegal in that state.
    """
    wf = _workflow_mod(workflow_mod)
    started = wf.now() if timeout is not None else None
    while True:
        if predicate():
            return
        handoff_queue = await live_handoff_queue(workflow_instance)
        if handoff_queue:
            raise GenerationHandoffRequested(handoff_queue)
        slice_timeout = timedelta(seconds=poll_seconds)
        if timeout is not None and started is not None:
            remaining = timeout - (wf.now() - started)
            if remaining.total_seconds() <= 0:
                raise asyncio.TimeoutError()
            if remaining < slice_timeout:
                slice_timeout = remaining
        try:
            # cutover-class: primitive
            await wf.wait_condition(predicate, timeout=slice_timeout)
        except (asyncio.TimeoutError, TemporalTimeoutError):
            if timeout is not None and started is not None and (wf.now() - started) >= timeout:
                raise asyncio.TimeoutError()
            continue


async def sleep_or_generation_handoff(
    workflow_instance: Any,
    seconds: float,
    *,
    poll_seconds: float = HANDOFF_POLL_SECONDS,
    workflow_mod: Any | None = None,
) -> None:
    """Deterministic sleep in slices so a long wait_for can still cut over."""
    wf = _workflow_mod(workflow_mod)
    remaining = float(seconds)
    while remaining > 0:
        handoff_queue = await live_handoff_queue(workflow_instance)
        if handoff_queue:
            raise GenerationHandoffRequested(handoff_queue)
        slice_seconds = min(poll_seconds, remaining)
        # cutover-class: primitive
        await wf.sleep(slice_seconds)
        remaining -= slice_seconds
