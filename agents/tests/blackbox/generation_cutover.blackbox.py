"""E2E proof that in-tool parks cut over through Temporal continue_as_new.

These tests start a real Temporal WorkflowEnvironment with two workers
(old queue + new queue) and drive the production park helpers. A pointer
flip mid-park must:

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
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

from generation_cutover_workflow_fixture import InToolCutoverWorkflow

OLD_QUEUE = "generation-cutover-old"
NEW_QUEUE = "generation-cutover-new"

_pointer: dict[str, Any] = {"fetches": 0, "flip_after": 1, "locked": None}

_WORKFLOW_RUNNER = SandboxedWorkflowRunner(
    restrictions=SandboxRestrictions.default.with_passthrough_all_modules()
)


def _reset_pointer(*, flip_after: int = 1, locked: str | None = None) -> None:
    _pointer["fetches"] = 0
    _pointer["flip_after"] = flip_after
    _pointer["locked"] = locked


@activity.defn(name="fetch_agent_queue_pointer")
async def mock_fetch_agent_queue_pointer() -> dict[str, Any]:
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
async def mock_notify_sms_event_activity(*_args: Any, **_kwargs: Any) -> None:
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
    assert any(
        event.get("message") == DEPLOY_INTERRUPTED_TOOL_MESSAGE for event in finished
    ), events


async def _execute_park(spec: dict[str, Any]) -> dict[str, Any]:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=OLD_QUEUE,
            workflows=[InToolCutoverWorkflow],
            activities=MOCK_ACTIVITIES,
            workflow_runner=_WORKFLOW_RUNNER,
        ), Worker(
            env.client,
            task_queue=NEW_QUEUE,
            workflows=[InToolCutoverWorkflow],
            activities=MOCK_ACTIVITIES,
            workflow_runner=_WORKFLOW_RUNNER,
        ):
            return await env.client.execute_workflow(
                InToolCutoverWorkflow.run,
                spec,
                id=f"cutover-{spec['park']}-{spec.get('agent_id', 'e2e')}",
                task_queue=OLD_QUEUE,
                execution_timeout=timedelta(seconds=60),
            )


async def test_wait_seconds_park_continues_as_new_onto_live_queue() -> None:
    _reset_pointer(flip_after=1)
    result = await _execute_park(
        {"park": "wait_seconds", "seconds": 90, "agent_id": "wait-seconds-cutover"}
    )
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
    result = await _execute_park(
        {"park": "wait_seconds", "seconds": 2, "agent_id": "wait-seconds-match"}
    )
    assert result["handed_off"] is False, result
    assert result["failed"] is False, result
    events = result.get("events") or []
    assert any(event.get("status") == "FINISHED" for event in events), events
    assert all(
        event.get("message") != DEPLOY_INTERRUPTED_TOOL_MESSAGE for event in events
    ), events
    assert all(event.get("status") != "ERROR" for event in events), events


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
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
