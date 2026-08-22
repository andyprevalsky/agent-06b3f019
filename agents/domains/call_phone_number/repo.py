"""Data access for the call-phone-number domain.

HTTP calls to the backend API for phone call management and message persistence.
"""

from typing import Any

import httpx
import structlog

from config import load_config
from domains.call_phone_number.config import HTTP_TIMEOUT_MESSAGE
from helpers.workflow_generation import (
    WorkflowGenerationSealed,
    raise_if_generation_sealed,
    stamp_tool_workflow_generation,
    workflow_generation_headers,
)
from tools.base import MessageStatus

logger = structlog.get_logger()


async def save_phone_call_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    tool_call_id: str,
    phone_metadata: dict[str, Any] | None = None,
) -> None:
    """Save phone call message directly to DB with rich metadata."""
    try:
        config = load_config()

        metadata: dict[str, Any] = {
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
        metadata = stamp_tool_workflow_generation(metadata) or metadata

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_MESSAGE) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json",
                    **workflow_generation_headers(),
                },
                json={"message": message, "role": "TOOL", "metadata": metadata},
            )
            raise_if_generation_sealed(response.status_code, "call_phone_number")
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        logger.error("Failed to save phone call message", error=str(e))
