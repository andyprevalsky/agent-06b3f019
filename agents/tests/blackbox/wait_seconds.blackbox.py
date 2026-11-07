"""Blackbox tests for wait-seconds domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_emits_wait_event():
    """WaitSecondsManager yields an event with the wait duration."""
    from tools.wait_seconds import WaitSecondsManager
    from tools.base import MessageStatus

    manager = WaitSecondsManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"seconds": 30},
        tool_call_id="tc-1",
    )
    event = await gen.__anext__()

    assert event.status in (MessageStatus.IN_PROGRESS, MessageStatus.FINISHED)


async def test_no_outbound_http_calls():
    """wait_seconds makes zero outbound HTTP calls."""
    from tools.wait_seconds import WaitSecondsManager

    manager = WaitSecondsManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"seconds": 5},
        tool_call_id="tc-2",
    )
    event = await gen.__anext__()

    assert len(get_captured_requests()) == 0


# -------------------- service.py tests --------------------


def test_format_duration_seconds():
    from domains.wait_seconds.service import format_duration

    assert format_duration(1) == "1 second"
    assert format_duration(30) == "30 seconds"


def test_format_duration_minutes():
    from domains.wait_seconds.service import format_duration

    assert format_duration(60) == "1 minute"
    assert format_duration(120) == "2 minutes"


def test_format_duration_fractional_minutes():
    from domains.wait_seconds.service import format_duration

    # 90 seconds = 1.5 minutes
    assert format_duration(90) == "1.5 minutes"


def test_format_duration_hours():
    from domains.wait_seconds.service import format_duration

    assert format_duration(3600) == "1 hour"
    assert format_duration(7200) == "2 hours"


def test_format_duration_fractional_hours():
    from domains.wait_seconds.service import format_duration

    # 5400 seconds = 1.5 hours
    assert format_duration(5400) == "1.5 hours"


def test_format_duration_days():
    from domains.wait_seconds.service import format_duration

    assert format_duration(86400) == "1 day"
    assert format_duration(172800) == "2 days"


def test_format_duration_fractional_days():
    from domains.wait_seconds.service import format_duration

    # 129600 seconds = 1.5 days
    assert format_duration(129600) == "1.5 days"


def test_validate_seconds_valid():
    from domains.wait_seconds.service import validate_seconds

    assert validate_seconds(1) is None
    assert validate_seconds(100) is None
    assert validate_seconds(3600) is None


def test_validate_seconds_too_low():
    from domains.wait_seconds.service import validate_seconds

    err = validate_seconds(0)
    assert err is not None


def test_validate_seconds_too_high():
    from domains.wait_seconds.service import validate_seconds
    from domains.wait_seconds.config import MAX_WAIT

    err = validate_seconds(MAX_WAIT + 1)
    assert err == f"Wait duration must be between 1 second and 31 days (got {MAX_WAIT + 1} seconds)", err
    # Anything inside the real bounds is valid (the text used to claim 3600s was the max).
    assert validate_seconds(7200) is None


# -------------------- handler.py tests --------------------


async def test_execute_tool_invalid_yields_error():
    """WaitSecondsManager yields ERROR on invalid duration."""
    from tools.wait_seconds import WaitSecondsManager
    from tools.base import MessageStatus

    manager = WaitSecondsManager()
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={"seconds": 0},  # Below MIN_WAIT
        tool_call_id="tc-1",
    ):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR


async def test_execute_tool_happy_path_yields_in_progress_then_finished():
    """Valid duration: yields IN_PROGRESS then FINISHED after sleep completes."""
    from tools.wait_seconds import WaitSecondsManager
    from tools.base import MessageStatus
    from unittest.mock import patch

    async def fake_timer(_predicate, timeout=None):
        raise asyncio.TimeoutError()  # the wait's timer fired

    manager = WaitSecondsManager()
    events = []
    with patch("temporalio.workflow.wait_condition", fake_timer):
        async for event in manager.execute_tool(
            workflow_instance=None,
            tool_call={"seconds": 10},
            tool_call_id="tc-1",
        ):
            events.append(event)

    assert len(events) == 2
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[1].status == MessageStatus.FINISHED


async def test_execute_tool_sleep_raises_yields_error():
    """If workflow.sleep raises, yields ERROR."""
    from tools.wait_seconds import WaitSecondsManager
    from tools.base import MessageStatus
    from unittest.mock import patch

    async def bad_sleep(_predicate, timeout=None):
        raise RuntimeError("sleep cancelled")

    manager = WaitSecondsManager()
    events = []
    with patch("temporalio.workflow.wait_condition", bad_sleep):
        async for event in manager.execute_tool(
            workflow_instance=None,
            tool_call={"seconds": 10},
            tool_call_id="tc-1",
        ):
            events.append(event)

    assert events[-1].status == MessageStatus.ERROR
    assert "sleep cancelled" in events[-1].message


async def test_execute_tool_handoff_yields_finished_and_raises():
    """A signalled live generation pointer during sleep closes FINISHED, not ERROR."""
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested
    from tools.base import MessageStatus
    from tools.wait_seconds import WaitSecondsManager

    class FakeWorkflow:
        # generation_handoff_available was delivered by the cutover owner.
        _generation_handoff_hint = "navi-agent-tasks@new"
        _generation_handoff_hint_seq = 1

        async def _check_generation_handoff(self):
            return "navi-agent-tasks@new"

    manager = WaitSecondsManager()
    events = []
    raised = None
    try:
        async for event in manager.execute_tool(
            workflow_instance=FakeWorkflow(),
            tool_call={"seconds": 10},
            tool_call_id="tc-handoff",
        ):
            events.append(event)
    except GenerationHandoffRequested as exc:
        raised = exc

    assert raised is not None
    assert raised.task_queue == "navi-agent-tasks@new"
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[-1].status == MessageStatus.FINISHED
    assert events[-1].message == DEPLOY_INTERRUPTED_TOOL_MESSAGE


async def test_wait_seconds_entry_point():
    """wait_seconds() entry point iterates events and returns last status."""
    from tools.wait_seconds import wait_seconds
    from tools.base import MessageStatus
    from unittest.mock import patch

    events_sent = []

    class FakeWorkflow:
        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            events_sent.append(event)

    async def fake_timer(_predicate, timeout=None):
        raise asyncio.TimeoutError()

    with patch("temporalio.workflow.wait_condition", fake_timer):
        status = await wait_seconds(
            workflow_instance=FakeWorkflow(),
            tool_call={"seconds": 5},
            tool_call_id="tc-1",
        )
    assert status == MessageStatus.FINISHED
    assert len(events_sent) == 2


class _SimWF:
    """Minimal workflow-instance stand-in carrying the world-model mode + sim clock."""

    def __init__(self, world_model_mode: str):
        self.world_model_mode = world_model_mode
        self.simulated_clock_offset_seconds = 0


async def test_execute_tool_simulate_mode_skips_sleep_and_advances_sim_clock():
    """World-model simulate: wait_seconds never sleeps; it advances the logical clock."""
    from unittest.mock import patch

    from tools.base import MessageStatus
    from tools.wait_seconds import WaitSecondsManager

    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    wf = _SimWF("simulate")
    with patch("temporalio.workflow.sleep", fake_sleep):
        events = [
            e
            async for e in WaitSecondsManager().execute_tool(
                workflow_instance=wf, tool_call={"seconds": 300}, tool_call_id="tc-sim"
            )
        ]

    assert sleeps == []
    assert events[-1].status == MessageStatus.FINISHED
    assert "simulated" in events[-1].title
    assert events[-1].metadata["simulatedTimeSkip"] is True
    assert events[-1].metadata["simulatedSkipSeconds"] == 300
    assert events[-1].metadata["simulatedClockOffsetSeconds"] == 300
    assert wf.simulated_clock_offset_seconds == 300

    # Skips accumulate across calls.
    with patch("temporalio.workflow.sleep", fake_sleep):
        events_2 = [
            e
            async for e in WaitSecondsManager().execute_tool(
                workflow_instance=wf, tool_call={"seconds": 60}, tool_call_id="tc-sim-2"
            )
        ]
    assert sleeps == []
    assert events_2[-1].metadata["simulatedClockOffsetSeconds"] == 360
    assert wf.simulated_clock_offset_seconds == 360


async def test_execute_tool_real_mode_still_sleeps_and_keeps_sim_clock_at_zero():
    """Real mode is unchanged: the full wall-clock sleep runs and no sim clock moves."""
    from unittest.mock import patch

    from tools.base import MessageStatus
    from tools.wait_seconds import WaitSecondsManager

    sleeps = []

    async def fake_timer(_predicate, timeout=None):
        sleeps.append(timeout.total_seconds())
        raise asyncio.TimeoutError()

    wf = _SimWF("real")
    with patch("temporalio.workflow.wait_condition", fake_timer):
        events = [
            e
            async for e in WaitSecondsManager().execute_tool(
                workflow_instance=wf, tool_call={"seconds": 300}, tool_call_id="tc-real"
            )
        ]

    # One deterministic timer: no 30s pointer-poll slices while unsignalled.
    assert sleeps == [300.0], sleeps
    assert events[-1].status == MessageStatus.FINISHED
    assert "simulatedTimeSkip" not in (events[-1].metadata or {})
    assert wf.simulated_clock_offset_seconds == 0


def test_wait_seconds_is_not_a_model_tool_and_routes_to_wait_for():
    """wait_seconds has no wake handling, so no model/DAG path may reach it.

    The LLM can only call TOOL_EXECUTORS tools; an old plan's wait_seconds task
    is aliased to wait_for, which wakes on user/agent messages (helpers/wait_wake.py).
    """
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, TOOL_ALIASES, TOOL_MODELS
    from workflows.agent_workflow import TOOL_EXECUTORS

    assert "wait_seconds" not in TOOL_EXECUTORS
    assert "wait_seconds" not in EXECUTE_PHASE_TOOLS and "wait_seconds" not in TOOL_MODELS
    assert TOOL_ALIASES["wait_seconds"] == "wait_for" and "wait_for" in TOOL_EXECUTORS


async def run_all_tests():
    print("wait-seconds blackbox tests:")
    r = BlackboxResult()
    await r.record_async("emits_wait_event", test_emits_wait_event)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    r.record("format_duration_seconds", test_format_duration_seconds)
    r.record("format_duration_minutes", test_format_duration_minutes)
    r.record("format_duration_fractional_minutes", test_format_duration_fractional_minutes)
    r.record("format_duration_hours", test_format_duration_hours)
    r.record("format_duration_fractional_hours", test_format_duration_fractional_hours)
    r.record("format_duration_days", test_format_duration_days)
    r.record("format_duration_fractional_days", test_format_duration_fractional_days)
    r.record("validate_seconds_valid", test_validate_seconds_valid)
    r.record("validate_seconds_too_low", test_validate_seconds_too_low)
    r.record("validate_seconds_too_high", test_validate_seconds_too_high)
    await r.record_async("execute_tool_invalid_yields_error", test_execute_tool_invalid_yields_error)
    await r.record_async("execute_tool_happy_path", test_execute_tool_happy_path_yields_in_progress_then_finished)
    await r.record_async("execute_tool_sleep_raises", test_execute_tool_sleep_raises_yields_error)
    await r.record_async("execute_tool_handoff_finished", test_execute_tool_handoff_yields_finished_and_raises)
    await r.record_async("wait_seconds_entry_point", test_wait_seconds_entry_point)
    await r.record_async(
        "execute_tool_simulate_skips_sleep", test_execute_tool_simulate_mode_skips_sleep_and_advances_sim_clock
    )
    await r.record_async(
        "execute_tool_real_mode_still_sleeps", test_execute_tool_real_mode_still_sleeps_and_keeps_sim_clock_at_zero
    )
    r.record("wait_seconds_not_a_model_tool", test_wait_seconds_is_not_a_model_tool_and_routes_to_wait_for)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
