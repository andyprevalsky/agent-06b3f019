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
# Turns before the cap at which the graceful wind-down nudge is injected.
EXPLORE_WINDDOWN_WINDOW = 1


def explore_limits_for_depth(depth: str | None) -> tuple[int, timedelta]:
    """Resolve an explore depth to (max_iterations, activity_timeout).

    Unknown/None falls back to the default depth. The cap is turns; each turn
    may batch multiple parallel searches.
    """
    return EXPLORE_DEPTH_LIMITS.get(depth or EXPLORE_DEFAULT_DEPTH, EXPLORE_DEPTH_LIMITS[EXPLORE_DEFAULT_DEPTH])

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

# ── Explore message save ──
SAVE_MESSAGE_TIMEOUT = 5.0
