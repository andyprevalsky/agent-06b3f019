"""Send email domain config - constants and defaults.

No domain-specific configuration needed; shared config (config.load_config)
provides backend URL and API key.
"""

# Display truncation limit for email subject in status messages
DISPLAY_SUBJECT_MAX_LEN = 50

# HTTP timeout for the backend email send endpoint (seconds)
SEND_TIMEOUT_SECONDS = 30.0

# Temporal activity retry settings
ACTIVITY_MAX_ATTEMPTS = 3
ACTIVITY_BACKOFF_COEFFICIENT = 2.0
ACTIVITY_INITIAL_INTERVAL_SECONDS = 1
ACTIVITY_MAX_INTERVAL_SECONDS = 10
ACTIVITY_START_TO_CLOSE_TIMEOUT_SECONDS = 30
