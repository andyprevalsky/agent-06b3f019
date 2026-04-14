"""Configuration for the search-user-network domain."""

from datetime import timedelta

# Activity timeout and retry configuration
ACTIVITY_TIMEOUT = timedelta(seconds=30)
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL = timedelta(seconds=1)
RETRY_MAX_INTERVAL = timedelta(seconds=10)

# HTTP client timeout
HTTP_TIMEOUT = 30.0

# Display constants
TITLE_MAX_LENGTH = 40
TOOL_NAME = "search_user_network_for_people"

# Fields to exclude from person signals
INTERNAL_FIELDS = frozenset(("tool", "tool_call_id"))
