"""SMS Activities for Temporal workflows.

Activities for:
- Getting agent source (WEB, MAC_APP, SMS)
- Enqueueing/sending SMS questions with queue awareness
- Sending direct SMS (for completion, welcome - no queue)
- Handling agent unblock (cleanup queue state)
"""

from typing import Dict, Optional
from temporalio import activity
import structlog
import httpx

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def get_agent_source(agent_id: str) -> str:
    """
    Get the source of an agent (WEB, MAC_APP, SMS).

    Args:
        agent_id: Agent ID

    Returns:
        Source string: "WEB", "MAC_APP", or "SMS"
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
async def enqueue_sms_question_activity(
    user_id: str, agent_id: str, workflow_id: str, question: str
) -> Dict:
    """
    Enqueue or send an SMS question for an agent.

    If no active SMS for the user, sends immediately.
    If there's already an active SMS, queues this one.

    Args:
        user_id: User ID
        agent_id: Agent ID
        workflow_id: Workflow ID (for signaling when reply arrives)
        question: The question text to send

    Returns:
        Dict with sent, queued, and error fields
    """
    config = load_config()

    try:
        activity.heartbeat("Enqueueing SMS question")

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/send-sms/queue",
                json={
                    "user_id": user_id,
                    "agent_id": agent_id,
                    "workflow_id": workflow_id,
                    "question": question,
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
            response.raise_for_status()
            result = response.json()

            logger.info(
                "SMS queue result",
                user_id=user_id,
                agent_id=agent_id,
                sent=result.get("sent"),
                queued=result.get("queued"),
            )
            return result
    except Exception as e:
        logger.error(
            "Failed to enqueue SMS question",
            user_id=user_id,
            agent_id=agent_id,
            error=str(e),
        )
        return {"sent": False, "queued": False, "error": str(e)}


@activity.defn
async def send_direct_sms_activity(user_id: str, message: str) -> Dict:
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
async def handle_agent_unblocked_activity(user_id: str, agent_id: str) -> Dict:
    """
    Handle agent getting unblocked (via web or SMS response).

    Removes agent from SMS queue (active or pending).
    If it was active and there are pending items, sends the next SMS.

    Args:
        user_id: User ID
        agent_id: Agent ID

    Returns:
        Dict with nextSent and nextAgentId fields
    """
    config = load_config()

    try:
        activity.heartbeat("Handling agent unblock")

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/send-sms/unblock",
                json={
                    "user_id": user_id,
                    "agent_id": agent_id,
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
            response.raise_for_status()
            result = response.json()

            logger.info(
                "Agent unblock result",
                user_id=user_id,
                agent_id=agent_id,
                next_sent=result.get("nextSent"),
                next_agent_id=result.get("nextAgentId"),
            )
            return result
    except Exception as e:
        logger.error(
            "Failed to handle agent unblock",
            user_id=user_id,
            agent_id=agent_id,
            error=str(e),
        )
        return {"nextSent": False, "error": str(e)}
