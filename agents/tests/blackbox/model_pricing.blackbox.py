"""Blackbox tests for model-pricing domain."""

import asyncio
from unittest.mock import patch

from _test_utils import BlackboxResult


async def test_fetch_pricing_pool_average():
    """fetch_model_pricing averages waterfall pricing for a Rose pool."""
    with patch("temporalio.activity.heartbeat"):
        from helpers.model_pricing import fetch_model_pricing

        result = await fetch_model_pricing("rose-1-ultra")

    # rose-1-ultra waterfall: anthropic/claude-opus-4.7 ($5/$25 per M) +
    # google/gemini-3.1-pro-preview ($2/$12 per M).
    # Average input: (5+2)/2 = $3.5/M -> 0.35 cents/1k
    assert abs(result["input_cents_per_1k"] - 0.35) < 1e-9
    # Average output: (25+12)/2 = $18.5/M -> 1.85 cents/1k
    assert abs(result["output_cents_per_1k"] - 1.85) < 1e-9


def test_get_anthropic_pricing_claude():
    """get_anthropic_pricing returns correct pricing for claude-sonnet-4."""
    from helpers.model_pricing import get_anthropic_pricing

    result = get_anthropic_pricing("claude-sonnet-4")

    assert result is not None
    assert result["input_cents_per_1k"] == 0.3
    assert result["output_cents_per_1k"] == 1.5


def test_get_anthropic_pricing_claude_auth_zero():
    """claudeAuth-suffixed models bill $0 to Rose."""
    from helpers.model_pricing import get_anthropic_pricing

    result = get_anthropic_pricing("claude-opus-4-7-claude")

    assert result is not None
    assert result["input_cents_per_1k"] == 0.0
    assert result["output_cents_per_1k"] == 0.0


def test_get_default_pricing():
    """get_default_pricing returns fallback pricing for unknown models."""
    from helpers.model_pricing import get_default_pricing

    result = get_default_pricing("some-unknown-model")

    assert result["input_cents_per_1k"] == 0.1
    assert result["output_cents_per_1k"] == 0.3


async def run_all_tests():
    print("model-pricing blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_pricing_pool_average", test_fetch_pricing_pool_average)
    r.record("get_anthropic_pricing_claude", test_get_anthropic_pricing_claude)
    r.record("get_anthropic_pricing_claude_auth_zero", test_get_anthropic_pricing_claude_auth_zero)
    r.record("get_default_pricing", test_get_default_pricing)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
