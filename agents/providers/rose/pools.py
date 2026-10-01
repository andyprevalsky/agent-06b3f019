"""Model pool registry — single source of truth for Rose's pool definitions.

Both rose-1-flash and rose-1-ultra share the same code path (claudeAuth ->
waterfall); the only difference is which models are tried at each layer.

Model contract — 2026-09-27 live stream bench plus Artificial Analysis
Intelligence Index v4.3.2. Speed numbers are our OpenRouter medians
(180-word prompt, effort low). Index is AA, not our harness.

    z-ai/glm-5.3-flash          TTFT 0.48s, 65–124 tok/s, index 42 (89% of Sol)
    google/gemini-3.8-flash     TTFT 1.64s / 124 tok/s at low, index 33
    google/gemini-3.1-flash-lite TTFT 1.19s / 245 tok/s, index 16 (dominated)
    deepseek-v4.1-flash         TTFT 3.1s / ~420 tok/s, index 39 max
    openai/gpt-6-sol            xhigh TTFT 14.2s, index 48 max
    openai/gpt-5.6-sol          xhigh TTFT 12.4s, index 47 max
    claude-opus-5-5             index 58 max (frontier). tool_choice any/tool
                                is downgraded like Fable until a credited call
                                proves Opus accepts forced tool_choice.

rose-1-flash / rose-1-browser-use skip Claude/GPT auth and funded API keys.
Primary is Cerebras ``qwen-3.8-27b`` (direct, not OpenRouter). OpenRouter
fallback is qwen/qwen3.8-27b then google/gemini-3.8-flash. Planner stays
on rose-1-ultra (Opus 5.5 xhigh) regardless of the agent model.

    rose-1-mini:
        claudeAuth = claude-haiku-4-5
        gptAuth    = gpt-5.6-luna
        waterfall  = anthropic/claude-haiku-4.5 -> z-ai/glm-5.3-flash
        waterfall effort = low

    rose-1-flash:  (renamed from rose-1-lite; rose-fast)
        direct_auth_enabled = False
        cerebras   = qwen-3.8-27b (high; Cerebras max, xhigh 400s)
        waterfall  = qwen/qwen3.8-27b -> google/gemini-3.8-flash
        waterfall effort = low

    rose-1-ultra:  (frontier — planner / verifier / param-populator)
        claudeAuth = claude-opus-5-5
        gptAuth    = gpt-6-sol
        waterfall  = openai/gpt-6-sol -> moonshotai/kimi-k3

    rose-1-browser-use:  (same rose-fast hop as flash)
        direct_auth_enabled = False
        cerebras   = qwen-3.8-27b (high; Cerebras max, xhigh 400s)
        waterfall  = qwen/qwen3.8-27b -> google/gemini-3.8-flash
        waterfall effort = low

Chat exclusive routes (not pool waterfalls): Cerebras/Groq gpt-oss-120b.
Groq's newer qwen3.8-27b is not on OpenRouter's Groq route. TypeSafe Jev
is Decisions-API only. Yutori n1.5 is a separate computer-use tool schema.
OpenLake is KV-cache storage, not a model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Tuple

PoolName = Literal[
    "rose-1-mini",
    "rose-1-flash",
    "rose-1-ultra",
    "rose-1-browser-use",
    "rose-1-oss",
]

# DAG / approval param-populator always uses ultra, even when the parent agent is flash.
PARAM_POPULATOR_MODEL = "rose-labs/rose-1-ultra"


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

    waterfall_reasoning_effort: str | None = None
    """When set, the OpenRouter waterfall stamps this effort instead of the
    caller / xhigh default. Speed pools pin ``low``: measured xhigh TTFT on
    the fast Gemini/GPT layers jumps from ~1s to 8–24s. claudeAuth and
    gptAuth keep the caller effort. Ultra leaves this unset."""

    direct_auth_enabled: bool = True
    """When False, OAuth and funded API-key routes (claudeAuth / gptAuth /
    ANTHROPIC_API_KEY / GPT_API_KEY) are skipped. The pool then starts at
    `cerebras_model` (if set) and falls through to `waterfall`."""

    cerebras_model: str | None = None
    """Bare Cerebras inventory id, posted to api.cerebras.ai (not OpenRouter)."""

    cerebras_reasoning_effort: str | None = None
    """Effort stamped on the direct Cerebras hop. Independent of the
    OpenRouter waterfall effort so the 1,500 tok/s Qwen point can stay
    high (Cerebras max) while Gemini fallback stays low."""


POOL_REGISTRY: Dict[PoolName, PoolSpec] = {
    # Cheapest/fastest tier — used by background condensation passes
    # (web_fetch Haiku filter, tool-result summarization). claudeAuth routes
    # directly to Anthropic's Haiku 4.5; waterfall falls back to OpenRouter's
    # fastest multimodal lite models.
    "rose-1-mini": PoolSpec(
        name="rose-1-mini",
        claude_auth_model="claude-haiku-4-5",
        gpt_auth_model="gpt-5.6-luna",
        waterfall=(
            "anthropic/claude-haiku-4.5",
            "z-ai/glm-5.3-flash",
        ),
        waterfall_reasoning_effort="low",
    ),
    "rose-1-flash": PoolSpec(
        name="rose-1-flash",
        claude_auth_model="claude-sonnet-5",
        gpt_auth_model="gpt-5.6-luna",
        waterfall=(
            "qwen/qwen3.8-27b",
            "google/gemini-3.8-flash",
        ),
        waterfall_reasoning_effort="low",
        direct_auth_enabled=False,
        cerebras_model="qwen-3.8-27b",
        cerebras_reasoning_effort="high",
    ),
    "rose-1-ultra": PoolSpec(
        name="rose-1-ultra",
        claude_auth_model="claude-opus-5-5",
        gpt_auth_model="gpt-6-sol",
        # Opus 5.5 is the AA v4.3.2 leader (58) and cheaper than Fable 5.1
        # ($4/$20 vs $10/$50). Paid waterfall is gpt-6-sol ($2/$10, index 48)
        # then kimi-k3 (index 44). Fable stays off this waterfall.
        waterfall=(
            "openai/gpt-6-sol",
            "moonshotai/kimi-k3",
        ),
    ),
    # Browser-use shares the claudeAuth + waterfall machinery; the only
    # browser-specific bits live in transforms (Anthropic-native tool schemas
    # for AVAILABLE_ACTIONS) and the response extractor (tool_use -> UnifiedAction).
    "rose-1-browser-use": PoolSpec(
        name="rose-1-browser-use",
        claude_auth_model="claude-sonnet-5",
        gpt_auth_model="gpt-5.6-luna",
        # Speed-tier browser pool. Both waterfall layers must stay in
        # VISION_MODELS (transforms.py) — the browser loop feeds screenshots,
        # and a model missing from that allowlist silently drops the image
        # instead of erroring, so the agent would fly blind on fallback.
        waterfall=(
            "qwen/qwen3.8-27b",
            "google/gemini-3.8-flash",
        ),
        waterfall_reasoning_effort="low",
        direct_auth_enabled=False,
        cerebras_model="qwen-3.8-27b",
        cerebras_reasoning_effort="high",
    ),
    # Open-weights only. Exists so one task can be pinned to a non-frontier,
    # open-source model -- currently the behavioral-biometrics benchmark, whose
    # prompt the Anthropic-family primaries decline.
    #
    # `direct_auth_enabled=False` is what makes the guarantee real: without it a
    # user's Claude OAuth token would route to claude_auth_model and the pinned
    # open-weights model would never be reached. The direct-token fields below
    # are therefore inert; PoolSpec requires them, and they mirror rose-1-flash so
    # any future code path reading them degrades to a normal tier.
    "rose-1-oss": PoolSpec(
        name="rose-1-oss",
        claude_auth_model="claude-sonnet-5",
        gpt_auth_model="gpt-5.6-luna",
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
