"""People search domain config - constants, defaults, and pricing."""

# Exa API endpoint
EXA_SEARCH_URL = "https://api.exa.ai/search"

# Exa search category for people
EXA_SEARCH_CATEGORY = "people"

# Default max results for people search
DEFAULT_MAX_RESULTS = 10

# HTTP timeout for Exa API calls (seconds)
EXA_TIMEOUT_SECONDS = 60.0

# Content limits
MAX_TEXT_CHARACTERS = 5000
PROFILE_TEXT_TRUNCATE_LENGTH = 2000

# Display limits
QUERY_DISPLAY_MAX_LENGTH = 100

# Exa pricing: $5/1000 search = 0.5 cents per search
COST_PER_SEARCH_CENTS = 0.5

# Exa pricing: $1/1000 text content = 0.1 cents per result
COST_PER_RESULT_CENTS = 0.1
