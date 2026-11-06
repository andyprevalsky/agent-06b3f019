"""Grep domain config - constants, defaults, limits."""

# HTTP timeout for grep backend calls (seconds)
GREP_HTTP_TIMEOUT = 25.0

# HTTP timeout for data summary endpoint (seconds)
SUMMARY_HTTP_TIMEOUT = 15.0

# Cache TTL for local data summaries (minutes)
SUMMARY_CACHE_TTL_MINUTES = 5

# Truncation limit for display pattern in tool events
DISPLAY_PATTERN_MAX_LENGTH = 80

# Maximum pattern length to log
LOG_PATTERN_MAX_LENGTH = 100

# Top threads to show in data summary
SUMMARY_MAX_THREADS = 15

# Temporal activity retry settings
ACTIVITY_TIMEOUT_SECONDS = 30
ACTIVITY_MAX_ATTEMPTS = 2
ACTIVITY_BACKOFF_COEFFICIENT = 2.0
ACTIVITY_INITIAL_INTERVAL_SECONDS = 1
ACTIVITY_MAX_INTERVAL_SECONDS = 5

# Filter keys each grep source accepts. Mirrors back-end DATA_SOURCE_CONFIGS
# (src/domains/data/types.ts); grep.blackbox.py fails if they differ.
SOURCE_FILTER_KEYS = {
    "messages": ("person", "since", "path"),
    "gmail": ("person", "since", "path"),
    "email": ("person", "since", "path"),
    "imessage": ("person", "since", "path"),
    "whatsapp": ("person", "since", "path"),
    "network": ("path",),
    "agent_network": ("path", "role"),
    "agent_trajectories": ("path", "since", "until", "role", "surface", "record_kind"),
    "transactions": (
        "path",
        "since",
        "until",
        "account",
        "min_amount",
        "max_amount",
        "status",
        "include_pending_in_totals",
    ),
    "documents": ("document_source", "since", "until", "path", "tag"),
    "calendar": ("since", "until", "path"),
    "drive": ("since", "until", "path"),
}

# Top-level shorthands that apply like flat filter keys.
BROADCAST_GREP_PARAMS = ("person", "since", "until")
