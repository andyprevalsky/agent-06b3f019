"""User tools domain config - limits, executor selection."""

from __future__ import annotations

import os
from typing import Mapping, Optional, Tuple

# Backend HTTP timeout for the active-version + file fetches (seconds).
BACKEND_HTTP_TIMEOUT_SECONDS = 20.0

# Resolve activity (startup): manifest + up to MAX_USER_TOOLS tool.json fetches.
RESOLVE_ACTIVITY_TIMEOUT_SECONDS = 60
RESOLVE_ACTIVITY_MAX_ATTEMPTS = 3

# Run activity: handler timeout + this margin covers download/copy/validation
# (local) or session sandbox acquisition (code_session).
RUN_ACTIVITY_MARGIN_SECONDS = 60
# Read-only tools retry freely; side-effecting tools replay their stored run
# record on retry (backend ToolSideEffect claim), so one retry is safe for both.
RUN_ACTIVITY_MAX_ATTEMPTS = 2

# code_session executor: the backend holds POST /api/user-ui/tools/run for the
# handler's own timeout plus this margin (resume/create the session sandbox,
# write handler files). Below RUN_ACTIVITY_MARGIN_SECONDS so the activity's
# start-to-close never cuts a run the backend can still finish.
CODE_SESSION_HTTP_MARGIN_SECONDS = 45
# How long a call waits for one of the user's tool sessions (the backend caps
# them per user) before reporting session_busy. Fits inside the activity
# margin above the HTTP margin.
CODE_SESSION_BUSY_WAIT_SECONDS = 10

# A side-effect claim still STARTED this long after the handler's own timeout
# (plus the HTTP margin) belongs to an attempt that died mid-run: the outcome is
# unknown and the handler is never run again for that call.
CLAIM_STALE_GRACE_SECONDS = 30
# Poll interval while a concurrent duplicate of the same call is running.
CLAIM_POLL_SECONDS = (0.25, 0.5, 1.0, 2.0)
# Inline retries of the record-store call after the handler ran.
COMPLETE_MAX_ATTEMPTS = 3

# Worker-disk cache of downloaded handler dirs, keyed by (user, version).
CACHE_DIR_ENV = "USER_TOOLS_CACHE_DIR"

# PATH handed to handler processes. Never the worker's environment.
HANDLER_PATH = "/usr/local/bin:/usr/bin:/bin"

EXECUTOR_ENV = "USER_TOOLS_EXECUTOR"
EXECUTOR_LOCAL = "local"
EXECUTOR_CODE_SESSION = "code_session"


def resolve_executor_mode(env: Optional[Mapping[str, str]] = None) -> Tuple[Optional[str], str]:
    """Return ``(executor, disabled_reason)``. The selection is explicit:

    - ``USER_TOOLS_EXECUTOR=code_session``: production path. The backend runs the
      handler inside the calling user's own persistent code session sandbox
      (``POST /api/user-ui/tools/run``); nothing user-authored runs on the worker.
    - ``USER_TOOLS_EXECUTOR=local``: run handlers as worker subprocesses (dev).
    - ``off`` / ``disabled`` / ``none`` / ``0`` / ``false``: no user tools.
    - unset: ``local`` off Fly (dev default); disabled on Fly (``FLY_APP_NAME``
      defined, even empty), so production never silently runs user code locally.
    """
    source = os.environ if env is None else env
    raw = str(source.get(EXECUTOR_ENV) or "").strip().lower()
    if raw == EXECUTOR_LOCAL:
        return EXECUTOR_LOCAL, ""
    if raw == EXECUTOR_CODE_SESSION:
        return EXECUTOR_CODE_SESSION, ""
    if raw in ("off", "disabled", "none", "0", "false"):
        return None, f"user tools disabled by {EXECUTOR_ENV}={raw}"
    if raw:
        return None, f"unknown {EXECUTOR_ENV}={raw!r}"
    if "FLY_APP_NAME" in source:
        return None, (
            f"the local user-tool executor is disabled in production; set {EXECUTOR_ENV}={EXECUTOR_CODE_SESSION}"
        )
    return EXECUTOR_LOCAL, ""
