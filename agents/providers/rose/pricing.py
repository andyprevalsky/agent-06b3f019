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

# Per-token USD pricing for every provider model that appears in any pool's
# waterfall. Values come from the providers' published per-million-token prices.
_PROVIDER_PRICING: Dict[str, Dict[str, float]] = {
    "google/gemini-3-flash-preview": {"prompt": 0.50 / 1_000_000, "completion": 3.00 / 1_000_000},
    "google/gemini-3.5-flash":        {"prompt": 1.50 / 1_000_000, "completion": 9.00 / 1_000_000},
    "moonshotai/kimi-k2.5":           {"prompt": 0.38 / 1_000_000, "completion": 1.72 / 1_000_000},
    "moonshotai/kimi-k2.7-code":      {"prompt": 0.74 / 1_000_000, "completion": 3.50 / 1_000_000},
    "moonshotai/kimi-k3":             {"prompt": 3.00 / 1_000_000, "completion": 15.00 / 1_000_000},
    "anthropic/claude-opus-4.8":      {"prompt": 5.00 / 1_000_000, "completion": 25.00 / 1_000_000},
    "anthropic/claude-opus-4.7":      {"prompt": 5.00 / 1_000_000, "completion": 25.00 / 1_000_000},
    "google/gemini-3.1-pro-preview":  {"prompt": 2.00 / 1_000_000, "completion": 12.00 / 1_000_000},
    "openai/gpt-5.4":                 {"prompt": 1.75 / 1_000_000, "completion": 14.00 / 1_000_000},
    "openai/gpt-5.5":                 {"prompt": 5.00 / 1_000_000, "completion": 30.00 / 1_000_000},
    "openai/gpt-5.6-luna":            {"prompt": 1.00 / 1_000_000, "completion": 6.00 / 1_000_000},
    "openai/gpt-5.6-terra":           {"prompt": 2.50 / 1_000_000, "completion": 15.00 / 1_000_000},
    "openai/gpt-5.6-sol":             {"prompt": 5.00 / 1_000_000, "completion": 30.00 / 1_000_000},
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
}

_DIRECT_OPENAI_API_KEY_PRICING: Dict[str, Dict[str, float]] = {
    "gpt-5.4-openai": {
        "input_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.4"]["prompt"] * 1000 * 100,
        "output_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.4"]["completion"] * 1000 * 100,
    },
    "gpt-5.5-openai": {
        "input_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.5"]["prompt"] * 1000 * 100,
        "output_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.5"]["completion"] * 1000 * 100,
    },
    "gpt-5.6-luna-openai": {
        "input_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.6-luna"]["prompt"] * 1000 * 100,
        "output_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.6-luna"]["completion"] * 1000 * 100,
    },
    "gpt-5.6-terra-openai": {
        "input_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.6-terra"]["prompt"] * 1000 * 100,
        "output_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.6-terra"]["completion"] * 1000 * 100,
    },
    "gpt-5.6-sol-openai": {
        "input_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.6-sol"]["prompt"] * 1000 * 100,
        "output_cents_per_1k": _PROVIDER_PRICING["openai/gpt-5.6-sol"]["completion"] * 1000 * 100,
    },
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
    "claude-haiku-4.5":  {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.5},
    "claude-haiku-4-5":  {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.5},
}


# Pool waterfall composition — must stay in sync with pools.py.
_POOL_WATERFALLS: Dict[str, tuple[str, ...]] = {
    "rose-1-lite":         ("google/gemini-3.5-flash", "moonshotai/kimi-k3"),
    "rose-1-ultra":        (
        "anthropic/claude-opus-4.8",
        "google/gemini-3.1-pro-preview",
        "openai/gpt-5.6-sol",
    ),
    "rose-1-browser-use":  ("anthropic/claude-opus-4.8", "openai/gpt-5.6-sol"),
}


def _average_pool_pricing(pool_name: str) -> Dict[str, float]:
    """Average the input/output prices across every model in a pool, then
    convert from per-token USD to cents-per-1k-tokens."""
    waterfall = _POOL_WATERFALLS[pool_name]
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


# $0 direct-auth pricing (user's own provider subscription pays for inference).
_FREE_DIRECT_PRICING: Dict[str, float] = {"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0}


def get_anthropic_pricing(model: str) -> Optional[Dict[str, float]]:
    """Return cents-per-1k pricing for a direct-Anthropic model id."""
    normalized = model.lower().strip()
    if not normalized:
        # An empty/whitespace model id must not fuzzy-match a substring below.
        return None
    normalized_dashed = normalized.replace(".", "-")
    # Any `-claude`/`-gpt` suffix is a direct-auth path (claudeAuth / gptAuth): the
    # user's own subscription pays, so it costs $0 to us. Enforce that invariant for
    # EVERY direct model — the explicit `_DIRECT_TOKEN_PRICING` list is incomplete
    # (e.g. haiku-claude is absent), and without this guard a missing entry would
    # fall through to the paid fuzzy match below and wrongly bill a $0 call.
    if normalized_dashed.endswith("-claude") or normalized_dashed.endswith("-gpt"):
        return dict(_FREE_DIRECT_PRICING)
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
