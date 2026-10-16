"""Lantern people-search limits, display settings and activity policy."""

# Legacy names remain valid activity inputs; all real execution uses Lantern.
PROVIDERS = ("lantern", "exa", "parallel")
MODES = ("enrich", "discover")
DISCOVER_DEFAULT_LIMIT = 10
DISCOVER_MIN_LIMIT = 1
DISCOVER_MAX_LIMIT = 25
QUERY_DISPLAY_MAX_LENGTH = 100

# Owned search/profile operations are nonbillable; paid research is separate.
LANTERN_COST_CENTS_PER_QUERY = 0.0
HTTP_TIMEOUT = 45.0
AUTH_HTTP_TIMEOUT = 18.0
ACTIVITY_TIMEOUT_SECONDS = 55

# Do not immediately replay rate-limited, ambiguous or unknown-outcome calls.
RETRY_MAX_ATTEMPTS = 1
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 5
