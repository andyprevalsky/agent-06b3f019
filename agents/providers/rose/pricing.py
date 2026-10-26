"""In-process model pricing — replaces the Supabase /cost edge function.

Computes per-pool input/output prices by averaging the underlying provider
prices for every model in the waterfall (the same algorithm the deleted
research/domains/cost service used). claudeAuth-direct usage costs $0 to
Rose since the user's own Anthropic subscription pays for inference.

Output is cents-per-1k-tokens to match the existing
`get_model_pricing_with_fallback` API.
"""

from __future__ import annotations

from typing import Dict, Optional

from providers.rose.pools import POOL_REGISTRY

# Per-token USD pricing for every provider model that appears in any pool's
# waterfall. Values are the models' published per-million-token OpenRouter
# prices.
#
# Reconciled against the live OpenRouter /api/v1/models catalog on 2026-08-18.
# Six entries had drifted — gpt-5.6-sol and gemini-3.6-flash were both billing
# at 2x actual and gpt-5.6-luna at 5x, while kimi-k2.5 and gpt-5.4 were
# UNDER-billing. Because `_average_pool_pricing` derives every pool's rate from
# this table, each stale row silently mispriced whole pools rather than one
# model. Re-check against the live catalog when adding a waterfall layer.
_PROVIDER_PRICING: Dict[str, Dict[str, float]] = {
    "google/gemini-3-flash-preview": {"prompt": 0.50 / 1_000_000, "completion": 3.00 / 1_000_000},
    "google/gemini-3.1-flash-lite":   {"prompt": 0.25 / 1_000_000, "completion": 1.50 / 1_000_000},
    "google/gemini-3.5-flash":        {"prompt": 1.50 / 1_000_000, "completion": 9.00 / 1_000_000},
    "google/gemini-3.5-flash-lite":   {"prompt": 0.30 / 1_000_000, "completion": 2.50 / 1_000_000},
    "google/gemini-3.6-flash":        {"prompt": 0.75 / 1_000_000, "completion": 3.75 / 1_000_000},
    "google/gemini-3.7-flash":        {"prompt": 0.75 / 1_000_000, "completion": 3.75 / 1_000_000},
    "google/gemini-3.8-flash":        {"prompt": 0.75 / 1_000_000, "completion": 3.75 / 1_000_000},
    "qwen/qwen3.8-27b":               {"prompt": 0.15 / 1_000_000, "completion": 0.80 / 1_000_000},
    # Cerebras direct hop (api.cerebras.ai), not the OpenRouter qwen/* row.
    # Official Cerebras list 2026-09-25: $0.99 / $1.49 per million.
    "qwen-3.8-27b":                   {"prompt": 0.99 / 1_000_000, "completion": 1.49 / 1_000_000},
    "moonshotai/kimi-k2.5":           {"prompt": 0.57 / 1_000_000, "completion": 2.85 / 1_000_000},
    "moonshotai/kimi-k2.7-code":      {"prompt": 0.71 / 1_000_000, "completion": 3.50 / 1_000_000},
    "moonshotai/kimi-k3":             {"prompt": 3.00 / 1_000_000, "completion": 15.00 / 1_000_000},
    "anthropic/claude-opus-4.8":      {"prompt": 5.00 / 1_000_000, "completion": 25.00 / 1_000_000},
    "anthropic/claude-opus-4.7":      {"prompt": 5.00 / 1_000_000, "completion": 25.00 / 1_000_000},
    # rose-1-mini's first waterfall layer. Absent until the waterfall table was
    # derived from POOL_REGISTRY, at which point pricing rose-1-mini raised
    # KeyError instead of returning a number.
    "anthropic/claude-haiku-4.5":     {"prompt": 1.00 / 1_000_000, "completion": 5.00 / 1_000_000},
    "google/gemini-3.1-pro-preview":  {"prompt": 2.00 / 1_000_000, "completion": 12.00 / 1_000_000},
    "openai/gpt-5.4":                 {"prompt": 2.50 / 1_000_000, "completion": 15.00 / 1_000_000},
    "openai/gpt-5.5":                 {"prompt": 5.00 / 1_000_000, "completion": 30.00 / 1_000_000},
    "openai/gpt-5.6-luna":            {"prompt": 0.20 / 1_000_000, "completion": 1.20 / 1_000_000},
    "openai/gpt-5.6-terra":           {"prompt": 2.00 / 1_000_000, "completion": 12.00 / 1_000_000},
    "openai/gpt-5.6-sol":             {"prompt": 2.50 / 1_000_000, "completion": 15.00 / 1_000_000},
    "openai/gpt-6-luna":              {"prompt": 0.10 / 1_000_000, "completion": 0.50 / 1_000_000},
    "openai/gpt-6-sol":               {"prompt": 2.00 / 1_000_000, "completion": 10.00 / 1_000_000},
    "openai/gpt-6.1-sol":             {"prompt": 2.00 / 1_000_000, "completion": 10.00 / 1_000_000},
    "openai/gpt-oss-120b":            {"prompt": 0.15 / 1_000_000, "completion": 0.60 / 1_000_000},
    # OpenRouter list price. AA's first-party card is $0.15/$0.50; we pay OR.
    "z-ai/glm-5.3-flash":             {"prompt": 0.045 / 1_000_000, "completion": 0.14 / 1_000_000},
    "anthropic/claude-opus-5.5":      {"prompt": 4.00 / 1_000_000, "completion": 20.00 / 1_000_000},
}


