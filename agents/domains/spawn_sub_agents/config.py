"""Spawn-sub-agents domain configuration — constants and defaults."""

# Maximum nesting depth for sub-agent hierarchies.
MAX_DEPTH = 4

# Concurrency limit for parallel spawn requests.
MAX_PARALLEL_SPAWNS = 10

# Retry configuration for spawn HTTP requests.
MAX_SPAWN_ATTEMPTS = 4
BASE_BACKOFF_SECONDS = 0.5
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
