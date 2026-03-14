"""Unified message_person tool - resolve person, read history, enrich, generate, approve, send."""

import re
from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow, activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import time
import json
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, extract_root_error
from tools.request_user_approval import request_user_approval_direct, UserRejectedError

logger = structlog.get_logger()


def _safe_time() -> float:
    try:
        return time.time()
    except Exception:
        return 0.0


def _classify_person_id(person_id: str) -> dict:
    """Classify person_id as phone, email, or name.

    Returns dict with exactly one key set:
      {"phone": "+19725551234"} or {"email": "a@b.com"} or {"first_name": "John", "last_name": "Smith"}
    """
    pid = person_id.strip()

    # Phone: digits with optional +, spaces, dashes, parens - at least 7 digits
    if re.match(r'^[\+\d\s\-()]+$', pid) and sum(c.isdigit() for c in pid) >= 7:
        # Normalise to E.164
        digits = re.sub(r'[^\d]', '', pid)
        if len(digits) == 10:
            digits = '1' + digits
        return {"phone": f"+{digits}"}

    # Email: contains @
    if '@' in pid and '.' in pid.split('@')[-1]:
        return {"email": pid.lower().strip()}

    # Name: must be at least first + last
    parts = pid.strip().split()
    if len(parts) >= 2:
        return {"first_name": parts[0], "last_name": " ".join(parts[1:])}

    # Fallback: treat as name with empty last
    return {"first_name": pid, "last_name": ""}


def _format_messages_for_context(messages: list, limit: int = 100) -> str:
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
        lines.append(f"[{channel}] {ts} | {from_addr} → {to_addr}: {content}")
    return "\n".join(lines)


def _format_person_display(person: dict) -> str:
    """Build a display name from person dict."""
    first = person.get("firstName", "")
    last = person.get("lastName", "")
    name = f"{first} {last}".strip()
    return name or person.get("email") or person.get("phoneNumber") or "Unknown"


