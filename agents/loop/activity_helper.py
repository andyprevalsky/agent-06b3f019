"""
Helper for calling Temporal activities from within another activity.

When `run_agent` is used inside a Temporal activity (e.g., browser agent),
we can't use `workflow.execute_activity()`. Instead, we call the activity
function directly with retry/timeout semantics.
"""

import asyncio
from datetime import timedelta
from typing import Any, Callable, List, Optional, TypeVar

from temporalio.exceptions import ApplicationError

from utils.error_utils import extract_error_message
from helpers.workflow_safe import context_logger

logger = context_logger()

T = TypeVar("T")


def _is_non_retryable_error(error: BaseException, retry_policy: Optional[Any]) -> bool:
    """Mirror Temporal's non-retryable classification for the in-activity shim.

    Temporal stops retrying when the failure is an ``ApplicationError`` with
    ``non_retryable=True``, or when the failure's type appears in the retry
    policy's ``non_retryable_error_types``. This shim replaces
    ``workflow.execute_activity`` for activity-to-activity calls, so it must
    honour both — otherwise a deterministic failure (e.g. web_fetch rejecting a
    bad URL) is retried anyway and costs double.

    Non-``ApplicationError`` exceptions are matched by class name, which is the
    type Temporal's failure converter assigns them.
    """
    if isinstance(error, ApplicationError) and error.non_retryable:
        return True

    non_retryable_types = getattr(retry_policy, "non_retryable_error_types", None) or ()
    if not non_retryable_types:
        return False

    error_type = error.type if isinstance(error, ApplicationError) else type(error).__name__
    return error_type in non_retryable_types


async def call_temporal_activity_from_activity(
    func: Callable[..., T],
    *,
    args: List[Any],
    start_to_close_timeout: timedelta = timedelta(seconds=60),
    retry_policy: Optional[Any] = None,  # temporalio.common.RetryPolicy
) -> T:
    """
    Call an async function with Temporal-like retry/timeout semantics.

    Signature matches workflow.execute_activity() so they can be used interchangeably.

    Use this when calling activity functions directly from within another activity
    (e.g., browser agent calling web_search_activity) to get similar retry behavior
    as workflow.execute_activity().

    Args:
        func: The async function to call (e.g., an @activity.defn function)
        args: Arguments to pass to the function
        start_to_close_timeout: Timeout for each attempt (matches Temporal)
        retry_policy: Optional RetryPolicy (extracts max_attempts, intervals, etc.)

    Returns:
        The result from the function

    Raises:
        The last exception if all retries fail
    """
    # Extract retry params from policy or use defaults
    max_attempts = 3
    initial_interval = 1.0
    backoff_coefficient = 2.0
    max_interval = 10.0

    if retry_policy:
        max_attempts = getattr(retry_policy, "maximum_attempts", 3) or 3
        if hasattr(retry_policy, "initial_interval") and retry_policy.initial_interval:
            initial_interval = retry_policy.initial_interval.total_seconds()
        if hasattr(retry_policy, "backoff_coefficient") and retry_policy.backoff_coefficient:
            backoff_coefficient = retry_policy.backoff_coefficient
        if hasattr(retry_policy, "maximum_interval") and retry_policy.maximum_interval:
            max_interval = retry_policy.maximum_interval.total_seconds()

    timeout_seconds = start_to_close_timeout.total_seconds()

    last_error = None
    current_interval = initial_interval

    for attempt in range(max_attempts):
        try:
            # Timeout for this attempt
            result = await asyncio.wait_for(func(*args), timeout=timeout_seconds)
            return result

        except asyncio.TimeoutError:
            last_error = TimeoutError(f"Activity timed out after {timeout_seconds}s")
            logger.warning(
                f"Activity timeout (attempt {attempt + 1}/{max_attempts})", func=func.__name__, timeout=timeout_seconds
            )

        except Exception as e:
            last_error = e
            if _is_non_retryable_error(e, retry_policy):
                logger.warning(
                    f"Activity failed non-retryably (attempt {attempt + 1}/{max_attempts}) — not retrying",
                    func=func.__name__,
                    error=extract_error_message(e),
                )
                raise
            logger.warning(
                f"Activity failed (attempt {attempt + 1}/{max_attempts})",
                func=func.__name__,
                error=extract_error_message(e),
            )

        # If not the last attempt, wait before retry
        if attempt < max_attempts - 1:
            await asyncio.sleep(current_interval)

            # Exponential backoff
            current_interval = min(current_interval * backoff_coefficient, max_interval)

    # All retries exhausted
    raise last_error
