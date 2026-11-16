"""Project inventory activity: the root's projects and GitHub repos, fetched live per environment sync.

The registered activity name stays ``fetch_github_repo_inventory_activity`` (its
original name) so histories of in-flight workflows keep matching; it fetches
GET /api/projects and (main #2238) GET /api/integrations/github/repos concurrently.

Failure semantics: either fetch failing makes the whole result unavailable, so the
root keeps the section it was last shown; a partial view never retracts lines.

Activity return annotations stay plain ``Dict[str, Any]``: the workflow
sandbox decodes results with get_type_hints (see structural test
activity_return_types_decode_in_sandbox).
"""

import asyncio
from typing import Any, Dict

from temporalio import activity

from domains.github_repo_inventory.repo import fetch_github_repo_inventory, fetch_projects
from helpers.github_repo_inventory import project_listing


@activity.defn
async def fetch_github_repo_inventory_activity(user_id: str) -> Dict[str, Any]:
    """``{"projects": [...], "repos": [...], "total": int, "available": bool}``; never raises.

    Repos are the ones no listed project covers (a teammate's share, or an own connection
    not linked to a project). At most MAX_PROJECTS + 1 entries of both kinds (the 25
    rendered lines plus proof of more) with the exact ``total``, so the per-turn payload in
    workflow history stays bounded (10k agents). ``available`` is False when either list
    could not be read (the root keeps its last listing).
    """
    activity.heartbeat("Fetching projects and GitHub repos")
    projects, repos = await asyncio.gather(fetch_projects(user_id), fetch_github_repo_inventory(user_id))
    if projects is None or repos is None:
        return {"projects": [], "repos": [], "total": 0, "available": False}
    return {**project_listing(projects, repos), "available": True}
