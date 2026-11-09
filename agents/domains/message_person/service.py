"""Business logic for the message-person domain.

Pure functions that classify, format, and transform data.
No I/O, no framework dependencies.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from domains.message_person.repo import (
    fetch_recent_messages_activity as fetch_recent_messages_activity,
)
from domains.message_person.repo import (
    generate_message_activity as generate_message_activity,
)
from domains.message_person.repo import queue_imessage_activity as queue_imessage_activity
from domains.message_person.repo import read_phone_message_activity as read_phone_message_activity
from domains.message_person.repo import send_agent_sms_activity as send_agent_sms_activity
from domains.message_person.repo import send_email_activity as send_email_activity
from domains.message_person.types import PersonIdFields


def build_agent_sms_idempotency_key(
    agent_id: str,
    phone_number: str,
    context: list[dict[str, Any]],
) -> str:
    """Deduplicate model retries while allowing a later explicit user turn."""
    user_turn = "initial"
    for message in reversed(context):
        if str(message.get("role", "")).upper() != "USER":
            continue
        user_turn = str(
            message.get("message_id")
            or message.get("id")
            or message.get("timestamp")
            or message.get("text")
            or message.get("message")
            or "initial"
        )
        break
    digest = hashlib.sha256(f"{agent_id}\0{phone_number}\0{user_turn}".encode()).hexdigest()
    return f"message_person_agent_sms_{digest[:48]}"


def classify_person_id(person_id: str) -> PersonIdFields:
    """Classify person_id as phone, email, or name.

    Returns dict with exactly one key set:
      {"phone": "+19725551234"} or {"email": "a@b.com"} or {"first_name": "John", "last_name": "Smith"}
    """
    pid = person_id.strip()

    # Phone: digits with optional +, spaces, dashes, parens - at least 7 digits
    if re.match(r"^[\+\d\s\-()]+$", pid) and sum(c.isdigit() for c in pid) >= 7:
        # Normalise to E.164
        digits = re.sub(r"[^\d]", "", pid)
        if len(digits) == 10:
            digits = "1" + digits
        return PersonIdFields(phone=f"+{digits}")

    # Email: contains @
    if "@" in pid and "." in pid.split("@")[-1]:
        return PersonIdFields(email=pid.lower().strip())

    # Name: must be at least first + last
    parts = pid.strip().split()
    if len(parts) >= 2:
        return PersonIdFields(first_name=parts[0], last_name=" ".join(parts[1:]))

    # Fallback: treat as name with empty last
    return PersonIdFields(first_name=pid, last_name="")


def format_messages_for_context(messages: list[dict[str, Any]], limit: int = 100) -> str:
    """Format message records into readable text for LLM context."""
    if not messages:
        return "No previous messages."

    lines = []
    for msg in messages[:limit]:
        channel = msg.get("channel", "?")
        from_addr = msg.get("from", "?")
        to_addr = msg.get("to", "?")
        ts = msg.get("timestamp", "")
        content = msg.get("message", "")
        lines.append(f"[{channel}] {ts} | {from_addr} \u2192 {to_addr}: {content}")
    return "\n".join(lines)


def format_person_display(person: dict[str, Any]) -> str:
    """Build a display name from person dict."""
    first = person.get("firstName", "")
    last = person.get("lastName", "")
    name = f"{first} {last}".strip()
    return name or person.get("email") or person.get("phoneNumber") or "Unknown"


def build_conversation_summary(context: list[dict[str, Any]]) -> str:
    """Build a full conversation context string from workflow context messages."""
    if not context:
        return "No conversation history."
    lines = []
    for msg in context:
        role = msg.get("role", "UNKNOWN")
        text = msg.get("text", "")
        if not text:
            continue
        # Truncate very long individual messages
        if len(text) > 2000:
            text = text[:2000] + "...(truncated)"
        lines.append(f"[{role}]: {text}")
    return "\n".join(lines) if lines else "No conversation history."


def extract_user_name(system_name: str, user_context_section: str) -> str:
    """Extract the user's real name from user context, falling back to system_name."""
    for line in user_context_section.split("\n"):
        if line.strip().startswith("Full Name:"):
            extracted = line.strip().removeprefix("Full Name:").strip()
            if extracted:
                return extracted
    return system_name


def build_cold_outreach_person(email: str | None, phone: str | None) -> dict[str, Any]:
    """Create a synthetic person dict for cold outreach (no existing contact)."""
    return {
        "firstName": "",
        "lastName": "",
        "email": email,
        "phoneNumber": phone,
    }


def build_message_approval_question(
    system_name: str,
    channel: str,
    channel_label: str,
    person_display: str,
    recipient: str | None,
    from_email: str,
    generated_subject: str | None,
    intent: str,
    generated_message: str,
) -> str:
    """Format the SMS/FE approval question for a drafted outbound message.

    Plain text only — this string is sent to iMessage/SMS via write_lock notify,
    which does not render Markdown. Never emit `**bold**` markers here.
    The full generated_message must be preserved; callers must not truncate it.
    """
    article = "an" if channel == "email" else "a"
    lines = [
        f"{system_name} wants to send {article} {channel_label}",
        "",
        f"To: {person_display} ({recipient})",
    ]
    if channel == "email":
        lines.append(f"From: {from_email}")
        if generated_subject:
            lines.append(f"Subject: {generated_subject}")
    lines.extend(
        [
            "",
            f"Intent: {intent}",
            "",
            "Message:",
            generated_message,
            "",
            'Reply to approve, or say "no" to cancel.',
        ]
    )
    return "\n".join(lines)
