"""Spawn-sub-agents domain service — business logic for spawning and managing sub-agents."""

from __future__ import annotations

import asyncio
import random
from typing import Any, Dict, List

import structlog
import structlog.contextvars
from temporalio import activity

from config import load_config
from domains.spawn_sub_agents.config import (
    BASE_BACKOFF_SECONDS,
    MAX_PARALLEL_SPAWNS,
    MAX_SPAWN_ATTEMPTS,
    RETRYABLE_STATUS_CODES,
)
from domains.spawn_sub_agents.repo import create_sub_agent, fetch_parent_attachments, spawn_http_client
from domains.spawn_sub_agents.types import SpawnResult

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def extract_file_pointers_from_structured_response(
    structured_response: Dict[str, Any],
    output_schema: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Extract FilePointer dicts from structured_response based on output_schema field types.

    Args:
        structured_response: The response dict from sub-agent verifier
        output_schema: The output schema with field definitions

    Returns:
        List of FilePointer dicts found in the structured response
    """
    if not structured_response or not output_schema:
        return []

    file_pointers: list[Dict[str, Any]] = []
    fields = output_schema.get("fields", [])

    for field in fields:
        field_name = field.get("name")
        field_type = field.get("type")

        if not field_name or field_name not in structured_response:
            continue

        value = structured_response[field_name]

        if field_type == "file_pointer":
            if value and isinstance(value, dict) and value.get("id") and value.get("storage_path"):
                file_pointers.append(value)
        elif field_type == "list[file_pointer]" and isinstance(value, list):
            for item in value:
                if item and isinstance(item, dict) and item.get("id") and item.get("storage_path"):
                    file_pointers.append(item)

    return file_pointers


def resolve_attachments_for_sub_agent(
    agent_cfg: Dict[str, Any],
    filename_to_pointer: Dict[str, Dict[str, Any]],
    all_pointers_by_id: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Resolve attachment references for a sub-agent.

    If the agent specifies explicit attachments, resolve them by filename or ID.
    If none are specified, auto-forward all parent attachments.
    """
    resolved_attachments: list[Dict[str, Any]] = []
    id_to_pointer = {v.get("id", ""): v for v in filename_to_pointer.values() if v.get("id")}
    all_attachments = list(all_pointers_by_id.values()) if all_pointers_by_id else list(filename_to_pointer.values())

    if agent_cfg.get("attachments"):
        for filename in agent_cfg["attachments"]:
            if filename in filename_to_pointer:
                resolved_attachments.append(filename_to_pointer[filename])
            elif filename in id_to_pointer:
                resolved_attachments.append(id_to_pointer[filename])
            else:
                logger.warning(
                    f"Attachment not found in parent context: {filename}",
                    available_files=list(filename_to_pointer.keys()),
                )
        # If explicit resolution found nothing, auto-forward all
        if not resolved_attachments and filename_to_pointer:
            logger.info(
                "Explicit attachment resolution failed, auto-forwarding all parent attachments",
                requested=agent_cfg["attachments"],
                num_files=len(all_attachments),
                filenames=list(filename_to_pointer.keys()),
            )
            resolved_attachments = all_attachments
    elif filename_to_pointer:
        logger.info(
            "Auto-forwarding parent attachments to sub-agent",
            num_files=len(all_attachments),
            filenames=list(filename_to_pointer.keys()),
        )
        resolved_attachments = all_attachments

    return resolved_attachments


def build_spawn_payload(
    user_id: str,
    agent_cfg: Dict[str, Any],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool,
    parent_model: str,
    bus_id: str | None,
    parent_source: str,
    resolved_attachments: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Build the POST payload for creating a sub-agent."""
    start_phase = str(agent_cfg.get("start_phase", "plan")).strip().lower()
    if start_phase not in {"plan", "execute"}:
        start_phase = "plan"

    payload: Dict[str, Any] = {
        "user_id": user_id,
        "goal": agent_cfg.get("goal", ""),
        "verifier": agent_cfg["verifier"],
        "start_phase": start_phase,
        "parent_agent_id": parent_agent_id,
        "parent_workflow_id": parent_workflow_id,
        "depth": depth,
        "pause_state": parent_is_paused,
        "response_schema": agent_cfg.get("output_schema"),
        "bus_id": bus_id,
        "max_iterations": 25,
        "source": parent_source,
        "model": parent_model,
    }
    if resolved_attachments:
        payload["attachments"] = resolved_attachments
    if agent_cfg.get("context_gates"):
        payload["context_gates"] = agent_cfg["context_gates"]

    return payload


# ---------------------------------------------------------------------------
# Temporal activity
# ---------------------------------------------------------------------------


@activity.defn
async def spawn_sub_agent_activity(
    user_id: str,
    sub_agents: List[Dict[str, Any]],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool,
    parent_model: str = "rose-labs/rose-1-lite",
    bus_id: str | None = None,
    parent_source: str = "WEB",
) -> SpawnResult:
    """Activity: Spawn multiple sub-agents to work on parallel subtasks.

    Args:
        user_id: User ID (agents will be created for this user)
        sub_agents: List of agent configs, each with:
            - goal (str): The subtask goal
            - verifier (dict): {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "..."}
            - start_phase (str, optional): "plan" (default) or "execute"
            - attachments (list[str], optional): Filenames to pass to this sub-agent
        parent_agent_id: Parent agent ID (for hierarchy)
        parent_workflow_id: Parent workflow ID (for signaling)
        depth: Nesting depth for children
        parent_is_paused: Whether parent is currently paused (children inherit this state)
        parent_model: Model from parent agent (inherited by all sub-agents)
        bus_id: Shared bus channel ID for sub-agent tree updates
        parent_source: Agent source from parent (WEB or MAC_APP), inherited by sub-agents

    Returns:
        Dict with summary: {"spawned": int, "completed": int, "failed": int, "agents": [...]}
    """
    structlog.contextvars.bind_contextvars(agent_id=parent_agent_id)

    try:
        activity.heartbeat(f"Spawning {len(sub_agents)} sub-agents")

        config = load_config()
        backend_url = config.backend.api_url.rstrip("/")
        api_key = config.backend.api_key

        if not api_key:
            raise ValueError("BACKEND_API_KEY not configured - required for spawning sub-agents")

        # Fetch parent attachments
        activity.heartbeat("Fetching parent agent's attachments...")
        filename_to_pointer, all_pointers_by_id = await fetch_parent_attachments(backend_url, api_key, parent_agent_id)

        # Spawn with bounded concurrency
        async with spawn_http_client() as client:
            semaphore = asyncio.Semaphore(MAX_PARALLEL_SPAWNS)

            async def spawn_one_with_retry(index: int, agent_cfg: Dict[str, Any]) -> tuple[int, Dict[str, Any]]:
                async with semaphore:
                    goal = agent_cfg.get("goal", "")
                    activity.heartbeat(f"Spawning sub-agent {index + 1}/{len(sub_agents)}")

                    resolved_attachments = resolve_attachments_for_sub_agent(
                        agent_cfg, filename_to_pointer, all_pointers_by_id
                    )
                    payload = build_spawn_payload(
                        user_id=user_id,
                        agent_cfg=agent_cfg,
                        parent_agent_id=parent_agent_id,
                        parent_workflow_id=parent_workflow_id,
                        depth=depth,
                        parent_is_paused=parent_is_paused,
                        parent_model=parent_model,
                        bus_id=bus_id,
                        parent_source=parent_source,
                        resolved_attachments=resolved_attachments,
                    )

                    last_error = "unknown error"
                    for attempt in range(1, MAX_SPAWN_ATTEMPTS + 1):
                        try:
                            logger.info(
                                "Spawning sub-agent",
                                index=index,
                                attempt=attempt,
                                payload=payload,
                            )
                            response = await create_sub_agent(client, backend_url, api_key, payload)

                            if response.is_success:
                                data = response.json()
                                logger.info(
                                    "Sub-agent spawned",
                                    agent_id=data.get("agent_id"),
                                    workflow_id=data.get("temporal_workflow_id"),
                                    goal=data.get("goal", goal),
                                    index=index,
                                )
                                return index, {
                                    "agent_id": data["agent_id"],
                                    "temporal_workflow_id": data["temporal_workflow_id"],
                                    "goal": data["goal"],
                                    "model": data["model"],
                                    "status": data["status"],
                                }

                            status_code = response.status_code
                            response_text = response.text[:500]
                            last_error = f"HTTP {status_code}: {response_text}"
                            if status_code in RETRYABLE_STATUS_CODES and attempt < MAX_SPAWN_ATTEMPTS:
                                delay = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
                                jitter = random.uniform(0, delay * 0.3)
                                sleep_s = delay + jitter
                                logger.warning(
                                    "Retrying sub-agent spawn after HTTP error",
                                    index=index,
                                    attempt=attempt,
                                    status_code=status_code,
                                    sleep_seconds=round(sleep_s, 2),
                                )
                                await asyncio.sleep(sleep_s)
                                continue

                            logger.error(
                                "Failed to spawn sub-agent - HTTP error",
                                index=index,
                                goal=goal,
                                status_code=status_code,
                                response_text=response_text,
                            )
                            break

                        except Exception as e:
                            last_error = str(e)
                            if attempt < MAX_SPAWN_ATTEMPTS:
                                delay = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
                                jitter = random.uniform(0, delay * 0.3)
                                sleep_s = delay + jitter
                                logger.warning(
                                    "Retrying sub-agent spawn after exception",
                                    index=index,
                                    attempt=attempt,
                                    error=last_error,
                                    sleep_seconds=round(sleep_s, 2),
                                )
                                await asyncio.sleep(sleep_s)
                                continue
                            logger.error(
                                "Failed to spawn sub-agent - exception",
                                index=index,
                                goal=goal,
                                error=last_error,
                            )
                            break

                    return index, {"error": last_error, "goal": goal, "status": "FAILED"}

            tasks = [asyncio.create_task(spawn_one_with_retry(i, agent_cfg)) for i, agent_cfg in enumerate(sub_agents)]

            spawned: List[Dict[str, Any]] = [{} for _ in sub_agents]
            for finished in asyncio.as_completed(tasks):
                idx, result = await finished
                spawned[idx] = result

            completed = sum(1 for s in spawned if s.get("status") != "FAILED")
            failed = sum(1 for s in spawned if s.get("status") == "FAILED")

            return SpawnResult(spawned=len(spawned), completed=completed, failed=failed, agents=spawned)

    except Exception as e:
        logger.error("Failed to spawn sub-agents", error=str(e))
        raise
