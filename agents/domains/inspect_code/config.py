"""Inspect-code domain config."""

from __future__ import annotations

# The backend restores a checkpoint (re-fetching the repo) and runs the CLI for
# up to CODE_INSPECT_CLI_TIMEOUT_S (480 s); this bounds the whole HTTP call.
INSPECT_HTTP_TIMEOUT_SECONDS: int = 14 * 60
# Activity attempt bound, just past the HTTP bound.
INSPECT_ACTIVITY_TIMEOUT_SECONDS: int = INSPECT_HTTP_TIMEOUT_SECONDS + 30
# A second attempt only follows a connection failure: the inspection never ran.
INSPECT_ACTIVITY_MAX_ATTEMPTS: int = 2

MAX_QUESTION_CHARS: int = 8000
