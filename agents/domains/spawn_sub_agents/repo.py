"""Spawn-sub-agents domain data access — backend HTTP calls for agent creation and attachment fetching."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, Tuple

import httpx
import structlog

from domains.spawn_sub_agents.config import SPAWN_HTTP_TIMEOUT_SECONDS
from helpers.attachments import extract_attachments_from_context
from helpers.tracing import backend_api_headers

logger = structlog.get_logger()


@asynccontextmanager
async def spawn_http_client() -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx client configured for spawn requests.

    Keeps the httpx import confined to the repo layer so service.py stays pure.
    """
    async with httpx.AsyncClient(timeout=SPAWN_HTTP_TIMEOUT_SECONDS) as client:
        yield client


async def fetch_parent_attachments(
    backend_url: str,
    api_key: str,
    parent_agent_id: str,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """Fetch parent agent's attachments from the backend.

    Returns:
        Tuple of (filename_to_pointer, all_pointers_by_id) dicts.
    """
    filename_to_pointer: Dict[str, Dict[str, Any]] = {}
    all_pointers_by_id: Dict[str, Dict[str, Any]] = {}

    try:
        async with spawn_http_client() as client:
            response = await client.get(
                f"{backend_url}/api/agents/{parent_agent_id}",
                headers=backend_api_headers(api_key),
            )
            response.raise_for_status()
            parent_data = response.json()
            parent_messages = parent_data.get("messages", [])

            file_pointers = extract_attachments_from_context(parent_messages)

            for fp in file_pointers:
                fp_dict = fp.to_dict()
                filename_to_pointer[fp.original_filename] = fp_dict
                if fp.id:
                    all_pointers_by_id[fp.id] = fp_dict

            logger.info(
                "Extracted parent attachments",
                parent_agent_id=parent_agent_id,
                attachment_count=len(file_pointers),
                filenames=list(filename_to_pointer.keys()),
            )
    except Exception as e:
        logger.warning(f"Failed to fetch parent attachments: {e}")

    return filename_to_pointer, all_pointers_by_id


async def fetch_agent_messages(
    backend_url: str,
    api_key: str,
    agent_id: str,
) -> list[dict[str, Any]]:
    """Fetch persisted messages for an agent from the backend."""
    async with spawn_http_client() as client:
        response = await client.get(
            f"{backend_url}/api/agents/{agent_id}",
            headers=backend_api_headers(api_key),
        )
        response.raise_for_status()
        return response.json().get("messages", [])


async def create_sub_agent(
    client: httpx.AsyncClient,
    backend_url: str,
    api_key: str,
    payload: Dict[str, Any],
) -> httpx.Response:
    """POST to the backend to create a single sub-agent.

    Returns the raw httpx Response for the caller to interpret.
    """
    return await client.post(
        f"{backend_url}/api/agents",
        headers=backend_api_headers(api_key),
        json=payload,
    )


async def create_sub_agents_batch(
    client: httpx.AsyncClient,
    backend_url: str,
    api_key: str,
    payloads: list[Dict[str, Any]],
) -> httpx.Response:
    """POST to the batch endpoint to create up to 200 sub-agents in one call.

    Each payload must include `agent_id`. The backend returns a 201 (all
    succeeded) or 207 (partial: some workflow starts failed) with a
    `{ results: [...] }` body whose entries mirror the input order.
    """
    return await client.post(
        f"{backend_url}/api/agents/batch",
        headers=backend_api_headers(api_key),
        json={"agents": payloads},
    )
