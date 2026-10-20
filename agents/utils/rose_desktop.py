"""Rose Desktop flag (server-side mirror of ``front-end/src/lib/roseDesktop.ts``).

The new Rose UI (apps, inline user views, pinned questions, the per-user
``rose_user_ui``) is on only for the accounts below. Agent-visible surfaces
that only make sense with that UI are assembled for flagged accounts only, so
a deploy is a no-op for every other account on those surfaces:

    is_rose_desktop_user(user_id)
      ├─ True  → Rose Desktop tool schemas / prompt text / user tools
      └─ False → the stock surfaces (byte-stable per group, so prompt caching holds)

A code-reviewed constant on purpose: workflow code reads it, and Temporal
workflows must be deterministic (an env var could differ between workers).
``back-end/src/tests/structural/rose-desktop-flag-sync.test.ts`` keeps this
list, the backend's ``providers/roseDesktop.ts`` and the front-end list equal.

Pure module: no project imports (utils boundary), safe in the workflow sandbox.
"""

from __future__ import annotations

from typing import Any

ROSE_DESKTOP_USER_IDS: tuple[str, ...] = (
    "1f85ff25-6e29-4c1b-8739-f917bd101a30",  # Andy
)


def is_rose_desktop_user(user_id: Any) -> bool:
    """True when ``user_id`` is a Rose Desktop account."""
    return isinstance(user_id, str) and user_id != "" and user_id in ROSE_DESKTOP_USER_IDS


__all__ = ["ROSE_DESKTOP_USER_IDS", "is_rose_desktop_user"]
