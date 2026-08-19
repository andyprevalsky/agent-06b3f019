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
        waterfall  = openai/gpt-5.6-sol -> moonshotai/kimi-k3

    rose-1-browser-use:
        claudeAuth = claude-fable-5
        gptAuth    = gpt-5.6-sol
        waterfall  = openai/gpt-5.6-sol -> moonshotai/kimi-k3
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Tuple

PoolName = Literal["rose-1-mini", "rose-1-lite", "rose-1-ultra", "rose-1-browser-use"]


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
        # Anthropic dropped from the waterfall: opus-4.8 was both the most
        # expensive layer ($5/$25 per M) and scored below the models beneath
        # it (AA intelligence 57.3 vs sol 60.9). Sol leads — it is the
        # highest-scoring model in the registry on all three AA indices
        # (intelligence 60.9 / coding 77.4 / agentic 57.8) at half opus's
        # price. kimi-k3 backs it with a different vendor, so a single
        # OpenAI-side outage cannot take the whole waterfall down.
        waterfall=(
            "openai/gpt-5.6-sol",
            "moonshotai/kimi-k3",
        ),
    ),
    # Browser-use shares the claudeAuth + waterfall machinery; the only
    # browser-specific bits live in transforms (Anthropic-native tool schemas
    # for AVAILABLE_ACTIONS) and the response extractor (tool_use -> UnifiedAction).
    "rose-1-browser-use": PoolSpec(
        name="rose-1-browser-use",
        claude_auth_model="claude-fable-5",
        gpt_auth_model="gpt-5.6-sol",
        # Same reordering as rose-1-ultra. Both layers must stay in
        # VISION_MODELS (transforms.py) — the browser loop feeds screenshots,
        # and a model missing from that allowlist silently drops the image
        # instead of erroring, so the agent would fly blind on fallback.
        waterfall=(
            "openai/gpt-5.6-sol",
            "moonshotai/kimi-k3",
        ),
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
