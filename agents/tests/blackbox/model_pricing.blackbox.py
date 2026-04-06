"""Blackbox tests for model-pricing domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/cost": {
            "status": 200,
            "json": {
                "pricing": {
                    "costPerMillionInputTokens": 1.25,
                    "costPerMillionOutputTokens": 5.0,
                },
            },
        },
    })


async def test_fetch_pricing_happy_path():
    """fetch_model_pricing returns cents-per-1k pricing from Supabase cost endpoint."""
    _setup()
    # Clear the module-level cache to ensure we hit the HTTP endpoint
    import helpers.model_pricing as mp
    mp._model_pricing_cache.clear()

    with patch("temporalio.activity.heartbeat"):
        from helpers.model_pricing import fetch_model_pricing

        result = await fetch_model_pricing("rose-1-ultra")

    # costPerMillionInputTokens=1.25 => 1.25 / 10 = 0.125 cents per 1k
    assert result["input_cents_per_1k"] == 0.125
    # costPerMillionOutputTokens=5.0 => 5.0 / 10 = 0.5 cents per 1k
    assert result["output_cents_per_1k"] == 0.5


def test_get_anthropic_pricing_claude():
    """get_anthropic_pricing returns correct pricing for claude-sonnet-4."""
    from helpers.model_pricing import get_anthropic_pricing

    result = get_anthropic_pricing("claude-sonnet-4")

    assert result is not None
    assert result["input_cents_per_1k"] == 0.3
    assert result["output_cents_per_1k"] == 1.5


def test_get_default_pricing():
    """get_default_pricing returns fallback pricing for unknown models."""
    from helpers.model_pricing import get_default_pricing

    result = get_default_pricing("some-unknown-model")

    assert result["input_cents_per_1k"] == 0.1
    assert result["output_cents_per_1k"] == 0.3


async def run_all_tests():
    print("model-pricing blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_pricing_happy_path", test_fetch_pricing_happy_path)
    r.record("get_anthropic_pricing_claude", test_get_anthropic_pricing_claude)
    r.record("get_default_pricing", test_get_default_pricing)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
