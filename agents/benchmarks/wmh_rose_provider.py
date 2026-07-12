"""World Model Harness (WMH) inference provider backed by Rose completions.

The vendored `wmh.providers.anthropic.AnthropicProvider` calls Anthropic directly
(reads `ANTHROPIC_API_KEY`, no compute tokens, no rotation). This module supplies a
drop-in replacement — `RoseWMHProvider` — that routes the WMH's per-step LLM call
through the EXISTING agent-side Rose machinery instead:

    WMH step  ->  RoseWMHProvider.complete()  ->  RoseClient.collect(pool="rose-1-lite")
                     |                                    |
                     |                                    +-- claudeAuth / gptAuth direct
                     |                                        compute-token routing + rotation
                     +-- leases a compute token per call via the SAME helpers the agent
                         uses (helpers.llm.fetch_compute_token_activity +
                         _build_compute_auth_context), which already wire the rotation
                         callbacks (fetch_fresh / mark_rate_limited / heartbeat_lease).

Nothing here re-implements token leasing or rotation: leasing is one call to
`fetch_compute_token_activity`, and rotation is owned entirely by `RoseClient` via the
callbacks baked into the `ComputeAuthContext` that `_build_compute_auth_context` returns.

Sync -> async bridge: WMH's `Provider.complete` is synchronous (the serve `/step` route
runs in a FastAPI threadpool, so there is no running event loop), while `RoseClient` is
async. We bridge with a plain `asyncio.run(...)` inside `complete()`.
"""

from __future__ import annotations

import asyncio
import os
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, List, Optional

import structlog

from providers.rose import (
    ClaudeAuthContext,
    GptAuthContext,
    RoseClient,
)
from providers.rose.pricing import get_model_pricing

if TYPE_CHECKING:  # pragma: no cover - typing only
    from wmh.providers.base import Completion, Message

    from providers.rose.types import PoolName

logger = structlog.get_logger(__name__)

# The benchmark user whose pooled compute tokens back WMH inference by default.
# Overridable via env so a different tenant's pool can be used.
_DEFAULT_WMH_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

# WMH step prompts are single-shot env simulations; give the model room to emit a full
# observation JSON without truncating. Mirrors wmh.providers.base.DEFAULT_MAX_TOKENS.
_WMH_MAX_TOKENS = 8192


def _resolve_user_id(explicit: Optional[str]) -> str:
    """User id for the compute-token lease: explicit arg > env > benchmark default."""
    return explicit or os.environ.get("WMH_ROSE_USER_ID") or _DEFAULT_WMH_USER_ID


@dataclass(frozen=True)
class RoseUsageSnapshot:
    """An immutable view of the cumulative Rose inference usage for a served WMH."""

    total_cost_usd: float
    calls: int
    input_tokens: int
    output_tokens: int

    def as_dict(self) -> dict:
        return {
            "total_cost_usd": round(self.total_cost_usd, 6),
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
        }


