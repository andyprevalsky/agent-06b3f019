"""Workflow-side entry point: the root's projects (and uncovered GitHub repos) for its environment block.

    AgentWorkflow._sync_environment_context (root only)
        ──▶ fetch_root_projects ──▶ fetch_github_repo_inventory_activity (one attempt)
        ──▶ {projects, repos, total} listing (capped entries + exact total; no entries =
            no projects), or None when either fetch failed or the result carries no
            project list or a malformed repo list (the environment block then keeps the
            listing the model was last shown)

Fetched live on every sync (no cache), so adding or removing a project shows up
on the root's next turn. Imported inside the Temporal workflow sandbox.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.github_repo_inventory.config import ACTIVITY_TIMEOUT
from domains.github_repo_inventory.service import fetch_github_repo_inventory_activity
from helpers.github_repo_inventory import project_listing


async def fetch_root_projects(workflow_instance: Any) -> Optional[Dict[str, Any]]:
    """The workflow user's ``{projects, repos, total}`` listing; empty without a user, None when unavailable."""
    user_id = getattr(workflow_instance, "user_id", None)
    if not isinstance(user_id, str) or not user_id:
        return {"projects": [], "repos": [], "total": 0}
    try:
        result = await workflow.execute_activity(
            fetch_github_repo_inventory_activity,
            args=[user_id],
            start_to_close_timeout=ACTIVITY_TIMEOUT,
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
    except Exception as exc:
        workflow.logger.warning(f"[environment] project list unavailable: {type(exc).__name__}")
        return None
    if not isinstance(result, dict) or result.get("available") is False:
        workflow.logger.warning("[environment] project list unavailable")
        return None
    projects, repos = result.get("projects"), result.get("repos", [])
    if not isinstance(projects, list) or not isinstance(repos, list):
        workflow.logger.warning("[environment] project list malformed")
        return None
    return {**project_listing(projects, repos), "total": result.get("total")}
