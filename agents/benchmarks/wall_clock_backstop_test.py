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
        if phase != "archive":
            raise UnexpectedPoll("polling started before the blocked preparation completed")
        try:
            events.append("poll-started")
            await asyncio.Event().wait()
        finally:
            events.append("poll-cancelled")

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
    if phase == "archive":
        assert events[:3] == ["created", "archive", "poll-started"]
        assert set(events[3:5]) == {"preparation-cancelled", "poll-cancelled"}
        assert events[5:] == ["paused", "diagnostics"]
    else:
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


class _ExecutionObserved(BaseException):
    """Stop the real task owner after its execution boundary, before scoring I/O."""


def _archive_observation_owner(monkeypatch, archive, poll=None):
    """Exercise real creation/execute_agent/backstop/finally; replace only external I/O."""
    from unittest.mock import AsyncMock

    task = deepcopy(get_task_by_name("background-agent-message-smoke"))
    outcome = {}
    backstop = runner._run_with_agent_execution_backstop

    async def observe_execution(*args, **kwargs):
        try:
            outcome["result"] = await backstop(*args, **kwargs)
        except BaseException as error:
            outcome["error"] = error
        raise _ExecutionObserved

    for name in (
        "prepare_sandbox_payment_residual", "_apply_live_fixtures", "_apply_memory_fixtures",
        "_apply_auth_test_site", "_restore_live_fixture_scenarios_async", "_release_auth_test_site",
        "subscribe_supabase_realtime_agent", "post_world_model_update_events",
        "_warm_cache_gated_root", "get_agent_tree",
    ):
        monkeypatch.setattr(runner, name, AsyncMock(return_value=[]))
    monkeypatch.setattr(runner, "create_agent", AsyncMock(return_value="private-feedback-root"))
    monkeypatch.setattr(runner, "archive_agent_start", archive)
    monkeypatch.setattr(runner, "_run_with_agent_execution_backstop", observe_execution)
    if poll is not None:
        monkeypatch.setattr(runner, "_poll_agent", poll)

    async def run():
        with pytest.raises(_ExecutionObserved):
            await runner._run_single_task_as_run_user(
                "https://fixture.invalid", task, True, None, "", None, None, None
            )
        return outcome

    return task, run, outcome


