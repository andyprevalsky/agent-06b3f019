"""Web search domain constants and defaults."""

# Parallel AI Search API
PARALLEL_API_URL = "https://api.parallel.ai/v1beta/search"
PARALLEL_BETA_HEADER = "search-extract-2025-10-10"

# Defaults. Capped at the source so parallel-fanout sub-agents don't dump
# 60k chars / 15k tokens of search answer into context per call (see
# docs/plans/active context-management-overhaul). 500 tokens × 4 chars = 2k
# chars per result, 5 results = ~10k chars / ~2.5k tokens per call.
DEFAULT_MAX_TOKENS = 500
DEFAULT_MAX_RESULTS = 5

# Display
QUERY_DISPLAY_MAX_LENGTH = 100

# Pricing: Parallel AI Search flat rate per query ($0.005 for 10 results = 0.5 cents)
COST_CENTS_PER_QUERY = 0.5

# HTTP / activity timeouts (seconds)
HTTP_TIMEOUT = 60.0
ACTIVITY_TIMEOUT_SECONDS = 60

# Retry policy
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10
