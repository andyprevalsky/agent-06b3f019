"""Data access for the root agent's GitHub repo inventory.

    fetch_github_repo_inventory ──▶ GET /api/integrations/github/repos  (X-API-Key + X-User-Id)

The backend scopes the inventory to the user (connected AND still granted
repos only, legacy project repos imported first). Only repo_name, repo_url
and canonical_ref leave this module; any failure is None (unavailable, not empty).
"""

from __future__ import annotations

from typing import List, Optional

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
    return [
        GithubRepoEntry(repo_name=r["repo_name"], repo_url=r["repo_url"], canonical_ref=r["canonical_ref"])
        for r in repos
    ]
