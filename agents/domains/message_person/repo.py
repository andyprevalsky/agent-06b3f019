"""Data access for the message-person domain.

Activities that perform HTTP calls to the backend or LLM providers.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import structlog
from temporalio import activity

from helpers.tracing import traced
from helpers.world_model_runtime import WorldModelToolExecutionAdapter

logger = structlog.get_logger()

IMESSAGE_ACK_POLL_ATTEMPTS = 30
IMESSAGE_ACK_POLL_INTERVAL_SECONDS = 2


@activity.defn
@traced("queue_imessage_activity")
async def queue_imessage_activity(
    user_id: str,
    agent_id: str,
    tool_call_id: str,
    phone_number: str,
    message: str,
    world_model_mode: str | None = None,
    world_model_session_scope_id: str | None = None,
    world_model_write_approved: bool = False,
) -> dict[str, Any]:
    async def real_executor(
        _tool_name: str,
        _tool_args: dict[str, Any],
        _tool_call_id: str,
    ) -> dict[str, Any]:
        return await _queue_imessage_real(user_id, agent_id, tool_call_id, phone_number, message)

    return await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        session_scope_id=world_model_session_scope_id,
        mode=world_model_mode,
    ).execute(
        "message_transport_send",
        {
            "channel": "imessage",
            "user_id": user_id,
            "agent_id": agent_id,
            "phone_number": phone_number,
            "message": message,
            "approval_granted": world_model_write_approved,
        },
        tool_call_id,
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _queue_imessage_real(
    user_id: str,
    agent_id: str,
    tool_call_id: str,
    phone_number: str,
    message: str,
) -> dict[str, Any]:
    """Persist an approved iMessage for delivery by the user's Mac app.

    ``tool_call_id`` is forwarded as the idempotency key because Temporal may
    retry an activity after the backend committed the queue write but before
    the worker received the response.
    """
    from config import load_config

    activity.heartbeat("Queueing approved iMessage")
    config = load_config()
    payload = {
        "user_id": user_id,
        "agent_id": agent_id,
        "idempotency_key": tool_call_id,
        "phone_number": phone_number,
        "message": message,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/imessage/queue",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    try:
        result = response.json()
    except ValueError:
        result = {"error": response.text[:200] or f"Backend error ({response.status_code})"}

    if response.status_code >= 500:
        response.raise_for_status()
    if response.status_code != 200:
        return {
            "success": False,
            "error": result.get("message") or result.get("error") or f"Backend error ({response.status_code})",
        }

    queue_id = result.get("queue_id")
    if result.get("success") is not True or not isinstance(queue_id, str) or not queue_id:
        return {"success": False, "error": "Backend did not return an iMessage queue receipt"}

    if result.get("provider") == "phone_harness":
        return {"success": True, "queue_id": queue_id, "provider": "phone_harness",
                "status": result.get("status"), "browser_task_id": result.get("browser_task_id"),
                "sent_at": result.get("sent_at")}

    relay_connected = result.get("relay_connected") is True
    relay_last_seen_at = result.get("relay_last_seen_at")
    if not relay_connected:
        return {
            "success": True,
            "queue_id": queue_id,
            "status": "queued",
            "relay_connected": False,
            "relay_last_seen_at": relay_last_seen_at if isinstance(relay_last_seen_at, str) else None,
        }

    status_url = f"{config.backend.api_url}/api/imessage/queue/{queue_id}/status"
    status_headers = {
        "X-API-Key": config.backend.api_key or "",
        "X-User-Id": user_id,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        last_transport_status = "queued"
        for poll_attempt in range(IMESSAGE_ACK_POLL_ATTEMPTS):
            activity.heartbeat(f"Waiting for Mac send confirmation for {queue_id}")
            status_response = await client.get(status_url, headers=status_headers)
            if status_response.status_code >= 500:
                status_response.raise_for_status()
            try:
                status_result = status_response.json()
            except ValueError:
                status_result = {"error": status_response.text[:200]}
            if status_response.status_code != 200:
                return {
                    "success": False,
                    "queue_id": queue_id,
                    "error": status_result.get("error") or f"Backend error ({status_response.status_code})",
                }

            delivery_status = status_result.get("status")
            if isinstance(delivery_status, str):
                last_transport_status = delivery_status
            if delivery_status == "sent" and isinstance(status_result.get("sent_at"), str):
                logger.info(
                    "iMessage send confirmed",
                    queue_id=queue_id,
                    agent_id=agent_id,
                    phone=phone_number[:4] + "****",
                )
                return {
                    "success": True,
                    "queue_id": queue_id,
                    "status": "sent",
                    "sent_at": status_result["sent_at"],
                }
            if delivery_status == "failed":
                return {
                    "success": False,
                    "queue_id": queue_id,
                    "error": status_result.get("last_error") or "Mac Messages send failed",
                }
            if delivery_status == "expired":
                return {
                    "success": False,
                    "queue_id": queue_id,
                    "error": "The Mac app did not claim the iMessage before its send window expired; it was not sent.",
                }
            if delivery_status == "legacy_dispatched":
                return {
                    "success": False,
                    "queue_id": queue_id,
                    "error": (
                        "The iMessage was handed to an older Mac app that cannot confirm the send. "
                        "Update the Mac app to verify that Messages sent it."
                    ),
                }
            if poll_attempt < IMESSAGE_ACK_POLL_ATTEMPTS - 1:
                await asyncio.sleep(IMESSAGE_ACK_POLL_INTERVAL_SECONDS)

    return {
        "success": True,
        "queue_id": queue_id,
        "status": "queued",
        "relay_connected": True,
        "relay_last_seen_at": relay_last_seen_at if isinstance(relay_last_seen_at, str) else None,
        "last_transport_status": last_transport_status,
    }


@activity.defn
@traced("send_agent_sms_activity")
async def send_agent_sms_activity(
    user_id: str,
    agent_id: str,
    tool_call_id: str,
    phone_number: str,
    message: str,
    world_model_mode: str | None = None,
    world_model_session_scope_id: str | None = None,
    world_model_write_approved: bool = False,
) -> dict[str, Any]:
    async def real_executor(
        _tool_name: str,
        _tool_args: dict[str, Any],
        _tool_call_id: str,
    ) -> dict[str, Any]:
        return await _send_agent_sms_real(user_id, agent_id, tool_call_id, phone_number, message)

    return await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        session_scope_id=world_model_session_scope_id,
        mode=world_model_mode,
    ).execute(
        "message_transport_send",
        {
            "channel": "agent_sms",
            "user_id": user_id,
            "agent_id": agent_id,
            "phone_number": phone_number,
            "message": message,
            "approval_granted": world_model_write_approved,
        },
        tool_call_id,
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _send_agent_sms_real(
    user_id: str,
    agent_id: str,
    tool_call_id: str,
    phone_number: str,
    message: str,
) -> dict[str, Any]:
    """Send once through the agent-owned AgentPhone number; never enqueue."""
    from config import load_config

    activity.heartbeat("Sending approved Agent SMS")
    config = load_config()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/agentphone/messages/send",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json={
                "user_id": user_id,
                "agent_id": agent_id,
                "idempotency_key": tool_call_id,
                "phone_number": phone_number,
                "message": message,
            },
        )

    try:
        result = response.json()
    except ValueError:
        result = {"error": response.text[:200] or f"Backend error ({response.status_code})"}
    if response.status_code != 200:
        return {
            "success": False,
            "error": result.get("error") or f"Backend error ({response.status_code})",
        }
    if (
        result.get("success") is not True
        or result.get("status") != "sent"
        or not isinstance(result.get("message_id"), str)
    ):
        return {"success": False, "error": "AgentPhone did not return a sent message receipt"}
    return result


@activity.defn
@traced("send_email_activity")
async def send_email_activity(
    user_id: str,
    agent_id: str,
    tool_call_id: str,
    to_email: str,
    from_email: str,
    subject: str,
    body: str,
    world_model_mode: str | None = None,
    world_model_session_scope_id: str | None = None,
    world_model_write_approved: bool = False,
) -> dict[str, Any]:
    """Send an approved email through the user's connected Gmail account."""

    async def real_executor(
        _tool_name: str,
        _tool_args: dict[str, Any],
        _tool_call_id: str,
    ) -> dict[str, Any]:
        return await _send_email_real(
            user_id,
            agent_id,
            tool_call_id,
            to_email,
            from_email,
            subject,
            body,
        )

    return await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        session_scope_id=world_model_session_scope_id,
        mode=world_model_mode,
    ).execute(
        "message_transport_send",
        {
            "channel": "email",
            "user_id": user_id,
            "agent_id": agent_id,
            "to_email": to_email,
            "from_email": from_email,
            "subject": subject,
            "message": body,
            "approval_granted": world_model_write_approved,
        },
        tool_call_id,
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _send_email_real(
    user_id: str,
    agent_id: str,
    tool_call_id: str,
    to_email: str,
    from_email: str,
    subject: str,
    body: str,
) -> dict[str, Any]:
    """POST /api/integrations/email/send with Temporal-safe idempotency."""
    from config import load_config

    activity.heartbeat(f"Sending approved email to {to_email[:40]}")
    config = load_config()
    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/integrations/email/send",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json={
                "user_id": user_id,
                "agent_id": agent_id,
                "idempotency_key": tool_call_id,
                "to": to_email,
                "from_email": from_email,
                "subject": subject,
                "body": body,
            },
        )

    try:
        result = response.json()
    except ValueError:
        result = {"error": response.text[:200] or f"Backend error ({response.status_code})"}

    if response.status_code != 200:
        return {
            "success": False,
            "error": result.get("message") or result.get("error") or f"Backend error ({response.status_code})",
        }

    message_id = result.get("messageId")
    if result.get("success") is not True or not isinstance(message_id, str) or not message_id:
        return {"success": False, "error": "Gmail did not return a sent message receipt"}

    return {
        "success": True,
        "status": "sent",
        "channel": "email",
        "message_id": message_id,
        "thread_id": result.get("threadId") if isinstance(result.get("threadId"), str) else None,
        "to": to_email,
        "from_email": from_email,
        "subject": subject,
    }


