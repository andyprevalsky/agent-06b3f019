"""Spawn-agent domain configuration: constants, defaults, limits."""

from __future__ import annotations

import os
from datetime import timedelta
from typing import Final

# ── Explore agent ──
EXPLORE_ACTIVITY_TIMEOUT = timedelta(seconds=600)  # 10 min max (medium default)
EXPLORE_HEARTBEAT_TIMEOUT = timedelta(seconds=120)
EXPLORE_MAX_ITERATIONS = 20  # medium depth; see EXPLORE_DEPTH_LIMITS
EXPLORE_DEFAULT_MODEL = "rose-labs/rose-1-lite"
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
# Fast Mode replays July OAi-demo explore trajectories whose attempt_completion
# typically lands around turn ~14 (many namespaces run to p:20–49). The live
# default "quick" (5) aborts mid-replay before that turn → max-iter + loops.
EXPLORE_FAST_MODE_DEPTH = "deep"
# Turns before the cap at which the graceful wind-down nudge is injected.
EXPLORE_WINDDOWN_WINDOW = 1


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

# test-mass-agent-run-0 / July OAi demo only. Nested GP skip and the Andy
# name rewrite must not apply to other Fast Mode trees.
OAI_DEMO_ROOT_GOAL_PREFIX = (
    "I'm building a personal brand for health, longevity, technology, founder journey"  # pragma: allowlist secret
)
OAI_DEMO_CHILD_WINDOW = "2026-04-04 through 2026-07-03"  # pragma: allowlist secret
# First-level for_each children start with this even when Agent.goal is
# truncated before the date window. Keep hashing on window/root only so a
# truncated goal cannot alias all 50 children onto one namespace.
OAI_DEMO_CHILD_GOAL_PREFIX = "You are analyzing ONE creator"
OAI_DEMO_CACHE_SOURCE_NAME = "Aman Gottumukkala"
OAI_DEMO_CACHE_DISPLAY_NAME = "Andy Prevalsky"


def _is_oai_demo_bound_child_goal(blob: str) -> bool:
    """Child prefix alone is not enough — require a DEMO identity binding.

    Real for_each children always include Andy/Aman (or the date window / root
    brand). Rejecting a bare prefix stops unrelated goals that merely contain
    "You are analyzing ONE creator" from entering demo cache replay.
    """
    if OAI_DEMO_CHILD_GOAL_PREFIX not in blob:
        return False
    return (
        OAI_DEMO_CACHE_DISPLAY_NAME in blob
        or OAI_DEMO_CACHE_SOURCE_NAME in blob
        or OAI_DEMO_CHILD_WINDOW in blob
        or OAI_DEMO_ROOT_GOAL_PREFIX in blob
    )


def is_oai_demo_goal(text: str | None) -> bool:
    """True only for test-mass-agent-run-0 root, child-window, or bound child."""
    blob = str(text or "")
    return (
        OAI_DEMO_ROOT_GOAL_PREFIX in blob
        or OAI_DEMO_CHILD_WINDOW in blob
        or _is_oai_demo_bound_child_goal(blob)
    )


def is_oai_demo_mass_agent_task(workflow_instance) -> bool:
    """True only for the mass-agent-0 root or its per-creator for_each children."""
    chunks = (
        getattr(workflow_instance, "fast_cache_goal", None) or "",
        getattr(workflow_instance, "goal", None) or "",
    )
    return is_oai_demo_goal("\n".join(str(chunk) for chunk in chunks))


# Small fleet-concurrency DEMO probes (demo-fleet-alpha|beta|gamma). Prefix is
# workflow-sandbox safe (no catalog I/O). Keep in sync with tasks.json prompts.
DEMO_FLEET_CONCURRENCY_GOAL_PREFIX = "DEMO fleet concurrency probe"

