"""Interruptible parks for cooperative generation cutover.

``run_agent`` only checks the live AgentQueuePointer at the top of a turn,
after the previous tool/LLM/browser activity finished. An unbounded
``wait_condition`` inside a tool (approval, gate, signup, send_message,
``wait_for`` sleep) never reaches that checkpoint — that is how a browser
write-lock parked through a 45m drain SLO and was force-cleared.

Every park that is NOT waiting on a running activity must use these helpers
so cutover can continue_as_new. Activity-bound waits (browser / claude-code /
spawn activity handles) cannot continue_as_new until the activity completes;
those stay classified ``activity-bound`` and force-clear *replaces* them if
they outlive the SLO.

Push, not poll (10k idle agents)::

    deploy flips AgentQueuePointer ──▶ broadcast-generation-handoff.ts lists
        Running AgentWorkflows on the old queue (Temporal visibility, paged,
        rate-limited) ──signal generation_handoff_available(live_queue)──▶
    note_generation_handoff: hint + seq bump (idempotent per queue)
        ──▶ every park below wakes, reads the pointer once (continuation
            admission), raises GenerationHandoffRequested
    no signal (lost / workflow missed by visibility) ──▶ IDLE_HANDOFF_SAFETY_SECONDS
        slice expiry reads the pointer once; run_agent's top-of-turn check is unchanged.

An idle park therefore costs one pointer activity per safety slice (not per
30s), and a signalled agent re-checks every HANDOFF_POLL_SECONDS only until it
has handed off.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Callable

from temporalio import workflow
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

from helpers.generation_handoff import GenerationHandoffRequested, should_handoff_to_generation

# Re-check cadence once a handoff was signalled but not yet confirmed (e.g. the
# continuation admission was still pending): today's bounded drain behaviour.
HANDOFF_POLL_SECONDS = 30.0
# Unsignalled parks re-read the pointer this often as a lost-signal backstop.
# Stays well under the 45-minute drain SLO before force-clear replacement.
IDLE_HANDOFF_SAFETY_SECONDS = 1200.0
# Signal the cutover owner sends to running workflows on a superseded queue.
GENERATION_HANDOFF_SIGNAL = "generation_handoff_available"


def note_generation_handoff(workflow_instance: Any, task_queue: Any, current_task_queue: str | None = None) -> bool:
    """Record that ``task_queue`` is (probably) the live generation; wake handoff-aware parks.

    Idempotent: a duplicate signal for the queue already hinted is a no-op, and a
    queue equal to this run's own queue is ignored. Returns True when the hint changed.
    The hint only triggers a pointer read; the pointer stays the source of truth.
    """
    queue = task_queue.strip() if isinstance(task_queue, str) else ""
    if not queue:
        return False
    if current_task_queue is None:
        try:
            current_task_queue = workflow.info().task_queue
        except Exception:
            current_task_queue = None
    if current_task_queue and not should_handoff_to_generation(current_task_queue, queue):
        return False
    if getattr(workflow_instance, "_generation_handoff_hint", None) == queue:
        return False
    workflow_instance._generation_handoff_hint = queue
    workflow_instance._generation_handoff_hint_seq = _hint_seq(workflow_instance) + 1
    return True


def _hint_seq(workflow_instance: Any) -> int:
    seq = getattr(workflow_instance, "_generation_handoff_hint_seq", 0)
    return seq if isinstance(seq, int) else 0


def _mark_handoff_checked(workflow_instance: Any, wf: Any) -> None:
    try:
        workflow_instance._generation_handoff_checked_at = _workflow_seconds(wf)
    except Exception:
        pass


def _safety_check_elapsed(workflow_instance: Any, wf: Any, safety_seconds: float) -> bool:
    """True once ``safety_seconds`` of workflow time passed since this run's last park check.

    Tracked on the instance, so callers that re-enter a park in short slices
    (e.g. a 30s reconcile loop) still reach the lost-signal backstop. The first
    park of a run starts the clock without reading the pointer.
    """
    last = getattr(workflow_instance, "_generation_handoff_checked_at", None)
    if not isinstance(last, (int, float)) or isinstance(last, bool):
        _mark_handoff_checked(workflow_instance, wf)
        return False
    return _workflow_seconds(wf) - last >= safety_seconds - 0.001


def _seconds_until_safety_check(workflow_instance: Any, wf: Any, safety_seconds: float) -> float:
    last = getattr(workflow_instance, "_generation_handoff_checked_at", None)
    if not isinstance(last, (int, float)) or isinstance(last, bool):
        return safety_seconds
    return max(1.0, safety_seconds - (_workflow_seconds(wf) - last))


def _hinted(workflow_instance: Any) -> bool:
    hint = getattr(workflow_instance, "_generation_handoff_hint", None)
    return isinstance(hint, str) and bool(hint)


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


def _workflow_seconds(wf: Any) -> float:
    """Deterministic workflow time in seconds (``workflow.time()``; ``now()`` for fakes)."""
    for read in (getattr(wf, "time", None), lambda: wf.now().timestamp()):
        if callable(read):
            try:
                return float(read())
            except Exception:
                continue
    return 0.0  # no clock outside a workflow: the slice budget bounds the wait


async def wait_condition_or_generation_handoff(
    predicate: Callable[[], bool],
    workflow_instance: Any,
    *,
    timeout: timedelta | None = None,
    poll_seconds: float = HANDOFF_POLL_SECONDS,
    safety_seconds: float = IDLE_HANDOFF_SAFETY_SECONDS,
    workflow_mod: Any | None = None,
) -> None:
    """Park until ``predicate()`` is true, or raise ``GenerationHandoffRequested``.

    # cutover-class: primitive
    Must not be called while a Temporal activity started by this workflow is
    still running — continue_as_new is illegal in that state.

    The pointer is read only when a handoff signal is pending (then every
    ``poll_seconds`` until it hands off) or when a ``safety_seconds`` slice
    expires; an unsignalled park schedules no periodic activity.
    """
    wf = _workflow_mod(workflow_mod)
    deadline = _workflow_seconds(wf) + timeout.total_seconds() if timeout is not None else None
    # Expired slices also count toward the deadline, so a wait ends even when the
    # clock does not advance (test doubles stub workflow.now).
    budget = timeout.total_seconds() if timeout is not None else None
    safety_due = False
    while True:
        if predicate():
            return
        hinted = _hinted(workflow_instance)
        if hinted or safety_due or _safety_check_elapsed(workflow_instance, wf, safety_seconds):
            _mark_handoff_checked(workflow_instance, wf)
            handoff_queue = await live_handoff_queue(workflow_instance)
            if handoff_queue:
                raise GenerationHandoffRequested(handoff_queue)
            if predicate():
                return
        safety_due = False
        slice_seconds = poll_seconds if hinted else _seconds_until_safety_check(workflow_instance, wf, safety_seconds)
        clamped = False
        if deadline is not None and budget is not None:
            remaining = min(deadline - _workflow_seconds(wf), budget)
            if remaining <= 0.001:
                raise asyncio.TimeoutError()
            if remaining <= slice_seconds:
                slice_seconds, clamped = remaining, True
        seq = _hint_seq(workflow_instance)
        try:
            # cutover-class: primitive
            await wf.wait_condition(
                lambda: predicate() or _hint_seq(workflow_instance) != seq,
                timeout=timedelta(seconds=slice_seconds),
            )
        except (asyncio.TimeoutError, TemporalTimeoutError):
            if budget is not None:
                budget -= slice_seconds
                if clamped or budget <= 0.001 or (deadline is not None and _workflow_seconds(wf) >= deadline - 0.001):
                    raise asyncio.TimeoutError()
            safety_due = not hinted
        else:
            # Temporal only returns once the condition holds; any other return
            # (a test double) is treated like an expired slice: re-check once.
            if not predicate() and _hint_seq(workflow_instance) == seq:
                safety_due = True


async def sleep_or_generation_handoff(
    workflow_instance: Any,
    seconds: float,
    *,
    poll_seconds: float = HANDOFF_POLL_SECONDS,
    safety_seconds: float = IDLE_HANDOFF_SAFETY_SECONDS,
    workflow_mod: Any | None = None,
) -> None:
    """Deterministic sleep that still cuts over when a handoff is signalled.

    Same wake/re-check rules as ``wait_condition_or_generation_handoff``.
    """
    if seconds <= 0:
        return
    try:
        await wait_condition_or_generation_handoff(
            lambda: False,
            workflow_instance,
            timeout=timedelta(seconds=float(seconds)),
            poll_seconds=poll_seconds,
            safety_seconds=safety_seconds,
            workflow_mod=workflow_mod,
        )
    except asyncio.TimeoutError:
        return


async def sleep_until_woken_or_generation_handoff(
    workflow_instance: Any,
    seconds: float,
    woken: Callable[[], bool],
    *,
    poll_seconds: float = HANDOFF_POLL_SECONDS,
    safety_seconds: float = IDLE_HANDOFF_SAFETY_SECONDS,
    workflow_mod: Any | None = None,
) -> bool:
    """Sleep ``seconds`` unless ``woken()`` turns true first (True = woken early).

    Same handoff-aware wait as ``sleep_or_generation_handoff``; a signal that
    makes ``woken()`` true ends the wait at once. Raises ``GenerationHandoffRequested``.
    """
    if seconds <= 0:
        return bool(woken())
    try:
        await wait_condition_or_generation_handoff(
            woken,
            workflow_instance,
            timeout=timedelta(seconds=seconds),
            poll_seconds=poll_seconds,
            safety_seconds=safety_seconds,
            workflow_mod=workflow_mod,
        )
    except asyncio.TimeoutError:
        return False
    return True
