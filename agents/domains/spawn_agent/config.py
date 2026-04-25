"""Spawn-agent domain configuration: constants, defaults, limits."""

from datetime import timedelta

# ── Explore agent ──
EXPLORE_ACTIVITY_TIMEOUT = timedelta(seconds=600)  # 10 min max
EXPLORE_HEARTBEAT_TIMEOUT = timedelta(seconds=120)
EXPLORE_MAX_ITERATIONS = 20
EXPLORE_DEFAULT_MODEL = "rose-labs/rose-1-lite"
EXPLORE_MESSAGE_TRUNCATE_LEN = 500
EXPLORE_GOAL_DISPLAY_LEN = 200

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
