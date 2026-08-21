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


async def test_non_retryable_application_error_runs_exactly_once():
    """ApplicationError(non_retryable=True) is re-raised immediately.

    Regression: prod agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc (2026-08-03).
    web_fetch_activity raised non_retryable=True for a deterministically-bad
    URL and this shim retried it anyway, doubling the cost of every
    deterministic sub-agent tool failure.
    """
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def deterministic_fn():
        nonlocal attempts
        attempts += 1
        raise ApplicationError("deterministic", type="WebFetchProvidersFailed", non_retryable=True)

    try:
        await call_temporal_activity_from_activity(
            deterministic_fn,
            args=[],
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=0)),
        )
    except ApplicationError:
        pass
    else:
        raise AssertionError("expected the non-retryable error to propagate")

    assert attempts == 1, f"non_retryable=True was retried: ran {attempts}x"


async def test_non_retryable_error_types_run_exactly_once():
    """A type listed in retry_policy.non_retryable_error_types is not retried."""
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def deterministic_fn():
        nonlocal attempts
        attempts += 1
        raise ApplicationError("deterministic", type="ToolInputInvalid")

    try:
        await call_temporal_activity_from_activity(
            deterministic_fn,
            args=[],
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                initial_interval=timedelta(seconds=0),
                non_retryable_error_types=["ToolInputInvalid"],
            ),
        )
    except ApplicationError:
        pass
    else:
        raise AssertionError("expected the non-retryable error to propagate")

    assert attempts == 1, f"non_retryable_error_types was ignored: ran {attempts}x"


async def test_plain_exception_class_name_in_non_retryable_error_types():
    """Non-ApplicationError failures match non_retryable_error_types by class name."""
    from temporalio.common import RetryPolicy

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def deterministic_fn():
        nonlocal attempts
        attempts += 1
        raise ValueError("bad input")

    try:
        await call_temporal_activity_from_activity(
            deterministic_fn,
            args=[],
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                initial_interval=timedelta(seconds=0),
                non_retryable_error_types=["ValueError"],
            ),
        )
    except ValueError:
        pass
    else:
        raise AssertionError("expected the non-retryable error to propagate")

    assert attempts == 1, f"class-name match ignored: ran {attempts}x"


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
    await r.record_async(
        "non_retryable_application_error_runs_once", test_non_retryable_application_error_runs_exactly_once
    )
    await r.record_async("non_retryable_error_types_run_once", test_non_retryable_error_types_run_exactly_once)
    await r.record_async(
        "plain_exception_class_name_non_retryable", test_plain_exception_class_name_in_non_retryable_error_types
    )
    await r.record_async("call_timeout", test_call_timeout)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
