"""Regression tests for the in-process Rose pricing table.

Focus: the direct-auth ($0) invariant and the empty-model guard — both were latent
bugs where a `-claude` direct model absent from the explicit list (e.g. haiku-claude)
fuzzy-matched to a paid Anthropic price, and an empty model id matched a substring.
"""

from __future__ import annotations

from providers.rose.pricing import (
    get_anthropic_pricing,
    get_model_pricing,
    get_pool_pricing,
)


def test_direct_claude_suffix_always_free():
    for m in (
        "claude-opus-4-8-claude",
        "claude-sonnet-4-6-claude",
        "claude-haiku-4-5-claude",  # absent from the explicit direct list
        "claude-fable-5-claude",
    ):
        p = get_model_pricing(m)
        assert p == {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0}, m


def test_direct_gpt_suffix_always_free():
    for m in ("gpt-5.4-gpt", "gpt-5.5-gpt", "gpt-5.4-mini-gpt", "gpt-9.9-nonexistent-gpt"):
        p = get_model_pricing(m)
        assert p == {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0}, m


def test_empty_or_whitespace_model_is_unpriced():
    assert get_anthropic_pricing("") is None
    assert get_anthropic_pricing("   ") is None
    assert get_model_pricing("") is None
    assert get_model_pricing("   ") is None


def test_unknown_model_is_unpriced():
    assert get_model_pricing("totally/unknown-model") is None


def test_paid_anthropic_direct_still_priced():
    # A plain (non-suffixed) Anthropic model still resolves to paid pricing.
    p = get_model_pricing("claude-opus-4-8")
    assert p is not None
    assert p["input_cents_per_1k"] > 0


def test_pool_pricing_resolves():
    p = get_pool_pricing("rose-1-lite")
    assert p is not None
    assert p["input_cents_per_1k"] > 0
    assert p["output_cents_per_1k"] > 0
