"""Error handling utilities for unwrapping Temporal error wrappers."""

from typing import Any

from pydantic import ValidationError


def _safe_error_text(e: BaseException) -> str:
    """Return a compact error string without recursively rendering huge inputs."""
    if isinstance(e, ValidationError):
        details: list[str] = []
        for item in e.errors(include_input=False, include_url=False)[:5]:
            loc = ".".join(str(part) for part in item.get("loc", ()))
            msg = item.get("msg") or item.get("type") or "validation error"
            details.append(f"{loc}: {msg}" if loc else str(msg))
        suffix = ""
        remaining = e.error_count() - len(details)
        if remaining > 0:
            suffix = f"; ... {remaining} more"
        return f"{e.error_count()} validation error(s): " + "; ".join(details) + suffix

    try:
        msg = str(e)
    except Exception:
        msg = ""
    if len(msg) > 2000:
        return msg[:2000] + "... [truncated]"
    return msg


def _next_cause(e: BaseException) -> Any:
    cause = getattr(e, "cause", None)
    if cause is not None:
        return cause
    return getattr(e, "__cause__", None)


def error_chain_has_type(e: BaseException, error_type: str) -> bool:
    """Return whether a wrapped exception chain contains an application error type."""
    current: Any = e
    seen: set[int] = set()

    while isinstance(current, BaseException) and id(current) not in seen:
        seen.add(id(current))
        if type(current).__name__ == error_type or getattr(current, "type", None) == error_type:
            return True
        current = _next_cause(current)

    return False


def extract_error_message(e: Exception) -> str:
    """
    Extract the actual error message from an exception, unwrapping Temporal wrappers.

    Temporal wraps activity failures in ActivityError/ApplicationError which have
    generic messages like "Activity task failed". The real error is in .cause.
    """
    current = e
    messages = []
    seen: set[int] = set()

    while current is not None and id(current) not in seen:
        seen.add(id(current))
        msg = _safe_error_text(current)
        if msg and msg not in ("Activity task failed", ""):
            messages.append(msg)

        current = _next_cause(current)

    if messages:
        return messages[-1] if len(messages) > 1 else messages[0]
    return _safe_error_text(e) or "Unknown error"
