"""GitHub repo inventory activity: the root's connected repos, fetched live per environment sync.

Activity return annotations stay plain ``Dict[str, Any]``: the workflow
sandbox decodes results with get_type_hints (see structural test
activity_return_types_decode_in_sandbox).
"""

from typing import Any, Dict

from temporalio import activity

from domains.github_repo_inventory.repo import fetch_github_repo_inventory


@activity.defn
async def fetch_github_repo_inventory_activity(user_id: str) -> Dict[str, Any]:
    """``{"repos": [{repo_name, repo_url, canonical_ref}]}``; empty when unavailable (never raises)."""
    activity.heartbeat("Fetching GitHub repo inventory")
    return {"repos": await fetch_github_repo_inventory(user_id)}
