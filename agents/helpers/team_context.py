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
        "you": ("userId",),
        "teams": ("id", "name", "role"),
        "accounts": ("teamId", "ownerUserId", "ownerName", "provider", "accountId", "accountEmail"),
        "projects": ("projectId", "teamId", "teamName", "ownerUserId", "name"),
    }

    def rows(value: object, allowed: tuple) -> list:
        items = value if isinstance(value, list) else [value]
        return [{field: row.get(field) for field in allowed} for row in items if isinstance(row, dict)]

    safe = {key: rows(data.get(key, []), allowed) for key, allowed in fields.items()}
    safe["you"] = safe["you"][0] if safe["you"] else {}
    return (
        "## Connected Teams and Shared Data\n"
        + json.dumps(safe, ensure_ascii=False)
        + "\ngrep and list_agents cover this shared data; filter by owner_user_id, team_id, account_id or project_id. "
        "Use exact ids; never guess identities."
    )
