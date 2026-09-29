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
        raise asyncio.TimeoutError()

    async def sleep(self, seconds):
        self.sleep_calls.append(seconds)


def test_wait_condition_raises_when_live_queue_differs():
    async def check():
        return "navi-agent-tasks@new"

    instance = SimpleNamespace(_check_generation_handoff=check)

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

    async def _run():
        await sleep_or_generation_handoff(
            SimpleNamespace(_check_generation_handoff=check),
            90,
            poll_seconds=30,
            workflow_mod=fake,
        )

    try:
        asyncio.run(_run())
        raise AssertionError("expected GenerationHandoffRequested")
    except GenerationHandoffRequested:
        assert fake.sleep_calls == []


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
    assert fake.sleep_calls == [30.0, 30.0, 30.0]
