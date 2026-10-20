"""User tools domain service - re-exports the activities and pure helpers for the handler."""

from __future__ import annotations

from .config import RUN_ACTIVITY_MARGIN_SECONDS, RUN_ACTIVITY_MAX_ATTEMPTS
from .repo import resolve_user_tools_activity, run_user_tool_activity
from .types import empty_pinned

__all__ = [
    "RUN_ACTIVITY_MARGIN_SECONDS",
    "RUN_ACTIVITY_MAX_ATTEMPTS",
    "empty_pinned",
    "resolve_user_tools_activity",
    "run_user_tool_activity",
    "run_activity_timeout_seconds",
]


def run_activity_timeout_seconds(timeout_s: object) -> int:
    """start_to_close for one handler run: declared timeout + download/validation margin."""
    declared = timeout_s if isinstance(timeout_s, int) and not isinstance(timeout_s, bool) and timeout_s > 0 else 60
    return declared + RUN_ACTIVITY_MARGIN_SECONDS
