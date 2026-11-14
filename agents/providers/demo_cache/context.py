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
import hashlib
import json
import stat
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit
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


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


@lru_cache(maxsize=8)
def _recording_manifest(path: str, identity: tuple[int, ...]) -> dict:
    # Stat identity includes ctime: replacement and in-place mutations invalidate
    # this bounded memo without rereading the same file on every cache lookup.
    with open(path, "rb") as stream:
        current = os.fstat(stream.fileno())
        observed = (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns)
        if observed != identity or not stat.S_ISREG(current.st_mode) or current.st_size > 16384:
            raise ValueError("Owned recording manifest changed or is invalid")
        value = json.loads(stream.read(16385))
    if not isinstance(value, dict):
        raise ValueError("Owned recording manifest must be an object")
    return value


def validate_owned_recording(env, *, checkout: str, workspace: str | None, fixture_database: str) -> str:
    """Validate the existing retained owner without changing environment or storage."""
    path = env.get("WMH_OWNED_RECORDING_CACHE_MANIFEST", "")
    url = env.get("WMH_OWNED_RECORDING_CACHE_DATABASE_URL", "")
    if not path or not url:
        raise ValueError("Selected isolated WMH recording requires a retained owned cache manifest and URL")
    file = Path(path)
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
        raise ValueError("Owned recording manifest must be a regular private file")
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    manifest = _recording_manifest(str(file.resolve()), identity)
    parsed = urlsplit(url)
    database = parsed.path.removeprefix("/")
    if not (
        parsed.scheme in {"postgres", "postgresql"}
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        and database.startswith("victoria_wmh_recording_")
        and bool(workspace) and bool(fixture_database)
        and database != fixture_database
        and manifest.get("checkout") == checkout
        and manifest.get("owner_workspace") == workspace
        and manifest.get("database") == database
        and manifest.get("host") == parsed.hostname
        and manifest.get("url_sha256") == hashlib.sha256(url.encode()).hexdigest()
        and manifest.get("retained_across_iterations") is True
    ):
        raise ValueError("WMH recording cache must be a retained loopback owner separate from the fixture")
    for name in ("DATABASE_URL", "RECORD_DEMO", "DISABLE_WRITE_THROUGH", "USE_LOCAL"):
        current, legacy = env.get("DEMO_CACHE_" + name), env.get("FAST_MODE_CACHE_" + name)
        if current is not None and legacy is not None and current != legacy:
            raise ValueError("Conflicting DEMO cache environment aliases")
    if _truthy(env.get("BENCHMARK_DEMO_CACHE_READ_ONLY")):
        raise ValueError("Owned recording conflicts with read-only validation")
    return hashlib.sha256(url.encode()).hexdigest()


def owned_recording_namespace() -> str | None:
    """An explicit validated owner enables fresh reads-off recording only."""
    env = os.environ
    if (env.get("WMH_OWNED_RECORDING_CACHE_MANIFEST") or env.get("WMH_OWNED_RECORDING_CACHE_DATABASE_URL")) and (
        env.get("DEMO_CACHE_RECORD_DEMO") is not None and env.get("FAST_MODE_CACHE_RECORD_DEMO") is not None
        and env["DEMO_CACHE_RECORD_DEMO"] != env["FAST_MODE_CACHE_RECORD_DEMO"]
    ):
        raise ValueError("Conflicting DEMO recording aliases")
    if not demo_recording_enabled():
        return None
    if not (env.get("WMH_OWNED_RECORDING_CACHE_MANIFEST") or env.get("WMH_OWNED_RECORDING_CACHE_DATABASE_URL")):
        return None
    if not _truthy(env.get("BENCHMARK_ISOLATED_RUN")) or env.get("BENCHMARK_WORLD_MODEL_MODE") not in {"real", "simulate"}:
        raise ValueError("Owned recording requires an isolated run with explicit real or simulate mode")
    namespace = validate_owned_recording(
        env, checkout=str(Path(__file__).resolve().parents[3]),
        workspace=env.get("CONDUCTOR_WORKSPACE_NAME"),
        fixture_database=urlsplit(env.get("DATABASE_URL", "")).path.removeprefix("/"),
    )
    if demo_cache_env("DEMO_CACHE_DATABASE_URL") != env.get("WMH_OWNED_RECORDING_CACHE_DATABASE_URL"):
        raise ValueError("Owned recording cache URL is not the effective cache database")
    return namespace


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
        return self.enabled and owned_recording_namespace() is None

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
        return owned_recording_namespace() is None and normalize.soft_complete_allowed(self.goal, root_goal=self.root_goal)

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
    return owned_recording_namespace() is not None or bool(user_id) and user_id in WRITE_THROUGH_USER_IDS
