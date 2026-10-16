"""Blackbox tests for the step-boundary drain signal used by resumable activities.

A long browser activity polls ``activity_drain_reason`` between steps. It must
report a worker drain (graceful shutdown during a rolling deploy) and a
superseded generation (cooperative cutover moved the live pointer), share one
pointer read per worker process per window, and fail open when the pointer
cannot be read.
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from _test_utils import BlackboxResult, teardown_mock
from temporalio.testing import ActivityEnvironment

from helpers import activity_generation_drain as drain
from helpers.activity_generation_drain import (
    GENERATION_SUPERSEDED,
    WORKER_SHUTDOWN,
    activity_drain_reason,
    reset_live_queue_cache,
)

OLD_QUEUE = "navi-agent-tasks-gen-old"
NEW_QUEUE = "navi-agent-tasks-gen-new"


def _activity_env(task_queue: str = OLD_QUEUE) -> ActivityEnvironment:
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, task_queue=task_queue)
    return env


async def _probe(**kwargs) -> str | None:
    return await activity_drain_reason(**kwargs)


async def test_outside_activity_never_drains() -> None:
    reset_live_queue_cache()
    pointer = AsyncMock(return_value={"task_queue": NEW_QUEUE})
    with patch.object(drain, "read_agent_queue_pointer", pointer):
        assert await activity_drain_reason() is None
    pointer.assert_not_awaited()


async def test_worker_shutdown_drains_without_reading_the_pointer() -> None:
    reset_live_queue_cache()
    env = _activity_env()
    env.worker_shutdown()
    pointer = AsyncMock(return_value={"task_queue": OLD_QUEUE})
    with patch.object(drain, "read_agent_queue_pointer", pointer):
        assert await env.run(_probe) == WORKER_SHUTDOWN
        assert await env.run(_probe, allow_generation_handoff=False) == WORKER_SHUTDOWN
    pointer.assert_not_awaited()


async def test_superseded_generation_drains_and_live_generation_does_not() -> None:
    reset_live_queue_cache()
    with patch.object(drain, "read_agent_queue_pointer", AsyncMock(return_value={"task_queue": NEW_QUEUE})):
        assert await _activity_env(OLD_QUEUE).run(_probe) == GENERATION_SUPERSEDED
        assert await _activity_env(NEW_QUEUE).run(_probe) is None


async def test_generation_handoff_opt_out_keeps_running_when_superseded() -> None:
    reset_live_queue_cache()
    pointer = AsyncMock(return_value={"task_queue": NEW_QUEUE})
    with patch.object(drain, "read_agent_queue_pointer", pointer):
        assert await _activity_env(OLD_QUEUE).run(_probe, allow_generation_handoff=False) is None
    pointer.assert_not_awaited()


async def test_one_pointer_read_per_worker_per_window() -> None:
    """Polling must cost O(machines) backend reads, not O(running activities)."""
    reset_live_queue_cache()
    pointer = AsyncMock(return_value={"task_queue": OLD_QUEUE})
    clock = {"now": 1_000.0}
    with (
        patch.object(drain, "read_agent_queue_pointer", pointer),
        patch.object(drain.time, "monotonic", side_effect=lambda: clock["now"]),
    ):
        env = _activity_env(OLD_QUEUE)
        results = await asyncio.gather(*(env.run(_probe) for _ in range(25)))
        assert results == [None] * 25
        assert pointer.await_count == 1, f"25 concurrent activities read the pointer {pointer.await_count} times"

        pointer.return_value = {"task_queue": NEW_QUEUE}
        clock["now"] += drain.POINTER_CACHE_SECONDS - 1
        assert await env.run(_probe) is None, "a cached pointer must be reused inside the window"
        assert pointer.await_count == 1

        clock["now"] += 2
        assert await env.run(_probe) == GENERATION_SUPERSEDED
        assert pointer.await_count == 2
    pointer_timeout = pointer.await_args.kwargs.get("timeout_seconds")
    assert pointer_timeout == drain.POINTER_READ_TIMEOUT_SECONDS, pointer_timeout
    assert pointer.await_args.kwargs.get("observation_only") is True


async def test_pointer_read_failure_fails_open() -> None:
    reset_live_queue_cache()
    failing = AsyncMock(side_effect=RuntimeError("backend unavailable"))
    with patch.object(drain, "read_agent_queue_pointer", failing):
        assert await _activity_env(OLD_QUEUE).run(_probe) is None
    reset_live_queue_cache()
    with patch.object(drain, "read_agent_queue_pointer", AsyncMock(return_value={"task_queue": "  "})):
        assert await _activity_env(OLD_QUEUE).run(_probe) is None


async def test_pointer_activity_sends_native_source_run_identity() -> None:
    pointer = importlib.import_module("helpers.fetch_queue_pointer")
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"taskQueue": NEW_QUEUE, "surfaceHash": "new"})

    original_client = httpx.AsyncClient

    def client(**kwargs):
        return original_client(transport=httpx.MockTransport(handler), **kwargs)

    env = _activity_env()
    env.info = dataclasses.replace(env.info, workflow_id="chain-id", workflow_run_id="exact-run-id")
    with (
        patch.object(
            pointer,
            "config",
            SimpleNamespace(backend=SimpleNamespace(api_url="http://localhost:43119", api_key="offline-key")),
        ),
        patch.object(pointer.httpx, "AsyncClient", client),
    ):
        value = await env.run(pointer.fetch_agent_queue_pointer)
    assert value["task_queue"] == NEW_QUEUE
    assert len(requests) == 1
    assert requests[0].headers["X-Workflow-Id"] == "chain-id"
    assert requests[0].headers["X-Workflow-Run-Id"] == "exact-run-id"
    assert requests[0].headers["X-API-Key"] == "offline-key"


async def run_all_tests() -> bool:
    print("activity-generation-drain blackbox tests:")
    result = BlackboxResult()
    await result.record_async("outside_activity_never_drains", test_outside_activity_never_drains)
    await result.record_async(
        "worker_shutdown_drains_without_reading_pointer",
        test_worker_shutdown_drains_without_reading_the_pointer,
    )
    await result.record_async(
        "superseded_generation_drains_live_generation_does_not",
        test_superseded_generation_drains_and_live_generation_does_not,
    )
    await result.record_async(
        "generation_handoff_opt_out_keeps_running",
        test_generation_handoff_opt_out_keeps_running_when_superseded,
    )
    await result.record_async("one_pointer_read_per_worker_per_window", test_one_pointer_read_per_worker_per_window)
    await result.record_async("pointer_read_failure_fails_open", test_pointer_read_failure_fails_open)
    await result.record_async(
        "pointer_activity_native_identity", test_pointer_activity_sends_native_source_run_identity
    )
    reset_live_queue_cache()
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
