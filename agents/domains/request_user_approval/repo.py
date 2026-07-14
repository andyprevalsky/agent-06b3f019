"""Request user approval domain data access.

Temporal activities for creating approval requests via the backend API.
Imports: own types, own config, external packages.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config

from .config import CREATE_REQUEST_TIMEOUT_SECONDS

logger = structlog.get_logger()


@activity.defn
async def create_approval_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> str:
    """Create an approval request in the database via backend API.

    Args:
        user_id: User ID.
        agent_id: Agent ID.
        workflow_id: Temporal workflow ID.
        question: Question to ask the user.
        image_url: Optional image URL (e.g. product thumbnail).
        metadata: Optional additional metadata.

    Returns:
        The ID of the created request.
    """
    try:
        config = load_config()
        backend_url = config.backend.api_url

        payload: Dict[str, Any] = {
            "userId": user_id,
            "agentId": agent_id,
            "workflowId": workflow_id,
            "question": question,
        }

        if image_url:
            payload["imageUrl"] = image_url

        if metadata:
            payload["metadata"] = metadata

        logger.info("Creating approval request", payload=payload, backend_url=backend_url)

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{backend_url}/api/attention-requests",
                json=payload,
                timeout=CREATE_REQUEST_TIMEOUT_SECONDS,
            )

            if response.status_code != 200:
                logger.error(
                    "Failed to create approval request - HTTP error",
                    status_code=response.status_code,
                    response_body=response.text,
                    payload=payload,
                )

            response.raise_for_status()
            data = response.json()

            request_id = data.get("id")
            logger.info("Approval request created", request_id=request_id, agent_id=agent_id, question=question[:100])

            return request_id

    except Exception as e:
        logger.error("Failed to create approval request", error=str(e))
        raise


@activity.defn
async def resolve_attention_request_activity(
    user_id: str,
    request_id: str,
    response_text: str,
) -> Dict[str, Any]:
    """Resolve an existing attention request through the backend API."""
    try:
        config = load_config()
        backend_url = config.backend.api_url
        payload = {"response": response_text}

        logger.info(
            "Resolving attention request",
            request_id=request_id,
            user_id=user_id,
            backend_url=backend_url,
        )

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{backend_url}/api/attention-requests/{request_id}/respond",
                json=payload,
                headers={
                    "X-API-Key": config.backend.api_key,
                    "X-User-Id": user_id,
                    "Content-Type": "application/json",
                },
                timeout=CREATE_REQUEST_TIMEOUT_SECONDS,
            )

            if response.status_code != 200:
                logger.error(
                    "Failed to resolve attention request - HTTP error",
                    status_code=response.status_code,
                    response_body=response.text,
                    request_id=request_id,
                    user_id=user_id,
                )

            response.raise_for_status()
            data = response.json()
            logger.info("Attention request resolved", request_id=request_id, user_id=user_id)
            return data

    except Exception as e:
        logger.error(
            "Failed to resolve attention request",
            error=str(e),
            request_id=request_id,
            user_id=user_id,
        )
        raise
