"""Blackbox tests for browser step phase timing (browser.step.phases)."""

import asyncio
import re
from pathlib import Path

from structlog.testing import capture_logs

from _test_utils import BlackboxResult, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parents[2]
HANDLER = AGENTS_ROOT / "domains" / "spawn_browser_agent_v3" / "handler.py"


class _FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _timer(clock):
    from domains.spawn_browser_agent_v3.step_timing import StepPhaseTimer

    return StepPhaseTimer(agent_id="agent-1", task_id="task-1", clock=clock)


def test_phases_partition_step_wall_clock():
    clock = _FakeClock()
    timer = _timer(clock)
    timer.start_step(1)
    clock.advance(0.25)
    timer.mark("observe_state")
    clock.advance(3.0)
    timer.mark("llm_decision")
    clock.advance(1.5)
    timer.mark("execute_action")
    clock.advance(0.1)
    summary = timer.finish()

    assert summary["step"] == 1
    assert summary["phases_ms"] == {
        "observe_state": 250,
        "llm_decision": 3000,
        "execute_action": 1500,
        "unattributed": 100,
    }
    assert summary["total_ms"] == sum(summary["phases_ms"].values()) == 4850


def test_repeated_phase_accumulates_and_annotations_attach():
    clock = _FakeClock()
    timer = _timer(clock)
    timer.start_step(7)
    clock.advance(0.2)
    timer.mark("bookkeeping")
    clock.advance(0.3)
    timer.mark("bookkeeping")
    timer.annotate(action="click", llm_round_trip_ms=2900, llm_mode=None)
    summary = timer.finish()

    assert summary["phases_ms"]["bookkeeping"] == 500
    assert summary["action"] == "click"
    assert summary["llm_round_trip_ms"] == 2900
    assert "llm_mode" not in summary


def test_start_step_emits_previous_step_even_on_continue_paths():
    clock = _FakeClock()
    timer = _timer(clock)
    with capture_logs() as logs:
        timer.start_step(1)
        clock.advance(0.4)
        timer.mark("observe_state")
        clock.advance(0.6)
        timer.start_step(2)
        clock.advance(0.1)
        timer.finish()
        assert timer.finish() is None

    events = [entry for entry in logs if entry["event"] == "browser.step.phases"]
    assert [event["step"] for event in events] == [1, 2]
    assert events[0]["phases_ms"] == {"observe_state": 400, "unattributed": 600}
    assert events[0]["total_ms"] == 1000
    assert events[0]["agent_id"] == "agent-1"
    assert events[0]["task_id"] == "task-1"


def test_mark_before_start_is_noop():
    timer = _timer(_FakeClock())
    timer.mark("observe_state")
    timer.annotate(action="click")
    assert timer.finish() is None


def test_browser_loop_marks_every_core_phase():
    source = HANDLER.read_text()
    marked = set(re.findall(r'step_timer\.mark\("([a-z_]+)"\)', source))
    required = {
        "user_control_wait",
        "tab_rebind",
        "otp_fetch",
        "overlay_suppress",
        "observe_state",
        "record_observation",
        "thinking_stream_start",
        "llm_decision",
        "thinking_stream_finish",
        "pre_action_bookkeeping",
        "execute_action",
        "post_action_bookkeeping",
        "loop_delay",
    }
    assert required <= marked, f"missing step phases: {sorted(required - marked)}"
    assert "step_timer.start_step(iteration)" in source
    assert "step_timer.finish()" in source


async def run_all_tests():
    print("browser-step-timing blackbox tests:")
    r = BlackboxResult()
    r.record("phases_partition_step_wall_clock", test_phases_partition_step_wall_clock)
    r.record("repeated_phase_accumulates", test_repeated_phase_accumulates_and_annotations_attach)
    r.record("start_step_emits_previous_step", test_start_step_emits_previous_step_even_on_continue_paths)
    r.record("mark_before_start_is_noop", test_mark_before_start_is_noop)
    r.record("browser_loop_marks_every_core_phase", test_browser_loop_marks_every_core_phase)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
