"""set-plan domain config -- constants, defaults."""

# Maximum planner LLM retry attempts on validation failure
MAX_RETRIES = 2

# Planner always uses rose-ultra for best DAG generation quality
PLANNER_MODEL = "rose-labs/rose-1-ultra"

# Temporal activity timeouts (seconds)
PLANNER_ACTIVITY_TIMEOUT_SECONDS = 240
PLANNER_ACTIVITY_MAX_ATTEMPTS = 2

SCHEMA_ACTIVITY_TIMEOUT_SECONDS = 90
SCHEMA_ACTIVITY_MAX_ATTEMPTS = 3

# Default goal when no user messages found
DEFAULT_GOAL = "Complete the user's request"
