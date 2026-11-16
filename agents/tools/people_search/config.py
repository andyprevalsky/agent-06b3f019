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

# Lantern answers a repeated identical search from the existing session, whose
# fixed TTL started at the first search. A first page with less continuation
# lifetime than this is fetched again once that session expires, inside the
# HTTP budget and with a reserve left for the second request.
SEARCH_SESSION_MIN_LIFETIME_SECONDS = 30.0
SEARCH_SESSION_REFRESH_RESERVE_SECONDS = 10.0

# Do not immediately replay rate-limited, ambiguous or unknown-outcome calls.
RETRY_MAX_ATTEMPTS = 1
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 5
