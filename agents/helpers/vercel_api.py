"""Vercel API helper functions.

This module provides functions to interact with the Vercel API
for managing preview deployments.

API Documentation: https://vercel.com/docs/rest-api
"""

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class VercelProject:
    """Information about a Vercel project."""
    
    id: str
    name: str
    github_repo: Optional[str] = None
    production_url: Optional[str] = None


@dataclass
class VercelDeployment:
    """Information about a Vercel deployment."""
    
    id: str
    url: str
    state: str  # "BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED"
    branch: Optional[str] = None
    created_at: Optional[str] = None


def _parse_github_repo(repo_url: str) -> tuple[str, str]:
    """
    Parse GitHub repo URL or owner/repo format into owner and repo name.
    
    Args:
        repo_url: GitHub URL or "owner/repo" format
        
    Returns:
        Tuple of (owner, repo_name)
        
    Raises:
        ValueError: If the repo URL format is invalid
    """
    # Handle "owner/repo" format
    if "/" in repo_url and "://" not in repo_url:
        parts = repo_url.split("/")
        if len(parts) == 2:
            return parts[0], parts[1]
    
    # Handle full URL format
    parsed = urlparse(repo_url)
    if parsed.netloc == "github.com":
        path_parts = parsed.path.strip("/").split("/")
        if len(path_parts) >= 2:
            # Remove .git suffix if present
            repo_name = path_parts[1].replace(".git", "")
            return path_parts[0], repo_name
    
    raise ValueError(f"Invalid GitHub repo format: {repo_url}")


async def ensure_vercel_project(
    token: str,
    github_repo: str,
    team_id: Optional[str] = None,
) -> VercelProject:
    """
    Ensure a Vercel project exists for the given GitHub repository.
    
    If a project linked to the repo already exists, returns it.
    Otherwise, creates a new project and links it to the GitHub repo.
    
    Args:
        token: Vercel API token
        github_repo: GitHub repository URL or "owner/repo" format
        team_id: Optional Vercel team ID
        
    Returns:
        VercelProject with project details
        
    Raises:
        httpx.HTTPStatusError: If the API request fails
    """
    owner, repo_name = _parse_github_repo(github_repo)
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    params = {}
    if team_id:
        params["teamId"] = team_id
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        # First, try to find an existing project linked to this repo
        logger.info("Checking for existing Vercel project", github_repo=f"{owner}/{repo_name}")
        
        list_response = await client.get(
            "https://api.vercel.com/v9/projects",
            headers=headers,
            params={**params, "limit": 100}
        )
        list_response.raise_for_status()
        
        projects_data = list_response.json()
        
        for project in projects_data.get("projects", []):
            # Check if project is linked to the GitHub repo
            git_repo = project.get("link", {}).get("repo")
            if git_repo:
                project_owner = project["link"].get("org") or project["link"].get("owner")
                if project_owner == owner and git_repo == repo_name:
                    logger.info(
                        "Found existing Vercel project",
                        project_id=project["id"],
                        project_name=project["name"]
                    )
                    return VercelProject(
                        id=project["id"],
                        name=project["name"],
                        github_repo=f"{owner}/{repo_name}",
                        production_url=project.get("alias", [{}])[0].get("domain") if project.get("alias") else None
                    )
        
        # No existing project found - create a new one
        logger.info("Creating new Vercel project", github_repo=f"{owner}/{repo_name}")
        
        # Generate a project name from repo name
        project_name = f"{repo_name}-preview".lower()
        # Vercel names must be lowercase, alphanumeric, and hyphens only
        project_name = re.sub(r'[^a-z0-9-]', '-', project_name)
        project_name = re.sub(r'-+', '-', project_name).strip('-')
        
        create_payload = {
            "name": project_name,
            "gitRepository": {
                "type": "github",
                "repo": f"{owner}/{repo_name}"
            }
        }
        
        create_response = await client.post(
            "https://api.vercel.com/v10/projects",
            headers=headers,
            params=params,
            json=create_payload
        )
        
        if create_response.status_code == 409:
            # Project name already exists - try with a suffix
            import uuid
            project_name = f"{project_name}-{uuid.uuid4().hex[:6]}"
            create_payload["name"] = project_name
            
            create_response = await client.post(
                "https://api.vercel.com/v10/projects",
                headers=headers,
                params=params,
                json=create_payload
            )
        
        create_response.raise_for_status()
        project_data = create_response.json()
        
        logger.info(
            "Created new Vercel project",
            project_id=project_data["id"],
            project_name=project_data["name"]
        )
        
        return VercelProject(
            id=project_data["id"],
            name=project_data["name"],
            github_repo=f"{owner}/{repo_name}",
            production_url=None
        )


