"""Spawn-sub-agents domain data access — backend HTTP calls for agent creation and attachment fetching."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Dict, Tuple

import httpx
import structlog

from helpers.attachments import extract_attachments_from_context

logger = structlog.get_logger()


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
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{backend_url}/api/agents/{parent_agent_id}",
                headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            )
            response.raise_for_status()
            parent_data = response.json()
            parent_messages = parent_data.get("messages", [])

            file_pointers = extract_attachments_from_context(parent_messages)

            for fp in file_pointers:
                fp_dict = asdict(fp)
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
        headers={"X-API-Key": api_key, "Content-Type": "application/json"},
        json=payload,
    )
