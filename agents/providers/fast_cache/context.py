"""Fast Mode cache — per-activity context.

A contextvar carries the run's Fast Mode state into deep call sites (the Rose
wrapper) without threading kwargs through every signature. LLM keys are canonical
request fingerprints: system prompt, messages, schemas, model settings, and tool
payloads participate in the hash while secrets/blobs/dynamic prompt suffixes are
stripped by the normalizer.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass
from typing import Optional

from . import normalize

WRITE_THROUGH_USER_IDS = {"1f85ff25-6e29-4c1b-8739-f917bd101a30"}


@dataclass
class FastCacheContext:
    # `enabled` is the read/replay switch. Some allowlisted accounts write cache
    # entries even with Fast Mode off, but must not replay unless this is true.
    enabled: bool
    goal: str
    # Durable trajectory position for run loops/verifiers/summaries. When present,
    # the LLM key replays by step plus static request config instead of volatile
    # prior tool output text.
    base_step: Optional[int] = None
    write_enabled: Optional[bool] = None

    @property
    def read_enabled(self) -> bool:
        return self.enabled

    @property
    def should_write(self) -> bool:
        return self.enabled if self.write_enabled is None else self.write_enabled

    @property
    def active(self) -> bool:
        return self.read_enabled or self.should_write

    @property
    def provider_fast_mode(self) -> bool:
        # Write-through runs must record the same provider request envelope that
        # a later read-enabled Fast Mode run will replay.
        return self.read_enabled or self.should_write

    @property
    def goal_hash(self) -> str:
        return normalize.goal_hash(self.goal)

    def llm_key(self, call_site: str, messages: object = None) -> str:
        """Build the LLM cache key for the current request."""
        if self.base_step is not None:
            return normalize.position_key(self.goal, call_site, self.base_step, messages)
        return normalize.content_key(self.goal, call_site, messages)


_CTX: contextvars.ContextVar[Optional[FastCacheContext]] = contextvars.ContextVar(
    "fast_cache_context", default=None
)


def set_context(ctx: Optional[FastCacheContext]) -> contextvars.Token:
    return _CTX.set(ctx)


def reset_context(token: contextvars.Token) -> None:
    _CTX.reset(token)


def current_context() -> Optional[FastCacheContext]:
    return _CTX.get()


def is_enabled() -> bool:
    ctx = _CTX.get()
    return ctx is not None and ctx.read_enabled


def write_through_enabled_for_user(user_id: Optional[str]) -> bool:
    return bool(user_id) and user_id in WRITE_THROUGH_USER_IDS
