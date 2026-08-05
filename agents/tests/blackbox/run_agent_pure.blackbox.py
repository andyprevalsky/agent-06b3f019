"""Blackbox tests for run_agent_pure domain (pure functions only)."""

import asyncio

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


def test_estimate_tokens():
    """_estimate_tokens is the SAME estimator the compactor uses.

    Prod agent e14d5abb (2026-08-03) hard-failed because it wasn't: this counted
    only ``m["text"]`` while helpers.summarize counted metadata payloads too, so
    compaction removed ~0 measured tokens and added a measured summary — it grew
    the context by 1698 tokens.
    """
    from helpers.summarize import ESTIMATE_SAFETY_MULTIPLIER, estimate_context_tokens
    from loop.run_agent import _estimate_tokens

    context = [
        {"text": "Hello world this is a test message", "metadata": {}},
        {"text": "Another message here with more content", "metadata": {}},
    ]

    result = _estimate_tokens(context)

    expected = sum(max(1, int(len(m["text"]) / 4 * ESTIMATE_SAFETY_MULTIPLIER)) for m in context)
    assert result == expected
    assert result == estimate_context_tokens(context)


def test_estimate_tokens_counts_metadata_payloads():
    """Text-empty rows whose payload lives in metadata must not score ~0."""
    from loop.run_agent import _estimate_tokens

    tool_call_row = {
        "role": "ASSISTANT",
        "text": "",
        "metadata": {
            "tool_calls": [{"tool": "spawn_agent", "tool_call_id": "tc-1", "goal": "find a phone number " * 50}]
        },
    }
    structured_row = {
        "role": "TOOL",
        "text": "",
        "metadata": {
            "toolName": "grep",
            "structured_response": {"matches": [{"path": "network/contact.contact"}] * 20},
        },
    }

    assert _estimate_tokens([tool_call_row]) > 100
    assert _estimate_tokens([structured_row]) > 100
    # Weights are additive per message, so dropping rows always reduces the total.
    assert _estimate_tokens([tool_call_row, structured_row]) == _estimate_tokens([tool_call_row]) + _estimate_tokens(
        [structured_row]
    )


def test_estimate_tokens_excludes_subagent():
    """Messages with subAgentId in metadata are excluded from token count."""
    from loop.run_agent import _estimate_tokens

    regular = [
        {"text": "Regular message", "metadata": {}},
        {"text": "Another regular message", "metadata": {}},
    ]
    context = [
        regular[0],
        {"text": "Sub-agent internal step that should be excluded", "metadata": {"subAgentId": "sub-1"}},
        regular[1],
    ]

    # Only the two regular messages should count
    assert _estimate_tokens(context) == _estimate_tokens(regular)


def test_estimate_tokens_empty():
    """Empty context returns 0."""
    from loop.run_agent import _estimate_tokens

    result = _estimate_tokens([])
    assert result == 0


async def run_all_tests():
    print("run-agent-pure blackbox tests:")
    r = BlackboxResult()
    r.record("estimate_tokens", test_estimate_tokens)
    r.record("estimate_tokens_counts_metadata_payloads", test_estimate_tokens_counts_metadata_payloads)
    r.record("estimate_tokens_excludes_subagent", test_estimate_tokens_excludes_subagent)
    r.record("estimate_tokens_empty", test_estimate_tokens_empty)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
