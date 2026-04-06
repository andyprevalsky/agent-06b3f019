"""Blackbox tests for activity_helper domain."""

import asyncio
from datetime import timedelta

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


async def test_call_succeeds_first_try():
    """call_temporal_activity_from_activity returns result on first success."""
    from loop.activity_helper import call_temporal_activity_from_activity

    async def ok_fn():
        return "ok"

    result = await call_temporal_activity_from_activity(
        ok_fn,
        args=[],
        start_to_close_timeout=timedelta(seconds=5),
    )

    assert result == "ok"


async def test_call_retries_on_failure():
    """call_temporal_activity_from_activity retries and returns on second attempt."""
    from loop.activity_helper import call_temporal_activity_from_activity

    call_count = 0

    async def flaky_fn():
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            raise ValueError("transient error")
        return "recovered"

    # Use a simple object with the attributes the function reads
    class FakeRetryPolicy:
        maximum_attempts = 3
        initial_interval = timedelta(seconds=0.01)
        backoff_coefficient = 1.0
        maximum_interval = timedelta(seconds=0.1)

    result = await call_temporal_activity_from_activity(
        flaky_fn,
        args=[],
        start_to_close_timeout=timedelta(seconds=5),
        retry_policy=FakeRetryPolicy(),
    )

    assert result == "recovered"
    assert call_count == 2


async def test_call_timeout():
    """call_temporal_activity_from_activity raises TimeoutError on timeout."""
    from loop.activity_helper import call_temporal_activity_from_activity

    async def slow_fn():
        await asyncio.sleep(10)
        return "never"

    class FakeRetryPolicy:
        maximum_attempts = 1
        initial_interval = timedelta(seconds=0.01)
        backoff_coefficient = 1.0
        maximum_interval = timedelta(seconds=0.01)

    try:
        await call_temporal_activity_from_activity(
            slow_fn,
            args=[],
            start_to_close_timeout=timedelta(seconds=0.1),
            retry_policy=FakeRetryPolicy(),
        )
        raise AssertionError("Expected TimeoutError")
    except TimeoutError:
        pass  # Expected


async def run_all_tests():
    print("activity-helper blackbox tests:")
    r = BlackboxResult()
    await r.record_async("call_succeeds_first_try", test_call_succeeds_first_try)
    await r.record_async("call_retries_on_failure", test_call_retries_on_failure)
    await r.record_async("call_timeout", test_call_timeout)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
