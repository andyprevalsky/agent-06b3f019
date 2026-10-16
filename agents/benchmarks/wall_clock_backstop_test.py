"""Execution backstops remain independent of catalog and Polar step budgets."""

import asyncio
from copy import deepcopy

import pytest

import benchmarks.run_benchmark as runner
from benchmarks.benchmark_tasks import get_task_by_name


def test_backstop_default_and_explicit_override(monkeypatch):
    monkeypatch.delenv("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", raising=False)
    assert runner.benchmark_wall_clock_backstop_seconds() == 7200
    monkeypatch.setenv("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", "300")
    assert runner.benchmark_wall_clock_backstop_seconds() == 300


def test_only_the_default_backstop_yields_to_a_longer_task_timeout(monkeypatch):
    long_task = deepcopy(get_task_by_name("chat-mode"))
    long_task.timeout_seconds = 12600
    monkeypatch.delenv("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", raising=False)
    assert runner.agent_execution_backstop_seconds(long_task) == 12600
    long_task._resolved_timeout_seconds = 9000
    assert runner.agent_execution_backstop_seconds(long_task) == 9000
    long_task._resolved_timeout_seconds = 600
    assert runner.agent_execution_backstop_seconds(long_task) == 7200
    long_task._resolved_timeout_seconds = 9000
    for operator_cap in ("300", "7200"):
        monkeypatch.setenv("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", operator_cap)
        assert runner.agent_execution_backstop_seconds(long_task) == int(operator_cap)


def test_realtime_tree_capture_finishes_after_lost_first_cancellation():
    async def case():
        stop = asyncio.Event()
        cancellations = 0

        async def reconnecting_capture():
            nonlocal cancellations
            while True:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancellations += 1
                    if cancellations >= 2:
                        return

        task = asyncio.create_task(reconnecting_capture())
        await asyncio.sleep(0)
        await runner._stop_realtime_tree_capture(task, stop, attempts=3, interval=0.01)
        assert stop.is_set()
        assert task.done()
        assert cancellations == 2

    asyncio.run(case())


@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "nan", "300; exit", "３００"])
def test_invalid_backstop_cannot_disable_safety(monkeypatch, value):
    monkeypatch.setenv("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", value)
    with pytest.raises(ValueError, match="positive integer"):
        runner.benchmark_wall_clock_backstop_seconds()


def test_backstop_cancels_active_poll_then_pauses_before_diagnostics(monkeypatch):
    events = []

    async def progressing_poll(*args):
        snapshot = args[-1]
        snapshot["_benchmark"] = {"approvals_triggered": 2, "approvals_resolved": 2}
        try:
            while True:
                events.append("progress")
                await asyncio.sleep(0.001)
        finally:
            events.append("poll-cancelled")

    async def pause(*args):
        events.append("paused")
        return True

    async def read(*args):
        events.append("diagnostics")
        return {"agent": {"status": "PAUSED"}, "messages": []}

    monkeypatch.setattr(runner, "agent_execution_backstop_seconds", lambda task=None: 0.02)
    monkeypatch.setattr(runner, "_poll_agent", progressing_poll)
    monkeypatch.setattr(runner, "pause_agent", pause)
    monkeypatch.setattr(runner, "get_agent", read)
    task = get_task_by_name("polar-bu-034")
    assert task.timeout_seconds == 0
    result = asyncio.run(runner.poll_agent("http://test", "agent", task))
    assert events.count("progress") > 1
    assert events[-3:] == ["poll-cancelled", "paused", "diagnostics"]
    assert result[1:3] == (2, 2)
    assert "wall-clock backstop" in result[3]
    assert runner._early_fail_should_pause_agent(result[3])
    assert task.timeout_seconds == 0  # The catalog contract is unchanged.


def test_backstop_retries_cancellation_absorbed_by_provider(monkeypatch):
    events = []

    async def reconnecting_poll(*args):
        while True:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                events.append("cancelled")
                if events.count("cancelled") == 2:
                    raise

    async def pause(*args):
        events.append("paused")
        return True

    async def read(*args):
        events.append("diagnostics")
        return {"agent": {"status": "PAUSED"}, "messages": []}

    monkeypatch.setattr(runner, "agent_execution_backstop_seconds", lambda task=None: 0.01)
    monkeypatch.setattr(runner, "_poll_agent", reconnecting_poll)
    monkeypatch.setattr(runner, "pause_agent", pause)
    monkeypatch.setattr(runner, "get_agent", read)
    result = asyncio.run(runner.poll_agent("http://test", "agent", get_task_by_name("polar-bu-034")))
    assert events == ["cancelled", "cancelled", "paused", "diagnostics"]
    assert "wall-clock backstop" in result[3]


def test_inner_timeout_is_not_reported_as_backstop(monkeypatch):
    async def fail(*args):
        raise TimeoutError("provider read timed out")

    monkeypatch.setattr(runner, "_poll_agent", fail)
    with pytest.raises(TimeoutError, match="provider read"):
        asyncio.run(runner.poll_agent("http://test", "agent", get_task_by_name("chat-mode")))


