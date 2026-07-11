"""Gate domain data access.

Temporal activity that creates a Gate attention request via the backend API.
The backend validates the gate, dedups on (userId, gateKey), fans multiple
agents onto one gate, and emits the in-stream gate message — so this activity
only needs to POST and return the request id.

Imports: own config, external packages.
"""

from __future__ import annotations

from typing import Any, Dict, List

import httpx
import structlog
from temporalio import activity

from config import load_config

logger = structlog.get_logger()

CREATE_GATE_TIMEOUT_SECONDS = 30.0


@activity.defn
async def create_gate_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    gate: Dict[str, Any],
    gate_key: str,
) -> str:
    """Create (or dedup onto) a Gate attention request. Returns the request id."""
    config = load_config()
    backend_url = config.backend.api_url

    payload: Dict[str, Any] = {
        "userId": user_id,
        "agentId": agent_id,
        "workflowId": workflow_id,
        "question": question,
        "gateKey": gate_key,
        "metadata": {"gate": gate},
    }

    logger.info("Creating gate request", gate_key=gate_key, agent_id=agent_id)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{backend_url}/api/attention-requests",
            json=payload,
            timeout=CREATE_GATE_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.error(
                "Failed to create gate request - HTTP error",
                status_code=response.status_code,
                response_body=response.text,
                gate_key=gate_key,
            )
        response.raise_for_status()
        data = response.json()
        request_id = data.get("id")
        logger.info(
            "Gate request created",
            request_id=request_id,
            gate_key=gate_key,
            deduped=data.get("deduped"),
        )
        return request_id


@activity.defn
async def mint_subscription_checkout_activity(user_id: str) -> str:
    """Mint the minimal subscription action URL for a gate."""
    config = load_config()
    backend_url = config.backend.api_url
    headers = {
        "X-API-Key": config.backend.api_key or "",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{backend_url}/api/billing/subscription-checkout",
            headers=headers,
            json={"userId": user_id},
            timeout=CREATE_GATE_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
        url = data.get("url")
        if not isinstance(url, str) or url == "":
            raise ValueError("Subscription checkout response missing url")
        return url


@activity.defn
async def mint_gmail_connect_activity(user_id: str) -> str:
    """Mint the minimal Gmail OAuth URL for a source-connect gate."""
    config = load_config()
    backend_url = config.backend.api_url
    headers = {
        "X-API-Key": config.backend.api_key or "",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{backend_url}/api/integrations/email/gmail/start",
            headers=headers,
            json={"user_id": user_id},
            timeout=CREATE_GATE_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
        url = data.get("authUrl")
        if not isinstance(url, str) or url == "":
            raise ValueError("Gmail OAuth response missing authUrl")
        return url


@activity.defn
async def has_message_corpus_activity(user_id: str) -> bool:
    """Return whether the user has any local message records available to grep."""
    config = load_config()
    backend_url = config.backend.api_url
    async with httpx.AsyncClient(timeout=CREATE_GATE_TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{backend_url}/api/data/summary",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
        )
        response.raise_for_status()
        data = response.json()
        total = data.get("sources", {}).get("messages", {}).get("total_messages", 0)
        return isinstance(total, int) and total > 0


@activity.defn
async def source_status_activity(user_id: str, sources: List[str]) -> List[Dict[str, Any]]:
    """Return connectivity status for each requested grep source.

    Calls the backend source-status endpoint, which maps each source to its
    connector (an Integration name) and reports whether that connector is
    CONNECTED plus the connect URL to mint the gate. Local sources
    (messages/network/agent_network) always report connected=True. Returns a
    list of ``{source, connector, connected, connectUrl}`` dicts.
    """
    if not sources:
        return []
    config = load_config()
    backend_url = config.backend.api_url
    async with httpx.AsyncClient(timeout=CREATE_GATE_TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{backend_url}/api/data/source-status",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            params={"sources": ",".join(sources)},
        )
        response.raise_for_status()
        data = response.json()
        statuses = data.get("statuses", [])
        return statuses if isinstance(statuses, list) else []
