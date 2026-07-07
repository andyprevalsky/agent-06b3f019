"""Fast Mode cache — persisted-goal resolution activity.

The Temporal workflow may start with a goal that differs from the persisted
Agent row: chat escalation passes an LLM-refined goal to the workflow
(back-end/src/providers/chat/chatHandler.ts, "Use refined goal if provided")
and that refined text varies run to run. Fast Mode cache keys namespace by
exact goal hash, so keying on the workflow-input goal gives every
chat-originated run a fresh, empty namespace — a 100% miss.

This activity resolves the durable DB-row goal so all runs of the same
persisted goal share one cache namespace. It is the same source the
activity-side fallback (`ensure_position_context` → `resolve_agent_fast_mode`)
already uses, which is why DAG calls replayed for chat-originated runs while
the explicitly-threaded plan/execute/verifier calls missed.
"""

from typing import Optional

import structlog
from temporalio import activity

logger = structlog.get_logger()


@activity.defn
async def resolve_fast_cache_goal_activity(agent_id: str) -> Optional[str]:
    """Return the persisted Agent-row goal for Fast Mode cache keying.

    Returns None when the agent row can't be resolved; the workflow falls back
    to its input goal (pre-fix behavior).
    """
    # Lazy import: providers.fast_cache.client imports helpers.trace_archive,
    # so a module-level import here would cycle through helpers/__init__.
    from providers.fast_cache.client import resolve_agent_fast_mode

    # resolve_agent_fast_mode returns a 4-tuple (enabled, goal, write_enabled,
    # root_agent_id). Unpacking only 3 here raised ValueError("too many values to
    # unpack (expected 3)"), failing resolve_fast_cache_goal_activity on every run.
    _enabled, goal, _write_enabled, _root_agent_id = await resolve_agent_fast_mode(agent_id)
    logger.info(
        "fast_cache.goal_resolved",
        agent_id=agent_id,
        resolved=bool(goal),
    )
    return goal
