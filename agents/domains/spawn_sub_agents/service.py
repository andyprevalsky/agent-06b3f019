"""Spawn-sub-agents domain service — business logic for spawning and managing sub-agents."""

from __future__ import annotations

import asyncio
import random
import uuid
from typing import Any, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity
from temporalio.exceptions import ApplicationError

from config import load_config
from domains.spawn_sub_agents.config import (
    BASE_BACKOFF_SECONDS,
    MAX_PARALLEL_SPAWNS,
    MAX_SPAWN_ATTEMPTS,
    RETRYABLE_STATUS_CODES,
)
from domains.spawn_sub_agents.repo import (
    create_sub_agent,
    create_sub_agents_batch,
    fetch_parent_attachments,
    spawn_http_client,
)
from domains.spawn_sub_agents.types import SpawnResult
from helpers.github_repo_ref import (
    GITHUB_REPO_NOT_CONNECTED_CODE,
    explicit_github_repo_ref,
    is_repo_not_connected_response,
    repo_not_connected_message,
)
from helpers.tracing import traced

logger = structlog.get_logger()

# Type alias for the serialisable attachment dicts returned by
# fetch_parent_attachments_activity and accepted by spawn_sub_agent_activity.
ParentAttachments = Dict[str, Dict[str, Dict[str, Any]]]


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
    fields_by_name = _schema_fields_by_name(output_schema.get("fields", []))

    for key, value in structured_response.items():
        file_pointers.extend(_extract_file_pointers_by_schema(value, fields_by_name.get(key)))

    return file_pointers


