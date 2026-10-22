"""Blackbox tests for the fast_cache backend client (providers/fast_cache/client.py).

Owning-boundary regression for RCA 2026-10-02 (test-mass-agent-run-0,
`t10-no-tool-failures`: `spawn_agent ... status=ERROR` on child 1230af01):

get-position lookups are single-flighted per durable slot through a shared
awaitable. Under backend saturation the summarize_web_fetch call sat on that
shared fetch until `call_temporal_activity_from_activity`'s 90s
`asyncio.wait_for` cancelled attempt 1. `Task.cancel()` cancels the future the
task is awaiting — the SHARED one — so attempt 2 raised `CancelledError` from
`await existing`, a BaseException no `except Exception` ladder catches. It
escaped the explore activity ("Completing activity as failed ... CancelledError"),
Temporal encoded it as `ApplicationError(type="CancelledError")`, and
`_explore_result_after_activity_failure` re-raised it into a tool ERROR chip.

These tests drive the real client with a hanging backend and the real
`call_temporal_activity_from_activity` wrapper.
"""

import asyncio
import json
from contextlib import suppress
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, teardown_mock


class _Resp:
    status_code = 200

    @staticmethod
    def json():
        return {"hit": True, "value": {"tool_calls": [{"name": "web_search"}]}, "key": "k-pos"}


