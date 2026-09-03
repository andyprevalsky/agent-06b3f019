"""Business logic for the call-phone-number domain.

Pure functions for formatting, display, and usage computation.
No I/O, no framework dependencies.
"""

import json
import re
from datetime import datetime
from typing import Any

from domains.call_phone_number.config import (
    CALL_PROVIDER,
    COST_CENTS_PER_MINUTE,
    MINIMUM_BILLED_MINUTES,
)
from domains.call_phone_number.repo import save_phone_call_message as save_phone_call_message


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


def _parse_dtmf_keys(arguments: Any) -> str | None:
    """Extract the keypad string from a Vapi dtmf tool-call arguments payload."""
    raw = arguments
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            text = raw.strip()
            return text or None
    if not isinstance(raw, dict):
        return None
    for key in ("keys", "key", "digits", "digit"):
        value = raw.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def format_dtmf_transcript_line(keys: str) -> str:
    """Render a clearly marked DTMF line for human verification.

    Keeps the exact keys payload Vapi sent (including ``w`` pauses and ``#``)
    and, when pauses are present, also shows the digit/# sequence alone.
    """
    compact = re.sub(r"[wW]+", "", keys)
    if compact and compact != keys:
        return f"[DTMF] {compact} (sent: {keys})"
    return f"[DTMF] {keys}"


def extract_dtmf_keypresses(messages: list[Any] | None) -> list[str]:
    """Return ordered DTMF key payloads from Vapi call ``messages``."""
    if not messages:
        return []
    presses: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        tool_calls = message.get("toolCalls") or message.get("tool_calls") or []
        if not isinstance(tool_calls, list):
            continue
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            function = tool_call.get("function") or {}
            if not isinstance(function, dict):
                continue
            if str(function.get("name") or "").lower() != "dtmf":
                continue
            keys = _parse_dtmf_keys(function.get("arguments"))
            if keys:
                presses.append(keys)
    return presses


def enrich_transcript_with_dtmf(
    transcript: str,
    messages: list[Any] | None,
) -> str:
    """Merge speech transcript with clearly marked DTMF keypress lines.

    Vapi's speech ``transcript`` omits keypad tones by design. Outbound DTMF is
    present on the call as ``tool_calls`` named ``dtmf``. When those exist,
    rebuild a chronological transcript from ``messages`` so reviewers can see
    exactly which digits were pressed and when.
    """
    if not messages:
        return transcript

    presses = extract_dtmf_keypresses(messages)
    if not presses:
        return transcript

    lines: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").lower()
        if role in {"bot", "assistant"}:
            text = str(message.get("message") or message.get("content") or "").strip()
            if text:
                lines.append(f"AI: {text}")
            continue
        if role == "user":
            text = str(message.get("message") or message.get("content") or "").strip()
            if text:
                lines.append(f"User: {text}")
            continue
        if role in {"tool_calls", "tool_call"}:
            tool_calls = message.get("toolCalls") or message.get("tool_calls") or []
            if not isinstance(tool_calls, list):
                continue
            for tool_call in tool_calls:
                if not isinstance(tool_call, dict):
                    continue
                function = tool_call.get("function") or {}
                if not isinstance(function, dict):
                    continue
                if str(function.get("name") or "").lower() != "dtmf":
                    continue
                keys = _parse_dtmf_keys(function.get("arguments"))
                if keys:
                    lines.append(format_dtmf_transcript_line(keys))

    if lines:
        return "\n".join(lines)

    # Fallback: keep speech transcript and append a DTMF section.
    marked = [format_dtmf_transcript_line(keys) for keys in presses]
    base = (transcript or "").rstrip()
    block = "DTMF keypresses:\n" + "\n".join(marked)
    return f"{base}\n\n{block}" if base else block


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
