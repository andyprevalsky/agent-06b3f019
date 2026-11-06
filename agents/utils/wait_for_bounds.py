"""wait_for(agents=...) timeout bounds, shared by the tool schema and the handler.

Codex multi_agents_v2/wait.rs: a timeout above the maximum is rejected; one
below the minimum is clamped up to it (a floor against tight polling loops)
and the result says so.
"""

from typing import Any, Optional, Tuple

WAIT_FOR_AGENTS_MIN_TIMEOUT_SECONDS = 10
WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS = 3600
WAIT_FOR_AGENTS_DEFAULT_TIMEOUT_SECONDS = 600

WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR = (
    f"timeout_seconds must be at most {WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS} (1 hour). "
    "To wait longer, wait once with until_timestamp (up to 31 days): it ends early as soon as one of "
    "your background agents finishes or an agent messages you."
)
WAIT_FOR_AGENTS_TIMEOUT_TYPE_ERROR = "timeout_seconds must be a number of seconds."


def resolve_wait_for_agents_timeout(requested: Any) -> Tuple[int, Optional[str]]:
    """Requested timeout -> (effective seconds, clamp note or None).

    Raises ValueError above the maximum or for a non-number.
    """
    if requested is None:
        return WAIT_FOR_AGENTS_DEFAULT_TIMEOUT_SECONDS, None
    if isinstance(requested, bool) or not isinstance(requested, (int, float)):
        raise ValueError(WAIT_FOR_AGENTS_TIMEOUT_TYPE_ERROR)
    if requested > WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS:
        raise ValueError(WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR)
    if requested < WAIT_FOR_AGENTS_MIN_TIMEOUT_SECONDS:
        shown = int(requested) if float(requested).is_integer() else requested
        return WAIT_FOR_AGENTS_MIN_TIMEOUT_SECONDS, (
            f"Requested timeout of {shown}s was clamped to the minimum of {WAIT_FOR_AGENTS_MIN_TIMEOUT_SECONDS}s."
        )
    return int(requested), None