class _HangingBackend:
    """get-position stays open until `release` is set; records every (callSite, step) posted."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.posts: list[tuple[str, int]] = []

    async def post(self, *args, **kwargs):
        del args
        body = kwargs.get("json") or {}
        self.posts.append((str(body.get("callSite")), int(body.get("step") or 0)))
        await self.release.wait()
        return _Resp()

    async def wait_for_posts(self, count: int) -> None:
        for _ in range(200):
            if len(self.posts) >= count:
                return
            await asyncio.sleep(0.001)
        raise AssertionError(f"backend never saw {count} get-position call(s); posts={self.posts}")


class _RetryTwice:
    maximum_attempts = 2
    initial_interval = timedelta(seconds=0.01)
    backoff_coefficient = 1.0
    maximum_interval = timedelta(seconds=0.01)


class _PatchedClient:
    """Point the real client at a hanging fake backend; restore it afterwards.

    Waits for every in-flight get-position task before restoring so a shielded
    fetch can never outlive the fake and reach a real backend.
    """

    def __init__(self) -> None:
        self.backend = _HangingBackend()

    async def __aenter__(self):
        import providers.fast_cache.client as cache_client

        self._mod = cache_client
        self._orig_backend = cache_client._backend
        self._orig_shared = cache_client._shared_client
        cache_client.clear_position_memo()
        cache_client._backend = lambda: ("http://fast-cache.test", "key")
        cache_client._shared_client = lambda: self.backend
        return self.backend

    async def __aexit__(self, *exc):
        self.backend.release.set()
        # Owners schedule prefetch tasks after their own fetch resolves, so
        # drain until no fetch is left rather than once.
        for _ in range(50):
            inflight = list(self._mod._position_inflight.values())
            if not inflight:
                break
            await asyncio.gather(*inflight, return_exceptions=True)
            await asyncio.sleep(0)
        self._mod.clear_position_memo()
        self._mod._backend = self._orig_backend
        self._mod._shared_client = self._orig_shared
        return False


async def test_cancelled_waiter_does_not_poison_shared_get_position():
    """A waiter cancelled by call_temporal_activity_from_activity's wait_for must
    not break the shared fetch for the owner or for its own retry attempt."""
    import providers.fast_cache.client as cache_client
    from loop.activity_helper import call_temporal_activity_from_activity

    async with _PatchedClient() as backend:
        # In the incident the owner was a detached prefetch task from the previous
        # turn's summarize; a sibling caller owning the slot is the same shape.
        owner = asyncio.create_task(cache_client.cache_get_position_fallback("goal-h", "summarize_web_fetch", 2))
        await backend.wait_for_posts(1)
        assert backend.posts == [("summarize_web_fetch", 2)], (
            f"owner should have issued exactly one get-position, got {backend.posts}"
        )

        attempts = 0

        async def lookup():
            # Stands in for summarize_and_filter_links -> lookup_llm_cache.
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                # Backend recovers while the retry is waiting on the shared fetch.
                backend.release.set()
            return await cache_client.cache_get_position_fallback("goal-h", "summarize_web_fetch", 2)

        # Attempt 1 times out (wait_for cancels the waiter); attempt 2 must succeed.
        try:
            retried = await asyncio.wait_for(
                call_temporal_activity_from_activity(
                    lookup,
                    args=[],
                    start_to_close_timeout=timedelta(seconds=1),
                    retry_policy=_RetryTwice(),
                ),
                timeout=5,
            )
        except asyncio.CancelledError:
            raise AssertionError(
                "retry attempt raised CancelledError: the cancelled waiter poisoned the shared get-position future"
            ) from None
        assert attempts == 2, f"expected timeout then retry, got {attempts} attempts"
        assert retried == ({"tool_calls": [{"name": "web_search"}]}, "k-pos"), retried

        owner_result = await asyncio.wait_for(owner, timeout=5)
        assert owner_result == retried, f"owner must receive the shared result, got {owner_result!r}"
        assert backend.posts.count(("summarize_web_fetch", 2)) == 1, (
            f"slot 2 must stay single-flighted, posts={backend.posts}"
        )


async def test_cancelled_owner_still_resolves_waiters():
    """Cancelling the first caller must not strand later callers on a dead future."""
    import providers.fast_cache.client as cache_client

    async with _PatchedClient() as backend:
        owner = asyncio.create_task(cache_client.cache_get_position_fallback("goal-h", "explore_agent", 7))
        await backend.wait_for_posts(1)
        waiter = asyncio.create_task(cache_client.cache_get_position_fallback("goal-h", "explore_agent", 7))
        await asyncio.sleep(0)

        owner.cancel()
        with suppress(asyncio.CancelledError):
            await owner
        backend.release.set()

        try:
            result = await asyncio.wait_for(waiter, timeout=5)
        except asyncio.TimeoutError:
            raise AssertionError(
                "waiter hung: the cancelled owner never resolved the shared get-position future"
            ) from None
        assert result == ({"tool_calls": [{"name": "web_search"}]}, "k-pos"), result
        assert backend.posts.count(("explore_agent", 7)) == 1, (
            f"slot 7 must stay single-flighted, posts={backend.posts}"
        )


async def test_shared_fetch_failure_is_a_plain_exception_for_every_waiter():
    """A transport failure on the shared fetch must surface as a retryable Exception
    (never a BaseException) to each caller, and must not be memoized as a miss."""
    import providers.fast_cache.client as cache_client

    class _FailingBackend:
        def __init__(self) -> None:
            self.posts = 0

        async def post(self, *args, **kwargs):
            del args, kwargs
            self.posts += 1
            raise ConnectionError("backend reset")

    cache_client.clear_position_memo()
    orig_backend, orig_shared = cache_client._backend, cache_client._shared_client
    orig_backoff = cache_client._GET_RETRY_BACKOFF_S
    failing = _FailingBackend()
    cache_client._backend = lambda: ("http://fast-cache.test", "key")
    cache_client._shared_client = lambda: failing
    cache_client._GET_RETRY_BACKOFF_S = 0.0
    try:
        results = await asyncio.gather(
            cache_client.cache_get_position_fallback("goal-h", "execute_loop", 3),
            cache_client.cache_get_position_fallback("goal-h", "execute_loop", 3),
            return_exceptions=True,
        )
        for item in results:
            assert isinstance(item, ConnectionError), f"expected the transport error for each waiter, got {item!r}"
        assert failing.posts == cache_client._GET_MAX_ATTEMPTS, (
            f"one shared fetch with {cache_client._GET_MAX_ATTEMPTS} attempts expected, got {failing.posts}"
        )
        assert cache_client._position_memo_get("goal-h", "execute_loop", 3) is None, "failure must not memoize a miss"
    finally:
        inflight = list(cache_client._position_inflight.values())
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)
        cache_client.clear_position_memo()
        cache_client._backend, cache_client._shared_client = orig_backend, orig_shared
        cache_client._GET_RETRY_BACKOFF_S = orig_backoff


async def _native_demo_recording_case(*, compatibility: bool, recording: bool, status: int):
    """Exercise the real native context, cache write policy and Rose completion.

    Only the external model stream and cache HTTP server are controlled. A
    successful model response is not a persisted replay entry when the frozen
    namespace or the server rejects its write.
    """
    import benchmarks.wmh_rose_provider as native
    import providers.fast_cache.client as cache_client
    import providers.fast_cache.rose_cache as cache_wrapper
    import providers.rose.client as rose_module
    from providers.fast_cache.context import reset_context, set_context
    from providers.rose.types import StreamChunk

    rows, events, provider_calls = {}, [], []

    class _CacheBackend:
        async def post(self, url, *, json, **kwargs):
            del kwargs
            assert url == "http://cache.test/api/fast-cache/set", url
            if status == 200:
                rows[json["key"]] = json["value"]
            return type(
                "Response",
                (),
                {"status_code": status, "json": lambda self: {"ok": status == 200, "stored": status == 200}},
            )()

    async def read_first(keys):
        return next(((rows[key], key) for key in keys if key in rows), (None, None))

    async def stream(**kwargs):
        provider_calls.append(kwargs)
        yield StreamChunk(kind="content", data={"text": "offline native prediction"})
        yield StreamChunk(kind="done", data={})

    tasks = json.loads((Path(__file__).parents[2] / "benchmarks/tasks.json").read_text())
    goal = next(task["prompt"] for task in tasks if task["name"] == "raise-5m-rose-labs-brex")
    context = native._WMHFastCacheContext(
        enabled=True,
        goal=goal,
        root_goal=goal,
        write_enabled=True,
        provider_fast_mode=False,
    )
    assert context.read_enabled and context.soft_complete_allowed
    client = rose_module.RoseClient(openrouter_key="offline")
    env = {
        "FAST_MODE_CACHE_RECORD_DEMO": "1" if recording else "0",
        "FAST_MODE_CACHE_DISABLE_WRITE_THROUGH": "0",
        "BENCHMARK_DEMO_CACHE_READ_ONLY": "0",
    }
    with (
        patch.dict("os.environ", env),
        patch.object(cache_client, "_backend", return_value=("http://cache.test", "offline")),
        patch.object(cache_client, "_shared_client", return_value=_CacheBackend()),
        patch.object(cache_client, "_archive_cache_write", new=AsyncMock()),
        patch.object(cache_client, "cache_get_first", side_effect=read_first),
        patch.object(cache_client, "cache_get_position_fallback", new=AsyncMock(return_value=(None, None))),
        patch.object(client, "_complete_impl", new=stream),
        patch.object(rose_module.logger, "info", side_effect=lambda event, **kw: events.append(event)),
        patch.object(cache_wrapper.logger, "info", side_effect=lambda event, **kw: events.append(event)),
    ):
        token = set_context(context)
        try:
            for _ in range(2):
                kwargs = {
                    "pool": "rose-1-flash",
                    "messages": [{"role": "user", "content": "same request"}],
                    "dump_context": False,
                }
                if compatibility:
                    result = [
                        chunk
                        async for chunk in cache_wrapper.cached_complete(
                            client, call_site="wmh_world_model_timed_distribution_v1", **kwargs
                        )
                    ]
                else:
                    result = [
                        chunk
                        async for chunk in client.complete(call_site="wmh_world_model_timed_distribution_v1", **kwargs)
                    ]
                assert result[-1].kind == "done"
                assert any(chunk.kind == "content" for chunk in result)
        finally:
            reset_context(token)
    accepted = recording and status == 200
    assert len(rows) == int(accepted), rows
    assert events.count("llm.cache.stored") == int(accepted), (
        "Rose reported a stored response without an accepted cache write",
        events,
    )
    assert events.count("llm.cache.store_skipped") == (0 if accepted else 2), events
    assert events.count("llm.cache.replay") == int(accepted), events
    assert len(provider_calls) == (1 if accepted else 2), provider_calls
    assert all(call["provider_fast_mode"] is False for call in provider_calls)


async def test_native_frozen_namespace_never_reports_a_store():
    await _native_demo_recording_case(compatibility=False, recording=False, status=200)


async def test_compatibility_native_frozen_namespace_never_reports_a_store():
    await _native_demo_recording_case(compatibility=True, recording=False, status=200)


async def test_native_rejected_cache_write_never_reports_a_store():
    await _native_demo_recording_case(compatibility=False, recording=True, status=503)


async def test_compatibility_native_rejected_cache_write_never_reports_a_store():
    await _native_demo_recording_case(compatibility=True, recording=True, status=503)


async def test_native_recording_replays_exact_key_with_provider_fast_button_off():
    await _native_demo_recording_case(compatibility=False, recording=True, status=200)


async def test_compatibility_native_recording_replays_exact_key_with_provider_fast_button_off():
    await _native_demo_recording_case(compatibility=True, recording=True, status=200)


async def test_http_200_skipped_persistence_never_reports_store():
    import providers.fast_cache.client as client

    class Response:
        status_code = 200

        def json(self):
            return {"ok": True, "stored": False}

    backend = AsyncMock()
    backend.post.return_value = Response()
    with (
        patch.object(client, "_shared_client", return_value=backend),
        patch.object(client, "_backend", return_value=("http://cache.test", "offline")),
        patch.object(client, "_archive_cache_write", new=AsyncMock()),
    ):
        assert await client.cache_set("ack-control", "llm", "ack-control", {}) is False


def test_candidate_exclusions_shape_cache_request_material():
    from providers.fast_cache.rose_cache import request_key_material
    from providers.rose.truncation import model_key

    original = {"pool": "rose-1-flash", "messages": [{"role": "user", "content": "same request"}]}
    base = request_key_material(original)
    assert request_key_material({**original, "_skip_models": frozenset()}) == base
    excluded = request_key_material({**original, "_skip_models": {"qwen/qwen3.8-27b", "qwen-3.8-27b", "gpt-6-sol-gpt"}})
    assert excluded != base
    assert excluded["skip_models"] == sorted({model_key("qwen-3.8-27b"), model_key("gpt-6-sol")})
    assert "skip_models" not in base


async def test_excluded_cached_actual_candidate_is_not_replayed():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from providers.fast_cache.rose_cache import lookup_llm_cache
    import providers.fast_cache.rose_cache as owner

    ctx = SimpleNamespace(llm_lookup_keys=lambda *args: ["key"])
    for actual, expected in (("candidate-a-gpt", False), ("unknown", False), ("candidate-b-gpt", True)):
        stored = {"actual_model": actual}
        with (
            patch.object(owner.cache_client, "cache_get_first", AsyncMock(return_value=(stored, "key"))),
            patch.object(owner, "july_gp_resolve_execute", AsyncMock(return_value=(stored, "key"))),
            patch.object(owner, "july_explore_resolve", AsyncMock(return_value=(stored, "key"))),
        ):
            value, _ = await lookup_llm_cache(ctx, "test", {"skip_models": ["candidatea"]})
        assert (value is not None) is expected


class _AgentFlagBackend:
    """/api/fast-cache/agent-flag returning the agent row's current goal."""

    def __init__(self, goal: str) -> None:
        self.goal = goal
        self.posts = 0

    async def post(self, url, **kwargs):
        assert url.endswith("/api/fast-cache/agent-flag"), url
        self.posts += 1
        goal = self.goal

        class _FlagResp:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "enabled": False,
                    "goal": goal,
                    "writeEnabled": True,
                    "rootAgentId": "root-agent",
                    "rootGoal": "Root goal",
                    "providerFastMode": True,
                }

        return _FlagResp()


