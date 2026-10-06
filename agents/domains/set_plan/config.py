"""set-plan domain config -- constants, defaults."""

# Maximum planner LLM retry attempts on validation failure
MAX_RETRIES = 2

# Temporal activity timeouts (seconds)
PLANNER_ACTIVITY_TIMEOUT_SECONDS = 240
# StartToClose is the LLM budget after Temporal considers the activity started.
# Agent 292022e4 sat on "Generating Plan" for 241s because heartbeat_timeout
# was 0, so a StartToClose on a dead assignment was the only liveness signal.
# Do not add a short schedule_to_start with max_attempts=2 — that can fail a
# healthy pickup that would have succeeded inside the 240s budget.
PLANNER_ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS = 30
PLANNER_ACTIVITY_MAX_ATTEMPTS = 2

SCHEMA_ACTIVITY_TIMEOUT_SECONDS = 90
SCHEMA_ACTIVITY_MAX_ATTEMPTS = 3

# Default goal when no user messages found
DEFAULT_GOAL = "Complete the user's request"
