"""Blackbox tests for loop/payload_guard.py."""

import asyncio

from _test_utils import BlackboxResult, teardown_mock


def test_measure_payload_bytes_small():
    """Short args serialize to a small byte count."""
    from loop.payload_guard import measure_payload_bytes

    size = measure_payload_bytes(["hi", {"a": 1}, 42])
    assert 0 < size < 100


def test_measure_payload_bytes_handles_non_json_native():
    """default=str lets datetimes/UUIDs through without blowing up."""
    import uuid
    from datetime import datetime, timezone

    from loop.payload_guard import measure_payload_bytes

    size = measure_payload_bytes([datetime(2026, 4, 18, tzinfo=timezone.utc), uuid.uuid4()])
    assert size > 0


def test_check_activity_payload_under_limit_no_raise():
    """Small args do not raise."""
    from loop.payload_guard import check_activity_payload

    check_activity_payload("demo_activity", ["goal", [{"role": "user", "message": "short"}]])


def test_check_activity_payload_over_limit_raises():
    """Oversize args raise ActivityPayloadTooLarge with activity name + size."""
    from loop.payload_guard import ACTIVITY_PAYLOAD_LIMIT_BYTES, ActivityPayloadTooLarge, check_activity_payload

    # Build ~2 MiB of context to overflow the guard
    big_string = "x" * (ACTIVITY_PAYLOAD_LIMIT_BYTES + 10_000)
    context = [{"role": "user", "message": big_string}]

    raised = False
    try:
        check_activity_payload("execute_reasoning_activity", ["goal", context])
    except ActivityPayloadTooLarge as e:
        raised = True
        assert e.activity_name == "execute_reasoning_activity"
        assert e.size > ACTIVITY_PAYLOAD_LIMIT_BYTES
        assert "execute_reasoning_activity" in str(e)
    assert raised, "expected ActivityPayloadTooLarge"


async def test_dag_reasoning_oversize_context_fails_fast():
    """DAG guards the reasoning schedule and surfaces an error instead of stalling."""
    from unittest.mock import MagicMock, patch

    from loop.dag_executor import TaskDAG, execute_dag
    from loop.payload_guard import ACTIVITY_PAYLOAD_LIMIT_BYTES

    plan_data = {
        "tasks": [{"goal": "Summarize", "tool_name": "reasoning"}],
        "dependencies": {},
    }
    dag = TaskDAG(plan_data)

    # Oversize context: triggers the guard inside _execute_single_task
    oversize_blob = "z" * (ACTIVITY_PAYLOAD_LIMIT_BYTES + 50_000)
    context = [{"role": "user", "message": oversize_blob}]

    events: list = []

    async def post_message(text, role, metadata):
        events.append({"type": "post_message", "text": text, "role": role, "metadata": metadata})

    async def handle_tool_event_fn(event, tcid, tname):
        events.append({"type": "tool_event", "status": event.status, "message": event.message, "tcid": tcid})

    async def execute_tool(name, params, tcid):
        return {"message": f"{name} done"}

    async def execute_activity(fn, args=None, **_kwargs):
        raise AssertionError("execute_activity must NOT be called when payload is oversize")

    with (
        patch("loop.dag_executor.workflow.logger", MagicMock()),
        # Outside a real workflow event loop the patch gates cannot be read;
        # behave as a new execution (all markers applied).
        patch("loop.dag_executor.workflow.patched", side_effect=lambda _pid: True),
    ):
        result = await execute_dag(
            dag=dag,
            agent_id="a",
            user_id="u",
            model="rose-lite",
            context=context,
            execute_activity=execute_activity,
            post_message=post_message,
            execute_tool=execute_tool,
            handle_tool_event_fn=handle_tool_event_fn,
        )

    # A failed DAG task is recoverable: execute_dag returns "needs_llm" so the
    # workflow falls through to run_agent (LLM loop) instead of terminating. The
    # payload guard's contract still holds — it fails fast (no execute_activity),
    # surfaces a visible ERROR tool event, and marks the task FAILED.
    assert result["status"] == "needs_llm"
    tool_events = [e for e in events if e["type"] == "tool_event"]
    assert any("execute_reasoning_activity" in (e.get("message") or "") for e in tool_events), (
        f"expected a visible ERROR tool event mentioning the activity; got {tool_events}"
    )
    assert dag.tasks[0].state.value == "FAILED"


async def run_all_tests():
    print("payload-guard blackbox tests:")
    r = BlackboxResult()
    r.record("measure_small", test_measure_payload_bytes_small)
    r.record("measure_non_json_native", test_measure_payload_bytes_handles_non_json_native)
    r.record("check_under_limit_ok", test_check_activity_payload_under_limit_no_raise)
    r.record("check_over_limit_raises", test_check_activity_payload_over_limit_raises)
    await r.record_async("dag_reasoning_oversize_fails_fast", test_dag_reasoning_oversize_context_fails_fast)
    teardown_mock()
    return r.summary() if hasattr(r, "summary") else r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
