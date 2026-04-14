"""Business logic for the call-phone-number domain.

Pure functions for formatting, display, and usage computation.
No I/O, no framework dependencies.
"""

import json
import re
from datetime import datetime
from typing import Any

from domains.call_phone_number.repo import save_phone_call_message as save_phone_call_message

from domains.call_phone_number.config import (
    CALL_PROVIDER,
    COST_CENTS_PER_MINUTE,
    MINIMUM_BILLED_MINUTES,
)


def format_phone_number(number: str) -> str:
    """Format phone number for display as +1 (972) 977-7432 or leave as-is on failure."""
    digits = re.sub(r"[^\d]", "", number)
    # Handle 11-digit numbers (with country code 1)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]  # Strip leading 1
    # Now expect exactly 10 digits
    match = re.fullmatch(r"(\d{3})(\d{3})(\d{4})", digits)
    if match:
        area, prefix, line = match.groups()
        return f"+1 ({area}) {prefix}-{line}"
    return number


def compute_call_cost_cents(duration_seconds: int) -> int:
    """Compute estimated call cost in cents based on duration."""
    duration_minutes = max(MINIMUM_BILLED_MINUTES, duration_seconds / 60)
    return int(duration_minutes * COST_CENTS_PER_MINUTE)


def compute_service_usage(duration_seconds: int) -> list[dict[str, Any]]:
    """Compute phone call service usage costs."""
    return [{"cost_cents": compute_call_cost_cents(duration_seconds), "provider": CALL_PROVIDER}]


def build_completion_message(
    formatted_phone: str,
    duration: int,
    summary: str,
    structured_data: dict[str, Any],
    transcript: str,
) -> str:
    """Build a human-readable completion message for the LLM context."""
    parts = [f"Call to {formatted_phone} completed ({duration}s)."]
    if summary:
        parts.append(f"\n\nSummary: {summary}")
    if structured_data:
        parts.append(f"\n\nExtracted Data:\n{json.dumps(structured_data, indent=2)}")
    if transcript:
        parts.append(f"\n\nTranscript:\n{transcript}")
    return "".join(parts)


def calculate_duration_from_timestamps(started_at_str: str | None, ended_at_str: str | None) -> int:
    """Calculate call duration in seconds from ISO timestamp strings."""
    if not started_at_str or not ended_at_str:
        return 0
    try:
        started_at_dt = datetime.fromisoformat(started_at_str.replace("Z", "+00:00"))
        ended_at_dt = datetime.fromisoformat(ended_at_str.replace("Z", "+00:00"))
        return int((ended_at_dt - started_at_dt).total_seconds())
    except Exception:
        return 0
