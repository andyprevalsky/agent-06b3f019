"""Call phone number tool - event-driven architecture with polling updates."""

import asyncio
import json
import uuid as uuid_module
from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageType, UsageItem, extract_root_error
from helpers.handle_tool_event import handle_tool_event

# Config import is safe - no side effects at import time (load_dotenv is lazy)
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


# ========================================
# MESSAGE HELPERS
# ========================================

async def save_phone_call_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    tool_call_id: str,
    phone_metadata: dict = None,
):
    """Save phone call message directly to DB with rich metadata."""
    try:
        config = load_config()

        metadata = {
            "toolCallId": tool_call_id,
            "toolName": "call_phone_number",
            "toolStatus": status.value,
            "title": title,
        }

        # Merge phone-specific metadata
        if phone_metadata:
            metadata["phoneCall"] = phone_metadata

        if status == MessageStatus.ERROR:
            metadata["error"] = True

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save phone call message", error=str(e))


class CallPhoneNumberManager(ToolManager):
    """Manager for making outbound phone calls via Vapi API."""

    tool_name = "call_phone_number"
    requires_approval = True

    def get_approval_question(self, tool_call: Dict[str, Any]) -> str:
        """Return the approval question for this phone call."""
        to = tool_call.get("to", "unknown")
        system_prompt = tool_call.get("system_prompt", "")

        # Format phone for display
        formatted_phone = format_phone_number(to)

        return f"Make a phone call to {formatted_phone}?\n\nAgent behavior: {system_prompt}"

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute phone call and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'to', 'system_prompt', 'output_schema'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking

        Returns:
            Result dict with structured data extracted from the call
        """
        to = tool_call.get("to", "")
        system_prompt = tool_call.get("system_prompt", "")
        output_schema = tool_call.get("output_schema", {})

        formatted_phone = format_phone_number(to)

        # 1. Initial status - just show we're starting (activity will update with rich metadata)
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📞 Initiating call",
                message=f"**Calling:** {formatted_phone}",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "phoneCall": {
                        "status": "initiating",
                        "to": formatted_phone,
                    }
                }
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="call_phone_number",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute phone call activity (handles IN_PROGRESS and FINISHED messages with rich metadata)
        try:
            result = await execute_activity(
                call_phone_number_activity,
                args=[to, system_prompt, output_schema, agent_id, tool_call_id, user_id],
                start_to_close_timeout=timedelta(minutes=15),  # Calls can take a while
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,  # Limited retries - don't spam calls
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=5),
                    maximum_interval=timedelta(seconds=30)
                )
            )

            # 3. Report usage based on call duration
            duration_seconds = result.get("duration", 0)
            duration_minutes = max(1, duration_seconds / 60)  # Minimum 1 minute
            cost_cents = int(duration_minutes * 5)  # ~$0.05/min estimate

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.USAGE,
                    tool_name="call_phone_number",
                    usage_items=[
                        UsageItem(
                            type=UsageType.SERVICE,
                            cost_cents=cost_cents,
                            provider="Vapi Voice Call"
                        )
                    ]
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="call_phone_number",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Activity already posts FINISHED message with rich metadata
            return result

        except Exception as e:
            # Error status - extract root cause from Temporal exception chain
            error_msg = extract_root_error(e)
            logger.error("Call phone number failed", error=error_msg, to=to[:4] + "****")
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Call failed",
                    message=f"**To:** {formatted_phone}\n\n**Error:** {error_msg}",
                    status=MessageStatus.ERROR,
                    metadata={
                        "phoneCall": {
                            "status": "error",
                            "to": formatted_phone,
                            "error": error_msg,
                        }
                    }
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="call_phone_number",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {"error": error_msg, "to": to}


def format_phone_number(number: str) -> str:
    """Format phone number for display as +1 (972) 977-7432 or leave as-is on failure."""
    import re
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


# ========================================
# SINGLETON
# ========================================

_manager: Optional[CallPhoneNumberManager] = None


def get_manager() -> CallPhoneNumberManager:
    """Get or create call phone number manager singleton."""
    global _manager
    if _manager is None:
        _manager = CallPhoneNumberManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def call_phone_number(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute call_phone_number tool.

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
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def call_phone_number_activity(
    to: str,
    system_prompt: str,
    output_schema: Dict[str, Any],
    agent_id: str,
    tool_call_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Activity: Initiate phone call via backend API and poll until complete.

    Args:
        to: Phone number in E.164 format (e.g., +19729777432)
        system_prompt: LLM-defined behavior instructions for the voice agent
        output_schema: JSON Schema for structured data extraction
        agent_id: Agent ID for progress updates
        tool_call_id: Tool call ID for progress updates
        user_id: User ID for tracking

    Returns:
        Dict with:
            - success: Boolean
            - structured_data: Extracted data from the call
            - duration: Call duration in seconds
            - ended_reason: Why the call ended
            - transcript: Call transcript (if available)
    """
    config = load_config()
    formatted_phone = format_phone_number(to)

    activity.heartbeat("Initiating call...")

    # 1. Initiate the call via backend
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/vapi/call",
            headers={
                "x-api-key": config.backend.api_key or "",
                "Content-Type": "application/json"
            },
            json={
                "to": to,
                "system_prompt": system_prompt,
                "output_schema": output_schema
            }
        )

        if response.status_code not in [200, 201]:
            error_data = response.text
            raise Exception(f"Backend API error ({response.status_code}): {error_data}")

        init_result = response.json()
        call_id = init_result.get("call_id")

        if not call_id:
            raise Exception("No call_id returned from backend")

        logger.info("Call initiated", call_id=call_id, to=to[:4] + "****")

    # 2. Poll for first status to get listenUrl and startedAt
    poll_interval = 3  # seconds (faster initial poll)
    max_polls = 200  # 10 minutes max
    polls = 0
    call_started = False
    listen_url = None
    started_at = None

    while polls < max_polls:
        activity.heartbeat(f"Polling call status (attempt {polls + 1})...")

        await asyncio.sleep(poll_interval)
        polls += 1

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{config.backend.api_url}/api/vapi/call/{call_id}",
                headers={
                    "x-api-key": config.backend.api_key or "",
                }
            )

            if response.status_code != 200:
                logger.warning("Poll request failed", status=response.status_code, text=response.text)
                continue

            poll_result = response.json()
            status = poll_result.get("status", "")

            # Log poll response
            logger.info(
                "Vapi poll response",
                call_id=call_id,
                status=status,
                polls=polls,
            )

            # When call starts (queued -> in-progress), send IN_PROGRESS message with live metadata
            if status == "in-progress" and not call_started:
                call_started = True
                poll_interval = 5  # Slow down polling once call is active

                # Extract live call metadata
                monitor = poll_result.get("monitor", {})
                listen_url = monitor.get("listenUrl")
                started_at = poll_result.get("startedAt")

                # Post IN_PROGRESS message with rich metadata for live UI
                await save_phone_call_message(
                    agent_id=agent_id,
                    title="📞 Call in progress",
                    message=f"**Calling:** {formatted_phone}",
                    status=MessageStatus.IN_PROGRESS,
                    tool_call_id=tool_call_id,
                    phone_metadata={
                        "status": "in-progress",
                        "to": formatted_phone,
                        "callId": call_id,
                        "listenUrl": listen_url,
                        "startedAt": started_at,
                    }
                )

            if status == "ended":
                # Call completed - extract all results
                transcript = poll_result.get("transcript", "")
                summary = poll_result.get("summary", "")
                recording_url = poll_result.get("recordingUrl", "")
                ended_reason = poll_result.get("endedReason", "unknown")

                # Calculate duration from timestamps (Vapi doesn't return top-level duration)
                started_at_str = poll_result.get("startedAt")
                ended_at_str = poll_result.get("endedAt")
                duration = 0
                if started_at_str and ended_at_str:
                    from datetime import datetime
                    try:
                        started_at_dt = datetime.fromisoformat(started_at_str.replace("Z", "+00:00"))
                        ended_at_dt = datetime.fromisoformat(ended_at_str.replace("Z", "+00:00"))
                        duration = int((ended_at_dt - started_at_dt).total_seconds())
                    except Exception:
                        pass

                # Get structured data from analysis
                analysis = poll_result.get("analysis", {})
                structured_data = analysis.get("structuredData", {})

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
                    title="✅ Call completed",
                    message=f"**To:** {formatted_phone}\n**Duration:** {duration}s",
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
                    }
                )

                # Build a message with key data for LLM context
                message_parts = [f"Call to {formatted_phone} completed ({duration}s)."]
                if summary:
                    message_parts.append(f"\n\nSummary: {summary}")
                if structured_data:
                    message_parts.append(f"\n\nExtracted Data:\n{json.dumps(structured_data, indent=2)}")
                if transcript:
                    message_parts.append(f"\n\nTranscript:\n{transcript}")

                return {
                    "success": True,
                    "message": "".join(message_parts),
                    "call_id": call_id,
                    "structured_data": structured_data,
                    "duration": duration,
                    "ended_reason": ended_reason,
                    "transcript": transcript,
                    "summary": summary,
                    "recording_url": recording_url,
                    "to": to
                }

    # Timeout
    raise Exception(f"Call timed out after {max_polls * poll_interval} seconds")
