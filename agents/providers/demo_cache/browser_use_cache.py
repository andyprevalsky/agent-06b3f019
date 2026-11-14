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


def soft_complete_browser_decision() -> Dict[str, Any]:
    """Synthetic Fast Mode browser decision when the warm trajectory is exhausted.

    Returning ``done`` lets the browser loop run the normal completion/verifier
    path instead of burning live ``rose-1-browser-use`` tokens (verify13).
    """
    return {
        "action": {
            "action": "done",
            "params": {
                "text": (
                    "Fast Mode cache trajectory ended for this browser goal; "
                    "treating gathered page evidence as sufficient."
                ),
            },
            "thinking": "Fast Mode soft-complete",
        },
        "actual_model": "fast-mode-soft-complete",
        "pool_name": "",
        "request_id": "fast-mode-soft-complete",
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "from_fast_cache": True,
        },
        "mode": "fast_cache",
        "from_fast_cache": True,
    }


async def cached_browser_decision(
    *,
    enabled: bool,
    goal: Optional[str],
    request: Dict[str, Any],
    call_llm: Callable[[], Awaitable[Dict[str, Any]]],
    write_enabled: bool = False,
    root_goal: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Return a browser-use decision, from cache when possible.

    `call_llm` is the live decision call (zero-arg coroutine). `enabled`
    controls read/replay. `write_enabled` records live decisions without a read.
    Under Fast Mode read, a clean miss soft-completes with ``done`` only for
    exact-match ``demo_cache:on`` bench trees (mass-agent OAi demo) so warm paths
    stay ~$0 instead of live browser-use.
    """
    from .context import owned_recording_namespace

    enabled = enabled and owned_recording_namespace() is None
    if not goal or not (enabled or write_enabled):
        return await call_llm()

    key = normalize.browser_use_key(goal, request)
    if enabled:
        lookup_failed = False
        try:
            stored = await cache_client.cache_get(key)
        except Exception as exc:  # never break a run on a cache read
            logger.warning("demo_cache.browser_use_get_error", key=key, error=str(exc))
            stored = None
            lookup_failed = True
        if stored is not None:
            logger.info("demo_cache.browser_use_hit", key=key)
            return stored
        logger.info("demo_cache.browser_use_miss", key=key)
        # Soft-complete only for exact-match demo_cache:on benches (mass-agent OAi).
        allowed = normalize.soft_complete_allowed(goal, root_goal=root_goal)
        if not allowed and agent_id:
            allowed = await cache_client.soft_complete_allowed_for_agent(agent_id, goal)
        if not allowed:
            logger.info(
                "demo_cache.browser_use_miss_live",
                key=key,
                reason="soft_complete_not_allowlisted",
            )
        else:
            soft = soft_complete_browser_decision()
            logger.info(
                "demo_cache.browser_use_soft_complete",
                key=key,
                reason=("browser_cache_lookup_error" if lookup_failed else "browser_trajectory_exhausted"),
            )
            return soft
    else:
        logger.info("demo_cache.browser_use_write_only", key=key)

    result = await call_llm()
    if write_enabled:
        try:
            # A non-DEMO child under a DEMO root must not write into the frozen
            # replay namespace; only the agent's resolved tree root knows.
            if agent_id and not await cache_client.cache_write_allowed_for_agent(agent_id, goal):
                logger.info("demo_cache.browser_use_write_skipped", key=key, reason="demo_tree_root")
                return result
            await cache_client.cache_set(
                key, "browser_use", normalize.goal_hash(goal), result, goal=goal, root_goal=root_goal
            )
            logger.info("demo_cache.browser_use_stored", key=key)
        except Exception as exc:
            logger.warning("demo_cache.browser_use_set_error", key=key, error=str(exc))
    return result
