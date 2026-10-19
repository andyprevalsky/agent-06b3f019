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

# One end-to-end deadline per activity attempt, strictly inside
# ACTIVITY_TIMEOUT_SECONDS so the typed result or outage error is returned
# before Temporal's start-to-close timeout. Every provider request and the
# keyless fallback receives only the time remaining (HTTP_TIMEOUT is a cap,
# not a grant). Authenticated providers and their retries must finish by
# SEARCH_DEADLINE_SECONDS - DDGS_FALLBACK_RESERVE_SECONDS, so a provider that
# hangs can never consume the fallback's time.
SEARCH_DEADLINE_SECONDS = 55.0
DDGS_FALLBACK_RESERVE_SECONDS = 15.0

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
# after PROVIDER_RETRY_BUDGET_SECONDS or past the authenticated deadline above;
# the rest of the SEARCH_DEADLINE_SECONDS budget is left for the final request
# and the keyless fallback. Exhaustion is
# non-retryable so the activity retry policy does not multiply provider load.
PROVIDER_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS
PROVIDER_RETRY_BUDGET_SECONDS = 25.0
PROVIDER_RETRY_AFTER_MAX_SECONDS = 10.0