# Eager catalog allowlist for workflow gating. Must load at import time (worker /
# pass-through), never lazily inside a Temporal workflow step — file I/O and
# deferred imports there leave agents stuck in STARTING_UP.
_DEMO_CACHE_GOAL_HASHES: frozenset[str]
_demo_cache_goal_hash = None
try:
    from providers.fast_cache.normalize import (
        demo_cache_goal_hashes as _load_demo_cache_goal_hashes,
        goal_hash as _load_demo_cache_goal_hash,
    )

    _DEMO_CACHE_GOAL_HASHES = _load_demo_cache_goal_hashes()
    _demo_cache_goal_hash = _load_demo_cache_goal_hash
except Exception:  # pragma: no cover - slim images / import-order unit tests
    _DEMO_CACHE_GOAL_HASHES = frozenset()
    _demo_cache_goal_hash = None


def is_demo_cache_task(workflow_instance) -> bool:
    """True when Fast Mode DEMO cache replay / cold soft-complete may run.

    Broader than ``is_oai_demo_mass_agent_task``: catalog DEMO / ``fast_cache:on``
    goal hashes (eagerly loaded) plus the fleet-concurrency DEMO prefix.
    Used only to gate ``workflow.fast_mode_cache_enabled`` — mass-agent-only
    spawn rules keep ``is_oai_demo_mass_agent_task``.
    """
    if is_oai_demo_mass_agent_task(workflow_instance):
        return True
    goal = str(getattr(workflow_instance, "goal", None) or "")
    root = str(getattr(workflow_instance, "fast_cache_goal", None) or "")
    if DEMO_FLEET_CONCURRENCY_GOAL_PREFIX in goal or DEMO_FLEET_CONCURRENCY_GOAL_PREFIX in root:
        return True
    if _demo_cache_goal_hash is None or not _DEMO_CACHE_GOAL_HASHES:
        return False
    if goal and _demo_cache_goal_hash(goal) in _DEMO_CACHE_GOAL_HASHES:
        return True
    if root and _demo_cache_goal_hash(root) in _DEMO_CACHE_GOAL_HASHES:
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
# Temporary GPA kill-switch
# =============================================================================
# Drop general_purpose / for_each spawn routes so coding-agent GitHub ranking
# benches cannot burn budget (or trip forbidden_tools) on recursive GP fan-out.
# Prefer spawn_agent(type=code). Values: 1 / true / yes / on
ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV: Final[str] = "ROSE_DISABLE_GENERAL_PURPOSE_AGENT"

_DISABLED_TYPES: Final[frozenset[str]] = frozenset({"general_purpose", "for_each"})
_DISABLED_PLANNER_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "spawn_general_purpose_agent",
        "spawn_general_purpose_agent_for_each",
    }
)


def general_purpose_agent_disabled() -> bool:
    """Return True when general_purpose / for_each spawn routes must be blocked."""
    raw = os.getenv(ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV, "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def is_disabled_general_purpose_type(agent_type: str | None) -> bool:
    """True when ``agent_type`` is blocked by ROSE_DISABLE_GENERAL_PURPOSE_AGENT."""
    return general_purpose_agent_disabled() and str(agent_type or "").strip() in _DISABLED_TYPES


def is_disabled_general_purpose_planner_tool(tool_name: str | None) -> bool:
    """True when a planner alias tool is blocked by the GPA kill-switch."""
    return general_purpose_agent_disabled() and str(tool_name or "").strip() in _DISABLED_PLANNER_TOOLS


def disabled_general_purpose_rejection_message(
    *, agent_type: str | None = None, tool_name: str | None = None
) -> str:
    """User-facing rejection for a blocked general_purpose / for_each spawn."""
    label = agent_type or tool_name or "general_purpose"
    return (
        f"spawn_agent type/tool '{label}' is disabled for this run "
        f"({ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV}=1). "
        "Use spawn_agent(type='code') / Claude Code for GitHub discovery and ranking, "
        "or type='explore' for read-only research."
    )
