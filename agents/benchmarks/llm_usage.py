"""Provider/model-level LLM usage aggregation for benchmark artifacts."""

from __future__ import annotations

import runpy
from pathlib import Path
from typing import Any, Iterable

# Load the data-only registry file without importing providers.rose.__init__,
# which pulls runtime HTTP dependencies that the standalone fleet aggregator
# intentionally does not need.
POOL_REGISTRY = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "providers" / "rose" / "pools.py")
)["POOL_REGISTRY"]


PROVIDER_ORDER = (
    "codex_token",
    "claude_oauth_token",
    "gpt_api_key",
    "anthropic_api_key",
    "foundry",
    "openrouter_model_1",
    "openrouter_model_2",
)
FAST_MODE_USAGE_MODELS = frozenset(
    {
        "fast-cache",
        "fast-mode-scrape-passthrough",
        "fast-mode-soft-complete",
    }
)


def classify_model(model: str) -> tuple[str, str]:
    suffixes = (
        ("-gpt", "codex_token"),
        ("-claude", "claude_oauth_token"),
        ("-openai", "gpt_api_key"),
        ("-anthropic", "anthropic_api_key"),
        ("-foundry", "foundry"),
    )
    for suffix, provider in suffixes:
        if model.endswith(suffix):
            return provider, model[: -len(suffix)]
    for slot in (0, 1):
        # Waterfalls are not all the same length -- rose-1-oss pins a single
        # open-weights layer -- so the slot must be bounds-checked per pool.
        # Without the guard this raised IndexError for any model that reached
        # the loop without matching an earlier pool at that slot; `any()` had
        # been hiding it by short-circuiting on a longer pool first, which made
        # the crash depend on registry ordering and on which models happened to
        # occupy slot 0.
        if any(
            slot < len(spec.waterfall) and model == spec.waterfall[slot]
            for spec in POOL_REGISTRY.values()
        ):
            return f"openrouter_model_{slot + 1}", model
    return "unclassified", model or "unknown"


def classify_usage_item(item: dict[str, Any]) -> tuple[str, str]:
    """Classify usage records whose transport model was not serialized.

    Verifier telemetry records the forced Rose Ultra pool alias even though
    ``check_progress`` supplies the Claude OAuth token. Legacy browser-use
    telemetry can omit ``model`` while naming the Rose Browser Use provider.
    Preserve those known historical attributions without overriding an explicit
    browser transport model from current telemetry.
    """
    model = str(item.get("model") or "")
    provider = str(item.get("provider") or "")
    if model == "rose-labs/rose-1-ultra" and provider.startswith("Verifier ("):
        return "claude_oauth_token", POOL_REGISTRY["rose-1-ultra"].claude_auth_model
    # New browser telemetry carries its transport model and must win: the pool
    # can route through GPT, Claude, or OpenRouter. Older artifacts omitted it
    # (or inherited the parent pool alias), so preserve the historical Claude
    # fallback only when the model itself is not classifiable.
    if provider == "Rose 1 Browser Use":
        classified = classify_model(model)
        if classified[0] != "unclassified":
            return classified
        return "claude_oauth_token", POOL_REGISTRY["rose-1-browser-use"].claude_auth_model
    return classify_model(model)


def live_output_tokens(breakdown: dict[str, Any] | None) -> int:
    """Count completion tokens streamed by live (non-Fast-Mode) models."""
    total = 0
    for row in (breakdown or {}).values():
        if not isinstance(row, dict):
            continue
        models = row.get("models")
        if isinstance(models, dict) and models:
            for name, model_row in models.items():
                if str(name) in FAST_MODE_USAGE_MODELS or not isinstance(model_row, dict):
                    continue
                total += int(model_row.get("output_tokens") or 0)
            continue
        total += int(row.get("output_tokens") or 0)
    return total


def _empty_metrics() -> dict[str, int | float]:
    return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


