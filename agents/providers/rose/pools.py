"""Model pool registry — single source of truth for Rose's pool definitions.

Both rose-1-lite and rose-1-ultra share the same code path (claudeAuth ->
waterfall); the only difference is which models are tried at each layer.

Model contract (P1):

    rose-1-mini:
        claudeAuth = claude-haiku-4-5
        gptAuth    = gpt-5.6-luna
        waterfall  = anthropic/claude-haiku-4.5 -> google/gemini-3-flash-preview

    rose-1-lite:
        claudeAuth = claude-sonnet-5
        gptAuth    = gpt-5.6-terra
        waterfall  = google/gemini-3.6-flash -> moonshotai/kimi-k3

    rose-1-ultra:
        claudeAuth = claude-fable-5
        gptAuth    = gpt-5.6-sol
        waterfall  = anthropic/claude-opus-4.8 -> openai/gpt-5.6-terra
                     -> openai/gpt-5.6-sol

    rose-1-browser-use:
        claudeAuth = claude-fable-5
        gptAuth    = gpt-5.6-sol
        waterfall  = anthropic/claude-opus-4.8 -> openai/gpt-5.6-sol
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Tuple

PoolName = Literal[
    "rose-1-mini",
    "rose-1-lite",
    "rose-1-ultra",
    "rose-1-browser-use",
    "rose-1-oss",
]


@dataclass(frozen=True)
class PoolSpec:
    """One pool's direct-token models + ordered waterfall fallback list."""

    name: PoolName
    claude_auth_model: str
    """Anthropic model ID used when a Claude OAuth token is supplied."""

    gpt_auth_model: str
    """OpenAI model ID used when a ChatGPT/Codex OAuth token is supplied."""

    waterfall: Tuple[str, ...]
    """Provider-prefixed model IDs tried in order if claudeAuth fails (or
    is unavailable). Format matches OpenRouter's `provider/model` convention,
    which the transport layer maps to the right endpoint."""

    direct_auth_enabled: bool = True
    """When False, the OAuth direct-token routes (claudeAuth / gptAuth) are
    skipped entirely and only `waterfall` serves this pool.

    A pool that exists to guarantee a specific model must own that guarantee
    itself rather than depending on the caller also setting an env flag --
    otherwise the pool silently routes to a direct-token provider and the
    guarantee is void."""


POOL_REGISTRY: Dict[PoolName, PoolSpec] = {
    # Cheapest/fastest tier — used by background condensation passes
    # (web_fetch Haiku filter, tool-result summarization). claudeAuth routes
    # directly to Anthropic's Haiku 4.5; waterfall falls back to OpenRouter's
    # cheapest fast model.
    "rose-1-mini": PoolSpec(
        name="rose-1-mini",
        claude_auth_model="claude-haiku-4-5",
        gpt_auth_model="gpt-5.6-luna",
        waterfall=(
            "anthropic/claude-haiku-4.5",
            "google/gemini-3-flash-preview",
        ),
    ),
    "rose-1-lite": PoolSpec(
        name="rose-1-lite",
        claude_auth_model="claude-sonnet-5",
        gpt_auth_model="gpt-5.6-terra",
        waterfall=(
            "google/gemini-3.6-flash",
            "moonshotai/kimi-k3",
        ),
    ),
    "rose-1-ultra": PoolSpec(
        name="rose-1-ultra",
        claude_auth_model="claude-fable-5",
        gpt_auth_model="gpt-5.6-sol",
        waterfall=(
            "anthropic/claude-opus-4.8",
            # gemini-3.1-pro-preview was removed here: OpenRouter 400s it on the
            # rose-1-ultra execute pool. Terra is the replacement second layer;
            # sol stays as the third so ultra keeps a deeper fallback than a
            # single retry.
            "openai/gpt-5.6-terra",
            "openai/gpt-5.6-sol",
        ),
    ),
    # Browser-use shares the claudeAuth + waterfall machinery; the only
    # browser-specific bits live in transforms (Anthropic-native tool schemas
    # for AVAILABLE_ACTIONS) and the response extractor (tool_use -> UnifiedAction).
    "rose-1-browser-use": PoolSpec(
        name="rose-1-browser-use",
        claude_auth_model="claude-fable-5",
        gpt_auth_model="gpt-5.6-sol",
        waterfall=(
            "anthropic/claude-opus-4.8",
            "openai/gpt-5.6-sol",
        ),
    ),
    # Open-weights only. Exists so one task can be pinned to a non-frontier,
    # open-source model -- currently the behavioral-biometrics benchmark, whose
    # prompt the Anthropic-family primaries decline.
    #
    # `direct_auth_enabled=False` is what makes the guarantee real: without it a
    # user's Claude OAuth token would route to claude_auth_model and the pinned
    # open-weights model would never be reached. The direct-token fields below
    # are therefore inert; PoolSpec requires them, and they mirror rose-1-lite so
    # any future code path reading them degrades to a normal tier.
    "rose-1-oss": PoolSpec(
        name="rose-1-oss",
        claude_auth_model="claude-sonnet-5",
        gpt_auth_model="gpt-5.6-terra",
        waterfall=("moonshotai/kimi-k3",),
        direct_auth_enabled=False,
    ),
}


def get_pool(name: str) -> PoolSpec:
    """Resolve a pool name to its spec. Raises ValueError on unknown pool."""
    if name not in POOL_REGISTRY:
        valid = ", ".join(sorted(POOL_REGISTRY.keys()))
        raise ValueError(f"Unknown Rose pool {name!r} (valid: {valid})")
    return POOL_REGISTRY[name]


def all_pool_names() -> List[str]:
    """Stable-ordered list of supported pool names (for validation / docs)."""
    return sorted(POOL_REGISTRY.keys())