def test_start_archive_pending_does_not_hide_background_feedback_window(monkeypatch):
    """A whole explore can finish while required archival is pending; real polling must see it."""
    from unittest.mock import AsyncMock

    async def case():
        archive_started, release_archive = asyncio.Event(), asyncio.Event()
        feedback_posted, poll_finished = asyncio.Event(), asyncio.Event()
        owned = {}
        polls = 0
        real_poll = runner._poll_agent

        async def archive(*args):
            owned["archive"] = asyncio.current_task()
            archive_started.set()
            await release_archive.wait()
            return "private-start-fixture"

        async def poll(*args):
            owned["poll"] = asyncio.current_task()
            try:
                return await real_poll(*args)
            finally:
                poll_finished.set()

        task, run, outcome = _archive_observation_owner(monkeypatch, archive, poll)
        original_timeout, original_price = task.timeout_seconds, task.price_limit_cents
        assert original_timeout == 180
        bg = "private-explore"
        running_rows = [
            {"role": "TOOL", "message": "Started explore agent in background.", "metadata": {
                "toolCallId": bg, "toolName": "spawn_agent", "toolStatus": "FINISHED",
                "runInBackground": True, "hidden": True, "backgroundTaskId": bg,
                "backgroundAddress": bg, "backgroundAgentType": "explore"}},
            {"role": "TOOL", "message": "working", "metadata": {
                "toolCallId": bg, "toolName": "spawn_agent", "toolStatus": "IN_PROGRESS",
                "agentType": "explore", "excludeFromModel": True}},
        ]

        async def get_agent(*args):
            nonlocal polls
            polls += 1
            messages = deepcopy(running_rows)
            if polls > 1:
                messages.extend([
                    {"role": "USER", "text": task.mid_run_feedback["message"]},
                    {"role": "USER", "message": "explore complete", "metadata": {
                        "agentNotification": True, "backgroundTaskId": bg,
                        "agentType": "explore", "status": "completed"}},
                ])
            return {"agent": {"agent_id": "private-feedback-root", "status": "ACTIVE" if polls == 1 else "COMPLETED",
                              "response_schema": task.response_schema}, "messages": messages}

        async def post(*args):
            assert not release_archive.is_set(), "feedback was delayed until archival completed"
            assert polls == 1, "feedback missed the active background task"
            feedback_posted.set()
            return True

        monkeypatch.setattr(runner, "get_agent", get_agent)
        monkeypatch.setattr(runner, "post_message", post)
        monkeypatch.setattr(runner, "get_attention_requests", AsyncMock(return_value=[]))
        monkeypatch.setattr(runner, "_fetch_tree_stats", AsyncMock(return_value={
            "agent_count": 0, "total_messages": 0, "total_cost_cents": 0, "active_count": 0,
            "failed_count": 0, "tree_tokens_in": 0, "tree_tokens_out": 0, "error_agents": [], "all_agents": [],
        }))
        monkeypatch.setattr(runner, "POLL_INTERVAL", 0)
        execution = asyncio.create_task(run())
        try:
            await asyncio.wait_for(archive_started.wait(), 1)
            await asyncio.wait_for(feedback_posted.wait(), 1)
            await asyncio.wait_for(poll_finished.wait(), 1)
            assert not execution.done(), "task returned before its required start archive joined"
            assert "error" not in outcome, repr(outcome.get("error"))
            assert not owned["archive"].done()
            release_archive.set()
            await execution
            assert "error" not in outcome, outcome
            assert task._mid_run_feedback_evidence["background_task"]["background_task_id"] == bg
            assert outcome["result"][0]["agent"]["status"] == "COMPLETED"
            assert (task.timeout_seconds, task.price_limit_cents) == (original_timeout, original_price)
        finally:
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)
        assert all(task.done() for task in owned.values())
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]

    asyncio.run(case())


@pytest.mark.parametrize("failure", ["archive", "poll", "cancel", "archive-cancel"])
def test_start_archive_observation_errors_and_cancellation_join_both(monkeypatch, failure):
    async def case():
        entered = {name: asyncio.Event() for name in ("archive", "poll")}
        retired, owned = set(), {}
        original = RuntimeError(f"{failure} failed")

        async def operation(name):
            owned[name] = asyncio.current_task()
            entered[name].set()
            try:
                await entered["archive"].wait()
                await entered["poll"].wait()
                if failure == name:
                    raise original
                if failure == "archive-cancel" and name == "archive":
                    raise asyncio.CancelledError
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.05)  # Prove asynchronous cancellation cleanup was joined.
                retired.add(name)

        async def archive(*args):
            return await operation("archive")

        async def poll(*args):
            return await operation("poll")

        _, run, outcome = _archive_observation_owner(monkeypatch, archive, poll)
        execution = asyncio.create_task(run())
        try:
            await asyncio.wait_for(entered["archive"].wait(), 1)
            await asyncio.wait_for(entered["poll"].wait(), 1)
            if failure == "cancel":
                execution.cancel()
            await asyncio.wait_for(execution, 1)
            error = outcome["error"]
            if failure in ("archive", "poll"):
                assert error is original, "orchestration hid the original failure"
            else:
                assert isinstance(error, asyncio.CancelledError)
            assert retired == {"archive", "poll"}
            assert all(task.done() for task in owned.values())
        finally:
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]

    asyncio.run(case())


