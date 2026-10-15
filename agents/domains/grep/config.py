"""Grep domain config - constants, defaults, limits."""

# HTTP timeout for grep backend calls (seconds)
GREP_HTTP_TIMEOUT = 25.0

# HTTP timeout for data summary endpoint (seconds)
SUMMARY_HTTP_TIMEOUT = 15.0

# Cache TTL for local data summaries (minutes)
SUMMARY_CACHE_TTL_MINUTES = 5

# Truncation limit for display pattern in tool events
DISPLAY_PATTERN_MAX_LENGTH = 80

# Maximum pattern length to log
LOG_PATTERN_MAX_LENGTH = 100

# Top threads to show in data summary
SUMMARY_MAX_THREADS = 15

# Temporal activity retry settings
ACTIVITY_TIMEOUT_SECONDS = 30
ACTIVITY_MAX_ATTEMPTS = 2
ACTIVITY_BACKOFF_COEFFICIENT = 2.0
ACTIVITY_INITIAL_INTERVAL_SECONDS = 1
ACTIVITY_MAX_INTERVAL_SECONDS = 5
