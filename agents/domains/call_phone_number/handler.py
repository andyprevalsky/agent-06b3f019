"""Call-phone-number domain handler — runtime entry point.

Thin orchestration layer: parses tool_call input, calls service/repo functions,
and posts ToolEvents. The Temporal activity is defined here because blackbox
tests patch ``tools.call_phone_number.asyncio.sleep`` and
``tools.call_phone_number.save_phone_call_message`` on the tools shim's namespace
(which re-exports these names from this module).
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import httpx
import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from config import load_config
from domains.call_phone_number.config import (
    ACTIVE_POLL_INTERVAL_SECONDS,
    ACTIVITY_TIMEOUT_MINUTES,
    HEARTBEAT_TIMEOUT_SECONDS,
    HTTP_TIMEOUT_INITIATE,
    HTTP_TIMEOUT_POLL,
    INITIAL_POLL_INTERVAL_SECONDS,
    MAX_POLL_ATTEMPTS,
    MAX_RETRY_ATTEMPTS,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_INTERVAL_SECONDS,
)
from domains.call_phone_number.service import (
    build_completion_message,
    calculate_duration_from_timestamps,
    compute_service_usage,
    format_phone_number,
    save_phone_call_message,
)
from domains.call_phone_number.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from helpers.world_model_runtime import WorldModelToolExecutionAdapter
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, UsageItem, UsageType, extract_root_error

__all__ = [
    "CallPhoneNumberManager",
    "call_phone_number",
    "call_phone_number_activity",
    "save_phone_call_message",
]

logger = structlog.get_logger()


# =============================================================================
# MANAGER
# =============================================================================


class CallPhoneNumberManager(ToolManager):
    """Manager for making outbound phone calls via Vapi API."""

    tool_name = "call_phone_number"
    requires_approval = True

    def get_approval_question(self, tool_call: dict[str, Any]) -> str:
        """Return the approval question for this phone call."""
        to = tool_call.get("to", "unknown")
        system_prompt = tool_call.get("system_prompt", "")
        formatted_phone = format_phone_number(to)
        return f"Make a phone call to {formatted_phone}?\n\nAgent behavior: {system_prompt}"

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: str | None = None,
        world_model_mode: str = "real",
    ) -> dict[str, Any]:
        """Execute phone call and post events via handle_tool_event."""
        to = tool_call.get("to", "")
        system_prompt = tool_call.get("system_prompt", "")
        output_schema = normalize_output_schema(tool_call.get("output_schema", {}))

        formatted_phone = format_phone_number(to)

        # 1. Initial status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\U0001f4de Initiating call",
                message=f"**Calling:** {formatted_phone}",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "phoneCall": {
                        "status": "initiating",
                        "to": formatted_phone,
                    }
                },
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="call_phone_number",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute phone call activity
        try:
            activity_args = [to, system_prompt, output_schema, agent_id, tool_call_id, user_id]
            if world_model_mode != "real":
                activity_args.append(world_model_mode)
            result = await execute_activity(
                call_phone_number_activity,
                args=activity_args,
                start_to_close_timeout=timedelta(minutes=ACTIVITY_TIMEOUT_MINUTES),
                heartbeat_timeout=timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=MAX_RETRY_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            # 3. Report usage based on call duration
            duration_seconds = result.get("duration", 0)
            usage_items = [] if result.get("world_model_simulated") else compute_service_usage(duration_seconds)

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.USAGE,
                    tool_name="call_phone_number",
                    usage_items=[
                        UsageItem(type=UsageType.SERVICE, cost_cents=item["cost_cents"], provider=item["provider"])
                        for item in usage_items
                    ],
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="call_phone_number",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return result

        except Exception as e:
            error_msg = extract_root_error(e)
            logger.error("Call phone number failed", error=error_msg, to=to[:4] + "****")
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="\u274c Call failed",
                    message=f"**To:** {formatted_phone}\n\n**Error:** {error_msg}",
                    status=MessageStatus.ERROR,
                    metadata={
                        "phoneCall": {
                            "status": "error",
                            "to": formatted_phone,
                            "error": error_msg,
                        }
                    },
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="call_phone_number",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            return {"error": error_msg, "to": to}


# =============================================================================
# SINGLETON
# =============================================================================

_manager: CallPhoneNumberManager | None = None


def get_manager() -> CallPhoneNumberManager:
    """Get or create call phone number manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = CallPhoneNumberManager()
    return _manager


# =============================================================================
# TOOL ENTRY POINT
# =============================================================================


