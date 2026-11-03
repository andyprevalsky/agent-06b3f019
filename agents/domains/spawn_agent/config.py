"""Spawn-agent domain configuration: constants, defaults, limits."""

from __future__ import annotations

from datetime import timedelta
from typing import Final

from utils.kill_switches import ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV, general_purpose_agent_disabled
from utils.oai_demo import is_oai_demo_goal, is_oai_demo_mass_agent_task

# ── Explore agent ──
EXPLORE_ACTIVITY_TIMEOUT = timedelta(seconds=600)  # 10 min max (medium default)
EXPLORE_HEARTBEAT_TIMEOUT = timedelta(seconds=120)
EXPLORE_MAX_ITERATIONS = 20  # medium depth; see EXPLORE_DEPTH_LIMITS
EXPLORE_DEFAULT_MODEL = "rose-labs/rose-1-flash"
EXPLORE_MESSAGE_TRUNCATE_LEN = 500
EXPLORE_GOAL_DISPLAY_LEN = 200

# ── Explore depth (caller-controlled thoroughness) ──
# The cap is TURNS, not searches — one turn can batch many parallel tool calls.
# Mirrors Claude Code's exploreAgent thoroughness levels. Default is "quick".
# depth -> (max_iterations turns, activity_timeout)
EXPLORE_DEPTH_LIMITS = {
    "quick": (5, timedelta(seconds=600)),
    "medium": (20, timedelta(seconds=600)),
    "deep": (50, timedelta(seconds=1800)),
}
EXPLORE_DEFAULT_DEPTH = "quick"
# The parent waits the depth's full activity timeout. If the handle is still
# open at that point, cancel and wait this long instead of awaiting it
# unbounded (53831ac9: an unbounded await blocked past the activity timeout).
EXPLORE_CANCEL_GRACE = timedelta(seconds=15)
# Fast Mode replays July OAi-demo explore trajectories whose attempt_completion
# typically lands around turn ~14 (many namespaces run to p:20–49). The live
# default "quick" (5) aborts mid-replay before that turn → max-iter + loops.
EXPLORE_FAST_MODE_DEPTH = "deep"
# Turns before the cap at which the graceful wind-down nudge is injected.
EXPLORE_WINDDOWN_WINDOW = 1

# Model-visible result of an explore completion deferred because an agent
# message arrived before the answer was delivered (the message follows it).
EXPLORE_COMPLETION_DEFERRED_FOR_MESSAGE = (
    "Result not delivered: a new message for you arrived before it; the message follows."
)


def explore_limits_for_depth(depth: str | None) -> tuple[int, timedelta]:
    """Resolve an explore depth to (max_iterations, activity_timeout).

    Unknown/None falls back to the default depth. The cap is turns; each turn
    may batch multiple parallel searches.
    """
    return EXPLORE_DEPTH_LIMITS.get(depth or EXPLORE_DEFAULT_DEPTH, EXPLORE_DEPTH_LIMITS[EXPLORE_DEFAULT_DEPTH])


def resolve_explore_depth(
    requested_depth: str | None,
    *,
    fast_mode_cache_enabled: bool = False,
    oai_demo: bool = False,
) -> str:
    """Pick explore thoroughness for a spawn.

    Under DEMO cache replay (test-mass-agent-run-0), use EXPLORE_FAST_MODE_DEPTH:
    July OAi-demo explore caches often reach attempt_completion at turn ~26–36,
    so both the live default (quick=5) and an explicit medium=20 abort mid-replay.
    Other trees keep the requested/live depth. The Fast Mode button does not
    affect depth — only DEMO prompt match does (via oai_demo / cache flag).
    """
    if oai_demo:
        return EXPLORE_FAST_MODE_DEPTH
    if requested_depth in EXPLORE_DEPTH_LIMITS:
        return requested_depth
    return EXPLORE_DEFAULT_DEPTH


# ── Network metadata ──
NETWORK_CACHE_TTL_MINUTES = 5
NETWORK_FETCH_TIMEOUT = 30.0
NETWORK_PEOPLE_LIMIT = 500
NETWORK_PERSON_SKIP_FIELDS = frozenset({"id", "userId", "createdAt", "updatedAt", "firstName", "lastName"})

# ── Fetch timeouts for sub-activities ──
SUB_ACTIVITY_TIMEOUT = timedelta(seconds=30)
SUB_ACTIVITY_MAX_ATTEMPTS = 2

# ── For-each ──
FOR_EACH_MAX_DEPTH = 4
FOR_EACH_MAX_INFLIGHT = 5
# Legacy inflight cap from the removed fire-and-track path. Fast Mode now
# waits for each explore like live; this constant is only used by leftover
# slot helpers that no spawn path calls.
FM_EXPLORE_INFLIGHT_CAP = 16