async def test_workflow_start_reads_the_goal_a_wake_persisted():
    """RCA 2026-10-19 tree-feedback-routing run 4 (agent 7304d3f1).

    A wake (send_message_to_agent NEW_TASK) persists the message as Agent.goal
    and starts a new workflow run, often on the worker process that ran the
    previous run. Its per-process memo still held the old goal, so the new
    run's fast_cache_goal was the previous task: the schema baseline consumed
    the original goal row, no schema was regenerated, and the verifier judged
    with neither goal nor schema (0% on correct work).
    """
    import providers.fast_cache.client as cache_client
    from helpers.fast_cache_goal import resolve_fast_cache_context_activity

    agent_id = "woken-drafter"
    backend = _AgentFlagBackend("Draft one cold email to Garry Tan.")
    orig_backend, orig_shared = cache_client._backend, cache_client._shared_client
    cache_client._AGENT_FASTMODE.pop(agent_id, None)
    cache_client._backend = lambda: ("http://fast-cache.test", "key")
    cache_client._shared_client = lambda: backend
    try:
        first = await resolve_fast_cache_context_activity(agent_id)
        assert first["goal"] == "Draft one cold email to Garry Tan."
        # Activities inside the run keep the memo (one lookup per run).
        assert (await cache_client.resolve_agent_fast_mode(agent_id))[1] == first["goal"]
        assert backend.posts == 1, backend.posts

        backend.goal = "Correction: re-sign your draft as Andy Prevalskii and return it."
        second = await resolve_fast_cache_context_activity(agent_id)
        assert second["goal"] == backend.goal, (
            f"new workflow run resolved the previous run's goal from the process memo: {second['goal']!r}"
        )
        assert (await cache_client.resolve_agent_fast_mode(agent_id))[1] == backend.goal, (
            "later activities in the woken run still see the stale memoized goal"
        )
    finally:
        cache_client._AGENT_FASTMODE.pop(agent_id, None)
        cache_client._backend, cache_client._shared_client = orig_backend, orig_shared


