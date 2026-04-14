"""Read-message-history domain configuration.

Constants and defaults.
Imports: own types only.
"""

# Tool identity
TOOL_NAME = "read_message_history_with_person"

# Activity defaults
DEFAULT_MESSAGE_LIMIT = 50
ACTIVITY_TIMEOUT_SECONDS = 30
MAX_RETRY_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10

# Backend API path
MESSAGES_API_PATH = "/api/people/messages"
