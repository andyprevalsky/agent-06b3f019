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
from typing import TYPE_CHECKING, List, Optional

import structlog

from providers.rose import (
    ClaudeAuthContext,
    GptAuthContext,
    RoseClient,
)

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
    ) -> None:
        self._pool: "PoolName" = pool
        self._user_id = _resolve_user_id(user_id)
        # `config.model` is a metering label only (no model resolution happens here —
        # the pool decides the real model). Default to the pool name so the metered
        # rows read e.g. "rose-1-lite".
        self.config = _RoseProviderConfig(model_label or pool)
        self._client = client or RoseClient()

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
        logger.info(
            "wmh.rose.complete",
            pool=self._pool,
            actual_model=response.actual_model,
            compute_token_used=bool(token_used),
            compute_token_type=(token_used or {}).get("type") if isinstance(token_used, dict) else None,
            compute_token_rotated=bool(usage.get("compute_token_rotated")),
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        )

        return Completion(
            text=response.content,
            usage=TokenUsage(
                input_tokens=int(usage.get("prompt_tokens", 0) or 0),
                output_tokens=int(usage.get("completion_tokens", 0) or 0),
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
