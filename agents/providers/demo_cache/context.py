"""DEMO cache — per-activity context.

A contextvar carries the run's Fast Mode state into deep call sites (the Rose
wrapper) without threading kwargs through every signature. LLM keys are canonical
request fingerprints: system prompt, messages, schemas, model settings, and tool
payloads participate in the hash while secrets/blobs/dynamic prompt suffixes are
stripped by the normalizer.
"""

from __future__ import annotations

import contextvars
import os
from dataclasses import dataclass
from typing import Optional

from . import normalize
from .env import demo_cache_env

WRITE_THROUGH_USER_IDS = {
    "1f85ff25-6e29-4c1b-8739-f917bd101a30",  # Andy
    "43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9",  # Tamy
}


def demo_recording_enabled() -> bool:
    """Return whether a deliberate DEMO re-recording may write its replay namespace."""
    return (demo_cache_env("DEMO_CACHE_RECORD_DEMO") or "").strip().lower() in {"1", "true", "yes", "on"}


def cache_writes_disabled() -> bool:
    """Return whether ordinary cache contexts are read-only in this process."""
    return (demo_cache_env("DEMO_CACHE_DISABLE_WRITE_THROUGH") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


@dataclass
class DemoCacheContext:
    # `enabled` is the DEMO-prompt cache read/replay switch. Independent of the
    # Fast Mode button (which only controls provider_fast_mode / LLM speed).
    enabled: bool
    goal: str
    # Durable trajectory position for run loops/verifiers/summaries. When present,
    # the LLM key replays by step plus static request config instead of volatile
    # prior tool output text.
    base_step: Optional[int] = None
    write_enabled: Optional[bool] = None
    # Root agent's goal (busId row). Soft-complete stubs require exact match of
    # this agent's goal OR the tree root against a DEMO-tagged bench prompt.
    root_goal: Optional[str] = None
    # Fast Mode button: Anthropic speed=fast / OpenAI priority tier.
    provider_fast_mode: bool = True

    @property
    def read_enabled(self) -> bool:
        return self.enabled

    @property
    def should_write(self) -> bool:
        if cache_writes_disabled():
            return False
        # A DEMO replay is a frozen recording: a live miss must not add an entry
        # that later replays mix with the recorded steps.
        if self.soft_complete_allowed and not demo_recording_enabled():
            return False
        return self.enabled if self.write_enabled is None else self.write_enabled

    @property
    def active(self) -> bool:
        return self.read_enabled or self.should_write

    @property
    def goal_hash(self) -> str:
        return normalize.goal_hash(self.goal)

    @property
    def soft_complete_allowed(self) -> bool:
        return normalize.soft_complete_allowed(self.goal, root_goal=self.root_goal)

    def llm_key(self, call_site: str, messages: object = None) -> str:
        """Build the LLM cache key for the current request."""
        if self.base_step is not None:
            return normalize.position_key(self.goal, call_site, self.base_step, messages)
        return normalize.content_key(self.goal, call_site, messages)

    def llm_lookup_keys(self, call_site: str, messages: object = None) -> list[str]:
        """Exact keys to try for a cache read (current + OAi-demo aliases)."""
        if self.base_step is not None:
            return normalize.position_lookup_keys(self.goal, call_site, self.base_step, messages)
        return [self.llm_key(call_site, messages)]

    def llm_keys(self, call_site: str, messages: object = None) -> tuple[str, list[str]]:
        """``(llm_key, llm_lookup_keys)`` for one request, canonicalizing it once.

        Both values are byte-identical to calling the two methods separately;
        a replayed call previously derived the current position key twice.
        """
        if self.base_step is None:
            key = self.llm_key(call_site, messages)
            return key, [key]
        current = normalize.position_key(self.goal, call_site, self.base_step, messages)
        # A subclass that rekeys llm_key keeps its own write key; the lookup
        # order stays the base position keys, exactly as llm_lookup_keys.
        key = current if type(self).llm_key is DemoCacheContext.llm_key else self.llm_key(call_site, messages)
        lookup = normalize.position_lookup_keys(self.goal, call_site, self.base_step, messages, current_key=current)
        return key, lookup


_CTX: contextvars.ContextVar[Optional[DemoCacheContext]] = contextvars.ContextVar(
    "demo_cache_context", default=None
)


def set_context(ctx: Optional[DemoCacheContext]) -> contextvars.Token:
    return _CTX.set(ctx)


def reset_context(token: contextvars.Token) -> None:
    _CTX.reset(token)


def current_context() -> Optional[DemoCacheContext]:
    return _CTX.get()


def is_enabled() -> bool:
    ctx = _CTX.get()
    return ctx is not None and ctx.read_enabled


def write_through_enabled_for_user(user_id: Optional[str]) -> bool:
    if cache_writes_disabled():
        return False
    return bool(user_id) and user_id in WRITE_THROUGH_USER_IDS
