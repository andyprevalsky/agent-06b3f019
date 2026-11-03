"""Spawn-agent domain data access: HTTP calls to backend, network metadata cache."""

from __future__ import annotations

import uuid as uuid_module
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import structlog
from temporalio import activity

from config import load_config
from domains.spawn_agent.config import (
    NETWORK_CACHE_TTL_MINUTES,
    NETWORK_FETCH_TIMEOUT,
    NETWORK_PEOPLE_LIMIT,
    NETWORK_PERSON_SKIP_FIELDS,
    SAVE_MESSAGE_TIMEOUT,
)
from helpers.attachments import FilePointer, resolve_attachments_for_llm
from helpers.http_client import get_http_client
from helpers.workflow_generation import (
    WorkflowGenerationSealed,
    raise_if_generation_sealed,
    stamp_tool_workflow_generation,
    workflow_generation_headers,
)
from tools.base import MessageStatus

logger = structlog.get_logger()

# Module-level cache for network metadata
_network_metadata_cache: Dict[str, Dict[str, Any]] = {}


@activity.defn
async def fetch_explore_tool_evidence(agent_id: str, user_id: str, task_id: str) -> List[str]:
    """Read only this explore task's persisted, completed tool results.

    The backend scopes the read to the parent agent and user, scans at most
    16 rows, and returns at most eight 1,200-character excerpts. A failed read
    never becomes a successful explore result.
    """
    config = load_config()
    response = await get_http_client().get(
        f"{config.backend.api_url}/api/agents/{agent_id}/explore-tool-evidence",
        params={"taskId": task_id},
        headers={"x-api-key": config.backend.api_key or "", "x-user-id": user_id},
        timeout=10.0,
    )
    raise_if_generation_sealed(response.status_code, "spawn_agent")
    response.raise_for_status()
    results = response.json().get("results", [])
    if not isinstance(results, list):
        return []
    return [item[:1280] for item in results[:8] if isinstance(item, str) and item.strip()]


async def save_explore_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    tool_call_id: Optional[str] = None,
    tool_name: Optional[str] = None,
    inbox: Optional[Dict[str, Any]] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Save explore agent message directly to DB.

    ``inbox`` ({task_id, since}) piggybacks the explore task's agent-inbox read
    on this post; the backend's ``pending_inbox`` rows are returned (None when
    not requested or unavailable).

    When tool_call_id is provided, the message reuses that ID so the frontend
    deduplicator replaces the previous message with the same toolCallId.
    This is used for progress updates on the init bubble.

    ``tool_name`` must be the name of the tool the message is ABOUT. It defaults
    to ``spawn_agent`` only for the explore agent's own lifecycle messages. The
    FE keys a chip by toolCallId, so relabelling a tool's message as
    ``spawn_agent`` made it collide with — and overwrite — that tool's own chip:
    docs/rca/cases/2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id.md
    """
    try:
        config = load_config()
        unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

        metadata: Dict[str, Any] = {
            "toolCallId": unique_tool_call_id,
            "toolName": tool_name or "spawn_agent",
            "toolStatus": status.value,
            "title": title,
            "agentType": "explore",
            "taskId": task_id,
            "subAgentId": task_id,
        }

        if status == MessageStatus.ERROR:
            metadata["error"] = True
        metadata = stamp_tool_workflow_generation(metadata) or metadata

        response = await get_http_client().post(
            f"{config.backend.api_url}/api/agents/{agent_id}/messages",
            headers={
                "x-api-key": config.backend.api_key or "",
                "Content-Type": "application/json",
                **workflow_generation_headers(),
            },
            json={"message": message, "role": "TOOL", "metadata": metadata, **({"inbox": inbox} if inbox else {})},
            timeout=SAVE_MESSAGE_TIMEOUT,
        )
        raise_if_generation_sealed(response.status_code, "spawn_agent")
        if inbox and response.status_code == 201:
            pending = (response.json() or {}).get("pending_inbox")
            return pending if isinstance(pending, list) else None
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        logger.error("Failed to save explore message", error=str(e))
    return None


@activity.defn
async def _resolve_explore_attachments_activity(
    attachment_dicts: List[Dict[str, Any]],
) -> tuple:
    """Download file content for explore agent attachments.

    Returns (content_blocks, metadata_texts) from resolve_attachments_for_llm.
    Runs as a Temporal activity because file downloads require I/O.
    """
    pointers = [FilePointer.from_dict(d) for d in attachment_dicts]
    content_blocks, metadata_texts = await resolve_attachments_for_llm(pointers, require_inline=True)
    # Explore agents are text-only (no multimodal), so we only return metadata_texts.
    # Images get a metadata placeholder; text/CSV files get inlined content.
    return content_blocks, metadata_texts


@activity.defn
async def fetch_full_network_metadata(user_id: str) -> str:
    """Fetch full user network metadata for explore agent system prompt.

    Cached with 5-minute TTL.
    """
    now = datetime.utcnow()
    if user_id in _network_metadata_cache:
        cached = _network_metadata_cache[user_id]
        if (now - cached["fetched_at"]) < timedelta(minutes=NETWORK_CACHE_TTL_MINUTES):
            return cached["metadata"]

    config = load_config()
    try:
        response = await get_http_client().get(
            f"{config.backend.api_url}/api/people",
            params={"limit": NETWORK_PEOPLE_LIMIT},
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=NETWORK_FETCH_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        people = data.get("people", [])

        # Format all non-null fields per person
        lines: List[str] = []
        for person in people:
            parts: List[str] = []
            first = person.get("firstName", "")
            last = person.get("lastName", "")
            name = f"{first} {last}".strip()
            if not name:
                continue

            parts.append(name)

            for key, value in person.items():
                if key in NETWORK_PERSON_SKIP_FIELDS or value is None or value == "" or value == []:
                    continue
                field_name = key.replace("_", " ").replace("Id", "").strip()
                parts.append(f"{field_name}: {value}")

            lines.append("- " + " | ".join(parts))

        metadata = "\n".join(lines) if lines else "No contacts found."

        _network_metadata_cache[user_id] = {
            "metadata": metadata,
            "fetched_at": now,
        }

        return metadata
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        logger.error("Failed to fetch network metadata", user_id=user_id[:8], error=str(e))
        return ""
