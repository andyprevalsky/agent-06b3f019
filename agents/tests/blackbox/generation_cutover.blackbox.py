"""E2E proof that in-tool parks cut over through Temporal continue_as_new.

These tests start a real Temporal WorkflowEnvironment with two workers
(old queue + new queue) and drive the production park helpers. A pointer
flip mid-park, announced by the cutover owner's
``generation_handoff_available`` signal, must:

1. close the chip FINISHED with DEPLOY_INTERRUPTED (never ERROR)
2. continue_as_new onto the live queue
3. complete without failing the workflow

A matching pointer must let wait_seconds finish without handing off.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from _test_utils import BlackboxResult, teardown_mock
from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE
from helpers.wait_condition_or_handoff import GENERATION_HANDOFF_SIGNAL, IDLE_HANDOFF_SAFETY_SECONDS
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from helpers.workflow_sandbox import production_workflow_runner
from temporalio.worker import Worker

from generation_cutover_workflow_fixture import InToolCutoverWorkflow

OLD_QUEUE = "generation-cutover-old"
NEW_QUEUE = "generation-cutover-new"

_pointer: dict[str, Any] = {"fetches": 0, "flip_after": 1, "locked": None}

_WORKFLOW_RUNNER = production_workflow_runner()


def _reset_pointer(*, flip_after: int = 1, locked: str | None = None) -> None:
    _pointer["fetches"] = 0
    _pointer["flip_after"] = flip_after
    _pointer["locked"] = locked
    _pointer.pop("read_release", None)


@activity.defn(name="fetch_agent_queue_pointer")
async def mock_fetch_agent_queue_pointer() -> dict[str, Any]:
    release = _pointer.get("read_release")
    if isinstance(release, asyncio.Event):
        await release.wait()
    _pointer["fetches"] = int(_pointer["fetches"]) + 1
    locked = _pointer["locked"]
    if isinstance(locked, str) and locked:
        queue = locked
    elif int(_pointer["fetches"]) > int(_pointer["flip_after"]):
        queue = NEW_QUEUE
    else:
        queue = OLD_QUEUE
    return {"task_queue": queue, "surface_hash": "cutover-e2e"}


@activity.defn(name="create_approval_request_activity")
async def mock_create_approval_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    image_url: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    return f"attn-{agent_id[:8]}"


@activity.defn(name="notify_sms_event_activity")
async def mock_notify_sms_event_activity(
    user_id: str,
    event_type: str,
    agent_id: str,
    payload: dict[str, Any],
    world_model_mode: str | None = None,
) -> None:
    return None


@activity.defn(name="resolve_attention_request_activity")
async def mock_resolve_attention_request_activity(
    user_id: str,
    request_id: str,
    response_text: str,
) -> dict[str, Any]:
    return {"success": True, "request_id": request_id}


@activity.defn(name="create_gate_request_activity")
async def mock_create_gate_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    gate: dict[str, Any],
    gate_key: str,
) -> str:
    return f"gate-{agent_id[:8]}"


MOCK_ACTIVITIES = [
    mock_fetch_agent_queue_pointer,
    mock_create_approval_request_activity,
    mock_notify_sms_event_activity,
    mock_resolve_attention_request_activity,
    mock_create_gate_request_activity,
]


def _assert_handoff_chip(result: dict[str, Any], park: str) -> None:
    assert result["handed_off"] is True, result
    assert result["failed"] is False, result
    assert result["park"] == park, result
    events = result.get("events") or []
    assert events, f"{park} must emit a tool chip before handing off: {result}"
    assert all(event.get("status") != "ERROR" for event in events), events
    finished = [event for event in events if event.get("status") == "FINISHED"]
    assert finished, f"{park} must close FINISHED, not stay open: {events}"
    assert any(event.get("message") == DEPLOY_INTERRUPTED_TOOL_MESSAGE for event in finished), events


def _workers(env: WorkflowEnvironment):
    return (
        Worker(
            env.client,
            task_queue=OLD_QUEUE,
            workflows=[InToolCutoverWorkflow],
            activities=MOCK_ACTIVITIES,
            workflow_runner=_WORKFLOW_RUNNER,
        ),
        Worker(
            env.client,
            task_queue=NEW_QUEUE,
            workflows=[InToolCutoverWorkflow],
            activities=MOCK_ACTIVITIES,
            workflow_runner=_WORKFLOW_RUNNER,
        ),
    )


async def _execute_park(spec: dict[str, Any], *, flip: bool = True) -> dict[str, Any]:
    """Run one park; with ``flip`` the deploy moves the pointer and signals once it is parked."""
    async with await WorkflowEnvironment.start_time_skipping() as env:
        old_worker, new_worker = _workers(env)
        async with old_worker, new_worker:
            handle = await env.client.start_workflow(
                InToolCutoverWorkflow.run,
                spec,
                id=f"cutover-{spec['park']}-{spec.get('agent_id', 'e2e')}",
                task_queue=OLD_QUEUE,
                execution_timeout=timedelta(seconds=60),
            )
            if flip:
                for _ in range(200):
                    if await handle.query(InToolCutoverWorkflow.tool_event_count) > 0:
                        break
                    await asyncio.sleep(0.02)
                assert _pointer["fetches"] == 0, f"a park must not poll the pointer before a signal: {_pointer}"
                _pointer["locked"] = NEW_QUEUE
                await handle.signal(GENERATION_HANDOFF_SIGNAL, NEW_QUEUE)
            return await handle.result()


async def test_wait_seconds_park_continues_as_new_onto_live_queue() -> None:
    _reset_pointer(flip_after=1)
    result = await _execute_park({"park": "wait_seconds", "seconds": 90, "agent_id": "wait-seconds-cutover"})
    _assert_handoff_chip(result, "wait_seconds")


async def test_approval_park_continues_as_new_onto_live_queue() -> None:
    _reset_pointer(flip_after=1)
    result = await _execute_park(
        {
            "park": "approval",
            "question": "Approve the Amazon purchase?",
            "agent_id": "approval-cutover",
        }
    )
    _assert_handoff_chip(result, "approval")


async def test_gate_park_continues_as_new_onto_live_queue() -> None:
    _reset_pointer(flip_after=1)
    result = await _execute_park({"park": "gate", "agent_id": "gate-cutover"})
    _assert_handoff_chip(result, "gate")


async def test_signup_park_continues_as_new_onto_live_queue() -> None:
    _reset_pointer(flip_after=1)
    result = await _execute_park({"park": "signup", "agent_id": "signup-cutover"})
    _assert_handoff_chip(result, "signup")


async def test_matching_pointer_wait_seconds_completes_without_handoff() -> None:
    _reset_pointer(locked=OLD_QUEUE)
    result = await _execute_park({"park": "wait_seconds", "seconds": 2, "agent_id": "wait-seconds-match"}, flip=False)
    assert result["handed_off"] is False, result
    assert result["failed"] is False, result
    events = result.get("events") or []
    assert any(event.get("status") == "FINISHED" for event in events), events
    assert all(event.get("message") != DEPLOY_INTERRUPTED_TOOL_MESSAGE for event in events), events
    assert all(event.get("status") != "ERROR" for event in events), events


async def _wait_for_first_workflow_task(handle: Any) -> None:
    """Return once the workflow's first task completed (its park timer is scheduled)."""
    from temporalio.api.enums.v1 import EventType

    for _ in range(600):
        history = await handle.fetch_history()
        if any(event.event_type == EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED for event in history.events):
            return
        await asyncio.sleep(0.05)
    raise AssertionError("workflow never completed its first task")


