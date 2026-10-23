"""api_request domain repo - backend HTTP proxy."""

from typing import Any, Dict, Optional

import structlog
from temporalio import activity

from config import load_config
from domains.api_request.config import API_REQUEST_HTTP_TIMEOUT
from helpers.http_client import get_http_client

logger = structlog.get_logger()


@activity.defn
async def api_request_activity(
    request_payload: Dict[str, Any],
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute an external HTTP request via backend POST /api/external-http/request."""
    method = str(request_payload.get("method") or "GET").upper()
    url = str(request_payload.get("url") or "")
    activity.heartbeat(f"{method} {url[:80]}")

    from providers.demo_cache.google_oauth_demo_fixture import DEMO_URL, matches_demo_goal, run_fixture

    if url == DEMO_URL:
        from providers.demo_cache.client import resolve_agent_fast_mode

        if method != "GET" or not agent_id:
            raise ValueError("Google OAuth DEMO fixture requires a GET from its benchmark agent")
        _, goal, _, _, root_goal, _ = await resolve_agent_fast_mode(agent_id)
        if not (matches_demo_goal(goal) or matches_demo_goal(root_goal)):
            raise ValueError("Google OAuth DEMO fixture is available only to the Google OAuth task")
        return {
            "ok": True,
            "status": 200,
            "status_text": "OK",
            "url": DEMO_URL,
            "body": run_fixture(),
            "body_encoding": "json",
            "content_type": "application/json",
            "attempts": 1,
            "demo_fixture": True,
        }

    config = load_config()
    payload = {
        key: value
        for key, value in request_payload.items()
        if key not in {"tool", "tool_call_id"} and value is not None
    }

    response = await get_http_client().post(
        f"{config.backend.api_url}/api/external-http/request",
        headers={
            "X-API-Key": config.backend.api_key or "",
            "X-User-Id": user_id or "",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=API_REQUEST_HTTP_TIMEOUT,
    )

    if response.status_code == 200:
        data = response.json()
        logger.info(
            "api_request completed",
            method=method,
            url=url[:120],
            status=data.get("status"),
            ok=data.get("ok"),
            attempts=data.get("attempts"),
        )
        return data

    try:
        error_data = response.json()
    except Exception:
        error_data = {"message": response.text}

    message = error_data.get("message") or error_data.get("error") or f"HTTP {response.status_code}"
    logger.error(
        "api_request backend error",
        method=method,
        url=url[:120],
        status_code=response.status_code,
        message=str(message)[:200],
    )
    raise ValueError(message)
