"""Business logic for the call-phone-number domain.

Pure functions for formatting, display, and usage computation.
No I/O, no framework dependencies.
"""

import json
import re
from datetime import datetime
from typing import Any

from domains.call_phone_number.config import (
    ACTIVE_POLL_INTERVAL_SECONDS,
    CALL_HOLD_PROVIDER,
    CALL_PROVIDER,
    COST_CENTS_PER_MINUTE,
    HOLD_COST_CENTS_PER_MINUTE,
    INITIAL_POLL_INTERVAL_SECONDS,
    LONG_HOLD_POLL_AFTER_POLLS,
    LONG_HOLD_POLL_INTERVAL_SECONDS,
    MAX_POLL_ATTEMPTS,
    MINIMUM_BILLED_MINUTES,
)
from domains.call_phone_number.repo import save_phone_call_message as save_phone_call_message


def poll_interval_seconds(polls: int, *, call_started: bool) -> int:
    """Return the next sleep before another Vapi status fetch.

    Short calls keep the 5s in-progress cadence. Long holds back off so the
    worker is not parsing a growing artifact every few seconds.
    """
    if not call_started:
        return INITIAL_POLL_INTERVAL_SECONDS
    if polls >= LONG_HOLD_POLL_AFTER_POLLS:
        return LONG_HOLD_POLL_INTERVAL_SECONDS
    return ACTIVE_POLL_INTERVAL_SECONDS


def max_poll_coverage_seconds() -> int:
    """Lower-bound wall time the poll loop can stay on a live call."""
    early = min(LONG_HOLD_POLL_AFTER_POLLS, MAX_POLL_ATTEMPTS)
    late = max(0, MAX_POLL_ATTEMPTS - early)
    return early * ACTIVE_POLL_INTERVAL_SECONDS + late * LONG_HOLD_POLL_INTERVAL_SECONDS


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


def compute_service_usage(duration_seconds: int, hold_seconds: int = 0) -> list[dict[str, Any]]:
    """Compute phone call service usage costs; parked hold time bills at the hold-line rate."""
    hold_seconds = max(0, min(hold_seconds, duration_seconds))
    usage = [{"cost_cents": compute_call_cost_cents(duration_seconds - hold_seconds), "provider": CALL_PROVIDER}]
    if hold_seconds > 0:
        usage.append(
            {"cost_cents": int(hold_seconds / 60 * HOLD_COST_CENTS_PER_MINUTE), "provider": CALL_HOLD_PROVIDER}
        )
    return usage


def format_hold_duration(seconds: int) -> str:
    """Format a hold as '2h 30m', '4m 5s', or '40s'."""
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def phone_hold_info(poll_result: dict[str, Any]) -> dict[str, Any]:
    """The backend's `phoneHold` block for hold-capable calls ({} for plain Vapi calls)."""
    hold = poll_result.get("phoneHold")
    return hold if isinstance(hold, dict) else {}


def live_call_update(
    poll_result: dict[str, Any],
    *,
    last_hold_state: str | None,
    last_listen_url: str | None,
    formatted_phone: str,
    call_id: str,
) -> dict[str, Any] | None:
    """Phone-card metadata to post when a live call goes on or off hold, else None.

    connected ──wait_for_human──▶ on_hold ──live person──▶ reconnecting ──▶ connected
    (in-progress, listenUrl)      (on-hold card)                      (in-progress, new listenUrl)
    """
    hold = phone_hold_info(poll_result)
    state = hold.get("state")
    base = {"to": formatted_phone, "callId": call_id, "startedAt": poll_result.get("startedAt")}
    if state == "on_hold":
        if last_hold_state == "on_hold":
            return None
        holds = hold.get("holds") if isinstance(hold.get("holds"), list) else []
        current = holds[-1] if holds and isinstance(holds[-1], dict) else {}
        return {**base, "status": "on-hold", "holdStartedAt": current.get("startedAt")}
    if poll_result.get("status") != "in-progress" or state not in (None, "connected"):
        return None
    monitor = poll_result.get("monitor") if isinstance(poll_result.get("monitor"), dict) else {}
    listen_url = monitor.get("listenUrl")
    resumed = last_hold_state in ("on_hold", "reconnecting")
    if resumed or (listen_url and listen_url != last_listen_url):
        return {**base, "status": "in-progress", "listenUrl": listen_url}
    return None


def build_completion_message(
    formatted_phone: str,
    duration: int,
    summary: str,
    structured_data: dict[str, Any],
    transcript: str,
    hold_seconds: int = 0,
) -> str:
    """Build a human-readable completion message for the LLM context."""
    hold_note = f", including {format_hold_duration(hold_seconds)} on hold" if hold_seconds > 0 else ""
    parts = [f"Call to {formatted_phone} completed ({duration}s{hold_note})."]
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
