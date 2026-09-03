"""api_request domain configuration."""

from __future__ import annotations

import os
from typing import Final

API_REQUEST_HTTP_TIMEOUT = 130.0
LOG_URL_MAX_LENGTH = 120

# Temporary kill-switch: drop api_request from explore tool injection and
# prompt context so agents take the coding-agent / GitHub-script path instead.
# Values: 1 / true / yes / on
ROSE_DISABLE_API_REQUEST_ENV: Final[str] = "ROSE_DISABLE_API_REQUEST"


def api_request_disabled() -> bool:
    """Return True when api_request must not be injected or mentioned."""
    raw = os.getenv(ROSE_DISABLE_API_REQUEST_ENV, "").strip().lower()
    return raw in {"1", "true", "yes", "on"}