async def run_all_tests():
    print("fast-cache-client blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "excluded_cached_candidate_not_replayed", test_excluded_cached_actual_candidate_is_not_replayed
    )
    r.record("candidate_exclusions_cache_material", test_candidate_exclusions_shape_cache_request_material)
    await r.record_async(
        "cancelled_waiter_does_not_poison_shared_get_position",
        test_cancelled_waiter_does_not_poison_shared_get_position,
    )
    await r.record_async("cancelled_owner_still_resolves_waiters", test_cancelled_owner_still_resolves_waiters)
    await r.record_async(
        "shared_fetch_failure_is_a_plain_exception_for_every_waiter",
        test_shared_fetch_failure_is_a_plain_exception_for_every_waiter,
    )
    await r.record_async(
        "native_frozen_namespace_never_reports_a_store",
        test_native_frozen_namespace_never_reports_a_store,
    )
    await r.record_async(
        "compatibility_native_frozen_namespace_never_reports_a_store",
        test_compatibility_native_frozen_namespace_never_reports_a_store,
    )
    await r.record_async(
        "native_rejected_cache_write_never_reports_a_store",
        test_native_rejected_cache_write_never_reports_a_store,
    )
    await r.record_async(
        "compatibility_native_rejected_cache_write_never_reports_a_store",
        test_compatibility_native_rejected_cache_write_never_reports_a_store,
    )
    await r.record_async(
        "native_recording_replays_exact_key_with_provider_fast_button_off",
        test_native_recording_replays_exact_key_with_provider_fast_button_off,
    )
    await r.record_async(
        "compatibility_native_recording_replays_exact_key_with_provider_fast_button_off",
        test_compatibility_native_recording_replays_exact_key_with_provider_fast_button_off,
    )
    await r.record_async(
        "http_200_skipped_persistence_never_reports_store", test_http_200_skipped_persistence_never_reports_store
    )
    await r.record_async(
        "workflow_start_reads_the_goal_a_wake_persisted", test_workflow_start_reads_the_goal_a_wake_persisted
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
