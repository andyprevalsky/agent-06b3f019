"""Web search domain constants and defaults."""

# Parallel AI Search API (V1 Turbo — same contract as chat web_search)
PARALLEL_API_URL = "https://api.parallel.ai/v1/search"
PARALLEL_SEARCH_MODE = "turbo"

# Defaults. Capped at the source so parallel-fanout sub-agents don't dump
# 60k chars / 15k tokens of search answer into context per call (see
# docs/plans/active context-management-overhaul). 500 tokens × 4 chars = 2k
# chars per result, 5 results = ~10k chars / ~2.5k tokens per call.
DEFAULT_MAX_TOKENS = 500
DEFAULT_MAX_RESULTS = 5

# Display
QUERY_DISPLAY_MAX_LENGTH = 100

# Pricing: Parallel Search Turbo = $1 / 1,000 requests = 0.1 cents / query
COST_CENTS_PER_QUERY = 0.1

# HTTP / activity timeouts (seconds)
HTTP_TIMEOUT = 60.0
ACTIVITY_TIMEOUT_SECONDS = 60

# Retry policy
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10
