"""Data access for the message-person domain.

Activities that perform HTTP calls to the backend or LLM providers.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog
from temporalio import activity

from helpers.tracing import traced

logger = structlog.get_logger()


@activity.defn
@traced("fetch_recent_messages_activity")
async def fetch_recent_messages_activity(
    user_id: str,
    limit: int = 100,
    days: int = 30,
) -> dict[str, Any]:
    """Fetch recent messages across all contacts for a user to understand their writing style.

    Returns: {"messages": [...], "count": int}
    """
    from config import load_config

    activity.heartbeat("Fetching recent messages for voice analysis")
    config = load_config()

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/people/messages/recent",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            params={"limit": limit, "days": days},
        )

        if response.status_code != 200:
            try:
                result = response.json()
                error_msg = result.get("error", f"Backend error ({response.status_code})")
            except Exception:
                error_msg = f"Backend error ({response.status_code}): {response.text[:200]}"
            raise Exception(error_msg)  # noqa: TRY002

        return response.json()


@activity.defn
@traced("generate_message_activity")
async def generate_message_activity(
    model: str,
    system_name: str,
    conversation_context: str,
    person_name: str,
    messages_context: str,
    exa_context: str,
    intent: str,
    channel: str,
    person_email: str | None = None,
    general_messages_context: str = "",
) -> dict[str, Any]:
    """Generate a message for a person using the inherited LLM model.

    Returns: {"message": str, "subject": Optional[str]}
    """
    from helpers.llm import call_llm

    activity.heartbeat(f"Generating message for {person_name}")

    channel_label = "iMessage" if channel == "imessage" else "Email"

    channel_instructions = ""
    if channel == "imessage":
        channel_instructions = (
            "You are writing an iMessage/text message. Keep it casual, conversational, "
            "and relatively brief (1-3 short paragraphs max). Use a warm, natural texting tone. "
            "Do NOT include a subject line."
        )
    else:
        channel_instructions = (
            "You are writing an email. Be professional but personable. "
            "Include a clear, concise subject line. Structure the email with a greeting, body, and sign-off. "
            f"Sign the email as {system_name}."
        )

    system_prompt = f"""You are ghostwriting a message on behalf of the user, {system_name}. This message will be sent
from {system_name}'s personal account - it must sound exactly like {system_name} wrote it themselves.
You are NOT an AI assistant writing a message. You ARE {system_name}, writing to {person_name}.

**Channel:** {channel_label}

{channel_instructions}

VOICE & STYLE RULES:
- Study {system_name}'s previous messages carefully. Mimic their exact writing style: sentence length, vocabulary,
  punctuation habits, capitalization patterns, use of abbreviations, emoji usage (or lack thereof).
- Pay special attention to how {system_name} writes on THIS specific channel ({channel_label}). People write
  differently across channels - texts are usually more casual than emails. Match the channel-specific style.
- Study how {system_name} specifically communicates with {person_name}. The tone, formality, and style may differ
  from how they write to other people. Match the relationship dynamic.
- If previous messages exist, the generated message should be indistinguishable from {system_name}'s real messages.

CONTENT RULES:
- Write ONLY the message content (and subject if email). No meta-commentary.
- Be authentic and genuine - this message is sent from {system_name}'s personal account, not from an AI.
- CRITICAL: NEVER use em dashes ("\u2014") anywhere in the message. This is a strict, non-negotiable rule. Always use regular hyphens (-) or commas instead.
- Reference specific shared context when relevant (previous conversations, mutual interests).
- Do NOT include placeholder text like [your name] or [company].
- Sign the message as {system_name}, not as an AI assistant or agent name.
"""  # noqa: RUF001

    user_prompt = f"""## Channel
{channel_label}

## Intent
{intent}

## Previous Messages with {person_name}
{messages_context}

## {system_name}'s Recent Messages (all contacts)
Use these to understand {system_name}'s general writing voice, tone, and habits across conversations.
{general_messages_context if general_messages_context else "No recent messages available."}

## Research about {person_name}
{exa_context if exa_context else "No additional research available."}

## Recent Conversation Context
{conversation_context}

---

Now write the message as {system_name}. {"Include a subject line on the first line prefixed with 'Subject: ' followed by the message body." if channel == "email" else "Write only the message text."}"""

    result = await call_llm(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model=model,
        temperature=0.7,
        max_tokens=1024,
        call_site="message_person",
    )

    content = result.get("content", "").strip()
    usage = result.get("usage", {})

    # Parse subject from email response
    subject = None
    message_body = content
    if channel == "email" and content.startswith("Subject:"):
        lines = content.split("\n", 1)
        subject = lines[0].replace("Subject:", "").strip()
        message_body = lines[1].strip() if len(lines) > 1 else ""

    return {"message": message_body, "subject": subject, "usage": usage}
