"""add-memory domain config — constants, defaults, env reads."""

import os

# SuperMemory API
SUPERMEMORY_API_URL = "https://api.supermemory.ai/v3/documents"
SUPERMEMORY_TIMEOUT_SECONDS = 30.0

# Display
DISPLAY_CONTENT_MAX_LENGTH = 100
DISPLAY_CONTENT_TRUNCATION_LENGTH = 97

# Activity retry
ACTIVITY_TIMEOUT_SECONDS = 30
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10


def get_supermemory_api_key() -> str:
    """Read SUPERMEMORY_API_KEY from the environment.

    Raises:
        ValueError: If the key is not configured.
    """
    api_key = os.getenv("SUPERMEMORY_API_KEY", "")
    if not api_key:
        raise ValueError("SUPERMEMORY_API_KEY not configured")
    return api_key
