"""Project inventory activity: the root's projects, fetched live per environment sync.

The registered activity name stays ``fetch_github_repo_inventory_activity`` (its
original name) so histories of in-flight workflows keep matching; only what it
fetches changed (GET /api/projects instead of the connected-repo inventory).

Activity return annotations stay plain ``Dict[str, Any]``: the workflow
sandbox decodes results with get_type_hints (see structural test
activity_return_types_decode_in_sandbox).
"""

from typing import Any, Dict

from temporalio import activity

from domains.github_repo_inventory.repo import fetch_projects
from helpers.github_repo_inventory import project_listing


@activity.defn
async def fetch_github_repo_inventory_activity(user_id: str) -> Dict[str, Any]:
    """``{"projects": [{id, name, repoUrl, imported}], "total": int, "available": bool}``; never raises.

    At most MAX_PROJECTS + 1 entries (the 25 rendered lines plus proof of more) with the exact
    ``total``, so the per-turn payload in workflow history stays bounded (10k agents).
    ``available`` is False when the list could not be read (the root keeps its last listing).
    """
    activity.heartbeat("Fetching project list")
    projects = await fetch_projects(user_id)
    return {**project_listing(projects or []), "available": projects is not None}
