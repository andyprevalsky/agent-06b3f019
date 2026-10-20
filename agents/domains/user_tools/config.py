"""User tools domain config - limits, executor selection."""

from __future__ import annotations

import os
from typing import Mapping, Optional, Tuple

# Backend HTTP timeout for the active-version + file fetches (seconds).
BACKEND_HTTP_TIMEOUT_SECONDS = 20.0

# Resolve activity (startup): manifest + up to MAX_USER_TOOLS tool.json fetches.
RESOLVE_ACTIVITY_TIMEOUT_SECONDS = 60
RESOLVE_ACTIVITY_MAX_ATTEMPTS = 3

# Run activity: handler timeout + this margin covers download/copy/validation.
RUN_ACTIVITY_MARGIN_SECONDS = 60
# v1 only declares side-effect-free tools, so one transport retry is safe.
RUN_ACTIVITY_MAX_ATTEMPTS = 2

# Worker-disk cache of downloaded handler dirs, keyed by (user, version).
CACHE_DIR_ENV = "USER_TOOLS_CACHE_DIR"

# PATH handed to handler processes. Never the worker's environment.
HANDLER_PATH = "/usr/local/bin:/usr/bin:/bin"

EXECUTOR_ENV = "USER_TOOLS_EXECUTOR"
EXECUTOR_LOCAL = "local"
EXECUTOR_CODE_SESSION = "code_session"


def resolve_executor_mode(env: Optional[Mapping[str, str]] = None) -> Tuple[Optional[str], str]:
    """Return ``(executor, disabled_reason)``.

    - ``USER_TOOLS_EXECUTOR=local``: run handlers as worker subprocesses (prototype path).
    - ``USER_TOOLS_EXECUTOR=code_session``: production path — run inside the user's
      persistent E2B code session (docs/plans/active/rose-user-ui.md). TODO: not
      implemented in v1, so it disables user tools rather than silently running locally.
    - unset: ``local`` off Fly; disabled on Fly (``FLY_APP_NAME`` defined, even empty).
    """
    source = os.environ if env is None else env
    raw = str(source.get(EXECUTOR_ENV) or "").strip().lower()
    if raw == EXECUTOR_LOCAL:
        return EXECUTOR_LOCAL, ""
    if raw == EXECUTOR_CODE_SESSION:
        return None, "USER_TOOLS_EXECUTOR=code_session is not implemented yet (v1 supports local only)"
    if raw in ("off", "disabled", "none", "0", "false"):
        return None, f"user tools disabled by {EXECUTOR_ENV}={raw}"
    if raw:
        return None, f"unknown {EXECUTOR_ENV}={raw!r}"
    if "FLY_APP_NAME" in source:
        return None, f"local user-tool executor is disabled in production unless {EXECUTOR_ENV}=local"
    return EXECUTOR_LOCAL, ""
