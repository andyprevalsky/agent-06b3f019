"""Activities for the per-user rose_user_ui (published Rose app UI).

send_message_to_user(inline_view=...) pins a message to the user's ACTIVE
published version at send time:

    workflow ──execute_activity──► resolve_user_ui_inline_view_activity(user_id, view)
                                     GET /api/user-ui/active (X-API-Key + X-User-Id)
                                     ├─ view in manifest.inline → {"ok": True, "version_id": ...}
                                     └─ no active UI / unknown view → {"ok": False, "error": ...}

Read-only, so retries are idempotent. Transport/5xx failures raise so the
Temporal retry policy applies; definitive answers are returned as data.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog
from temporalio import activity

from config import load_config

logger = structlog.get_logger()


@activity.defn
async def resolve_user_ui_inline_view_activity(user_id: str, view: str) -> dict[str, Any]:
    """Resolve `view` against the user's active published rose-ui.json."""
    config = load_config()
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{config.backend.api_url}/api/user-ui/active",
            headers={"X-API-Key": config.backend.api_key, "X-User-Id": user_id},
            timeout=30.0,
        )
    if response.status_code >= 500:
        response.raise_for_status()
    if response.status_code != 200:
        logger.warning("[UserUi] active lookup rejected", user_id=user_id, status=response.status_code)
        return {"ok": False, "error": f"Could not load the user's published Rose UI (HTTP {response.status_code})."}

    data = response.json()
    version_id = data.get("versionId")
    if not version_id:
        return {
            "ok": False,
            "error": (
                "The user has no published Rose UI, so inline views are unavailable. "
                "Publish one with `rose-ui publish` first."
            ),
        }
    inline = (data.get("manifest") or {}).get("inline") or {}
    if view not in inline:
        available = ", ".join(sorted(inline)) or "none"
        return {
            "ok": False,
            "error": f"Inline view '{view}' is not in the user's published Rose UI (available: {available}).",
        }
    logger.info("[UserUi] inline view resolved", user_id=user_id, view=view, version_id=version_id)
    return {"ok": True, "version_id": version_id}