async def call_phone_number(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: str | None = None,
    world_model_mode: str = "real",
) -> dict[str, Any]:
    """Execute call_phone_number tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'to', 'system_prompt', 'output_schema'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with structured data extracted from the call
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
        world_model_mode=world_model_mode,
    )


# =============================================================================
# TEMPORAL ACTIVITY
# =============================================================================
# Kept in handler because blackbox tests patch asyncio.sleep and
# save_phone_call_message on the tools shim's namespace (re-exported from here).


@activity.defn
async def call_phone_number_activity(
    to: str,
    system_prompt: str,
    output_schema: dict[str, Any],
    agent_id: str,
    tool_call_id: str,
    user_id: str | None = None,
    world_model_mode: str | None = None,
) -> dict[str, Any]:
    async def real_executor(_tool_name: str, _tool_args: dict[str, Any], _tool_call_id: str) -> dict[str, Any]:
        return await _call_phone_number_activity_real(
            to=to,
            system_prompt=system_prompt,
            output_schema=output_schema,
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            user_id=user_id,
        )

    return await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        mode=world_model_mode,
    ).execute(
        "call_phone_number",
        {
            "to": to,
            "system_prompt": system_prompt,
            "output_schema": output_schema,
            "agent_id": agent_id,
            "user_id": user_id,
        },
        tool_call_id,
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _call_phone_number_activity_real(
    to: str,
    system_prompt: str,
    output_schema: dict[str, Any],
    agent_id: str,
    tool_call_id: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Activity: Initiate phone call via backend API and poll until complete.

    Args:
        to: Phone number in E.164 format (e.g., +19729777432)
        system_prompt: LLM-defined behavior instructions for the voice agent
        output_schema: JSON Schema for structured data extraction
        agent_id: Agent ID for progress updates
        tool_call_id: Tool call ID for progress updates
        user_id: User ID for tracking

    Returns:
        Dict with success, structured_data, duration, ended_reason, transcript
    """
    config = load_config()
    formatted_phone = format_phone_number(to)

    activity.heartbeat("Initiating call...")

    # 1. Initiate the call via backend
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_INITIATE) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/vapi/call",
            headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
            json={
                "to": to,
                "system_prompt": system_prompt,
                "output_schema": output_schema,
                "idempotency_key": f"{agent_id}:{tool_call_id}",
                "user_id": user_id,
            },
        )

        if response.status_code not in [200, 201]:
            error_data = response.text
            msg = f"Backend API error ({response.status_code}): {error_data}"
            raise Exception(msg)  # noqa: TRY002

        init_result = response.json()
        call_id = init_result.get("call_id")

        if not call_id:
            msg = "No call_id returned from backend"
            raise Exception(msg)  # noqa: TRY002

        logger.info("Call initiated", call_id=call_id, to=to[:4] + "****")

    # 2. Poll for call status
    poll_interval = INITIAL_POLL_INTERVAL_SECONDS
    polls = 0
    call_started = False

    while polls < MAX_POLL_ATTEMPTS:
        activity.heartbeat(f"Polling call status (attempt {polls + 1})...")

        await asyncio.sleep(poll_interval)
        polls += 1

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_POLL) as client:
            response = await client.get(
                f"{config.backend.api_url}/api/vapi/call/{call_id}",
                headers={"x-api-key": config.backend.api_key or ""},
            )

            if response.status_code != 200:
                logger.warning("Poll request failed", status=response.status_code, text=response.text)
                continue

            poll_result = response.json()
            status = poll_result.get("status", "")

            logger.info("Vapi poll response", call_id=call_id, status=status, polls=polls)

            # When call starts, send IN_PROGRESS message with live metadata
            if status == "in-progress" and not call_started:
                call_started = True
                poll_interval = ACTIVE_POLL_INTERVAL_SECONDS

                monitor = poll_result.get("monitor", {})
                listen_url = monitor.get("listenUrl")
                started_at = poll_result.get("startedAt")

                await save_phone_call_message(
                    agent_id=agent_id,
                    title="\U0001f4de Call in progress",
                    message=f"**Calling:** {formatted_phone}",
                    status=MessageStatus.IN_PROGRESS,
                    tool_call_id=tool_call_id,
                    phone_metadata={
                        "status": "in-progress",
                        "to": formatted_phone,
                        "callId": call_id,
                        "listenUrl": listen_url,
                        "startedAt": started_at,
                    },
                )

            if status == "ended":
                # Call completed - extract all results
                transcript = poll_result.get("transcript", "")
                analysis = poll_result.get("analysis", {})
                summary = poll_result.get("summary") or analysis.get("summary", "")
                recording_url = poll_result.get("recordingUrl", "")
                ended_reason = poll_result.get("endedReason", "unknown")

                duration = calculate_duration_from_timestamps(
                    poll_result.get("startedAt"),
                    poll_result.get("endedAt"),
                )

                structured_data = analysis.get("structuredData", {})
                completion_message = build_completion_message(
                    formatted_phone, duration, summary, structured_data, transcript
                )

                logger.info(
                    "Call completed",
                    call_id=call_id,
                    duration=duration,
                    ended_reason=ended_reason,
                    has_transcript=bool(transcript),
                    has_summary=bool(summary),
                    has_recording=bool(recording_url),
                )

                # Post FINISHED message with rich metadata
                await save_phone_call_message(
                    agent_id=agent_id,
                    title="\u2705 Call completed",
                    message=completion_message,
                    status=MessageStatus.FINISHED,
                    tool_call_id=tool_call_id,
                    phone_metadata={
                        "status": "ended",
                        "to": formatted_phone,
                        "callId": call_id,
                        "duration": duration,
                        "endedReason": ended_reason,
                        "recordingUrl": recording_url,
                        "transcript": transcript,
                        "summary": summary,
                        "structuredData": structured_data,
                    },
                )

                return {
                    "success": True,
                    "message": completion_message,
                    "call_id": call_id,
                    "structured_data": structured_data,
                    "duration": duration,
                    "ended_reason": ended_reason,
                    "transcript": transcript,
                    "summary": summary,
                    "recording_url": recording_url,
                    "to": to,
                }

    # Timeout
    msg = f"Call timed out after {MAX_POLL_ATTEMPTS * poll_interval} seconds"
    raise Exception(msg)  # noqa: TRY002


def normalize_output_schema(raw_schema: Any) -> dict[str, Any]:
    """Convert the LLM-facing field-list schema into the backend extraction map."""
    if not isinstance(raw_schema, dict):
        return {}
    fields = raw_schema.get("fields")
    if not isinstance(fields, list):
        return raw_schema
    normalized: dict[str, Any] = {}
    for field in fields:
        if not isinstance(field, dict):
            continue
        name = field.get("name")
        description = field.get("description")
        if isinstance(name, str) and name.strip():
            normalized[name] = description if isinstance(description, str) else ""
    return normalized