def aggregate_usage_items(items: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    breakdown: dict[str, dict[str, Any]] = {}
    for item in items:
        if item.get("type") != "llm":
            continue
        provider, sub_model = classify_usage_item(item)
        provider_row = breakdown.setdefault(provider, {**_empty_metrics(), "models": {}})
        model_row = provider_row["models"].setdefault(sub_model, _empty_metrics())
        input_tokens = sum(
            int(item.get(key) or 0)
            for key in ("tokens_in", "cache_read_input_tokens", "cache_creation_input_tokens")
        )
        output_tokens = int(item.get("tokens_out") or 0)
        cost_usd = float(item.get("cost_cents") or 0) / 100.0
        for row in (provider_row, model_row):
            row["calls"] += 1
            row["input_tokens"] += input_tokens
            row["output_tokens"] += output_tokens
            row["cost_usd"] += cost_usd
    return _round_costs(breakdown)


def aggregate_prompt_cache_share(items: Iterable[dict[str, Any]]) -> dict[str, int | float]:
    """Return the prompt-cache share of every cache-sequenced LLM call in a run.

    share = cache_read / (cache_read + cache_creation + uncached input), the hit
    rate the golden references compute over a query's total usage
    (claude-code-src utils/forkedAgent.ts:646-654, services/compact/compact.ts:1220-1226;
    openclaw src/agents/live-cache-test-support.ts:166-180). Uncached input is
    ``tokens_in``: usage rows store it exclusive of cache tokens for every
    provider (providers/rose/client.py:_normalize_usage_input_tokens rewrites
    OpenAI's inclusive prompt_tokens; ``aggregate_usage_items`` sums the three
    buckets). Only calls carrying the provider
    ``cache_sequence_id`` can reuse a cache, so only they are measured; a run
    with none has no cache telemetry and the ratchet fails it closed. Every
    sequenced call counts, including a sequence that ran once: its reads of the
    shared prefix and its writes are real cache effectiveness.
    """
    calls = [
        item
        for item in items
        if item.get("type") == "llm"
        and isinstance(item.get("cache_sequence_id"), str)
        and item["cache_sequence_id"].strip()
    ]
    cache_read = sum(int(item.get("cache_read_input_tokens") or 0) for item in calls)
    cache_write = sum(int(item.get("cache_creation_input_tokens") or 0) for item in calls)
    uncached = sum(int(item.get("tokens_in") or 0) for item in calls)
    total = cache_read + cache_write + uncached
    return {
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
        "uncached_input_tokens": uncached,
        "cache_share_pct": round(cache_read / total * 100, 1) if total else 0.0,
        "call_count": len(calls),
    }


def merge_usage_breakdowns(
    breakdowns: Iterable[dict[str, dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for breakdown in breakdowns:
        for provider, source in breakdown.items():
            target = merged.setdefault(provider, {**_empty_metrics(), "models": {}})
            for key in ("calls", "input_tokens", "output_tokens", "cost_usd"):
                target[key] += source.get(key, 0)
            for model, model_source in (source.get("models") or {}).items():
                model_target = target["models"].setdefault(model, _empty_metrics())
                for key in ("calls", "input_tokens", "output_tokens", "cost_usd"):
                    model_target[key] += model_source.get(key, 0)
    return _round_costs(merged)


def _round_costs(breakdown: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ordered: dict[str, dict[str, Any]] = {}
    # The batch artifact is a fixed report contract: emit every requested auth
    # path even when it had zero calls, so absence cannot be mistaken for a
    # collector failure. ``unclassified`` remains conditional and must be empty
    # in a successful artifact audit.
    for provider in PROVIDER_ORDER:
        breakdown.setdefault(provider, {**_empty_metrics(), "models": {}})
    for provider in (*PROVIDER_ORDER, "unclassified"):
        if provider not in breakdown:
            continue
        row = breakdown[provider]
        row["cost_usd"] = round(float(row["cost_usd"]), 6)
        row["models"] = dict(sorted(row["models"].items()))
        for model_row in row["models"].values():
            model_row["cost_usd"] = round(float(model_row["cost_usd"]), 6)
        ordered[provider] = row
    return ordered
