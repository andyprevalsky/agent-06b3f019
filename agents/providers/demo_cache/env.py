"""DEMO cache environment variables.

``DEMO_CACHE_<NAME>`` is the current spelling. The legacy ``FAST_MODE_CACHE_<NAME>``
/ ``FAST_CACHE_<NAME>`` spelling is still honoured, and wins while it is present,
so existing prod, Fly, Render and benchmark environments keep their exact
behaviour without any env writes. Harness code that isolates a stack must clear
both spellings (``DEMO_CACHE_ENV_ALIASES``).
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

DEMO_CACHE_ENV_ALIASES: dict[str, str] = {
    "DEMO_CACHE_DATABASE_URL": "FAST_MODE_CACHE_DATABASE_URL",
    "DEMO_CACHE_USE_LOCAL": "FAST_MODE_CACHE_USE_LOCAL",
    "DEMO_CACHE_DISABLE_WRITE_THROUGH": "FAST_MODE_CACHE_DISABLE_WRITE_THROUGH",
    "DEMO_CACHE_RECORD_DEMO": "FAST_MODE_CACHE_RECORD_DEMO",
    "DEMO_CACHE_DB_POOL": "FAST_CACHE_DB_POOL",
    "DEMO_CACHE_GET_BATCH_MAX_IN_FLIGHT": "FAST_CACHE_GET_BATCH_MAX_IN_FLIGHT",
    "DEMO_CACHE_HTTP_MAX_CONNECTIONS": "FAST_CACHE_HTTP_MAX_CONNECTIONS",
    "DEMO_CACHE_HTTP_MAX_KEEPALIVE_CONNECTIONS": "FAST_CACHE_HTTP_MAX_KEEPALIVE_CONNECTIONS",
    "DEMO_CACHE_POSITION_MAX_IN_FLIGHT": "FAST_CACHE_POSITION_MAX_IN_FLIGHT",
}


def demo_cache_env(name: str, default: Optional[str] = None, environ: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """Read ``DEMO_CACHE_<NAME>``, honouring its legacy alias first when present."""
    env = os.environ if environ is None else environ
    legacy = DEMO_CACHE_ENV_ALIASES[name]
    if legacy in env:
        return env[legacy]
    return env.get(name, default)


def pop_demo_cache_env(env: dict[str, str], name: str) -> None:
    """Remove both spellings of one DEMO cache variable from a child env."""
    env.pop(name, None)
    env.pop(DEMO_CACHE_ENV_ALIASES[name], None)
