"""Spawn-claude-code-agent domain data access — HTTP calls to back-end API."""

from __future__ import annotations

import uuid as uuid_module
from typing import Any, Optional

import httpx
import structlog
from temporalio.exceptions import ApplicationError

from config import load_config
from domains.spawn_claude_code_agent.config import LOCAL_TARGET_UNAVAILABLE_CODE
from helpers.workflow_generation import (
    WorkflowGenerationSealed,
    raise_if_generation_sealed,
    stamp_tool_workflow_generation,
    workflow_generation_headers,
)
from tools.base import MessageStatus
from utils.error_utils import extract_error_message

logger = structlog.get_logger()


def _json_or_empty(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _session_base_path(code_provider: str = "claude") -> str:
    if code_provider == "codex":
        return "/api/codex-code-session"
    return "/api/claude-code-session"


async def save_claude_code_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    action_type: str = "default",
    tool_call_id: Optional[str] = None,
    is_init_message: bool = False,
    ws_url: Optional[str] = None,
    output_schema: Optional[dict] = None,
    structured_response: Optional[dict] = None,
    github_repo_url: Optional[str] = None,
    code_provider: str = "claude",
    completed_turns: Optional[int] = None,
    tool_name: Optional[str] = None,
    agent_type: Optional[str] = None,
    steps_taken: Optional[int] = None,
    code_agent: Optional[dict[str, Any]] = None,
) -> None:
    """Save Claude Code sub-action message directly to DB via back-end API.

    ``code_agent`` merges into ``metadata.code_agent`` (this lane owns its
    ``target`` and ``device_name`` keys; other lanes own the rest).
    """
    config = load_config()
    unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

    metadata: dict[str, Any] = {
        "toolCallId": unique_tool_call_id,
        "toolName": tool_name or "spawn_claude_code_agent",
        "toolStatus": status.value,
        "title": title,
        "task_id": task_id,
        "action_type": action_type,
        "code_provider": code_provider,
    }

    if ws_url:
        metadata["ws_url"] = ws_url

    # Include output schema in init message for FE display
    if output_schema:
        metadata["output_schema"] = output_schema

    # Include structured response in task_complete message for FE display
    if structured_response:
        metadata["structured_response"] = structured_response

    if github_repo_url:
        metadata["github_repo_url"] = github_repo_url

    if completed_turns is not None:
        metadata["completed_turns"] = max(0, int(completed_turns))

    # Non-orchestration evidence chips (SDK events / history) need an explicit
    # agentType so harness `_agent_class_step_counts` attributes them to `code`.
    if agent_type:
        metadata["agentType"] = agent_type

    if steps_taken is not None:
        metadata["steps_taken"] = max(0, int(steps_taken))

    if code_agent:
        existing = metadata.get("code_agent")
        metadata["code_agent"] = {**(existing if isinstance(existing, dict) else {}), **code_agent}
    # Intermediate chip rows (progress, task_started, system) are child-scoped
    # UI and must stay out of the parent LLM context via subAgentId.
    # Parent-facing task_complete terminals reuse the spawn toolCallId — if they
    # are also marked subAgentId, drop_rows_never_sent_to_model strips them and
    # the ASSISTANT tool_call is left unpaired (role_alternation). That happens
    # on cancel/DAG-cancel when the handler never yields a twin ERROR event and
    # Session Cancelled from this helper is the only terminal for the toolCallId.
    if not is_init_message and action_type != "task_complete":
        metadata["subAgentId"] = task_id

    if status == MessageStatus.ERROR:
        metadata["error"] = True
    metadata = stamp_tool_workflow_generation(metadata) or metadata

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json",
                    **workflow_generation_headers(),
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata,
                },
            )
            raise_if_generation_sealed(response.status_code, "spawn_claude_code_agent")
            logger.info(
                "[ClaudeCode] Saved message",
                agent_id=agent_id,
                task_id=task_id,
                title=title,
                status=status.value,
                response_status=response.status_code,
            )
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        logger.error(
            "[ClaudeCode] Failed to save message",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(e),
        )


