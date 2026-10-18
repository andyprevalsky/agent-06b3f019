"""Web search domain constants and defaults."""

# Parallel AI Search API (V1 Turbo — same contract as chat web_search)
PARALLEL_API_URL = "https://api.parallel.ai/v1/search"
PARALLEL_SEARCH_MODE = "turbo"

# Exa Search API — secondary authenticated provider with its own quota, used
# when Parallel is rate-limited or unavailable. Same endpoint/contract as
# tools/people_search, without the people category (general web results).
EXA_SEARCH_URL = "https://api.exa.ai/search"
EXA_SEARCH_TYPE = "auto"

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
# Exa: same flat-rate estimate as tools/people_search. Keyless DDGS is unbilled.
EXA_COST_CENTS_PER_QUERY = 0.7

# HTTP / activity timeouts (seconds)
HTTP_TIMEOUT = 60.0
ACTIVITY_TIMEOUT_SECONDS = 60

# Retry policy
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10

# Provider retries inside one activity attempt. Transient failures (HTTP 429,
# 5xx, timeouts, transport errors) are retried per provider with jittered
# exponential backoff (the RETRY_* values above), never earlier than the
# provider's Retry-After. A provider is not retried in this call when its
# Retry-After exceeds PROVIDER_RETRY_AFTER_MAX_SECONDS or the retry would start
# after PROVIDER_RETRY_BUDGET_SECONDS; the rest of the ACTIVITY_TIMEOUT_SECONDS
# attempt is left for the final request and the keyless fallback. Exhaustion is
# non-retryable so the activity retry policy does not multiply provider load.
PROVIDER_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS
PROVIDER_RETRY_BUDGET_SECONDS = 25.0
PROVIDER_RETRY_AFTER_MAX_SECONDS = 10.0
