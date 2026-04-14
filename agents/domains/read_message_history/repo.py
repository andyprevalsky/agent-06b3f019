"""Read-message-history data access layer.

Sole consumer of the backend messages API.
Imports: own types, own config, providers (config for backend URL/key).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import httpx
import structlog

from config import load_config
from domains.read_message_history.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    DEFAULT_MESSAGE_LIMIT,
    MESSAGES_API_PATH,
)

if TYPE_CHECKING:
    from domains.read_message_history.types import ReadMessageHistoryResult

logger = structlog.get_logger()


async def fetch_message_history(
    *,
    user_id: str,
    phone: str | None = None,
    email: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    message_limit: int = DEFAULT_MESSAGE_LIMIT,
) -> ReadMessageHistoryResult:
    """Fetch message history from the backend API.

    Args:
        user_id: User ID for the request.
        phone: Phone number (E.164 format).
        email: Email address.
        first_name: First name.
        last_name: Last name.
        message_limit: Maximum number of messages to return.

    Returns:
        Backend response with person info and messages.

    Raises:
        Exception: If API request fails or returns non-200.
        httpx.TimeoutException: If the request times out.
    """
    app_config = load_config()

    body: dict[str, object] = {"user_id": user_id, "message_limit": message_limit}
    if phone:
        body["phone"] = phone
    if email:
        body["email"] = email
    if first_name:
        body["firstName"] = first_name
    if last_name:
        body["lastName"] = last_name

    async with httpx.AsyncClient(timeout=float(ACTIVITY_TIMEOUT_SECONDS)) as client:
        response = await client.post(
            f"{app_config.backend.api_url}{MESSAGES_API_PATH}",
            headers={
                "X-API-Key": app_config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json=body,
        )

        result = response.json()

        if response.status_code != 200:
            error_msg = result.get("error") or f"Backend error ({response.status_code})"
            raise Exception(error_msg)

        logger.info(
            "Message history retrieved",
            person=result.get("person"),
            message_count=result.get("count", 0),
        )

        return result
