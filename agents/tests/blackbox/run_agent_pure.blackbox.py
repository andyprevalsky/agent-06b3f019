"""Blackbox tests for run_agent_pure domain (pure functions only)."""

import asyncio

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


def test_estimate_tokens():
    """_estimate_tokens counts roughly len(text) // 4."""
    from loop.run_agent import _estimate_tokens

    context = [
        {"text": "Hello world this is a test message", "metadata": {}},
        {"text": "Another message here with more content", "metadata": {}},
    ]

    result = _estimate_tokens(context)

    # Total chars = 34 + 38 + 1 (newline join) = 73, // 4 = 18
    total_text = "\n".join([m["text"] for m in context])
    expected = len(total_text) // 4
    assert result == expected


def test_estimate_tokens_excludes_subagent():
    """Messages with subAgentId in metadata are excluded from token count."""
    from loop.run_agent import _estimate_tokens

    context = [
        {"text": "Regular message", "metadata": {}},
        {"text": "Sub-agent internal step that should be excluded", "metadata": {"subAgentId": "sub-1"}},
        {"text": "Another regular message", "metadata": {}},
    ]

    result = _estimate_tokens(context)

    # Only the two regular messages should count
    total_text = "\n".join(["Regular message", "Another regular message"])
    expected = len(total_text) // 4
    assert result == expected


def test_estimate_tokens_empty():
    """Empty context returns 0."""
    from loop.run_agent import _estimate_tokens

    result = _estimate_tokens([])
    assert result == 0


async def run_all_tests():
    print("run-agent-pure blackbox tests:")
    r = BlackboxResult()
    r.record("estimate_tokens", test_estimate_tokens)
    r.record("estimate_tokens_excludes_subagent", test_estimate_tokens_excludes_subagent)
    r.record("estimate_tokens_empty", test_estimate_tokens_empty)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
