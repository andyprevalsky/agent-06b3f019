"""Blackbox tests for model-pricing domain."""

import asyncio
from unittest.mock import patch

from _test_utils import BlackboxResult


async def test_fetch_pricing_pool_average():
    """fetch_model_pricing averages waterfall pricing for a Rose pool."""
    with patch("temporalio.activity.heartbeat"):
        from helpers.model_pricing import fetch_model_pricing

        result = await fetch_model_pricing("rose-1-ultra")

    # rose-1-ultra waterfall: openai/gpt-6-sol ($2/$10 per M) +
    # moonshotai/kimi-k3 ($3/$15 per M).
    # Average input: (2+3)/2 = $2.50/M -> 0.25 cents/1k
    assert abs(result["input_cents_per_1k"] - 0.25) < 1e-9
    # Average output: (10+15)/2 = $12.50/M -> 1.25 cents/1k
    assert abs(result["output_cents_per_1k"] - 1.25) < 1e-9


async def test_every_pool_model_has_provider_pricing():
    """Every model in every pool waterfall must be priceable.

    `_average_pool_pricing` indexes `_PROVIDER_PRICING` directly, so a pool
    model with no pricing row raises KeyError rather than returning a number.
    Deriving the waterfall table from POOL_REGISTRY made that reachable for
    rose-1-mini (anthropic/claude-haiku-4.5 had no entry).
    """
    from providers.rose.pools import POOL_REGISTRY
    from providers.rose.pricing import _PROVIDER_PRICING, get_pool_pricing

    missing = [
        (name, model)
        for name, spec in POOL_REGISTRY.items()
        for model in spec.waterfall
        if model not in _PROVIDER_PRICING
    ]
    assert missing == [], f"pool models with no pricing entry: {missing}"

    for name, spec in POOL_REGISTRY.items():
        pricing = get_pool_pricing(name)
        assert pricing is not None, f"{name} priced as None"
        if not spec.waterfall:
            # rose-local serves on the user's own machine: no remote leg to bill.
            assert pricing == {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0}, (name, pricing)
            continue
        assert pricing["input_cents_per_1k"] > 0, name
        assert pricing["output_cents_per_1k"] > 0, name


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

    result = get_anthropic_pricing("claude-fable-5-1-claude")

    assert result is not None
    assert result["input_cents_per_1k"] == 0.0
    assert result["output_cents_per_1k"] == 0.0


def test_get_anthropic_pricing_gpt_auth_zero():
    """gptAuth-suffixed models bill $0 to Rose."""
    from helpers.model_pricing import get_anthropic_pricing

    result = get_anthropic_pricing("gpt-5.6-terra-gpt")

    assert result is not None
    assert result["input_cents_per_1k"] == 0.0
    assert result["output_cents_per_1k"] == 0.0


async def test_get_gpt_56_sol_openrouter_pricing():
    """GPT-5.6 Sol uses its published OpenRouter token pricing."""
    from helpers.model_pricing import get_model_pricing

    result = await get_model_pricing("openai/gpt-5.6-sol")

    assert result is not None
    # $2.50/$15 per M -> 0.25 / 1.5 cents per 1k.
    assert abs(result["input_cents_per_1k"] - 0.25) < 1e-9
    assert abs(result["output_cents_per_1k"] - 1.5) < 1e-9


async def test_get_openrouter_anthropic_pricing_exact():
    """OpenRouter Anthropic model ids use provider pricing, not broad Claude aliases."""
    from helpers.model_pricing import get_model_pricing

    result = await get_model_pricing("anthropic/claude-opus-4.7")

    assert result is not None
    assert result["input_cents_per_1k"] == 0.5
    assert result["output_cents_per_1k"] == 2.5


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
    await r.record_async(
        "every_pool_model_has_provider_pricing", test_every_pool_model_has_provider_pricing
    )
    r.record("get_anthropic_pricing_claude", test_get_anthropic_pricing_claude)
    r.record("get_anthropic_pricing_claude_auth_zero", test_get_anthropic_pricing_claude_auth_zero)
    r.record("get_anthropic_pricing_gpt_auth_zero", test_get_anthropic_pricing_gpt_auth_zero)
    await r.record_async("get_gpt_56_sol_openrouter_pricing", test_get_gpt_56_sol_openrouter_pricing)
    await r.record_async("get_openrouter_anthropic_pricing_exact", test_get_openrouter_anthropic_pricing_exact)
    r.record("get_default_pricing", test_get_default_pricing)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
