"""SMS Activities for Temporal workflows.

Activities for:
- Getting agent source (WEB, MAC_APP, SMS)
- Sending direct SMS (for completion, welcome)
- Sending lifecycle SMS notifications (agent started, write lock, cost limit)
"""

import asyncio
import time
from typing import Dict

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.trace_archive import archive_json
from helpers.tracing import current_root_agent_id
from helpers.world_model_runtime import WorldModelToolExecutionAdapter
from utils.llm_timeouts import SMS_NOTIFICATION_HTTP_TIMEOUT_SECONDS

logger = structlog.get_logger()


# Agent.source values for agents started from the phone (Linq delivers as SMS).
# WhatsApp follows the same notification rules as SMS.
MESSAGING_AGENT_SOURCES = frozenset({"SMS", "WHATSAPP"})


@activity.defn
async def get_agent_source(agent_id: str) -> str:
    """
    Get the source of an agent (WEB, MAC_APP, SMS, WHATSAPP).

    Args:
        agent_id: Agent ID

    Returns:
        Source string: "WEB", "MAC_APP", "SMS" or "WHATSAPP"
    """
    config = load_config()

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{config.backend.api_url}/api/agents/{agent_id}",
                headers={"X-API-Key": config.backend.api_key},
                timeout=30.0,
            )
            response.raise_for_status()
            data = response.json()
            source = data.get("agent", {}).get("source", "WEB")
            logger.info("Got agent source", agent_id=agent_id, source=source)
            return source
    except Exception as e:
        logger.error("Failed to get agent source", agent_id=agent_id, error=str(e))
        return "WEB"  # Default to WEB if we can't fetch


@activity.defn
async def send_direct_sms_activity(
    user_id: str,
    message: str,
    agent_id: str | None = None,
    world_model_mode: str | None = None,
) -> Dict:
    async def real_executor(_tool_name: str, _tool_args: Dict, _tool_call_id: str) -> Dict:
        return await _send_direct_sms_real(user_id, message)

    return await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id or user_id,
        mode=world_model_mode,
    ).execute(
        "send_direct_sms",
        {"user_id": user_id, "message": message},
        f"send_direct_sms:{user_id}",
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _send_direct_sms_real(user_id: str, message: str) -> Dict:
    """
    Send SMS directly (for completion, welcome - no queue).

    Args:
        user_id: User ID
        message: Message to send

    Returns:
        Dict with success and error fields
    """
    config = load_config()

    try:
        activity.heartbeat("Sending direct SMS")

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/send-sms/direct",
                json={
                    "user_id": user_id,
                    "message": message,
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
            response.raise_for_status()
            result = response.json()
            archive_root_agent_id = current_root_agent_id() or user_id
            archive_json(
                root_agent_id=archive_root_agent_id,
                path=f"provider/sms/direct/{int(time.time() * 1000)}.json.gz.enc",
                payload={"request": {"user_id": user_id, "message": message}, "response": result},
            )

            logger.info(
                "Direct SMS result",
                user_id=user_id,
                success=result.get("success"),
            )
            return result
    except Exception as e:
        logger.error(
            "Failed to send direct SMS",
            user_id=user_id,
            error=str(e),
        )
        return {"success": False, "error": str(e)}


@activity.defn
async def notify_sms_event_activity(
    user_id: str,
    event_type: str,
    agent_id: str,
    payload: Dict,
    world_model_mode: str | None = None,
) -> Dict:
    async def real_executor(_tool_name: str, _tool_args: Dict, _tool_call_id: str) -> Dict:
        return await _notify_sms_event_real(user_id, event_type, agent_id, payload)

    return await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        mode=world_model_mode,
    ).execute(
        "notify_sms_event",
        {"user_id": user_id, "event_type": event_type, "agent_id": agent_id, "payload": payload},
        f"notify_sms_event:{agent_id}:{event_type}",
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _notify_sms_event_real(user_id: str, event_type: str, agent_id: str, payload: Dict) -> Dict:
    """
    Send a lifecycle SMS notification via the backend /api/send-sms/notify endpoint.

    Event types: agent_started, planner_message, write_lock, agentcard_setup, completion, cost_limit

    Args:
        user_id: User ID
        event_type: One of the supported event types
        agent_id: Agent ID
        payload: Event-specific data (e.g. goal, question, summary)

    Returns:
        Dict with success field
    """
    config = load_config()

    logger.info(
        "Sending SMS lifecycle notification",
        user_id=user_id,
        event_type=event_type,
        agent_id=agent_id,
        payload_keys=list(payload.keys()) if payload else [],
    )

    try:
        activity.heartbeat(f"Sending SMS notification: {event_type}")

        request_body = {
            "user_id": user_id,
            "event_type": event_type,
            "agent_id": agent_id,
            "payload": payload,
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/send-sms/notify",
                json=request_body,
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json",
                },
                timeout=httpx.Timeout(SMS_NOTIFICATION_HTTP_TIMEOUT_SECONDS, connect=30.0),
            )

            logger.info(
                "SMS notify response",
                user_id=user_id,
                event_type=event_type,
                agent_id=agent_id,
                status_code=response.status_code,
                response_body=response.text[:200] if response.text else "",
            )

            response.raise_for_status()
            result = response.json()
            archive_root_agent_id = current_root_agent_id() or agent_id
            await asyncio.to_thread(
                archive_json,
                root_agent_id=archive_root_agent_id,
                path=f"provider/sms/notify/{event_type}-{agent_id}.json.gz.enc",
                payload={
                    "request": request_body,
                    "response": result,
                    "status_code": response.status_code,
                },
            )

            logger.info(
                "SMS notify result",
                user_id=user_id,
                event_type=event_type,
                agent_id=agent_id,
                success=result.get("success"),
            )
            return result
    except Exception as e:
        logger.error(
            "Failed to send SMS notification",
            user_id=user_id,
            event_type=event_type,
            agent_id=agent_id,
            error=str(e),
        )
        return {"success": False, "error": str(e)}
