"""Workflow-side entry point: the root's connected GitHub repos for its environment block.

    AgentWorkflow._sync_environment_context (root only)
        ──▶ fetch_root_github_repos ──▶ fetch_github_repo_inventory_activity (one attempt)
        ──▶ compacted entries ([] = none connected), or None when the fetch failed
            (the environment block then keeps the listing the model was last shown)

Fetched live on every sync (no cache), so connecting or disconnecting a repo
shows up on the root's next turn. Imported inside the Temporal workflow sandbox.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.github_repo_inventory.config import ACTIVITY_TIMEOUT
from domains.github_repo_inventory.service import fetch_github_repo_inventory_activity
from helpers.github_repo_inventory import compact_github_repos


async def fetch_root_github_repos(workflow_instance: Any) -> Optional[List[Dict[str, str]]]:
    """The workflow user's connected repos; [] without a user, None when the fetch failed."""
    user_id = getattr(workflow_instance, "user_id", None)
    if not isinstance(user_id, str) or not user_id:
        return []
    try:
        result = await workflow.execute_activity(
            fetch_github_repo_inventory_activity,
            args=[user_id],
            start_to_close_timeout=ACTIVITY_TIMEOUT,
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
    except Exception as exc:
        workflow.logger.warning(f"[environment] GitHub repo inventory unavailable: {type(exc).__name__}")
        return None
    if isinstance(result, dict) and result.get("available") is False:
        workflow.logger.warning("[environment] GitHub repo inventory unavailable")
        return None
    return compact_github_repos(result)
