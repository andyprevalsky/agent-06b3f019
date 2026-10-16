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
from contextlib import suppress
from datetime import timedelta

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
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
