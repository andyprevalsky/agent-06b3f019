"""Data access for the message-person domain.

Activities that perform HTTP calls to the backend or LLM providers.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from temporalio import activity

from helpers.tracing import traced

logger = structlog.get_logger()

# Cache-stability bucket for voice-context fetches. Same bucket = byte-identical
# voice-context payload across all message_person calls in the window =
# prompt-prefix cache hit. Rolls forward at the next 15-min boundary; new
# messages arriving inside the window are excluded from voice context until
# the next bucket so the prompt bytes never shift mid-window.
VOICE_CONTEXT_BUCKET_MINUTES = 15


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

        data = response.json()

        # Bucket the cutoff so voice-context bytes stay stable for
        # VOICE_CONTEXT_BUCKET_MINUTES — every call in the same bucket
        # produces the same filtered list, the same formatted text, the
        # same prompt prefix, and a cache-read instead of cache-write.
        now = datetime.now(timezone.utc)
        bucket_minute = (now.minute // VOICE_CONTEXT_BUCKET_MINUTES) * VOICE_CONTEXT_BUCKET_MINUTES
        bucket_now = now.replace(minute=bucket_minute, second=0, microsecond=0)
        bucket_iso = bucket_now.isoformat().replace("+00:00", "Z")

        messages = data.get("messages", []) or []
        filtered = [m for m in messages if (m.get("timestamp") or "") <= bucket_iso]
        return {
            "messages": filtered,
            "count": len(filtered),
            "bucket_at": bucket_iso,
            "bucket_minutes": VOICE_CONTEXT_BUCKET_MINUTES,
        }


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
    agent_id: str | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    claude_token_user_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    gpt_token_user_id: str | None = None,
) -> dict[str, Any]:
    """Generate a message for a person using the inherited LLM model.

    Returns: {"message": str, "subject": Optional[str]}
    """
    from helpers.llm import call_llm
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    from utils.user_facing_writing_prompt import USER_FACING_WRITING_STYLE

    activity.heartbeat(f"Generating message for {person_name}")

    channel_label = "iMessage" if channel == "imessage" else "Email"

    # Prompt is structured into FOUR tiers, each with its own cache breakpoint:
    #
    #   1. static_prefix  - identity + voice/content rules. ZERO interpolation,
    #      so byte-identical across every message_person call from any user.
    #      Globally cacheable.
    #   2. dynamic_persona - the per-user persona ("You ARE {system_name}") and
    #      per-user content rules. Lives BELOW SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    #      so it does not contaminate the global static prefix. Cacheable
    #      per-user via the second cache breakpoint.
    #   3. voice_system   - `general_messages_context`, the user's recent
    #      messages across all contacts (~30k tokens). Per-USER stable
    #      within VOICE_CONTEXT_BUCKET_MINUTES (the fetch activity buckets
    #      its cutoff timestamp). Refreshes once per bucket.
    #   4. user message   - channel + recipient + intent + per-call context.
    #      Per-CALL unique. Not cached.
    #
    # Anthropic / OpenRouter-Anthropic honor `cache_control` on each text
    # block; the breakpoints stack so the longest stable prefix is reused.
    static_prefix = (
        "You are a ghostwriter. You compose a message on behalf of a user "
        "from their personal account, in a voice indistinguishable from how "
        "they write themselves. You are NOT an AI assistant; you produce the "
        "message text only.\n\n"
        f"{USER_FACING_WRITING_STYLE}\n\n"
        "# Voice and Style Rules\n"
        "- Study the user's previous messages carefully. Mimic their exact writing style: "
        "sentence length, vocabulary, punctuation habits, capitalization patterns, use of "
        "abbreviations, emoji usage (or lack thereof).\n"
        "- Pay special attention to how the user writes on the channel they are sending on. "
        "People write differently across channels: texts are usually more casual than emails. "
        "Match the channel-specific style.\n"
        "- Study how the user specifically communicates with the recipient. The tone, formality, "
        "and style may differ from how they write to other people. Match the relationship dynamic.\n"
        "- If previous messages exist, the generated message should be indistinguishable from "
        "the user's real messages.\n\n"
        "# Content Rules\n"
        "- Write ONLY the message content (and subject if email). No meta-commentary.\n"
        "- Be authentic and genuine; this message is sent from the user's personal account, not from an AI.\n"
        "- Reference specific shared context when relevant (previous conversations, mutual interests).\n"
        "- Do NOT include placeholder text like [your name] or [company]."
    )

    persona_dynamic = (
        f"# Persona\n"
        f"You ARE {system_name}. The message will be sent from {system_name}'s personal account, "
        f"so it must sound exactly like {system_name} wrote it. Sign the message as {system_name}, "
        f"not as an AI assistant or agent name."
    )

    static_system = static_prefix + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + persona_dynamic

    voice_system = (
        f"# {system_name}'s Recent Messages (all contacts)\n"
        f"Use these to understand {system_name}'s general writing voice, tone, and habits across conversations.\n"
        f"{general_messages_context if general_messages_context else 'No recent messages available.'}"
    )

    if channel == "imessage":
        channel_instructions = (
            "You are writing an iMessage/text message. Keep it casual, conversational, "
            "and relatively brief (1-3 short paragraphs max). Use a warm, natural texting tone. "
            "Do NOT include a subject line."
        )
        final_instruction = "Write only the message text."
    else:
        channel_instructions = (
            "You are writing an email. Be professional but personable. "
            "Include a clear, concise subject line. Structure the email with a greeting, body, and sign-off. "
            f"Sign the email as {system_name}."
        )
        final_instruction = (
            "Include a subject line on the first line prefixed with 'Subject: ' followed by the message body."
        )

    user_prompt = (
        f"# Channel\n{channel_label}\n\n"
        f"{channel_instructions}\n\n"
        f"# Recipient\n{person_name}\n\n"
        f"# Intent\n{intent}\n\n"
        f"# Previous Messages with {person_name}\n{messages_context}\n\n"
        f"# Research about {person_name}\n"
        f"{exa_context if exa_context else 'No additional research available.'}\n\n"
        f"# Recent Conversation Context\n{conversation_context}\n\n"
        f"Now write the message as {system_name}. {final_instruction}"
    )

    # Multi-block system content: each block carries its own ephemeral
    # cache_control so the longest matching prefix gets a hit. Both Anthropic
    # native (claudeAuth) and OpenRouter-routed Anthropic accept this shape.
    # `transform_messages_for_openai` will idempotently mark the last user
    # message too \u2014 that's the third (and last) breakpoint.
    result = await call_llm(
        messages=[
            {
                "role": "system",
                "content": [
                    {"type": "text", "text": static_system, "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": voice_system, "cache_control": {"type": "ephemeral"}},
                ],
            },
            {"role": "user", "content": user_prompt},
        ],
        model=model,
        temperature=0.7,
        max_tokens=1024,
        call_site="message_person",
        agent_id=agent_id,
        claude_token=claude_token,
        claude_token_source=claude_token_source,
        claude_token_pool_id=claude_token_pool_id,
        claude_token_user_id=claude_token_user_id,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        gpt_token_user_id=gpt_token_user_id,
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
