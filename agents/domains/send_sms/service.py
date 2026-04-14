"""Business logic for the send-sms domain.

Pure functions for formatting, display, and usage computation.
No I/O, no framework dependencies.
"""

import re
from typing import Any

from domains.send_sms.repo import send_sms_activity as send_sms_activity

from domains.send_sms.config import (
    MESSAGE_DISPLAY_MAX_LENGTH,
    MESSAGE_DISPLAY_SUFFIX,
    SMS_COST_CENTS,
    SMS_PROVIDER,
)


def format_phone_number(number: str) -> str:
    """Format phone number for display as +1 (972) 977-7432 or leave as-is on failure."""
    match = re.fullmatch(r"\+?1?(\d{3})(\d{3})(\d{4})", re.sub(r"[^\d+]", "", number))
    if match:
        area, prefix, line = match.groups()
        return f"+1 ({area}) {prefix}-{line}"
    return number


def truncate_message(message: str) -> str:
    """Truncate a message for display, adding suffix if needed."""
    if len(message) <= MESSAGE_DISPLAY_MAX_LENGTH:
        return message
    return message[: MESSAGE_DISPLAY_MAX_LENGTH - len(MESSAGE_DISPLAY_SUFFIX)] + MESSAGE_DISPLAY_SUFFIX


def compute_service_usage() -> list[dict[str, Any]]:
    """Compute SMS service usage costs (fixed per-SMS pricing)."""
    return [{"cost_cents": SMS_COST_CENTS, "provider": SMS_PROVIDER}]