# Direct token pricing — bypassed (user pays via their provider account).
# Detected via the `-claude` / `-gpt` suffix actual_model carries on direct
# auth paths.
_DIRECT_TOKEN_PRICING: Dict[str, Dict[str, float]] = {
    "claude-opus-4-8-claude":   {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "claude-opus-4-7-claude":   {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "claude-sonnet-4-6-claude": {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "claude-sonnet-5-claude":   {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "claude-fable-5-claude":    {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.4-gpt":              {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.5-gpt":              {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.4-mini-gpt":         {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.3-codex-gpt":        {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.6-luna-gpt":         {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.6-terra-gpt":        {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-5.6-sol-gpt":          {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-6-luna-gpt":           {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
    "gpt-6-sol-gpt":            {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
}

# Direct OpenAI API pricing (the `-openai` suffix == GPT_API_KEY -> api.openai.com).
#
# These are OpenAI's own list prices and are DELIBERATELY NOT derived from
# `_PROVIDER_PRICING`. That table holds OpenRouter's `openai/*` rates, which are
# a different commercial route and genuinely cheaper -- gpt-5.6-sol is
# $2.50/$15 per M on OpenRouter but $5.00/$30 per M direct from OpenAI. The old
# derivation asserted the two routes were the same price, so correcting the
# OpenRouter side silently halved what we believe our own funded key costs.
# Keep the two tables independent; verify each against its own provider.
#
# Short-context rates only: OpenAI applies a 2x input / 1.5x output multiplier
# above 272k input tokens, which this flat table does not model.
_DIRECT_OPENAI_API_KEY_PRICING: Dict[str, Dict[str, float]] = {
    # $2.50/$15 per M. The repo's long-standing $1.75/$14 was stale for the
    # direct route as well, so it under-reported funded API usage by ~30%.
    # (Unlike sol/terra/luna, 5.4's direct and OpenRouter rates coincide.)
    "gpt-5.4-openai":       {"input_cents_per_1k": 0.25,  "output_cents_per_1k": 1.5},
    "gpt-5.5-openai":       {"input_cents_per_1k": 0.5,   "output_cents_per_1k": 3.0},
    # Luna $0.20/$1.20 and Terra $2/$12 per M. Like 5.4, the repo's previous
    # $1.00/$6.00 and $2.50/$15 were stale for the direct route.
    "gpt-5.6-luna-openai":  {"input_cents_per_1k": 0.02,  "output_cents_per_1k": 0.12},
    "gpt-5.6-terra-openai": {"input_cents_per_1k": 0.2,   "output_cents_per_1k": 1.2},
    # Sol is the ONLY model in this set whose direct rate differs from
    # OpenRouter's: $5/$30 direct vs $2.50/$15 via OpenRouter.
    "gpt-5.6-sol-openai":   {"input_cents_per_1k": 0.5,   "output_cents_per_1k": 3.0},
    "gpt-6-luna-openai":    {"input_cents_per_1k": 0.01,  "output_cents_per_1k": 0.05},
    "gpt-6-sol-openai":     {"input_cents_per_1k": 0.2,   "output_cents_per_1k": 1.0},
}


# Direct-Anthropic pricing — used on the verifier / planner LLM activities
# when they hit Anthropic directly (no claudeAuth bypass).
ANTHROPIC_MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "claude-sonnet-4":   {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5},
    "claude-sonnet-4.5": {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5},
    "claude-sonnet-4-6": {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5},
    "claude-sonnet-5":   {"input_cents_per_1k": 0.2, "output_cents_per_1k": 1.0},
    "claude-4-sonnet":   {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5},
    "claude-opus-4":     {"input_cents_per_1k": 1.5, "output_cents_per_1k": 7.5},
    "claude-4-opus":     {"input_cents_per_1k": 1.5, "output_cents_per_1k": 7.5},
    "claude-opus-4.5":   {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.5},
    "claude-opus-4-5":   {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.5},
    "claude-opus-4-7":   {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.5},
    "claude-opus-4-8":   {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.5},
    "claude-fable-5":    {"input_cents_per_1k": 1.0, "output_cents_per_1k": 5.0},
    "claude-fable-5-1":  {"input_cents_per_1k": 1.0, "output_cents_per_1k": 5.0},
    "claude-opus-5-5":   {"input_cents_per_1k": 0.4, "output_cents_per_1k": 2.0},
    "claude-haiku-4.5":  {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.5},
    "claude-haiku-4-5":  {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.5},
}


# Pool waterfall composition, DERIVED from the pool registry rather than restated
# here. A hand-copied duplicate silently drifts the moment a pool's waterfall
# changes, and the resulting mispricing is invisible — every pool keeps returning
# a plausible number computed from the wrong models. (The copy this replaced had
# already lost rose-1-mini entirely, so that pool priced as None.)
_POOL_WATERFALLS: Dict[str, tuple[str, ...]] = {
    name: tuple(spec.waterfall) for name, spec in POOL_REGISTRY.items()
}


def _average_pool_pricing(pool_name: str) -> Dict[str, float]:
    """Average the input/output prices across every model in a pool, then
    convert from per-token USD to cents-per-1k-tokens."""
    waterfall = _POOL_WATERFALLS[pool_name]
    if pool_name == "rose-local":
        return dict(_ZERO_USER_PRICING)
    prompt = sum(_PROVIDER_PRICING[m]["prompt"] for m in waterfall) / len(waterfall)
    completion = sum(_PROVIDER_PRICING[m]["completion"] for m in waterfall) / len(waterfall)
    return {
        # USD/token * 1000 tokens * 100 cents = USD/1k * 100
        "input_cents_per_1k": prompt * 1000 * 100,
        "output_cents_per_1k": completion * 1000 * 100,
    }


def get_pool_pricing(pool_name: str) -> Optional[Dict[str, float]]:
    """Return cents-per-1k pricing for a Rose pool, or None if unknown."""
    if pool_name not in _POOL_WATERFALLS:
        return None
    return _average_pool_pricing(pool_name)


# Zero user-facing token cost. OAuth uses the user's subscription; Foundry
# remains an Azure expense paid by Rose and must be tracked in Azure billing.
_ZERO_USER_PRICING: Dict[str, float] = {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0}


def get_anthropic_pricing(model: str) -> Optional[Dict[str, float]]:
    """Return cents-per-1k pricing for a direct-Anthropic model id."""
    normalized = model.lower().strip()
    if not normalized:
        # An empty/whitespace model id must not fuzzy-match a substring below.
        return None
    normalized_dashed = normalized.replace(".", "-")
    # `-claude`/`-gpt` are user-subscription paths; `-foundry` is funded by Rose
    # but has the same zero user-facing cost. Enforce this for every such model:
    # the explicit `_DIRECT_TOKEN_PRICING` list is incomplete
    # (e.g. haiku-claude is absent), and without this guard a missing entry would
    # fall through to the paid fuzzy match below and wrongly bill a $0 call.
    if normalized_dashed.endswith(("-claude", "-gpt", "-foundry")):
        return dict(_ZERO_USER_PRICING)
    if normalized in _DIRECT_TOKEN_PRICING:
        return _DIRECT_TOKEN_PRICING[normalized]
    if normalized_dashed in _DIRECT_TOKEN_PRICING:
        return _DIRECT_TOKEN_PRICING[normalized_dashed]
    if normalized in ANTHROPIC_MODEL_PRICING:
        return ANTHROPIC_MODEL_PRICING[normalized]
    if normalized_dashed in ANTHROPIC_MODEL_PRICING:
        return ANTHROPIC_MODEL_PRICING[normalized_dashed]
    for key, pricing in sorted(ANTHROPIC_MODEL_PRICING.items(), key=lambda item: len(item[0]), reverse=True):
        if key in normalized_dashed or normalized_dashed in key:
            return pricing
    return None


def get_model_pricing(model: str) -> Optional[Dict[str, float]]:
    """Lookup pricing for a model identifier — Rose pool, claudeAuth direct,
    or plain Anthropic. Returns None if no entry matches.
    """
    normalized = model.lower().strip()
    if normalized.startswith("local/"):
        return dict(_ZERO_USER_PRICING)
    if normalized.startswith("rose-labs/"):
        normalized = normalized[len("rose-labs/"):]
    if normalized in _POOL_WATERFALLS:
        return _average_pool_pricing(normalized)
    if normalized in _PROVIDER_PRICING:
        pricing = _PROVIDER_PRICING[normalized]
        return {
            "input_cents_per_1k": pricing["prompt"] * 1000 * 100,
            "output_cents_per_1k": pricing["completion"] * 1000 * 100,
        }
    if normalized in _DIRECT_OPENAI_API_KEY_PRICING:
        return _DIRECT_OPENAI_API_KEY_PRICING[normalized]
    return get_anthropic_pricing(normalized)
