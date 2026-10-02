"""Activity heartbeats that keep an activity's resume state on every beat.

Each heartbeat replaces the details a retried attempt reads from
``activity.info().heartbeat_details``. One detail-less heartbeat from any
helper the activity calls (an LLM stream, a token fetch) would otherwise erase
the state the retry needs to resume.
"""

from __future__ import annotations

import contextlib
from contextvars import ContextVar
from typing import Any, Iterator

from temporalio import activity

_resume_details: ContextVar[tuple[Any, ...]] = ContextVar("activity_resume_details", default=())


@contextlib.contextmanager
def heartbeat_resume_details(*details: Any) -> Iterator[None]:
    """Send ``details`` with every heartbeat from this context that carries none of its own.

    Tasks created inside the block inherit the details, so mutating a detail
    object updates what later heartbeats send.
    """
    token = _resume_details.set(details)
    try:
        yield
    finally:
        _resume_details.reset(token)


def safe_heartbeat(message: str, *details: Any) -> None:
    """Heartbeat when running inside an activity; a no-op anywhere else."""
    with contextlib.suppress(Exception):
        activity.heartbeat(message, *(details or _resume_details.get()))
