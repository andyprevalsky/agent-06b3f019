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

It also returns the tree ``root_goal``. Child agents keep their own goal for
cache keys but inherit DEMO wait_for / spawn gates from the root prompt.
"""

from typing import Any, Optional

import structlog
from temporalio import activity

logger = structlog.get_logger()


def unpack_fast_cache_goal_resolution(
    resolved: Any,
) -> tuple[Optional[str], Optional[str]]:
    """Accept the current dict payload or a legacy persisted-goal string."""
    if isinstance(resolved, dict):
        goal = resolved.get("goal")
        root_goal = resolved.get("root_goal")
        return (
            goal if isinstance(goal, str) and goal else None,
            root_goal if isinstance(root_goal, str) and root_goal else None,
        )
    if isinstance(resolved, str) and resolved:
        return resolved, None
    return None, None


@activity.defn
async def resolve_fast_cache_goal_activity(agent_id: str) -> Optional[dict[str, Optional[str]]]:
    """Return persisted child goal plus tree root goal for DEMO inheritance.

    Returns None when the agent row can't be resolved; the workflow falls back
    to its input goal (pre-fix behavior).
    """
    # Lazy import: providers.fast_cache.client imports helpers.trace_archive,
    # so a module-level import here would cycle through helpers/__init__.
    from providers.fast_cache.client import resolve_agent_fast_mode

    # resolve_agent_fast_mode returns
    # (enabled, goal, write_enabled, root_agent_id, root_goal, provider_fast_mode).
    _enabled, goal, _write_enabled, _root_agent_id, root_goal, _pfm = await resolve_agent_fast_mode(agent_id)
    logger.info(
        "fast_cache.goal_resolved",
        agent_id=agent_id,
        resolved=bool(goal),
        root_resolved=bool(root_goal),
    )
    if not goal and not root_goal:
        return None
    return {"goal": goal, "root_goal": root_goal}


@activity.defn
async def resolve_fast_cache_context_activity(agent_id: str) -> dict[str, Any]:
    """Return the backend's complete cache decision for an agent tree.

    The workflow used to infer replay eligibility locally from one legacy OAI
    prompt.  The backend is the authoritative source because it resolves the
    persisted child and root goals against every catalog task tagged ``DEMO``.
    """
    from providers.fast_cache.client import resolve_agent_fast_mode

    # One read per workflow run start: the agent row's goal can change between
    # runs (wake / follow-up), so never reuse a previous run's process memo.
    enabled, goal, write_enabled, root_agent_id, root_goal, provider_fast_mode = await resolve_agent_fast_mode(
        agent_id, refresh=True
    )
    result = {
        "resolved": isinstance(root_agent_id, str),
        "enabled": bool(enabled),
        "goal": goal,
        "write_enabled": bool(write_enabled),
        "root_agent_id": root_agent_id,
        "root_goal": root_goal,
        "provider_fast_mode": bool(provider_fast_mode),
    }
    logger.info(
        "fast_cache.context_resolved",
        agent_id=agent_id,
        enabled=result["enabled"],
        write_enabled=result["write_enabled"],
        resolved=bool(goal),
        root_resolved=bool(root_goal),
    )
    return result
