"""Blackbox tests for error_utils domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_simple_error():
    """extract_error_message returns message from plain ValueError."""
    from helpers.error_utils import extract_error_message

    result = extract_error_message(ValueError("test error"))

    assert result == "test error"


def test_chained_error():
    """extract_error_message unwraps chained exceptions and returns inner message."""
    from helpers.error_utils import extract_error_message

    inner = RuntimeError("root cause")
    outer = ValueError("wrapper")
    outer.__cause__ = inner

    result = extract_error_message(outer)

    assert result == "root cause"


def test_empty_error():
    """extract_error_message with empty message still returns something."""
    from helpers.error_utils import extract_error_message

    result = extract_error_message(Exception(""))

    # Empty string exceptions: str(Exception("")) == "", so it falls through
    # to the final return: str(e) or "Unknown error"
    assert result == "Unknown error"


def test_activity_task_failed_wrapper():
    """extract_error_message skips 'Activity task failed' wrapper messages."""
    from helpers.error_utils import extract_error_message

    inner = RuntimeError("actual failure reason")
    outer = Exception("Activity task failed")
    outer.__cause__ = inner

    result = extract_error_message(outer)

    assert result == "actual failure reason"


async def run_all_tests():
    print("error-utils blackbox tests:")
    r = BlackboxResult()
    r.record("simple_error", test_simple_error)
    r.record("chained_error", test_chained_error)
    r.record("empty_error", test_empty_error)
    r.record("activity_task_failed_wrapper", test_activity_task_failed_wrapper)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
