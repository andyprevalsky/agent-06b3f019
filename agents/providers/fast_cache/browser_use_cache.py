"""Fast Mode — browser-use LLM decision record/replay.

The browser agent's "what action next" LLM call (`complete_browser_use`) is the slow,
expensive part of each browser step. We cache its result by a canonical browser
request fingerprint: task, browser observation, action history, and turn messages.
The live browser session still executes the action — only the DECISION is cached.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Optional

import structlog

from . import client as cache_client
from . import normalize

logger = structlog.get_logger(__name__)


async def cached_browser_decision(
    *,
    enabled: bool,
    goal: Optional[str],
    request: Dict[str, Any],
    call_llm: Callable[[], Awaitable[Dict[str, Any]]],
    write_enabled: bool = False,
) -> Dict[str, Any]:
    """Return a browser-use decision, from cache when possible.

    `call_llm` is the live decision call (zero-arg coroutine). `enabled`
    controls read/replay. `write_enabled` records live decisions without a read.
    """
    if not goal or not (enabled or write_enabled):
        return await call_llm()

    key = normalize.browser_use_key(goal, request)
    if enabled:
        try:
            stored = await cache_client.cache_get(key)
        except Exception as exc:  # never break a run on a cache read
            logger.warning("fast_cache.browser_use_get_error", key=key, error=str(exc))
            stored = None
        if stored is not None:
            logger.info("fast_cache.browser_use_hit", key=key)
            return stored
        logger.info("fast_cache.browser_use_miss", key=key)
    else:
        logger.info("fast_cache.browser_use_write_only", key=key)

    result = await call_llm()
    if enabled or write_enabled:
        try:
            await cache_client.cache_set(key, "browser_use", normalize.goal_hash(goal), result)
            logger.info("fast_cache.browser_use_stored", key=key)
        except Exception as exc:
            logger.warning("fast_cache.browser_use_set_error", key=key, error=str(exc))
    return result
