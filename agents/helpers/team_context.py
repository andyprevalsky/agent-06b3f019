"""Fresh, read-only team context; shared credentials never enter prompts."""

import json

import httpx

from config import load_config


async def fetch_team_context(user_id: str) -> str:
    config = load_config()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{config.backend.api_url}/api/data/team-context",
                headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": user_id},
                timeout=5.0,
            )
            response.raise_for_status()
            return format_team_context(response.json())
    except Exception:
        # Never cache authorization hints or fall back to a previous grant map.
        return ""


def format_team_context(data: dict) -> str:
    if not isinstance(data, dict) or not data.get("teams"):
        return ""
    fields = {
        "teams": ("id", "name", "role"),
        "accounts": ("teamId", "ownerUserId", "ownerName", "provider", "accountId", "accountEmail"),
        "projectAgents": ("id", "title", "status", "projectId", "ownerUserId", "teamId"),
        "projects": ("projectId", "teamId", "teamName", "ownerUserId", "name", "hasMoreAgents"),
    }
    safe = {
        key: [{field: row.get(field) for field in allowed} for row in data.get(key, []) if isinstance(row, dict)]
        for key, allowed in fields.items()
    }
    return (
        "## Connected Teams and Shared Data\n"
        + json.dumps(safe, ensure_ascii=False)
        + "\nGrep defaults to own records plus explicit team account grants. Narrow with team_id, owner_user_id, account_id or scope. "
        "Use grep source=shared_project_agents and filters.project_id for searchable, paged metadata beyond the shown agents. Shared projects permit discovery only; they grant no credentials, iPhone access or other accounts. "
        "Use exact identities in this map; do not guess a teammate's identity."
    )
