"""Data access for the send-sms domain.

Calls the backend SMS API via HTTP.
This is a Temporal activity -- safe to use I/O, network, etc.
"""

from typing import Any

import httpx
import structlog
from temporalio import activity

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def send_sms_activity(phone_number: str, message: str) -> dict[str, Any]:
    """Activity: Send SMS message via backend API (backend handles Surge).

    Agent doesn't need Surge credentials -- backend does the API call.

    Args:
        phone_number: Phone number in E.164 format (e.g., +19729777432)
        message: SMS message content

    Returns:
        Dict with success, phone_number, message_id fields.
    """
    try:
        activity.heartbeat(f"Sending SMS to {phone_number[:4]}****")

        config = load_config()

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/send-sms",
                headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                json={"phone_number": phone_number, "message": message},
            )

            if response.status_code not in [200, 201]:
                error_data = response.text
                msg = f"Backend API error ({response.status_code}): {error_data}"
                raise Exception(msg)  # noqa: TRY002

            result = response.json()

            logger.info("SMS sent successfully", phone=phone_number, message_id=result.get("message_id", "unknown"))

            return result

    except Exception as e:
        logger.error("SMS send failed", error=str(e))
        raise
