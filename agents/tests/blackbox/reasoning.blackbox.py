"""Blackbox tests for reasoning domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_reasoning_response_model():
    """ReasoningResponse stores response field and serializes correctly."""
    from activities.reasoning import ReasoningResponse

    r = ReasoningResponse(response="test analysis")

    assert r.response == "test analysis"
    d = r.model_dump()
    assert d == {"response": "test analysis"}


def test_reasoning_response_validates():
    """ReasoningResponse rejects missing response field."""
    from activities.reasoning import ReasoningResponse
    from pydantic import ValidationError

    try:
        ReasoningResponse()  # missing required 'response'
        raise AssertionError("Should have raised ValidationError")
    except ValidationError:
        pass  # expected


def test_safe_heartbeat_outside_activity():
    """_safe_heartbeat does not raise when called outside Temporal activity context."""
    from activities.reasoning import _safe_heartbeat

    # Should silently skip without raising
    _safe_heartbeat("test heartbeat")


async def run_all_tests():
    print("reasoning blackbox tests:")
    r = BlackboxResult()
    r.record("reasoning_response_model", test_reasoning_response_model)
    r.record("reasoning_response_validates", test_reasoning_response_validates)
    r.record("safe_heartbeat_outside_activity", test_safe_heartbeat_outside_activity)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
