"""Send email domain repo - data access via backend API.

Sole consumer of the backend email endpoint. Typed args in, typed results out.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog
from temporalio import activity

from config import load_config

from .config import SEND_TIMEOUT_SECONDS

logger = structlog.get_logger()


@activity.defn
async def send_email_activity(
    user_id: str,
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
    from_email: str | None = None,
) -> dict[str, Any]:
    """
    Activity: Send email via backend API (backend handles Gmail OAuth).

    Args:
        user_id: User ID for the request
        to: Recipient email address
        subject: Email subject
        body: Email body content
        cc: Optional CC recipient
        from_email: Optional sender email to select which connected account to send from

    Returns:
        Dict with messageId, threadId, to, subject.

    Raises:
        Exception: If email fails to send (Gmail not connected, auth error, etc.)
    """
    try:
        activity.heartbeat(f"Sending email to {to[:20]}...")

        config = load_config()

        async with httpx.AsyncClient(timeout=SEND_TIMEOUT_SECONDS) as client:
            payload: dict[str, str] = {
                "user_id": user_id,
                "to": to,
                "subject": subject,
                "body": body,
            }
            if cc:
                payload["cc"] = cc
            if from_email:
                payload["from_email"] = from_email

            response = await client.post(
                f"{config.backend.api_url}/api/integrations/email/send",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

            result = response.json()

            if response.status_code != 200:
                error_msg = result.get("message") or result.get("error") or f"Backend error ({response.status_code})"
                raise Exception(error_msg)  # noqa: TRY002

            logger.info(
                "Email sent successfully",
                to=to,
                message_id=result.get("messageId", "unknown"),
            )

            return {
                "messageId": result.get("messageId"),
                "threadId": result.get("threadId"),
                "to": to,
                "subject": subject,
            }

    except httpx.TimeoutException:
        logger.error("Send email timeout", to=to)
        raise Exception("Request timed out while sending email") from None  # noqa: TRY002
    except Exception as exc:
        logger.error("Send email failed", error=str(exc), to=to)
        raise
