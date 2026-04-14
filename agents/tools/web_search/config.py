"""Web search domain constants and defaults."""

# Parallel AI Search API
PARALLEL_API_URL = "https://api.parallel.ai/v1beta/search"
PARALLEL_BETA_HEADER = "search-extract-2025-10-10"

# Defaults
DEFAULT_MAX_TOKENS = 1500
DEFAULT_MAX_RESULTS = 10

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
