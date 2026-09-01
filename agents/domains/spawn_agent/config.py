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
    oai_demo: bool = False,
) -> str:
    """Pick explore thoroughness for a spawn.

    Under Fast Mode on test-mass-agent-run-0 only, use EXPLORE_FAST_MODE_DEPTH:
    July OAi-demo explore caches often reach attempt_completion at turn ~26–36,
    so both the live default (quick=5) and an explicit medium=20 abort mid-replay.
    Other Fast Mode trees keep the requested/live depth. Outside Fast Mode,
    explicit medium/deep win; otherwise the live default applies.
    """
    if fast_mode_cache_enabled and oai_demo:
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
# OAi-demo Fast Mode only: fire-and-track explores so a Huberman-class GP
# (224–336 sequential explores) can overlap instead of paying p50~32s each
# on the parent execute_loop. Cap is per GP workflow so 50 first-level GPs
# stay within the isolated worker's ~500 activity slots (50×16=800 queued;
# Temporal backpressures). Not a shared fan-in — each GP tracks its own
# handles. Other Fast Mode trees keep the blocking explore path.
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


def is_oai_demo_goal(text: str | None) -> bool:
    """True only for test-mass-agent-run-0 root, child-window, or for_each prefix."""
    blob = str(text or "")
    return (
        OAI_DEMO_ROOT_GOAL_PREFIX in blob
        or OAI_DEMO_CHILD_WINDOW in blob
        or OAI_DEMO_CHILD_GOAL_PREFIX in blob
    )


def is_oai_demo_mass_agent_task(workflow_instance) -> bool:
    """True only for the mass-agent-0 root or its per-creator for_each children."""
    chunks = (
        getattr(workflow_instance, "fast_cache_goal", None) or "",
        getattr(workflow_instance, "goal", None) or "",
    )
    return is_oai_demo_goal("\n".join(str(chunk) for chunk in chunks))

# ── Explore message save ──
SAVE_MESSAGE_TIMEOUT = 5.0
