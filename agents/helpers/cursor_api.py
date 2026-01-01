"""Cursor Cloud Agent API helper functions.

This module provides functions to interact with the Cursor Cloud Agent API
for launching and managing autonomous code agents.

API Documentation: https://cursor.com/docs/cloud-agent/api/endpoints
"""

import asyncio
import base64
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class CursorAgentStatus:
    """Status information for a Cursor Cloud Agent."""
    
    agent_id: str
    status: str  # "pending", "running", "completed", "failed", "cancelled"
    branch_name: Optional[str] = None
    commit_sha: Optional[str] = None
    error_message: Optional[str] = None
    files_changed: Optional[List[str]] = None


def _get_auth_header(api_key: str) -> str:
    """Generate Basic Auth header from API key.
    
    Cursor API uses Basic Auth with API key as username and empty password.
    """
    credentials = f"{api_key}:"
    encoded = base64.b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"


async def launch_cursor_agent(
    api_key: str,
    goal: str,
    github_repo: str,
    branch_name: str,
    base_url: str = "https://api.cursor.com/v1",
    auto_create_pr: bool = False,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Launch a new Cursor Cloud Agent to write code.
    
    Args:
        api_key: Cursor API key for authentication
        goal: The task/goal for the agent to accomplish
        github_repo: GitHub repository URL (e.g., "https://github.com/owner/repo")
        branch_name: Branch name to push code to
        base_url: Cursor API base URL
        auto_create_pr: Whether to automatically create a PR (default: False = push only)
        model: Optional model to use for code generation
        
    Returns:
        Dict containing:
        - agent_id: Unique ID of the launched agent
        - status: Initial status (usually "pending" or "running")
        - branch_name: The branch name being used
        
    Raises:
        httpx.HTTPStatusError: If the API request fails
    """
    headers = {
        "Authorization": _get_auth_header(api_key),
        "Content-Type": "application/json"
    }
    
    payload = {
        "prompt": goal,
        "githubRepo": github_repo,
        "branch": branch_name,
        "autoCreatePr": auto_create_pr,
    }
    
    if model:
        payload["model"] = model
    
    logger.info(
        "Launching Cursor agent",
        github_repo=github_repo,
        branch_name=branch_name,
        goal=goal[:100] + "..." if len(goal) > 100 else goal
    )
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{base_url}/agents",
            headers=headers,
            json=payload
        )
        response.raise_for_status()
        
        data = response.json()
        
        logger.info(
            "Cursor agent launched",
            agent_id=data.get("id") or data.get("agentId"),
            status=data.get("status")
        )
        
        return {
            "agent_id": data.get("id") or data.get("agentId"),
            "status": data.get("status", "pending"),
            "branch_name": branch_name,
        }


async def get_cursor_agent_status(
    api_key: str,
    agent_id: str,
    base_url: str = "https://api.cursor.com/v1",
) -> CursorAgentStatus:
    """
    Get the current status of a Cursor Cloud Agent.
    
    Args:
        api_key: Cursor API key for authentication
        agent_id: The agent's unique ID
        base_url: Cursor API base URL
        
    Returns:
        CursorAgentStatus with current status information
        
    Raises:
        httpx.HTTPStatusError: If the API request fails
    """
    headers = {
        "Authorization": _get_auth_header(api_key),
    }
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{base_url}/agents/{agent_id}",
            headers=headers
        )
        response.raise_for_status()
        
        data = response.json()
        
        return CursorAgentStatus(
            agent_id=agent_id,
            status=data.get("status", "unknown"),
            branch_name=data.get("branch"),
            commit_sha=data.get("commitSha"),
            error_message=data.get("error"),
            files_changed=data.get("filesChanged"),
        )


async def poll_cursor_agent_status(
    api_key: str,
    agent_id: str,
    base_url: str = "https://api.cursor.com/v1",
    poll_interval: float = 5.0,
    timeout: float = 600.0,
    on_status_update: Optional[callable] = None,
) -> CursorAgentStatus:
    """
    Poll a Cursor Cloud Agent until it completes or fails.
    
    Args:
        api_key: Cursor API key for authentication
        agent_id: The agent's unique ID
        base_url: Cursor API base URL
        poll_interval: Seconds between status checks (default: 5)
        timeout: Maximum seconds to wait (default: 600 = 10 minutes)
        on_status_update: Optional callback called on each status update
        
    Returns:
        Final CursorAgentStatus when agent completes
        
    Raises:
        TimeoutError: If agent doesn't complete within timeout
        httpx.HTTPStatusError: If the API request fails
    """
    start_time = asyncio.get_event_loop().time()
    last_status = None
    
    logger.info("Starting to poll Cursor agent status", agent_id=agent_id)
    
    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout:
            raise TimeoutError(f"Cursor agent {agent_id} did not complete within {timeout}s")
        
        status = await get_cursor_agent_status(api_key, agent_id, base_url)
        
        # Log status changes
        if status.status != last_status:
            logger.info(
                "Cursor agent status changed",
                agent_id=agent_id,
                status=status.status,
                elapsed_seconds=round(elapsed, 1)
            )
            last_status = status.status
            
            # Call callback if provided
            if on_status_update:
                try:
                    await on_status_update(status)
                except Exception as e:
                    logger.warning("Status update callback failed", error=str(e))
        
        # Check for terminal states
        if status.status in ("completed", "failed", "cancelled"):
            logger.info(
                "Cursor agent finished",
                agent_id=agent_id,
                status=status.status,
                elapsed_seconds=round(elapsed, 1),
                files_changed=status.files_changed
            )
            return status
        
        await asyncio.sleep(poll_interval)


async def stop_cursor_agent(
    api_key: str,
    agent_id: str,
    base_url: str = "https://api.cursor.com/v1",
) -> bool:
    """
    Stop a running Cursor Cloud Agent.
    
    Args:
        api_key: Cursor API key for authentication
        agent_id: The agent's unique ID
        base_url: Cursor API base URL
        
    Returns:
        True if agent was stopped successfully
        
    Raises:
        httpx.HTTPStatusError: If the API request fails
    """
    headers = {
        "Authorization": _get_auth_header(api_key),
    }
    
    logger.info("Stopping Cursor agent", agent_id=agent_id)
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{base_url}/agents/{agent_id}/stop",
            headers=headers
        )
        response.raise_for_status()
        
        logger.info("Cursor agent stopped", agent_id=agent_id)
        return True


async def get_cursor_agent_conversation(
    api_key: str,
    agent_id: str,
    base_url: str = "https://api.cursor.com/v1",
) -> List[Dict[str, Any]]:
    """
    Get the conversation history for a Cursor Cloud Agent.
    
    Args:
        api_key: Cursor API key for authentication
        agent_id: The agent's unique ID
        base_url: Cursor API base URL
        
    Returns:
        List of conversation messages
        
    Raises:
        httpx.HTTPStatusError: If the API request fails
    """
    headers = {
        "Authorization": _get_auth_header(api_key),
    }
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{base_url}/agents/{agent_id}/conversation",
            headers=headers
        )
        response.raise_for_status()
        
        data = response.json()
        return data.get("messages", [])