def test_external_cancellation_is_not_reported_as_backstop(monkeypatch):
    async def cancelled(*args):
        raise asyncio.CancelledError

    monkeypatch.setattr(runner, "_poll_agent", cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(runner.poll_agent("http://test", "agent", get_task_by_name("chat-mode")))


def test_terminal_result_passes_through_without_pause(monkeypatch):
    result = ({"agent": {"status": "COMPLETED"}}, 1, 1, None)

    async def complete(*args):
        return result

    async def unexpected_pause(*args):
        pytest.fail("completed task must not be paused by the backstop")

    monkeypatch.setattr(runner, "_poll_agent", complete)
    monkeypatch.setattr(runner, "pause_agent", unexpected_pause)
    assert asyncio.run(runner.poll_agent("http://test", "agent", get_task_by_name("chat-mode"))) == result


def test_backstop_cannot_report_normal_timeout_when_pause_fails(monkeypatch):
    async def hang(*args):
        await asyncio.Event().wait()

    async def reject_pause(*args):
        return False

    monkeypatch.setattr(runner, "agent_execution_backstop_seconds", lambda task=None: 0.001)
    monkeypatch.setattr(runner, "_poll_agent", hang)
    monkeypatch.setattr(runner, "pause_agent", reject_pause)
    with pytest.raises(RuntimeError, match="Could not pause"):
        asyncio.run(runner.poll_agent("http://test", "agent", get_task_by_name("polar-bu-034")))


@pytest.mark.parametrize("phase", ["subscription", "upload", "archive", "checkpoint"])
def test_backstop_covers_real_task_preparation_and_checkpoint(monkeypatch, tmp_path, phase):
    events = []

    class DiagnosticsReached(BaseException):
        pass

    class UnexpectedPoll(BaseException):
        pass

    async def empty(*args, **kwargs):
        return []

    async def create(*args, **kwargs):
        events.append("created")
        return "00000000-0000-4000-8000-000000000031"

    async def hang(*args, **kwargs):
        try:
            events.append(phase)
            await asyncio.Event().wait()
        finally:
            events.append("preparation-cancelled")

    async def pause(*args):
        events.append("paused")
        return True

    async def read(*args):
        events.append("diagnostics")
        # Stop this test at the boundary before evaluation/archive I/O. A
        # BaseException escapes run_single_task's ordinary failure evaluator.
        raise DiagnosticsReached

    async def unexpected_poll(*args):
        raise UnexpectedPoll("polling started before the blocked preparation completed")

    for name in (
        "_apply_live_fixtures",
        "_apply_memory_fixtures",
        "_restore_live_fixture_scenarios_async",
        "subscribe_supabase_realtime_agent",
        "get_agent_tree",
        "post_world_model_update_events",
        "archive_agent_start",
        "upload_attachment",
        "post_attachment_message",
    ):
        monkeypatch.setattr(runner, name, empty)
    monkeypatch.setattr(runner, "create_agent", create)
    monkeypatch.setattr(runner, "pause_agent", pause)
    monkeypatch.setattr(runner, "get_agent", read)
    monkeypatch.setattr(runner, "_poll_agent", unexpected_poll)
    for name in ("collect_logs", "finalize_archive_and_score_world_model", "delete_agent"):
        monkeypatch.setattr(runner, name, unexpected_poll)
    monkeypatch.setattr(runner, "agent_execution_backstop_seconds", lambda task=None: 0.02)
    boundary = {
        "subscription": "subscribe_supabase_realtime_agent",
        "upload": "upload_attachment",
        "archive": "archive_agent_start",
        "checkpoint": "poll_agent_until_message_index",
    }[phase]
    monkeypatch.setattr(runner, boundary, hang)
    task = deepcopy(get_task_by_name("parallel-tool-calls"))
    task.tags = []
    if phase == "upload":
        (tmp_path / "attachment.txt").write_text("fixture")
        monkeypatch.setattr(runner, "TEST_ASSETS_DIR", str(tmp_path))
        task.attachments = ["attachment.txt"]
    kwargs = (
        {"checkpoint_source_index": 1, "checkpoint_source_out": tmp_path / "checkpoint.json"}
        if phase == "checkpoint"
        else {}
    )

    async def run():
        guard = asyncio.timeout(10)
        try:
            async with guard:
                await runner.run_single_task("http://127.0.0.1:39999", task, **kwargs)
        finally:
            assert not guard.expired(), "execution backstop failed to interrupt blocked preparation"

    with pytest.raises(DiagnosticsReached):
        asyncio.run(run())
    assert events == ["created", phase, "preparation-cancelled", "paused", "diagnostics"]


def test_delayed_entry_uses_creation_time_instead_of_restarting_clock(monkeypatch):
    events = []

    async def execute(snapshot):
        await asyncio.sleep(0.01)
        pytest.fail("execution exceeded the already-expired creation deadline")

    async def pause(*args):
        events.append("paused")
        return True

    async def read(*args):
        return {"agent": {"status": "PAUSED"}, "messages": []}

    async def run():
        created_at = asyncio.get_running_loop().time() - 301
        return await runner._run_with_agent_execution_backstop("http://test", "agent", execute, started_at=created_at)

    monkeypatch.setenv("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", "300")
    monkeypatch.setattr(runner, "pause_agent", pause)
    monkeypatch.setattr(runner, "get_agent", read)
    result = asyncio.run(run())
    assert events == ["paused"]
    assert "Timeout after 300s" in result[3]
