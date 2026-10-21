"""Rose Desktop defaults on for all account ids, mirrored by backend/frontend.

The rollout is a code constant so Temporal workflows remain deterministic.
No project imports: safe in the workflow sandbox.
"""

from __future__ import annotations

from typing import Any

ROSE_DESKTOP_ENABLED_BY_DEFAULT = True

ROSE_DESKTOP_USER_IDS: tuple[str, ...] = (
    "1f85ff25-6e29-4c1b-8739-f917bd101a30",  # Andy
)


def is_rose_desktop_user(user_id: Any) -> bool:
    """True when ``user_id`` is a Rose Desktop account."""
    return (
        isinstance(user_id, str)
        and user_id != ""
        and (ROSE_DESKTOP_ENABLED_BY_DEFAULT or user_id in ROSE_DESKTOP_USER_IDS)
    )


__all__ = ["ROSE_DESKTOP_ENABLED_BY_DEFAULT", "ROSE_DESKTOP_USER_IDS", "is_rose_desktop_user"]
