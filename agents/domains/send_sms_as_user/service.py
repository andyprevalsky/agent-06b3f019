"""Send SMS as user domain service - phone formatting and business logic."""

from __future__ import annotations

import re

from .config import MESSAGE_DISPLAY_MAX_LENGTH, MESSAGE_PREVIEW_MAX_LENGTH


def format_phone_number(number: str) -> str:
    """Format phone number for display as +1 (972) 977-7432."""
    digits = re.sub(r"[^\d]", "", number)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    match = re.fullmatch(r"(\d{3})(\d{3})(\d{4})", digits)
    if match:
        area, prefix, line = match.groups()
        return f"+1 ({area}) {prefix}-{line}"
    return number


def normalize_to_e164(number: str) -> str:
    """Normalize phone number to E.164 format (+19729777432)."""
    digits = re.sub(r"[^\d]", "", number)
    # Handle 10-digit US numbers
    if len(digits) == 10:
        return f"+1{digits}"
    # Handle 11-digit numbers starting with 1
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    # Already has country code or international
    return f"+{digits}"


def build_approval_question(phone_number: str, message: str, system_name: str) -> str:
    """Build approval question showing recipient and message preview."""
    formatted_phone = format_phone_number(phone_number)
    message_preview = (
        message if len(message) <= MESSAGE_PREVIEW_MAX_LENGTH else message[: MESSAGE_PREVIEW_MAX_LENGTH - 3] + "..."
    )

    return f"""{system_name} wants to send an **iMessage** from your phone

**To:** {formatted_phone}

**Message:**
{message_preview}

Reply to approve, or say "no" to cancel."""


def build_queue_display_message(phone_number: str, message: str) -> tuple[str, str]:
    """Build display strings for the queue status event.

    Returns:
        Tuple of (formatted_phone, display_message).
    """
    formatted_phone = format_phone_number(phone_number)
    display_message = (
        message if len(message) <= MESSAGE_DISPLAY_MAX_LENGTH else message[: MESSAGE_DISPLAY_MAX_LENGTH - 3] + "..."
    )
    return formatted_phone, display_message