# Small fleet-concurrency DEMO probes (demo-fleet-alpha|beta|gamma). Prefix is
# workflow-sandbox safe (no catalog I/O). Keep in sync with tasks.json prompts.
DEMO_FLEET_CONCURRENCY_GOAL_PREFIX = "DEMO fleet concurrency probe"

# Eager catalog allowlist for workflow gating. Must load at import time (worker /
# pass-through), never lazily inside a Temporal workflow step — file I/O and
# deferred imports there leave agents stuck in STARTING_UP.
_DEMO_CACHE_GOAL_HASHES: frozenset[str]
_demo_cache_goal_hash = None
try:
    from providers.demo_cache.normalize import (
        demo_cache_goal_hashes as _load_demo_cache_goal_hashes,
    )
    from providers.demo_cache.normalize import (
        goal_hash as _load_demo_cache_goal_hash,
    )

    _DEMO_CACHE_GOAL_HASHES = _load_demo_cache_goal_hashes()
    _demo_cache_goal_hash = _load_demo_cache_goal_hash
except Exception:  # pragma: no cover - slim images / import-order unit tests
    _DEMO_CACHE_GOAL_HASHES = frozenset()
    _demo_cache_goal_hash = None


def is_demo_cache_task(workflow_instance) -> bool:
    """True when Fast Mode DEMO cache replay / cold soft-complete may run.

    Broader than ``is_oai_demo_mass_agent_task``: catalog DEMO / ``demo_cache:on``
    goal hashes (eagerly loaded) plus the fleet-concurrency DEMO prefix.
    Used only to gate ``workflow.fast_mode_cache_enabled`` — mass-agent-only
    spawn rules keep ``is_oai_demo_mass_agent_task``.
    """
    if is_oai_demo_mass_agent_task(workflow_instance):
        return True
    goal = str(getattr(workflow_instance, "goal", None) or "")
    cached = str(getattr(workflow_instance, "demo_cache_goal", None) or "")
    root_goal = str(getattr(workflow_instance, "root_goal", None) or "")
    if any(DEMO_FLEET_CONCURRENCY_GOAL_PREFIX in blob for blob in (goal, cached, root_goal)):
        return True
    if _demo_cache_goal_hash is None or not _DEMO_CACHE_GOAL_HASHES:
        return False
    for blob in (goal, cached, root_goal):
        if blob and _demo_cache_goal_hash(blob) in _DEMO_CACHE_GOAL_HASHES:
            return True
    return False


def should_skip_oai_demo_browser_spawn(workflow_instance) -> bool:
    """DEMO mass-agent trees must not open browser-agent sessions."""
    return is_oai_demo_mass_agent_task(workflow_instance)


def resolve_explore_oai_demo(goal: str | None, *, oai_demo: bool | None = None) -> bool:
    """Canonical explore demo class: explicit flag wins, else goal prefix only.

    `_spawn_explore` computes `is_oai_demo_mass_agent_task` once and passes it
    as the activity's trailing `oai_demo`. Direct/old callers omit the flag;
    those fall back to `is_oai_demo_goal(goal)` and must not re-read Fast Mode
    resolver goals — truncated child goals and resolver failures disagree.
    """
    if oai_demo is not None:
        return bool(oai_demo)
    return is_oai_demo_goal(goal)


# ── Explore message save ──
SAVE_MESSAGE_TIMEOUT = 5.0


# =============================================================================
# Temporary GPA kill-switch (utils.kill_switches)
# =============================================================================
_DISABLED_TYPES: Final[frozenset[str]] = frozenset({"general_purpose", "for_each"})
_DISABLED_PLANNER_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "spawn_general_purpose_agent",
        "spawn_general_purpose_agent_for_each",
    }
)


def is_disabled_general_purpose_type(agent_type: str | None) -> bool:
    """True when ``agent_type`` is blocked by ROSE_DISABLE_GENERAL_PURPOSE_AGENT."""
    return general_purpose_agent_disabled() and str(agent_type or "").strip() in _DISABLED_TYPES


def is_disabled_general_purpose_planner_tool(tool_name: str | None) -> bool:
    """True when a planner alias tool is blocked by the GPA kill-switch."""
    return general_purpose_agent_disabled() and str(tool_name or "").strip() in _DISABLED_PLANNER_TOOLS


def disabled_general_purpose_rejection_message(*, agent_type: str | None = None, tool_name: str | None = None) -> str:
    """User-facing rejection for a blocked general_purpose / for_each spawn."""
    label = agent_type or tool_name or "general_purpose"
    return (
        f"spawn_agent type/tool '{label}' is disabled for this run "
        f"({ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV}=1). "
        "Use spawn_agent(type='code') / Claude Code for GitHub discovery and ranking, "
        "or type='explore' for read-only research."
    )
