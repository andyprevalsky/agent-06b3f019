"""Data access for the root agent's project list.

    fetch_projects               ──▶ GET /api/projects                 (X-API-Key + X-User-Id)
    fetch_github_repo_inventory  ──▶ GET /api/integrations/github/repos (X-API-Key + X-User-Id)

The backend scopes both to the user. Projects: every connected GitHub repo is a
project, plus projects imported from the user's computer and projects teammates
shared through a team; folders (isRepository false) are dropped. Only id, name,
repoUrl, imported and shared (owner + team name) leave this module. Repos
(main #2238): connected AND still granted repos only, legacy project repos
imported first, plus repos teammates share with the user's teams (the internal
API key includes them); only repo_name, repo_url and canonical_ref leave this
module, plus a shared repo's sanitized owner and team names. Any failure is
None (unavailable, not empty).
"""

from __future__ import annotations

from typing import List, Optional

import structlog

from config import load_config
from domains.github_repo_inventory.config import (
    GITHUB_REPO_INVENTORY_PATH,
    GITHUB_REPO_INVENTORY_TIMEOUT_SECONDS,
    PROJECT_INVENTORY_TIMEOUT_SECONDS,
    PROJECTS_PATH,
)
from domains.github_repo_inventory.types import GithubRepoEntry, ProjectEntry, SharedBy
from helpers.github_repo_inventory import compact_github_repos, compact_projects
from helpers.http_client import get_http_client

logger = structlog.get_logger()


async def fetch_projects(user_id: str) -> Optional[List[ProjectEntry]]:
    """The user's projects, compacted; None on a missing key, non-2xx or any error."""
    config = load_config()
    if not config.backend.api_key or not user_id:
        return None
    try:
        response = await get_http_client().get(
            f"{config.backend.api_url.rstrip('/')}{PROJECTS_PATH}",
            headers={"X-API-Key": config.backend.api_key, "X-User-Id": user_id},
            timeout=PROJECT_INVENTORY_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.warning("[ProjectInventory] project list unavailable", status=response.status_code)
            return None
        payload = response.json()
        entries = payload.get("projects") if isinstance(payload, dict) else None
        if not isinstance(entries, list):
            logger.warning("[ProjectInventory] project list malformed", payload_type=type(entries).__name__)
            return None
        projects = compact_projects(entries)
    except Exception as exc:  # timeout, transport, malformed JSON: unavailable, not "no projects"
        logger.warning("[ProjectInventory] project list fetch failed", error=type(exc).__name__)
        return None
    logger.info("[ProjectInventory] project list fetched", count=len(projects), received=len(entries))
    return [
        ProjectEntry(
            id=p["id"], name=p["name"], repoUrl=p["repoUrl"], imported=p["imported"], shared=_shared_by(p["shared"])
        )
        for p in projects
    ]


def _shared_by(shared: Optional[dict]) -> Optional[SharedBy]:
    return SharedBy(ownerName=shared["ownerName"], teamName=shared["teamName"]) if shared else None


async def fetch_github_repo_inventory(user_id: str) -> Optional[List[GithubRepoEntry]]:
    """The user's connected repos, compacted; None on a missing key, non-2xx or any error."""
    config = load_config()
    if not config.backend.api_key or not user_id:
        return None
    try:
        response = await get_http_client().get(
            f"{config.backend.api_url.rstrip('/')}{GITHUB_REPO_INVENTORY_PATH}",
            headers={"X-API-Key": config.backend.api_key, "X-User-Id": user_id},
            timeout=GITHUB_REPO_INVENTORY_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.warning("[GithubRepoInventory] inventory unavailable", status=response.status_code)
            return None
        payload = response.json()
        entries = payload.get("repos") if isinstance(payload, dict) else payload
        if not isinstance(entries, list):
            logger.warning("[GithubRepoInventory] inventory malformed", payload_type=type(entries).__name__)
            return None
        repos = compact_github_repos(entries)
    except Exception as exc:  # timeout, transport, malformed JSON: unavailable, not "no repos"
        logger.warning("[GithubRepoInventory] inventory fetch failed", error=type(exc).__name__)
        return None
    logger.info("[GithubRepoInventory] inventory fetched", count=len(repos))
    return [_entry(r) for r in repos]


def _entry(repo: dict) -> GithubRepoEntry:
    entry = GithubRepoEntry(repo_name=repo["repo_name"], repo_url=repo["repo_url"], canonical_ref=repo["canonical_ref"])
    if "shared_team" in repo:  # a teammate's shared repo keeps its sanitized owner and team
        entry["shared_by"] = repo["shared_by"]
        entry["shared_team"] = repo["shared_team"]
    return entry