async def test_idle_park_reads_no_pointer_for_minutes_then_hands_off_on_signal() -> None:
    """10k idle agents: a parked agent schedules zero pointer activities until signalled.

    A one-hour wait_seconds park runs 19 simulated minutes without a single
    fetch_agent_queue_pointer activity (the old 30s poll did 38). The deploy's
    signal then hands it off at once: exactly one pointer read, no safety-slice wait.
    """
    _reset_pointer(locked=OLD_QUEUE)
    spec = {"park": "wait_seconds", "seconds": 3600, "agent_id": "idle-park-signal"}
    async with await WorkflowEnvironment.start_time_skipping() as env:
        old_worker, new_worker = _workers(env)
        async with old_worker, new_worker:
            handle = await env.client.start_workflow(
                InToolCutoverWorkflow.run,
                spec,
                id="cutover-idle-park-signal",
                task_queue=OLD_QUEUE,
                execution_timeout=timedelta(hours=2),
            )
            # Start the 19 simulated minutes only once the park is in place: the
            # fixture times the handoff from its first workflow task, which a
            # loaded worker can pick up after the test's clock already started.
            await _wait_for_first_workflow_task(handle)
            await env.sleep(timedelta(minutes=19))
            assert _pointer["fetches"] == 0, f"idle park polled the pointer: {_pointer['fetches']} reads in 19 minutes"
            _pointer["locked"] = NEW_QUEUE
            read_release = asyncio.Event()
            _pointer["read_release"] = read_release
            try:
                await handle.signal(GENERATION_HANDOFF_SIGNAL, NEW_QUEUE)
                # A duplicate broadcast (second sweep / retried CLI) is a no-op.
                # Keep this fixture running until both broadcasts are server-acknowledged.
                await handle.signal(GENERATION_HANDOFF_SIGNAL, NEW_QUEUE)
                assert _pointer["fetches"] == 0, "pointer read escaped the signal acknowledgement barrier"
            finally:
                read_release.set()
                _pointer.pop("read_release", None)
            result = await handle.result()
    _assert_handoff_chip(result, "wait_seconds")
    elapsed = timedelta(seconds=result["handoff_after_seconds"])
    assert _pointer["fetches"] == 1, f"signalled handoff must read the pointer exactly once, got {_pointer['fetches']}"
    assert timedelta(minutes=19) <= elapsed < timedelta(seconds=IDLE_HANDOFF_SAFETY_SECONDS), (
        f"handoff waited for the safety slice instead of the signal: {elapsed}"
    )