class MessagePersonManager(ToolManager):
    """Unified tool: resolve person → read history → enrich → generate message → approve → send."""

    tool_name = "message_person"
    requires_approval = False  # Approval handled internally after message generation

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        person_id_raw = tool_call.get("person_id", "")
        channel = tool_call.get("channel", "").lower()
        from_email = tool_call.get("from_email", "")
        intent = tool_call.get("intent", "")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id
        model = workflow_instance.model

        # ── Validate inputs ──────────────────────────────────────────────
        if not person_id_raw:
            yield ToolEvent(type=EventType.POST_MESSAGE, title="Missing person_id",
                            message="person_id is required.", status=MessageStatus.ERROR)
            return

        if channel not in ("imessage", "email"):
            yield ToolEvent(type=EventType.POST_MESSAGE, title="Invalid channel",
                            message=f"Channel must be 'imessage' or 'email', got: '{channel}'",
                            status=MessageStatus.ERROR)
            return

        if channel == "email" and not from_email:
            yield ToolEvent(type=EventType.POST_MESSAGE, title="Missing from_email",
                            message="from_email is required when channel is 'email'. "
                            "Specify which connected email address to send from.",
                            status=MessageStatus.ERROR)
            return

        if not intent:
            yield ToolEvent(type=EventType.POST_MESSAGE, title="Missing intent",
                            message="intent is required - describe what the message should accomplish.",
                            status=MessageStatus.ERROR)
            return

        # ── Step 1: Resolve person & read messages ───────────────────────
        id_fields = _classify_person_id(person_id_raw)
        person_display = person_id_raw  # fallback until we resolve

        yield ToolEvent(type=EventType.POST_MESSAGE,
                        title=f"Reading Messages with {person_display}",
                        message=f"Looking up **{person_display}** and reading conversation history...",
                        status=MessageStatus.IN_PROGRESS)

        try:
            history_result = await workflow.execute_activity(
                read_message_history_activity,
                args=[user_id,
                      id_fields.get("phone"),
                      id_fields.get("email"),
                      id_fields.get("first_name"),
                      id_fields.get("last_name"),
                      100],  # message_limit
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3, backoff_coefficient=2.0,
                                         initial_interval=timedelta(seconds=1),
                                         maximum_interval=timedelta(seconds=10)),
            )
        except Exception as e:
            # Unwrap Temporal's ActivityError → ApplicationError to get the real message
            error_msg = extract_root_error(e)
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Failed to look up {person_display}",
                            message=f"Error reading message history: {error_msg}",
                            status=MessageStatus.ERROR)
            return

        # Handle multiple matches
        if history_result.get("multiple_matches"):
            matches = history_result.get("matches", [])
            id_type = "name" if id_fields.get("first_name") else "email" if id_fields.get("email") else "phone"
            lines = [f"Multiple people found with the {id_type}: **{person_id_raw}**\n"]
            for i, m in enumerate(matches, 1):
                name = f"{m.get('firstName', '')} {m.get('lastName', '')}".strip()
                email_str = m.get("email") or "no email"
                phone_str = m.get("phoneNumber") or "no phone"
                msg_count = m.get("messageCount", 0)
                lines.append(f"{i}. **{name}** - {email_str}, {phone_str}, {msg_count} messages")
            lines.append("\nPlease specify using their phone number or email address.")
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Ambiguous: multiple matches for {person_id_raw}",
                            message="\n".join(lines),
                            status=MessageStatus.ERROR)
            return

        # Handle no person found
        person = history_result.get("person")
        if not person:
            # Cold outreach: if person_id is a direct email or phone, create synthetic person
            cold_email = id_fields.get("email")
            cold_phone = id_fields.get("phone")
            if cold_email or cold_phone:
                person = {
                    "firstName": "",
                    "lastName": "",
                    "email": cold_email,
                    "phoneNumber": cold_phone,
                }
                logger.info("Cold outreach - no existing contact, using direct identifier",
                            email=cold_email, phone=cold_phone)
            else:
                yield ToolEvent(type=EventType.POST_MESSAGE,
                                title=f"No person found: {person_display}",
                                message=history_result.get("message", f"No person found matching: {person_display}"),
                                status=MessageStatus.ERROR)
                return

        # We have a resolved person (or synthetic cold contact)
        person_display = _format_person_display(person)
        messages = history_result.get("messages", [])
        person_phone = person.get("phoneNumber")
        person_email = person.get("email")

        # ── Channel validation ───────────────────────────────────────────
        if channel == "imessage" and not person_phone:
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Cannot send iMessage to {person_display}",
                            message=f"No phone number found for {person_display}. Try the email channel instead.",
                            status=MessageStatus.ERROR)
            return

        if channel == "email" and not person_email:
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Cannot send email to {person_display}",
                            message=f"No email address found for {person_display}. Try the imessage channel instead.",
                            status=MessageStatus.ERROR)
            return

        # ── Step 1b: Fetch general recent messages for voice/style ────────
        general_messages_context = ""
        try:
            general_result = await workflow.execute_activity(
                fetch_recent_messages_activity,
                args=[user_id, 100, 30],  # limit=100, days=30
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2, backoff_coefficient=2.0,
                                         initial_interval=timedelta(seconds=1),
                                         maximum_interval=timedelta(seconds=10)),
            )
            general_messages = general_result.get("messages", [])
            general_messages_context = _format_messages_for_context(general_messages, limit=100)
        except Exception as e:
            logger.warning("Failed to fetch general recent messages, continuing without", error=str(e))
            general_messages_context = ""

        # ── Step 2: Exa enrichment (only if we have a name) ─────────────
        exa_context = ""
        has_name = person.get("firstName") and person.get("lastName")
        if has_name:
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Gathering Information about {person_display}",
                            message=f"Researching **{person_display}** online...",
                            status=MessageStatus.IN_PROGRESS)
            try:
                exa_query = f"{person.get('firstName')} {person.get('lastName')}"
                if person.get("company"):
                    exa_query += f" {person.get('company')}"
                exa_result = await workflow.execute_activity(
                    people_search_activity,
                    args=[exa_query, 3],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2, backoff_coefficient=2.0,
                                             initial_interval=timedelta(seconds=1),
                                             maximum_interval=timedelta(seconds=10)),
                )
                exa_context = exa_result.get("answer", "")
            except Exception as e:
                logger.warning("Exa enrichment failed, continuing without it", error=str(e))
                exa_context = ""

        # ── Step 3: Generate message via LLM ─────────────────────────────
        yield ToolEvent(type=EventType.POST_MESSAGE,
                        title=f"Generating Message for {person_display}",
                        message=f"Crafting a message for **{person_display}** based on your intent...",
                        status=MessageStatus.IN_PROGRESS)

        # Build conversation context from workflow
        conversation_context = _build_conversation_summary(workflow_instance.context)
        messages_context = _format_messages_for_context(messages, limit=100)

        # Extract the user's real name from user context (the person sending the message)
        user_name = workflow_instance.system_name  # fallback
        user_context = getattr(workflow_instance, 'user_context_section', '') or ''
        for line in user_context.split('\n'):
            if line.strip().startswith('Name:'):
                extracted = line.strip().replace('Name:', '').strip()
                if extracted:
                    user_name = extracted
                break

        try:
            gen_result = await workflow.execute_activity(
                generate_message_activity,
                args=[
                    model,
                    user_name,
                    conversation_context,
                    person_display,
                    messages_context,
                    exa_context,
                    intent,
                    channel,
                    person_email,
                    general_messages_context,
                ],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2, backoff_coefficient=2.0,
                                         initial_interval=timedelta(seconds=2),
                                         maximum_interval=timedelta(seconds=15)),
            )
        except Exception as e:
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Message generation failed for {person_display}",
                            message=f"Error generating message: {e}",
                            status=MessageStatus.ERROR)
            return

        generated_message = gen_result.get("message", "")
        generated_subject = gen_result.get("subject")

        if not generated_message:
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title="Empty message generated",
                            message="The LLM returned an empty message. Please try again with a clearer intent.",
                            status=MessageStatus.ERROR)
            return

        # ── Step 4: User approval ────────────────────────────────────────
        recipient = person_phone if channel == "imessage" else person_email
        channel_label = "iMessage" if channel == "imessage" else "Email"

        approval_text = f"""{workflow_instance.system_name} wants to send {'an' if channel == 'email' else 'a'} **{channel_label}**

**To:** {person_display} ({recipient})"""

        if channel == "email":
            approval_text += f"\n**From:** {from_email}"
            if generated_subject:
                approval_text += f"\n**Subject:** {generated_subject}"

        approval_text += f"""

**Intent:** {intent}

**Message:**
{generated_message}

Reply to approve, or say "no" to cancel."""

        try:
            await request_user_approval_direct(
                workflow_instance,
                question=approval_text,
                metadata={"toolApproval": True},
            )
        except UserRejectedError:
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Message to {person_display} cancelled",
                            message="User declined to send the message.",
                            status=MessageStatus.ERROR)
            return

        # ── Step 5: Send ─────────────────────────────────────────────────
        sending_msg = f"Delivering message to **{person_display}**..."
        if channel == "email":
            sending_msg = f"Delivering email from **{from_email}** to **{person_display}**..."
        yield ToolEvent(type=EventType.POST_MESSAGE,
                        title=f"Sending {channel_label} to {person_display}",
                        message=sending_msg,
                        status=MessageStatus.IN_PROGRESS)

        try:
            if channel == "imessage":
                send_result = await workflow.execute_activity(
                    queue_imessage_activity,
                    args=[user_id, agent_id, person_phone, generated_message],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3, backoff_coefficient=2.0,
                                             initial_interval=timedelta(seconds=1),
                                             maximum_interval=timedelta(seconds=10)),
                )
                if not send_result.get("success"):
                    error_msg = send_result.get("error", "Unknown error")
                    if "imessage" in error_msg.lower() or "mac" in error_msg.lower():
                        error_msg = "iMessage integration is not setup for the current user (Mac app not connected)"
                    yield ToolEvent(type=EventType.POST_MESSAGE,
                                    title=f"Failed to send iMessage to {person_display}",
                                    message=error_msg,
                                    status=MessageStatus.ERROR)
                    return
            else:  # email
                send_result = await workflow.execute_activity(
                    send_email_activity,
                    args=[user_id, person_email, generated_subject or "(no subject)", generated_message, None, from_email],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3, backoff_coefficient=2.0,
                                             initial_interval=timedelta(seconds=1),
                                             maximum_interval=timedelta(seconds=10)),
                )
        except Exception as e:
            error_str = extract_root_error(e)
            if channel == "email" and ("gmail" in error_str.lower() or "not connected" in error_str.lower()):
                error_str = "Email integration is not setup for the current user"
            elif channel == "imessage" and ("imessage" in error_str.lower() or "mac" in error_str.lower()):
                error_str = "iMessage integration is not setup for the current user (Mac app not connected)"
            yield ToolEvent(type=EventType.POST_MESSAGE,
                            title=f"Failed to send {channel_label} to {person_display}",
                            message=error_str,
                            status=MessageStatus.ERROR)
            return

        # ── Done ─────────────────────────────────────────────────────────
        preview = generated_message if len(generated_message) <= 200 else generated_message[:197] + "..."
        finished_parts = [f"**To:** {person_display} ({recipient})"]
        if channel == "email":
            finished_parts.append(f"**From:** {from_email}")
            if generated_subject:
                finished_parts.append(f"**Subject:** {generated_subject}")
        finished_parts.append(f"\n**Message:**\n{preview}")
        yield ToolEvent(type=EventType.POST_MESSAGE,
                        title=f"{channel_label} sent to {person_display}",
                        message="\n".join(finished_parts),
                        status=MessageStatus.FINISHED)


