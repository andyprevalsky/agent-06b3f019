"""Spawn-claude-code-agent domain data access — HTTP calls to back-end API."""

from __future__ import annotations

import uuid as uuid_module
from typing import Any, Optional

import httpx
import structlog

from config import load_config
from tools.base import MessageStatus
from utils.error_utils import extract_error_message

logger = structlog.get_logger()


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
) -> None:
    """Save Claude Code sub-action message directly to DB via back-end API."""
    config = load_config()
    unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

    metadata: dict[str, Any] = {
        "toolCallId": unique_tool_call_id,
        "toolName": "spawn_claude_code_agent",
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

    if not is_init_message:
        metadata["subAgentId"] = task_id

    if status == MessageStatus.ERROR:
        metadata["error"] = True

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json",
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata,
                },
            )
            logger.info(
                "[ClaudeCode] Saved message",
                agent_id=agent_id,
                task_id=task_id,
                title=title,
                status=status.value,
                response_status=response.status_code,
            )
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
) -> dict[str, Any]:
    """Create an E2B sandbox session via back-end API.

    Returns the session data dict with task_id, sandbox_id, ws_url, etc.
    Raises on HTTP failure.
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
    if github_repo_url:
        create_payload["github_repo_url"] = github_repo_url

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{config.backend.api_url}{_session_base_path(code_provider)}/create",
            headers={
                "x-api-key": config.backend.api_key or "",
                "Content-Type": "application/json",
            },
            json=create_payload,
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
            raise Exception(
                f"Failed to create code session (provider={code_provider}): "
                f"HTTP {response.status_code}{detail}"
            )

        return response.json()


async def persist_terminal_output(
    task_id: str,
    output: str,
    agent_id: str,
    code_provider: str = "claude",
) -> None:
    """Persist filtered terminal output to DB."""
    config = load_config()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            output_response = await client.post(
                f"{config.backend.api_url}{_session_base_path(code_provider)}/{task_id}/output",
                headers={"x-api-key": config.backend.api_key or ""},
                json={"output": output},
            )
            logger.info(
                "[ClaudeCode] Output persisted",
                agent_id=agent_id,
                task_id=task_id,
                output_len=len(output),
                response_status=output_response.status_code,
            )
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
    except Exception as e:
        logger.warning(
            "[ClaudeCode] Failed to close session",
            task_id=task_id,
            error=extract_error_message(e),
        )
        return {}


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
    except Exception as health_err:
        logger.warning(
            "[ClaudeCode] Failed to check sandbox health",
            agent_id=agent_id,
            error=str(health_err),
        )
    return None
