"""Data access for the root agent's GitHub repo inventory.

    fetch_github_repo_inventory ──▶ GET /api/integrations/github/repos  (X-API-Key + X-User-Id)

The backend scopes the inventory to the user (connected AND still granted
repos only, legacy project repos imported first). Only repo_name, repo_url
and canonical_ref leave this module; any failure is an empty inventory.
"""

from __future__ import annotations

from typing import List

import structlog

from config import load_config
from domains.github_repo_inventory.config import (
    GITHUB_REPO_INVENTORY_PATH,
    GITHUB_REPO_INVENTORY_TIMEOUT_SECONDS,
)
from domains.github_repo_inventory.types import GithubRepoEntry
from helpers.github_repo_inventory import compact_github_repos
from helpers.http_client import get_http_client

logger = structlog.get_logger()


async def fetch_github_repo_inventory(user_id: str) -> List[GithubRepoEntry]:
    """The user's connected repos, compacted; ``[]`` on a missing key, non-2xx or any error."""
    config = load_config()
    if not config.backend.api_key or not user_id:
        return []
    try:
        response = await get_http_client().get(
            f"{config.backend.api_url.rstrip('/')}{GITHUB_REPO_INVENTORY_PATH}",
            headers={"X-API-Key": config.backend.api_key, "X-User-Id": user_id},
            timeout=GITHUB_REPO_INVENTORY_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.warning("[GithubRepoInventory] inventory unavailable", status=response.status_code)
            return []
        repos = compact_github_repos(response.json())
    except Exception as exc:  # timeout, transport, malformed JSON: omit the section
        logger.warning("[GithubRepoInventory] inventory fetch failed", error=type(exc).__name__)
        return []
    logger.info("[GithubRepoInventory] inventory fetched", count=len(repos))
    return [
        GithubRepoEntry(repo_name=r["repo_name"], repo_url=r["repo_url"], canonical_ref=r["canonical_ref"])
        for r in repos
    ]