def _build_conversation_summary(context: list) -> str:
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


# ========================================
# SINGLETON
# ========================================

_manager: Optional[MessagePersonManager] = None


def get_manager() -> MessagePersonManager:
    global _manager
    if _manager is None:
        _manager = MessagePersonManager()
    return _manager


# ========================================
# WORKFLOW HELPER (legacy signature)
# ========================================

async def message_person(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str,
):
    """Legacy-signature workflow helper. Receives workflow_instance directly."""
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "message_person")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status

    return last_status


# ========================================
# TEMPORAL ACTIVITIES (imported at workflow level via unsafe.imports_passed_through)
# ========================================

# Re-export activities we use (they live in their own files)
from tools.read_message_history import read_message_history_activity  # noqa: E402
from tools.people_search import people_search_activity  # noqa: E402
from tools.send_sms_as_user import queue_imessage_activity  # noqa: E402
from tools.send_email import send_email_activity  # noqa: E402


@activity.defn
async def fetch_recent_messages_activity(
    user_id: str,
    limit: int = 100,
    days: int = 30,
) -> Dict[str, Any]:
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
            raise Exception(error_msg)

        return response.json()


@activity.defn
async def generate_message_activity(
    model: str,
    system_name: str,
    conversation_context: str,
    person_name: str,
    messages_context: str,
    exa_context: str,
    intent: str,
    channel: str,
    person_email: Optional[str] = None,
    general_messages_context: str = "",
) -> Dict[str, Any]:
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
"""

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
{conversation_context[:8000]}

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
    )

    content = result.get("content", "").strip()

    # Parse subject from email response
    subject = None
    message_body = content
    if channel == "email" and content.startswith("Subject:"):
        lines = content.split("\n", 1)
        subject = lines[0].replace("Subject:", "").strip()
        message_body = lines[1].strip() if len(lines) > 1 else ""

    return {"message": message_body, "subject": subject}
