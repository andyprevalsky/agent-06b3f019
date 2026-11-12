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
    """``{"repos": [{repo_name, repo_url, canonical_ref}], "available": bool}``; never raises.

    ``available`` is False when the inventory could not be read (the root keeps its last listing).
    """
    activity.heartbeat("Fetching GitHub repo inventory")
    repos = await fetch_github_repo_inventory(user_id)
    return {"repos": repos or [], "available": repos is not None}
