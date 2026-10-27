"""Runtime layer for the message-person domain.

Thin ToolManager that orchestrates activities via Temporal workflow calls.
"""

from __future__ import annotations

from helpers.wmh_activity_policy import wmh_activity_timeout_options
from datetime import timedelta
from typing import Any, AsyncGenerator

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.message_person.service import (
    build_agent_sms_idempotency_key,
    build_cold_outreach_person,
    build_conversation_summary,
    build_message_approval_question,
    classify_person_id,
    extract_user_name,
    fetch_recent_messages_activity,
    format_messages_for_context,
    format_person_display,
    generate_message_activity,
    queue_imessage_activity,
    send_agent_sms_activity,
    send_email_activity,
)
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, extract_root_error
from tools.read_message_history import read_message_history_activity
from tools.request_user_approval import UserRejectedError, request_user_approval_direct

logger = structlog.get_logger()


class MessagePersonManager(ToolManager):
    """Unified tool: resolve person -> read history -> generate message -> approve."""

    tool_name = "message_person"
    requires_approval = False  # Approval handled internally after message generation

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        person_id_raw = tool_call.get("person_id", "")
        channel = tool_call.get("channel", "").lower()
        from_email = tool_call.get("from_email", "")
        intent = tool_call.get("intent", "")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id
        model = workflow_instance.model

        # -- Validate inputs --
        validation_error = self._validate_inputs(person_id_raw, channel, from_email, intent)
        if validation_error:
            yield validation_error
            return

        # -- Step 1: Resolve person & read messages --
        id_fields = classify_person_id(person_id_raw)
        person_display = person_id_raw  # fallback until we resolve

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Reading Messages with {person_display}",
            message=f"Looking up **{person_display}** and reading conversation history...",
            status=MessageStatus.IN_PROGRESS,
        )

        history_result = await self._read_history(id_fields, user_id)
        if isinstance(history_result, ToolEvent):
            yield history_result
            return

        # Handle multiple matches
        if history_result.get("multiple_matches"):
            yield self._build_ambiguous_error(history_result, id_fields, person_id_raw)
            return

        # Handle no person found
        person = history_result.get("person")
        if not person:
            cold_email = id_fields.get("email")
            cold_phone = id_fields.get("phone")
            if cold_email or cold_phone:
                person = build_cold_outreach_person(cold_email, cold_phone)
                logger.info(
                    "Cold outreach - no existing contact, using direct identifier",
                    email=cold_email,
                    phone=cold_phone,
                )
            else:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"No person found: {person_display}",
                    message=history_result.get("message", f"No person found matching: {person_display}"),
                    status=MessageStatus.ERROR,
                )
                return

        # We have a resolved person (or synthetic cold contact)
        person_display = format_person_display(person)
        messages = history_result.get("messages", [])
        person_phone = person.get("phoneNumber")
        person_email_addr = person.get("email")

        # -- Channel validation --
        channel_error = self._validate_channel(channel, person_phone, person_email_addr, person_display)
        if channel_error:
            yield channel_error
            return

        # -- Step 1b: Fetch latest messages across contacts for voice/style --
        # Per-call context_gates override workflow-level gates.
        context_gates = tool_call.get("context_gates") or getattr(workflow_instance, "context_gates", None) or {}
        general_messages_context = await self._fetch_voice_context(context_gates, user_id)

        # -- Step 2: Exa enrichment not used here (people_search is an explore-only
        # research tool; message_person does not enrich inline) --
        exa_context = ""

        # -- Step 3: Generate message via LLM --
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Generating Message for {person_display}",
            message=f"Crafting a message for **{person_display}** based on your intent...",
            status=MessageStatus.IN_PROGRESS,
        )

        conversation_context = build_conversation_summary(workflow_instance.context)
        messages_context = format_messages_for_context(messages, limit=100)
        user_context = getattr(workflow_instance, "user_context_section", "") or ""
        user_name = extract_user_name(workflow_instance.system_name, user_context)

        gen_result = await self._generate_message(
            workflow_instance,
            model,
            user_name,
            conversation_context,
            person_display,
            messages_context,
            exa_context,
            intent,
            channel,
            person_email_addr,
            general_messages_context,
            agent_id,
        )
        if isinstance(gen_result, ToolEvent):
            yield gen_result
            return

        generated_message = gen_result.get("message", "")
        generated_subject = gen_result.get("subject")
        gen_usage = gen_result.get("usage", {})

        if not generated_message:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Empty message generated",
                message="The LLM returned an empty message. Please try again with a clearer intent.",
                status=MessageStatus.ERROR,
            )
            return

        # -- Step 4: User approval --
        recipient = person_email_addr if channel == "email" else person_phone
        channel_label = {"imessage": "iMessage", "agent_sms": "Agent SMS", "email": "Email"}[channel]

        approval_error = await self._request_approval(
            workflow_instance,
            channel,
            channel_label,
            person_display,
            recipient,
            from_email,
            generated_subject,
            intent,
            generated_message,
        )
        if approval_error:
            yield approval_error
            return

        # -- Step 5: Deliver --
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"{'Queueing' if channel == 'imessage' else 'Sending'} {channel_label} to {person_display}",
            message=f"Submitting the approved {channel_label} for delivery to **{person_display}**...",
            status=MessageStatus.IN_PROGRESS,
        )

        delivery_result = await self._deliver_message(
            channel=channel,
            user_id=user_id,
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            context=workflow_instance.context,
            person_phone=person_phone,
            person_email=person_email_addr,
            from_email=from_email,
            generated_subject=generated_subject,
            generated_message=generated_message,
            person_display=person_display,
            world_model_mode=getattr(workflow_instance, "world_model_mode", "real"),
            world_model_session_scope_id=(
                getattr(workflow_instance, "root_agent_id", None) or agent_id
            ),
        )
        if isinstance(delivery_result, ToolEvent):
            yield delivery_result
            return

        # -- Done --
        yield self._build_finished_event(
            channel,
            channel_label,
            person_display,
            recipient,
            from_email,
            generated_subject,
            generated_message,
            delivery_result,
            gen_usage,
            model,
        )

    # ── Private helpers ──────────────────────────────────────────────────

    @staticmethod
    def _validate_inputs(
        person_id_raw: str,
        channel: str,
        from_email: str,
        intent: str,
    ) -> ToolEvent | None:
        if not person_id_raw:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Missing person_id",
                message="person_id is required.",
                status=MessageStatus.ERROR,
            )
        if channel not in ("imessage", "agent_sms", "email"):
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Invalid channel",
                message=f"Channel must be 'imessage', 'agent_sms', or 'email', got: '{channel}'",
                status=MessageStatus.ERROR,
            )
        if channel == "email" and not from_email:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Missing from_email",
                message="from_email is required when channel is 'email'. "
                "Specify which connected email address to send from.",
                status=MessageStatus.ERROR,
            )
        if not intent:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Missing intent",
                message="intent is required - describe what the message should accomplish.",
                status=MessageStatus.ERROR,
            )
        return None

    @staticmethod
    def _validate_channel(
        channel: str,
        person_phone: str | None,
        person_email: str | None,
        person_display: str,
    ) -> ToolEvent | None:
        if channel in ("imessage", "agent_sms") and not person_phone:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Cannot send {'iMessage' if channel == 'imessage' else 'Agent SMS'} to {person_display}",
                message=f"No phone number found for {person_display}. Try the email channel instead.",
                status=MessageStatus.ERROR,
            )
        if channel == "email" and not person_email:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Cannot send email to {person_display}",
                message=f"No email address found for {person_display}. Try the imessage channel instead.",
                status=MessageStatus.ERROR,
            )
        return None

    @staticmethod
    def _build_ambiguous_error(
        history_result: dict[str, Any],
        id_fields: dict[str, Any],
        person_id_raw: str,
    ) -> ToolEvent:
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
        return ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Ambiguous: multiple matches for {person_id_raw}",
            message="\n".join(lines),
            status=MessageStatus.ERROR,
        )

    @staticmethod
    async def _read_history(
        id_fields: dict[str, Any],
        user_id: str,
    ) -> dict[str, Any] | ToolEvent:
        try:
            return await workflow.execute_activity(
                read_message_history_activity,
                args=[
                    user_id,
                    id_fields.get("phone"),
                    id_fields.get("email"),
                    id_fields.get("first_name"),
                    id_fields.get("last_name"),
                    100,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )
        except Exception as e:
            error_msg = extract_root_error(e)
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Failed to look up person",
                message=f"Error reading message history: {error_msg}",
                status=MessageStatus.ERROR,
            )

    @staticmethod
    async def _fetch_voice_context(context_gates: dict[str, Any], user_id: str) -> str:
        if not context_gates.get("recent_communications", True):
            return ""
        try:
            general_result = await workflow.execute_activity(
                fetch_recent_messages_activity,
                args=[user_id, 100],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )
            general_messages = general_result.get("messages", [])
            return format_messages_for_context(general_messages, limit=100)
        except Exception as e:
            logger.warning("Failed to fetch general recent messages, continuing without", error=str(e))
            return ""

    @staticmethod
    async def _generate_message(
        workflow_instance: Any,
        model: str,
        user_name: str,
        conversation_context: str,
        person_display: str,
        messages_context: str,
        exa_context: str,
        intent: str,
        channel: str,
        person_email: str | None,
        general_messages_context: str,
        agent_id: str | None = None,
    ) -> dict[str, Any] | ToolEvent:
        try:
            user_id = getattr(workflow_instance, "user_id", None)
            if user_id and hasattr(workflow_instance, "_refresh_compute_token"):
                await workflow_instance._refresh_compute_token(user_id)

            active_claude_token = getattr(workflow_instance, "_active_claude_token", None)
            claude_token = (
                active_claude_token()
                if callable(active_claude_token)
                else getattr(workflow_instance, "claude_max_token", None)
            )
            active_claude_source = getattr(workflow_instance, "_active_claude_source", None)
            claude_token_source = (
                active_claude_source()
                if callable(active_claude_source)
                else getattr(workflow_instance, "claude_max_token_source", None)
            )
            active_claude_pool_id = getattr(workflow_instance, "_active_claude_pool_id", None)
            claude_token_pool_id = (
                active_claude_pool_id()
                if callable(active_claude_pool_id)
                else getattr(workflow_instance, "claude_max_token_pool_id", None)
            )
            active_gpt_token = getattr(workflow_instance, "_active_gpt_token", None)
            gpt_token = (
                active_gpt_token() if callable(active_gpt_token) else getattr(workflow_instance, "gpt_code_token", None)
            )
            active_gpt_account_id = getattr(workflow_instance, "_active_gpt_account_id", None)
            gpt_account_id = (
                active_gpt_account_id()
                if callable(active_gpt_account_id)
                else getattr(workflow_instance, "gpt_code_account_id", None)
            )
            active_gpt_source = getattr(workflow_instance, "_active_gpt_source", None)
            gpt_token_source = (
                active_gpt_source()
                if callable(active_gpt_source)
                else getattr(workflow_instance, "gpt_code_token_source", None)
            )
            active_gpt_pool_id = getattr(workflow_instance, "_active_gpt_pool_id", None)
            gpt_token_pool_id = (
                active_gpt_pool_id()
                if callable(active_gpt_pool_id)
                else getattr(workflow_instance, "gpt_code_token_pool_id", None)
            )

            return await workflow.execute_activity(
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
                    agent_id,
                    claude_token,
                    claude_token_source,
                    claude_token_pool_id,
                    user_id,
                    gpt_token,
                    gpt_account_id,
                    gpt_token_source,
                    gpt_token_pool_id,
                    user_id,
                ],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=15),
                ),
            )
        except Exception as e:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Message generation failed for {person_display}",
                message=f"Error generating message: {e}",
                status=MessageStatus.ERROR,
            )

    @staticmethod
    async def _request_approval(
        workflow_instance: Any,
        channel: str,
        channel_label: str,
        person_display: str,
        recipient: str | None,
        from_email: str,
        generated_subject: str | None,
        intent: str,
        generated_message: str,
    ) -> ToolEvent | None:
        # Plain text only — this question is SMS'd via write_lock notify and
        # iMessage does not render Markdown. Keep the full generated_message.
        approval_text = build_message_approval_question(
            system_name=workflow_instance.system_name,
            channel=channel,
            channel_label=channel_label,
            person_display=person_display,
            recipient=recipient,
            from_email=from_email,
            generated_subject=generated_subject,
            intent=intent,
            generated_message=generated_message,
        )

        try:
            await request_user_approval_direct(
                workflow_instance,
                question=approval_text,
                metadata={"toolApproval": True},
            )
        except UserRejectedError as e:
            rejection_feedback = e.rejection_message
            error_msg = f"User declined to send the message: {generated_message}"
            if rejection_feedback:
                error_msg = (
                    f'User rejected with feedback: "{rejection_feedback}"\n\nDeclined message: {generated_message}'
                )
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Message to {person_display} cancelled",
                message=error_msg,
                status=MessageStatus.ERROR,
            )
        return None

    @staticmethod
    def _agent_sms_terminal_failure(provider_error: str) -> str:
        """Tell the agent and user the safe lifecycle after an unconfirmed send."""
        return (
            "Agent SMS was not confirmed and will not be retried automatically. "
            "Do not call message_person again for this send unless the user explicitly requests a new attempt. "
            f"Provider error: {provider_error}"
        )

    @staticmethod
    def _delivery_error(result: dict[str, Any], default: str) -> str:
        """Return a provider failure safe for typed message activities."""

        for key in ("error", "message"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return default

    @staticmethod
    async def _deliver_message(
        channel: str,
        user_id: str,
        agent_id: str,
        tool_call_id: str,
        context: list[dict[str, Any]],
        person_phone: str | None,
        generated_message: str,
        person_display: str,
        world_model_mode: str = "real",
        world_model_session_scope_id: str | None = None,
        person_email: str | None = None,
        from_email: str = "",
        generated_subject: str | None = None,
    ) -> dict[str, Any] | ToolEvent:
        if channel == "email":
            if not person_email:
                return ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Failed to send Email to {person_display}",
                    message="An email address is required for the email channel.",
                    status=MessageStatus.ERROR,
                )
            if not from_email:
                return ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Failed to send Email to {person_display}",
                    message="from_email is required when channel is 'email'.",
                    status=MessageStatus.ERROR,
                )
            subject = (generated_subject or "").strip() or "Message"
            try:
                activity_args = [
                    user_id,
                    agent_id,
                    tool_call_id,
                    person_email,
                    from_email,
                    subject,
                    generated_message,
                ]
                if world_model_mode != "real":
                    activity_args.extend([world_model_mode, world_model_session_scope_id, True])
                result = await workflow.execute_activity(
                    send_email_activity,
                    args=activity_args,
                    **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=60)),
                    retry_policy=RetryPolicy(maximum_attempts=1),
                )
            except Exception as exc:
                return ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Failed to send Email to {person_display}",
                    message=extract_root_error(exc),
                    status=MessageStatus.ERROR,
                )
            if (
                result.get("success") is not True
                or result.get("status") != "sent"
                or not isinstance(result.get("message_id"), str)
                or not result.get("message_id")
            ):
                return ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Failed to send Email to {person_display}",
                    message=MessagePersonManager._delivery_error(
                        result,
                        "Gmail did not confirm that it accepted the message",
                    ),
                    status=MessageStatus.ERROR,
                )
            return {
                "channel": "email",
                "status": "sent",
                "message_id": result["message_id"],
                "thread_id": result.get("thread_id"),
                "to": result.get("to", person_email),
                "from_email": result.get("from_email", from_email),
                "subject": result.get("subject", subject),
            }

        if not person_phone:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Failed to send message to {person_display}",
                message="A phone number is required for this channel.",
                status=MessageStatus.ERROR,
            )

        if channel == "agent_sms":
            idempotency_key = build_agent_sms_idempotency_key(
                agent_id,
                person_phone,
                context,
            )
            try:
                activity_args = [user_id, agent_id, idempotency_key, person_phone, generated_message]
                if world_model_mode != "real":
                    activity_args.extend([world_model_mode, world_model_session_scope_id, True])
                result = await workflow.execute_activity(
                    send_agent_sms_activity,
                    args=activity_args,
                    **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=45)),
                    retry_policy=RetryPolicy(maximum_attempts=1),
                )
            except Exception as exc:
                return ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Failed to send Agent SMS to {person_display}",
                    message=MessagePersonManager._agent_sms_terminal_failure(extract_root_error(exc)),
                    status=MessageStatus.ERROR,
                )
            if (
                result.get("success") is not True
                or result.get("status") != "sent"
                or not isinstance(result.get("message_id"), str)
                or not result.get("message_id")
            ):
                return ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Failed to send Agent SMS to {person_display}",
                    message=MessagePersonManager._agent_sms_terminal_failure(
                        MessagePersonManager._delivery_error(
                            result,
                            "AgentPhone did not confirm that it accepted the message",
                        )
                    ),
                    status=MessageStatus.ERROR,
                )
            return {
                "channel": "agent_sms",
                "status": "sent",
                "provider": "agentphone",
                "message_id": result["message_id"],
                "provider_channel": result.get("provider_channel"),
                "from_number": result.get("from_number"),
                "to_number": result.get("to_number"),
                "conversation_id": result.get("conversation_id"),
            }

        try:
            activity_args = [user_id, agent_id, tool_call_id, person_phone, generated_message]
            if world_model_mode != "real":
                activity_args.extend([world_model_mode, world_model_session_scope_id, True])
            result = await workflow.execute_activity(
                queue_imessage_activity,
                args=activity_args,
                **wmh_activity_timeout_options(world_model_mode, timedelta(seconds=150)),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )
        except Exception as exc:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Failed to queue iMessage to {person_display}",
                message=extract_root_error(exc),
                status=MessageStatus.ERROR,
            )

        queue_id = result.get("queue_id")
        delivery_status = result.get("status")
        sent_at = result.get("sent_at")
        if result.get("success") is not True or not isinstance(queue_id, str) or not queue_id:
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Failed to send iMessage to {person_display}",
                message=MessagePersonManager._delivery_error(
                    result,
                    "The Mac app did not confirm the iMessage send",
                ),
                status=MessageStatus.ERROR,
            )
        if delivery_status == "sent" and isinstance(sent_at, str) and sent_at:
            return {
                "channel": "imessage",
                "queue_id": queue_id,
                "status": "sent",
                "sent_at": sent_at,
            }
        if delivery_status != "queued":
            return ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Failed to send iMessage to {person_display}",
                message=MessagePersonManager._delivery_error(
                    result,
                    "The iMessage transport returned an invalid state",
                ),
                status=MessageStatus.ERROR,
            )
        return {
            "channel": "imessage",
            "queue_id": queue_id,
            "status": "queued",
            "relay_connected": result.get("relay_connected") is True,
            "relay_last_seen_at": result.get("relay_last_seen_at"),
            "last_transport_status": result.get("last_transport_status", "queued"),
        }

    @staticmethod
    def _build_finished_event(
        channel: str,
        channel_label: str,
        person_display: str,
        recipient: str | None,
        from_email: str,
        generated_subject: str | None,
        generated_message: str,
        delivery_receipt: dict[str, Any],
        gen_usage: dict[str, Any],
        model: str,
    ) -> ToolEvent:
        finished_parts = [f"**To:** {person_display} ({recipient})"]
        if channel == "email":
            finished_parts.append(f"**From:** {from_email}")
            if generated_subject:
                finished_parts.append(f"**Subject:** {generated_subject}")
        finished_parts.append(f"\n**Message:**\n{generated_message}")
        is_queued = channel == "imessage" and delivery_receipt.get("status") == "queued"
        if is_queued:
            finished_parts.append(
                "\n**Delivery status:** Queued. The user's Mac relay is not currently able to confirm "
                "delivery. It will send when that Mac is back online; there is no guarantee when that will be."
            )
        finished_data: dict[str, Any] = {"delivery": delivery_receipt}
        if gen_usage:
            finished_data["usage"] = {
                "llm": [
                    {
                        "tokens_in": gen_usage.get("prompt_tokens", 0),
                        "tokens_out": gen_usage.get("completion_tokens", 0),
                        "model": gen_usage.get("actual_model", model),
                        "provider": "message_person",
                        "cache_read_input_tokens": gen_usage.get("cache_read_input_tokens", 0),
                        "cache_creation_input_tokens": gen_usage.get("cache_creation_input_tokens", 0),
                        # Propagate demo-cache replay so a replayed message_person
                        # call bills $0 instead of its replayed output tokens.
                        "from_fast_cache": gen_usage.get("from_fast_cache", False),
                    }
                ],
            }
        return ToolEvent(
            type=EventType.POST_MESSAGE,
            title=(
                f"{channel_label} queued for {person_display}"
                if is_queued
                else f"{channel_label} sent to {person_display}"
            ),
            message="\n".join(finished_parts),
            status=MessageStatus.FINISHED,
            data=finished_data,
        )


# ── Singleton ────────────────────────────────────────────────────────────

_manager: MessagePersonManager | None = None


def get_manager() -> MessagePersonManager:
    global _manager
    if _manager is None:
        _manager = MessagePersonManager()
    return _manager


# ── Workflow helper (legacy signature) ───────────────────────────────────


async def message_person(
    workflow_instance: Any,
    tool_call: dict[str, Any],
    tool_call_id: str,
) -> str | None:
    """Legacy-signature workflow helper. Receives workflow_instance directly."""
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "message_person")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Track LLM usage piggy-backed on the FINISHED event
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(
                event.data["usage"], tool_name="message_person", call_site="message_person"
            )

    return last_status