@activity.defn
@traced("fetch_recent_messages_activity")
async def fetch_recent_messages_activity(
    user_id: str,
    limit: int = 100,
    days: int | None = None,
) -> dict[str, Any]:
    """Fetch the latest messages across all contacts without an age cutoff by default.

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
            params={"limit": limit, **({"days": days} if days is not None else {})},
        )

        if response.status_code != 200:
            try:
                result = response.json()
                error_msg = result.get("error", f"Backend error ({response.status_code})")
            except Exception:
                error_msg = f"Backend error ({response.status_code}): {response.text[:200]}"
            raise RuntimeError(error_msg)

        data = response.json()

        messages = data.get("messages", []) or []
        return {
            "messages": messages,
            "count": len(messages),
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

    channel_label = {"imessage": "iMessage", "agent_sms": "Agent SMS", "email": "Email"}.get(channel, channel)

    # Prompt is structured into FOUR tiers, each with its own cache breakpoint:
    #
    #   1. static_prefix  - identity + voice/content rules. ZERO interpolation,
    #      so byte-identical across every message_person call from any user.
    #      Globally cacheable.
    #   2. dynamic_persona - the per-user persona ("You ARE {system_name}") and
    #      per-user content rules. Lives BELOW SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    #      so it does not contaminate the global static prefix. Cacheable
    #      per-user via the second cache breakpoint.
    #   3. voice_system   - `general_messages_context`, the user's latest
    #      messages across all contacts (~30k tokens). Each formatted message
    #      includes its timestamp so the model can judge recency.
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

    if channel in ("imessage", "agent_sms"):
        channel_instructions = (
            f"You are writing a {'message from the agent phone' if channel == 'agent_sms' else 'personal iMessage'}. "
            "Keep it casual, conversational, "
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
    # 4096 (not 1024): short emails were still truncated mid-sentence when the
    # model spent output budget on preamble/reasoning under the old 1024 cap
    # (incident eab955b6 — approval SMS ended at "Please share the"). call_llm
    # also escalates once on finish_reason=length; this floor keeps the common
    # path from needing that retry.
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
        max_tokens=4096,
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
    finish_reason = result.get("finish_reason") or usage.get("finish_reason")
    if finish_reason == "length":
        # Refuse to ship a truncated draft to approval/SMS. call_llm should have
        # escalated already; if we still see length, fail loudly so the tool
        # retries rather than asking the user to approve an incomplete email.
        raise ValueError(
            "Message generation was truncated at the model output limit. Retry so the approval shows the full draft."
        )

    # Parse subject from email response
    subject = None
    message_body = content
    if channel == "email" and content.startswith("Subject:"):
        lines = content.split("\n", 1)
        subject = lines[0].replace("Subject:", "").strip()
        message_body = lines[1].strip() if len(lines) > 1 else ""

    return {"message": message_body, "subject": subject, "usage": usage}


@activity.defn
async def read_phone_message_activity(user_id: str, agent_id: str, queue_id: str) -> dict[str, Any]:
    from urllib.parse import quote

    from config import load_config
    config = load_config()
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/imessage/queue/{quote(queue_id, safe='')}/status",
            headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": user_id},
        )
    if response.status_code != 200:
        return {"success": False, "error": "Cloud message receipt unavailable"}
    value = response.json()
    return {"success": value.get("success") is True, "queue_id": queue_id,
            "provider": value.get("provider"), "status": value.get("status"),
            "sent_at": value.get("sent_at"), "browser_task_id": value.get("browser_task_id")}
