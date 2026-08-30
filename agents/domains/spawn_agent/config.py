"""Spawn-agent domain configuration: constants, defaults, limits."""

from datetime import timedelta

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
) -> str:
    """Pick explore thoroughness for a spawn.

    Under Fast Mode, always use EXPLORE_FAST_MODE_DEPTH: July OAi-demo explore
    caches often reach attempt_completion at turn ~26–36, so both the live
    default (quick=5) and an explicit medium=20 abort mid-replay. Outside Fast
    Mode, explicit medium/deep win; otherwise the live default applies.
    """
    if fast_mode_cache_enabled:
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

# test-mass-agent-run-0 / July OAi demo only. Nested GP skip and the Andy
# name rewrite must not apply to other Fast Mode trees.
OAI_DEMO_ROOT_GOAL_PREFIX = (
    "I'm building a personal brand for health, longevity, technology, founder journey"  # pragma: allowlist secret
)
OAI_DEMO_CHILD_WINDOW = "2026-04-04 through 2026-07-03"  # pragma: allowlist secret


def is_oai_demo_mass_agent_task(workflow_instance) -> bool:
    """True only for the mass-agent-0 root or its per-creator for_each children."""
    chunks = (
        getattr(workflow_instance, "fast_cache_goal", None) or "",
        getattr(workflow_instance, "goal", None) or "",
    )
    text = "\n".join(str(chunk) for chunk in chunks)
    return OAI_DEMO_ROOT_GOAL_PREFIX in text or OAI_DEMO_CHILD_WINDOW in text

# ── Explore message save ──
SAVE_MESSAGE_TIMEOUT = 5.0
