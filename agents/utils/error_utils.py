"""Error handling utilities for unwrapping Temporal error wrappers."""


def extract_error_message(e: Exception) -> str:
    """
    Extract the actual error message from an exception, unwrapping Temporal wrappers.

    Temporal wraps activity failures in ActivityError/ApplicationError which have
    generic messages like "Activity task failed". The real error is in .cause.
    """
    current = e
    messages = []

    while current is not None:
        msg = str(current)
        if msg and msg not in ("Activity task failed", ""):
            messages.append(msg)

        if hasattr(current, "cause") and current.cause is not None:
            current = current.cause
        elif hasattr(current, "__cause__") and current.__cause__ is not None:
            current = current.__cause__
        else:
            break

    if messages:
        return messages[-1] if len(messages) > 1 else messages[0]
    return str(e) or "Unknown error"
