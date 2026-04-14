"""Monitor domain config — constants, defaults, and limits."""

from __future__ import annotations

# Parallel AI Monitor API
BASE_URL = "https://api.parallel.ai"
CREATE_ENDPOINT = "/v1alpha/monitors"

# HTTP settings
REQUEST_TIMEOUT_SECONDS = 60.0

# Temporal activity settings
ACTIVITY_TIMEOUT_SECONDS = 60
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10

# Cost tracking (Parallel AI pricing: $3 per 1,000 requests = $0.003 per request)
COST_PER_REQUEST_CENTS = 0.3

# Display truncation limits
TITLE_QUERY_MAX_LENGTH = 50
DISPLAY_QUERY_MAX_LENGTH = 100

# Default cadence when not specified
DEFAULT_CADENCE = "daily"
