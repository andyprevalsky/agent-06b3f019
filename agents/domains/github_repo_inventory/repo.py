"""Data access for the root agent's project list.

    fetch_projects ──▶ GET /api/projects  (X-API-Key + X-User-Id)

The backend scopes the list to the user (every connected GitHub repo is a
project, plus projects imported from the user's computer and projects teammates
shared through a team); folders (isRepository false) are dropped. Only id, name,
repoUrl, imported and shared (owner + team name) leave this module; any failure
is None (unavailable, not empty).
"""

from __future__ import annotations

from typing import List, Optional

import structlog

from config import load_config
from domains.github_repo_inventory.config import PROJECT_INVENTORY_TIMEOUT_SECONDS, PROJECTS_PATH
from domains.github_repo_inventory.types import ProjectEntry, SharedBy
from helpers.github_repo_inventory import compact_projects
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
