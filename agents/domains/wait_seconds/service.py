"""Wait-seconds domain service — business logic for wait/sleep operations."""

from __future__ import annotations

from domains.wait_seconds.config import (
    MAX_WAIT,
    MIN_WAIT,
    SECONDS_PER_DAY,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
)


def format_duration(seconds: int) -> str:
    """Format seconds into a human-readable duration string.

    Examples: "5 seconds", "2 minutes", "3 hours", "1 day"
    """
    if seconds < SECONDS_PER_MINUTE:
        return f"{seconds} second{'s' if seconds != 1 else ''}"

    if seconds < SECONDS_PER_HOUR:
        minutes = seconds / SECONDS_PER_MINUTE
        if minutes == int(minutes):
            minutes = int(minutes)
            return f"{minutes} minute{'s' if minutes != 1 else ''}"
        return f"{minutes:.1f} minutes"

    if seconds < SECONDS_PER_DAY:
        hours = seconds / SECONDS_PER_HOUR
        if hours == int(hours):
            hours = int(hours)
            return f"{hours} hour{'s' if hours != 1 else ''}"
        return f"{hours:.1f} hours"

    days = seconds / SECONDS_PER_DAY
    if days == int(days):
        days = int(days)
        return f"{days} day{'s' if days != 1 else ''}"
    return f"{days:.1f} days"


def validate_seconds(seconds: int) -> str | None:
    """Validate wait duration and return an error message, or ``None`` if valid."""
    if seconds < MIN_WAIT or seconds > MAX_WAIT:
        return (
            f"Wait duration must be between {format_duration(MIN_WAIT)} and {format_duration(MAX_WAIT)} "
            f"(got {seconds} seconds)"
        )
    return None