async def test_lost_signal_park_hands_off_at_safety_recheck() -> None:
    """No signal (missed by visibility, broadcaster down): the safety slice still cuts over."""
    _reset_pointer(locked=NEW_QUEUE)
    spec = {"park": "wait_seconds", "seconds": 3600, "agent_id": "idle-park-lost-signal"}
    async with await WorkflowEnvironment.start_time_skipping() as env:
        old_worker, new_worker = _workers(env)
        async with old_worker, new_worker:
            handle = await env.client.start_workflow(
                InToolCutoverWorkflow.run,
                spec,
                id="cutover-idle-park-lost-signal",
                task_queue=OLD_QUEUE,
                execution_timeout=timedelta(hours=2),
            )
            result = await handle.result()
    _assert_handoff_chip(result, "wait_seconds")
    elapsed = timedelta(seconds=result["handoff_after_seconds"])
    assert _pointer["fetches"] == 1, f"one safety re-check expected, got {_pointer['fetches']}"
    assert (
        timedelta(seconds=IDLE_HANDOFF_SAFETY_SECONDS) <= elapsed < timedelta(seconds=IDLE_HANDOFF_SAFETY_SECONDS + 60)
    ), elapsed


async def run_all_tests() -> bool:
    print("generation-cutover blackbox tests:")
    result = BlackboxResult()
    await result.record_async(
        "wait_seconds_park_continues_as_new",
        test_wait_seconds_park_continues_as_new_onto_live_queue,
    )
    await result.record_async(
        "approval_park_continues_as_new",
        test_approval_park_continues_as_new_onto_live_queue,
    )
    await result.record_async(
        "gate_park_continues_as_new",
        test_gate_park_continues_as_new_onto_live_queue,
    )
    await result.record_async(
        "signup_park_continues_as_new",
        test_signup_park_continues_as_new_onto_live_queue,
    )
    await result.record_async(
        "matching_pointer_wait_seconds_no_handoff",
        test_matching_pointer_wait_seconds_completes_without_handoff,
    )
    await result.record_async(
        "idle_park_zero_pointer_reads_then_signal_handoff",
        test_idle_park_reads_no_pointer_for_minutes_then_hands_off_on_signal,
    )
    await result.record_async(
        "lost_signal_park_hands_off_at_safety_recheck",
        test_lost_signal_park_hands_off_at_safety_recheck,
    )
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
