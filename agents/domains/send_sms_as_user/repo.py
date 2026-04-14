"""Send SMS as user domain repo - backend API data access."""

from __future__ import annotations

from typing import Any

import httpx
import structlog

from config import load_config

from .config import IMESSAGE_QUEUE_ENDPOINT, QUEUE_TIMEOUT_SECONDS

logger = structlog.get_logger()


async def queue_imessage_via_backend(
    user_id: str,
    agent_id: str,
    phone_number: str,
    message: str,
) -> dict[str, Any]:
    """
    Queue an iMessage for delivery via the backend API.

    Args:
        user_id: User ID for queue routing.
        agent_id: Agent ID for event routing.
        phone_number: E.164 formatted phone number.
        message: Message text to send.

    Returns:
        Dict with 'success' and optional 'queue_id' or 'error'.
    """
    config = load_config()

    async with httpx.AsyncClient(timeout=QUEUE_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{config.backend.api_url}{IMESSAGE_QUEUE_ENDPOINT}",
            headers={
                "x-api-key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json={
                "user_id": user_id,
                "agent_id": agent_id,
                "phone_number": phone_number,
                "message": message,
            },
        )

        if response.status_code not in [200, 201]:
            error_text = response.text
            logger.error("iMessage queue failed", status=response.status_code, error=error_text)
            return {"success": False, "error": f"API error: {response.status_code}"}

        result = response.json()
        logger.info("iMessage queued", queue_id=result.get("queue_id"))
        return {"success": True, "queue_id": result.get("queue_id")}
