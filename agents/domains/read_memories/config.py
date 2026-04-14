"""Read Memories domain config — constants, defaults, env reads."""

# SuperMemory API endpoint
SUPERMEMORY_PROFILE_URL = "https://api.supermemory.ai/v4/profile"

# HTTP timeout for SuperMemory requests (seconds)
REQUEST_TIMEOUT_SECS = 30.0

# Display truncation for query in status messages
DISPLAY_QUERY_MAX_LEN = 100

# Temporal activity retry settings
ACTIVITY_TIMEOUT_SECS = 30
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECS = 1
RETRY_MAX_INTERVAL_SECS = 10
