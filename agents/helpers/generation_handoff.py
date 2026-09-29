"""Pure helpers for cooperative generation handoff decisions."""

from __future__ import annotations

# Same bytes as back-end DEPLOY_INTERRUPTED_TOOL_MESSAGE. An in-tool wait that
# yields for cutover closes the chip with this so the next generation retries.
DEPLOY_INTERRUPTED_TOOL_MESSAGE = "new code version deployed, retry this tool"


class GenerationHandoffRequested(Exception):
    """Raised when an in-tool wait must yield so the workflow can continue_as_new.

    Only raise when no Temporal activity is running. The caller closes the
    in-progress tool chip, returns to run_agent, and the existing top-of-loop
    checkpoint hands off onto the live generation queue.
    """

    def __init__(self, task_queue: str):
        self.task_queue = task_queue
        super().__init__(task_queue)


def should_handoff_to_generation(
    current_task_queue: str | None,
    live_task_queue: str | None,
) -> bool:
    """Return True when this workflow should continue_as_new onto ``live_task_queue``.

    Handoff is required only when both queues are known and differ. Missing
    values fail open (keep running) so a transient pointer read never aborts
    an agent mid-loop.
    """
    current = (current_task_queue or "").strip()
    live = (live_task_queue or "").strip()
    if not current or not live:
        return False
    return current != live


def parse_shutdown_grace_seconds(raw: str | None, default: int = 2100) -> int:
    """Parse ``WORKER_SHUTDOWN_GRACE_PERIOD`` values like ``35m``, ``2100s``, or ``2100``."""
    if raw is None:
        return default
    text = raw.strip().lower()
    if not text:
        return default
    try:
        if text.endswith("ms"):
            return max(1, int(float(text[:-2]) / 1000.0))
        if text.endswith("s"):
            return max(1, int(float(text[:-1])))
        if text.endswith("m"):
            return max(1, int(float(text[:-1]) * 60))
        if text.endswith("h"):
            return max(1, int(float(text[:-1]) * 3600))
        return max(1, int(float(text)))
    except ValueError:
        return default