class RoseUsageAccumulator:
    """Process-level, thread-safe tally of Rose inference cost + tokens.

    WMH steps run in a FastAPI threadpool (one thread per concurrent step), so the
    accumulator must be safe under concurrent `record()` calls. A single lock guards
    the counters — the critical section is a handful of additions, so contention is
    negligible relative to the LLM call it follows.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total_cost_usd = 0.0
        self._calls = 0
        self._input_tokens = 0
        self._output_tokens = 0

    def record(self, *, cost_usd: float, input_tokens: int, output_tokens: int) -> None:
        with self._lock:
            self._total_cost_usd += cost_usd
            self._calls += 1
            self._input_tokens += input_tokens
            self._output_tokens += output_tokens

    def snapshot(self) -> RoseUsageSnapshot:
        with self._lock:
            return RoseUsageSnapshot(
                total_cost_usd=self._total_cost_usd,
                calls=self._calls,
                input_tokens=self._input_tokens,
                output_tokens=self._output_tokens,
            )


def _cost_usd_for_call(actual_model: str, input_tokens: int, output_tokens: int) -> float:
    """USD cost of one Rose call from token counts × the model's pricing.

    Rose's `usage` dict carries no cost field, so we derive it exactly the way the
    rest of the agents stack does: look up cents-per-1k for `actual_model` via the
    shared `providers.rose.pricing` table and multiply by the tokens.

    claudeAuth/gptAuth direct paths (`actual_model` ends `-claude`/`-gpt`) are priced
    at $0 in that table — the user's own subscription pays — so this correctly returns
    0.0 for the common WMH path. Waterfall models return their real averaged pool price.
    Unknown models return 0.0 (no invented numbers); the token counts are still tracked.
    """
    pricing = get_model_pricing(actual_model or "")
    if not pricing:
        return 0.0
    input_cost = (input_tokens / 1000.0) * pricing["input_cents_per_1k"]
    output_cost = (output_tokens / 1000.0) * pricing["output_cents_per_1k"]
    return (input_cost + output_cost) / 100.0  # cents → USD


# Process-level usage tally shared by every provider instance in the served app. The
# served WMH constructs one provider, but keeping the accumulator at module scope means
# the `/rose_usage` route can read it without threading the provider handle through the
# FastAPI app. Reset per process (a served WMH is one benchmark run).
GLOBAL_ROSE_USAGE = RoseUsageAccumulator()


class _RoseProviderConfig:
    """Minimal `config` object the WorldModel reads for metering.

    `wmh.engine.world_model.WorldModel.step` reads `self._provider.config.model` to
    attribute token usage to a model name. The vendored providers expose a full
    `ProviderConfig`; the WorldModel only ever touches `.model`, so a tiny shim
    suffices and keeps us free of the vendored `ProviderConfig` pydantic surface.
    """

    def __init__(self, model: str) -> None:
        self.model = model


class RoseWMHProvider:
    """WMH `Provider` whose `complete()` routes through Rose completions.

    Implements the subset of the `wmh.providers.base.Provider` protocol that serving
    exercises: `.config.model` (metering) and `.complete(system, messages)` (generation).
    Retrieval uses the offline `HashingEmbedder`, so `embed()` is never called during
    serving; `verify()` is not on the serve path either. Both raise clearly if invoked.
    """

    def __init__(
        self,
        *,
        pool: "PoolName" = "rose-1-lite",
        user_id: Optional[str] = None,
        model_label: Optional[str] = None,
        client: Optional[RoseClient] = None,
        usage: Optional[RoseUsageAccumulator] = None,
    ) -> None:
        self._pool: "PoolName" = pool
        self._user_id = _resolve_user_id(user_id)
        # `config.model` is a metering label only (no model resolution happens here —
        # the pool decides the real model). Default to the pool name so the metered
        # rows read e.g. "rose-1-lite".
        self.config = _RoseProviderConfig(model_label or pool)
        self._client = client or RoseClient()
        # Cumulative Rose inference cost/tokens across every step this served WMH runs.
        # Defaults to the process-level accumulator the `/rose_usage` route reads; tests
        # inject their own to assert accumulation in isolation.
        self._usage = usage if usage is not None else GLOBAL_ROSE_USAGE

    # -- WMH Provider protocol -------------------------------------------------

    def complete(
        self,
        system: str,
        messages: List["Message"],
        *,
        temperature: float = 0.7,
        max_tokens: int = _WMH_MAX_TOKENS,
    ) -> "Completion":
        """Generate a completion for one WMH step through Rose.

        Sync entrypoint (called from the FastAPI threadpool). Bridges to the async
        Rose client with `asyncio.run`. `temperature` is accepted for protocol parity
        but not forwarded: rose-1-lite's claudeAuth path (Anthropic) rejects sampling
        params, matching the vendored AnthropicProvider's behavior.
        """
        return asyncio.run(self._complete_async(system, messages, max_tokens=max_tokens))

    def embed(self, texts: List[str]) -> List[List[float]]:  # pragma: no cover - not on serve path
        raise NotImplementedError(
            "RoseWMHProvider has no embeddings API; WMH retrieval uses the offline "
            "HashingEmbedder, so serving never calls embed()."
        )

    def verify(self):  # pragma: no cover - not on serve path
        raise NotImplementedError(
            "RoseWMHProvider does not implement verify(); it is not on the serve step path."
        )

    # -- internals -------------------------------------------------------------

    async def _complete_async(
        self,
        system: str,
        messages: List["Message"],
        *,
        max_tokens: int,
    ) -> "Completion":
        # Import the vendored value types lazily so importing this module doesn't require
        # the `wmh` package (e.g. for unit tests that monkeypatch the client).
        from wmh.providers.base import Completion, TokenUsage

        rose_messages = _to_rose_messages(system, messages)
        claude_auth, gpt_auth = await self._lease_auth()

        response = await self._client.collect(
            pool=self._pool,
            messages=rose_messages,
            max_tokens=max_tokens,
            claude_auth=claude_auth,
            gpt_auth=gpt_auth,
            call_site="wmh_world_model",
            dump_context=False,
        )

        usage = response.usage or {}
        token_used = usage.get("compute_token_used")
        input_tokens = int(usage.get("prompt_tokens", 0) or 0)
        output_tokens = int(usage.get("completion_tokens", 0) or 0)
        # Rose returns no cost field, so derive it from tokens × the actual model's
        # pricing (claudeAuth/gptAuth direct = $0; waterfall = real pool price). This is
        # the only place WMH grounding cost is measured — surfaced via /rose_usage.
        cost_usd = _cost_usd_for_call(response.actual_model or "", input_tokens, output_tokens)
        self._usage.record(cost_usd=cost_usd, input_tokens=input_tokens, output_tokens=output_tokens)
        logger.info(
            "wmh.rose.complete",
            pool=self._pool,
            actual_model=response.actual_model,
            compute_token_used=bool(token_used),
            compute_token_type=(token_used or {}).get("type") if isinstance(token_used, dict) else None,
            compute_token_rotated=bool(usage.get("compute_token_rotated")),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=round(cost_usd, 6),
        )

        return Completion(
            text=response.content,
            usage=TokenUsage(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            ),
        )

    async def _lease_auth(self):
        """Lease one compute token and build the rotation-capable auth context.

        Reuses the agent-side lease + rotation wiring verbatim:
          - `fetch_compute_token_activity` leases a claude|gpt token from the backend.
          - `_build_compute_auth_context` returns a Claude/Gpt `ComputeAuthContext`
            with `fetch_fresh` / `mark_rate_limited` / `heartbeat_lease` already bound
            to the rotation activity functions. RoseClient drives rotation via those.

        Returns `(claude_auth, gpt_auth)` — exactly one is non-None (or both None if
        the user has no compute credentials, in which case Rose falls to the waterfall).
        """
        # Imported here (not at module top) so this benchmark-home module doesn't pull
        # the heavy helpers.llm graph on import; it's only needed when actually serving.
        from helpers.llm import (
            _build_compute_auth_context,
            fetch_compute_token_activity,
        )

        result = await fetch_compute_token_activity(self._user_id)
        if not result or not result.get("accessToken"):
            logger.info("wmh.rose.no_compute_token", user_id=self._user_id)
            return None, None

        ctx = _build_compute_auth_context(result, self._user_id)
        if isinstance(ctx, ClaudeAuthContext):
            return ctx, None
        if isinstance(ctx, GptAuthContext):
            return None, ctx
        return None, None


def _to_rose_messages(system: str, messages: List["Message"]) -> List[dict]:
    """Convert WMH `Message`s to Rose's OpenAI-style message dicts.

    Rose takes the system prompt as a leading `role: "system"` message (not a kwarg),
    then the user/assistant turns. WMH only ever sends a single user message for a
    step, but we forward all turns generically.
    """
    rose: List[dict] = []
    if system:
        rose.append({"role": "system", "content": system})
    for m in messages:
        rose.append({"role": m.role, "content": m.content})
    return rose
