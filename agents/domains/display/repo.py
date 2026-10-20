"""Display domain data access - the backend agent-tools route."""

import httpx
import structlog
from temporalio import activity

from config import load_config
from domains.display.config import DISPLAY_ACTIVITY_TIMEOUT_SECONDS
from domains.display.types import DisplayActivityInput, DisplayActivityResult

logger = structlog.get_logger()


@activity.defn
async def display_media_activity(payload: DisplayActivityInput) -> DisplayActivityResult:
    """POST /api/agent-tools/:agentId/display.

    Idempotent (CLAUDE.md rule 20): inline media dedupes per (agent, content
    hash) and a pinned question's attention row id derives from
    (agent, tool_call_id), so a retried attempt returns the same rows. 4xx
    answers are definitive and returned as data; transport errors and 5xx
    raise so the Temporal retry policy applies.
    """
    config = load_config()
    body = {
        "items": payload["items"],
        "placement": payload["placement"],
        **({"caption": payload["caption"]} if payload["caption"] else {}),
    }
    if payload["placement"] == "pinned":
        body.update(
            {
                "options": payload["options"],
                "allow_other": payload["allow_other"],
                "request_key": payload["tool_call_id"],
                "workflow_id": payload["workflow_id"],
            }
        )
    url = f"{config.backend.api_url}/api/agent-tools/{payload['agent_id']}/display"
    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": payload["user_id"]},
            json=body,
            timeout=DISPLAY_ACTIVITY_TIMEOUT_SECONDS,
        )
    if response.status_code >= 500:
        response.raise_for_status()
    try:
        data = response.json()
    except ValueError:
        data = {"error": response.text[:500]}
    logger.info(
        "[Display] backend responded",
        agent_id=payload["agent_id"],
        placement=payload["placement"],
        status=response.status_code,
        item_count=len(payload["items"]),
    )
    if response.status_code >= 400:
        details = data.get("details") if isinstance(data, dict) else None
        return {
            "ok": False,
            "status_code": response.status_code,
            "error": str((data or {}).get("error") or f"HTTP {response.status_code}"),
            "details": [str(d) for d in details] if isinstance(details, list) else [],
        }
    return {"ok": True, "status_code": response.status_code, "body": data}