async def get_deployment_for_branch(
    token: str,
    project_id: str,
    branch_name: str,
    team_id: Optional[str] = None,
) -> Optional[VercelDeployment]:
    """
    Get the latest deployment for a specific branch.
    
    Args:
        token: Vercel API token
        project_id: Vercel project ID
        branch_name: Git branch name to find deployment for
        team_id: Optional Vercel team ID
        
    Returns:
        VercelDeployment if found, None otherwise
    """
    headers = {
        "Authorization": f"Bearer {token}",
    }
    
    params = {
        "projectId": project_id,
        "limit": 10,
    }
    if team_id:
        params["teamId"] = team_id
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            "https://api.vercel.com/v6/deployments",
            headers=headers,
            params=params
        )
        response.raise_for_status()
        
        deployments = response.json().get("deployments", [])
        
        for deployment in deployments:
            # Check if deployment is for the target branch
            git_source = deployment.get("meta", {})
            deployment_branch = git_source.get("githubCommitRef") or git_source.get("gitBranch")
            
            if deployment_branch == branch_name:
                return VercelDeployment(
                    id=deployment["uid"],
                    url=f"https://{deployment['url']}",
                    state=deployment["state"],
                    branch=deployment_branch,
                    created_at=deployment.get("created")
                )
        
        return None


async def get_vercel_preview_url(
    token: str,
    project_id: str,
    branch_name: str,
    team_id: Optional[str] = None,
    poll_interval: float = 5.0,
    timeout: float = 300.0,
    on_status_update: Optional[callable] = None,
) -> str:
    """
    Poll Vercel until a deployment is ready and return the preview URL.
    
    Args:
        token: Vercel API token
        project_id: Vercel project ID
        branch_name: Git branch name to find deployment for
        team_id: Optional Vercel team ID
        poll_interval: Seconds between status checks (default: 5)
        timeout: Maximum seconds to wait (default: 300 = 5 minutes)
        on_status_update: Optional callback called on status changes
        
    Returns:
        Preview URL when deployment is ready
        
    Raises:
        TimeoutError: If deployment doesn't become ready within timeout
        RuntimeError: If deployment fails
    """
    start_time = asyncio.get_event_loop().time()
    last_state = None
    
    logger.info(
        "Polling for Vercel deployment",
        project_id=project_id,
        branch_name=branch_name
    )
    
    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout:
            raise TimeoutError(f"Vercel deployment for branch {branch_name} did not complete within {timeout}s")
        
        deployment = await get_deployment_for_branch(
            token=token,
            project_id=project_id,
            branch_name=branch_name,
            team_id=team_id
        )
        
        if deployment:
            # Log state changes
            if deployment.state != last_state:
                logger.info(
                    "Vercel deployment state changed",
                    deployment_id=deployment.id,
                    state=deployment.state,
                    elapsed_seconds=round(elapsed, 1)
                )
                last_state = deployment.state
                
                # Call callback if provided
                if on_status_update:
                    try:
                        await on_status_update(deployment)
                    except Exception as e:
                        logger.warning("Status update callback failed", error=str(e))
            
            # Check for terminal states
            if deployment.state == "READY":
                logger.info(
                    "Vercel deployment ready",
                    url=deployment.url,
                    elapsed_seconds=round(elapsed, 1)
                )
                return deployment.url
            
            if deployment.state == "ERROR":
                raise RuntimeError(f"Vercel deployment failed for branch {branch_name}")
            
            if deployment.state == "CANCELED":
                raise RuntimeError(f"Vercel deployment was canceled for branch {branch_name}")
        else:
            logger.debug(
                "No deployment found yet",
                branch_name=branch_name,
                elapsed_seconds=round(elapsed, 1)
            )
        
        await asyncio.sleep(poll_interval)


async def list_deployments(
    token: str,
    project_id: str,
    team_id: Optional[str] = None,
    limit: int = 20,
) -> List[VercelDeployment]:
    """
    List recent deployments for a project.
    
    Args:
        token: Vercel API token
        project_id: Vercel project ID
        team_id: Optional Vercel team ID
        limit: Maximum number of deployments to return
        
    Returns:
        List of VercelDeployment objects
    """
    headers = {
        "Authorization": f"Bearer {token}",
    }
    
    params = {
        "projectId": project_id,
        "limit": limit,
    }
    if team_id:
        params["teamId"] = team_id
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            "https://api.vercel.com/v6/deployments",
            headers=headers,
            params=params
        )
        response.raise_for_status()
        
        deployments = []
        for d in response.json().get("deployments", []):
            git_source = d.get("meta", {})
            deployments.append(VercelDeployment(
                id=d["uid"],
                url=f"https://{d['url']}",
                state=d["state"],
                branch=git_source.get("githubCommitRef") or git_source.get("gitBranch"),
                created_at=d.get("created")
            ))
        
        return deployments