async def create_e2b_session(
    agent_id: str,
    goal: str,
    user_id: str,
    attachments: Optional[list[dict[str, Any]]] = None,
    github_repo_url: Optional[str] = None,
    code_provider: str = "claude",
    fast_mode_cache_enabled: bool = False,
    target: str = "cloud",
    local_device_id: Optional[str] = None,
) -> dict[str, Any]:
    """Create an E2B sandbox session via back-end API.

    Returns the session data dict with task_id, sandbox_id, ws_url, etc.
    Raises on HTTP failure. ``target="local"`` asks the backend to start the
    same ws-server on the agent's Mac instead; an unavailable Mac answers 409
    ``LOCAL_TARGET_UNAVAILABLE``, raised as a non-retryable error carrying the
    exact user-facing text (no retry, no cloud fallback).
    """
    config = load_config()

    create_payload: dict[str, Any] = {
        "agent_id": agent_id,
        "goal": goal,
        "user_id": user_id,
        "fast_mode_cache_enabled": fast_mode_cache_enabled,
    }
    if attachments:
        create_payload["attachments"] = attachments
    if github_repo_url and target != "local":
        create_payload["github_repo_url"] = github_repo_url
    if target == "local":
        create_payload["target"] = "local"
        if local_device_id:
            create_payload["device_id"] = local_device_id

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{config.backend.api_url}{_session_base_path(code_provider)}/create",
            headers={
                "x-api-key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json=create_payload,
        )

        if response.status_code == 409 and target == "local":
            body = _json_or_empty(response)
            if body.get("code") == LOCAL_TARGET_UNAVAILABLE_CODE and isinstance(body.get("error"), str):
                raise ApplicationError(
                    body["error"],
                    {"reason": body.get("reason"), "device_name": body.get("device_name")},
                    type=LOCAL_TARGET_UNAVAILABLE_CODE,
                    non_retryable=True,
                )

        if response.status_code not in (200, 201):
            response_text = response.text[:500]
            logger.error(
                "[ClaudeCode] Failed to create code session",
                agent_id=agent_id,
                code_provider=code_provider,
                status_code=response.status_code,
                response_text=response_text,
            )
            detail = f": {response_text}" if response_text else ""
            message = (
                f"Failed to create code session (provider={code_provider}): "
                f"HTTP {response.status_code}{detail}"
            )
            upper = f"{message} {response_text}".upper()
            billing_markers = (
                "MISSING PAYMENT METHOD",
                "TEAM IS BLOCKED",
                "CREDIT BALANCE IS TOO LOW",
                "TOO LOW TO ACCESS THE ANTHROPIC API",
                "YOUR CREDIT BALANCE IS TOO LOW",
            )
            if any(m in upper for m in billing_markers):
                # Permanent billing blocks must not burn activity retries —
                # the tool manager soft-fails and the agent continues.
                raise ApplicationError(
                    message,
                    type="ClaudeCodeBillingBlocked",
                    non_retryable=True,
                )
            raise Exception(message)

        return response.json()


async def persist_terminal_output(
    task_id: str,
    output: str,
    agent_id: str,
    code_provider: str = "claude",
    credential_feedback: Optional[list[dict[str, str]]] = None,
) -> None:
    """Persist filtered terminal output to DB."""
    config = load_config()
    body: dict[str, Any] = {"output": output}
    if credential_feedback is not None:
        body["credential_feedback"] = credential_feedback
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            output_response = await client.post(
                f"{config.backend.api_url}{_session_base_path(code_provider)}/{task_id}/output",
                headers={"x-api-key": config.backend.api_key or ""},
                json=body,
            )
            logger.info(
                "[ClaudeCode] Output persisted",
                agent_id=agent_id,
                task_id=task_id,
                output_len=len(output),
                response_status=output_response.status_code,
            )
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        logger.warning(
            "[ClaudeCode] Failed to persist output",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(e),
        )


async def close_e2b_session(
    task_id: str,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    additional_paths: Optional[list[str]] = None,
    code_provider: str = "claude",
) -> dict[str, Any]:
    """Close the E2B sandbox session and extract output files.

    Returns dict with output_files and usage, or empty dict on failure.
    """
    config = load_config()
    payload: dict[str, Any] = {"task_id": task_id}
    if user_id:
        payload["user_id"] = user_id
    if agent_id:
        payload["agent_id"] = agent_id
    if additional_paths:
        payload["additional_paths"] = additional_paths

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            close_response = await client.post(
                f"{config.backend.api_url}{_session_base_path(code_provider)}/close",
                headers={"x-api-key": config.backend.api_key or ""},
                json=payload,
            )
            if close_response.status_code == 200:
                return close_response.json()
            logger.warning(
                "[ClaudeCode] Close session returned non-200",
                task_id=task_id,
                status_code=close_response.status_code,
            )
            return {}
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as e:
        logger.warning(
            "[ClaudeCode] Failed to close session",
            task_id=task_id,
            error=extract_error_message(e),
        )
        return {}


async def fetch_local_agent_target(agent_id: str) -> dict[str, Any]:
    """Ask the backend whether ``agent_id`` may run a code agent on its Mac now.

    ``GET /api/local-devices/agent-target/:agentId`` answers from the agent
    tree's recorded origin and the Mac's live control channel; it never waits.
    """
    config = load_config()
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/local-devices/agent-target/{agent_id}",
            headers={"x-api-key": config.backend.api_key or ""},
        )
    if response.status_code != 200:
        raise RuntimeError(
            f"Local target lookup failed for agent {agent_id}: HTTP {response.status_code} {response.text[:200]}"
        )
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


async def check_sandbox_health(
    sandbox_id: str,
    agent_id: str,
    code_provider: str = "claude",
) -> Optional[dict[str, Any]]:
    """Check E2B sandbox health. Returns health dict or None on failure."""
    config = load_config()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            health_resp = await client.get(
                f"{config.backend.api_url}{_session_base_path(code_provider)}/{sandbox_id}/health",
                headers={"x-api-key": config.backend.api_key or ""},
            )
            if health_resp.status_code == 200:
                return health_resp.json()
    except WorkflowGenerationSealed:
        raise  # a replaced generation must stop, never be swallowed
    except Exception as health_err:
        logger.warning(
            "[ClaudeCode] Failed to check sandbox health",
            agent_id=agent_id,
            error=str(health_err),
        )
    return None
