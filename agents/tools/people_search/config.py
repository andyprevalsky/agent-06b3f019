"""People search domain constants and defaults."""

# ---------------------------------------------------------------------------
# Providers (exposed to the model as an enum; no auto-routing)
# ---------------------------------------------------------------------------

PROVIDERS = ("exa", "parallel")
# When the chosen provider rate-limits or errors, auto-retry the OTHER one.
PROVIDER_FALLBACK = {"exa": "parallel", "parallel": "exa"}

# Exa Search API (people category). Sync, sub-second to a few seconds.
EXA_SEARCH_URL = "https://api.exa.ai/search"
EXA_CATEGORY = "people"
EXA_TYPE = "auto"
# enrich resolves ONE person; request a small candidate pool so the provider
# can rank, then return the single best match.
ENRICH_EXA_CANDIDATE_POOL = 3

# Parallel Fast Entity Search (FindAll). Sync, recall-optimized.
# NOTE: Parallel's deep, field-level enrichment (FindAll) is async and
# multi-minute, which violates the sub-minute tool-call budget, so it is NOT
# wired. enrich + parallel falls back to Entity Search (best-effort fields).
PARALLEL_ENTITY_SEARCH_URL = "https://api.parallel.ai/v1beta/findall/entity-search"
PARALLEL_ENTITY_TYPE = "people"
# Parallel rejects match_limit below 5; request the floor then trim output.
PARALLEL_MIN_MATCH_LIMIT = 5

# ---------------------------------------------------------------------------
# Public-interface limits
# ---------------------------------------------------------------------------

MODES = ("enrich", "discover")

# discover: caller-facing list size, clamped to this range.
DISCOVER_DEFAULT_LIMIT = 10
DISCOVER_MIN_LIMIT = 1
DISCOVER_MAX_LIMIT = 25

# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

QUERY_DISPLAY_MAX_LENGTH = 100

# Pricing (cents/query). Rough flat-rate estimates for usage accounting.
EXA_COST_CENTS_PER_QUERY = 0.7
PARALLEL_COST_CENTS_PER_QUERY = 0.5

# ---------------------------------------------------------------------------
# HTTP / activity timeouts (seconds) -- kept under the sub-minute tool budget
# ---------------------------------------------------------------------------

HTTP_TIMEOUT = 45.0
ACTIVITY_TIMEOUT_SECONDS = 55

# Retry policy (transient infra only; provider fallback is handled in-activity)
RETRY_MAX_ATTEMPTS = 2
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 5
