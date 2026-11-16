"""Unit tests for cooperative generation handoff helpers."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from helpers.generation_handoff import (
    GenerationHandoffRequested,
    parse_shutdown_grace_seconds,
    should_handoff_to_generation,
)
from helpers.wait_condition_or_handoff import (
    HANDOFF_POLL_SECONDS,
    IDLE_HANDOFF_SAFETY_SECONDS,
    note_generation_handoff,
    sleep_or_generation_handoff,
    wait_condition_or_generation_handoff,
)


def test_should_handoff_when_queues_differ():
    assert should_handoff_to_generation("navi-agent-tasks@aaa", "navi-agent-tasks@bbb") is True


def test_should_not_handoff_when_queues_match():
    assert should_handoff_to_generation("navi-agent-tasks@aaa", "navi-agent-tasks@aaa") is False


def test_should_not_handoff_when_either_queue_missing():
    assert should_handoff_to_generation(None, "navi-agent-tasks@bbb") is False
    assert should_handoff_to_generation("navi-agent-tasks@aaa", None) is False
    assert should_handoff_to_generation("", "navi-agent-tasks@bbb") is False
    assert should_handoff_to_generation("navi-agent-tasks@aaa", "  ") is False


def test_parse_shutdown_grace_seconds_supports_units():
    assert parse_shutdown_grace_seconds("35m") == 2100
    assert parse_shutdown_grace_seconds("2100s") == 2100
    assert parse_shutdown_grace_seconds("2100") == 2100
    assert parse_shutdown_grace_seconds("30s") == 30
    assert parse_shutdown_grace_seconds(None) == 2100
    assert parse_shutdown_grace_seconds("nope") == 2100


class _FakeWorkflowMod:
    def __init__(self):
        self.now_value = datetime(2026, 9, 29, tzinfo=timezone.utc)
        self.wait_calls: list[object] = []
        self.sleep_calls: list[float] = []

    def now(self):
        return self.now_value

    async def wait_condition(self, predicate, timeout=None):
        self.wait_calls.append(timeout)
        if predicate():
            return
        if timeout is not None:
            self.now_value = self.now_value + timeout
        raise asyncio.TimeoutError()

    async def sleep(self, seconds):
        self.sleep_calls.append(seconds)


def test_wait_condition_raises_when_live_queue_differs():
    async def check():
        return "navi-agent-tasks@new"

    instance = SimpleNamespace(_check_generation_handoff=check)
    note_generation_handoff(instance, "navi-agent-tasks@new", "navi-agent-tasks@old")

    async def _run():
        await wait_condition_or_generation_handoff(
            lambda: False,
            instance,
            workflow_mod=_FakeWorkflowMod(),
        )

    try:
        asyncio.run(_run())
        raise AssertionError("expected GenerationHandoffRequested")
    except GenerationHandoffRequested as exc:
        assert exc.task_queue == "navi-agent-tasks@new"


def test_wait_condition_returns_when_predicate_already_true():
    async def _run():
        await wait_condition_or_generation_handoff(
            lambda: True,
            SimpleNamespace(),
            workflow_mod=_FakeWorkflowMod(),
        )

    asyncio.run(_run())


def test_sleep_raises_on_handoff_before_first_slice():
    async def check():
        return "navi-agent-tasks@new"

    fake = _FakeWorkflowMod()
    instance = SimpleNamespace(_check_generation_handoff=check)
    note_generation_handoff(instance, "navi-agent-tasks@new", "navi-agent-tasks@old")

    async def _run():
        await sleep_or_generation_handoff(instance, 90, poll_seconds=30, workflow_mod=fake)

    try:
        asyncio.run(_run())
        raise AssertionError("expected GenerationHandoffRequested")
    except GenerationHandoffRequested:
        assert fake.wait_calls == []


def test_unsignalled_park_reads_pointer_only_at_safety_slices():
    """10k idle agents: no pointer activity per 30s; one read per safety slice."""
    reads = []

    async def check():
        reads.append(1)
        return None

    fake = _FakeWorkflowMod()
    instance = SimpleNamespace(_check_generation_handoff=check)
    hours = 2 * 3600

    async def _run():
        await sleep_or_generation_handoff(instance, hours, workflow_mod=fake)

    asyncio.run(_run())
    slices = [timeout.total_seconds() for timeout in fake.wait_calls]
    assert slices == [IDLE_HANDOFF_SAFETY_SECONDS] * int(hours // IDLE_HANDOFF_SAFETY_SECONDS), slices
    # The final slice ends the sleep itself; every earlier one re-checks once.
    assert len(reads) == len(slices) - 1, reads


def test_signalled_but_unconfirmed_handoff_rechecks_every_poll():
    """A signal whose pointer read is not yet admitted re-checks at HANDOFF_POLL_SECONDS."""
    reads = []

    async def check():
        reads.append(1)
        return None if len(reads) < 3 else "navi-agent-tasks@new"

    fake = _FakeWorkflowMod()
    instance = SimpleNamespace(_check_generation_handoff=check)
    note_generation_handoff(instance, "navi-agent-tasks@new", "navi-agent-tasks@old")

    async def _run():
        await wait_condition_or_generation_handoff(lambda: False, instance, workflow_mod=fake)

    try:
        asyncio.run(_run())
        raise AssertionError("expected GenerationHandoffRequested")
    except GenerationHandoffRequested as exc:
        assert exc.task_queue == "navi-agent-tasks@new"
    assert [t.total_seconds() for t in fake.wait_calls] == [HANDOFF_POLL_SECONDS] * 2
    assert len(reads) == 3


def test_note_generation_handoff_is_idempotent_and_ignores_own_queue():
    instance = SimpleNamespace()
    assert note_generation_handoff(instance, "q@old", "q@old") is False
    assert getattr(instance, "_generation_handoff_hint", None) is None
    assert note_generation_handoff(instance, " q@new ", "q@old") is True
    assert note_generation_handoff(instance, "q@new", "q@old") is False
    assert instance._generation_handoff_hint == "q@new"
    assert instance._generation_handoff_hint_seq == 1
    assert note_generation_handoff(instance, "", "q@old") is False
    assert note_generation_handoff(instance, None, "q@old") is False


def test_wait_condition_overall_timeout_normalizes_temporal_timeout():
    """A Temporal TimeoutError after the caller timeout becomes asyncio.TimeoutError."""
    from datetime import timedelta

    from temporalio.exceptions import TimeoutError as TemporalTimeoutError
    from temporalio.exceptions import TimeoutType

    class _TemporalTimeoutMod(_FakeWorkflowMod):
        async def wait_condition(self, predicate, timeout=None):
            self.now_value = datetime(2026, 9, 29, 0, 20, tzinfo=timezone.utc)
            raise TemporalTimeoutError(
                "timed out",
                type=TimeoutType.START_TO_CLOSE,
                last_heartbeat_details=(),
            )

    async def _run():
        await wait_condition_or_generation_handoff(
            lambda: False,
            SimpleNamespace(),
            timeout=timedelta(minutes=15),
            workflow_mod=_TemporalTimeoutMod(),
        )

    try:
        asyncio.run(_run())
        raise AssertionError("expected asyncio.TimeoutError")
    except asyncio.TimeoutError:
        pass
    except GenerationHandoffRequested:
        raise AssertionError("overall timeout must not become a handoff")


def test_sleep_slices_long_wait_into_handoff_polls():
    fake = _FakeWorkflowMod()

    async def _run():
        await sleep_or_generation_handoff(
            SimpleNamespace(),
            90,
            poll_seconds=30,
            workflow_mod=fake,
        )

    asyncio.run(_run())
    # Unsignalled: one deterministic timer for the whole (sub-safety-slice) sleep.
    assert [t.total_seconds() for t in fake.wait_calls] == [90.0]


def test_short_caller_slices_still_reach_the_lost_signal_backstop():
    """A 30s reconcile loop re-entering the park keeps one per-run safety clock.

    Each 30s caller timeout must not read the pointer (that is the old 30s poll),
    but the lost-signal backstop must still fire once per IDLE_HANDOFF_SAFETY_SECONDS.
    """
    from datetime import timedelta

    reads = []

    async def check():
        reads.append(1)
        return None

    fake = _FakeWorkflowMod()
    instance = SimpleNamespace(_check_generation_handoff=check)
    loops = int(2 * IDLE_HANDOFF_SAFETY_SECONDS // 30)

    async def _run():
        for _ in range(loops):
            try:
                await wait_condition_or_generation_handoff(
                    lambda: False, instance, timeout=timedelta(seconds=30), workflow_mod=fake
                )
            except asyncio.TimeoutError:
                continue

    asyncio.run(_run())
    assert len(reads) == 1, reads  # at the 20-minute mark; the 40-minute check is the next park
    assert all(t.total_seconds() == 30 for t in fake.wait_calls), fake.wait_calls


def test_refused_pointer_read_keeps_the_workflow_on_its_current_generation(monkeypatch):
    """RCA 2026-11-15 (agent 08aa04a2): a failed or retired deploy never strands an agent.

    The backend refuses a continuation onto any generation whose admission gate is not
    qualified OPEN; the workflow must then stay on its current queue rather than
    continue_as_new onto the pointer's queue.
    """
    from temporalio import workflow as temporal_workflow

    from workflows.agent_workflow import AgentWorkflow

    current = "navi-agent-tasks-pool-701ac3d5ae3d@f38b8b178a7e"
    live = "navi-agent-tasks-pool-5c33f46a4b8d@40e8aa1c8933"
    outcomes = iter(
        [
            RuntimeError("409 Managed continuation destination is not qualified OPEN"),
            {"task_queue": live, "surface_hash": "40e8aa1c8933"},
            {"task_queue": current, "surface_hash": "f38b8b178a7e"},
        ]
    )

    async def pointer_activity(*_args, **_kwargs):
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(temporal_workflow, "execute_activity", pointer_activity)
    monkeypatch.setattr(temporal_workflow, "info", lambda: SimpleNamespace(task_queue=current))
    monkeypatch.setattr(temporal_workflow, "logger", SimpleNamespace(info=lambda *_: None, warning=lambda *_: None))
    wf = AgentWorkflow()
    assert asyncio.run(wf._check_generation_handoff()) is None, "a refused destination keeps the current queue"
    assert asyncio.run(wf._check_generation_handoff()) == live, "an admitted live generation still hands off"
    assert asyncio.run(wf._check_generation_handoff()) is None