@pytest.mark.parametrize("cancel_phase", ["running", "deadline-drain"])
def test_external_cancel_joins_archive_and_poll_at_actual_backstop_boundary(monkeypatch, cancel_phase):
    async def case():
        entered = {name: asyncio.Event() for name in ("archive", "poll")}
        retired, children = set(), {}
        boundary = {}
        finalizing = asyncio.Event()
        backstop = runner._run_with_agent_execution_backstop
        if cancel_phase == "deadline-drain":
            monkeypatch.setattr(runner, "agent_execution_backstop_seconds", lambda task=None: 0.01)

        async def operation(name):
            children[name] = asyncio.current_task()
            entered[name].set()
            try:
                await asyncio.Event().wait()
            finally:
                finalizing.set()
                await asyncio.sleep(0.05)
                retired.add(name)

        async def archive(*args):
            return await operation("archive")

        async def poll(*args):
            return await operation("poll")

        _, run, _ = _archive_observation_owner(monkeypatch, archive, poll)

        async def check_boundary(*args, **kwargs):
            owner = asyncio.create_task(backstop(*args, **kwargs))
            try:
                for event in entered.values():
                    await asyncio.wait_for(event.wait(), 1)
                if cancel_phase == "deadline-drain":
                    await asyncio.wait_for(finalizing.wait(), 1)
                owner.cancel()
                if cancel_phase == "deadline-drain":
                    await asyncio.sleep(0.01)
                    owner.cancel()  # Repeated cancellation must not abandon or restart the drain.
                with pytest.raises(asyncio.CancelledError):
                    await owner
                boundary["retired"] = set(retired)
                boundary["children_done"] = all(child.done() for child in children.values())
            finally:
                owner.cancel()
                await asyncio.gather(owner, *children.values(), return_exceptions=True)
            raise _ExecutionObserved

        monkeypatch.setattr(runner, "_run_with_agent_execution_backstop", check_boundary)
        await run()
        assert boundary["retired"] == {"archive", "poll"}, "backstop returned before async finalizers joined"
        assert boundary["children_done"]
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]

    asyncio.run(case())


@pytest.mark.parametrize("cancel_phase", ["running", "deadline-drain"])
def test_external_cancel_preserves_slow_sibling_finalizer_at_backstop_boundary(monkeypatch, cancel_phase):
    slow_poll_finalizer_seconds = 0.05  # Simulate slow cleanup work, not synchronization.

    async def case():
        entered = {name: asyncio.Event() for name in ("archive", "poll")}
        retired, children = set(), {}
        boundary = {}
        finalizing = asyncio.Event()
        backstop = runner._run_with_agent_execution_backstop
        if cancel_phase == "deadline-drain":
            monkeypatch.setattr(runner, "agent_execution_backstop_seconds", lambda task=None: 0.01)

        async def operation(name):
            children[name] = asyncio.current_task()
            entered[name].set()
            try:
                await asyncio.Event().wait()
            finally:
                finalizing.set()
                if name == "poll":
                    await asyncio.sleep(slow_poll_finalizer_seconds)
                retired.add(name)

        async def archive(*args):
            return await operation("archive")

        async def poll(*args):
            return await operation("poll")

        _, run, _ = _archive_observation_owner(monkeypatch, archive, poll)

        async def check_boundary(*args, **kwargs):
            owner = asyncio.create_task(backstop(*args, **kwargs))
            try:
                for event in entered.values():
                    await asyncio.wait_for(event.wait(), 1)
                if cancel_phase == "deadline-drain":
                    await asyncio.wait_for(finalizing.wait(), 1)
                owner.cancel()
                if cancel_phase == "deadline-drain":
                    await asyncio.sleep(0)  # Yield to the cancellation owner before cancelling it again.
                    owner.cancel()  # Repeated cancellation must not abandon or restart the drain.
                with pytest.raises(asyncio.CancelledError):
                    await owner
                boundary["retired"] = set(retired)
                boundary["children_done"] = all(child.done() for child in children.values())
            finally:
                owner.cancel()
                await asyncio.gather(owner, *children.values(), return_exceptions=True)
            raise _ExecutionObserved

        monkeypatch.setattr(runner, "_run_with_agent_execution_backstop", check_boundary)
        await run()
        assert boundary["retired"] == {"archive", "poll"}, "backstop returned before async finalizers joined"
        assert boundary["children_done"]
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]

    asyncio.run(case())
