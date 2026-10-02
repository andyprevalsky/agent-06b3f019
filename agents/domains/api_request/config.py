"""api_request domain configuration.

The ROSE_DISABLE_API_REQUEST kill-switch lives in utils.kill_switches because
tool schemas and prompts read it too.
"""

from __future__ import annotations

API_REQUEST_HTTP_TIMEOUT = 130.0
LOG_URL_MAX_LENGTH = 120