def _schema_fields_by_name(fields: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(fields, list):
        return {}
    by_name: Dict[str, Dict[str, Any]] = {}
    for field in fields:
        if isinstance(field, dict) and isinstance(field.get("name"), str):
            by_name[field["name"]] = field
    return by_name


def _extract_file_pointers_by_schema(value: Any, field_schema: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    field_type = field_schema.get("type") if isinstance(field_schema, dict) else None

    if field_type == "file_pointer":
        return [value] if _is_full_file_pointer(value) else []

    if field_type == "list[file_pointer]" and isinstance(value, list):
        return [item for item in value if _is_full_file_pointer(item)]

    if field_type == "object" and isinstance(value, dict):
        return _extract_file_pointers_from_object(
            value,
            field_schema.get("properties") if isinstance(field_schema, dict) else None,
        )

    if field_type == "list[object]" and isinstance(value, list):
        file_pointers: list[Dict[str, Any]] = []
        properties = field_schema.get("properties") if isinstance(field_schema, dict) else None
        for item in value:
            if isinstance(item, dict):
                file_pointers.extend(_extract_file_pointers_from_object(item, properties))
        return file_pointers

    return []


def _extract_file_pointers_from_object(value: Dict[str, Any], fields: Any) -> List[Dict[str, Any]]:
    file_pointers: list[Dict[str, Any]] = []
    fields_by_name = _schema_fields_by_name(fields)
    for key, item in value.items():
        file_pointers.extend(_extract_file_pointers_by_schema(item, fields_by_name.get(key)))
    return file_pointers


def _is_full_file_pointer(value: Any) -> bool:
    return bool(isinstance(value, dict) and value.get("id") and value.get("storage_path"))


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
    # Backend sets the child's path to <parent path>/<task_name> (409 on a live sibling).
    if agent_cfg.get("task_name"):
        payload["task_name"] = agent_cfg["task_name"]
    # Explicit connected-repo selection; omitted, the backend inherits the parent's ref.
    github_repo_ref = explicit_github_repo_ref(agent_cfg.get("github_repo_ref"))
    if github_repo_ref:
        payload["github_repo_ref"] = github_repo_ref

    return payload


# ---------------------------------------------------------------------------
# Temporal activity
# ---------------------------------------------------------------------------


@activity.defn
@traced("spawn_sub_agent_activity")
async def spawn_sub_agent_activity(
    user_id: str,
    sub_agents: List[Dict[str, Any]],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool,
    parent_model: str = "rose-labs/rose-1-flash",
    bus_id: str | None = None,
    parent_source: str = "WEB",
    parent_attachments: ParentAttachments | None = None,
    child_agent_ids: List[str] | None = None,
) -> SpawnResult:
    """Activity: Spawn multiple sub-agents to work on parallel subtasks.

    Args:
        user_id: User ID (agents will be created for this user)
        sub_agents: List of agent configs, each with:
            - goal (str): The subtask goal
            - start_phase (str, optional): "plan" (default) or "execute"
            - attachments (list[str], optional): Filenames to pass to this sub-agent
        parent_agent_id: Parent agent ID (for hierarchy)
        parent_workflow_id: Parent workflow ID (for signaling)
        depth: Nesting depth for children
        parent_is_paused: Whether parent is currently paused (children inherit this state)
        parent_model: Model from parent agent (inherited by all sub-agents)
        bus_id: Shared bus channel ID for sub-agent tree updates
        parent_source: Agent source from parent (WEB or MAC_APP), inherited by sub-agents
        parent_attachments: Pre-fetched parent attachment dicts (from
            fetch_parent_attachments_activity).  When provided the activity
            skips re-fetching them, eliminating N-1 redundant backend calls
            during batch spawns.

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

        if parent_attachments is not None:
            filename_to_pointer = parent_attachments.get("filename_to_pointer", {})
            all_pointers_by_id = parent_attachments.get("all_pointers_by_id", {})
        else:
            activity.heartbeat("Fetching parent agent's attachments...")
            filename_to_pointer, all_pointers_by_id = await fetch_parent_attachments(
                backend_url, api_key, parent_agent_id
            )

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
                    if child_agent_ids is not None and len(child_agent_ids) == len(sub_agents):
                        payload["agent_id"] = child_agent_ids[index]

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
                                    "task_path": data.get("task_path"),
                                    "github_repo_ref": data.get("github_repo_ref"),
                                }

                            status_code = response.status_code
                            response_text = response.text[:500]
                            last_error = f"HTTP {status_code}: {response_text}"
                            if payload.get("github_repo_ref") and is_repo_not_connected_response(
                                status_code, response_text
                            ):
                                last_error = repo_not_connected_message(payload["github_repo_ref"], last_error)
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


# ---------------------------------------------------------------------------
# Batch activity: one HTTP call → up to 200 sub-agents.
# ---------------------------------------------------------------------------


def _build_batch_payload_item(
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
    agent_id: str,
) -> Dict[str, Any]:
    """Build one entry of the batch POST body. Mirrors `build_spawn_payload`
    but adds `agent_id` so the call is idempotent on retry."""
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
    payload["agent_id"] = agent_id
    return payload


@activity.defn
@traced("spawn_sub_agents_batch_activity")
async def spawn_sub_agents_batch_activity(
    user_id: str,
    sub_agents: List[Dict[str, Any]],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool,
    parent_model: str = "rose-labs/rose-1-flash",
    bus_id: str | None = None,
    parent_source: str = "WEB",
    parent_attachments: ParentAttachments | None = None,
    child_agent_ids: List[str] | None = None,
) -> SpawnResult:
    """Spawn N sub-agents in one HTTP call to POST /api/agents/batch.

    Mints a stable agent_id per child upfront (or reuses ``child_agent_ids``
    when supplied) so that activity-level retries are idempotent: re-POSTing
    the same ids returns the existing rows untouched (already_existed=true).

    Retries the HTTP call on 429/5xx with exponential backoff per the existing
    constants (MAX_SPAWN_ATTEMPTS, BASE_BACKOFF_SECONDS). Permanent failures
    (4xx other than 429) propagate as activity errors so the workflow can
    decide whether to fail the for_each.
    """
    structlog.contextvars.bind_contextvars(agent_id=parent_agent_id)

    activity.heartbeat(f"Batch-spawning {len(sub_agents)} sub-agents")

    config = load_config()
    backend_url = config.backend.api_url.rstrip("/")
    api_key = config.backend.api_key
    if not api_key:
        raise ValueError("BACKEND_API_KEY not configured - required for spawning sub-agents")

    if parent_attachments is not None:
        filename_to_pointer = parent_attachments.get("filename_to_pointer", {})
        all_pointers_by_id = parent_attachments.get("all_pointers_by_id", {})
    else:
        activity.heartbeat("Fetching parent agent's attachments...")
        filename_to_pointer, all_pointers_by_id = await fetch_parent_attachments(backend_url, api_key, parent_agent_id)

    # Mint or reuse caller-supplied ids — used as the canonical agent_id for
    # each child row so retries from this activity are idempotent.
    minted_ids = (
        list(child_agent_ids)
        if child_agent_ids is not None and len(child_agent_ids) == len(sub_agents)
        else [str(uuid.uuid4()) for _ in sub_agents]
    )

    payloads = [
        _build_batch_payload_item(
            user_id=user_id,
            agent_cfg=agent_cfg,
            parent_agent_id=parent_agent_id,
            parent_workflow_id=parent_workflow_id,
            depth=depth,
            parent_is_paused=parent_is_paused,
            parent_model=parent_model,
            bus_id=bus_id,
            parent_source=parent_source,
            resolved_attachments=resolve_attachments_for_sub_agent(agent_cfg, filename_to_pointer, all_pointers_by_id),
            agent_id=minted_ids[i],
        )
        for i, agent_cfg in enumerate(sub_agents)
    ]

    last_error = "unknown error"
    async with spawn_http_client() as client:
        for attempt in range(1, MAX_SPAWN_ATTEMPTS + 1):
            try:
                activity.heartbeat(f"Batch attempt {attempt} ({len(payloads)} agents)")
                response = await create_sub_agents_batch(client, backend_url, api_key, payloads)

                # 201 (all succeeded) and 207 (partial workflow-start failure)
                # both carry a valid `results` body. 4xx (non-429) is permanent;
                # 429/5xx is retryable per existing convention.
                if response.status_code in (200, 201, 207):
                    body = response.json() or {}
                    results = body.get("results", [])
                    if not isinstance(results, list):
                        raise ValueError(f"Malformed batch response (no results array): {body}")
                    return _build_spawn_result_from_batch(results, sub_agents)

                status_code = response.status_code
                response_text = response.text[:500]
                last_error = f"HTTP {status_code}: {response_text}"
                if status_code in RETRYABLE_STATUS_CODES and attempt < MAX_SPAWN_ATTEMPTS:
                    delay = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
                    sleep_s = delay + random.uniform(0, delay * 0.3)
                    logger.warning(
                        "Retrying batch spawn after HTTP error",
                        attempt=attempt,
                        status_code=status_code,
                        sleep_seconds=round(sleep_s, 2),
                    )
                    await asyncio.sleep(sleep_s)
                    continue
                logger.error(
                    "Batch spawn HTTP error (non-retryable)",
                    status_code=status_code,
                    response_text=response_text,
                )
                refs = sorted({p["github_repo_ref"] for p in payloads if p.get("github_repo_ref")})
                if refs and is_repo_not_connected_response(status_code, response_text):
                    # The explicit repo is not connected: no child is created and none
                    # falls back to the parent's repo; a retry cannot connect it.
                    raise ApplicationError(
                        repo_not_connected_message(", ".join(refs), last_error),
                        type=GITHUB_REPO_NOT_CONNECTED_CODE,
                        non_retryable=True,
                    )
                raise RuntimeError(last_error)

            except ApplicationError:
                raise
            except Exception as exc:
                last_error = str(exc)
                if attempt < MAX_SPAWN_ATTEMPTS:
                    delay = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
                    sleep_s = delay + random.uniform(0, delay * 0.3)
                    logger.warning(
                        "Retrying batch spawn after exception",
                        attempt=attempt,
                        error=last_error,
                        sleep_seconds=round(sleep_s, 2),
                    )
                    await asyncio.sleep(sleep_s)
                    continue
                logger.error("Batch spawn failed (exhausted retries)", error=last_error)
                raise

    raise RuntimeError(f"Batch spawn unreachable end-of-loop: {last_error}")


def _build_spawn_result_from_batch(
    results: List[Dict[str, Any]],
    sub_agents: List[Dict[str, Any]],
) -> SpawnResult:
    """Reshape backend batch results into the same SpawnResult that today's
    per-child spawn_sub_agent_activity returns, so the for_each handler can
    drop in the new activity without changing its consumer code."""
    spawned: List[Dict[str, Any]] = []
    completed = 0
    failed = 0
    for i, r in enumerate(results):
        status = (r.get("status") or "").upper()
        agent_id = r.get("agent_id", "")
        goal = r.get("goal") or sub_agents[i].get("goal", "")
        if status == "FAILED":
            failed += 1
            spawned.append(
                {
                    "agent_id": agent_id,
                    "goal": goal,
                    "status": "FAILED",
                    "error": r.get("error") or "workflow start failed",
                }
            )
            continue
        completed += 1
        spawned.append(
            {
                "agent_id": agent_id,
                "temporal_workflow_id": r.get("temporal_workflow_id"),
                "goal": goal,
                "model": r.get("model"),
                "status": status or "STARTING_UP",
                "github_repo_ref": r.get("github_repo_ref"),
            }
        )
    return SpawnResult(
        spawned=len(spawned),
        completed=completed,
        failed=failed,
        agents=spawned,
    )
