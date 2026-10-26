"""DEMO cache (Python side).

Record/replay store for third-party responses so a slow real run can be replayed
instantly for demos. Writes happen ONLY when Fast Mode is enabled. The store lives
in the backend (Postgres + Supabase); this package is the agent-side client +
key/normalization rules (mirrored from back-end/src/domains/demo-cache).
"""

from . import normalize
from .client import cache_get, cache_set
from .context import (
    DemoCacheContext,
    current_context,
    is_enabled,
    reset_context,
    set_context,
)

__all__ = [
    "DemoCacheContext",
    "current_context",
    "set_context",
    "reset_context",
    "is_enabled",
    "cache_get",
    "cache_set",
    "normalize",
]
